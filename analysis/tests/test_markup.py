import json
import pathlib

import pytest

from apricitus_analyze.markup import merge

ROOT = pathlib.Path(__file__).resolve().parents[2]
MARCHES = sorted((ROOT / "samples/marine-band").glob("*.mp3.apricitus.json"))


def test_merge_keeps_user_work_and_replaces_old_ml():
    existing = {
        "slices": [
            {"name": "hook", "start": 1, "end": 2, "source": "user"},
            {"name": "mine", "start": 3, "end": 4},  # no source = a person made it
            {"name": "loop-1", "start": 5, "end": 6, "source": "ml"},
        ],
        "markers": [{"name": "old", "seconds": 1, "source": "ml"}, {"name": "cue", "seconds": 2, "source": "user"}],
        "tags": ["keep me"],
    }
    ml = {
        "slices": [{"name": "loop-1", "start": 7, "end": 8, "source": "ml"}, {"name": "hook", "start": 9, "end": 10, "source": "ml"}],
        "markers": [{"name": "hit", "seconds": 3, "source": "ml"}],
    }
    out = merge(existing, ml)
    names = [(s["name"], s.get("source")) for s in out["slices"]]
    assert names == [("hook", "user"), ("mine", None), ("loop-1", "ml")], "user slices kept; ML 'hook' skipped (name taken)"
    assert [s for s in out["slices"] if s["name"] == "loop-1"][0]["start"] == 7, "old ML markup replaced"
    assert [m["name"] for m in out["markers"]] == ["cue", "hit"]
    assert out["tags"] == ["keep me"]


needs_marches = pytest.mark.skipif(not MARCHES, reason="no analyzed marches")


def ml(m, tag=None):
    return [s for s in m.get("annotations", {}).get("slices", []) if s.get("source") == "ml" and (tag is None or tag in s.get("tags", []))]


@needs_marches
@pytest.mark.parametrize("path", MARCHES, ids=lambda p: p.name.split(".")[0])
def test_march_markup_is_well_formed(path):
    m = json.loads(path.read_text())
    dur, beats = m["source"]["duration"], m["rhythm"]["beats"]
    for s in ml(m):
        assert 0 <= s["start"] < s["end"] <= dur + 1e-6
    secs = ml(m, "section")
    assert len(secs) >= 4, "a march has several sections"
    # Sections tile the clip in order, starting and ending on beats.
    for a, b in zip(secs, secs[1:]):
        assert abs(a["end"] - b["start"]) < 1e-6
    for s in secs:
        assert min(abs(s["start"] - t) for t in beats) < 0.02
    assert len(ml(m, "loop")) >= 1


@needs_marches
def test_marches_show_their_form():
    """Across the Marine Band marches, most should show a repeated section and a trio."""
    repeated = trio = 0
    for path in MARCHES:
        secs = ml(json.loads(path.read_text()), "section")
        letters = [s["name"].removeprefix("sec-")[0] for s in secs if s["name"].startswith("sec-")]
        repeated += len(letters) != len(set(letters))
        trio += any("trio" in s["tags"] for s in secs)
    assert repeated >= len(MARCHES) * 0.6, f"only {repeated}/{len(MARCHES)} marches show a repeated section"
    assert trio >= len(MARCHES) * 0.6, f"only {trio}/{len(MARCHES)} marches have a trio"


def test_drum_stems_get_no_sections():
    for path in (ROOT / "samples/marine-band/stems").glob("*/drums.wav.apricitus.json"):
        assert not ml(json.loads(path.read_text()), "section")


def test_phrases_split_at_pauses_not_breaths():
    import numpy as np

    from apricitus_analyze.analyze import SR
    from apricitus_analyze.markup import phrases

    rng = np.random.default_rng(0)

    def talk(secs):
        t = np.arange(int(secs * SR)) / SR
        return (0.3 * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))).astype(np.float32)

    def gap(secs):
        return (1e-4 * rng.standard_normal(int(secs * SR))).astype(np.float32)

    # "phrase" 1 has a 0.1 s breath inside it; then 0.6 s and 0.4 s pauses.
    audio = np.concatenate([talk(1.0), gap(0.1), talk(0.8), gap(0.6), talk(1.5), gap(0.4), talk(0.7), gap(0.3)])
    got = phrases(audio)
    assert len(got) == 3, got
    starts = [a for a, _ in got]
    assert abs(starts[1] - 2.5) < 0.06 and abs(starts[2] - 4.4) < 0.06, got
    assert all(b > a for a, b in got)
    # Dense music with no pauses: nothing to mark.
    assert phrases(talk(5.0)) == []
