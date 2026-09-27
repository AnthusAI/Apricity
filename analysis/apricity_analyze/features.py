"""Per-sample "fit-feature" sidecar: precomputed per-beat / quarter-beat audio features used by
the stochastic mash-up optimizer's compile-informed surrogate (Kanbus apricitus-798704; design in
the apricitus-7e51f2 epic's first comment, section 2b).

For each sample manifest `<file>.apricity.json` this module computes a sidecar
`<file>.fitfeat.npz` on the sample's own beat grid (`manifest["rhythm"]["beats"]`, a list of `N`
beat-time markers in seconds). There are `B = N - 1` beat *intervals* -- the same convention
`analyze.py` already uses for `rhythm.beat_loudness` and `tonal.beat_chroma` (one value per
`zip(beats, beats[1:])` pair), so the arrays here line up with those manifest arrays index for
index. A sample whose beat tracker found fewer than 2 beats (a handful of drum one-shots and a
few tracks the tracker failed on) has no beat grid to compute on and is skipped -- see
`compute_features`'s `None` return.

Reuses `analyze.py` / `check.py` / `layer.py`'s existing STFT-based helpers (same FRAME/HOP/SR)
rather than re-implementing chroma, RMS, tonalness or onset-strength extraction:
`check.frame_tonalness`, `check.frame_rms`, `check.frame_times`, `layer.band_energy`,
`layer.onset_envelope`.

Sidecar arrays, stored `float16` (or `int16` for counts) in a compressed `.npz`
(`np.savez_compressed`); `B` = the sample's beat-interval count (see above). `SampleFeatures` (the
in-memory/test-facing object `compute_features` returns) keeps `beat_bands` in **linear power**
throughout -- only `write_sidecar`'s on-disk form converts it to dB, purely to fit float16 without
overflow (raw STFT power routinely exceeds float16's ~65500 max; a dB scale does not). Read a
sidecar back with `10 ** (beat_bands_db / 10.0)` to recover linear power.

  sha256               0-d U64 str   the manifest's `source.sha256` this sidecar was computed
                                     from -- the re-run invalidation key (see `is_up_to_date`).
  beat_tonalness       (B,) f16      1 - spectral flatness of the harmonic-relevant band
                                     (`check.frame_tonalness`, i.e. STFT bins >= 40 Hz), RMS-
                                     weighted mean per beat interval. Unitless, 0 (noise-like) ..
                                     1 (pure tone).
  beat_bands_db        (4B, 24) f16  Log-spaced STFT power (20 Hz-16 kHz, `layer.MASKING_N_BANDS`
                                     = 24 band edges, `layer.band_energy`), averaged per
                                     quarter-beat window (each beat interval split into 4 equal
                                     sub-intervals), then `10*log10(power + eps)`. dB, **not**
                                     linear power (see above).
  beat_onset_strength  (4B,) f16     Mean onset-strength envelope (`layer.onset_envelope`, i.e.
                                     `librosa.onset.onset_strength`) per quarter-beat window.
                                     Unitless onset-strength units.
  beat_onset_count     (4B,) i16     Count of discrete onset events (`librosa.onset.onset_detect`
                                     on the same envelope) whose time falls in each quarter-beat
                                     window.
  beat_bass_share      (B,) f16      STFT power below `BASS_HZ` Hz (250 Hz, matching
                                     `check.BASS_HZ`) over total STFT power, per beat interval.
                                     0..1.

`B` (and `4B`) are recoverable from the arrays' own shapes; no separate scalar is stored.
"""

from __future__ import annotations

import dataclasses
import hashlib
import pathlib

import numpy as np

from . import check, layer
from .analyze import FRAME, HOP, SR

BASS_HZ = check.BASS_HZ  # 250.0, matching check.py's own bass-stem threshold
N_BANDS = layer.MASKING_N_BANDS  # 24
QUARTERS_PER_BEAT = 4

SIDECAR_SUFFIX = ".fitfeat.npz"

_EPS = 1e-12


@dataclasses.dataclass
class SampleFeatures:
    sha256: str
    beat_tonalness: np.ndarray       # (B,)
    beat_bands: np.ndarray           # (4B, 24)
    beat_onset_strength: np.ndarray  # (4B,)
    beat_onset_count: np.ndarray     # (4B,)
    beat_bass_share: np.ndarray      # (B,)

    def to_npz_kwargs(self) -> dict:
        return {
            "sha256": np.array(self.sha256),
            "beat_tonalness": self.beat_tonalness.astype(np.float16),
            # dB, not linear power: raw STFT power routinely exceeds float16's ~65500 max, dB
            # doesn't. See the module docstring for the linear-power round trip.
            "beat_bands_db": (10.0 * np.log10(self.beat_bands + _EPS)).astype(np.float16),
            "beat_onset_strength": self.beat_onset_strength.astype(np.float16),
            "beat_onset_count": self.beat_onset_count.astype(np.int16),
            "beat_bass_share": self.beat_bass_share.astype(np.float16),
        }


# --------------------------------------------------------------------------- audio loading

def load_mono(path: pathlib.Path) -> np.ndarray:
    """Mono float32 audio at `SR`, matching `analyze.py`'s essentia loader (resamples as needed)."""
    import essentia.standard as es

    return es.MonoLoader(filename=str(path), sampleRate=SR)()


# --------------------------------------------------------------------------- low-band power (bass share)

def _low_band_power(mono: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-STFT-frame `(low_power, total_power)`, `low_power` summed over bins below `BASS_HZ`.
    Same FRAME/HOP as every other per-frame feature here, so the frame axis lines up."""
    import librosa

    S = np.abs(librosa.stft(np.ascontiguousarray(mono, dtype=np.float32), n_fft=FRAME, hop_length=HOP, center=True)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=FRAME)
    low = S[freqs < BASS_HZ, :].sum(axis=0)
    total = S.sum(axis=0)
    return low, total


def _quarter_beat_edges(beats: list[float]) -> list[float]:
    """`4B + 1` edges: each beat interval `[beats[i], beats[i+1]]` split into 4 equal parts."""
    edges = []
    for a, b in zip(beats, beats[1:]):
        for k in range(QUARTERS_PER_BEAT):
            edges.append(a + (b - a) * k / QUARTERS_PER_BEAT)
    edges.append(beats[-1])
    return edges


def _weighted_mean(values: np.ndarray, weights: np.ndarray) -> float:
    w = np.clip(weights, 0.0, None)
    total = float(w.sum())
    if total <= _EPS:
        return float(np.mean(values)) if len(values) else 0.0
    return float(np.dot(values, w) / total)


def compute_features(path: pathlib.Path, beats: list[float], sha256: str) -> SampleFeatures | None:
    """Compute the sidecar arrays for one sample's audio, on its own `beats` grid (seconds).
    Returns `None` when there are fewer than 2 beat markers (no beat interval to compute on)."""
    if len(beats) < 2:
        return None

    mono = load_mono(path)
    tonalness_frames = check.frame_tonalness(mono)
    rms_frames = check.frame_rms(mono)
    bands_frames = layer.band_energy(mono, SR)
    onset_env = layer.onset_envelope(mono, SR)
    low_power, total_power = _low_band_power(mono)

    n = min(len(tonalness_frames), len(rms_frames), bands_frames.shape[0], len(onset_env), len(low_power))
    tonalness_frames = tonalness_frames[:n]
    rms_frames = rms_frames[:n]
    bands_frames = bands_frames[:n]
    onset_env = onset_env[:n]
    low_power = low_power[:n]
    total_power = total_power[:n]
    times = check.frame_times(n)

    import librosa

    onset_times = librosa.onset.onset_detect(onset_envelope=onset_env, sr=SR, hop_length=HOP, units="time")

    b = len(beats) - 1
    beat_tonalness = np.zeros(b, dtype=np.float64)
    beat_bass_share = np.zeros(b, dtype=np.float64)
    for i, (a, e) in enumerate(zip(beats, beats[1:])):
        sel = (times >= a) & (times < e)
        if sel.any():
            beat_tonalness[i] = _weighted_mean(tonalness_frames[sel], rms_frames[sel])
            lo, tot = float(low_power[sel].sum()), float(total_power[sel].sum())
            beat_bass_share[i] = lo / tot if tot > _EPS else 0.0

    q_edges = _quarter_beat_edges(beats)
    n_q = b * QUARTERS_PER_BEAT
    beat_bands = np.zeros((n_q, N_BANDS), dtype=np.float64)
    beat_onset_strength = np.zeros(n_q, dtype=np.float64)
    beat_onset_count = np.zeros(n_q, dtype=np.int64)
    for i in range(n_q):
        a, e = q_edges[i], q_edges[i + 1]
        sel = (times >= a) & (times < e)
        if sel.any():
            beat_bands[i] = bands_frames[sel].mean(axis=0)
            beat_onset_strength[i] = float(onset_env[sel].mean())
        beat_onset_count[i] = int(np.sum((onset_times >= a) & (onset_times < e)))

    return SampleFeatures(
        sha256=sha256,
        beat_tonalness=beat_tonalness,
        beat_bands=beat_bands,
        beat_onset_strength=beat_onset_strength,
        beat_onset_count=beat_onset_count,
        beat_bass_share=beat_bass_share,
    )


# --------------------------------------------------------------------------- sidecar I/O

def sidecar_path_for(manifest_path: pathlib.Path) -> pathlib.Path:
    """`<file>.fitfeat.npz` next to `<file>.apricity.json` (the "natural" location; the caller
    decides whether it is actually writable there -- see `scripts/fit-features.py`'s
    `--samples`/`--out-root` handling and `resolve_sidecar_root`)."""
    name = manifest_path.name
    assert name.endswith(".apricity.json"), name
    return manifest_path.with_name(name[: -len(".apricity.json")] + SIDECAR_SUFFIX)


def write_sidecar(path: pathlib.Path, features: SampleFeatures) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **features.to_npz_kwargs())


def read_sidecar_sha(path: pathlib.Path) -> str | None:
    """Just the `sha256` field, cheaply (for the up-to-date check) -- `None` if unreadable/missing."""
    if not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as z:
            return str(z["sha256"])
    except Exception:  # noqa: BLE001 -- a corrupt/partial sidecar is just "not up to date"
        return None


def is_up_to_date(path: pathlib.Path, manifest_sha: str) -> bool:
    return read_sidecar_sha(path) == manifest_sha


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
