"""Tests for `apricity_analyze.explore.notebook`: the log is append-only, experiments and the
leaderboard get written where expected."""

from __future__ import annotations

import json

from apricity_analyze.explore.notebook import Notebook


def test_log_is_append_only(tmp_path):
    nb = Notebook(tmp_path / "run1", meta={"role": "bright"})
    nb.log({"a": 1})
    nb.log({"a": 2})
    lines = (tmp_path / "run1" / "notebook.jsonl").read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["a"] == 1
    assert json.loads(lines[1])["a"] == 2

    # A second Notebook instance over the same run dir keeps what's already there.
    nb2 = Notebook(tmp_path / "run1", meta={"role": "bright"})
    nb2.log({"a": 3})
    lines = (tmp_path / "run1" / "notebook.jsonl").read_text().splitlines()
    assert len(lines) == 3, "re-opening a run must never truncate its notebook"
    assert [r["a"] for r in nb2.read_log()] == [1, 2, 3]


def test_save_experiment_writes_its_files(tmp_path):
    nb = Notebook(tmp_path / "run2", meta={})
    exp_id = nb.new_experiment_id("stage1")
    assert exp_id == "stage1-0001"
    d = nb.save_experiment(exp_id, base_sha="abc123", ops_list=[{"op": "track.volume", "track": "bright", "delta": 2}],
                            predicted="(explain output)", score_text="tempo 100\n", check_json={"objective": 50.0})
    assert (d / "experiment.json").exists()
    assert (d / "score.apr").read_text() == "tempo 100\n"
    exp = json.loads((d / "experiment.json").read_text())
    assert exp["base_sha"] == "abc123"
    assert exp["ops"][0]["op"] == "track.volume"
    assert exp["predicted"] == "(explain output)"
    check_json = json.loads((d / "check.json").read_text())
    assert check_json["objective"] == 50.0

    # A second experiment gets the next id.
    exp_id2 = nb.new_experiment_id("stage1")
    assert exp_id2 == "stage1-0002"


def test_write_leaderboard(tmp_path):
    nb = Notebook(tmp_path / "run3", meta={})
    nb.write_leaderboard([
        {"label": "(incumbent)", "objective": 60.0, "consonance": 70.0, "attribution": ""},
        {"label": "cast X", "objective": 75.5, "consonance": 80.0, "attribution": "CC BY 3.0"},
    ])
    text = (tmp_path / "run3" / "leaderboard.md").read_text()
    assert "75.5" in text and "CC BY 3.0" in text and "(incumbent)" in text
