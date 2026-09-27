"""Generates the Phase 2 `harmonic` fixture IN MEMORY, at test time -- no audio is committed (the
project rule: audio is never committed, in any format; `.gitignore` blocks `*.wav`).

The 4-chord synthetic score of spec-harmony-v2.md sec 4.3: `Am7 Fmaj7 Dm7 G`, 2 beats each at
120 bpm (1 s/chord at 48 kHz), no effect applied yet -- this is the "dry" stem the reference and
`crates/apricity-dsp` unit tests both start from. Each span sounds its chord's root and third
plus one fixed off-chord tone (C#, never a chord tone of any of the four spans), so a `cut`
setting has something to cut in every span and something to leave alone.

A documented simplification against the full spec: rather than rendering this through the actual
score engine (task 10, not yet landed when this fixture was written), the dry stem is synthesized
directly as sines -- the same scope the Rust `apricity-dsp` unit tests use (`crates/apricity-dsp/
src/fx.rs`'s `HarmonicBank` tests). It exercises the DSP (band design + biquad bank + glide), not
the score compiler's chord-span embedding, which task 10 tests separately against `examples/*.apr`.
"""

from __future__ import annotations

import numpy as np

SR = 48000
BPM = 120.0
BEATS_PER_CHORD = 2.0
SPAN_S = BEATS_PER_CHORD * 60.0 / BPM  # 1.0 s at 120 bpm

# (label, tones pitch-classes, bass pitch-class)
SPANS = [
    ("Am7", (9, 0, 4, 7), 9),
    ("Fmaj7", (5, 9, 0, 4), 5),
    ("Dm7", (2, 5, 9, 0), 2),
    ("G", (7, 11, 2), 7),
]

WRONG_PC = 1  # C#: never a chord tone of any of the four spans above

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _hz(pc: int, octave: int) -> float:
    midi = 12 * (octave + 1) + pc
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def dry_stem() -> np.ndarray:
    """4 s mono float64 (as a `subtype="FLOAT"` WAV read back would give): each span's root
    (octave 3) and third (octave 4) plus the fixed off-chord C#5, each at a steady amplitude."""
    n = int(SPAN_S * SR)
    t = np.arange(n) / SR
    out = np.zeros(len(SPANS) * n, dtype=np.float64)
    wrong_hz = _hz(WRONG_PC, 5)
    for i, (_label, tones, _bass) in enumerate(SPANS):
        root_hz = _hz(tones[0], 3)
        third_hz = _hz(tones[1], 4)
        y = 0.5 * np.sin(2 * np.pi * root_hz * t) + 0.3 * np.sin(2 * np.pi * third_hz * t) + 0.2 * np.sin(2 * np.pi * wrong_hz * t)
        out[i * n:(i + 1) * n] = (0.3 * y).astype(np.float32).astype(np.float64)
    return out


def chord_at(sample_index: int):
    from apricity_analyze.harmonic_ref import HarmonicChord

    span_i = min(sample_index // int(SPAN_S * SR), len(SPANS) - 1)
    _label, tones, bass_pc = SPANS[span_i]
    bass_hz = _hz(bass_pc, 2)
    fundamentals = [bass_hz] + [_hz(pc, 3) for pc in tones if pc != bass_pc]
    return HarmonicChord(tones_pc=frozenset(tones), bass_hz=bass_hz, fundamentals_hz=tuple(fundamentals))
