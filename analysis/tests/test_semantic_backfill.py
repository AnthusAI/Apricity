import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

from apricity_analyze import clap


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _catalog(root, *, clips=None, analysis=True, source_sha=None, path="samples/library/source.wav"):
    source = root / "library" / "source.wav"
    sha = source_sha or _sha(source)
    manifest = {"source": {"sha256": sha}, "rhythm": {"bpm": 120, "meter": [4, 4],
                "beats": list(range(9)), "downbeats": [0, 1, 2, 3, 4]}, "duration": 8}
    (root / "library" / "source.wav.apricity.json").write_text(json.dumps(manifest))
    return {"samples": [{"id": "smp_A", "recordingId": "rec_A", "path": path,
                           "aliases": ["library/source.wav"], "audio": {"sha256": sha}}],
            "clips": clips if clips is not None else [
                {"id": "clp_A", "sampleId": "smp_A", "name": "first", "start": 0, "end": 4},
                {"id": "clp_B", "sampleId": "smp_A", "name": "second", "start": 4, "end": 8}],
            "recordings": [{"id": "rec_A"}], "analyses": {"smp_A": manifest} if analysis else {}}


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "samples"
    (root / "library").mkdir(parents=True)
    path = root / "library" / "source.wav"
    sf.write(path, np.linspace(-0.2, 0.2, 8000, dtype=np.float32), 1000)
    return root


def _fake_embed(monkeypatch, *, fail_batch=False, fail_second=False):
    calls = []
    def embed(items, sr):
        calls.append(len(items))
        if fail_batch and len(items) > 1:
            raise RuntimeError("batch failure")
        if fail_second and len(calls) > 2:
            raise RuntimeError("region failure")
        out = np.zeros((len(items), 512), dtype=np.float32)
        for i in range(len(items)):
            out[i, (len(calls) + i) % 512] = 1
        return out
    monkeypatch.setattr(clap, "embed_audio_batch", embed)
    return calls


def test_backfill_reads_canonical_clips_and_reuses_current_sidecar(source, monkeypatch):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    calls = _fake_embed(monkeypatch)
    first = backfill(catalog, source)
    assert first["samples"]["smp_A"]["recomputed"] == {"saved_clip": 2, "window": 1}
    assert max(calls) <= 4
    second = backfill(catalog, source)
    assert second["samples"]["smp_A"]["reused"] == {"saved_clip": 2, "window": 1}
    assert len(calls) == 1


def test_boundary_rename_retirement_grid_and_invalid_vector_are_reconciled(source, monkeypatch):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    _fake_embed(monkeypatch)
    backfill(catalog, source)
    catalog["clips"][0]["end"] = 3
    catalog["clips"][1]["name"] = "renamed"
    catalog["clips"][1]["retired"] = True
    catalog["analyses"]["smp_A"]["rhythm"]["bpm"] = 121
    manifest_path = source / "library" / "source.wav.apricity.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["rhythm"]["bpm"] = 121
    manifest_path.write_text(json.dumps(manifest))
    report = backfill(catalog, source)
    row = report["samples"]["smp_A"]
    assert row["recomputed"]["saved_clip"] == 1
    assert row["reused"]["saved_clip"] == 0
    assert row["recomputed"]["window"] == 1
    assert any(x["reason"] == "retired" for x in row["excluded"])


def test_missing_or_mismatched_analysis_grid_is_excluded_before_sidecar_reuse(source, monkeypatch):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    _fake_embed(monkeypatch)
    backfill(catalog, source)
    sidecar = source / "library" / "source.wav.clap.npz"
    old = sidecar.read_bytes()
    catalog["analyses"]["smp_A"]["rhythm"]["bpm"] = 121
    report = backfill(catalog, source)
    assert sidecar.read_bytes() == old
    assert "analysis_grid_mismatch" in {x["reason"] for x in report["samples"]["smp_A"]["excluded"]}


@pytest.mark.parametrize("change, reason", [
    (lambda c: c.__setitem__("analyses", {}), "missing_analysis"),
    (lambda c: c["analyses"]["smp_A"]["source"].__setitem__("sha256", "b" * 64), "analysis_source_sha_mismatch"),
    (lambda c: c["samples"][0]["audio"].__setitem__("sha256", "b" * 64), "audio_sha_mismatch"),
])
def test_bad_source_leaves_existing_sidecar_untouched(source, monkeypatch, change, reason):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    _fake_embed(monkeypatch)
    backfill(catalog, source)
    sidecar = source / "library" / "source.wav.clap.npz"
    old = sidecar.read_bytes()
    change(catalog)
    report = backfill(catalog, source)
    assert sidecar.read_bytes() == old
    assert reason in {x["reason"] for x in report["samples"]["smp_A"]["excluded"]}


def test_path_escapes_and_batch_failures_are_explicit_and_partial_work_is_durable(source, monkeypatch):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source, path="../outside.wav")
    catalog["samples"][0]["aliases"] = []
    report = backfill(catalog, source)
    assert "unsafe_source_path" in {x["reason"] for x in report["samples"]["smp_A"]["excluded"]}
    catalog = _catalog(source)
    _fake_embed(monkeypatch, fail_batch=True, fail_second=True)
    report = backfill(catalog, source, batch_size=3)
    row = report["samples"]["smp_A"]
    assert any("embedding_error" in x["reason"] for x in row["excluded"])
    sidecar = source / "library" / "source.wav.clap.npz"
    assert sidecar.exists()  # completed regions survive an interrupted/partial invocation
    calls = _fake_embed(monkeypatch)
    resumed = backfill(catalog, source, batch_size=3)
    assert resumed["samples"]["smp_A"]["reused"]["saved_clip"] + resumed["samples"]["smp_A"]["reused"]["window"] >= 1
    assert max(calls) <= 3


def test_cli_requires_roots_and_help():
    script = "scripts/semantic-backfill.py"
    result = subprocess.run([sys.executable, script, "--help"], text=True, capture_output=True)
    assert result.returncode == 0
    assert "--catalog" in result.stdout and "--samples" in result.stdout and "--report" in result.stdout


def test_canonical_id_and_alias_preflight_prevents_any_sidecar_overwrite(source, monkeypatch):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    _fake_embed(monkeypatch)
    backfill(catalog, source)
    sidecar = source / "library" / "source.wav.clap.npz"
    old = sidecar.read_bytes()

    catalog["clips"][1]["id"] = catalog["clips"][0]["id"]
    report = backfill(catalog, source)
    assert report["fatal"] == ["duplicate_clip_id"]
    assert report["samples"] == {}
    assert sidecar.read_bytes() == old

    catalog = _catalog(source)
    catalog["samples"][0]["id"] = ""
    report = backfill(catalog, source)
    assert report["fatal"] == ["invalid_sample_id"]
    assert sidecar.read_bytes() == old

    catalog = _catalog(source)
    catalog["recordings"][0]["id"] = 7
    report = backfill(catalog, source)
    assert report["fatal"] == ["invalid_recording_id"]
    assert sidecar.read_bytes() == old

    catalog = _catalog(source)
    catalog["samples"][0]["aliases"] = "library/source.wav"
    report = backfill(catalog, source)
    assert report["fatal"] == ["invalid_sample_aliases"]
    assert sidecar.read_bytes() == old


def test_boolean_batch_size_is_not_accepted(source):
    from apricity_analyze.semantic_backfill import backfill
    report = backfill(_catalog(source), source, batch_size=True)
    assert report["fatal"] == ["invalid_input"]
    assert not (source / "library" / "source.wav.clap.npz").exists()


def test_manifest_symlink_escape_is_source_failure_and_preserves_sidecar(source, monkeypatch, tmp_path):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    _fake_embed(monkeypatch)
    backfill(catalog, source)
    sidecar = source / "library" / "source.wav.clap.npz"
    old = sidecar.read_bytes()
    manifest = source / "library" / "source.wav.apricity.json"
    outside = tmp_path / "outside.apricity.json"
    outside.write_text(manifest.read_text())
    manifest.unlink()
    os.symlink(outside, manifest)

    report = backfill(catalog, source)
    assert report["hasSourceFailures"] is True
    assert report["sourceFailures"] == [{"sampleId": "smp_A", "reason": "unsafe_source_manifest_path"}]
    assert sidecar.read_bytes() == old


def test_hash_read_failure_is_per_source_and_good_source_still_completes(source, monkeypatch):
    from apricity_analyze import semantic_backfill

    catalog = _catalog(source)
    good = source / "library" / "good.wav"
    sf.write(good, np.linspace(-0.1, 0.1, 8000, dtype=np.float32), 1000)
    good_sha = _sha(good)
    good_manifest = {"source": {"sha256": good_sha}, "rhythm": {"bpm": 120, "meter": [4, 4],
                     "beats": list(range(9)), "downbeats": [0, 1, 2, 3, 4]}}
    good.with_name("good.wav.apricity.json").write_text(json.dumps(good_manifest))
    catalog["samples"].append({"id": "smp_good", "recordingId": "rec_A", "path": "library/good.wav",
                               "aliases": None, "audio": {"sha256": good_sha}})
    catalog["analyses"]["smp_good"] = good_manifest
    _fake_embed(monkeypatch)
    real_hash = semantic_backfill._file_sha256

    def hash_with_denial(path):
        if path.name == "source.wav":
            raise PermissionError("denied by test")
        return real_hash(path)

    monkeypatch.setattr(semantic_backfill, "_file_sha256", hash_with_denial)
    report = semantic_backfill.backfill(catalog, source)
    assert report["hasSourceFailures"] is True
    assert report["sourceFailures"][0]["sampleId"] == "smp_A"
    assert report["sourceFailures"][0]["reason"].startswith("audio_hash_error:")
    assert report["samples"]["smp_good"]["coverage"] == {"saved_clip": 0, "window": 1}
    assert (source / "library" / "good.wav.clap.npz").exists()


def test_atomic_writer_failure_preserves_old_sidecar_and_reports_zero_coverage(source, monkeypatch):
    from apricity_analyze.semantic_backfill import backfill
    catalog = _catalog(source)
    _fake_embed(monkeypatch)
    backfill(catalog, source)
    sidecar = source / "library" / "source.wav.clap.npz"
    old = sidecar.read_bytes()
    catalog["clips"][0]["name"] = "renamed"
    monkeypatch.setattr(clap, "write_sidecar_v2", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disk full")))

    report = backfill(catalog, source)
    row = report["samples"]["smp_A"]
    assert row["coverage"] == {"saved_clip": 0, "window": 0}
    assert report["hasSourceFailures"] is True
    assert report["sourceFailures"][0]["reason"].startswith("sidecar_write_error:")
    assert sidecar.read_bytes() == old


def test_cli_returns_nonzero_for_source_failure_even_when_report_is_written(source, tmp_path):
    catalog = _catalog(source)
    catalog["samples"][0]["audio"]["sha256"] = "b" * 64
    catalog_path = tmp_path / "catalog.json"
    report_path = tmp_path / "report.json"
    catalog_path.write_text(json.dumps(catalog))
    result = subprocess.run([sys.executable, "scripts/semantic-backfill.py", "--catalog", str(catalog_path),
                             "--samples", str(source), "--report", str(report_path)], text=True, capture_output=True)
    assert result.returncode != 0
    report = json.loads(report_path.read_text())
    assert report["hasSourceFailures"] is True
    assert report["sourceFailures"][0]["reason"] == "audio_sha_mismatch"
