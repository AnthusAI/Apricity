"""Harmony v2 Phase 2 Python reference: the chord-following EQ's band design and its RBJ peaking
biquad bank. This is the *reference* `HarmonicBank` (Rust, `crates/apricity-dsp/src/fx.rs`,
Kanbus `apricitus-35c9f3`) is checked for parity against. Design: Kanbus epic `apricitus-445cae`,
`spec-harmony-v2.md` sec 4.

Deliberately does not use `scipy.signal` for the filter: its peaking-EQ coefficient formulas
round differently from the RBJ Audio EQ Cookbook formula `Biquad::set` implements, so this file
ports that exact formula in numpy instead of checking Rust against a third library's rounding.

Pipeline, mirroring `crates/apricity-dsp/src/fx.rs`:
  1. `q_from_tolerance_cents()` -- a band's Q from its half-width in cents (sec 4.4).
  2. `design_bands()` -- the note grid over `range` at `tune`'s semitone spacing, each band's
     target gain for the chord now sounding: `cut` touches non-chord tones (minus protected
     partials, sec 4.2), `boost` touches chord tones (full weight at/above the bass's own
     register, half below), `both` does both (sec 4.5).
  3. `HarmonicBank` -- the same fixed-grid bank as the Rust `HarmonicBank`: gains glide toward
     their per-span target at a rate set by `glide`, recomputed once per 32-frame block, and a
     band whose gain is bit-exact 0 dB contributes nothing (depth 0 is a bypass).
"""

from __future__ import annotations

import dataclasses
import math

import numpy as np

# --------------------------------------------------------------------------- band design

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def q_from_tolerance_cents(tolerance_cents: float) -> float:
    """A peaking band's Q from its half-width in cents (spec 4.4): `Q = f / (f*(2^x - 2^-x))`
    with `x = tolerance_cents / 1200`, which doesn't depend on `f`."""
    x = max(tolerance_cents, 1e-6) / 1200.0
    ratio = 2.0 ** x
    return max(1.0 / (ratio - 1.0 / ratio), 0.05)


@dataclasses.dataclass(frozen=True)
class HarmonicParams:
    mode: str = "cut"  # "cut" | "boost" | "both"
    depth_db: float = 9.0
    boost_db: float = 6.0
    tolerance_cents: float = 30.0
    harmonics: int = 6
    range_lo_hz: float = 80.0
    range_hi_hz: float = 4000.0
    tune_hz: float = 440.0
    mix: float = 1.0


@dataclasses.dataclass(frozen=True)
class HarmonicChord:
    """The chord sounding in a span, as the band designer needs it."""
    tones_pc: frozenset[int]
    bass_hz: float
    fundamentals_hz: tuple[float, ...] = ()

    def is_tone(self, pc: int) -> bool:
        return (pc % 12) in self.tones_pc


def _is_protected_partial(hz: float, fundamentals_hz, harmonics: int, tolerance_cents: float) -> bool:
    if harmonics <= 0:
        return False
    for f in fundamentals_hz:
        if f <= 0:
            continue
        for h in range(1, harmonics + 1):
            partial = f * h
            if partial <= 0:
                continue
            cents = 1200.0 * math.log2(hz / partial)
            if abs(cents) <= tolerance_cents:
                return True
    return False


def note_grid(p: HarmonicParams, max_bands: int = 96) -> list[tuple[float, int]]:
    """`(hz, pitch_class)` for every semitone-grid note in `range`, at most `max_bands` (spec
    4.3: at most 96, one per note across 8 octaves)."""
    if not (p.range_lo_hz > 0 and p.range_hi_hz > p.range_lo_hz):
        return []

    def midi_of_hz(hz: float) -> float:
        return 69.0 + 12.0 * math.log2(hz / p.tune_hz)

    lo = math.ceil(midi_of_hz(p.range_lo_hz))
    hi = math.floor(midi_of_hz(p.range_hi_hz))
    out = []
    for m in range(lo, hi + 1):
        if len(out) >= max_bands:
            break
        hz = p.tune_hz * 2.0 ** ((m - 69) / 12.0)
        out.append((hz, m % 12))
    return out


def target_db(pc: int, hz: float, chord: HarmonicChord, p: HarmonicParams) -> float:
    """The target gain (dB) for one band -- a direct port of `fx::target_db` in the Rust bank."""
    tone = chord.is_tone(pc)

    def cut() -> float:
        if tone or _is_protected_partial(hz, chord.fundamentals_hz, p.harmonics, p.tolerance_cents):
            return 0.0
        return -p.depth_db

    def boost() -> float:
        if not tone:
            return 0.0
        weight = 1.0 if hz >= chord.bass_hz else 0.5
        return weight * p.boost_db

    if p.mode == "cut":
        return cut()
    if p.mode == "boost":
        return boost()
    if p.mode == "both":
        return cut() + boost()
    raise ValueError(f"unknown mode {p.mode!r}")


def design_bands(chord: HarmonicChord, p: HarmonicParams) -> list[dict]:
    """The band list for one chord span: every note in `range`, with its target gain and Q.
    A band at 0 dB is inert (matches the Rust bank's "no band ticked at 0 dB" bypass path)."""
    q = q_from_tolerance_cents(p.tolerance_cents)
    bands = []
    for hz, pc in note_grid(p):
        db = target_db(pc, hz, chord, p)
        bands.append({"hz": round(hz, 6), "pc": pc, "note": NAMES[pc], "db": round(db, 6), "q": round(q, 6)})
    return bands


# --------------------------------------------------------------------------- the RBJ peaking biquad

@dataclasses.dataclass
class Biquad:
    """One RBJ Audio EQ Cookbook peaking section, normalized `b0..b2, a1, a2` (a0 = 1) -- the
    exact formula `Biquad::set(BiquadKind::Peak { .. })` in `crates/apricity-dsp/src/fx.rs`
    implements, so the two sides round the same way."""
    b0: float = 1.0
    b1: float = 0.0
    b2: float = 0.0
    a1: float = 0.0
    a2: float = 0.0
    z: np.ndarray = dataclasses.field(default_factory=lambda: np.zeros((2, 2)))

    def set(self, hz: float, db: float, q: float, sr: float) -> None:
        nyq = sr * 0.49
        hz = min(max(hz, 1.0), nyq)
        w = 2.0 * math.pi * hz / sr
        sin_w, cos_w = math.sin(w), math.cos(w)
        alpha = sin_w / (2.0 * max(q, 0.05))
        a = 10.0 ** (db / 40.0)
        b0, b1, b2 = 1.0 + alpha * a, -2.0 * cos_w, 1.0 - alpha * a
        a0, a1, a2 = 1.0 + alpha / a, -2.0 * cos_w, 1.0 - alpha / a
        self.b0, self.b1, self.b2, self.a1, self.a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0

    def tick(self, ch: int, x: float) -> float:
        z = self.z[ch]
        y = self.b0 * x + z[0]
        z[0] = self.b1 * x - self.a1 * y + z[1]
        z[1] = self.b2 * x - self.a2 * y
        return y

    def response_db(self, hz: float, sr: float) -> float:
        w = 2.0 * math.pi * hz / sr
        c1, s1 = math.cos(w), math.sin(w)
        c2, s2 = math.cos(2 * w), math.sin(2 * w)
        nr, ni = self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2)
        dr, di = 1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2)
        return 10.0 * math.log10((nr * nr + ni * ni) / (dr * dr + di * di))


class HarmonicBank:
    """The same fixed-grid bank as `crates/apricity-dsp/src/fx.rs::HarmonicBank`: one slot per
    note in `range`, gains glide toward their target, and the whole bank is a bit-exact bypass
    when every band is at 0 dB."""

    def __init__(self, sr: float, p: HarmonicParams):
        self.sr = sr
        self.p = p
        self.q = q_from_tolerance_cents(p.tolerance_cents)
        self.grid = note_grid(p)
        self.filters = [Biquad() for _ in self.grid]
        self.current_db = [0.0 for _ in self.grid]
        self.bypassed = True

    def update(self, chord: HarmonicChord | None, glide_s: float, block_dur_s: float) -> None:
        p = self.p
        full_swing = max(p.depth_db, p.boost_db, 1.0)
        max_step = full_swing * (block_dur_s / glide_s) if glide_s > 1e-9 else math.inf
        any_active = False
        for i, (hz, pc) in enumerate(self.grid):
            target = 0.0 if chord is None else target_db(pc, hz, chord, p)
            d = target - self.current_db[i]
            d = max(-max_step, min(max_step, d))
            if d != 0.0:
                self.current_db[i] += d
                self.filters[i].set(hz, self.current_db[i], self.q, self.sr)
            if abs(self.current_db[i]) > 1e-9:
                any_active = True
        self.bypassed = not any_active

    def tick(self, ch: int, x: float) -> float:
        if self.bypassed:
            return x
        y = x
        for i, db in enumerate(self.current_db):
            if abs(db) > 1e-9:
                y = self.filters[i].tick(ch, y)
        return y

    def process_mono(self, x: np.ndarray, chord_at, glide_s: float, block: int = 32) -> np.ndarray:
        """Filters a mono buffer, re-targeting every `block` samples from `chord_at(sample_index)`
        (mirrors `process_chain`'s 32-frame automation path in `apricity-engine`)."""
        out = np.empty_like(x, dtype=np.float64)
        block_dur_s = block / self.sr
        for start in range(0, len(x), block):
            end = min(start + block, len(x))
            self.update(chord_at(start), glide_s, block_dur_s)
            for i in range(start, end):
                out[i] = self.tick(0, float(x[i]))
        return out

    def response_db(self, hz: float) -> float:
        return sum(f.response_db(hz, self.sr) for f, db in zip(self.filters, self.current_db) if abs(db) > 1e-9)
