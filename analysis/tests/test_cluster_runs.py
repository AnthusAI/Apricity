"""Executable contract for bounded immutable M4 draft cluster runs."""
from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path

import pytest

from apricity_analyze.clap import EMBED_DIM, EMBEDDING_SPACE
from apricity_analyze.audio_clusters import AlgorithmDependencyError, cluster_snapshot
from apricity_analyze.cluster_runs import prepare_run, save_draft_run
from apricity_analyze.cluster_summaries import build_cluster_summaries
from apricity_analyze.lab.cli import main as lab_main


def vector(index: int) -> list[float]:
    value = [0.0] * EMBED_DIM
    value[index] = 1.0
    return value


def packets():
    alias = {"semanticId": "a", "semanticIdentity": {"semanticId": "a", "sampleId": "sample-a", "recordingId": "recording-a", "kind": "saved_clip", "clipId": "clip-a", "start": 0.0, "end": 4.0, "audioSha256": "a" * 64, "embeddingSpace": EMBEDDING_SPACE, "processingFingerprint": "process-v1"}, "sample": {"id": "sample-a"}, "recording": {"id": "recording-a"}, "clip": {"id": "clip-a"}}
    snapshot = {"schemaVersion": "apricity.cluster-corpus/1", "corpusDigest": "b" * 64, "embeddingSpace": EMBEDDING_SPACE, "processingFingerprint": "process-v1", "regions": [{"semanticId": "a", "vector": vector(0), "aliases": [alias]}]}
    result = {"schemaVersion": "apricity.clustering-result/1", "corpus": {"schemaVersion": "apricity.cluster-corpus/1", "digest": "b" * 64, "regionCount": 1}, "model": {"embeddingSpace": EMBEDDING_SPACE, "processingFingerprint": "process-v1"}, "preset": "fine", "requestedParams": {"neighbors": 15, "minClusterSize": 5, "minSamples": 3}, "effectiveParams": {"neighbors": None, "dimensions": None, "minClusterSize": None, "minSamples": None}, "algorithmVersions": {"umap-learn": "test", "hdbscan": "test", "numpy": "test", "scipy": "test", "scikit-learn": "test", "numba": "test", "pynndescent": "test"}, "seed": 42, "members": [{"semanticId": "a", "aliases": [alias], "clusterLabel": None, "membership": 0.0, "x": 1.0, "y": 2.0}], "outliers": ["a"]}
    summaries = {"schemaVersion": "apricity.cluster-summaries/1", "corpus": copy.deepcopy(result["corpus"]), "model": copy.deepcopy(result["model"]), "preset": "fine", "requestedParams": copy.deepcopy(result["requestedParams"]), "effectiveParams": copy.deepcopy(result["effectiveParams"]), "algorithmVersions": copy.deepcopy(result["algorithmVersions"]), "seed": 42, "clusters": [], "members": [{"semanticId": "a", "aliases": ["a"], "clusterId": None, "membership": 0.0, "x": 1.0, "y": 2.0}], "outliers": [{"semanticId": "a", "aliases": ["a"]}], "qualityReview": {"status": "pending"}}
    return snapshot, result, summaries


def representative() -> dict:
    return {"semanticId": "a", "sampleId": "sample-a", "recordingId": "recording-a", "kind": "saved_clip",
            "clipId": "clip-a", "clipName": "clip-a", "start": 0.0, "end": 4.0, "audioSha256": "a" * 64,
            "embeddingSpace": EMBEDDING_SPACE, "processingFingerprint": "process-v1",
            "fileKey": "audio/sample-a.wav", "sampleTitle": "sample-a"}


def suggested_label(*, approved: bool = False) -> dict:
    return {"label": "drum beat", "method": "clap_concept", "approved": approved,
            "vocabularyVersion": "semantic-audio-concepts-v1", "provenance": {"source": "fixture"},
            "conceptScores": [{"conceptId": "drum-beat", "label": "drum beat", "score": 1.0}]}


def test_prepare_run_is_immutable_traceable_and_deterministic_except_timestamp():
    snapshot, result, summaries = packets()
    before = copy.deepcopy((snapshot, result, summaries))
    first = prepare_run(snapshot, result, summaries, "2026-09-30T12:00:00Z")
    second = prepare_run(snapshot, result, summaries, "2026-09-30T13:00:00Z")
    assert first["schemaVersion"] == "apricity.cluster-run/1"
    assert first["runId"] == second["runId"] and first["createdAtUTC"] != second["createdAtUTC"]
    assert first["state"] == "draft" and first["qualityReview"] == {"status": "pending"}
    assert first["outliers"] == ["a"] and first["members"][0]["clusterId"] is None
    assert (snapshot, result, summaries) == before


@pytest.mark.parametrize("mutate", [
    lambda s, r, u: r["members"][0].update(aliases=[]),
    lambda s, r, u: u["members"][0].update(membership=math.nan),
    lambda s, r, u: u.update(preset="broad"),
    lambda s, r, u: u["outliers"].clear(),
])
def test_prepare_run_rejects_mixed_or_nonfinite_packets(mutate):
    snapshot, result, summaries = packets(); mutate(snapshot, result, summaries)
    with pytest.raises(ValueError): prepare_run(snapshot, result, summaries, "2026-09-30T12:00:00Z")


def test_save_is_atomic_no_clobber_and_reuses_only_equivalent_content(tmp_path: Path):
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    first = save_draft_run(tmp_path, packet)
    repeated = save_draft_run(tmp_path, {**packet, "createdAtUTC": "2026-09-30T13:00:00Z"})
    assert first == repeated == tmp_path / "runs" / packet["runId"] / "manifest.json"
    stored = json.loads(first.read_text())
    assert stored["createdAtUTC"] == "2026-09-30T12:00:00Z"
    changed = copy.deepcopy(packet); changed["members"][0]["x"] = 3.0
    with pytest.raises(FileExistsError): save_draft_run(tmp_path, changed)
    assert json.loads(first.read_text()) == stored


def test_save_leaves_published_pointer_sentinel_untouched(tmp_path: Path):
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    pointer = tmp_path / "published.json"
    sentinel = b'{"useful":"already-published"}\n'
    pointer.write_bytes(sentinel)

    save_draft_run(tmp_path, packet)

    assert pointer.read_bytes() == sentinel


@pytest.mark.parametrize("mutate", [
    lambda packet: packet["corpus"].update(digest="c" * 64),
    lambda packet: packet["model"].update(embeddingSpace="unaccepted-space"),
    lambda packet: packet["model"].update(processingFingerprint="other-process"),
])
def test_save_revalidates_embedded_accepted_provenance(tmp_path: Path, mutate):
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    mutate(packet)
    with pytest.raises(ValueError):
        save_draft_run(tmp_path, packet)


def test_save_rejects_unsafe_root_or_symlink_escape(tmp_path: Path):
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    with pytest.raises(ValueError): save_draft_run(tmp_path / "missing" / ".." / "x", packet)
    (tmp_path / "runs").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError): save_draft_run(tmp_path, packet)


def test_save_rejects_a_symlink_ancestor_before_it_can_create_outside_artifacts(tmp_path: Path):
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    outside = tmp_path / "outside"; outside.mkdir()
    (tmp_path / "user-link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError):
        save_draft_run(tmp_path / "user-link" / "drafts", packet)

    assert list(outside.iterdir()) == []


def test_save_preserves_competing_empty_run_directory_and_reports_incomplete_artifact(tmp_path: Path):
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    target = tmp_path / "runs" / packet["runId"]
    target.mkdir(parents=True)

    with pytest.raises(ValueError, match="incomplete"):
        save_draft_run(tmp_path, packet)

    assert target.is_dir() and list(target.iterdir()) == []


def test_save_never_replaces_a_competing_directory(tmp_path: Path, monkeypatch):
    """A staged rival must remain intact even where rename replaces empty dirs."""
    packet = prepare_run(*packets(), "2026-09-30T12:00:00Z")
    target = tmp_path / "runs" / packet["runId"]
    original_mkdir = os.mkdir

    def rival_then_claim(path, mode=0o777):
        if Path(path) == target:
            original_mkdir(path, mode)
            raise FileExistsError(path)
        return original_mkdir(path, mode)

    monkeypatch.setattr("apricity_analyze.cluster_runs.os.mkdir", rival_then_claim)
    with pytest.raises(ValueError, match="incomplete"):
        save_draft_run(tmp_path, packet)

    assert target.is_dir() and list(target.iterdir()) == []


@pytest.mark.parametrize("mutate", [
    lambda s, r, u: (r["members"][0].update(clusterLabel=2), u["members"][0].update(clusterId=2), u["clusters"].extend([
        {"clusterId": 2, "centroid": vector(0), "representatives": [representative()], "suggestedLabel": suggested_label()},
        {"clusterId": 2, "centroid": vector(0), "representatives": [representative()], "suggestedLabel": suggested_label()},
    ]), r.update(outliers=[]), u.update(outliers=[])),
    lambda s, r, u: (r["members"][0].update(clusterLabel=2), u["members"][0].update(clusterId=2), u["clusters"].append(
        {"clusterId": 2, "centroid": [0.0] * EMBED_DIM, "representatives": [representative()], "suggestedLabel": suggested_label()}), r.update(outliers=[]), u.update(outliers=[])),
    lambda s, r, u: (r["members"][0].update(clusterLabel=2), u["members"][0].update(clusterId=2), u["clusters"].append(
        {"clusterId": 2, "centroid": vector(0), "representatives": [{"semanticId": "a"}], "suggestedLabel": suggested_label()}), r.update(outliers=[]), u.update(outliers=[])),
    lambda s, r, u: (r["members"][0].update(clusterLabel=2), u["members"][0].update(clusterId=2), u["clusters"].append(
        {"clusterId": 2, "centroid": vector(0), "representatives": [representative()], "suggestedLabel": suggested_label(approved=True)}), r.update(outliers=[]), u.update(outliers=[])),
])
def test_prepare_run_revalidates_summary_clusters_and_never_accepts_approval(mutate):
    snapshot, result, summaries = packets()
    mutate(snapshot, result, summaries)
    with pytest.raises(ValueError):
        prepare_run(snapshot, result, summaries, "2026-09-30T12:00:00Z")


@pytest.mark.parametrize("changes", [
    {"fileKey": "audio/bad\x00.wav"},
    {"clipId": "unrelated-clip"},
    {"embeddingSpace": "other-space"},
    {"processingFingerprint": "other-process"},
])
def test_representatives_preserve_exact_source_provenance_and_safe_playback(changes):
    snapshot, result, summaries = packets()
    result["members"][0]["clusterLabel"] = 2
    summaries["members"][0]["clusterId"] = 2
    result["outliers"] = []
    summaries["outliers"] = []
    summaries["clusters"] = [{"clusterId": 2, "centroid": vector(0),
                              "representatives": [{**representative(), **changes}],
                              "suggestedLabel": suggested_label()}]
    with pytest.raises(ValueError):
        prepare_run(snapshot, result, summaries, "2026-09-30T12:00:00Z")


def test_real_pinned_small_pipeline_requires_clustering_dependencies():
    """Real algorithms are required here; a missing dependency is a failing gate."""
    snapshot, _result, _summaries = packets()
    region = snapshot["regions"][0]
    for index in range(1, 5):
        cloned = copy.deepcopy(region)
        semantic_id = chr(ord("a") + index)
        cloned["semanticId"] = semantic_id
        cloned["vector"] = vector(index)
        alias = cloned["aliases"][0]
        alias["semanticId"] = semantic_id
        alias["semanticIdentity"]["semanticId"] = semantic_id
        alias["semanticIdentity"]["sampleId"] = f"sample-{semantic_id}"
        alias["semanticIdentity"]["recordingId"] = f"recording-{semantic_id}"
        alias["semanticIdentity"]["clipId"] = f"clip-{semantic_id}"
        alias["sample"]["id"], alias["recording"]["id"], alias["clip"]["id"] = f"sample-{semantic_id}", f"recording-{semantic_id}", f"clip-{semantic_id}"
        snapshot["regions"].append(cloned)
    snapshot["regions"].sort(key=lambda row: row["semanticId"])
    try:
        result = cluster_snapshot(snapshot, "fine")
    except AlgorithmDependencyError as error:
        pytest.fail(f"not_evaluated: {error}")
    metadata = {}
    for region in snapshot["regions"]:
        alias = region["aliases"][0]; identity = alias["semanticIdentity"]
        metadata[alias["semanticId"]] = {**identity, "fileKey": f"audio/{identity['sampleId']}.wav", "sampleTitle": identity["sampleId"], "clipName": identity["clipId"]}
    vocabulary = json.loads((Path(__file__).parents[2] / "fixtures/semantic-audio/concept-vocabulary-v1.json").read_text())
    summaries = build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)
    assert prepare_run(snapshot, result, summaries, "2026-09-30T12:00:00Z")["state"] == "draft"


def test_lab_cli_empty_corpus_creates_only_an_unclustered_draft(tmp_path: Path, capsys):
    corpus = tmp_path / "publishedsemantic.json"; catalog = tmp_path / "currentexport.json"
    corpus.write_text(json.dumps({"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": EMBEDDING_SPACE, "processingFingerprint": "process-v1", "records": []}))
    catalog.write_text(json.dumps({"samples": [], "clips": [], "recordings": [], "analyses": {}}))
    assert lab_main(["semantic", "cluster", "--corpus", str(corpus), "--catalog", str(catalog), "--preset", "fine", "--output", str(tmp_path / "drafts"), "--json"]) == 0
    packet = json.loads(capsys.readouterr().out)
    assert packet["members"] == [] and packet["outliers"] == [] and packet["state"] == "draft"
    assert (tmp_path / "drafts" / "runs" / packet["runId"] / "manifest.json").is_file()
