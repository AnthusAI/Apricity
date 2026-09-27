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


def frame_times(n_frames: int, hop: int = HOP) -> np.ndarray:
    """Each CQT frame's centre time in seconds: frame `i` is centred on sample `i*hop` of the
    (unpadded) input, since `cqt()` pads by `n_fft//2` on both sides before framing."""
    return np.arange(n_frames) * hop / SR


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
        # sec 2.4's floor: "at or above G1 (49 Hz)". The reference's 84-row NNLS simplification
        # (sec 2.1's documented deviation) can, on a real low-register stem, put spurious
        # post-NNLS activation an octave below the true fundamental; below-G1 activation is never
        # a real bass note at this register, so the audio-only fallback never considers it in the
        # first place -- it doesn't need to tell a real low note from a false one, because Phase
        # 1's own design (sec 2.3, "ground truth first") never uses this fallback for a track
        # whose bass is already known from the score; this floor only guards the *unknown* case.
        floor_idx = max(0, (31 - MIDI_C1))  # G1 = MIDI 31
        thr = 0.25 * activation.max()
        idx = np.where(activation >= thr)[0]
        idx = idx[idx >= floor_idx]
        if len(idx):
            low = int(idx[0])
        else:
            # every candidate above the floor was below threshold: fall back to the loudest
            # semitone at or above the floor, rather than an ambiguous below-floor bin.
            above = activation.copy()
            above[:floor_idx] = -1.0
            low = int(np.argmax(above)) if above.max() > 0 else int(np.argmax(activation))
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


# --------------------------------------------------------------------------- extensions, inversion, confidence (sec 2.4)

# Semitone offset from the root for each extension tag sec 2.4 lists (`{6, 9, maj9, m9, add9}`).
EXTENSION_TONE = {"6": 9, "9": 2, "maj9": 2, "m9": 2, "add9": 2}
# Which base QUALITIES key each extension tag is checked against: "9" only makes sense read
# against a dominant 7th (a triad + a 9th with no 7th is "add9", not "9"); "maj9"/"m9" against
# the matching 7th chord; "6"/"add9" against a bare triad.
EXTENSION_BASE_QUALITY = {"6": {"", "m"}, "9": {"7"}, "maj9": {"maj7"}, "m9": {"m7", "mMaj7", "m7b5"}, "add9": {"", "m"}}
EXTENSION_REGISTER_FLOOR_MIDI = 60  # C4
EXTENSION_MASS_FLOOR = 0.04         # a candidate extension pc needs this share of total activation to be "heard"
SEVENTH_QUALITIES = {"7", "maj7", "m7", "mMaj7", "m7b5", "dim7"}


def detect_extensions(activation: np.ndarray, root_pc: int, quality: str, bass_idx: int | None) -> list[str]:
    """Which extension tags are audibly present on top of `(root_pc, quality)`, from the
    octave-aware `activation` (not the folded 12-pc profile: the register test needs to know
    WHERE the note sounds). A candidate extension pitch class counts only when the activation
    summed over semitone indices at/above C4, OR at/above a major ninth (14 semitones) above the
    sounding bass, exceeds `EXTENSION_MASS_FLOOR` of the total (sec 2.4: "a 9th at 65 Hz is mud,
    not colour")."""
    total = float(activation.sum())
    if total <= 0:
        return []
    floor_idx = EXTENSION_REGISTER_FLOOR_MIDI - MIDI_C1
    bass_floor_idx = (bass_idx + 14) if bass_idx is not None else 10**9
    out = []
    for tag, semis in EXTENSION_TONE.items():
        if quality not in EXTENSION_BASE_QUALITY.get(tag, set()):
            continue
        pc = (root_pc + semis) % 12
        mass = sum(activation[i] for i in range(N_SEMITONES) if (MIDI_C1 + i) % 12 == pc and (i >= floor_idx or i >= bass_floor_idx))
        if mass / total >= EXTENSION_MASS_FLOOR:
            out.append(tag)
    return out


def chord_inversion(root_pc: int, quality: str, bass_pc: int) -> str:
    """`"root" | "1st" | "2nd" | "3rd"` from the bass's position in the chord's own tone list
    (root, 3rd, 5th, [7th]); `"root"` when the bass isn't one of the chord's own tones."""
    tones = [(root_pc + iv) % 12 for iv in QUALITIES[quality]]
    if bass_pc not in tones:
        return "root"
    idx = tones.index(bass_pc)
    return ["root", "1st", "2nd", "3rd"][idx] if idx < 4 else "root"


def recognise_chord_full(activation: np.ndarray, known_bass_pc: int | None = None) -> dict | None:
    """Sec 2.4's full per-span output: `{root, quality, extensions, bass, inversion, confidence}`
    from one combined (summed-across-stems) `(N_SEMITONES,)` activation vector. `None` when
    there's no tonal mass at all (sec 2.5's own `Q = 0` gate for a silent/unpitched span)."""
    if activation.sum() <= 0:
        return None
    root, quality, bass_pc, best_score = recognise_chord(activation, known_bass_pc)
    pcp = np.zeros(12)
    for i, x in enumerate(activation):
        pcp[(MIDI_C1 + i) % 12] += x
    pcp = pcp / pcp.sum()
    scores = []
    for r in range(12):
        for q, intervals in QUALITIES.items():
            tones = {(r + iv) % 12 for iv in intervals}
            on = sum(pcp[p] for p in tones)
            off = sum(pcp[p] for p in range(12) if p not in tones)
            scores.append(on - 1.5 * off - 0.05 * max(0, len(intervals) - 3) + (0.15 if bass_pc in tones else -0.15))
    scores.sort(reverse=True)
    best, second = scores[0], (scores[1] if len(scores) > 1 else scores[0])
    confidence = float((best - second) / best) if best > 1e-9 else 0.0
    cand_idx = [i for i in range(N_SEMITONES) if (MIDI_C1 + i) % 12 == bass_pc]
    bass_idx = max(cand_idx, key=lambda i: activation[i]) if cand_idx else None
    extensions = detect_extensions(activation, root, quality, bass_idx)
    return {
        "root": NAMES[root], "quality": quality, "extensions": extensions,
        "bass": NAMES[bass_pc], "inversion": chord_inversion(root, quality, bass_pc),
        "confidence": round(confidence, 4), "score": round(float(best_score), 4),
    }


def notes_from_activation(activation: np.ndarray, thr_ratio: float = 0.15) -> list[int]:
    """MIDI note numbers whose activation is at least `thr_ratio` of this vector's peak -- the
    "which notes are actually sounding" list `spacing`/`voice_leading` need."""
    if activation.size == 0 or activation.max() <= 0:
        return []
    thr = thr_ratio * activation.max()
    return [MIDI_C1 + i for i in range(N_SEMITONES) if activation[i] >= thr]


# --------------------------------------------------------------------------- Q, the chord-quality term (sec 2.5)

WRITTEN_QUALITY_BY_INTERVALS = {tuple(sorted(iv)): q for q, iv in QUALITIES.items()}


def written_quality_from_tones(root_pc: int, chord_tones_pc: list[int]) -> str | None:
    """Best-matching `QUALITIES` key for a written `chord_tones` list (root first), e.g.
    `[0, 4, 7, 11]` (root C) -> "maj7". `None` when there's no exact match (an unmodeled chord,
    e.g. a written 9th -- sec 0's chord model doesn't have those yet)."""
    ivs = tuple(sorted((t - root_pc) % 12 for t in chord_tones_pc))
    return WRITTEN_QUALITY_BY_INTERVALS.get(ivs)


def q_target(heard: dict, written_root_pc: int, written_quality: str | None, written_bass_pc: int | None) -> float:
    """`0.5*[root matches] + 0.3*[bass matches the written slash bass, or the root when none] +
    0.2*[heard tones subset written tones]` (sec 2.5)."""
    heard_root_pc = NAMES.index(heard["root"])
    heard_bass_pc = NAMES.index(heard["bass"])
    score = 0.5 if heard_root_pc == written_root_pc else 0.0
    want_bass = written_bass_pc if written_bass_pc is not None else written_root_pc
    score += 0.3 if heard_bass_pc == want_bass else 0.0
    if written_quality is not None:
        heard_tones = {(heard_root_pc + iv) % 12 for iv in QUALITIES[heard["quality"]]}
        written_tones = {(written_root_pc + iv) % 12 for iv in QUALITIES[written_quality]}
        score += 0.2 if heard_tones <= written_tones else 0.0
    return score


def q_extension(heard: dict, written_quality: str | None, key_scale_pcs: set[int] | None) -> float:
    """1 when a written 7th chord is heard *with* its 7th; 0.5 when a written triad is heard with
    a diatonic 7th/9th above the register floor; 0 otherwise (sec 2.5)."""
    heard_root_pc = NAMES.index(heard["root"])
    heard_has_seventh = heard["quality"] in SEVENTH_QUALITIES
    if written_quality in SEVENTH_QUALITIES:
        return 1.0 if heard_has_seventh else 0.0
    if heard["extensions"] or heard_has_seventh:
        if key_scale_pcs is None:
            return 0.5  # no key given: can't test diatonicity, credit the interesting extension anyway
        if heard["extensions"]:
            tag_pc = (heard_root_pc + EXTENSION_TONE[heard["extensions"][0]]) % 12
        else:
            iv = 10 if heard["quality"] in {"7", "m7", "mMaj7", "m7b5"} else 11
            tag_pc = (heard_root_pc + iv) % 12
        return 0.5 if tag_pc in key_scale_pcs else 0.0
    return 0.0


SPACING_MAX_SEMITONES = 4  # "pairs of sounding notes <= 4 semitones apart below C3" (sec 2.5)
SPACING_REGISTER_MIDI = 48  # C3


def q_spacing(notes_by_stem: dict[str, list[int]], allow_maj7_under_bass: bool = True) -> float:
    """`1 - (pairs of sounding notes <= SPACING_MAX_SEMITONES apart below C3, per note below C3)`
    (sec 2.5). A major 7th sitting a semitone under the bass is treated as colour, not mud (a
    listening decision recorded on Kanbus apricitus-445cae): with `allow_maj7_under_bass` (the
    default), a semitone-apart pair (`d == 1`) between two different stems, both below C3, is left
    out of the pair count; any other close low pair (major 2nds through major 3rds) still counts."""
    all_notes: list[tuple[str, int]] = [(stem, n) for stem, ns in notes_by_stem.items() for n in ns]
    low_notes = [(stem, n) for stem, n in all_notes if n < SPACING_REGISTER_MIDI]
    if not low_notes:
        return 1.0
    # Every unordered pair is visited exactly once (`i < j`), independent of the notes' order
    # within `all_notes` (which itself depends only on `notes_by_stem`'s iteration order, not on
    # anything musical): a pair counts when AT LEAST ONE of its two notes is below C3, matching
    # this function's own contract ("pairs of sounding notes ... below C3"), not only when the
    # lower-indexed one happens to be.
    pairs = 0
    for i in range(len(all_notes)):
        si, ni = all_notes[i]
        for j in range(i + 1, len(all_notes)):
            sj, nj = all_notes[j]
            if si == sj:
                continue
            if ni >= SPACING_REGISTER_MIDI and nj >= SPACING_REGISTER_MIDI:
                continue
            d = abs(ni - nj)
            if d == 0 or d > SPACING_MAX_SEMITONES:
                continue
            if allow_maj7_under_bass and d == 1:
                continue
            pairs += 1
    return max(0.0, 1.0 - pairs / max(1, len(low_notes)))


def q_voice_leading(notes_now: list[int], notes_prev: list[int] | None) -> float:
    """`max(0, 1 - mean nearest-note movement (semitones) / 6)` between this span's and the
    previous span's note sets (sec 2.5); full credit when there's no previous span to compare."""
    if not notes_prev or not notes_now:
        return 1.0
    moves = [min(abs(n - p) for p in notes_prev) for n in notes_now]
    return max(0.0, 1.0 - float(np.mean(moves)) / 6.0)


def compute_q(heard: dict, written_root_pc: int, written_quality: str | None, written_bass_pc: int | None,
              notes_by_stem: dict[str, list[int]], notes_prev: list[int] | None, key_scale_pcs: set[int] | None) -> dict:
    """`Q = 0.5*target + 0.2*extension + 0.15*spacing + 0.15*voice_leading` (sec 2.5)."""
    target = q_target(heard, written_root_pc, written_quality, written_bass_pc)
    extension = q_extension(heard, written_quality, key_scale_pcs)
    spacing = q_spacing(notes_by_stem)
    notes_now = [n for ns in notes_by_stem.values() for n in ns]
    voice_leading = q_voice_leading(notes_now, notes_prev)
    q = 0.5 * target + 0.2 * extension + 0.15 * spacing + 0.15 * voice_leading
    return {"target": round(target, 4), "extension": round(extension, 4), "spacing": round(spacing, 4),
            "voice_leading": round(voice_leading, 4), "Q": round(q, 4)}


# --------------------------------------------------------------------------- v1 port onto CQT-folded chroma (sec 2.6, 2.7's documented deviation from HPCP)

INTERVAL_K = [0.0, 1.00, 0.35, 0.0, 0.0, 0.05, 0.70, 0.0, 0.05, 0.0, 0.30, 1.00]
DOUBLED_AGAINST_BASS = (1, 2, 11)
_INTERVAL_KERNEL = np.array([[INTERVAL_K[abs(p - q)] for q in range(12)] for p in range(12)])
_INTERVAL_KERNEL_BASS = _INTERVAL_KERNEL.copy()
for _p in range(12):
    for _q in range(12):
        if abs(_p - _q) in DOUBLED_AGAINST_BASS:
            _INTERVAL_KERNEL_BASS[_p, _q] *= 2.0
del _p, _q

COVERAGE_MIN_SHARE = 0.05
COVERAGE_GUARD_PENALTY = 2.0
EXTENSION_GUARD_SHARE = 0.40  # sec 2.6: "an extension carrying > 40% of a span's mass" (new guard)
EXTENSION_GUARD_PENALTY = 5.0
BASS_ROOT_SEMITONE_WEIGHT = 1.0


def fold_activation_to_chroma(activation: np.ndarray) -> np.ndarray:
    """`(84,) -> (12,)`, summed (not normalised) mass per pitch class: the v1 port's chroma, the
    CQT/NNLS analogue of `check.py`'s Essentia-HPCP `Stem.chroma` (documented deviation, sec
    2.7: "the v1 port computes chroma from the same CQT folded to 12 bins")."""
    c = np.zeros(12)
    for i, x in enumerate(activation):
        c[(MIDI_C1 + i) % 12] += x
    return c


def _beat_clash(stem_chromas: dict[str, np.ndarray], chord_tones_pc: list[int], bass_pc: int | None, bass_stem_name: str | None) -> tuple[float, float]:
    """Raw (un-inverted) clash and total tonal mass for ONE beat's per-stem chroma vectors:
    `check.py`'s `beat_clash` pairwise kernel plus the undiluted bass-vs-root term, with sec 2.6's
    one change -- a pair of pitch classes that are BOTH chord tones of the span scores 0 in the
    pairwise kernel (a correctly voiced maj7 stops being the checker's worst case; its register
    problem, if any, is `spacing`'s job instead, sec 2.5). Returns `(clash, mass)`; `clash` is 0
    for a silent beat (`mass <= 0`), matching `check.py`'s `beat_clash` returning `0.0` then."""
    names = list(stem_chromas)
    total_mass = sum(float(c.sum()) for c in stem_chromas.values())
    if total_mass <= 1e-9:
        return 0.0, 0.0
    tones = set(chord_tones_pc)
    acc = 0.0
    for i in range(len(names)):
        ci = stem_chromas[names[i]]
        nz_p = np.nonzero(ci)[0]
        if not len(nz_p):
            continue
        for j in range(i + 1, len(names)):
            cj = stem_chromas[names[j]]
            nz_q = np.nonzero(cj)[0]
            if not len(nz_q):
                continue
            bass_pair = names[i] == bass_stem_name or names[j] == bass_stem_name
            kernel = _INTERVAL_KERNEL_BASS if bass_pair else _INTERVAL_KERNEL
            for p in nz_p:
                for q in nz_q:
                    k = 0.0 if (p in tones and q in tones) else kernel[p, q]
                    acc += ci[p] * cj[q] * k
    pairwise = acc / (total_mass ** 2)
    bonus = 0.0
    if bass_pc is not None and bass_stem_name in stem_chromas:
        bc = stem_chromas[bass_stem_name]
        for p in range(12):
            if bc[p] <= 0:
                continue
            d = min((p - bass_pc) % 12, (bass_pc - p) % 12)
            if d == 1:
                bonus += bc[p] * BASS_ROOT_SEMITONE_WEIGHT
        bonus /= total_mass
    return pairwise + bonus, total_mass


def consonance_v1_ported(stem_chromas: dict[str, np.ndarray], chord_tones_pc: list[int], bass_pc: int | None, bass_stem_name: str | None) -> float:
    """Sec 2.6's `consonance_v1'` for ONE combined per-stem chroma vector per stem (e.g. a whole
    span's summed chroma, when no per-beat breakdown is available). Prefer
    `consonance_v1_ported_per_beat` when per-beat activations are available (check.py itself
    computes clash per BEAT, then averages across beats weighted by beat mass -- summing a whole
    span's beats into one chroma vector first, as this function does, conflates notes that never
    actually sounded together within the same beat, which can bias the result; see
    `objective_v2_for_span`'s docstring)."""
    clash, total_mass = _beat_clash(stem_chromas, chord_tones_pc, bass_pc, bass_stem_name)
    if total_mass <= 1e-9:
        return 100.0
    return 100.0 * (1.0 - min(1.0, clash))


def consonance_v1_ported_per_beat(stem_beat_chromas: dict[str, np.ndarray], chord_tones_pc: list[int], bass_pc: int | None, bass_stem_name: str | None) -> float:
    """Sec 2.6's `consonance_v1'`, computed the way `check.py`'s `evaluate` actually does it: one
    `beat_clash` per BEAT (only pitch classes that actually sound together in that beat interact),
    then the mass-weighted mean across the span's beats -- mirroring `np.average(beat_scores,
    weights=beat_weight)`. `stem_beat_chromas[name]` is `(n_beats_in_span, 12)`."""
    names = list(stem_beat_chromas)
    n_beats = next(iter(stem_beat_chromas.values())).shape[0] if names else 0
    clashes, masses = [], []
    for b in range(n_beats):
        beat_chromas = {name: stem_beat_chromas[name][b] for name in names}
        clash, mass = _beat_clash(beat_chromas, chord_tones_pc, bass_pc, bass_stem_name)
        clashes.append(clash)
        masses.append(mass)
    total_mass = sum(masses)
    if total_mass <= 1e-9:
        return 100.0
    mean_clash = float(np.average(clashes, weights=masses))
    return 100.0 * (1.0 - min(1.0, mean_clash))


def check_span_guards(combined: np.ndarray, chord_tones_pc: list[int], heard: dict | None) -> tuple[list[str], float]:
    """Sec 2.6's anti-gaming guards for one span, factored out of `objective_v2_for_span` so they
    can be unit-tested directly against a hand-built `heard`/activation without needing the
    root/quality recognizer to agree (a sufficiently loud extension can itself change what
    `recognise_chord_full` calls the best-fitting quality -- see
    `test_extension_guard_fires_on_a_dominant_extension`): the coverage guard (every written chord
    tone >= `COVERAGE_MIN_SHARE` of the span's tonal energy) and the extension guard (a heard
    extension carrying > `EXTENSION_GUARD_SHARE` of the span's mass -- "a 9th louder than the
    chord is not colour"). Returns `(violations, guard_penalty)`."""
    total = float(combined.sum())
    violations: list[str] = []
    guard_penalty = 0.0
    if total > 0 and chord_tones_pc:
        chroma = fold_activation_to_chroma(combined)
        share_total = chroma.sum()
        if share_total > 0:
            shares = chroma / share_total
            for t in chord_tones_pc:
                if shares[t] < COVERAGE_MIN_SHARE:
                    violations.append(f"chord tone {NAMES[t]} is only {shares[t] * 100:.1f}% of the tonal energy")
                    guard_penalty += COVERAGE_GUARD_PENALTY
    if heard and heard["extensions"] and total > 0:
        ext_pc = (NAMES.index(heard["root"]) + EXTENSION_TONE[heard["extensions"][0]]) % 12
        chroma = fold_activation_to_chroma(combined)
        if chroma.sum() > 0 and chroma[ext_pc] / chroma.sum() > EXTENSION_GUARD_SHARE:
            violations.append(f"extension {heard['extensions'][0]} carries {chroma[ext_pc] / chroma.sum() * 100:.0f}% of the span's mass")
            guard_penalty += EXTENSION_GUARD_PENALTY
    return violations, guard_penalty


def objective_v2_for_span(stem_activations: dict[str, np.ndarray], chord_tones_pc: list[int], written_root_pc: int | None,
                           written_quality: str | None, written_bass_pc: int | None, bass_stem_name: str | None,
                           notes_prev: list[int] | None, key_scale_pcs: set[int] | None = None,
                           tonal_mass_floor: float | None = None, stem_beat_activations: dict[str, np.ndarray] | None = None) -> dict:
    """One span's `consonance_v1'`, `Q`, guards and `objective_v2 = consonance_v1' - guards +
    10*Q` (sec 2.5, 2.6). `stem_activations` is each stem's activation SUMMED over the span's
    beats (drives chord recognition, the guards, and `Q`, per sec 2.4's "sum the stems' A_beat").
    `stem_beat_activations`, when given, is each stem's PER-BEAT activation for the span
    (`(n_beats, N_SEMITONES)`) and is used instead for `consonance_v1'` -- `check.py`'s
    `beat_clash` is computed one beat at a time and then mass-averaged, not on a whole span's
    notes summed together first (summing first would let two notes that never actually sounded in
    the same beat "clash" against each other). Falls back to the single summed vector when
    `stem_beat_activations` is omitted. `tonal_mass_floor`, when given, gates `Q` to 0 for a
    near-silent span (sec 2.5: "Q is only computed for a span whose beats have tonal mass >= 10%
    of the render's median beat mass")."""
    combined = sum(stem_activations.values()) if stem_activations else np.zeros(N_SEMITONES)
    total = float(combined.sum())
    known_bass_pc = written_bass_pc if bass_stem_name is not None else None
    heard = recognise_chord_full(combined, known_bass_pc)
    violations, guard_penalty = check_span_guards(combined, chord_tones_pc, heard)

    bass_pc_for_kernel = NAMES.index(heard["bass"]) if heard else written_bass_pc
    if stem_beat_activations:
        stem_beat_chromas = {name: np.array([fold_activation_to_chroma(a) for a in beats]) for name, beats in stem_beat_activations.items()}
        consonance = consonance_v1_ported_per_beat(stem_beat_chromas, chord_tones_pc, bass_pc_for_kernel, bass_stem_name)
    else:
        stem_chromas = {name: fold_activation_to_chroma(a) for name, a in stem_activations.items()}
        consonance = consonance_v1_ported(stem_chromas, chord_tones_pc, bass_pc_for_kernel, bass_stem_name)

    starved = tonal_mass_floor is not None and total < tonal_mass_floor
    if heard is None or starved:
        q = {"target": 0.0, "extension": 0.0, "spacing": 1.0, "voice_leading": 1.0, "Q": 0.0}
    else:
        notes_by_stem = {name: notes_from_activation(a) for name, a in stem_activations.items()}
        q = compute_q(heard, written_root_pc, written_quality, written_bass_pc, notes_by_stem, notes_prev, key_scale_pcs)

    objective_v2 = round(consonance - guard_penalty + 10.0 * q["Q"], 4)
    return {
        "heard": heard, "consonance_v1": round(consonance, 4), "guard_violations": violations,
        "guard_penalty": round(guard_penalty, 4), "Q": q, "objective_v2": objective_v2, "mass": total,
    }


def window_objective(span_results: list[dict], span_mass: list[float]) -> dict:
    """Sec 2.6's whole-window `objective_v2 = consonance_v1' - guards + 10*mean(Q)`: the
    mass-weighted mean per-span `consonance_v1'` (mirrors `check.py`'s beat-weighted mean
    clash), guard penalties summed across spans, and `Q_mean` the plain mean of each span's `Q`
    (silent spans, whose `Q` is gated to 0, still count in the mean -- sec 2.5 doesn't exempt
    them from `Q̄`, only from earning `Q` itself)."""
    total_mass = sum(span_mass) or 1.0
    if span_results:
        consonance = sum(r["consonance_v1"] * m for r, m in zip(span_results, span_mass)) / total_mass
    else:
        consonance = 100.0
    guard_penalty = sum(r["guard_penalty"] for r in span_results)
    q_mean = float(np.mean([r["Q"]["Q"] for r in span_results])) if span_results else 0.0
    objective_v1 = max(0.0, consonance - guard_penalty)
    objective_v2 = consonance - guard_penalty + 10.0 * q_mean
    return {
        "consonance_v1": round(consonance, 4), "guard_penalty": round(guard_penalty, 4),
        "Q_mean": round(q_mean, 4), "objective_v1": round(objective_v1, 4), "objective_v2": round(objective_v2, 4),
    }


# --------------------------------------------------------------------------- combined-window analysis (Python `io`, sec 2.7's `io` module reference)

def _pitch_name_to_pc(name: str) -> int:
    from apricity_analyze.theory import PITCH_NAMES

    return PITCH_NAMES.index(name)


def analyze_stems_dir(stems_dir, target_sr: int = SR) -> dict:
    """Reads `stems.json` + every pitched, non-kit track's WAV under `stems_dir`, runs the
    CQT/NNLS pipeline per stem (sec 2.1-2.3), and returns per-span chord recognition, `Q` and
    `objective_v2`, plus the window-level `objective_v2` (sec 2.4-2.6). Mirrors `check.py`'s
    `load_stems`/`evaluate` shape but on this module's octave-aware activations, and prefers the
    score's own bass (`stems.json`'s `events`/`harmony[].bass`, sec 2.3's "ground truth first")
    over any audio-derived guess."""
    import json
    import math
    import pathlib

    import soundfile as sf
    from scipy.signal import resample_poly

    stems_dir = pathlib.Path(stems_dir)
    manifest = json.loads((stems_dir / "stems.json").read_text())
    tempo = manifest["tempo"]
    sample_rate = manifest["sample_rate"]
    offset_beats = manifest["offset_beats"]
    length = manifest["length"]
    spb_frames = sample_rate * 60.0 / tempo
    n_beats = max(1, int(np.ceil(length / spb_frames)))

    def resample(y: np.ndarray, src_sr: int) -> np.ndarray:
        if src_sr == target_sr:
            return y.astype(np.float64)
        g = math.gcd(int(src_sr), int(target_sr))
        return resample_poly(y, target_sr // g, src_sr // g).astype(np.float64)

    events_by_track: dict[str, list[dict]] = {}
    for e in manifest.get("events", []):
        events_by_track.setdefault(e["track"], []).append(e)

    stem_beat_activation: dict[str, np.ndarray] = {}
    for t in manifest["tracks"]:
        if t.get("kit") or not t.get("pitched", True):
            continue
        path = stems_dir / f"{t['name']}.wav"
        if not path.exists():
            continue
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        mono = resample(data.mean(axis=1), sr)
        A = nnls_activations(fold_to_semitones(cqt(mono)))
        times = frame_times(A.shape[1])
        # `times` is relative to THIS render's own audio (frame 0 = sample 0 of the WAV), which
        # starts at the render's first bar, not the score's bar 1 -- so the beat grid here is
        # local (offset 0), even though `offset_beats` (the score's own absolute beat number for
        # this render's first beat) is used below to line up harmony spans and events.
        stem_beat_activation[t["name"]] = beat_aggregate(A, times, tempo, 0.0, n_beats)

    def known_bass_pc_for_beat(b: int, span: dict) -> int | None:
        beat_abs = offset_beats + b
        for evs in events_by_track.values():
            for e in evs:
                if e["start_beat"] <= beat_abs < e["end_beat"]:
                    return int(e["midi"]) % 12
        if span.get("bass"):
            return _pitch_name_to_pc(span["bass"])
        return None

    all_beat_mass = [float(sum(act[b].sum() for act in stem_beat_activation.values())) for b in range(n_beats)]
    median_beat_mass = float(np.median(all_beat_mass)) if all_beat_mass else 0.0
    tonal_mass_floor = 0.10 * median_beat_mass

    spans_out = []
    span_mass = []
    prev_notes: list[int] | None = None
    for span in manifest.get("harmony", []):
        a = max(0, int(round(span["start_beat"] - offset_beats)))
        b = min(n_beats, int(round(span["end_beat"] - offset_beats)))
        if b <= a:
            continue
        chord_tones_pc = [_pitch_name_to_pc(n) for n in span.get("chord_tones", []) if n]
        written_root_pc = chord_tones_pc[0] if chord_tones_pc else None
        written_quality = written_quality_from_tones(written_root_pc, chord_tones_pc) if chord_tones_pc else None
        written_bass_pc = _pitch_name_to_pc(span["bass"]) if span.get("bass") else None

        stem_span_beats = {name: (act[a:b] if b > a else np.zeros((0, N_SEMITONES))) for name, act in stem_beat_activation.items()}
        stem_span_activation = {name: beats.sum(axis=0) if len(beats) else np.zeros(N_SEMITONES) for name, beats in stem_span_beats.items()}

        bass_votes: dict[int, int] = {}
        for beat in range(a, b):
            kb = known_bass_pc_for_beat(beat, span)
            if kb is not None:
                bass_votes[kb] = bass_votes.get(kb, 0) + 1
        bass_stem_name = next((name for name in events_by_track if name in stem_span_activation), None)
        if bass_stem_name is None and stem_span_activation:
            floor_idx = 31 - MIDI_C1
            bass_stem_name = max(stem_span_activation, key=lambda name: float(stem_span_activation[name][: floor_idx + 12].sum()))

        result = objective_v2_for_span(
            stem_span_activation, chord_tones_pc, written_root_pc, written_quality, written_bass_pc,
            bass_stem_name, prev_notes, key_scale_pcs=None, tonal_mass_floor=tonal_mass_floor,
            stem_beat_activations=stem_span_beats,
        )
        notes_now = [n for act in stem_span_activation.values() for n in notes_from_activation(act)]
        prev_notes = notes_now or prev_notes
        result["label"] = span.get("label", "")
        result["bars"] = [span["start_beat"] / manifest["meter"] + 1, span["end_beat"] / manifest["meter"] + 1]
        spans_out.append(result)
        span_mass.append(result["mass"])

    return {"spans": spans_out, "window": window_objective(spans_out, span_mass), "stems": list(stem_beat_activation)}


# --------------------------------------------------------------------------- the steering report (sec 3, Kanbus apricitus-c46688)
#
# `build_steer_report` is the reference `apricity steer <stems dir> [--against written|heard]`
# writes (sec 3.1's schema draft): `analyze_stems_dir`'s per-span chord/Q/objective plus per-stem
# tuning, per-span transposition maps for loop stems (sec 3.2), a wrong-note list (sec 3.3), fit
# regions (sec 3.3), and suggestions mapped to optimizer ops (sec 3.4). `apricity-harmony::steer`
# is a direct port; its own docstring notes the same simplifications as this module's.

REGION_FIT_Q = 0.6
REGION_FIT_CLASH = 0.10
TUNING_CORRECTION_THRESHOLD_CENTS = 8.0  # matches check.py's tuning guard threshold
STEER_TRANSPOSE_MARGIN_DQ = 0.2  # sec 3.2's proposed margin: only suggest a shift that clearly beats the solver's

DEGREE_NAMES = {0: "root", 1: "b2", 2: "2nd", 3: "b3", 4: "3rd", 5: "4th", 6: "b5", 7: "5th", 8: "#5", 9: "6th", 10: "b7", 11: "7th"}


def _hz_for_midi(midi: int, tune: float = 440.0) -> float:
    """Equal-tempered Hz for a MIDI note number at the given reference (sec 3.3)."""
    return tune * 2.0 ** ((midi - 69) / 12.0)


def wrong_notes_for_span(stem_span_activation: dict[str, np.ndarray], target_root_pc: int | None,
                          target_tones_pc: set[int], target_label: str, stem_cents: dict[str, float],
                          bars: list[float]) -> list[dict]:
    """Sec 3.3's `wrong_notes`: per stem, the extracted notes (`notes_from_activation`) whose
    pitch class isn't in `target_tones_pc` (the written chord's tones, or the heard chord's when
    the caller passed `--against heard`), with octave, equal-tempered Hz, a cents figure, share
    of the stem's span mass, and the span's own bar range.

    `cents` is the STEM's own tuning offset (sec 2.2), not a per-note fit: Phase 1 only fits
    tuning once per stem (`cents_offset`, over the whole rendered stem), not per extracted note,
    since that needs the note's own frame range re-isolated from the beat-aggregated activation
    this function receives -- a real simplification against sec 3.3's "the note's measured
    cents", correct for a uniformly-tuned stem (a pinned single-pitch clip, or a loop with one
    consistent room/player tuning) and left as future work for a stem whose individual notes
    drift independently.

    Sorted by share x the pitch class's distance-from-root weight (`target_root_pc`, when given)
    so a root/bass-adjacent wrong note -- the one likeliest to read as a different chord entirely
    -- sorts first, matching sec 3.3's "root/bass semitone first"."""
    out = []
    for stem, activation in stem_span_activation.items():
        total = float(activation.sum())
        if total <= 0:
            continue
        for midi in notes_from_activation(activation):
            pc = midi % 12
            if pc in target_tones_pc:
                continue
            idx = midi - MIDI_C1
            share = float(activation[idx]) / total if 0 <= idx < len(activation) else 0.0
            degree = DEGREE_NAMES[(pc - target_root_pc) % 12] if target_root_pc is not None else "?"
            weight = 1.0 if target_root_pc is None else (2.0 if (pc - target_root_pc) % 12 in (1, 11) else 1.0)
            out.append({
                "stem": stem, "note": semitone_name(midi), "midi": int(midi),
                "hz": round(_hz_for_midi(midi), 1), "cents": round(stem_cents.get(stem, 0.0), 1),
                "share": round(share, 3), "beats": list(bars),
                "against": target_label, "reason": f"{degree} of {target_label}",
                "_sort": share * weight,
            })
    out.sort(key=lambda w: -w["_sort"])
    for w in out:
        del w["_sort"]
    return out


def steer_regions(spans: list[dict]) -> dict:
    """Sec 3.3's `regions`: spans with `Q >= REGION_FIT_Q` and `clash <= REGION_FIT_CLASH` are
    `fit`; contiguous fit (or unfit) spans -- adjacent bar ranges, in score order -- are merged
    into bar ranges. `spans` are steer-report span dicts, each carrying `bars` and its own
    `Q`/`clash`."""
    fit: list[list[float]] = []
    unfit: list[list[float]] = []
    cur_is_fit: bool | None = None
    cur_range: list[float] | None = None
    for sp in spans:
        is_fit = sp["Q"]["Q"] >= REGION_FIT_Q and sp["clash"] <= REGION_FIT_CLASH
        bars = sp["bars"]
        bucket = fit if is_fit else unfit
        if cur_range is not None and cur_is_fit == is_fit and cur_range[1] == bars[0]:
            cur_range[1] = bars[1]
        else:
            cur_range = [bars[0], bars[1]]
            bucket.append(cur_range)
            cur_is_fit = is_fit
    return {"fit": fit, "unfit": unfit}


def steer_suggestions(spans: list[dict], stems: dict[str, dict]) -> list[dict]:
    """Sec 3.4's suggestions, ranked by projected gain (`expected_dQ`, falling back to a fixed
    priority for ops that don't project a `Q` delta). Three of the table's rows are generated
    here in Phase 1 (`track.transpose_span`, `track.eq_notch`, `clip.retune`); `track.harmonic`
    is P2 (sec 3.4's own table) and `track.hp`/`track.bars` need a register/arrangement judgement
    this analytic pass doesn't make on its own, so they're left for the agent/optimizer loop to
    propose from the report's `wrong_notes`/`regions` rather than auto-suggested here."""
    suggestions: list[dict] = []

    for sp in spans:
        # A span whose chord already reads well (`Q >= REGION_FIT_Q`, the same threshold
        # `steer_regions` uses for "fits") isn't worth re-transposing even when the analytic map
        # prefers a different shift by more than the margin: the map's score (`chord_match_score`,
        # sec 3.2) is a cheaper proxy for `Q` and can disagree with it on a span that's already a
        # good, complete chord (voice_leading/spacing/extension credit the proxy doesn't see) --
        # suggesting a change there would fix a problem the span doesn't actually have.
        if sp["Q"]["Q"] >= REGION_FIT_Q:
            continue
        tmap = sp.get("transposition_map") or {}
        for stem, shifts in tmap.items():
            if not shifts:
                continue
            solver_shift = sp.get("solver_shift", {}).get(stem)
            best_shift = max(shifts, key=lambda k: shifts[k])
            best_score = shifts[best_shift]
            baseline_shift = solver_shift if solver_shift is not None else 0
            baseline_score = shifts.get(baseline_shift, best_score)
            if best_shift == baseline_shift:
                continue
            d_q = best_score - baseline_score
            if d_q < STEER_TRANSPOSE_MARGIN_DQ:
                continue
            suggestions.append({
                "op": "track.transpose_span", "track": stem, "bars": list(sp["bars"]),
                "value": int(best_shift), "expected_dQ": round(d_q, 3), "expected_dclash": None,
                "why": f"the loop's own notes at {best_shift:+d} st score {best_score:.2f} against "
                       f"{sp['label']} vs {baseline_score:.2f} at the solver's {baseline_shift:+d}",
            })

    for sp in spans:
        wrong = sp.get("wrong_notes") or []
        if wrong:
            top = wrong[0]
            suggestions.append({
                "op": "track.eq_notch", "track": top["stem"], "hz": top["hz"], "gain": -9, "q": 12,
                "bars": list(sp["bars"]), "expected_dQ": None,
                "why": f"{top['note']} is the loudest non-chord note under {sp['label']}",
            })

    for name, info in stems.items():
        cents = info.get("cents", 0.0)
        if info.get("kind") == "pitched" and abs(cents) > TUNING_CORRECTION_THRESHOLD_CENTS:
            suggestions.append({
                "op": "clip.retune", "clip": name, "cents": round(-cents, 1), "expected_dQ": None,
                "why": f"pinned root reads {cents:+.0f} c {'sharp' if cents > 0 else 'flat'}",
            })

    suggestions.sort(key=lambda s: -(s["expected_dQ"] if s.get("expected_dQ") is not None else 0.05))
    for s in suggestions:
        if s.get("expected_dQ") is None:
            s.pop("expected_dQ", None)
    return suggestions


def build_steer_report(stems_dir, against: str = "written", target_sr: int = SR) -> dict:
    """`apricity steer <stems dir> [--against written|heard]`'s output, matching sec 3.1's
    `apricity.steer/1` schema. Runs the same CQT/NNLS/chord/Q pipeline `analyze_stems_dir` does
    (this function calls it for the per-span heard/Q/objective numbers) and, separately, re-walks
    the per-stem beat activations to build the transposition map and wrong-note list sec 3.1-3.3
    need -- a second, cheap CQT/NNLS pass over the same stems rather than threading extra return
    values through `analyze_stems_dir`'s existing (and already Rust-ported) contract. A later pass
    can merge the two if the duplication matters in practice; Phase 1 keeps `analyze_stems_dir`'s
    signature untouched so its own callers and fixtures don't move."""
    import json
    import math
    import pathlib

    import soundfile as sf
    from scipy.signal import resample_poly

    stems_dir = pathlib.Path(stems_dir)
    manifest = json.loads((stems_dir / "stems.json").read_text())
    base = analyze_stems_dir(stems_dir, target_sr=target_sr)

    def resample(y: np.ndarray, src_sr: int) -> np.ndarray:
        if src_sr == target_sr:
            return y.astype(np.float64)
        g = math.gcd(int(src_sr), int(target_sr))
        return resample_poly(y, target_sr // g, src_sr // g).astype(np.float64)

    tempo = manifest["tempo"]
    meter = manifest["meter"]
    offset_beats = manifest["offset_beats"]
    sample_rate = manifest["sample_rate"]
    length = manifest["length"]
    spb_frames = sample_rate * 60.0 / tempo
    n_beats = max(1, int(np.ceil(length / spb_frames)))

    pitched_pitch = {t["name"]: t["pitch"] for t in manifest["tracks"] if t.get("pitch")}

    stem_beat_activation: dict[str, np.ndarray] = {}
    stem_cents: dict[str, float] = {}
    for t in manifest["tracks"]:
        if t.get("kit") or not t.get("pitched", True):
            continue
        path = stems_dir / f"{t['name']}.wav"
        if not path.exists():
            continue
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        mono = resample(data.mean(axis=1), sr)
        stem_cents[t["name"]] = cents_offset(mono)
        A = nnls_activations(fold_to_semitones(cqt(mono)))
        times = frame_times(A.shape[1])
        stem_beat_activation[t["name"]] = beat_aggregate(A, times, tempo, 0.0, n_beats)

    stems_out: dict[str, dict] = {}
    for name, act in stem_beat_activation.items():
        cents = round(float(stem_cents.get(name, 0.0)), 1)
        if name in pitched_pitch:
            stems_out[name] = {"kind": "pitched", "pitch": pitched_pitch[name], "cents": cents}
        else:
            # `cents_spread` (sec 3.1's schema) needs a per-note tuning fit; Phase 1 only fits one
            # offset per stem (`cents_offset`, above), so it's reported as 0 rather than omitted.
            stems_out[name] = {"kind": "loop", "cents": cents, "cents_spread": 0.0}

    loop_names = [n for n in stem_beat_activation if n not in pitched_pitch]

    # `base["spans"]` (from `analyze_stems_dir`, above) already dropped every harmony span outside
    # this render's own beat window (its loop's `if b <= a: continue`, sec 2.3's window slicing).
    # Re-deriving `a`/`b` below needs the SAME filtered list in the SAME order -- zipping against
    # the raw `manifest["harmony"]` (every span of the whole piece, most of them outside this
    # window) would pair `base["spans"][0]` with the wrong span and read a negative `b`.
    def in_window(span: dict) -> bool:
        a = max(0, int(round(span["start_beat"] - offset_beats)))
        b = min(n_beats, int(round(span["end_beat"] - offset_beats)))
        return b > a

    filtered_harmony = [span for span in manifest.get("harmony", []) if in_window(span)]

    spans_out = []
    for base_span, span in zip(base["spans"], filtered_harmony):
        a = max(0, int(round(span["start_beat"] - offset_beats)))
        b = min(n_beats, int(round(span["end_beat"] - offset_beats)))
        bars = base_span["bars"]
        chord_tones_pc = [_pitch_name_to_pc(n) for n in span.get("chord_tones", []) if n]
        written_root_pc = chord_tones_pc[0] if chord_tones_pc else None
        written_tones_pc = set(chord_tones_pc)
        heard = base_span.get("heard")

        if against == "heard" and heard:
            target_root_pc = NAMES.index(heard["root"])
            target_tones_pc = {(target_root_pc + iv) % 12 for iv in QUALITIES.get(heard["quality"], [0, 4, 7])}
            target_label = f"heard {heard['root']}{heard['quality']}"
        else:
            target_root_pc = written_root_pc
            target_tones_pc = written_tones_pc
            target_label = f"written {span.get('label', '')}".strip()

        stem_span_activation = {name: (act[a:b].sum(axis=0) if b > a else np.zeros(N_SEMITONES)) for name, act in stem_beat_activation.items()}
        # Sec 2.3's "ground truth first": a pinned/pitched single-note track's sounding pitch is
        # known exactly from the compiled timeline, so it never gets a `wrong_notes` entry (its
        # own tuning still earns a `clip.retune` suggestion, from `stems_out` below) -- only the
        # audio-analysed loop stems are checked against the chord.
        loop_span_activation = {name: a for name, a in stem_span_activation.items() if name not in pitched_pitch}
        wrong_notes = wrong_notes_for_span(loop_span_activation, target_root_pc, target_tones_pc, target_label, stem_cents, bars)

        tmap: dict[str, dict[int, float]] = {}
        for stem in loop_names:
            span_act = stem_span_activation.get(stem)
            if span_act is None or span_act.sum() <= 0:
                continue
            other = sum((v for name, v in stem_span_activation.items() if name != stem), np.zeros(N_SEMITONES))
            m = transposition_map(span_act, other, written_root_pc if written_root_pc is not None else 0,
                                   written_quality_from_tones(written_root_pc or 0, chord_tones_pc) or "", target_bass_pc=None)
            tmap[stem] = {int(k): round(float(v), 3) for k, v in m.items()}

        clash = round(1.0 - base_span["consonance_v1"] / 100.0, 4)
        spans_out.append({
            **base_span, "bars": bars, "clash": clash, "wrong_notes": wrong_notes,
            "transposition_map": tmap, "solver_shift": {}, "fits": base_span["Q"]["Q"] >= REGION_FIT_Q and clash <= REGION_FIT_CLASH,
        })

    regions = steer_regions(spans_out)
    suggestions = steer_suggestions(spans_out, stems_out)

    bars_range = [manifest["harmony"][0]["start_beat"] / meter + 1, manifest["harmony"][-1]["end_beat"] / meter + 1] if manifest.get("harmony") else [1, 1]
    return {
        "schema": "apricity.steer/1",
        "render": {"stems_dir": str(stems_dir), "bars": bars_range, "tempo": tempo, "meter": meter, "key": manifest.get("key")},
        "objective": {
            "v1": base["window"]["objective_v1"], "v2": base["window"]["objective_v2"],
            "consonance": base["window"]["consonance_v1"], "guards": [v for sp in spans_out for v in sp.get("guard_violations", [])],
            "Q_mean": base["window"]["Q_mean"],
        },
        "stems": stems_out,
        "spans": spans_out,
        "regions": regions,
        "suggestions": suggestions,
    }
