"""Tests for `apricity_analyze.explore.verdicts` and the notebook's archive: verdicts are appended to the
library and never lost, a run's text is mirrored there, and the taste term follows what was judged."""

from __future__ import annotations

import json

import pytest

from apricity_analyze.explore import verdicts as vs
from apricity_analyze.explore.notebook import Notebook


def _run(tmp_path, name="run1"):
    """A run whose notebook is archived in the library, with three experiments that cast three clips."""
    lib = tmp_path / "lib"
    nb = Notebook(tmp_path / "renders" / name, meta={"role": "bright"}, archive=vs.notebooks_dir(lib) / "explore" / name)
    for i, clip in enumerate(["loop-1", "loop-2", "loop-3"], 1):
        nb.save_experiment(f"stage3-{i:04d}", base_sha="abc", ops_list=[{"op": "cast.swap", "role": "bright", "sample": "s/a.wav", "clip": clip}],
                           predicted=None, score_text=f"score {i}\n", check_json={"objective": 70 + i})
    nb.log({"trial": 1})
    return lib, nb


def test_the_notebook_mirrors_its_text_into_the_archive(tmp_path):
    lib, nb = _run(tmp_path)
    arch = vs.notebooks_dir(lib) / "explore" / "run1"
    assert json.loads((arch / "run.json").read_text()) == {"role": "bright"}
    assert (arch / "stage3-0002" / "score.apr").read_text() == "score 2\n"
    assert json.loads((arch / "stage3-0002" / "experiment.json").read_text())["ops"][0]["clip"] == "loop-2"
    assert (arch / "notebook.jsonl").read_text().count("\n") == 1
    nb.write_leaderboard([{"label": "x", "objective": 71.0}])
    nb.finalize_best("best\n", None)
    assert (arch / "leaderboard.md").exists() and (arch / "best.apr").read_text() == "best\n"


def test_verdicts_are_appended_with_what_they_judged(tmp_path):
    lib, _ = _run(tmp_path)
    a = vs.record(vs.Verdict(kind="stars", run="run1", experiment="stage3-0002", stars=4, note="warmer"), library=lib)
    assert (a.sample, a.clip) == ("s/a.wav", "loop-2") and a.score_sha and a.at and a.id
    vs.record(vs.Verdict(kind="none", run="run1", over=["stage3-0001", "stage3-0003"], note="the stack alone"), library=lib)
    got = vs.read(library=lib)
    assert [v.kind for v in got] == ["stars", "none"]
    assert got[1].over_casts == [["s/a.wav", "loop-1"], ["s/a.wav", "loop-3"]]
    assert len((vs.notebooks_dir(lib) / "verdicts.jsonl").read_text().splitlines()) == 2


def test_a_verdict_must_make_sense(tmp_path):
    for bad in (
        vs.Verdict(kind="love", run="r", experiment="e"),
        vs.Verdict(kind="stars", run="r", experiment="e", stars=6),
        vs.Verdict(kind="stars", run="r", stars=3),
        vs.Verdict(kind="pick", run="r", experiment="e"),
        vs.Verdict(kind="none", run="r", experiment="e", over=["x"]),
    ):
        with pytest.raises(ValueError):
            vs.record(bad, library=tmp_path)
    assert vs.read(library=tmp_path) == []


def test_taste_follows_the_verdicts_smoothed_toward_unrated(tmp_path):
    lib, _ = _run(tmp_path)
    assert vs.taste("s/a.wav", "loop-2", library=lib) == 0.5  # nobody's judged it
    vs.record(vs.Verdict(kind="stars", run="run1", experiment="stage3-0002", stars=5), library=lib)
    once = vs.taste("s/a.wav", "loop-2", library=lib)
    assert 0 < once < 0.5  # liked, but one rating doesn't decide it
    vs.record(vs.Verdict(kind="pick", run="run1", experiment="stage3-0002", over=["stage3-0001"]), library=lib)
    assert vs.taste("s/a.wav", "loop-2", library=lib) < once
    assert vs.taste("s/a.wav", "loop-1", library=lib) > 0.5  # it lost
    assert vs.taste("s/a.wav", "loop-3", library=lib) == 0.5

