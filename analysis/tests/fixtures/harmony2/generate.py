"""Generates the three synthetic Harmony v2 fixtures (sec 5.3 of spec-harmony-v2.md) IN MEMORY,
at test time -- no audio is committed (the project rule: audio is never committed, in any
format; `.gitignore` blocks `*.wav`, so a checked-in fixture would silently vanish on a fresh
clone and fail in CI). `test_harmony2_ref.py` calls the four functions below directly.

Each signal is 2s mono float32 at 22.05 kHz, six harmonic partials per tone (amplitude
`0.6**(h-1)`), matching the prototype's `synth.py`. Every function returns the samples AS THEY
WOULD HAVE BEEN READ BACK from a `subtype="FLOAT"` (32-bit float) WAV -- i.e. rounded through
`float32` once -- so a fixture built here is bit-identical to the one the original, no-longer-
committed `.wav` files held, and the checked-in `expected.json` (computed from those original
files) stays valid without regenerating it. `crates/apricity-harmony/tests/synth.rs` is the Rust
port of the same functions, rounded through `f32` the same way, for the same reason.

`main()` (optional; not run by any test) writes the four signals to a path you give it, for
manual listening/debugging -- never into this fixtures directory, which is git-tracked.
"""

from __future__ import annotations

import sys
import pathlib

import numpy as np

SR = 22050


def tone(midi: float, secs: float = 2.0, cents: float = 0.0, partials: int = 6, amp: float = 1.0) -> np.ndarray:
    f = 440.0 * 2.0 ** ((midi - 69) / 12.0) * 2.0 ** (cents / 1200.0)
    t = np.arange(int(secs * SR)) / SR
    y = sum((0.6 ** (h - 1)) * np.sin(2 * np.pi * f * h * t) for h in range(1, partials + 1))
    return amp * y / np.max(np.abs(y))


def _as_wav_would_hold_it(y: np.ndarray, scale: float = 0.3) -> np.ndarray:
    """Rounds through `float32` once (what `sf.write(..., subtype="FLOAT")` then `sf.read()`
    would give back), and returns `float64` (what `soundfile.read()`'s default dtype gives)."""
    return (scale * y).astype(np.float32).astype(np.float64)


def ce_inversion() -> np.ndarray:
    """(a) C/E: a first-inversion C major triad, bass E2, C3 G3 C4 above (the additive-template
    prototype heard this as Am7; NNLS must not)."""
    y = 1.2 * tone(40) + tone(48) + tone(55) + tone(60)  # E2, C3, G3, C4
    return _as_wav_would_hold_it(y)


def detuned_30c() -> np.ndarray:
    """(b) A3 detuned +30 cents (six partials): the cents estimator must read +30 +/- 0.5."""
    return _as_wav_would_hold_it(tone(57, cents=30.0))


def shift_loop() -> np.ndarray:
    """(c) A known -3 semitone shift: a Cm7 arpeggio (C4 Eb4 G4 Bb4) that IS a written Am7
    shifted -3 semitones. See `shift_bass()` for the paired pinned bass."""
    y = 1.0 * tone(60) + 1.0 * tone(63) + 1.0 * tone(67) + 1.0 * tone(70)  # C4 Eb4 G4 Bb4
    return _as_wav_would_hold_it(y)


def shift_bass() -> np.ndarray:
    """The A2 pinned bass paired with `shift_loop()` (the written/pinned bass for the Am7)."""
    return _as_wav_would_hold_it(tone(45, partials=6))


def main():
    """Optional: writes the four signals as WAVs to `sys.argv[1]` (a directory OUTSIDE the repo,
    e.g. for manual listening) -- never into this fixtures directory. `shift_stems.json` (small,
    non-audio, git-tracked) is unaffected by this; see `generate_shift_stems_json` below."""
    import soundfile as sf

    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit("usage: generate.py <output dir, outside the repo>")
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name, fn in [("ce_inversion.wav", ce_inversion), ("detuned_30c.wav", detuned_30c), ("shift_loop.wav", shift_loop), ("shift_bass.wav", shift_bass)]:
        sf.write(out / name, fn().astype(np.float32), SR, subtype="FLOAT")
        print(f"{name}: {(out / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
