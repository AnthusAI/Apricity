"""Tests for `apricity_analyze.explore.ops`: each op applies and round-trips (the score still
compiles), and the whitelist has no mute/delete op."""

from __future__ import annotations

import pathlib
import subprocess

import pytest

from apricity_analyze.explore import ops

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "target/release/apricity"
SAMPLES = ROOT / "samples"

TINY = f"""tempo 100
key C major
samples {SAMPLES}

clip bright = ccmixter/AlexBeroza/Ave_34409.mp3  loop-2
clip low    = ccmixter/AlexBeroza/Ave_34409.mp3  hold-4  root Ab1

chords I | IV | V | I

track bright  transpose 2
  eq  peak -4@800 q8
track low  voicing root  octave 2
"""


def compiles(text: str) -> tuple[bool, str]:
    p = pathlib.Path(pathlib.os.environ.get("TMPDIR", "/tmp")) / "apricity-ops-test.apr"
    p.write_text(text)
    r = subprocess.run([str(BIN), "compile", str(p)], capture_output=True, text=True)
    return r.returncode == 0, r.stderr


pytestmark = pytest.mark.skipif(not BIN.exists(), reason="release binary not built")


def test_no_mute_or_delete_op_exists():
    assert "mute" not in ops.OP_NAMES and "delete" not in ops.OP_NAMES
    for name in ops.OP_NAMES:
        assert "mute" not in name and "delete" not in name


def test_cast_swap_repoints_the_clip_and_sets_transpose_auto_and_drops_only_tags():
    text = TINY.replace("clip bright = ccmixter/AlexBeroza/Ave_34409.mp3  loop-2",
                         "clip bright = ccmixter/AlexBeroza/Ave_34409.mp3  loop-2  # only:bright\n"
                         "extra_only_line  # only:bright")
    out = ops.apply(text, {"op": "cast.swap", "role": "bright", "sample": "ccmixter/CSoul/we-lived-and-learned-and-loved-and-chose_32859.mp3", "clip": "loop-1"})
    assert "we-lived-and-learned-and-loved-and-chose_32859.mp3  loop-1" in out
    assert "transpose 2" not in out
    assert "# only:bright" not in out
    assert "extra_only_line" not in out
    ok, err = compiles(out)
    assert ok, err


def test_track_eq_notch_adds_a_peak_and_caps_at_4_per_line_and_8_per_track():
    text = ops.apply(TINY, {"op": "track.eq_notch", "track": "bright", "hz": 300, "gain": -6, "q": 8})
    assert "peak -6@300 q8" in text
    ok, err = compiles(text)
    assert ok, err

    # Fill the first eq line to 4 peaks, then a 5th spills to a new eq line.
    t = TINY
    for hz in (200, 300, 400):
        t = ops.apply(t, {"op": "track.eq_notch", "track": "bright", "hz": hz, "gain": -4, "q": 8})
    assert t.count("peak") == 4  # the original one plus 3 added
    t2 = ops.apply(t, {"op": "track.eq_notch", "track": "bright", "hz": 500, "gain": -4, "q": 8})
    assert t2.count("peak") == 5
    assert t2.count("\n  eq") == 2, "a 5th peak needs a second eq line"
    ok, err = compiles(t2)
    assert ok, err

    # 8 is the hard cap on the whole track.
    t3 = t2
    for hz in (600, 700, 800):
        t3 = ops.apply(t3, {"op": "track.eq_notch", "track": "bright", "hz": hz, "gain": -4, "q": 8})
    assert t3.count("peak") == 8
    with pytest.raises(ops.OpError):
        ops.apply(t3, {"op": "track.eq_notch", "track": "bright", "hz": 900, "gain": -4, "q": 8})


def test_track_eq_notch_rejects_an_unlisted_gain_or_q():
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.eq_notch", "track": "bright", "hz": 300, "gain": -5, "q": 8})
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.eq_notch", "track": "bright", "hz": 300, "gain": -6, "q": 10})


def test_track_hp_toggles_on_and_off_and_is_idempotent():
    on = ops.apply(TINY, {"op": "track.hp", "track": "bright", "hz": 250, "slope": "24dB", "on": True})
    assert "filter hp 250 24dB" in on
    ok, err = compiles(on)
    assert ok, err
    # Applying again (a different hz) replaces, doesn't stack.
    on2 = ops.apply(on, {"op": "track.hp", "track": "bright", "hz": 400, "slope": "24dB", "on": True})
    assert on2.count("filter hp") == 1
    assert "filter hp 400 24dB" in on2
    off = ops.apply(on2, {"op": "track.hp", "track": "bright", "hz": 400, "slope": "24dB", "on": False})
    assert "filter hp" not in off
    ok, err = compiles(off)
    assert ok, err


def test_track_transpose_sets_auto_or_a_fixed_value():
    auto = ops.apply(TINY, {"op": "track.transpose", "track": "bright", "value": "auto"})
    assert "transpose 2" not in auto and "transpose auto" in auto
    ok, err = compiles(auto)
    assert ok, err
    fixed = ops.apply(TINY, {"op": "track.transpose", "track": "bright", "value": -3})
    assert "transpose -3" in fixed
    ok, err = compiles(fixed)
    assert ok, err


def test_clip_root_pins_a_new_note():
    out = ops.apply(TINY, {"op": "clip.root", "clip": "low", "note": "A1"})
    assert "root A1" in out and "root Ab1" not in out
    ok, err = compiles(out)
    assert ok, err
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "clip.root", "clip": "low", "note": "not-a-note"})


def test_track_octave_sets_the_octave():
    out = ops.apply(TINY, {"op": "track.octave", "track": "low", "n": 3})
    assert "octave 3" in out and "octave 2" not in out
    ok, err = compiles(out)
    assert ok, err


def test_track_release_sets_a_release_time():
    out = ops.apply(TINY, {"op": "track.release", "track": "low", "ms": 250})
    assert "release 250ms" in out
    ok, err = compiles(out)
    assert ok, err
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.release", "track": "low", "ms": -1})


def test_track_volume_nudges_relative_to_current():
    out = ops.apply(TINY, {"op": "track.volume", "track": "bright", "delta": -4})
    assert "volume -4" in out
    out2 = ops.apply(out, {"op": "track.volume", "track": "bright", "delta": 2})
    assert "volume -2" in out2
    ok, err = compiles(out2)
    assert ok, err
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.volume", "track": "bright", "delta": 3})


def test_unknown_op_raises():
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.mute", "track": "bright"})


def test_missing_track_or_clip_raises():
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.volume", "track": "nope", "delta": 2})
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "clip.root", "clip": "nope", "note": "C2"})
