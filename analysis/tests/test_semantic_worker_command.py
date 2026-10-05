"""Focused CLI contract for the one-shot ground worker."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from apricity_analyze.cluster_jobs import StorageError
from apricity_analyze.lab.cli import main
from apricity_analyze.lab.commands import semantic


def test_semantic_worker_cli_runs_at_most_one_idle_job_and_redacts_internal_lease_state(tmp_path, capsys):
    corpus = tmp_path / "corpus.json"; catalog = tmp_path / "catalog.json"
    corpus.write_text(json.dumps({"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": "clap-htsat-unfused-512-v1", "processingFingerprint": "process-v1", "records": []}))
    catalog.write_text(json.dumps({"samples": [], "clips": [], "recordings": [], "analyses": {}}))

    assert main(["semantic", "worker", "--control-root", str(tmp_path / "control"), "--runs-root", str(tmp_path / "drafts"),
                 "--corpus", str(corpus), "--catalog", str(catalog), "--worker-id", "ground-a"]) == 0
    output = capsys.readouterr().out
    assert json.loads(output) == {"state": "idle"}
    assert "lease" not in output.lower() and "token" not in output.lower()


def test_semantic_worker_cli_reports_control_outage_without_secret_or_traceback(tmp_path, capsys, monkeypatch):
    corpus = tmp_path / "corpus.json"; catalog = tmp_path / "catalog.json"
    corpus.write_text("{}")
    catalog.write_text("{}")
    monkeypatch.setattr(semantic, "ClusterJobService", lambda *_args: (_ for _ in ()).throw(StorageError("control_store_unavailable", retryable=True)))

    assert main(["semantic", "worker", "--control-root", str(tmp_path / "control"), "--runs-root", str(tmp_path / "drafts"),
                 "--corpus", str(corpus), "--catalog", str(catalog), "--worker-id", "ground-a"]) == 2
    output = capsys.readouterr().out
    assert json.loads(output) == {"state": "unavailable", "error": "temporary_capacity"}
    assert "traceback" not in output.lower() and "token" not in output.lower()


@pytest.mark.parametrize("interruption", (KeyboardInterrupt, SystemExit))
def test_semantic_worker_cli_does_not_convert_process_cancellation_to_json(tmp_path, capsys, monkeypatch, interruption):
    monkeypatch.setattr(semantic, "run_once", lambda *_args, **_kwargs: (_ for _ in ()).throw(interruption()))
    args = SimpleNamespace(worker_id="ground-a", control_root=tmp_path / "control", runs_root=tmp_path / "drafts",
                           corpus=tmp_path / "corpus.json", catalog=tmp_path / "catalog.json")

    with pytest.raises(interruption):
        semantic.run_worker(args)

    assert capsys.readouterr().out == ""
