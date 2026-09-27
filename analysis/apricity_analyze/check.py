"""Harmony/interval-clash checker for a `--stems` render (Phase 1 of the harmony checker).

`apricity render --stems DIR` writes one 32-bit float WAV per track (soloed through its group
and sends, as heard, pre-master), `mix.wav`, and `stems.json` (the score's own tempo/meter/key,
harmony spans and per-track routing). This module measures how much concurrent stems clash, on
the score's own beat grid (no beat tracking needed, and `offset_beats` fixes up a `--bars`
render's alignment), and reports one 0-100 objective plus guards and per-span, per-stem findings.

The chord-tone-share objective (`scripts/check-render.py`) scores a stem playing the chord's own
maj7 a semitone under the bass as "on chord" -- it can't see that a minor 2nd is the harshest
interval there is. This checker scores *interval clashes* between concurrently sounding stems,
weighted by loudness and "tonalness" (so a hi-hat's noise doesn't count as much as a held pad),
with a bass track's minor/major 2nds and major 7ths counted doubly harsh.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import pathlib

import numpy as np

from .analyze import FRAME, HOP, SR
from .theory import PITCH_NAMES

# --------------------------------------------------------------------------- constants

# Interval-clash weight by the raw |semitone distance| 0..11 between two pitch classes (spec).
#           u     m2    M2    m3   M3    P4    tt    P5   m6    M6    m7    M7
INTERVAL_K = [0.0, 1.00, 0.35, 0.0, 0.0, 0.05, 0.70, 0.0, 0.05, 0.0, 0.30, 1.00]

# A bass stem's minor 2nd, major 2nd or major 7th against another stem counts double: the
# harshest kind of clash a bass note can make (e.g. a maj7 pad held a semitone above the root).
DOUBLED_AGAINST_BASS = (1, 2, 11)

BASS_HZ = 250.0             # a stem is "bass" when more than half its energy sits below this
BASS_LOW_ENERGY_SHARE = 0.5

CHORD_ROOT_OR_BASS_SEMITONE = 1.0   # a non-chord tone a semitone from the root or the sounding bass note
CHORD_OTHER_TONE_SEMITONE = 0.6     # a semitone from some other chord tone
CHORD_TRITONE_ROOT = 0.7            # a tritone from the root
CHORD_OTHER = 0.25                  # anything else off-chord
OUT_OF_KEY_MULT = 1.3               # multiplies the above when the tone is also out of key

ENERGY_SECTION_BEATS = 16.0   # 4 bars of 4/4; scaled by meter/4 for other meters
ENERGY_GUARD_DB = 3.0
MUTE_GUARD_DB = 6.0
DENSITY_GUARD_STEMS = 1
COVERAGE_MIN_SHARE = 0.05
COVERAGE_ENTROPY_GUARD_BITS = 0.5
TUNING_GUARD_CENTS = 8.0

SMEAR_WINDOW_S = 0.4

# Rough diatonic scales for the modes the DSL supports, as semitone offsets from the tonic.
_MODE_STEPS = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "ionian": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "aeolian": [0, 2, 3, 5, 7, 8, 10],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "phrygian": [0, 1, 3, 5, 7, 8, 10],
    "lydian": [0, 2, 4, 6, 7, 9, 11],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "locrian": [0, 1, 3, 5, 6, 8, 10],
}

_INTERVAL_KERNEL = np.array([[INTERVAL_K[abs(p - q)] for q in range(12)] for p in range(12)])
_INTERVAL_KERNEL_BASS = _INTERVAL_KERNEL.copy()
for _p in range(12):
    for _q in range(12):
        if abs(_p - _q) in DOUBLED_AGAINST_BASS:
            _INTERVAL_KERNEL_BASS[_p, _q] *= 2.0


def key_scale(key: str) -> set[int] | None:
    """Pitch classes (0=C) in `key`'s scale, e.g. "F mixolydian" or "Bb major". `None` when the
    mode isn't recognized (the out-of-key multiplier is then skipped, not guessed at)."""
    parts = key.strip().split()
    if len(parts) < 2:
        return None
    tonic_name, mode = parts[0], parts[1].lower()
    steps = _MODE_STEPS.get(mode)
    if steps is None or tonic_name not in PITCH_NAMES:
        return None
    tonic = PITCH_NAMES.index(tonic_name)
    return {(tonic + s) % 12 for s in steps}


# --------------------------------------------------------------------------- per-frame features

def chroma_frames(audio: np.ndarray) -> np.ndarray:
    """Per-frame HPCP (rotated so C is bin 0), the same settings as `analyze.tonal` -- factored
    out so both work off one definition of "chroma". `audio` is mono float32/float64 at `SR`."""
    import essentia.standard as es

    audio = np.ascontiguousarray(audio, dtype=np.float32)
    window, spectrum = es.Windowing(type="blackmanharris62"), es.Spectrum()
    peaks = es.SpectralPeaks(orderBy="magnitude", magnitudeThreshold=1e-5, minFrequency=40, maxFrequency=5000, maxPeaks=60, sampleRate=SR)
    hpcp = es.HPCP(size=12, referenceFrequency=440.0, harmonics=8, bandPreset=True, minFrequency=40, maxFrequency=5000,
                   weightType="cosine", nonLinear=False, windowSize=1.0, sampleRate=SR)
    frames = [hpcp(*peaks(spectrum(window(f)))) for f in es.FrameGenerator(audio, frameSize=FRAME, hopSize=HOP, startFromZero=True)]
    return np.roll(np.array(frames), 9, axis=1) if frames else np.zeros((0, 12))


def frame_times(n_frames: int) -> np.ndarray:
    return (np.arange(n_frames) * HOP + FRAME / 2) / SR


def frame_rms(audio: np.ndarray) -> np.ndarray:
    import librosa

    return librosa.feature.rms(y=np.ascontiguousarray(audio, dtype=np.float32), frame_length=FRAME, hop_length=HOP, center=True)[0]


TONALNESS_MIN_HZ = 40.0


def frame_tonalness(audio: np.ndarray) -> np.ndarray:
    """1 - spectral flatness, computed only on bins at or above `TONALNESS_MIN_HZ`: near 1 for a
    tone, near 0 for noise (a hi-hat), so percussion counts little in the chroma weighting.

    Below ~40 Hz a real recording often carries DC drift, mic rumble or sub-sonic hum that has
    nothing to do with the note itself; folding those bins into the flatness estimate (as
    `librosa.feature.spectral_flatness` does over the whole spectrum) inflates the measured
    flatness for a low, sustained, genuinely tonal stem (a bass), discounting exactly the material
    the harmony checker most needs to weight correctly. Excluding that band fixes it without
    touching the chroma or RMS weighting, which still see the full spectrum/signal."""
    import librosa

    audio = np.ascontiguousarray(audio, dtype=np.float32)
    spec = np.abs(librosa.stft(audio, n_fft=FRAME, hop_length=HOP, center=True)) + 1e-12
    freqs = librosa.fft_frequencies(sr=SR, n_fft=FRAME)
    band = spec[freqs >= TONALNESS_MIN_HZ, :]
    geometric_mean = np.exp(np.mean(np.log(band), axis=0))
    arithmetic_mean = np.mean(band, axis=0)
    flat = geometric_mean / arithmetic_mean
    return 1.0 - np.clip(flat, 0.0, 1.0)


def is_bass(audio: np.ndarray) -> bool:
    """True when more than half of a stem's spectral energy sits below `BASS_HZ`."""
    import scipy.signal

    audio = np.asarray(audio, dtype=np.float64)
    if audio.size == 0 or not np.any(audio):
        return False
    nperseg = min(8192, len(audio))
    if nperseg < 16:
        return False
    f, pxx = scipy.signal.welch(audio, fs=SR, nperseg=nperseg)
    total = pxx.sum()
    if total <= 0:
        return False
    return bool(pxx[f < BASS_HZ].sum() / total > BASS_LOW_ENERGY_SHARE)


# --------------------------------------------------------------------------- per-stem, per-beat data

@dataclasses.dataclass
class Stem:
    name: str
    pitched: bool
    kit: str | None
    bass: bool
    # Per beat (index 0 = the render's first beat, i.e. `offset_beats` in the score): a 12-vector
    # of chroma energy weighted by loudness and tonalness (not normalized -- summing it across
    # beats/stems is meaningful), and a scalar RMS energy in dBFS for the level guards.
    chroma: np.ndarray   # (n_beats, 12)
    energy_db: np.ndarray  # (n_beats,)
    mono: np.ndarray     # the raw mono audio, for tuning/leave-one-out
    # A pitched, single-note track's clip pitch with octave, e.g. "A1 (heard)" (from
    # `TrackInfo::pitch`, via stems.json): the score's own "this is the bass" signal, since a
    # loop (harmony-solver `voice`) or a kit carries no single octave. `None` otherwise.
    pitch: str | None = None


def octave_of(pitch: str | None) -> int | None:
    """The octave number in a pitch string like "A1 (heard)" or "Bb2 (pinned)", or `None` when
    `pitch` doesn't look like one (or is itself `None`)."""
    if not pitch:
        return None
    import re

    m = re.match(r"[A-Ga-g](#|b)?(-?\d+)", pitch.strip())
    return int(m.group(2)) if m else None


def choose_bass(stems: list["Stem"]) -> "Stem | None":
    """Which stem is "the bass" for chord-clash purposes. Prefers the score's own signal (a
    pitched, single-note track's octave -- the lowest one wins); falls back to the acoustic
    `is_bass` heuristic restricted to pitched, non-kit stems (a full loop or a kick drum can have
    plenty of energy under 250 Hz too, without being what a listener would call "the bass")."""
    with_octave = [(octave_of(s.pitch), s) for s in stems]
    with_octave = [(o, s) for o, s in with_octave if o is not None]
    if with_octave:
        return min(with_octave, key=lambda pair: pair[0])[1]
    return next((s for s in stems if s.bass and s.pitched and s.kit is None), next((s for s in stems if s.bass), None))


def analyze_stem(name: str, mono: np.ndarray, tempo: float, n_beats: int, *, pitched: bool, kit: str | None, pitch: str | None = None) -> Stem:
    chroma = chroma_frames(mono)
    times = frame_times(len(chroma))
    rms = frame_rms(mono)[: len(chroma)]
    tonalness = frame_tonalness(mono)[: len(chroma)]
    weight = rms * tonalness
    spb = 60.0 / tempo
    beat_chroma = np.zeros((n_beats, 12))
    beat_energy = np.full(n_beats, -120.0)
    for b in range(n_beats):
        sel = (times >= b * spb) & (times < (b + 1) * spb)
        if sel.any():
            beat_chroma[b] = (chroma[sel] * weight[sel, None]).sum(axis=0)
            e = float(np.sqrt(np.mean(rms[sel] ** 2))) if sel.any() else 0.0
            beat_energy[b] = 20 * np.log10(e + 1e-9)
    return Stem(name=name, pitched=pitched, kit=kit, bass=is_bass(mono), chroma=beat_chroma, energy_db=beat_energy, mono=mono, pitch=pitch)


# --------------------------------------------------------------------------- clash kernel

def pair_clash(ci: np.ndarray, cj: np.ndarray, bass_pair: bool) -> float:
    """Sum_p,q c_i[p]*c_j[q]*K[|p-q|], doubled on m2/M2/M7 when either stem is the bass."""
    kernel = _INTERVAL_KERNEL_BASS if bass_pair else _INTERVAL_KERNEL
    return float(ci @ kernel @ cj)


def chord_clash_terms(c: np.ndarray, chord_tones: list[int], bass_pc: int | None, scale: set[int] | None) -> dict[int, float]:
    """Per-pitch-class contributions to `chord_clash`: `{pitch_class: weighted_penalty}` for every
    *non-chord-tone* pitch class present in `c` (a chord tone, including the root, is never a key
    here -- it can't be "off-chord" by definition, so a caller that wants "which pitch class is
    this stem's worst off-chord note" can safely take `max(terms, key=terms.get)`)."""
    total = c.sum()
    if total <= 0 or not chord_tones:
        return {}
    root = chord_tones[0]
    bass_pc = bass_pc if bass_pc is not None else root
    terms: dict[int, float] = {}
    for p in range(12):
        w = c[p] / total
        if w <= 0 or p in chord_tones:
            continue
        d_root = min((p - root) % 12, (root - p) % 12)
        d_bass = min((p - bass_pc) % 12, (bass_pc - p) % 12)
        d_other = min((min((p - t) % 12, (t - p) % 12) for t in chord_tones if t != root), default=99)
        if d_root == 1 or d_bass == 1:
            penalty = CHORD_ROOT_OR_BASS_SEMITONE
        elif d_other == 1:
            penalty = CHORD_OTHER_TONE_SEMITONE
        elif d_root == 6:
            penalty = CHORD_TRITONE_ROOT
        else:
            penalty = CHORD_OTHER
        if scale is not None and p not in scale:
            penalty *= OUT_OF_KEY_MULT
        terms[p] = w * penalty
    return terms


def chord_clash(c: np.ndarray, chord_tones: list[int], bass_pc: int | None, scale: set[int] | None) -> float:
    """One stem's clash against the chord: for each non-chord-tone pitch class, its share of the
    stem's tonal mass times a penalty (root/bass semitone worst, then another chord tone's
    semitone, then a tritone from the root, else a flat rate), amplified when also out of key."""
    return sum(chord_clash_terms(c, chord_tones, bass_pc, scale).values())


# A bass note a semitone from the chord's root is, on its own, one of the biggest possible
# clashes (the Ave House bug this checker was built to catch: a "clean low A" bass sitting under
# B-flat major 7, a semitone under the root). `pair_clash`/`beat_clash` weight every interval by
# the *product* of two stems' shares and then divide by the squared total tonal mass, which can
# dilute this particular clash into the noise floor when other stems are also playing. This term
# is added on top, using the bass's own (undiluted) mass and a single division by the total mass
# -- not squared -- so it isn't swamped the same way.
BASS_ROOT_SEMITONE_WEIGHT = 1.0


def bass_root_penalty(bass_chroma: np.ndarray, root_pc: int) -> float:
    """Raw (unnormalized) penalty for the bass stem's own chroma sitting a semitone from the
    chord's root: `sum(bass_chroma[p] for p a semitone from root) * BASS_ROOT_SEMITONE_WEIGHT`."""
    pen = 0.0
    for p in range(12):
        mass = bass_chroma[p]
        if mass <= 0:
            continue
        d = min((p - root_pc) % 12, (root_pc - p) % 12)
        if d == 1:
            pen += mass * BASS_ROOT_SEMITONE_WEIGHT
    return pen


def beat_clash(stems: list[Stem], beat: int, root_pc: int | None = None) -> float:
    """The loudness-weighted mean pairwise clash among stems sounding at `beat`, normalized by
    the squared total tonal mass so turning everything down doesn't lower the score, plus the
    (much less diluted) bass-vs-root term when `root_pc` is given. Unpitched stems (a drum kit's
    pads, a re-pitched one-shot outside the harmony) don't take part: chroma/HPCP reads a kick's
    decaying thump as a pitch just as readily as a real note, so without this a kick can dominate
    the clash score and the leave-one-out ranking without actually being harmonic material."""
    vecs = [(s, s.chroma[beat]) for s in stems if beat < len(s.chroma) and s.pitched]
    total_mass = sum(v.sum() for _, v in vecs)
    if total_mass <= 1e-9:
        return 0.0
    acc = 0.0
    for i in range(len(vecs)):
        si, ci = vecs[i]
        for j in range(i + 1, len(vecs)):
            sj, cj = vecs[j]
            acc += pair_clash(ci, cj, si.bass or sj.bass)
    pairwise = acc / (total_mass ** 2)
    bonus = 0.0
    if root_pc is not None:
        bonus = sum(bass_root_penalty(ci, root_pc) for si, ci in vecs if si.bass) / total_mass
    return pairwise + bonus


# --------------------------------------------------------------------------- manifest / loading

def load_stems(stems_dir: pathlib.Path) -> tuple[dict, list[Stem]]:
    """Read `stems.json` and every `<track>.wav`, and compute each stem's per-beat features."""
    import soundfile as sf

    manifest = json.loads((stems_dir / "stems.json").read_text())
    tempo = manifest["tempo"]
    length = manifest["length"]
    spb_frames = manifest["sample_rate"] * 60.0 / tempo
    n_beats = max(1, int(np.ceil(length / spb_frames)))

    stems = []
    for t in manifest["tracks"]:
        path = stems_dir / f"{t['name']}.wav"
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        if sr != SR:
            import soxr

            mono = soxr.resample(mono, sr, SR)
        stems.append(analyze_stem(t["name"], mono, tempo, n_beats, pitched=t.get("pitched", True), kit=t.get("kit"), pitch=t.get("pitch")))
    return manifest, stems


# --------------------------------------------------------------------------- objective + guards

@dataclasses.dataclass
class SpanFinding:
    start_bar: float
    end_bar: float
    label: str
    clash: float
    detail: str


@dataclasses.dataclass
class Report:
    consonance: float
    objective: float
    penalties: dict[str, float]
    guard_violations: list[str]
    worst_spans: list[SpanFinding]
    leave_one_out: list[tuple[str, float]]
    on_chord: dict[str, float]
    off_key: dict[str, float]
    smear: dict[str, float]
    loop_wrap: float
    baseline: dict | None
    # min/median/max clash across *every* harmony span, not just the (often narrow) top of
    # `worst_spans` -- a top-N list alone can look "flat" simply because it's selecting from the
    # high end, even when the piece's spans actually range from silent to dissonant.
    span_clash_spread: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def to_json(self) -> dict:
        d = dataclasses.asdict(self)
        d["worst_spans"] = [dataclasses.asdict(s) for s in self.worst_spans]
        return d


def _beat_of(manifest: dict, beat_abs: float) -> int:
    return int(round(beat_abs - manifest["offset_beats"]))


def _bar_of(manifest: dict, beat_abs: float) -> float:
    return beat_abs / manifest["meter"] + 1


def span_beats(manifest: dict, span: dict, n_beats: int | None = None) -> range:
    """The span's beats, in this render's own (0-based, `offset_beats`-shifted) numbering,
    clipped to `[0, n_beats)` when `n_beats` is given (a `--bars` render only covers part of the
    score). A span with no overlap with the rendered range at all -- e.g. `--bars 9-16` next to a
    span that's actually bars 17-19 -- returns an empty range, not a range full of beats past the
    end of the render's own audio; a span that only partly overlaps is clipped to the part that
    does. Without `n_beats` (the default), only the start is clipped to 0, as before."""
    a = max(0, _beat_of(manifest, span["start_beat"]))
    b = _beat_of(manifest, span["end_beat"])
    if n_beats is not None:
        b = min(b, n_beats)
    if b <= a:
        return range(0, 0)
    return range(a, b)


def evaluate(manifest: dict, stems: list[Stem], *, allow_mute: set[str] | None = None) -> Report:
    allow_mute = allow_mute or set()
    scale = key_scale(manifest.get("key", ""))
    n_beats = max((len(s.chroma) for s in stems), default=0)

    # Which chord (its root pitch class) covers each beat, precomputed once so `beat_clash` can
    # add its (undiluted) bass-vs-root term without re-parsing the harmony spans per beat.
    beat_root: dict[int, int] = {}
    for span in manifest.get("harmony", []):
        chord_tones = [PITCH_NAMES.index(t) for t in span.get("chord_tones", []) if t in PITCH_NAMES]
        if not chord_tones:
            continue
        for b in span_beats(manifest, span, n_beats):
            beat_root[b] = chord_tones[0]

    # ---- clash, per beat and per span --------------------------------------------------------
    beat_scores = np.array([beat_clash(stems, b, beat_root.get(b)) for b in range(n_beats)])
    beat_weight = np.array([sum(s.chroma[b].sum() for s in stems if b < len(s.chroma)) for b in range(n_beats)])
    mean_clash = float(np.average(beat_scores, weights=beat_weight)) if beat_weight.sum() > 0 else 0.0
    consonance = 100.0 * (1.0 - min(1.0, mean_clash))

    spans = manifest.get("harmony", [])
    span_findings: list[SpanFinding] = []
    on_chord: dict[str, list[float]] = {s.name: [] for s in stems}
    off_key: dict[str, list[float]] = {s.name: [] for s in stems}
    bass_stem = choose_bass(stems)
    for span in spans:
        beats = list(span_beats(manifest, span, n_beats))
        if not beats:
            continue
        chord_tones = [PITCH_NAMES.index(t) for t in span.get("chord_tones", []) if t in PITCH_NAMES]
        span_clash = 0.0
        detail_candidates: list[tuple[float, str]] = []
        for b in beats:
            if b >= n_beats:
                continue
            bass_pc = int(np.argmax(bass_stem.chroma[b])) if bass_stem is not None and bass_stem.chroma[b].sum() > 0 else None
            span_clash += beat_scores[b] if b < len(beat_scores) else 0.0

            # The flagship case this checker exists for: a bass note a semitone (or a major 7th)
            # from another stem's loudest note *even when both are chord tones* -- chord-tone
            # share alone can't see this (a maj7 held over its own root is "on chord" but is the
            # harshest interval there is). Surfaced directly from the pairwise kernel, weighted by
            # how much it actually contributes to this beat's clash.
            if bass_stem is not None and bass_pc is not None:
                for s in stems:
                    if s is bass_stem or not s.pitched or b >= len(s.chroma) or s.chroma[b].sum() <= 0:
                        continue
                    mag = pair_clash(bass_stem.chroma[b], s.chroma[b], bass_pair=True)
                    if mag <= 0.05:
                        continue
                    top_pc = int(np.argmax(s.chroma[b]))
                    d = (top_pc - bass_pc) % 12
                    if d == 1:
                        rel = "a semitone above"
                    elif d == 11:
                        rel = "a semitone below"
                    elif d == 2:
                        rel = "a major 2nd above"
                    elif d == 10:
                        rel = "a major 2nd below"
                    else:
                        continue
                    bar = _bar_of(manifest, manifest["offset_beats"] + b)
                    detail_candidates.append((mag, f"{s.name}'s {PITCH_NAMES[top_pc]} {rel} the bass {PITCH_NAMES[bass_pc]} ({bass_stem.name}), bar {bar:.0f}"))

            for s in stems:
                if not s.pitched or b >= len(s.chroma) or s.chroma[b].sum() <= 0:
                    continue
                terms = chord_clash_terms(s.chroma[b], chord_tones, bass_pc, scale)
                cc = sum(terms.values())
                if chord_tones:
                    total = s.chroma[b].sum()
                    on_chord[s.name].append(sum(s.chroma[b][t] for t in chord_tones) / total)
                    if scale is not None:
                        off_key[s.name].append(sum(s.chroma[b][p] / total for p in range(12) if p not in scale))
                if cc > 0.3 and s is not bass_stem and chord_tones and terms:
                    # The worst-offending pitch class *among the off-chord ones this stem
                    # actually has* -- never the stem's overall loudest pitch class, which can be
                    # a chord tone even while some other, quieter pitch class is what's off-chord
                    # (a chord tone, by definition, is never itself flagged here).
                    worst_pc = max(terms, key=terms.get)
                    root_pc = chord_tones[0]
                    d_root = min((worst_pc - root_pc) % 12, (root_pc - worst_pc) % 12)
                    detail_candidates.append((cc, f"{s.name}'s {PITCH_NAMES[worst_pc]} is off-chord ({d_root} semitones from the root {PITCH_NAMES[root_pc]})"))
        avg_clash = span_clash / len(beats)
        # Dedupe by text (keep the strongest occurrence's magnitude), then the top few by magnitude.
        best: dict[str, float] = {}
        for mag, text in detail_candidates:
            best[text] = max(mag, best.get(text, 0.0))
        ranked = sorted(best.items(), key=lambda kv: -kv[1])
        detail = "; ".join(text for text, _ in ranked[:4]) or "no strong single clash; diffuse dissonance"
        span_findings.append(SpanFinding(
            start_bar=_bar_of(manifest, span["start_beat"]), end_bar=_bar_of(manifest, span["end_beat"]),
            label=span.get("label", ""), clash=round(avg_clash, 4), detail=detail,
        ))
    span_findings.sort(key=lambda f: -f.clash)
    all_span_clashes = sorted(f.clash for f in span_findings)
    span_clash_spread = (
        (all_span_clashes[0], float(np.median(all_span_clashes)), all_span_clashes[-1]) if all_span_clashes else (0.0, 0.0, 0.0)
    )

    on_chord_mean = {k: float(np.mean(v)) if v else float("nan") for k, v in on_chord.items()}
    off_key_mean = {k: float(np.mean(v)) if v else 0.0 for k, v in off_key.items()}

    # ---- leave-one-out: which stem's removal cuts the most clash --------------------------------
    loo = []
    for i, dropped in enumerate(stems):
        others = stems[:i] + stems[i + 1:]
        if len(others) < 2:
            loo.append((dropped.name, mean_clash))
            continue
        bs = np.array([beat_clash(others, b, beat_root.get(b)) for b in range(n_beats)])
        bw = np.array([sum(s.chroma[b].sum() for s in others if b < len(s.chroma)) for b in range(n_beats)])
        without = float(np.average(bs, weights=bw)) if bw.sum() > 0 else 0.0
        loo.append((dropped.name, round(mean_clash - without, 5)))
    loo.sort(key=lambda x: -x[1])

    # ---- chord-change smear: on-chord share in the first SMEAR_WINDOW_S vs the rest -------------
    spb = 60.0 / manifest["tempo"]
    smear: dict[str, float] = {}
    smear_beats = max(1, int(round(SMEAR_WINDOW_S / spb)))
    for span in spans:
        beats = list(span_beats(manifest, span, n_beats))
        chord_tones = [PITCH_NAMES.index(t) for t in span.get("chord_tones", []) if t in PITCH_NAMES]
        if not chord_tones or not beats:
            continue
        early, late = beats[:smear_beats], beats[smear_beats:]
        for s in stems:
            def share(bs):
                vals = [sum(s.chroma[b][t] for t in chord_tones) / s.chroma[b].sum() for b in bs if b < len(s.chroma) and s.chroma[b].sum() > 0]
                return float(np.mean(vals)) if vals else None

            e, l = share(early), share(late)
            if e is not None and l is not None:
                smear.setdefault(s.name, []).append(l - e)
    smear_mean = {k: round(float(np.mean(v)), 4) for k, v in smear.items() if v}

    # ---- loop-wrap: the last section's chroma judged against the first (does the loop-back clash) --
    loop_wrap = 0.0
    wrap_beats = int(round(4 * manifest["meter"]))
    if n_beats > wrap_beats:
        tail = [Stem(s.name, s.pitched, s.kit, s.bass, s.chroma[-wrap_beats:], s.energy_db[-wrap_beats:], s.mono) for s in stems]
        head = [Stem(s.name, s.pitched, s.kit, s.bass, s.chroma[:wrap_beats], s.energy_db[:wrap_beats], s.mono) for s in stems]
        # Beat 0 of the head immediately follows the last beat of the tail when the loop repeats.
        joint = [Stem(s.name, s.pitched, s.kit, s.bass, np.vstack([t.chroma[-1:], h.chroma[:1]]), np.array([0, 0]), s.mono) for s, t, h in zip(stems, tail, head)]
        loop_wrap = round(beat_clash(joint, 0), 5)

    # ---- guards -------------------------------------------------------------------------------
    violations: list[str] = []
    baseline = None
    baseline_path = None
    penalties = {"energy": 0.0, "density": 0.0, "coverage": 0.0, "tuning": 0.0}

    return Report(
        consonance=round(consonance, 2), objective=round(consonance, 2), penalties=penalties,
        guard_violations=violations, worst_spans=span_findings[:8], leave_one_out=loo,
        on_chord=on_chord_mean, off_key=off_key_mean, smear=smear_mean, loop_wrap=loop_wrap,
        baseline=baseline, span_clash_spread=tuple(round(x, 4) for x in span_clash_spread),
    )


# --------------------------------------------------------------------------- guards against a baseline

def section_energy_db(stems: list[Stem], manifest: dict) -> list[float]:
    """Total energy (dBFS-ish, summed linear power across stems) in each `ENERGY_SECTION_BEATS`
    section, scaled for the meter."""
    section = ENERGY_SECTION_BEATS * (manifest["meter"] / 4.0)
    n_beats = max((len(s.chroma) for s in stems), default=0)
    n_sections = max(1, int(np.ceil(n_beats / section)))
    out = []
    for sec in range(n_sections):
        a, b = int(sec * section), int(min(n_beats, (sec + 1) * section))
        power = 0.0
        for s in stems:
            vals = s.energy_db[a:b]
            vals = vals[np.isfinite(vals)]
            if len(vals):
                power += np.mean(10 ** (vals / 10.0))
        out.append(10 * np.log10(power + 1e-12))
    return out


def apply_guards(report: Report, manifest: dict, stems: list[Stem], baseline: dict | None, allow_mute: set[str]) -> Report:
    """Penalize/flag ways the objective could be gamed: muting, thinning, or collapsing to one
    pitch. Compares against `baseline` (a previous `evaluate()` + this function's own summary),
    when given."""
    violations = list(report.guard_violations)
    penalties = dict(report.penalties)
    n_beats = max((len(s.chroma) for s in stems), default=0)

    stem_names = {s.name for s in stems}
    stem_peak_db = {s.name: float(np.max(s.energy_db)) if len(s.energy_db) and np.any(np.isfinite(s.energy_db)) else -120.0 for s in stems}

    if baseline:
        base_sections = baseline.get("section_energy_db", [])
        cur_sections = section_energy_db(stems, manifest)
        for i, (a, b) in enumerate(zip(base_sections, cur_sections)):
            if b < a - ENERGY_GUARD_DB:
                violations.append(f"section {i + 1}: energy {b:.1f} dBFS is {a - b:.1f} dB under the baseline ({a:.1f} dBFS)")
                penalties["energy"] += min(10.0, (a - b - ENERGY_GUARD_DB))

        base_peaks = baseline.get("stem_peak_db", {})
        for name, base_db in base_peaks.items():
            if name in allow_mute:
                continue
            cur_db = stem_peak_db.get(name, -120.0)
            if base_db > -60.0 and cur_db < base_db - MUTE_GUARD_DB:
                violations.append(f"{name}: peak {cur_db:.1f} dBFS is {base_db - cur_db:.1f} dB under its baseline ({base_db:.1f} dBFS) -- looks muted")
                penalties["energy"] += 5.0

        base_density = baseline.get("density_per_bar", 0.0)
        cur_density = density_per_bar(stems, manifest)
        if cur_density < base_density - DENSITY_GUARD_STEMS:
            violations.append(f"density {cur_density:.2f} stems/bar is below the baseline {base_density:.2f} - {DENSITY_GUARD_STEMS}")
            penalties["density"] += 5.0

        base_entropy = baseline.get("pitch_entropy_bits", 0.0)
        cur_entropy = pitch_entropy_bits(stems)
        if cur_entropy < base_entropy - COVERAGE_ENTROPY_GUARD_BITS:
            violations.append(f"pitch-class entropy {cur_entropy:.2f} bits is below the baseline {base_entropy:.2f} - {COVERAGE_ENTROPY_GUARD_BITS}")
            penalties["coverage"] += 5.0

    # Coverage: every chord tone should carry at least COVERAGE_MIN_SHARE of the tonal energy of
    # each span (checked regardless of a baseline: this is about the render itself, not a delta).
    for span in manifest.get("harmony", []):
        chord_tones = [PITCH_NAMES.index(t) for t in span.get("chord_tones", []) if t in PITCH_NAMES]
        if not chord_tones:
            continue
        beats = list(span_beats(manifest, span, n_beats))
        total = np.zeros(12)
        for b in beats:
            for s in stems:
                if s.pitched and b < len(s.chroma):
                    total += s.chroma[b]
        if total.sum() <= 0:
            continue
        shares = total / total.sum()
        for t in chord_tones:
            if shares[t] < COVERAGE_MIN_SHARE:
                violations.append(f"{span.get('label', '')} bars {_bar_of(manifest, span['start_beat']):.0f}-{_bar_of(manifest, span['end_beat']):.0f}: "
                                   f"chord tone {PITCH_NAMES[t]} is only {shares[t] * 100:.1f}% of the tonal energy")
                penalties["coverage"] += 2.0

    # Tuning: any *pitched* stem more than TUNING_GUARD_CENTS off A440. A drum kit's pads and
    # other unpitched one-shots have no real "tuning" -- `TuningFrequencyExtractor` still returns
    # something for a decaying thump, but it's noise, not a mistuned note.
    for s in stems:
        if not s.pitched:
            continue
        cents = stem_tuning_cents(s.mono)
        if cents is not None and abs(cents) > TUNING_GUARD_CENTS:
            violations.append(f"{s.name}: tuned {cents:+.1f}¢ from A440 (beyond ±{TUNING_GUARD_CENTS:.0f}¢)")
            penalties["tuning"] += 2.0

    total_penalty = sum(penalties.values())
    objective = max(0.0, report.consonance - total_penalty)
    return dataclasses.replace(report, objective=round(objective, 2), penalties=penalties, guard_violations=violations)


def density_per_bar(stems: list[Stem], manifest: dict) -> float:
    """Mean count of stems with any tonal energy on a bar, across bars."""
    n_beats = max((len(s.chroma) for s in stems), default=0)
    meter = manifest["meter"]
    n_bars = max(1, int(np.ceil(n_beats / meter)))
    counts = []
    for bar in range(n_bars):
        a, b = bar * meter, min(n_beats, (bar + 1) * meter)
        n = sum(1 for s in stems if any(s.chroma[i].sum() > 1e-6 for i in range(a, b) if i < len(s.chroma)))
        counts.append(n)
    return float(np.mean(counts)) if counts else 0.0


def pitch_entropy_bits(stems: list[Stem]) -> float:
    """Pitch-class entropy of the pitched stems' summed chroma (unpitched stems -- drum kits, and
    one-shots outside the harmony -- are excluded, the same as `chord_clash`/`beat_clash`: a
    kick's decaying thump reads as a pitch class too, and would understate a genuinely
    single-pitch, gamed mix's entropy drop)."""
    total = np.zeros(12)
    for s in stems:
        if s.pitched:
            total += s.chroma.sum(axis=0)
    if total.sum() <= 0:
        return 0.0
    p = total / total.sum()
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def stem_tuning_cents(mono: np.ndarray) -> float | None:
    try:
        import essentia.standard as es
    except ImportError:
        return None
    per_frame = np.asarray(es.TuningFrequencyExtractor(frameSize=FRAME, hopSize=HOP)(np.ascontiguousarray(mono, dtype=np.float32)))
    per_frame = per_frame[per_frame > 0]
    if not len(per_frame):
        return None
    hz = float(np.median(per_frame))
    return 1200 * np.log2(hz / 440.0)


def summarize_for_baseline(stems: list[Stem], manifest: dict) -> dict:
    return {
        "section_energy_db": section_energy_db(stems, manifest),
        "stem_peak_db": {s.name: (float(np.max(s.energy_db)) if len(s.energy_db) and np.any(np.isfinite(s.energy_db)) else -120.0) for s in stems},
        "density_per_bar": density_per_bar(stems, manifest),
        "pitch_entropy_bits": pitch_entropy_bits(stems),
    }


# --------------------------------------------------------------------------- top-level entry point

def check(stems_dir: pathlib.Path, *, baseline_path: pathlib.Path | None = None, allow_mute: set[str] | None = None,
          log_path: pathlib.Path | None = None) -> Report:
    """Load a `--stems` render, evaluate it, apply the guards against `baseline_path` (writing it
    on first use), and append the result to `log_path`."""
    allow_mute = allow_mute or set()
    manifest, stems = load_stems(stems_dir)
    report = evaluate(manifest, stems, allow_mute=allow_mute)

    baseline = None
    if baseline_path is not None:
        if baseline_path.exists():
            baseline = json.loads(baseline_path.read_text())
        else:
            baseline = summarize_for_baseline(stems, manifest)
            baseline_path.parent.mkdir(parents=True, exist_ok=True)
            baseline_path.write_text(json.dumps(baseline, indent=1) + "\n")
    report = apply_guards(report, manifest, stems, baseline, allow_mute)
    report = dataclasses.replace(report, baseline=baseline)

    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        entry = {"at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "stems_dir": str(stems_dir),
                 "objective": report.objective, "consonance": report.consonance, "guard_violations": report.guard_violations}
        with log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    return report
