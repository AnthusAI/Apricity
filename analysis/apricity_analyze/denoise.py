"""Noise reduction for imported recordings.

Denoising never touches the original. `clean(audio, backend, strength)` writes a sibling
`<name>.clean.wav` (or a path you choose) and returns it; analysis can then run on the copy.

Backends register themselves in BACKENDS. A backend is `fn(y, sr, strength) -> y`, where `y` is a
float32 array shaped (channels, samples) and `strength` is one of STRENGTHS. A backend whose
library is not installed is left out of `available()`.
"""
from __future__ import annotations

import argparse
import os
import pathlib
from typing import Callable

import numpy as np
import soundfile as sf

STRENGTHS = ("light", "medium", "strong")
# What imports use unless told otherwise; set APRICITY_DENOISE (or pass --denoise) to change it, "off" to skip.
DEFAULT = os.environ.get("APRICITY_DENOISE", "neural:medium")
Backend = Callable[[np.ndarray, int, str], np.ndarray]
BACKENDS: dict[str, Backend] = {}
UNAVAILABLE: dict[str, str] = {}


def backend(name: str, needs: str):
    """Register `fn` as backend `name`; `needs` is the pip package shown when it can't load."""
    def wrap(fn):
        BACKENDS[name] = fn
        fn.needs = needs
        return fn
    return wrap


def available() -> list[str]:
    return sorted(BACKENDS)


# How much of the noise each strength removes (noisereduce's `prop_decrease`).
_PROP = {"light": 0.5, "medium": 0.8, "strong": 1.0}


@backend("spectral", "noisereduce")
def spectral(y: np.ndarray, sr: int, strength: str) -> np.ndarray:
    """Spectral gating against a steady noise floor: hiss, hum, rumble."""
    import noisereduce as nr
    return nr.reduce_noise(y=y, sr=sr, stationary=True, prop_decrease=_PROP[strength]).astype(np.float32)


@backend("adaptive", "noisereduce")
def adaptive(y: np.ndarray, sr: int, strength: str) -> np.ndarray:
    """Spectral gating that follows a changing noise floor; better for surface noise that moves."""
    import noisereduce as nr
    return nr.reduce_noise(y=y, sr=sr, stationary=False, prop_decrease=_PROP[strength]).astype(np.float32)


def declick(y: np.ndarray, sr: int, strength: str) -> np.ndarray:
    """Remove crackle: samples far above a running median are replaced by their neighbours."""
    from scipy.signal import medfilt
    k = {"light": 8.0, "medium": 6.0, "strong": 4.0}[strength]
    out = y.copy()
    for c in range(y.shape[0]):
        x = y[c]
        base = medfilt(x, 5)
        resid = x - base
        limit = k * (np.median(np.abs(resid)) / 0.6745 + 1e-9)
        out[c] = np.where(np.abs(resid) > limit, base, x)
    return out


BACKENDS["declick"] = declick
declick.needs = "scipy"


def _try_neural() -> None:
    """Neural backends load lazily and only if their package is installed."""
    try:
        import denoiser  # noqa: F401  (facebook/denoiser, MIT)
    except Exception as e:  # pragma: no cover - depends on the environment
        UNAVAILABLE["neural"] = f"pip install --no-deps denoiser ({type(e).__name__})"
        return

    @backend("neural", "denoiser")
    def neural(y: np.ndarray, sr: int, strength: str) -> np.ndarray:
        """Facebook Denoiser (dns64), a speech-trained waveform network. It works at 16 kHz, so the
        result is limited to 8 kHz bandwidth. `strength` sets how much of the dry signal is kept."""
        import soxr
        import torch
        from denoiser import pretrained
        global _NEURAL
        if _NEURAL is None:
            _NEURAL = pretrained.dns64().eval()
        dry = {"light": 0.5, "medium": 0.25, "strong": 0.0}[strength]
        chans = []
        for c in range(y.shape[0]):
            x = soxr.resample(y[c], sr, 16000).astype(np.float32)
            with torch.no_grad():
                out = _NEURAL(torch.from_numpy(x)[None, None])[0, 0].numpy()
            out = out[: len(x)] * (1 - dry) + x * dry
            chans.append(soxr.resample(out, 16000, sr)[: y.shape[1]])
        n = min(len(c) for c in chans)
        return np.stack([c[:n] for c in chans]).astype(np.float32)


_NEURAL = None
_try_neural()


def parse_spec(spec: str) -> tuple[list[str], str] | None:
    """"neural:medium" -> (["neural"], "medium"); "declick+spectral" -> (["declick", "spectral"], "medium");
    "off" -> None."""
    if spec in ("off", "none", ""):
        return None
    chain, _, strength = spec.partition(":")
    return chain.split("+"), strength or "medium"


def clean_path(audio: pathlib.Path) -> pathlib.Path:
    return audio.with_suffix(".clean.wav")


def apply(y: np.ndarray, sr: int, backends: list[str], strength: str) -> np.ndarray:
    """Run backends in order ("declick+spectral" style chains)."""
    for name in backends:
        if name not in BACKENDS:
            raise SystemExit(f"denoise backend '{name}' is not available "
                             f"({UNAVAILABLE.get(name) or 'unknown; have: ' + ', '.join(available())})")
        y = BACKENDS[name](y, sr, strength)
    return y


def clean(audio: pathlib.Path, backends: list[str], strength: str = "medium",
          out: pathlib.Path | None = None) -> pathlib.Path:
    """Write a denoised copy of `audio` and return its path. The original is never modified."""
    if strength not in STRENGTHS:
        raise SystemExit(f"strength must be one of {', '.join(STRENGTHS)}")
    y, sr = sf.read(str(audio), dtype="float32", always_2d=True)
    y = apply(y.T.copy(), sr, backends, strength)
    out = out or clean_path(audio)
    sf.write(str(out), y.T, sr, subtype="PCM_24")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="apricity-denoise", description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="+", type=pathlib.Path)
    ap.add_argument("--backend", default="spectral", help="one backend or a chain like declick,spectral")
    ap.add_argument("--strength", default="medium", choices=STRENGTHS)
    ap.add_argument("--out", type=pathlib.Path, help="output path (one input file only)")
    a = ap.parse_args(argv)
    for f in a.files:
        print(clean(f, a.backend.split(","), a.strength, a.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
