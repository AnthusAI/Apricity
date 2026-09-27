"""Harmony v2 Python reference: octave-aware note salience and chord recognition.

This is the *reference* `apricity-harmony` (Rust, Kanbus `apricitus-c7ffff`) is checked against
for parity. Design: Kanbus epic `apricitus-445cae`, `spec-harmony-v2.md` secs 2.1-2.3, 2.7, 5.3.

Deliberately does **not** use `librosa.cqt`: its kernel normalisation and windowing differ from a
straight Brown & Puckette (1992) sparse-kernel CQT, so the two implementations (this file and
`apricity-harmony`) compute the *same* thing from the same from-scratch design, rather than one
being checked against a third library's conventions.

Pipeline, per pitched non-kit stem:
  1. `cqt()` -- a sparse-kernel CQT, 36 bins/octave (3 per semitone), C1..B7 (84 semitones, 252
     bins), hop 512 at 22.05 kHz (sec 2.1).
  2. `cents_offset()` -- a parabolic sub-bin fit on each frame's strongest peak, folded to the
     semitone centre, median over frames (sec 2.2).
  3. `fold_to_semitones()` -- take each semitone's centre bin (bin `3k+1` of `3k..3k+3`; `fmin`
     is exactly C1 so bin `3k` is the semitone's left edge and `3k+1` its centre).
  4. `nnls_notes()` -- per-frame non-negative least squares against the 84 harmonic note
     templates (partial weights `[1, .6, .4, .3, .2, .15]` at `+0, +12, +19, +24, +28, +31`
     semitones), so a note already explains its own upper partials instead of a same-pitch-class
     "note" appearing an octave/fifth away.
  5. `beat_aggregate()` -- per-beat median over frames, then a semitone-axis local-max pick.
  6. `recognise_chord()` -- root x quality x bass over the combined (summed) note activations.
  7. `transposition_map()` -- re-score a stem's span rolled by every shift -6..5, others fixed.

A documented simplification against the full design (sec 2.1's 252-row NNLS): step 3 folds each
semitone's 3 CQT bins to its centre bin *before* NNLS, so the template matrix is 84x84 rather
than 252x84. This keeps the "a note explains its own harmonics; NNLS doesn't hallucinate a root a
fifth below" mechanism the acceptance tests (sec 5.3) exercise, at less computational cost; the
full 252-row decomposition (which also resolves within-semitone leakage) is left to a later pass
if a fixture needs it. `cents_offset()` still uses the full 252-bin resolution, so cents accuracy
is unaffected by the simplification.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import nnls

# --------------------------------------------------------------------------- constants

SR = 22050
HOP = 512
BINS_PER_OCTAVE = 36
BINS_PER_SEMITONE = 3
N_OCTAVES = 7  # C1..B7
N_SEMITONES = 12 * N_OCTAVES  # 84
N_BINS = N_SEMITONES * BINS_PER_SEMITONE  # 252
MIDI_C1 = 24  # C1 = MIDI 24
FMIN = 440.0 * 2.0 ** ((MIDI_C1 - 69) / 12.0)  # C1 in Hz, A440 reference

HARMONIC_SEMITONES = [0, 12, 19, 24, 28, 31]
HARMONIC_WEIGHTS = [1.0, 0.6, 0.4, 0.3, 0.2, 0.15]

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
QUALITIES = {
    "": [0, 4, 7],
    "m": [0, 3, 7],
    "dim": [0, 3, 6],
    "aug": [0, 4, 8],
    "sus2": [0, 2, 7],
    "sus4": [0, 5, 7],
    "7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10],
    "mMaj7": [0, 3, 7, 11],
    "m7b5": [0, 3, 6, 10],
    "dim7": [0, 3, 6, 9],
}


def semitone_name(m: int) -> str:
    """MIDI note name (no octave-safe unicode), e.g. 60 -> 'C5' (MIDI convention, C1=24)."""
    return f"{NAMES[m % 12]}{m // 12 - 1}"


# --------------------------------------------------------------------------- CQT (Brown & Puckette 1992)


def _bin_freq(k: int, tuning_cents: float = 0.0) -> float:
    return FMIN * 2.0 ** (k / BINS_PER_OCTAVE) * 2.0 ** (tuning_cents / 1200.0)


def build_cqt_kernels(tuning_cents: float = 0.0):
    """One sparse FFT-domain kernel per bin. Returns `(kernels, n_fft)`; `kernels[k]` is
    `(indices, weights)` into an `n_fft`-point FFT (Brown & Puckette 1992, sec 2.1)."""
    q = 1.0 / (2.0 ** (1.0 / BINS_PER_OCTAVE) - 1.0)
    lengths = [max(4, int(round(q * SR / _bin_freq(k, tuning_cents)))) for k in range(N_BINS)]
    n_fft = 1
    while n_fft < max(lengths):
        n_fft *= 2
    kernels = []
    for k in range(N_BINS):
        n = lengths[k]
        f = _bin_freq(k, tuning_cents)
        win = np.hanning(n)
        t = np.arange(n)
        wave = win * np.exp(-2j * np.pi * f * t / SR) / n
        padded = np.zeros(n_fft, dtype=np.complex128)
        start = (n_fft - n) // 2
        padded[start : start + n] = wave
        K = np.fft.fft(padded)
        mag = np.abs(K)
        thresh = mag.max() * 0.0054  # ~ -45 dB: sparsify (Brown & Puckette's "kernel truncation")
        idx = np.where(mag > thresh)[0]
        kernels.append((idx, np.conj(K[idx])))
    return kernels, n_fft


def cqt(y: np.ndarray, tuning_cents: float = 0.0, hop: int = HOP):
    """`(N_BINS, n_frames)` magnitude CQT of mono float `y`, centered frames on the hop grid."""
    kernels, n_fft = build_cqt_kernels(tuning_cents)
    pad = n_fft // 2
    yp = np.concatenate([np.zeros(pad), np.asarray(y, dtype=np.float64), np.zeros(pad)])
    n_frames = max(1, 1 + (len(yp) - n_fft) // hop)
    C = np.empty((N_BINS, n_frames), dtype=np.complex128)
    for i in range(n_frames):
        seg = yp[i * hop : i * hop + n_fft]
        if len(seg) < n_fft:
            seg = np.concatenate([seg, np.zeros(n_fft - len(seg))])
        X = np.fft.fft(seg)
        for k, (idx, w) in enumerate(kernels):
            C[k, i] = np.dot(X[idx], w)
    return np.abs(C)


def fold_to_semitones(C: np.ndarray) -> np.ndarray:
    """`(N_BINS, n_frames)` -> `(N_SEMITONES, n_frames)`, taking each semitone's centre bin.
    `FMIN` is exactly C1, so bin `3k` is the centre of semitone `k` (verified empirically: an
    untransposed A3 sine peaks at bin `3*33 = 99`, not `100`)."""
    centre = np.arange(N_SEMITONES) * BINS_PER_SEMITONE
    return C[centre]


# --------------------------------------------------------------------------- tuning / cents


def cents_offset(y: np.ndarray) -> float:
    """Cents from equal temperament (A440), from the strongest CQT peak each frame: a parabolic
    sub-bin fit over the 3 neighbouring bins (33.3 cents apart), folded to the semitone centre,
    median over frames (sec 2.2)."""
    C = cqt(y)
    offs = []
    for f in range(C.shape[1]):
        col = C[:, f]
        k = int(np.argmax(col))
        if k <= 0 or k >= C.shape[0] - 1 or col[k] <= 1e-9:
            continue
        a, b, c = np.log(col[k - 1] + 1e-12), np.log(col[k] + 1e-12), np.log(col[k + 1] + 1e-12)
        denom = a - 2 * b + c
        d = 0.5 * (a - c) / denom if denom != 0 else 0.0
        # bin k's offset from its NEAREST semitone centre (bin `3m`, since `fmin` is exactly
        # C1), in bins, then cents (33.33 cents/bin): the centre nearest to k, not k's own
        # residue class, since a note can sit anywhere within +/-50 cents of its written semitone.
        centre = BINS_PER_SEMITONE * round(k / BINS_PER_SEMITONE)
        cents = ((k - centre) + d) * (1200.0 / BINS_PER_OCTAVE)
        offs.append(cents)
    return float(np.median(offs)) if offs else 0.0


# --------------------------------------------------------------------------- NNLS note templates


def build_templates() -> np.ndarray:
    """`(N_SEMITONES, N_SEMITONES)` harmonic template matrix `T`: column `j` is the semitone
    salience a fundamental at semitone `j` produces (itself plus its upper partials, sec 2.1)."""
    T = np.zeros((N_SEMITONES, N_SEMITONES))
    for j in range(N_SEMITONES):
        for h, w in zip(HARMONIC_SEMITONES, HARMONIC_WEIGHTS):
            i = j + h
            if i < N_SEMITONES:
                T[i, j] = w
    return T


_TEMPLATES = build_templates()


def nnls_notes(folded_frame: np.ndarray, templates: np.ndarray = _TEMPLATES) -> tuple[np.ndarray, float]:
    """One frame's `(N_SEMITONES,)` note activations `a >= 0` minimising `||v - T @ a||^2`, and
    the relative residual `||v - T@a|| / ||v||` (sec 2.1's noisy-frame flag; NaN in for a silent
    frame)."""
    a, _ = nnls(templates, folded_frame)
    resid = templates @ a - folded_frame
    denom = np.linalg.norm(folded_frame)
    rel = float(np.linalg.norm(resid) / denom) if denom > 1e-12 else 0.0
    return a, rel


def nnls_activations(C_folded: np.ndarray) -> np.ndarray:
    """`(N_SEMITONES, n_frames)` NNLS activations, one frame at a time."""
    A = np.zeros_like(C_folded)
    for f in range(C_folded.shape[1]):
        a, _ = nnls_notes(C_folded[:, f])
        A[:, f] = a
    return A


# --------------------------------------------------------------------------- beat aggregation


def beat_aggregate(A: np.ndarray, frame_times: np.ndarray, tempo: float, offset_beats: float, n_beats: int) -> np.ndarray:
    """`(n_beats, N_SEMITONES)`: the per-beat median activation, then a semitone-axis local-max
    pick (a note's own-bin neighbours are leakage/harmonics, not a second note, sec 2.1)."""
    spb = 60.0 / tempo
    B = np.zeros((n_beats, N_SEMITONES))
    for b in range(n_beats):
        t0, t1 = (offset_beats + b) * spb, (offset_beats + b + 1) * spb
        sel = (frame_times >= t0) & (frame_times < t1)
        if sel.any():
            B[b] = np.median(A[:, sel], axis=1)
    P = np.zeros_like(B)
    for b in range(n_beats):
        v = B[b]
        for i in range(N_SEMITONES):
            left = v[i - 1] if i > 0 else 0.0
            right = v[i + 1] if i + 1 < N_SEMITONES else 0.0
            if v[i] > 0 and v[i] >= left and v[i] >= right:
                P[b, i] = v[i]
    return P


# --------------------------------------------------------------------------- chord recognition


def recognise_chord(activation: np.ndarray, known_bass_pc: int | None = None):
    """`(root_pc, quality, bass_pc, score)` for one combined `(N_SEMITONES,)` activation vector
    (sec 2.4). `known_bass_pc` is the score's own bass pitch class when a pinned single-note
    track sounds this span; otherwise the lowest note with >= 25% of the loudest is used."""
    if activation.sum() <= 0:
        return None
    pcp = np.zeros(12)
    for i, x in enumerate(activation):
        pcp[(MIDI_C1 + i) % 12] += x
    pcp = pcp / pcp.sum()
    if known_bass_pc is None:
        thr = 0.25 * activation.max()
        idx = np.where(activation >= thr)[0]
        low = int(idx[0]) if len(idx) else int(np.argmax(activation))
        bass_pc = (MIDI_C1 + low) % 12
    else:
        bass_pc = known_bass_pc
    best = None
    for root in range(12):
        for quality, intervals in QUALITIES.items():
            tones = {(root + iv) % 12 for iv in intervals}
            on = sum(pcp[p] for p in tones)
            off = sum(pcp[p] for p in range(12) if p not in tones)
            score = on - 1.5 * off - 0.05 * max(0, len(intervals) - 3) + (0.15 if bass_pc in tones else -0.15)
            if best is None or score > best[3]:
                best = (root, quality, bass_pc, score)
    return best


def chord_match_score(activation: np.ndarray, root_pc: int, quality: str, bass_pc: int | None = None) -> float:
    """How well `activation` matches a SPECIFIC written chord (root/quality/bass), the same
    on-chord-mass-minus-off-chord-mass shape `recognise_chord` uses per candidate, but for one
    named chord rather than the best-fitting one over all roots/qualities (sec 2.5's `target`)."""
    if activation.sum() <= 0:
        return 0.0
    pcp = np.zeros(12)
    for i, x in enumerate(activation):
        pcp[(MIDI_C1 + i) % 12] += x
    pcp = pcp / pcp.sum()
    intervals = QUALITIES[quality]
    tones = {(root_pc + iv) % 12 for iv in intervals}
    on = sum(pcp[p] for p in tones)
    off = sum(pcp[p] for p in range(12) if p not in tones)
    score = on - 1.5 * off - 0.05 * max(0, len(intervals) - 3)
    if bass_pc is not None:
        score += 0.15 if bass_pc in tones else -0.15
    return float(score)


def transposition_map(span_activation: np.ndarray, other_activation: np.ndarray, target_root_pc: int, target_quality: str, target_bass_pc: int | None, shifts=range(-6, 6)):
    """`{shift: score}` for rolling `span_activation` (one stem's span activation) by every
    semitone shift, with `other_activation` (everything else, summed) held fixed, scored against
    the WRITTEN chord `(target_root_pc, target_quality, target_bass_pc)` (sec 3.2): this is what
    "does shift `k` make the loop fit the chord that's actually written" measures, as opposed to
    `recognise_chord`, which asks "what chord does this shift's mix sound like at all"."""
    out = {}
    for s in shifts:
        rolled = np.roll(span_activation, s)
        combo = rolled + other_activation
        out[s] = chord_match_score(combo, target_root_pc, target_quality, target_bass_pc)
    return out
