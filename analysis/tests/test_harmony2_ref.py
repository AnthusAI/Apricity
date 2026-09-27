"""Acceptance tests for `apricity_analyze.harmony2_ref` (Kanbus `apricitus-e5cb09`, Harmony v2
Phase 1 task 2). Synthetic fixtures (sec 5.3 of `spec-harmony-v2.md`) are built IN MEMORY at test
time by `tests/fixtures/harmony2/generate.py` -- no audio is committed anywhere in this repo
(`.gitignore` blocks `*.wav`; a checked-in fixture would silently vanish on a fresh clone and
fail in CI and for anyone without the sample library). The one real-audio case (the Emerge bar-35
excerpt) is rendered from the sample library at test time by
`tests/fixtures/harmony2/emerge_fixture.py` and skips with a clear reason when that library isn't
present.

Also regenerates `tests/fixtures/harmony2/expected.json` (per-fixture activations, cents, and
notes -- numbers only, no audio, fine to commit) from the synthetic fixtures and diffs it against
the checked-in copy, so a drift on either side of the Rust parity test (`apricity-harmony`,
`crates/apricity-harmony/tests/synth.rs` + `tests/parity.rs`, Kanbus `apricitus-c7ffff`) is caught
here first.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

import numpy as np
import pytest

from apricity_analyze import harmony2_ref as h

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "harmony2"


def _import(name: str, path: pathlib.Path):
    """Imports `tests/fixtures/harmony2/<name>.py` by path -- `tests/` isn't a package (no
    `__init__.py`), so a normal `from tests.fixtures...` import isn't reliable across pytest's
    import modes."""
    spec = importlib.util.spec_from_file_location(f"harmony2_fixtures_{name}", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


generate = _import("generate", FIXTURES / "generate.py")
emerge_fixture = _import("emerge_fixture", FIXTURES / "emerge_fixture.py")

SYNTHETIC = {
    "ce_inversion.wav": generate.ce_inversion,
    "detuned_30c.wav": generate.detuned_30c,
    "shift_loop.wav": generate.shift_loop,
    "shift_bass.wav": generate.shift_bass,
}


def _load(name: str) -> np.ndarray:
    """The named synthetic fixture, generated in memory (never read from disk)."""
    return SYNTHETIC[name]()


def _beat_activation(y: np.ndarray) -> np.ndarray:
    """The whole clip's median NNLS note activation (one "beat" = the whole 2s tone)."""
    A = h.nnls_activations(h.fold_to_semitones(h.cqt(y)))
    return np.median(A, axis=1)


# --------------------------------------------------------------------------- 5.3 acceptance tests


def test_ce_inversion_is_heard_as_c_major_over_bass_e():
    """The additive-template prototype heard this as Am7 (E4/E5 partials credited to a phantom
    A2); NNLS must explain E4 with the E2/E3 already present and put nothing on A."""
    v = _beat_activation(_load("ce_inversion.wav"))
    root, quality, bass_pc, _ = h.recognise_chord(v)
    assert (h.NAMES[root], quality, h.NAMES[bass_pc]) == ("C", "", "E")


def test_detuned_note_reads_within_half_a_cent():
    c = h.cents_offset(_load("detuned_30c.wav"))
    assert abs(c - 30.0) <= 0.5, f"expected +30.0 c +/- 0.5, got {c:+.2f} c"


def test_transposition_map_finds_the_known_shift():
    """A Cm7 arpeggio loop (C4 Eb4 G4 Bb4) is, rolled -3 semitones, exactly a written Am7 with
    an A2 bass; the map must rank shift -3 first."""
    loop_v = _beat_activation(_load("shift_loop.wav"))
    bass_v = _beat_activation(_load("shift_bass.wav"))
    tmap = h.transposition_map(loop_v, bass_v, target_root_pc=9, target_quality="m7", target_bass_pc=9)
    best = max(tmap, key=tmap.get)
    assert best == -3, f"expected best shift -3, got {best} ({tmap})"


def test_bass_stem_sanity():
    """Settles sec 2.2's open question: does a clean, pinned single-note bass stem read as
    exactly one note per span with no ghost notes and one cents reading? On this SYNTHETIC bass
    (a pure six-partial A2 tone, `shift_bass()`) it does -- see
    `test_bass_stem_sanity_real_emerge_bar35` for the REAL-sample case (ghost notes, a plausible
    detuning reading), which is settled separately because it needs the real sample library.
    """
    y = _load("shift_bass.wav")
    v = _beat_activation(y)
    thr = 0.05 * v.max()
    notes = [i for i in range(h.N_SEMITONES) if v[i] >= thr]
    names = [h.semitone_name(h.MIDI_C1 + i) for i in notes]
    assert names == ["A2"], f"expected exactly one note (A2), got {names} -- ghost notes on a clean synthetic bass would be a bug"
    c = h.cents_offset(y)
    assert abs(c) < 5.0, f"a clean, untransposed A2 tone should read near 0 c, got {c:+.2f} c"


# --------------------------------------------------------------------------- the real Emerge excerpt


def test_emerge_library_availability_check():
    """`library_available` is the gate every real-audio test below goes through. Proves both
    directions: `True` against the real sample library (if this checkout has it), `False`
    against an empty directory (simulating a fresh clone / CI, where audio is never committed)."""
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        assert emerge_fixture.library_available(pathlib.Path(d)) is False, "an empty directory must never read as 'library available'"
    # The real root may or may not be populated in this environment; both outcomes are valid,
    # this just proves the check reflects reality rather than being hardcoded either way.
    real = emerge_fixture.library_available(emerge_fixture.DEFAULT_SAMPLES_ROOT)
    assert isinstance(real, bool)


def test_render_bar35_raises_a_clear_error_when_the_library_is_absent(tmp_path):
    """The "without the library" case the harness must handle gracefully: pointed at an empty
    samples root, `render_bar35` must raise `LibraryUnavailable` with a clear reason -- and must
    NOT attempt to invoke the renderer at all (no subprocess, no partial output)."""
    empty_samples = tmp_path / "empty-samples"
    empty_samples.mkdir()
    out_dir = tmp_path / "out"
    with pytest.raises(emerge_fixture.LibraryUnavailable, match="sample audio not found"):
        emerge_fixture.render_bar35(out_dir, samples_root=empty_samples)
    assert not out_dir.exists(), "no render output should be written when the library is absent"


def test_bass_stem_sanity_real_emerge_bar35(tmp_path):
    """The REAL-sample case sec 2.2 and `test_bass_stem_sanity` leave open: the Emerge render's
    `low` stem (Ave's pinned "clean low A-flat", moved to F for bar 35's Fmaj7/VImaj7 span),
    rendered fresh into `tmp_path` (never committed) and downsampled to 22.05 kHz mono.

    Finding, recorded (not asserted as pass/fail -- there is no ground-truth "correct" answer
    here, only what the analysis hears): on the RAW folded CQT magnitude (before NNLS), F2 is
    the dominant semitone as expected, but E2 -- a semitone below -- carries 72% of F2's
    magnitude (-2.8 dB), and D2/D#2 carry comparable amounts too. That -2.8 dB reading is the
    same ballpark as an independent measurement of this stem putting E2 about -7 dB under F2 (a
    different metric, same conclusion: a real, audible E2 component, not analysis noise). A
    local parabolic fit at F2's own bin reads F2 itself about 14.5 c flat -- present but modest,
    nowhere near a full semitone, so this is NOT "F is actually E2" mislabelled; it's a genuinely
    janky low end with a real secondary partial around E2.

    Separately, and NOT part of that finding: post-NNLS (this reference's 84-row semitone-folded
    decomposition), the note activation on this same stem shifts to peak in the OCTAVE BELOW
    (F1/E1/D1/D#1) rather than at F2. That is an artifact of the simplified reference (sec 2.1's
    documented deviation: folding to one bin/semitone before NNLS, on a short 2 s excerpt where
    the lowest bins' analysis windows are themselves ~1.5 s and edge-sensitive) confusing the
    fundamental with a subharmonic that also explains real broadband low-end content in this
    stem -- exactly the octave-confusion failure NNLS is supposed to avoid, re-appearing here at
    the register where the folding loses the most information. Left as a known limitation for
    whoever builds the full 252-row decomposition or the Rust parity task; not something this
    pass fixes.
    """
    if not emerge_fixture.library_available(emerge_fixture.DEFAULT_SAMPLES_ROOT):
        pytest.skip(f"sample library audio not present under {emerge_fixture.DEFAULT_SAMPLES_ROOT} -- this test only runs when the real library is checked out")

    data = emerge_fixture.render_bar35(tmp_path)
    y = data["low"]
    C = h.cqt(y)
    raw = h.fold_to_semitones(C)
    med = np.median(raw, axis=1)
    f2 = 41 - h.MIDI_C1  # F2
    e2 = 40 - h.MIDI_C1  # E2
    top = int(np.argmax(med))
    assert top == f2, f"raw CQT should peak at F2 (index {f2}), got semitone index {top} ({h.semitone_name(h.MIDI_C1 + top)})"
    e2_share_db = 20 * np.log10(med[e2] / med[f2])
    assert -12.0 < e2_share_db < 0.0, f"expected a real but secondary E2 component under F2, got {e2_share_db:+.1f} dB"


# --------------------------------------------------------------------------- Harmony v2 Phase 1 task 4:
# chord recognition, Q, objective_v2, the v1 port and guards (sec 2.4-2.6 of spec-harmony-v2.md,
# Kanbus apricitus-a164db)


def _tone(name: str, octave: int, amp: float, v: np.ndarray | None = None) -> np.ndarray:
    v = np.zeros(h.N_SEMITONES) if v is None else v
    pc = h.NAMES.index(name)
    idx = pc + 12 * (octave + 1) - h.MIDI_C1  # MIDI = 12*(octave+1)+pc
    v[idx] = amp
    return v


def test_recognise_chord_full_reports_extension_inversion_and_confidence():
    """A root-position Am7 (A2 C3 E3 G3, known A bass) is heard with no extensions, `inversion ==
    "root"`, and positive confidence."""
    v = _tone("A", 2, 1.0)
    _tone("C", 3, 1.0, v)
    _tone("E", 3, 1.0, v)
    _tone("G", 3, 1.0, v)
    heard = h.recognise_chord_full(v, known_bass_pc=h.NAMES.index("A"))
    assert heard["root"] == "A" and heard["quality"] == "m7" and heard["bass"] == "A"
    assert heard["extensions"] == []
    assert heard["inversion"] == "root"
    assert heard["confidence"] > 0


def test_q_is_1_for_an_exactly_written_chord_with_known_bass():
    v = _tone("A", 2, 1.0)
    _tone("C", 3, 1.0, v)
    _tone("E", 3, 1.0, v)
    _tone("G", 3, 1.0, v)
    heard = h.recognise_chord_full(v, known_bass_pc=h.NAMES.index("A"))
    q = h.compute_q(heard, h.NAMES.index("A"), "m7", h.NAMES.index("A"), {"x": [45, 48, 52, 55]}, None, None)
    assert q["Q"] == 1.0, q


def test_spacing_does_not_penalise_a_maj7_a_semitone_under_the_bass():
    """A maj7's 7th sitting a semitone under the bass, in its own octave, is treated as colour,
    not mud: at most neutral, never a clash. A genuine close dissonant pair below C3 that ISN'T
    the maj7-under-bass shape (e.g. a major 2nd) must still be penalised."""
    maj7_under_bass = {"bass": [41], "loop": [40]}  # F2, E2 (a semitone apart)
    assert h.q_spacing(maj7_under_bass) == 1.0

    major_second_clash = {"bass": [41], "loop": [43]}  # F2, G2 (2 semitones apart)
    assert h.q_spacing(major_second_clash) < 1.0


def test_objective_v2_mute_gaming_guard_does_not_raise_the_objective():
    """Sec 2.6's anti-gaming guard: muting the loop over a written Fmaj7 (keeping only the bass)
    must not raise `objective_v2` -- the bass alone reads as a bare root (low `target`, no
    `extension`), which must not outscore the full, correctly-voiced chord."""
    bass = _tone("F", 2, 1.0)
    loop = _tone("F", 3, 1.0)
    _tone("A", 3, 1.0, loop)
    _tone("C", 4, 1.0, loop)
    _tone("E", 4, 1.0, loop)
    chord_tones = [h.NAMES.index(n) for n in ["F", "A", "C", "E"]]

    full = h.objective_v2_for_span({"bass": bass, "loop": loop}, chord_tones, h.NAMES.index("F"), "maj7", h.NAMES.index("F"), "bass", None)
    muted = h.objective_v2_for_span({"bass": bass, "loop": np.zeros(h.N_SEMITONES)}, chord_tones, h.NAMES.index("F"), "maj7", h.NAMES.index("F"), "bass", None)
    assert muted["objective_v2"] <= full["objective_v2"], (muted, full)


def test_extension_guard_fires_on_a_dominant_extension():
    """Sec 2.6's new guard: a span where the heard extension carries > 40% of the span's tonal
    mass must be flagged ("a 9th louder than the chord is not colour"). Tested directly against
    `check_span_guards` with a hand-built `heard`, since a sufficiently loud "extension" pitch
    class can itself change which quality `recognise_chord_full` calls best-fitting (there's no
    9-chord in the modelled `QUALITIES`, sec 0's chord-model gap) -- the guard must still catch it
    whenever the report does say an extension was heard."""
    v = _tone("C", 3, 1.0)
    _tone("E", 3, 1.0, v)
    _tone("G", 3, 1.0, v)
    _tone("D", 4, 5.0, v)  # a 9th far louder than the triad itself
    heard = {"root": "C", "quality": "", "extensions": ["add9"], "bass": "C", "inversion": "root", "confidence": 1.0, "score": 1.0}
    violations, penalty = h.check_span_guards(v, [h.NAMES.index(n) for n in ["C", "E", "G"]], heard)
    assert any("extension" in msg for msg in violations), violations
    assert penalty >= h.EXTENSION_GUARD_PENALTY


def test_coverage_guard_fires_when_a_chord_tone_is_nearly_silent():
    v = _tone("C", 3, 1.0)
    _tone("E", 3, 1.0, v)
    _tone("G", 3, 0.001, v)  # far under COVERAGE_MIN_SHARE
    heard = {"root": "C", "quality": "", "extensions": [], "bass": "C", "inversion": "root", "confidence": 1.0, "score": 1.0}
    violations, penalty = h.check_span_guards(v, [h.NAMES.index(n) for n in ["C", "E", "G"]], heard)
    assert any("G" in msg for msg in violations), violations
    assert penalty >= h.COVERAGE_GUARD_PENALTY


def test_recognise_chord_bass_fallback_never_picks_below_g1():
    """Sec 2.4's own floor, "the lowest extracted note ... at or above G1 (49 Hz)", applied to the
    audio-only bass fallback: the reference's 84-row NNLS simplification can put spurious
    activation an octave below a real low-register fundamental, so the fallback must never pick a
    below-G1 candidate, even when it has more mass than the real note an octave above."""
    v = np.zeros(h.N_SEMITONES)
    f1 = h.NAMES.index("F") + 12 * (1 + 1) - h.MIDI_C1
    f2 = h.NAMES.index("F") + 12 * (2 + 1) - h.MIDI_C1
    v[f1] = 1.0   # a ghost, louder than the real note
    v[f2] = 0.9   # the real fundamental
    root, quality, bass_pc, _ = h.recognise_chord(v)
    assert h.NAMES[bass_pc] == "F", f"bass fallback picked a below-G1 ghost: {h.NAMES[bass_pc]}"


def test_combined_pipeline_hears_emerge_bar35_bass_as_f_not_an_octave_low(tmp_path):
    """End-to-end acceptance test: running the FULL combined pipeline (`analyze_stems_dir`) on a
    fresh real render of a bar whose bass track is known from the score must hear that bass at
    its real pitch, not an octave-low artifact the reference's 84-row NNLS simplification can
    produce. Uses the DEBUG binary (`emerge_fixture.DEBUG_BINARY`) because the combined pipeline
    needs `stems.json`'s `bass`/`events` fields, which the release binary in this checkout
    predates."""
    if not emerge_fixture.library_available(emerge_fixture.DEFAULT_SAMPLES_ROOT):
        pytest.skip(f"sample library audio not present under {emerge_fixture.DEFAULT_SAMPLES_ROOT}")
    if not emerge_fixture.DEBUG_BINARY.exists():
        pytest.skip(f"debug apricity binary not built: {emerge_fixture.DEBUG_BINARY}")
    out_dir = emerge_fixture.render_bar35_dir(tmp_path / "bar35")
    result = h.analyze_stems_dir(out_dir)
    span = next(s for s in result["spans"] if s["label"].startswith("VImaj7"))
    assert span["heard"] is not None, "expected a chord to be heard for the Fmaj7 span"
    assert span["heard"]["bass"] == "F", f"expected the bass to be heard as F, got {span['heard']}"
    assert span["heard"]["root"] == "F"


def _replay_window(fixture_song: dict) -> dict:
    """Recomputes `objective_v2_for_span`/`window_objective` from a committed activation-summary
    fixture (numbers only -- built by rendering the real window once, offline, and thrown away;
    see the scratchpad `build_lounge_fixture.py`/`build_cycle2_fixture.py` drivers referenced in
    the fixture files' own generation), needing no audio at test time."""
    span_results = []
    span_mass = []
    prev_notes = None
    for span in fixture_song["spans"]:
        chord_tones_pc = [h.NAMES.index(n) for n in span["chord_tones"] if n]
        written_root_pc = chord_tones_pc[0] if chord_tones_pc else None
        written_quality = h.written_quality_from_tones(written_root_pc, chord_tones_pc) if chord_tones_pc else None
        written_bass_pc = h.NAMES.index(span["bass"]) if span.get("bass") else None
        stem_beats = {name: np.array(beats) if beats else np.zeros((0, h.N_SEMITONES)) for name, beats in span["activations_by_beat"].items()}
        stem_activations = {name: (beats.sum(axis=0) if len(beats) else np.zeros(h.N_SEMITONES)) for name, beats in stem_beats.items()}
        result = h.objective_v2_for_span(
            stem_activations, chord_tones_pc, written_root_pc, written_quality, written_bass_pc,
            span.get("bass_stem_name"), prev_notes, key_scale_pcs=None, stem_beat_activations=stem_beats,
        )
        notes_now = [n for act in stem_activations.values() for n in h.notes_from_activation(act)]
        prev_notes = notes_now or prev_notes
        span_results.append(result)
        span_mass.append(result["mass"])
    return h.window_objective(span_results, span_mass)


def test_lounge_fixture_ranks_emerge_first_with_q_weight_10():
    """Acceptance test (sec 5.1 of spec-harmony-v2.md): of a set of bright-loop swaps rendered
    over the same window, the candidate the listener preferred must rank FIRST by `objective_v2`,
    even though v1 alone did not rank it first (evidence for the preference and the v1 gap lives
    in the Kanbus task and `renders/log.jsonl`, not here). Replays the committed
    `lounge_summaries.json` fixture (no audio, no render) built by rendering the real windows
    once."""
    fixture = json.loads((FIXTURES / "lounge_summaries.json").read_text())
    scores = {name: _replay_window(song)["objective_v2"] for name, song in fixture.items()}
    ranked = sorted(scores, key=scores.get, reverse=True)
    assert ranked[0] == "3-emerge", f"expected Emerge to rank first, got {ranked} ({scores})"


def test_cycle2_fixture_ranks_the_incumbent_keep_first_with_q_weight_10():
    """Acceptance test (sec 5.2): of a set of bright-loop candidates, the listener's preferred
    incumbent must rank first by `objective_v2` at weight 10, matching both v1 and the recorded
    verdict (see the Kanbus task and `renders/log.jsonl` for the verdict itself). Replays the
    committed `cycle2_summaries.json` fixture (no audio, no render)."""
    fixture = json.loads((FIXTURES / "cycle2_summaries.json").read_text())
    scores = {name: _replay_window(song)["objective_v2"] for name, song in fixture.items()}
    ranked = sorted(scores, key=scores.get, reverse=True)
    assert ranked[0] == "keep", f"expected 'keep' to rank first, got {ranked} ({scores})"


def test_window_objective_combines_consonance_and_q_with_weight_10():
    """Sec 2.6: `objective_v2 = consonance_v1' - guards + 10*mean(Q)`, at the whole-window level."""
    span = {"consonance_v1": 90.0, "guard_penalty": 2.0, "Q": {"Q": 0.8}}
    w = h.window_objective([span], [1.0])
    assert w["consonance_v1"] == 90.0
    assert w["guard_penalty"] == 2.0
    assert w["Q_mean"] == 0.8
    assert w["objective_v1"] == 88.0
    assert abs(w["objective_v2"] - 96.0) < 1e-9  # 90 - 2 + 10*0.8


# --------------------------------------------------------------------------- expected.json regeneration


def _fixture_summary() -> dict:
    out = {}
    for name in SYNTHETIC:
        y = _load(name)
        v = _beat_activation(y)
        rec = h.recognise_chord(v)
        out[name] = {
            "cents": round(h.cents_offset(y), 3),
            "activation": [round(float(x), 6) for x in v],
            "notes": [h.semitone_name(h.MIDI_C1 + i) for i in range(h.N_SEMITONES) if v[i] >= 0.05 * v.max()],
            "heard": None if rec is None else {"root": h.NAMES[rec[0]], "quality": rec[1], "bass": h.NAMES[rec[2]]},
        }
    return out


def test_expected_json_matches_the_checked_in_copy():
    """Regenerates `expected.json` from the current reference and diffs it against the checked-in
    copy: a drift here is a bug in the reference (or an intentional change that must re-check in
    the file), not something to silently accept."""
    fresh = _fixture_summary()
    path = FIXTURES / "expected.json"
    if not path.exists():
        path.write_text(json.dumps(fresh, indent=2) + "\n")
        pytest.skip("expected.json did not exist; wrote it from the current reference")
    checked_in = json.loads(path.read_text())
    for name, fresh_row in fresh.items():
        assert name in checked_in, f"{name} missing from the checked-in expected.json"
        row = checked_in[name]
        assert abs(fresh_row["cents"] - row["cents"]) <= 0.5, f"{name}: cents drifted {row['cents']} -> {fresh_row['cents']}"
        assert fresh_row["notes"] == row["notes"], f"{name}: notes drifted {row['notes']} -> {fresh_row['notes']}"
        assert fresh_row["heard"] == row["heard"], f"{name}: heard chord drifted {row['heard']} -> {fresh_row['heard']}"
        np.testing.assert_allclose(fresh_row["activation"], row["activation"], atol=1e-6, err_msg=f"{name}: activation drifted")
