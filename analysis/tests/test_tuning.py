"""Tests for the robust tuning estimator (apricity_analyze.analyze.estimate_tuning) and the
tuning-only manifest refresh (apricity_analyze.analyze.refresh_tuning)."""

import copy
import json
import pathlib
import shutil

import numpy as np
import pytest

from apricity_analyze import analyze
from apricity_analyze.analyze import SR, estimate_tuning, manifest_path, refresh_tuning, validate

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"

# A short real sample (audio + manifest) used to exercise the refresh path end to end.
REFRESH_AUDIO = SAMPLES / "citizen-dj" / "loc-edison" / "True-to-the-flag-march_00694039_001_00-01-05.wav"

needs_sample = pytest.mark.skipif(
    not (REFRESH_AUDIO.exists() and manifest_path(REFRESH_AUDIO).exists()),
    reason="sample audio/manifest not available in this checkout",
)


# --------------------------------------------------------------------------- synthetic signals

def _sawtooth_note(freq: float, dur: float, sr: int, n_harmonics: int = 8) -> np.ndarray:
    """A short, faded-in/out multi-harmonic (approximately sawtooth) tone at `freq`."""
    t = np.arange(int(dur * sr)) / sr
    sig = np.zeros_like(t)
    for k in range(1, n_harmonics + 1):
        sig += (1.0 / k) * np.sin(2 * np.pi * freq * k * t)
    fade = int(0.01 * sr)
    env = np.ones_like(t)
    env[:fade] = np.linspace(0.0, 1.0, fade)
    env[-fade:] = np.linspace(1.0, 0.0, fade)
    return (sig * env).astype(np.float32)


def _detuned_melody(cents: float, sr: int = SR) -> np.ndarray:
    """A few harmonic-rich notes, all detuned from equal temperament by `cents`."""
    ratio = 2 ** (cents / 1200.0)
    notes = [220.0, 277.18, 329.63, 440.0]  # A3 C#4 E4 A4, all scaled by the same detuning
    parts = [_sawtooth_note(f * ratio, 0.6, sr) for f in notes]
    return np.concatenate(parts) * 0.3


# --------------------------------------------------------------------------- estimate_tuning

@pytest.mark.parametrize("cents", [-20, -8, 0, 8, 20])
def test_synthetic_detuned_tone_is_estimated_within_3_cents(cents):
    signal = _detuned_melody(cents)
    estimate, flags = estimate_tuning(signal, SR)
    assert not flags["uncertain"], flags
    assert abs(estimate - cents) <= 3.0, f"expected ~{cents}, got {estimate} ({flags})"


def test_disagreeing_estimators_yield_zero_and_uncertain_flag(monkeypatch):
    # Force the two independent estimators far enough apart that they cannot be trusted together;
    # this is exactly the failure mode seen on ccMixter mixes where essentia pins to one value
    # while librosa reads several cents (here, deliberately tens of cents) away.
    monkeypatch.setattr(analyze, "_essentia_tuning_cents", lambda audio: -23.0)
    monkeypatch.setattr(analyze, "_librosa_tuning_cents", lambda audio, sr: 1.0)

    estimate, flags = estimate_tuning(np.zeros(SR, dtype=np.float32), SR)

    assert estimate == 0.0
    assert flags["uncertain"] is True


def test_edge_pinned_essentia_value_is_discarded(monkeypatch):
    # A result sitting on essentia's documented output range is suspect on its own, even before
    # comparing it to the other estimator: with only one estimator left, we can't confirm
    # agreement, so the overall result must be uncertain.
    monkeypatch.setattr(analyze, "_essentia_tuning_cents", lambda audio: -35.0)
    monkeypatch.setattr(analyze, "_librosa_tuning_cents", lambda audio, sr: -34.0)

    estimate, flags = estimate_tuning(np.zeros(SR, dtype=np.float32), SR)

    assert flags["essentia_edge_pinned"] is True
    assert estimate == 0.0
    assert flags["uncertain"] is True


def test_agreeing_estimators_combine():
    monkeypatch_targets = {"_essentia_tuning_cents": lambda audio: 5.0, "_librosa_tuning_cents": lambda audio, sr: 7.0}
    import unittest.mock as mock

    with mock.patch.object(analyze, "_essentia_tuning_cents", monkeypatch_targets["_essentia_tuning_cents"]), \
         mock.patch.object(analyze, "_librosa_tuning_cents", monkeypatch_targets["_librosa_tuning_cents"]):
        estimate, flags = estimate_tuning(np.zeros(SR, dtype=np.float32), SR)

    assert not flags["uncertain"]
    assert estimate == pytest.approx(6.0)


# --------------------------------------------------------------------------- refresh_tuning

@needs_sample
def test_refresh_tuning_changes_only_tuning_fields(tmp_path):
    audio = tmp_path / REFRESH_AUDIO.name
    shutil.copy(REFRESH_AUDIO, audio)
    mpath = manifest_path(audio)
    shutil.copy(manifest_path(REFRESH_AUDIO), mpath)

    original = json.loads(mpath.read_text())
    # Corrupt the tuning fields the way the old buggy estimator could, to make sure refresh
    # actually rewrites them rather than trivially matching by coincidence.
    tampered = copy.deepcopy(original)
    tampered["tonal"]["tuning_hz"] = 434.19
    tampered["tonal"]["tuning_cents"] = -23.0
    tampered["tonal"].pop("tuning_uncertain", None)
    mpath.write_text(json.dumps(tampered, indent=1) + "\n")

    result = refresh_tuning(audio)
    assert result is not None
    old_cents, new_cents, uncertain = result
    assert old_cents == -23.0

    updated = json.loads(mpath.read_text())
    validate(updated)

    # Only tonal.tuning_hz / tuning_cents / tuning_uncertain may differ; everything else,
    # including the rest of `tonal`, must be byte-for-byte the same as the tampered input.
    before_sans_tuning = copy.deepcopy(tampered)
    after_sans_tuning = copy.deepcopy(updated)
    for d in (before_sans_tuning, after_sans_tuning):
        d["tonal"].pop("tuning_hz", None)
        d["tonal"].pop("tuning_cents", None)
        d["tonal"].pop("tuning_uncertain", None)
    assert before_sans_tuning == after_sans_tuning

    assert updated["tonal"]["tuning_cents"] == new_cents
    assert updated["tonal"]["tuning_hz"] == pytest.approx(440.0 * 2 ** (new_cents / 1200.0), abs=0.01)
    assert updated["tonal"].get("tuning_uncertain", False) == uncertain


@needs_sample
def test_refresh_tuning_is_idempotent(tmp_path):
    audio = tmp_path / REFRESH_AUDIO.name
    shutil.copy(REFRESH_AUDIO, audio)
    mpath = manifest_path(audio)
    shutil.copy(manifest_path(REFRESH_AUDIO), mpath)

    refresh_tuning(audio)
    first = mpath.read_text()
    refresh_tuning(audio)
    second = mpath.read_text()

    assert first == second
