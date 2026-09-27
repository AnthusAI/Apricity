"""Analyze one audio file (a sample) into an Apricity manifest (see schema/sample-manifest.schema.json).

Tuning (tonal.tuning_hz / tonal.tuning_cents): estimated by cross-checking two independent
estimators on the harmonic part of the signal — essentia's per-frame TuningFrequencyExtractor
(median across frames) and librosa.estimate_tuning (piptrack over the spectrum). Essentia's
estimator is documented to clamp its output to a fixed cents range and, on noisy or inharmonic
material (drum/bass stems, dense mixes), tends to pin at that edge or a spurious quantized bin
instead of failing; such a result is discarded before comparison. When the surviving estimators
agree within `TUNING_AGREEMENT_CENTS` cents their mean is used, otherwise the estimate is stored
as 0.0 (i.e. no retuning) and `tonal.tuning_uncertain` is set. See `estimate_tuning()`. Existing
manifests can be re-estimated for tuning alone, without a full re-analysis, via
`python -m apricity_analyze.analyze --tuning <paths...>`.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import pathlib
from importlib.metadata import version

import numpy as np

from .theory import rank_keys

SR = 44100
FRAME, HOP = 4096, 2048
SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "schema" / "sample-manifest.schema.json"


def _r(x: float, nd: int = 4) -> float:
    return round(float(x), nd)


def _norm(v: np.ndarray) -> list[float]:
    m = float(np.max(v)) if len(v) else 0.0
    return [_r(x / m if m > 0 else 0.0) for x in v]


# --------------------------------------------------------------------------- source

def source_info(path: pathlib.Path, manifest_dir: pathlib.Path) -> dict:
    import soundfile as sf
    import essentia.standard as es

    h = hashlib.sha256(path.read_bytes()).hexdigest()
    try:
        info = sf.info(str(path))
        sr, ch, dur = info.samplerate, info.channels, info.duration
    except RuntimeError:  # mp3 on older libsndfile: fall back to essentia's ffmpeg loader
        audio, sr, ch, *_ = es.AudioLoader(filename=str(path))()
        dur = audio.shape[0] / sr
    return {"path": path.name if path.parent == manifest_dir else str(path), "sha256": h,
            "sample_rate": int(sr), "channels": int(ch), "duration": _r(dur, 3)}


# --------------------------------------------------------------------------- rhythm

_beat_tracker = None


def rhythm(path: pathlib.Path) -> dict:
    global _beat_tracker
    from beat_this.inference import File2Beats

    if _beat_tracker is None:
        _beat_tracker = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    beats, downbeats = _beat_tracker(str(path))
    beats, downbeats = np.asarray(beats, float), np.asarray(downbeats, float)

    bpm = stability = meter = None
    markers = []
    if len(beats) >= 2:
        ibi = np.diff(beats)
        med = float(np.median(ibi))
        bpm = _r(60.0 / med, 2)
        stability = _r(max(0.0, 1.0 - float(np.std(ibi) / med)), 3)

    # Beat number 0 = first downbeat; pickups are negative. Meter = most common bar length.
    if len(downbeats) >= 2 and len(beats):
        idx = [int(np.argmin(np.abs(beats - d))) for d in downbeats]
        bar_lengths = np.diff(idx)
        bar_lengths = bar_lengths[bar_lengths > 0]
        if len(bar_lengths):
            meter = int(np.bincount(bar_lengths).argmax())
    first = int(np.argmin(np.abs(beats - downbeats[0]))) if len(downbeats) and len(beats) else 0
    for i, t in enumerate(beats):
        markers.append({"seconds": _r(t), "beat": float(i - first)})

    return {"bpm": bpm, "bpm_stability": stability if stability is not None else 0.0,
            "beats": [_r(b) for b in beats], "downbeats": [_r(d) for d in downbeats],
            "meter": meter, "warp_markers": markers}


def beat_loudness(path: pathlib.Path, beats: list[float]) -> list[float]:
    """RMS level (dBFS) of each beat interval: lets region picking avoid near-silent stretches."""
    import essentia.standard as es

    audio = es.MonoLoader(filename=str(path), sampleRate=SR)()
    out = []
    for a, b in zip(beats, beats[1:]):
        seg = audio[int(a * SR):int(b * SR)]
        rms = float(np.sqrt(np.mean(seg**2))) if len(seg) else 0.0
        out.append(_r(20 * np.log10(rms + 1e-9), 1))
    return out


LOUDNESS_HOP_S = 0.5


def time_loudness(path: pathlib.Path) -> list[float]:
    """RMS level (dBFS) of each half-second window: a level curve that needs no beat grid."""
    import essentia.standard as es

    audio = es.MonoLoader(filename=str(path), sampleRate=SR)()
    hop = int(LOUDNESS_HOP_S * SR)
    return [_r(20 * np.log10(float(np.sqrt(np.mean(audio[i:i + hop] ** 2))) + 1e-9), 1) for i in range(0, len(audio), hop) if len(audio[i:i + hop])]


# --------------------------------------------------------------------------- tonal

# essentia's TuningFrequency algorithm documents its output as clamped to "-35 to 65 cents"; on
# ccMixter mixes (lots of drums/noise even after HPSS) it often pins at one edge or a spurious
# quantized bin instead of failing loudly. A value within this many cents of either documented
# edge is treated as suspect and dropped rather than trusted.
ESSENTIA_TUNING_RANGE = (-35.0, 65.0)
ESSENTIA_EDGE_EPS = 1.0
# How far apart (in cents) the two independent estimators may be and still be considered agreeing.
TUNING_AGREEMENT_CENTS = 10.0


def _essentia_tuning_cents(audio_harmonic: np.ndarray) -> float | None:
    """Median of essentia's per-frame TuningFrequencyExtractor, in cents from A440."""
    import essentia.standard as es

    per_frame = np.asarray(es.TuningFrequencyExtractor(frameSize=FRAME, hopSize=HOP)(audio_harmonic))
    per_frame = per_frame[per_frame > 0]
    if not len(per_frame):
        return None
    return float(1200 * np.log2(float(np.median(per_frame)) / 440.0))


def _librosa_tuning_cents(audio_harmonic: np.ndarray, sr: int) -> float | None:
    """librosa.estimate_tuning (piptrack over the spectrum), in cents from A440."""
    import librosa

    semitones = librosa.estimate_tuning(y=np.asarray(audio_harmonic, dtype=np.float32), sr=sr)
    if semitones is None or not np.isfinite(semitones):
        return None
    return float(semitones) * 100.0


def estimate_tuning(audio_harmonic: np.ndarray, sr: int = SR) -> tuple[float, dict]:
    """Robust tuning estimate (cents deviation of A from 440 Hz) for the harmonic part of a clip.

    Cross-checks two independent estimators: essentia's per-frame TuningFrequencyExtractor
    (median across frames) and librosa.estimate_tuning (piptrack over the spectrum). Essentia's
    estimator is documented to clamp to a fixed range and, on inharmonic or noisy material
    (drum/bass stems, dense ccMixter mixes), is prone to pinning at that edge or a spurious
    quantized bin rather than failing; a result within ~1 cent of either documented edge is
    discarded as suspect. If the surviving estimator(s) agree within `TUNING_AGREEMENT_CENTS`
    cents, their mean is used; otherwise the estimate is untrustworthy and 0.0 is returned with
    `flags["uncertain"] = True` so the caller can record `tonal.tuning_uncertain`.

    Returns (cents, flags) where flags carries the raw per-estimator readings for diagnostics.
    """
    ess_cents = _essentia_tuning_cents(audio_harmonic)
    ess_edge_pinned = ess_cents is not None and any(
        abs(ess_cents - edge) <= ESSENTIA_EDGE_EPS for edge in ESSENTIA_TUNING_RANGE
    )
    if ess_edge_pinned:
        ess_cents = None
    lib_cents = _librosa_tuning_cents(audio_harmonic, sr)

    flags = {"essentia_cents": ess_cents, "librosa_cents": lib_cents, "essentia_edge_pinned": ess_edge_pinned}

    if ess_cents is None or lib_cents is None or abs(ess_cents - lib_cents) > TUNING_AGREEMENT_CENTS:
        flags["uncertain"] = True
        return 0.0, flags
    flags["uncertain"] = False
    return (ess_cents + lib_cents) / 2.0, flags


def tonal(path: pathlib.Path, beats: list[float], downbeats: list[float], meter: int | None) -> dict:
    import essentia.standard as es

    audio = es.MonoLoader(filename=str(path), sampleRate=SR)()
    # Measure pitch on the harmonic part only: drums and cymbals smear chroma across all twelve
    # pitch classes. librosa's median-filter HPSS; margin > 1 keeps only clearly-harmonic energy.
    audio = harmonic(audio)

    # Tuning first: 78s were often cut or played off-speed, so A may be far from 440. See
    # estimate_tuning() for how disagreement between estimators is detected and handled.
    tuning_cents, tuning_flags = estimate_tuning(audio, SR)
    tuning_hz = 440.0 * 2 ** (tuning_cents / 1200.0)

    window = es.Windowing(type="blackmanharris62")
    spectrum = es.Spectrum()
    peaks = es.SpectralPeaks(orderBy="magnitude", magnitudeThreshold=1e-5, minFrequency=40,
                             maxFrequency=5000, maxPeaks=60, sampleRate=SR)
    hpcp = es.HPCP(size=12, referenceFrequency=tuning_hz, harmonics=8, bandPreset=True,
                   minFrequency=40, maxFrequency=5000, weightType="cosine", nonLinear=False,
                   windowSize=1.0, sampleRate=SR)
    frames = []
    for frame in es.FrameGenerator(audio, frameSize=FRAME, hopSize=HOP, startFromZero=True):
        f, m = peaks(spectrum(window(frame)))
        frames.append(hpcp(f, m))
    # Essentia's HPCP starts at A (the reference frequency); rotate so C is bin 0.
    chroma = np.roll(np.array(frames), 9, axis=1) if frames else np.zeros((0, 12))
    times = (np.arange(len(chroma)) * HOP + FRAME / 2) / SR

    global_pcp = chroma.sum(axis=0) if len(chroma) else np.zeros(12)
    ranked = rank_keys(global_pcp)
    if not ranked:
        raise ValueError("no tonal content found")

    # Key over time: 8-bar windows when we know the bars, else 12 s windows; merge equal neighbours.
    bounds = _segment_bounds(times[-1] if len(times) else 0.0, downbeats, meter)
    segments = []
    for a, b in bounds:
        sel = (times >= a) & (times < b)
        if sel.sum() < 4:
            continue
        pcp = chroma[sel].sum(axis=0)
        k = rank_keys(pcp)
        if not k:
            continue
        seg = {"start": _r(a, 3), "end": _r(b, 3), "key": k[0], "pitch_class_profile": _norm(pcp)}
        if segments and segments[-1]["key"]["tonic"] == k[0]["tonic"] and segments[-1]["key"]["mode"] == k[0]["mode"]:
            prev = segments[-1]
            merged = np.array(prev["pitch_class_profile"]) + np.array(seg["pitch_class_profile"])
            prev.update(end=seg["end"], pitch_class_profile=_norm(merged))
        else:
            segments.append(seg)

    beat_chroma = []
    for a, b in zip(beats, beats[1:]):
        sel = (times >= a) & (times < b)
        beat_chroma.append(_norm(chroma[sel].mean(axis=0)) if sel.any() else [0.0] * 12)

    out = {"key": ranked[0], "alternatives": ranked[1:4], "tuning_hz": _r(tuning_hz, 2),
           "tuning_cents": _r(tuning_cents, 1),
           "pitch_class_profile": _norm(global_pcp), "segments": segments, "beat_chroma": beat_chroma}
    if tuning_flags["uncertain"]:
        out["tuning_uncertain"] = True
    return out


HPSS_MARGIN = 2.0


def harmonic(audio: np.ndarray) -> np.ndarray:
    import librosa

    return librosa.effects.harmonic(np.asarray(audio, dtype=np.float32), margin=HPSS_MARGIN).astype(np.float32)


def _segment_bounds(end: float, downbeats: list[float], meter: int | None) -> list[tuple[float, float]]:
    if len(downbeats) >= 9:
        marks = [0.0] + list(downbeats[8::8])
        if end - marks[-1] > 1.0:
            marks.append(end)
        return [(a, b) for a, b in zip(marks, marks[1:]) if b > a]
    step = 12.0
    edges = list(np.arange(0.0, end, step)) + [end]
    return [(a, b) for a, b in zip(edges, edges[1:]) if b - a > 1.0]


# --------------------------------------------------------------------------- notes

def notes(path: pathlib.Path) -> list[dict]:
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    _, _, events = predict(str(path), ICASSP_2022_MODEL_PATH)
    return sorted(
        ({"start": _r(s), "end": _r(e), "midi": int(p), "velocity": _r(min(1.0, max(0.0, a)), 3)}
         for s, e, p, a, *_ in events),
        key=lambda n: (n["start"], n["midi"]),
    )


# --------------------------------------------------------------------------- manifest

def manifest_path(audio: pathlib.Path) -> pathlib.Path:
    return audio.with_name(audio.name + ".apricity.json")


def analyze(path: pathlib.Path, with_notes: bool = True, rhythm_from: dict | None = None) -> dict:
    """Analyze `path`. `rhythm_from` reuses another manifest's beat grid (for stems of a recording).

    Deliberately does NOT resolve() `path`: library audio is sometimes a symlink (e.g. into
    another checkout or worktree's copy), while the manifest is a real file that belongs next to
    the symlink itself, not next to whatever it points at. Reading the audio through the symlink
    is transparent, so there is no need to resolve it first.
    """
    out = manifest_path(path)
    previous = json.loads(out.read_text()) if out.exists() else {}

    src = source_info(path, path.parent)
    rh = dict(rhythm_from["rhythm"]) if rhythm_from else rhythm(path)
    rh["beat_loudness"] = beat_loudness(path, rh["beats"])
    rh["loudness"] = time_loudness(path)
    tn = tonal(path, rh["beats"], rh["downbeats"], rh["meter"])
    m = {
        "apricity_manifest": 2,
        "source": src,
        "analysis": {
            "analyzed_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "tools": {"apricity-analyze": "0.2.0", "essentia": version("essentia"), "beat_this": "final0",
                      "librosa": f"{version('librosa')} (HPSS margin {HPSS_MARGIN} before chroma)",
                      **({"basic-pitch": version("basic-pitch")} if with_notes else {})},
        },
        "rhythm": rh,
        "tonal": tn,
    }
    if with_notes:
        m["notes"] = notes(path)
    elif "notes" in previous and previous.get("source", {}).get("sha256") == src["sha256"]:
        m["notes"] = previous["notes"]
    if "annotations" in previous:  # user data: always carried over
        m["annotations"] = previous["annotations"]
    if "derived_from" in previous:
        m["derived_from"] = previous["derived_from"]
    validate(m)
    return m


def validate(m: dict) -> None:
    import jsonschema

    jsonschema.validate(m, json.loads(SCHEMA.read_text()))
    dur = m["source"]["duration"]
    for s in m.get("annotations", {}).get("clips", []):
        if not (0 <= s["start"] < s["end"] <= dur + 1e-6):
            raise ValueError(f"saved clip {s['name']!r} [{s['start']}, {s['end']}] is outside the sample (0..{dur})")



def write(m: dict, audio: pathlib.Path) -> pathlib.Path:
    # See analyze()'s docstring: do NOT resolve() `audio` first, or a symlinked audio file's
    # manifest gets written next to its target instead of next to the symlink.
    out = manifest_path(audio)
    out.write_text(json.dumps(m, indent=1) + "\n")
    return out


# --------------------------------------------------------------------------- tuning-only refresh

def refresh_tuning(audio: pathlib.Path) -> tuple[float, float, bool] | None:
    """Re-estimate only tonal.tuning_hz / tuning_cents / tuning_uncertain for an existing manifest
    from `audio`, in place, leaving every other field (including the rest of `tonal`) untouched.
    Used to roll out a tuning-estimator fix over the library without a full, slow re-analysis.

    Returns (old_cents, new_cents, uncertain) or None if `audio` has no manifest yet.
    """
    import essentia.standard as es

    # Deliberately do NOT resolve() `audio`: library audio is often a symlink (e.g. into another
    # checkout or worktree's copy), while the manifest lives as a real file next to the symlink
    # itself. Resolving first would compute manifest_path() against the symlink's target
    # directory and silently edit a manifest outside this tree instead of the one we were asked
    # to refresh.
    mpath = manifest_path(audio)
    if not mpath.exists():
        return None
    m = json.loads(mpath.read_text())
    old_cents = float(m["tonal"]["tuning_cents"])

    signal = es.MonoLoader(filename=str(audio), sampleRate=SR)()
    signal = harmonic(signal)
    cents, flags = estimate_tuning(signal, SR)
    hz = 440.0 * 2 ** (cents / 1200.0)

    m["tonal"]["tuning_hz"] = _r(hz, 2)
    m["tonal"]["tuning_cents"] = _r(cents, 1)
    if flags["uncertain"]:
        m["tonal"]["tuning_uncertain"] = True
    else:
        m["tonal"].pop("tuning_uncertain", None)

    validate(m)
    mpath.write_text(json.dumps(m, indent=1) + "\n")
    return old_cents, float(m["tonal"]["tuning_cents"]), bool(flags["uncertain"])


AUDIO_EXTS = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a"}


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="apricity_analyze.analyze")
    ap.add_argument("--tuning", action="store_true",
                     help="refresh only tonal.tuning_hz/tuning_cents/tuning_uncertain for existing "
                          "manifests from the audio, without a full re-analysis")
    ap.add_argument("paths", nargs="+", type=pathlib.Path, help="audio files or folders (searched recursively)")
    args = ap.parse_args(argv)

    if not args.tuning:
        ap.error("only --tuning is supported here; use `apricity-analyze` (cli.py) for full analysis")

    import sys

    failed = 0
    for root in args.paths:
        files = sorted(f for f in root.rglob("*") if f.suffix.lower() in AUDIO_EXTS) if root.is_dir() else [root]
        for f in files:
            if not f.exists():  # a broken symlink (missing/moved target): skip, don't crash the run
                print(f"  MISSING     {f}: symlink target does not exist", file=sys.stderr)
                failed += 1
                continue
            try:
                result = refresh_tuning(f)
            except Exception as e:  # keep going over a folder; report at the end
                print(f"  FAILED      {f}: {e}", file=sys.stderr)
                failed += 1
                continue
            if result is None:
                continue
            old_cents, new_cents, uncertain = result
            flag = "  UNCERTAIN" if uncertain else ""
            print(f"  {f.name[:56]:56}  {old_cents:7.1f} -> {new_cents:7.1f} cents{flag}")
    return 1 if failed else 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
