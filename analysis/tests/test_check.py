"""Unit tests for the harmony/clash checker (`apricity_analyze.check`), Phase 1.

Most of these work directly on hand-built `Stem`/manifest data (no real audio, no essentia) so
they run fast and pin down the clash kernel's arithmetic exactly. The synthetic-audio path
(`analyze_stem`, which does call essentia/librosa) is exercised separately, gated on essentia
being importable, since it's slow and only the CI/dev venv has it installed.
"""

from __future__ import annotations

import pathlib

import numpy as np
import pytest

from apricity_analyze import check


def one_hot(pitch_class: int, amp: float = 1.0) -> np.ndarray:
    v = np.zeros(12)
    v[pitch_class] = amp
    return v


def make_stem(name: str, chroma: np.ndarray, *, bass: bool = False, pitched: bool = True, energy_db: float = -120.0) -> check.Stem:
    n_beats = len(chroma)
    return check.Stem(name=name, pitched=pitched, kit=None, bass=bass, chroma=np.asarray(chroma, dtype=float),
                       energy_db=np.full(n_beats, energy_db), mono=np.zeros(1))


def manifest(*, tempo=120.0, meter=4, offset_beats=0.0, key="C major", harmony=None, tracks=None, length=48000):
    return {"sample_rate": 48000, "tempo": tempo, "meter": meter, "offset_beats": offset_beats, "length": length,
            "key": key, "harmony": harmony or [], "tracks": tracks or []}


# --------------------------------------------------------------------------- pair_clash (interval kernel)

def test_minor_second_scores_worse_than_a_fifth():
    c = one_hot(0)   # C
    db = one_hot(1)  # Db: a minor 2nd above C
    g = one_hot(7)   # G: a fifth above C
    m2_clash = check.pair_clash(c, db, bass_pair=False)
    fifth_clash = check.pair_clash(c, g, bass_pair=False)
    assert m2_clash > fifth_clash
    assert fifth_clash == 0.0  # a perfect 5th is fully consonant in this kernel


def test_bb2_bass_with_a4_clashes_more_than_with_d4():
    bb = one_hot(10)  # Bb, the bass note
    a = one_hot(9)    # A: a minor 2nd below Bb -- the Ave House bug (bass root under a held maj7)
    d = one_hot(2)    # D: a major 3rd above Bb (a chord tone in a Bb chord), no clash
    clash_with_a = check.pair_clash(bb, a, bass_pair=True)
    clash_with_d = check.pair_clash(bb, d, bass_pair=True)
    assert clash_with_a > clash_with_d
    # The bass doubling applies: a plain (non-bass) m2 would only be 1.0, not 2.0.
    assert clash_with_a == pytest.approx(2.0)


def test_bass_doubling_only_applies_to_m2_m2_and_m7():
    bb, e = one_hot(10), one_hot(4)  # a tritone (6 semitones): not one of the doubled intervals
    plain = check.pair_clash(bb, e, bass_pair=False)
    doubled = check.pair_clash(bb, e, bass_pair=True)
    assert plain == doubled  # tritone isn't doubled against the bass


# --------------------------------------------------------------------------- chord_clash

def test_c_e_g_over_a_c_chord_is_all_on_chord_and_clash_free():
    chord_tones = [0, 4, 7]  # C E G
    c = one_hot(0, 0.4) + one_hot(4, 0.35) + one_hot(7, 0.25)
    clash = check.chord_clash(c, chord_tones, bass_pc=0, scale=None)
    assert clash == pytest.approx(0.0)
    on_chord_share = sum(c[t] for t in chord_tones) / c.sum()
    assert on_chord_share == pytest.approx(1.0)


def test_chord_clash_penalizes_a_semitone_from_the_root_hardest():
    chord_tones = [0, 4, 7]  # C E G
    root_semitone = one_hot(0, 0.5) + one_hot(1, 0.5)   # Db a semitone above the root
    tritone = one_hot(0, 0.5) + one_hot(6, 0.5)          # F# a tritone from the root
    other = one_hot(0, 0.5) + one_hot(2, 0.5)            # D: not adjacent to any chord tone
    c_root = check.chord_clash(root_semitone, chord_tones, bass_pc=0, scale=None)
    c_tritone = check.chord_clash(tritone, chord_tones, bass_pc=0, scale=None)
    c_other = check.chord_clash(other, chord_tones, bass_pc=0, scale=None)
    assert c_root > c_tritone > c_other > 0.0


def test_out_of_key_multiplies_the_chord_clash():
    chord_tones = [0, 4, 7]
    # D (pc 2) isn't adjacent to any chord tone or the root/bass -> the flat "other" penalty.
    c = one_hot(0, 0.5) + one_hot(2, 0.5)
    in_key = check.chord_clash(c, chord_tones, bass_pc=0, scale={0, 2, 4, 5, 7, 9, 11})  # C major, D is in key
    out_of_key = check.chord_clash(c, chord_tones, bass_pc=0, scale={0, 4, 7})  # a scale that excludes D
    assert out_of_key == pytest.approx(in_key * check.OUT_OF_KEY_MULT)


# --------------------------------------------------------------------------- beat_clash / evaluate

def test_all_silent_stems_score_below_the_baseline_the_guard_fires():
    m = manifest(harmony=[{"start_beat": 0.0, "end_beat": 4.0, "label": "I", "chord_tones": ["C", "E", "G"]}])
    silent = [make_stem("a", np.zeros((4, 12)))]
    report = check.evaluate(m, silent)
    baseline = {
        "section_energy_db": [-10.0],
        "stem_peak_db": {"a": -10.0},
        "density_per_bar": 1.0,
        "pitch_entropy_bits": 1.5,
    }
    guarded = check.apply_guards(report, m, silent, baseline, allow_mute=set())
    assert guarded.guard_violations, "an all-silent render vs a loud baseline should trip a guard"
    assert any("muted" in v or "energy" in v for v in guarded.guard_violations)
    assert guarded.objective < 100.0


def test_tuning_guard_ignores_unpitched_stems(monkeypatch):
    """A drum kit pad flagged unpitched shouldn't take the tuning penalty, even if
    `TuningFrequencyExtractor` (built for a real note) returns something wild for its thump."""
    m = manifest()
    kick = make_stem("kick", np.tile(np.full(12, 0.1), (4, 1)), pitched=False)
    monkeypatch.setattr(check, "stem_tuning_cents", lambda mono: 500.0)  # absurdly out of tune
    report = check.evaluate(m, [kick])
    guarded = check.apply_guards(report, m, [kick], baseline=None, allow_mute=set())
    assert guarded.penalties["tuning"] == 0
    assert not any("tuned" in v for v in guarded.guard_violations)


def test_all_silent_stems_do_not_trip_the_mute_guard_when_allowed():
    m = manifest()
    silent = [make_stem("a", np.zeros((4, 12)))]
    report = check.evaluate(m, silent)
    baseline = {"section_energy_db": [-10.0], "stem_peak_db": {"a": -10.0}, "density_per_bar": 0.0, "pitch_entropy_bits": 0.0}
    guarded = check.apply_guards(report, m, silent, baseline, allow_mute={"a"})
    assert not any("muted" in v for v in guarded.guard_violations)


def test_single_pitch_mix_takes_the_coverage_penalty():
    m = manifest(harmony=[{"start_beat": 0.0, "end_beat": 4.0, "label": "I", "chord_tones": ["C", "E", "G"]}])
    # All tonal energy sits on C: E and G never sound, so they fail the 5%-of-tonal-energy floor.
    only_c = [make_stem("a", np.tile(one_hot(0, 1.0), (4, 1)))]
    report = check.evaluate(m, only_c)
    guarded = check.apply_guards(report, m, only_c, baseline=None, allow_mute=set())
    assert guarded.penalties["coverage"] > 0
    assert any("E" in v or "G" in v for v in guarded.guard_violations)


def test_a_full_triad_does_not_take_the_coverage_penalty():
    m = manifest(harmony=[{"start_beat": 0.0, "end_beat": 4.0, "label": "I", "chord_tones": ["C", "E", "G"]}])
    triad = [make_stem("a", np.tile(one_hot(0, 0.4) + one_hot(4, 0.3) + one_hot(7, 0.3), (4, 1)))]
    report = check.evaluate(m, triad)
    guarded = check.apply_guards(report, m, triad, baseline=None, allow_mute=set())
    assert guarded.penalties["coverage"] == 0


# --------------------------------------------------------------------------- offset_beats

def test_offset_beats_shifts_the_spans_correctly():
    m = manifest(offset_beats=4.0)
    span = {"start_beat": 4.0, "end_beat": 8.0, "label": "I"}
    beats = list(check.span_beats(m, span))
    # The render's own beat 0 is the score's beat 4 (offset_beats): the span [4, 8) in absolute
    # score beats becomes [0, 4) in the render's own (stems.json) beat numbering.
    assert beats == [0, 1, 2, 3]


def test_beat_of_and_bar_of_use_absolute_score_beats_for_bar_numbers():
    m = manifest(offset_beats=8.0, meter=4)
    # Bar numbers in the report are absolute (from the top of the score), independent of offset.
    assert check._bar_of(m, 8.0) == 3.0  # beat 8, 4/4 -> bar 3 (1-indexed)
    assert check._beat_of(m, 8.0) == 0   # but it's the render's own first beat


# --------------------------------------------------------------------------- calibration fixes
# (from a real hill-climb on Ave House: drums misread as pitched, the bass under-weighted, and a
# "root reported as off-chord" wording bug.)

def test_unpitched_stem_does_not_change_the_clash_score():
    """A kick-like decaying noise burst (broadband, unpitched) sitting alongside a C major triad
    should not move the clash score at all: chroma/HPCP reads a kick's thump as a pitch just as
    readily as a real note, so without excluding unpitched stems it would clash with the triad."""
    triad = make_stem("triad", [one_hot(0, 0.4) + one_hot(4, 0.35) + one_hot(7, 0.25)])
    # A broadband "thump" smeared roughly evenly across all 12 pitch classes -- what a decaying
    # noise burst looks like to a chroma extractor -- but flagged unpitched, as a kit pad/kick is.
    kick = make_stem("kick", [np.full(12, 0.2)], pitched=False)

    triad_alone = check.beat_clash([triad], 0)
    triad_with_kick = check.beat_clash([triad, kick], 0)
    assert abs(triad_alone - triad_with_kick) <= 0.01

    # Sanity check that the kick *would* have clashed had it been (wrongly) treated as pitched --
    # otherwise this test would pass trivially regardless of whether exclusion actually works.
    kick_as_pitched = make_stem("kick", [np.full(12, 0.2)], pitched=True)
    triad_with_pitched_kick = check.beat_clash([triad, kick_as_pitched], 0)
    assert abs(triad_alone - triad_with_pitched_kick) > 0.01


def test_bass_a_semitone_off_the_root_is_heavily_penalized():
    """Fixing a bass that sat a semitone below the chord's root (the Ave House bug) should be one
    of the biggest possible objective swings, not a rounding error."""
    m = manifest(harmony=[{"start_beat": 0.0, "end_beat": 4.0, "label": "i", "chord_tones": ["A", "C", "E"]}])
    triad = make_stem("triad", np.tile(one_hot(9, 0.4) + one_hot(0, 0.3) + one_hot(4, 0.3), (4, 1)))

    def bass_at(pc: int) -> check.Stem:
        return make_stem("bass", np.tile(one_hot(pc, 1.0), (4, 1)), bass=True)

    on_root = check.evaluate(m, [bass_at(9), triad]).objective     # A2: the chord's own root
    off_root = check.evaluate(m, [bass_at(8), triad]).objective    # Ab2: a semitone flat

    assert on_root - off_root >= 15.0, f"on-root {on_root} vs off-root {off_root}: expected >= 15 points worse"


def test_worst_off_chord_pitch_class_is_never_a_chord_tone():
    """Regression for `"drums.kick's F is off-chord (0 semitones from the root F)"`: a pitch class
    equal to (or otherwise a member of) the chord can never be "off-chord". The bug was reporting
    a stem's overall loudest pitch class, which can be a chord tone even while the stem also has
    some quieter, genuinely off-chord energy -- `chord_clash_terms` (and the wording built from
    it) must key off the worst *off-chord* pitch class instead."""
    chord_tones = [0, 4, 7]  # C E G
    # G (a chord tone) is by far the loudest; Db (a semitone above the root) is quiet but present.
    c = one_hot(7, 0.9) + one_hot(1, 0.1)
    terms = check.chord_clash_terms(c, chord_tones, bass_pc=0, scale=None)
    assert 7 not in terms and 0 not in terms and 4 not in terms, "a chord tone (root included) is never off-chord"
    assert set(terms) == {1}
    assert max(terms, key=terms.get) == 1  # Db -- not G, the loudest pitch class overall


# --------------------------------------------------------------------------- key_scale

def test_key_scale_parses_recognized_modes():
    assert check.key_scale("C major") == {0, 2, 4, 5, 7, 9, 11}
    assert check.key_scale("F mixolydian") == {(check.PITCH_NAMES.index("F") + s) % 12 for s in [0, 2, 4, 5, 7, 9, 10]}
    assert check.key_scale("nonsense") is None


# --------------------------------------------------------------------------- synthetic-audio path (essentia)

essentia = pytest.importorskip("essentia", reason="the beat-level chroma pipeline needs essentia, as analyze.py does")


def sine(hz: float, seconds: float, sr: int = check.SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return 0.3 * np.sin(2 * np.pi * hz * t)


def midi_hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def test_analyze_stem_places_a_held_tone_in_its_own_pitch_class():
    tone = sine(midi_hz(60), 2.0)  # middle C, 2 seconds
    stem = check.analyze_stem("a", tone, tempo=120.0, n_beats=4, pitched=True, kit=None)
    top = np.argmax(stem.chroma.sum(axis=0))
    assert top == 0  # C


def test_analyze_stem_flags_a_low_tone_as_bass():
    low = sine(midi_hz(36), 1.0)  # C2, well under 250 Hz's fundamental region
    stem = check.analyze_stem("bass", low, tempo=120.0, n_beats=2, pitched=True, kit=None)
    assert stem.bass is True


def test_analyze_stem_does_not_flag_a_high_tone_as_bass():
    high = sine(midi_hz(84), 1.0)  # C6
    stem = check.analyze_stem("lead", high, tempo=120.0, n_beats=2, pitched=True, kit=None)
    assert stem.bass is False


# --------------------------------------------------------------------------- span_beats vs a --bars render

def test_span_beats_skips_a_span_entirely_outside_the_rendered_range():
    """A `--bars 9-16` render's `stems.json` still lists the *score's* full harmony (bars 1-40 in
    Ave House, say), not just the rendered slice -- `span_beats` must recognize a span outside
    `[0, n_beats)` and return nothing for it, not a range of beat indices past the audio's end."""
    m = manifest(offset_beats=32.0, meter=4)  # rendered bars 9-16 => beats [32, 64)
    n_beats = 32  # 8 bars * 4 beats

    before = {"start_beat": 0.0, "end_beat": 8.0, "label": "before"}       # bars 1-2: entirely before
    after = {"start_beat": 96.0, "end_beat": 104.0, "label": "after"}      # bars 25-26: entirely after
    inside = {"start_beat": 40.0, "end_beat": 48.0, "label": "inside"}     # bars 11-12: fully inside
    straddle_start = {"start_beat": 24.0, "end_beat": 40.0, "label": "s1"}  # bars 7-10: starts before, ends inside
    straddle_end = {"start_beat": 56.0, "end_beat": 72.0, "label": "s2"}    # bars 15-18: starts inside, ends after

    assert list(check.span_beats(m, before, n_beats)) == []
    assert list(check.span_beats(m, after, n_beats)) == []
    assert list(check.span_beats(m, inside, n_beats)) == [8, 9, 10, 11, 12, 13, 14, 15]
    assert list(check.span_beats(m, straddle_start, n_beats)) == list(range(0, 8))     # clipped to the render's start
    assert list(check.span_beats(m, straddle_end, n_beats)) == list(range(24, 32))     # clipped to the render's end


def test_span_beats_without_n_beats_only_clips_the_start_as_before():
    m = manifest(offset_beats=0.0)
    span = {"start_beat": -100.0, "end_beat": 1000.0, "label": "x"}  # pathological, but shouldn't crash
    assert list(check.span_beats(m, span))[:1] == [0]


def test_out_of_range_spans_do_not_pollute_the_objective_or_worst_spans():
    """The core of the bug: before the fix, an out-of-range span still showed up as a
    `SpanFinding` with clash 0.0 and "no strong single clash; diffuse dissonance" -- a fake,
    misleading entry, since that span was never actually in the rendered audio at all."""
    m = manifest(offset_beats=32.0, meter=4, harmony=[
        {"start_beat": 0.0, "end_beat": 8.0, "label": "before", "chord_tones": ["C", "E", "G"]},
        {"start_beat": 32.0, "end_beat": 40.0, "label": "inside", "chord_tones": ["C", "E", "G"]},
        {"start_beat": 96.0, "end_beat": 104.0, "label": "after", "chord_tones": ["C", "E", "G"]},
    ])
    n_beats = 32
    stem = make_stem("pad", np.tile(one_hot(0, 0.4) + one_hot(4, 0.3) + one_hot(7, 0.3), (n_beats, 1)))
    report = check.evaluate(m, [stem])
    labels = {f.label for f in report.worst_spans}
    assert "before" not in labels and "after" not in labels
    assert all(f.detail != "no strong single clash; diffuse dissonance" or f.label == "inside" for f in report.worst_spans)


essentia_bars = pytest.importorskip("essentia", reason="needs a real render + essentia")

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "target/release/apricity"


@pytest.mark.skipif(not BIN.exists(), reason="release binary not built")
def test_bars_render_objective_matches_a_full_render_sliced_to_the_same_bars(tmp_path):
    """A real `--bars`-restricted render's objective should match evaluating the *same* beats cut
    out of a full render's own stems, within tolerance (small differences are expected: warp/edge
    effects render slightly differently at the very start/end of a partial range)."""
    import subprocess

    score = ROOT / "examples" / "minor-line.apr"
    full_stems = tmp_path / "full.stems"
    bars_stems = tmp_path / "bars.stems"
    r1 = subprocess.run([str(BIN), "render", str(score), "--out", str(tmp_path / "full.wav"), "--stems", str(full_stems)], capture_output=True, text=True)
    assert r1.returncode == 0, r1.stderr
    r2 = subprocess.run([str(BIN), "render", str(score), "--out", str(tmp_path / "bars.wav"), "--stems", str(bars_stems), "--bars", "3-4"], capture_output=True, text=True)
    assert r2.returncode == 0, r2.stderr

    full_manifest, full_stems_list = check.load_stems(full_stems)
    meter = full_manifest["meter"]
    start_beat = 2 * meter  # bar 3 (0-indexed bar 2) starts at beat 2*meter
    n_beats_slice = 2 * meter  # bars 3-4
    sliced_manifest = dict(full_manifest)
    sliced_manifest["offset_beats"] = full_manifest["offset_beats"] + start_beat
    sliced_stems = [check.Stem(s.name, s.pitched, s.kit, s.bass, s.chroma[start_beat:start_beat + n_beats_slice],
                                s.energy_db[start_beat:start_beat + n_beats_slice], s.mono) for s in full_stems_list]
    report_sliced = check.evaluate(sliced_manifest, sliced_stems)

    bars_manifest, bars_stems_list = check.load_stems(bars_stems)
    report_bars = check.evaluate(bars_manifest, bars_stems_list)

    # Only bars 3-4's own spans should show up (not bars 1-2's or the rest of the piece's).
    for f in report_bars.worst_spans:
        assert 3 <= f.start_bar <= 5, f"span {f.label} at bar {f.start_bar} is outside the rendered bars 3-4"

    assert abs(report_bars.objective - report_sliced.objective) <= 5.0, (report_bars.objective, report_sliced.objective)
