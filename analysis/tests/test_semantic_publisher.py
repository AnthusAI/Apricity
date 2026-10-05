import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from apricity_analyze.semantic_contract import SemanticIdentity
from apricity_analyze.semantic_publisher import DynamoCorpusPublisher, publish_catalog, sample_partition

SPACE = "clap-htsat-unfused-512-v1"
FINGERPRINT = "processing-v1"
SHA = "a" * 64

def _vector(index=0): return [1.0 if n == index else 0.0 for n in range(512)]

def _record(sample_id, *, kind="saved_clip", start=0, end=4, updated="2026-09-30T12:00:00Z", vector=None):
    identity = SemanticIdentity(sample_id=sample_id, recording_id="rec_" + sample_id, kind=kind,
        clip_id="clp_" + sample_id if kind == "saved_clip" else None, start=start, end=end,
        audio_sha256=SHA, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    semantic_id = identity.semantic_id
    return {"identity": {"semanticId": semantic_id, "sampleId": sample_id, "recordingId": identity.recording_id,
        "kind": kind, **({"clipId": identity.clip_id} if kind == "saved_clip" else {}), "start": start,
        "end": end, "audioSha256": SHA, "embeddingSpace": SPACE, "processingFingerprint": FINGERPRINT},
        "vector": _vector(0 if sample_id.endswith("A") else 1) if vector is None else vector,
        "display": {"samplePath": sample_id + ".wav", "sampleTitle": sample_id, "tags": []},
        "playback": {"fileKey": "audio/" + sample_id, "start": start, "end": end},
        "revision": hashlib.sha256(json.dumps([semantic_id, ""], separators=(",", ":")).encode()).hexdigest(),
        "metadataUpdatedAt": updated}

def _catalog(records, excluded=()): return {"records": records, "excluded": list(excluded)}

def _script(name):
    path = Path(__file__).parents[2] / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module

def test_local_publish_is_atomic_idempotent_and_dry_run_does_not_write(tmp_path):
    output = tmp_path / "library" / "semantic" / "corpus.json"; records = [_record("smp_A"), _record("smp_B", kind="window")]
    dry = publish_catalog(_catalog(records), output, dry_run=True)
    assert not output.exists() and dry["counts"]["indexed"] == {"saved_clip": 1, "window": 1}
    assert dry["coverage"]["persisted"] == {"saved_clip": 0, "window": 0}
    assert dry["counts"]["projected"] == {"saved_clip": 1, "window": 1}
    assert publish_catalog(_catalog(records), output)["counts"]["retired"] == {"saved_clip": 0, "window": 0}
    assert json.loads(output.read_text())["records"] == sorted(records, key=lambda row: row["identity"]["semanticId"])
    assert publish_catalog(_catalog(records), output)["counts"]["indexed"] == {"saved_clip": 0, "window": 0}

def test_empty_scope_retires_last_record_and_first_empty_snapshot_needs_explicit_contract(tmp_path):
    output = tmp_path / "semantic" / "corpus.json"; publish_catalog(_catalog([_record("smp_A")]), output)
    report = publish_catalog(_catalog([]), output, scope={"smp_A"})
    envelope = json.loads(output.read_text())
    assert envelope["records"] == [] and (envelope["embeddingSpace"], envelope["processingFingerprint"]) == (SPACE, FINGERPRINT)
    assert report["counts"]["retired"] == {"saved_clip": 1, "window": 0}
    with pytest.raises(ValueError, match="empty publication"): publish_catalog(_catalog([]), tmp_path / "first.json", scope={"smp_A"})
    publish_catalog(_catalog([]), tmp_path / "first.json", scope={"smp_A"}, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)

def test_explicit_scope_rejects_outside_rows_and_default_scope_retires_absent_old_sources(tmp_path):
    output = tmp_path / "semantic" / "corpus.json"; a, b = _record("smp_A"), _record("smp_B")
    publish_catalog(_catalog([a, b]), output)
    with pytest.raises(ValueError, match="outside explicit scope"): publish_catalog(_catalog([a, b]), output, scope={"smp_A"})
    publish_catalog(_catalog([a]), output)
    assert [row["identity"]["sampleId"] for row in json.loads(output.read_text())["records"]] == ["smp_A"]

def test_default_scope_uses_excluded_current_source_to_retire_stale_record(tmp_path):
    output = tmp_path / "semantic" / "corpus.json"; a, b = _record("smp_A"), _record("smp_B")
    publish_catalog(_catalog([a, b]), output)
    publish_catalog(_catalog([a], [{"kind": "sample", "sampleId": "smp_B", "reason": "missing_analysis"}]), output)
    assert [row["identity"]["sampleId"] for row in json.loads(output.read_text())["records"]] == ["smp_A"]

def test_interrupted_publication_preserves_old_corpus_and_checkpoint_then_retries(tmp_path, monkeypatch):
    from apricity_analyze import semantic_publisher

    output, checkpoint = tmp_path / "semantic" / "corpus.json", tmp_path / "semantic" / "checkpoint.json"
    old = _record("smp_A")
    publish_catalog(_catalog([old]), output, checkpoint=checkpoint)
    before_output, before_checkpoint = output.read_bytes(), checkpoint.read_bytes()
    refreshed, added = _record("smp_A", updated="2026-10-01T12:00:00Z"), _record("smp_B", kind="window")
    real_atomic = semantic_publisher._atomic_json

    def interrupted(path, value):
        if Path(path) == output:
            raise OSError("interrupted atomic replace")
        real_atomic(path, value)

    monkeypatch.setattr(semantic_publisher, "_atomic_json", interrupted)
    with pytest.raises(OSError, match="interrupted atomic replace"):
        publish_catalog(_catalog([refreshed, added]), output, checkpoint=checkpoint)
    assert output.read_bytes() == before_output
    assert checkpoint.read_bytes() == before_checkpoint

    monkeypatch.setattr(semantic_publisher, "_atomic_json", real_atomic)
    report = publish_catalog(_catalog([refreshed, added]), output, checkpoint=checkpoint)
    envelope = json.loads(output.read_text())
    assert [row["identity"]["semanticId"] for row in envelope["records"]] == sorted(row["identity"]["semanticId"] for row in [refreshed, added])
    assert report["counts"]["indexed"] == {"saved_clip": 1, "window": 1}
    assert json.loads(checkpoint.read_text())["recordCount"] == 2

def test_publish_cli_full_refresh_and_explicit_scope(monkeypatch, tmp_path, capsys):
    cli = _script("semantic-publish.py")
    catalog = tmp_path / "catalog.json"
    output = tmp_path / "old.json"
    output.write_text("old corpus is not read by this mocked flow")
    catalog.write_text(json.dumps({"samples": [{"id": "smp_A"}, {"id": "smp_B"}], "clips": [], "recordings": [], "analyses": {}}))
    calls = []
    monkeypatch.setattr(cli, "materialize_catalog", lambda catalog, samples, sample_ids=None: calls.append((catalog, sample_ids)) or _catalog([]))
    monkeypatch.setattr(cli, "publish_catalog", lambda materialized, output, **kwargs: {"scope": sorted(kwargs["scope"]) if kwargs["scope"] is not None else None, "dryRun": kwargs["dry_run"]})

    assert cli.main(["--catalog", str(catalog), "--samples", str(tmp_path / "samples"), "--output", str(output)]) == 0
    assert calls[-1][1] is None
    assert json.loads(capsys.readouterr().out)["scope"] is None

    assert cli.main(["--catalog", str(catalog), "--samples", str(tmp_path / "samples"), "--output", str(output), "--sample-id", "smp_A"]) == 0
    assert calls[-1][1] == {"smp_A"}
    assert json.loads(capsys.readouterr().out)["scope"] == ["smp_A"]

def test_publish_cli_first_empty_snapshot_uses_catalog_scope_and_pinned_contract_without_model(monkeypatch, tmp_path, capsys):
    cli = _script("semantic-publish.py")
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"samples": [{"id": "smp_A"}], "clips": [], "recordings": [], "analyses": {}}))
    seen = {}
    monkeypatch.setattr(cli, "materialize_catalog", lambda *args, **kwargs: _catalog([]))
    monkeypatch.setattr(cli.clap, "_load", lambda *args, **kwargs: pytest.fail("CLI must not load the CLAP model"))
    monkeypatch.setattr(cli, "publish_catalog", lambda materialized, output, **kwargs: seen.update(kwargs) or {"ok": True})

    assert cli.main(["--catalog", str(catalog), "--samples", str(tmp_path / "samples"), "--output", str(tmp_path / "first.json")]) == 0
    assert seen["scope"] == {"smp_A"}
    assert seen["embedding_space"] == cli.clap.EMBEDDING_SPACE
    assert seen["processing_fingerprint"] == cli.clap.processing_fingerprint()
    assert json.loads(capsys.readouterr().out) == {"ok": True}

def test_publish_cli_unknown_sample_is_structured_nonzero(monkeypatch, tmp_path, capsys):
    cli = _script("semantic-publish.py")
    catalog = tmp_path / "catalog.json"; catalog.write_text("{}")
    monkeypatch.setattr(cli, "materialize_catalog", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("unknown sample id: nope")))
    assert cli.main(["--catalog", str(catalog), "--samples", str(tmp_path), "--sample-id", "nope"]) == 2
    error = json.loads(capsys.readouterr().err)
    assert error["error"] == {"code": "publish_failed", "message": "unknown sample id: nope", "retryable": False}

@pytest.mark.parametrize("mutate", [lambda r: r["identity"].__setitem__("semanticId", "bad"), lambda r: r.__setitem__("revision", "r-id"), lambda r: r.__setitem__("vector", [0.0] * 512), lambda r: r["identity"].__setitem__("clipId", None), lambda r: r["display"].__setitem__("clipName", 7), lambda r: r["display"].__setitem__("clipKind", False)])
def test_invalid_canonical_record_is_rejected_before_any_write(tmp_path, mutate):
    output = tmp_path / "semantic" / "corpus.json"; good = _record("smp_A"); publish_catalog(_catalog([good]), output)
    bad = _record("smp_B"); mutate(bad)
    with pytest.raises(ValueError): publish_catalog(_catalog([good, bad]), output)
    assert json.loads(output.read_text())["records"] == [good]

def test_duplicate_existing_corpus_is_rejected_before_reconciliation(tmp_path):
    output = tmp_path / "semantic" / "corpus.json"; a = _record("smp_A")
    payload = {"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE, "processingFingerprint": FINGERPRINT, "records": [a, a]}
    output.parent.mkdir(parents=True); output.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="unique"): publish_catalog(_catalog([_record("smp_B")]), output)
    assert json.loads(output.read_text()) == payload

def test_metadata_refresh_preserves_contract_and_fingerprint(tmp_path):
    output = tmp_path / "semantic" / "corpus.json"; publish_catalog(_catalog([_record("smp_A")]), output)
    refreshed = _record("smp_A", updated="2026-10-01T12:00:00Z"); refreshed["display"]["sampleTitle"] = "renamed"
    publish_catalog(_catalog([refreshed]), output); saved = json.loads(output.read_text())
    assert saved["processingFingerprint"] == FINGERPRINT and saved["records"] == [refreshed]

def test_sample_partition_uses_compact_utf8_json_golden_unicode_fixture():
    assert sample_partition("cläp/é", "smp_音楽") == "8ed4e143b7999b4a5595abb975057a51f01f511be1ad9d02f4c7067aad823740"

def test_injected_cloud_adapter_pages_exact_sample_gsi_retains_full_record_and_checkpoints_only_after_success(tmp_path):
    calls = []; a, b = _record("smp_A"), _record("smp_A", kind="window", start=4, end=8)
    class Client:
        def query(self, **kwargs):
            calls.append(("Query", kwargs))
            item = lambda semantic_id: {"semanticId": {"S": semantic_id}, "embeddingSpace": {"S": SPACE}, "sampleId": {"S": "smp_A"}, "samplePartition": {"S": sample_partition(SPACE, "smp_A")}}
            return ({"Items": [item("old")], "LastEvaluatedKey": {"semanticId": {"S": "old"}}}
                    if "ExclusiveStartKey" not in kwargs else {"Items": [item("gone")]})
        def put_item(self, **kwargs): calls.append(("PutItem", kwargs))
        def delete_item(self, **kwargs): calls.append(("DeleteItem", kwargs))
    checkpoint = tmp_path / "checkpoint.json"; DynamoCorpusPublisher(Client(), "Semantic", checkpoint=checkpoint).reconcile([a, b], sample_id="smp_A", embedding_space=SPACE)
    assert [name for name, _ in calls] == ["Query", "Query", "PutItem", "PutItem", "DeleteItem", "DeleteItem"]
    for _, query in calls[:2]:
        assert query["IndexName"] == "semantic-by-sample"
        assert query["KeyConditionExpression"] == "samplePartition = :samplePartition"
        assert query["ExpressionAttributeValues"] == {":samplePartition": {"S": sample_partition(SPACE, "smp_A")}}
        assert "FilterExpression" not in query and "embeddingSpace" not in query["KeyConditionExpression"]
    assert set(calls[2][1]["Item"]) >= {"embeddingSpace", "semanticId", "sampleId", "kind", "processingFingerprint", "identity", "revision", "display", "playback", "metadataUpdatedAt", "vector"}
    assert calls[2][1]["Item"]["samplePartition"] == {"S": sample_partition(SPACE, "smp_A")}
    assert "samplePartition" not in calls[2][1]["Item"]["identity"]["M"]
    assert json.loads(checkpoint.read_text())["completedSamples"] == ["smp_A"]
    class Failing(Client):
        def put_item(self, **kwargs): raise RuntimeError("actual operation failed")
    failed = tmp_path / "failed.json"
    with pytest.raises(RuntimeError, match="actual operation"): DynamoCorpusPublisher(Failing(), "Semantic", checkpoint=failed).reconcile([a], sample_id="smp_A", embedding_space=SPACE)
    assert not failed.exists()

def test_cloud_reconciliation_rejects_foreign_gsi_rows_before_any_mutation(tmp_path):
    calls = []
    class Client:
        def query(self, **kwargs):
            calls.append(("Query", kwargs))
            if "ExclusiveStartKey" not in kwargs:
                return {"Items": [{"semanticId": {"S": "declared"}, "embeddingSpace": {"S": SPACE}, "sampleId": {"S": "smp_A"}, "samplePartition": {"S": sample_partition(SPACE, "smp_A")}}], "LastEvaluatedKey": {"semanticId": {"S": "declared"}}}
            return {"Items": [{"semanticId": {"S": "foreign"}, "embeddingSpace": {"S": "other-model"}, "sampleId": {"S": "smp_B"}, "samplePartition": {"S": sample_partition(SPACE, "smp_A")}}]}
        def put_item(self, **kwargs): calls.append(("PutItem", kwargs))
        def delete_item(self, **kwargs): calls.append(("DeleteItem", kwargs))
    with pytest.raises(ValueError, match="foreign"):
        DynamoCorpusPublisher(Client(), "Semantic", checkpoint=tmp_path / "checkpoint.json").reconcile([_record("smp_A")], sample_id="smp_A", embedding_space=SPACE)
    assert [name for name, _ in calls] == ["Query", "Query"]

def test_cloud_retry_is_idempotent_for_declared_sample():
    calls = []
    class Client:
        def query(self, **kwargs):
            calls.append(("Query", kwargs)); return {"Items": []}
        def put_item(self, **kwargs): calls.append(("PutItem", kwargs))
        def delete_item(self, **kwargs): calls.append(("DeleteItem", kwargs))
    publisher = DynamoCorpusPublisher(Client(), "Semantic")
    publisher.reconcile([_record("smp_A")], sample_id="smp_A", embedding_space=SPACE)
    publisher.reconcile([_record("smp_A")], sample_id="smp_A", embedding_space=SPACE)
    assert [name for name, _ in calls] == ["Query", "PutItem", "Query", "PutItem"]

def test_cloud_retirement_deletes_only_the_declared_sample_gsi_rows():
    calls = []
    class Client:
        def query(self, **kwargs):
            calls.append(("Query", kwargs))
            return {"Items": [{"semanticId": {"S": "retired"}, "embeddingSpace": {"S": SPACE}, "sampleId": {"S": "smp_A"}, "samplePartition": {"S": sample_partition(SPACE, "smp_A")}}]}
        def put_item(self, **kwargs): calls.append(("PutItem", kwargs))
        def delete_item(self, **kwargs): calls.append(("DeleteItem", kwargs))
    DynamoCorpusPublisher(Client(), "Semantic").reconcile([], sample_id="smp_A", embedding_space=SPACE)
    assert [name for name, _ in calls] == ["Query", "DeleteItem"]
    assert calls[-1][1]["Key"] == {"embeddingSpace": {"S": SPACE}, "semanticId": {"S": "retired"}}
