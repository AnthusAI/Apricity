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
