import json
import pathlib

import pytest

from apricity_analyze.markup import merge

ROOT = pathlib.Path(__file__).resolve().parents[2]
MARCHES = sorted((ROOT / "samples/marine-band").glob("*.mp3.apricity.json"))


def test_merge_keeps_user_work_and_replaces_old_ml():
    existing = {
        "clips": [
            {"name": "hook", "start": 1, "end": 2, "source": "user"},
            {"name": "mine", "start": 3, "end": 4},  # no source = a person made it
            {"name": "loop-1", "start": 5, "end": 6, "source": "ml"},
        ],
        "markers": [{"name": "old", "seconds": 1, "source": "ml"}, {"name": "cue", "seconds": 2, "source": "user"}],
        "tags": ["keep me"],
    }
    ml = {
        "clips": [{"name": "loop-1", "start": 7, "end": 8, "source": "ml"}, {"name": "hook", "start": 9, "end": 10, "source": "ml"}],
        "markers": [{"name": "transient", "seconds": 3, "source": "ml"}],
    }
    out = merge(existing, ml)
    names = [(s["name"], s.get("source")) for s in out["clips"]]
    assert names == [("hook", "user"), ("mine", None), ("loop-1", "ml")], "your clips kept; ML 'hook' skipped (name taken)"
    assert [s for s in out["clips"] if s["name"] == "loop-1"][0]["start"] == 7, "old ML markup replaced"
    assert [m["name"] for m in out["markers"]] == ["cue", "transient"]
    assert out["tags"] == ["keep me"]


needs_marches = pytest.mark.skipif(not MARCHES, reason="no analyzed marches")


def ml(m, tag=None):
    return [s for s in m.get("annotations", {}).get("clips", []) if s.get("source") == "ml" and (tag is None or tag in s.get("tags", []))]


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
    for path in (ROOT / "samples/marine-band/stems").glob("*/drums.wav.apricity.json"):
        assert not ml(json.loads(path.read_text()), "section")


def test_phrases_split_at_pauses_not_breaths():
    import numpy as np

    from apricity_analyze.analyze import SR
    from apricity_analyze.markup import phrases

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


# ================================================================ holds

def test_holds_single_long_clean_note():
    """A single long clean note gives one hold with exact region and tags."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 60, "velocity": 0.6}
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    assert len(result) == 1
    assert result[0]["name"] == "hold-1"
    assert abs(result[0]["start"] - (1.0 - 0.02)) < 0.001
    assert abs(result[0]["end"] - (2.5 + 0.15)) < 0.001
    assert "C4" in result[0]["tags"]  # MIDI 60 = C4
    assert "hold" in result[0]["tags"]
    assert "1.5s" in result[0]["tags"]
    assert result[0]["source"] == "ml"


def test_holds_long_note_with_louder_notes_inside_is_rejected():
    """A long note is rejected when a note inside is louder by more than 0.1."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 3.0, "midi": 60, "velocity": 0.5},  # candidate
        {"start": 1.2, "end": 1.3, "midi": 62, "velocity": 0.61},  # louder by 0.11, rejects
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    # The first note should be rejected
    assert len(result) == 0


def test_holds_held_chord():
    """Three notes starting together form one hold tagged chord."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 48, "velocity": 0.6},  # lowest
        {"start": 1.01, "end": 2.4, "midi": 52, "velocity": 0.5},  # within 0.08s
        {"start": 1.02, "end": 2.3, "midi": 55, "velocity": 0.5},  # within 0.08s
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    assert len(result) == 1
    assert result[0]["name"] == "hold-1"
    assert "chord" in result[0]["tags"]
    assert "C3" in result[0]["tags"]  # lowest note (MIDI 48)


def test_holds_two_overlapping_candidates_keeps_higher_rank():
    """Two overlapping candidates: only the higher duration * velocity one is kept."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 3.0, "midi": 60, "velocity": 0.5},  # duration 2.0, rank = 2.0 * 0.5 = 1.0
        {"start": 1.5, "end": 4.0, "midi": 62, "velocity": 0.6},  # duration 2.5, rank = 2.5 * 0.6 = 1.5 (higher)
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    assert len(result) == 1
    assert result[0]["evidence"]["held"] == 62  # D4


def test_holds_max_holds_limit():
    """More than max_holds candidates: exactly max_holds, numbered in time order."""
    from apricity_analyze.markup import holds
    
    notes = []
    for i in range(20):
        notes.append({"start": float(i), "end": float(i + 1.0), "midi": 60 + i % 12, "velocity": 0.6})
    duration = 25.0
    
    result = holds(notes, duration, max_holds=5)
    
    assert len(result) == 5
    # Check they're numbered 1-5 and in time order
    for i, hold in enumerate(result, 1):
        assert hold["name"] == f"hold-{i}"
        if i < len(result):
            assert hold["start"] < result[i]["start"]


def test_holds_region_clamped_to_duration():
    """The region is clamped to [0, duration]."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 0.01, "end": 1.5, "midi": 60, "velocity": 0.6}  # near start
    ]
    duration = 1.2
    
    result = holds(notes, duration)
    
    assert len(result) == 1
    assert abs(result[0]["start"] - 0.0) < 0.001  # max(0, 0.01 - 0.02) = 0
    assert abs(result[0]["end"] - 1.2) < 0.001    # min(1.5 + 0.15, 1.2) = 1.2


def test_holds_rejects_quiet_candidate_with_loudness_check():
    """A loud-looking note over quiet beat_loudness is rejected."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 60, "velocity": 0.8}  # high velocity
    ]
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
    beat_loudness = [0.0, 0.0, -30.0, -30.0, -30.0, 0.0, 0.0]  # very quiet around hold
    duration = 10.0
    
    result = holds(notes, duration, beats=beats, beat_loudness=beat_loudness)
    
    # Should be rejected because mean loudness is more than 15 dB below median
    assert len(result) == 0


def test_holds_keeps_loud_note_with_loudness_check():
    """The same note over normal loudness is kept."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 60, "velocity": 0.8}
    ]
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
    beat_loudness = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]  # normal loudness
    duration = 10.0
    
    result = holds(notes, duration, beats=beats, beat_loudness=beat_loudness)
    
    # Should be kept because loudness is OK
    assert len(result) == 1


def test_holds_tags_clean_without_beat_loudness():
    """Free-time clip without beat_loudness is tagged clean or busy based on notes."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 60, "velocity": 0.6}
    ]
    duration = 10.0
    
    result = holds(notes, duration, beats=None, beat_loudness=None)
    
    assert len(result) == 1
    assert ("clean" in result[0]["tags"] or "busy" in result[0]["tags"])


def test_holds_running_twice_gives_same_file():
    """Running the holds function twice on the same input gives the same result."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 60, "velocity": 0.6},
        {"start": 4.0, "end": 6.0, "midi": 62, "velocity": 0.5}
    ]
    duration = 10.0
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0]
    beat_loudness = [0.0] * len(beats)
    
    result1 = holds(notes, duration, beats=beats, beat_loudness=beat_loudness)
    result2 = holds(notes, duration, beats=beats, beat_loudness=beat_loudness)
    
    # Should be identical
    assert result1 == result2


def test_holds_busy_candidate_is_kept_and_tagged():
    """A busy candidate (many notes starting inside) is kept and tagged 'busy'."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 3.0, "midi": 60, "velocity": 0.5},  # candidate (busy)
        {"start": 1.2, "end": 1.3, "midi": 62, "velocity": 0.49},  # not louder
        {"start": 1.5, "end": 1.6, "midi": 64, "velocity": 0.48},  # not louder
        {"start": 2.0, "end": 2.1, "midi": 65, "velocity": 0.47},  # not louder
        {"start": 2.5, "end": 2.6, "midi": 66, "velocity": 0.46},  # not louder (9+ notes inside is ok)
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    assert len(result) == 1
    assert "busy" in result[0]["tags"]
    assert "hold" in result[0]["tags"]


def test_holds_rejects_if_note_inside_is_louder_by_more_than_0_1():
    """Rejects candidate when a note inside is louder by more than 0.1 velocity."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 3.0, "midi": 60, "velocity": 0.5},  # candidate
        {"start": 1.2, "end": 1.3, "midi": 62, "velocity": 0.61},  # louder by 0.11 (rejects)
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    # Should be rejected
    assert len(result) == 0


def test_holds_keeps_if_note_inside_is_louder_by_0_1_or_less():
    """Keeps candidate when notes inside are louder by 0.1 or less."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 3.0, "midi": 60, "velocity": 0.5},  # candidate
        {"start": 1.2, "end": 1.3, "midi": 62, "velocity": 0.6},  # louder by exactly 0.1 (ok)
    ]
    duration = 10.0
    
    result = holds(notes, duration)
    
    # Should be kept
    assert len(result) == 1


def test_holds_clean_outranks_longer_busy():
    """A clean candidate outranks a longer busy one."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 3.0, "midi": 60, "velocity": 0.8},  # longer, will be busy (3 notes inside)
        {"start": 5.0, "end": 6.0, "midi": 62, "velocity": 0.5},  # shorter, clean
        {"start": 1.2, "end": 1.3, "midi": 64, "velocity": 0.79},  # inside first
        {"start": 1.5, "end": 1.6, "midi": 65, "velocity": 0.78},  # inside first
        {"start": 2.0, "end": 2.1, "midi": 66, "velocity": 0.77},  # inside first (now busy: >2 notes)
    ]
    duration = 10.0
    
    result = holds(notes, duration, max_holds=1)
    
    # Only one hold, should be the clean one at 5.0
    assert len(result) == 1
    assert result[0]["start"] > 4.0


def test_holds_loudness_check_before_overlap_removal():
    """A quiet higher-ranked candidate doesn't block a loud overlapping one."""
    from apricity_analyze.markup import holds
    
    notes = [
        {"start": 1.0, "end": 2.5, "midi": 60, "velocity": 0.8},  # loud, first in rank
        {"start": 1.5, "end": 3.0, "midi": 62, "velocity": 0.6},  # loud, overlaps
    ]
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
    beat_loudness = [0.0, 0.0, -30.0, -30.0, -30.0, 0.0, 0.0]  # first one is quiet
    duration = 10.0
    
    result = holds(notes, duration, beats=beats, beat_loudness=beat_loudness)
    
    # First note should be rejected by loudness, so second note should be kept
    assert len(result) == 1
    assert result[0]["start"] > 1.0
