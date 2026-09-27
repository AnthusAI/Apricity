"""Tests for `apricity_analyze.explore.ops`: each op applies and round-trips (the score still
compiles), and the whitelist has no mute/delete op."""

from __future__ import annotations

import pathlib
import re
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


def test_track_transpose_span_splits_around_the_span_and_keeps_the_original_transpose_outside_it():
    text = TINY  # `track bright  transpose 2` with no explicit `bars` -> needs total_bars
    out = ops.apply(text, {"op": "track.transpose_span", "track": "bright", "bars": [2, 2], "value": -3, "total_bars": 4})
    # A single-bar range prints "bars 1", not "bars 1-1" (`track.bars`/`track.transpose_span`
    # both collapse a==b that way) -- `\b` word boundaries so "bars 1" doesn't match inside "bars 1-4".
    assert re.search(r"\bbars 1\b(?!-)", out) and re.search(r"\bbars 1\b(?!-).*\btranspose 2\b", out)  # before the span: kept
    assert re.search(r"\bbars 2\b(?!-).*\btranspose -3\b", out)  # the span itself
    assert "bars 3-4" in out  # after the span: kept
    assert out.count("track bright") == 3
    assert out.count("as bright_") == 3
    ok, err = compiles(out)
    assert ok, err


def test_track_transpose_span_uses_an_explicit_bars_range_without_total_bars():
    text = TINY.replace("track bright  transpose 2", "track bright  bars 1-4  transpose 2")
    out = ops.apply(text, {"op": "track.transpose_span", "track": "bright", "bars": [3, 4], "value": 0})
    assert "bars 1-2" in out and "transpose 2" in out
    assert "bars 3-4" in out and "transpose 0" in out
    assert out.count("track bright") == 2  # the whole range is 1-4, so only 2 segments (no "after")
    ok, err = compiles(out)
    assert ok, err


def test_track_transpose_span_rejects_a_span_outside_the_track_range():
    text = TINY.replace("track bright  transpose 2", "track bright  bars 1-4  transpose 2")
    with pytest.raises(ops.OpError):
        ops.apply(text, {"op": "track.transpose_span", "track": "bright", "bars": [3, 8], "value": 0})
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.transpose_span", "track": "bright", "bars": [2, 2], "value": 0})  # no total_bars, no explicit bars


def test_track_transpose_span_is_idempotent_on_the_span_itself():
    text = TINY.replace("track bright  transpose 2", "track bright  bars 1-4  transpose 2")
    once = ops.apply(text, {"op": "track.transpose_span", "track": "bright", "bars": [3, 4], "value": 0})
    twice = ops.apply(once, {"op": "track.transpose_span", "track": "bright", "bars": [3, 4], "value": 5})
    assert "transpose 5" in twice
    ok, err = compiles(twice)
    assert ok, err


def test_track_bars_sets_or_replaces_the_range():
    # TINY is 4 bars (`chords I | IV | V | I`), so the ranges here must stay inside 1-4.
    out = ops.apply(TINY, {"op": "track.bars", "track": "bright", "bars": [1, 2]})
    assert "bars 1-2" in out
    ok, err = compiles(out)
    assert ok, err
    out2 = ops.apply(TINY.replace("track bright  transpose 2", "track bright  bars 1-4  transpose 2"), {"op": "track.bars", "track": "bright", "bars": [3, 3]})
    assert "bars 3" in out2 and "bars 1-4" not in out2
    ok, err = compiles(out2)
    assert ok, err
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.bars", "track": "bright", "bars": [8, 5]})


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


def test_track_harmonic_toggles_a_preset_and_is_idempotent():
    on = ops.apply(TINY, {"op": "track.harmonic", "track": "bright", "preset": "cleanup"})
    assert ops.HARMONIC_PRESETS["cleanup"] in on
    ok, err = compiles(on)
    assert ok, err
    # Applying a different preset replaces, doesn't stack.
    on2 = ops.apply(on, {"op": "track.harmonic", "track": "bright", "preset": "resonant"})
    assert on2.count("harmonic") == 1
    assert ops.HARMONIC_PRESETS["resonant"] in on2
    ok, err = compiles(on2)
    assert ok, err
    off = ops.apply(on2, {"op": "track.harmonic", "track": "bright", "preset": "resonant", "on": False})
    assert "harmonic" not in off
    ok, err = compiles(off)
    assert ok, err


def test_track_harmonic_rejects_an_unlisted_preset():
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.harmonic", "track": "bright", "preset": "wild"})


def test_unknown_op_raises():
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.mute", "track": "bright"})


def test_missing_track_or_clip_raises():
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "track.volume", "track": "nope", "delta": 2})
    with pytest.raises(ops.OpError):
        ops.apply(TINY, {"op": "clip.root", "clip": "nope", "note": "C2"})
