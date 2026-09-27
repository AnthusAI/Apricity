"""Renders bar 35 (Fmaj7/VImaj7) of `examples/ave-emerge.apr` through the sample library, for the
real-audio bass-stem sanity test. NO AUDIO IS EVER WRITTEN INTO THIS (git-tracked) fixtures
directory: `render_bar35` writes only to a directory the CALLER gives it (a pytest `tmp_path`, or
any other location outside the repo) -- never into `analysis/tests/fixtures/harmony2/`.

`library_available()` gates everything here: on a fresh clone, or in CI, the sample audio
(`samples/*.mp3`, `samples/salamander-drumkit/**/*.wav`) is not checked out (it's real,
copyrighted-adjacent recordings, never committed), so any test that needs it must check this
first and skip with a clear reason rather than fail.
"""

from __future__ import annotations

import math
import os
import pathlib
import subprocess

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

# analysis/tests/fixtures/harmony2/emerge_fixture.py -> repo root
REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
SCORE = REPO_ROOT / "examples" / "ave-emerge.apr"
BINARY = pathlib.Path("/Users/home/Projects/Apricity/target/release/apricity")
# Overridable so the "library absent" case can be exercised end-to-end (including by
# `test_bass_stem_sanity_real_emerge_bar35`'s skip path) without touching the real samples/
# directory -- point this at an empty directory to simulate a fresh clone / CI.
DEFAULT_SAMPLES_ROOT = pathlib.Path(os.environ["APRICITY_HARMONY2_SAMPLES_ROOT"]) if os.environ.get("APRICITY_HARMONY2_SAMPLES_ROOT") else REPO_ROOT / "samples"
TARGET_SR = 22050

# The audio files this specific excerpt (bar 35: the `bright` and `low` tracks) needs. Checked
# with `samples_root` as the base so `library_available` can be tested against an arbitrary
# (e.g. empty) directory without touching the real one.
REQUIRED_FILES = [
    "ccmixter/AlexBeroza/Ave_34409.mp3",
    "ccmixter/AlexBeroza/Emerge_30132.mp3",
]


class LibraryUnavailable(RuntimeError):
    """Raised by `render_bar35` when `samples_root` doesn't have the audio this excerpt needs,
    or the release binary/score aren't where expected. Tests catch this and `pytest.skip`."""


def library_available(samples_root: pathlib.Path) -> bool:
    """True when every audio file this excerpt needs exists (as a real file or a resolving
    symlink) under `samples_root`. Pass an empty directory to prove this returns `False`."""
    return all((samples_root / f).exists() for f in REQUIRED_FILES)


def _to_mono(y: np.ndarray) -> np.ndarray:
    return y.mean(axis=1) if y.ndim > 1 else y


def _resample(y: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return y.astype(np.float32).astype(np.float64)
    g = math.gcd(src_sr, dst_sr)
    up, down = dst_sr // g, src_sr // g
    return resample_poly(y, up, down).astype(np.float32).astype(np.float64)


def render_bar35(out_dir: pathlib.Path, samples_root: pathlib.Path = DEFAULT_SAMPLES_ROOT, binary: pathlib.Path = BINARY) -> dict:
    """Renders `examples/ave-emerge.apr --bars 35-35 --stems` into `out_dir` (the caller's job to
    make this a scratch location, e.g. a pytest `tmp_path`), and returns the two pitched stems
    downsampled to 22.05 kHz mono, plus the span this bar's chord names:
    `{"low": ndarray, "bright": ndarray, "sr": 22050, "chord": str, "chord_tones": [str], "bass": str}`.

    Raises `LibraryUnavailable` (does NOT invoke the renderer) when `samples_root` is missing the
    audio this excerpt needs, or the score/binary aren't present -- the "library absent" case.
    """
    if not library_available(samples_root):
        raise LibraryUnavailable(f"sample audio not found under {samples_root} (need: {REQUIRED_FILES}) -- this excerpt only renders when the real library is checked out")
    if not SCORE.exists():
        raise LibraryUnavailable(f"score not found: {SCORE}")
    if not binary.exists():
        raise LibraryUnavailable(f"apricity binary not found: {binary} (build it once with `cargo build --release -p apricity-cli`)")

    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [str(binary), "render", str(SCORE), "--bars", "35-35", "--stems", str(out_dir), "-o", str(out_dir / "mix.wav")],
        cwd=str(SCORE.parent),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise LibraryUnavailable(f"render failed (rc={proc.returncode}): {proc.stderr[-2000:]}")

    import json

    meta = json.loads((out_dir / "stems.json").read_text())
    offset = meta["offset_beats"]
    span = next(s for s in meta["harmony"] if s["start_beat"] <= offset < s["end_beat"])

    low_y, low_sr = sf.read(out_dir / "low.wav")
    bright_y, bright_sr = sf.read(out_dir / "bright.wav")
    return {
        "low": _resample(_to_mono(low_y), low_sr, TARGET_SR),
        "bright": _resample(_to_mono(bright_y), bright_sr, TARGET_SR),
        "sr": TARGET_SR,
        "chord": span["chord"],
        "chord_tones": span["chord_tones"],
        "bass": span["chord_tones"][0],
    }
