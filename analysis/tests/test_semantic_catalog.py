import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

from apricity_analyze.semantic_catalog import export_catalog


def _cli():
    path = Path(__file__).parents[2] / "scripts" / "semantic-catalog-export.py"
    spec = importlib.util.spec_from_file_location("semantic_catalog_export", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write(root, table, identifier, body):
    path = root / table / f"{identifier}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))


def test_export_reads_native_root_file_refs_and_preserves_ids(tmp_path):
    analysis = {"rhythm": {"bpm": 120}}
    payload = json.dumps(analysis).encode()
    sha = hashlib.sha256(payload).hexdigest()
    file = tmp_path / "files" / "analysis" / "smp_A" / "manifest.json"
    file.parent.mkdir(parents=True)
    file.write_bytes(payload)
    _write(tmp_path, "Sample", "smp_A", {"id": "smp_A", "recordingId": "rec_A", "analysis":
           {"key": "analysis/smp_A/manifest.json", "sha256": sha}, "audio": {"key": "audio/a", "sha256": "a" * 64}})
    _write(tmp_path, "Clip", "clp_A", {"id": "clp_A", "sampleId": "smp_A", "start": 0, "end": 4})
    _write(tmp_path, "Recording", "rec_A", {"id": "rec_A"})
    report = export_catalog(tmp_path)
    assert report["catalog"] == {"samples": [{"id": "smp_A", "recordingId": "rec_A", "analysis":
           {"key": "analysis/smp_A/manifest.json", "sha256": sha}, "audio": {"key": "audio/a", "sha256": "a" * 64}}],
           "clips": [{"id": "clp_A", "sampleId": "smp_A", "start": 0, "end": 4}], "recordings": [{"id": "rec_A"}],
           "analyses": {"smp_A": analysis}}
    assert report["excluded"] == []


def test_export_excludes_missing_unsafe_or_hash_mismatched_analysis_without_inventing_ids(tmp_path):
    _write(tmp_path, "Sample", "smp_A", {"id": "smp_A", "analysis": {"key": "../escape", "sha256": "a" * 64}})
    _write(tmp_path, "Sample", "smp_B", {"id": "smp_B", "analysis": {"key": "analysis/missing.json", "sha256": "b" * 64}})
    _write(tmp_path, "Clip", "clp_A", {"id": "clp_A", "sampleId": "smp_A"})
    _write(tmp_path, "Recording", "rec_A", {"id": "rec_A"})
    result = export_catalog(tmp_path)
    assert result["catalog"]["samples"] == [{"id": "smp_A", "analysis": {"key": "../escape", "sha256": "a" * 64}}, {"id": "smp_B", "analysis": {"key": "analysis/missing.json", "sha256": "b" * 64}}]
    assert result["catalog"]["analyses"] == {}
    assert {(row["sampleId"], row["reason"]) for row in result["excluded"]} == {("smp_A", "unsafe_analysis_file_ref"), ("smp_B", "missing_analysis_file")}


def test_export_rejects_native_table_symlink_escape_malformed_rows_and_duplicate_ids(tmp_path):
    outside = tmp_path.parent / "outside-sample.json"
    outside.write_text(json.dumps({"id": "smp_escape"}))
    table = tmp_path / "Sample"; table.mkdir()
    os.symlink(outside, table / "escape.json")
    (table / "bad.json").write_text("{")
    _write(tmp_path, "Sample", "one", {"id": "smp_A"})
    _write(tmp_path, "Sample", "two", {"id": "smp_A"})
    result = export_catalog(tmp_path)
    assert result["catalog"]["samples"] == [{"id": "smp_A"}]
    assert {(row["reason"], row.get("source")) for row in result["excluded"]} >= {
        ("unsafe_native_table_row", "escape.json"), ("invalid_native_json", "bad.json"), ("duplicate_native_id", "two.json"),
    }


def test_catalog_export_cli_has_no_unused_samples_flag_and_writes_export(monkeypatch, tmp_path, capsys):
    cli, output = _cli(), tmp_path / "catalog.json"
    monkeypatch.setattr(cli, "export_catalog", lambda library: {"catalog": {"samples": [], "clips": [], "recordings": [], "analyses": {}}, "excluded": []})
    assert cli.main(["--library", str(tmp_path / "library"), "--output", str(output)]) == 0
    assert json.loads(output.read_text()) == {"analyses": {}, "clips": [], "recordings": [], "samples": []}
    assert json.loads(capsys.readouterr().err)["counts"] == {"analyses": 0, "clips": 0, "recordings": 0, "samples": 0}
    with pytest.raises(SystemExit):
        cli.main(["--library", str(tmp_path / "library"), "--output", str(output), "--samples"])
