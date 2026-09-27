"""Acceptance tests for `apricity_analyze.harmonic_ref` (Kanbus `apricitus-ddc14b`, Harmony v2
Phase 2 task 8: the chord-following EQ's band design and RBJ biquad bank reference). The 4-chord
fixture (`tests/fixtures/harmonic/generate.py`) is built in memory at test time -- no audio is
committed anywhere (`.gitignore` blocks `*.wav`). Regenerates `tests/fixtures/harmonic/
expected.json` (band lists per span, output checksums/summary stats for three presets -- numbers
only) and diffs it against the checked-in copy, so a drift on either side of the Rust parity test
(`crates/apricity-dsp/src/fx.rs`'s `HarmonicBank`, Kanbus `apricitus-35c9f3`) is caught here first.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys

import numpy as np
import pytest

from apricity_analyze import harmonic_ref as h

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "harmonic"


def _import(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(f"harmonic_fixtures_{name}", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


generate = _import("generate", FIXTURES / "generate.py")

PRESETS = {
    # Name -> HarmonicParams, per spec-harmony-v2.md sec 4.7.
    "cleanup": h.HarmonicParams(mode="cut", depth_db=6.0, tolerance_cents=20.0, harmonics=6, range_lo_hz=100.0, range_hi_hz=3000.0),
    "autotune-ish": h.HarmonicParams(mode="cut", depth_db=14.0, tolerance_cents=40.0, harmonics=0, range_lo_hz=60.0, range_hi_hz=6000.0),
    "both-8c": h.HarmonicParams(mode="both", depth_db=18.0, boost_db=14.0, tolerance_cents=8.0, harmonics=2, range_lo_hz=60.0, range_hi_hz=8000.0),
}
GLIDE_S = {"cleanup": 0.060, "autotune-ish": 0.015, "both-8c": 0.250}


def _checksum(y: np.ndarray) -> str:
    return hashlib.sha256(np.round(y, 8).astype(np.float64).tobytes()).hexdigest()


def test_q_from_tolerance_matches_the_spec_worked_examples():
    assert abs(h.q_from_tolerance_cents(30.0) - 29.0) < 1.0
    assert abs(h.q_from_tolerance_cents(100.0) - 8.7) < 0.5
    assert abs(h.q_from_tolerance_cents(5.0) - 173.0) < 5.0


def test_design_bands_cuts_only_non_chord_tones_and_protects_the_bass_fifth_partial():
    bass_hz = generate._hz(9, 2)  # A2
    chord = h.HarmonicChord(tones_pc=frozenset({9, 0, 4}), bass_hz=bass_hz, fundamentals_hz=(bass_hz,))
    p = h.HarmonicParams(mode="cut", depth_db=9.0, tolerance_cents=30.0, harmonics=6, range_lo_hz=20.0, range_hi_hz=2000.0)
    bands = h.design_bands(chord, p)
    for b in bands:
        if b["pc"] in (9, 0, 4):
            assert b["db"] == 0.0, f"chord tone {b['note']} should not be cut: {b}"
    # A's 5th partial (h=5) lands near C# -- protected at harmonics=6, cut at harmonics=0.
    fifth_partial_band = min(bands, key=lambda b: abs(b["hz"] - bass_hz * 5))
    assert fifth_partial_band["pc"] == 1  # C#
    assert fifth_partial_band["db"] == 0.0, "harmonics 6 should protect the bass's 5th partial"

    p0 = h.HarmonicParams(mode="cut", depth_db=9.0, tolerance_cents=30.0, harmonics=0, range_lo_hz=20.0, range_hi_hz=2000.0)
    bands0 = h.design_bands(chord, p0)
    fifth_partial_band0 = min(bands0, key=lambda b: abs(b["hz"] - bass_hz * 5))
    assert fifth_partial_band0["db"] == -9.0, "harmonics 0 should cut it"


def test_depth_zero_is_a_bypass():
    chord = h.HarmonicChord(tones_pc=frozenset({0, 4, 7}), bass_hz=110.0)
    p = h.HarmonicParams(mode="both", depth_db=0.0, boost_db=0.0)
    bank = h.HarmonicBank(sr=48000.0, p=p)
    bank.update(chord, glide_s=0.0, block_dur_s=32 / 48000.0)
    assert bank.bypassed
    x = 0.37
    assert bank.tick(0, x) == x


def _band_summary(preset: str) -> dict:
    p = PRESETS[preset]
    rows = []
    for label, tones, bass_pc in generate.SPANS:
        bass_hz = generate._hz(bass_pc, 2)
        fundamentals = [bass_hz] + [generate._hz(pc, 3) for pc in tones if pc != bass_pc]
        chord = h.HarmonicChord(tones_pc=frozenset(tones), bass_hz=bass_hz, fundamentals_hz=tuple(fundamentals))
        bands = [b for b in h.design_bands(chord, p) if b["db"] != 0.0]
        rows.append({"span": label, "active_bands": bands})
    return {"q": round(h.q_from_tolerance_cents(p.tolerance_cents), 6), "spans": rows}


def _rendered_checksum(preset: str) -> dict:
    p = PRESETS[preset]
    dry = generate.dry_stem()
    bank = h.HarmonicBank(sr=generate.SR, p=p)
    wet = bank.process_mono(dry, generate.chord_at, glide_s=GLIDE_S[preset])
    return {
        "checksum_sha256": _checksum(wet),
        "peak": round(float(np.max(np.abs(wet))), 6),
        "rms": round(float(np.sqrt(np.mean(wet ** 2))), 6),
        "dry_rms": round(float(np.sqrt(np.mean(dry ** 2))), 6),
    }


def test_cut_reduces_energy_and_boost_raises_it_relative_to_dry():
    dry = generate.dry_stem()
    cut = _rendered_checksum("autotune-ish")
    both = _rendered_checksum("both-8c")
    assert cut["rms"] < cut["dry_rms"], "a cut-heavy preset should reduce RMS (it removes the wrong note)"
    assert both["rms"] > cut["dry_rms"] * 0.9, "a boost preset shouldn't be quieter than the dry signal"
    assert len(dry) == generate.SPANS.__len__() * int(generate.SPAN_S * generate.SR)


def _fixture_summary() -> dict:
    return {preset: {"bands": _band_summary(preset), "render": _rendered_checksum(preset)} for preset in PRESETS}


def test_expected_json_matches_the_checked_in_copy():
    """Regenerates `expected.json` (band lists per span and output checksums/summary stats for
    the three presets -- numbers only, no audio) and diffs it against the checked-in copy."""
    fresh = _fixture_summary()
    path = FIXTURES / "expected.json"
    if not path.exists():
        path.write_text(json.dumps(fresh, indent=2) + "\n")
        pytest.skip("expected.json did not exist; wrote it from the current reference")
    checked_in = json.loads(path.read_text())
    for preset, fresh_row in fresh.items():
        assert preset in checked_in, f"{preset} missing from the checked-in expected.json"
        row = checked_in[preset]
        assert fresh_row["bands"] == row["bands"], f"{preset}: band design drifted"
        assert fresh_row["render"]["checksum_sha256"] == row["render"]["checksum_sha256"], f"{preset}: rendered output drifted"
        assert abs(fresh_row["render"]["peak"] - row["render"]["peak"]) < 1e-6
        assert abs(fresh_row["render"]["rms"] - row["render"]["rms"]) < 1e-6
