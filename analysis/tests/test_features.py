"""Tests for the fit-feature sidecar (`apricity_analyze.features`) and the CLAP embeddings
(`apricity_analyze.clap`), Kanbus apricitus-798704.

The feature-extraction tests build one short synthetic signal on a known 1-second beat grid: a
60 Hz tone for the first half (tonal, bass-heavy) and white noise for the second half (non-tonal),
with short click impulses dropped at known times to exercise onset detection. All run fast, no
real library audio needed.

The CLAP tests are split: the windowing helper (`clap.bar_grid_windows`) is pure arithmetic and
always runs; anything that needs the actual model is skipped unless the checkpoint is already in
the local Hugging Face cache (`clap.is_model_cached`), so `pytest` never triggers an ~780 MB
download on its own.
"""

from __future__ import annotations

import pathlib

import numpy as np
import pytest

from apricity_analyze import clap, features
from apricity_analyze.analyze import SR


# --------------------------------------------------------------------------- synthetic signal

BPM = 60.0
BEAT_S = 60.0 / BPM  # 1.0 s
N_BEATS = 8  # 8 one-second intervals => 8 s total, 9 beat markers
CLICK_BEATS = (1, 3, 5, 6)  # beat *intervals* that get a click near their start


def _tone(freq: float, dur: float, sr: int = SR, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(dur * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _click(sr: int = SR, amp: float = 0.9) -> np.ndarray:
    """A single-sample-ish impulse, widened slightly so it survives resampling/windowing."""
    n = int(0.003 * sr)
    return (amp * np.hanning(n)).astype(np.float32)


def _synthetic_signal(rng: np.random.Generator) -> np.ndarray:
    half = N_BEATS // 2
    tone = _tone(60.0, half * BEAT_S)  # bass-range pure tone: high tonalness, bass_share ~ 1
    noise = (0.2 * rng.standard_normal(int(half * BEAT_S * SR))).astype(np.float32)
    sig = np.concatenate([tone, noise])
    for b in CLICK_BEATS:
        start = int((b * BEAT_S + 0.01) * SR)
        click = _click()
        sig[start:start + len(click)] += click
    return sig


def _beats() -> list[float]:
    return [i * BEAT_S for i in range(N_BEATS + 1)]


@pytest.fixture
def synthetic_wav(tmp_path: pathlib.Path) -> pathlib.Path:
    import soundfile as sf

    rng = np.random.default_rng(0)
    sig = _synthetic_signal(rng)
    path = tmp_path / "synthetic.wav"
    sf.write(str(path), sig, SR)
    return path


# --------------------------------------------------------------------------- compute_features

def test_too_few_beats_returns_none(synthetic_wav):
    assert features.compute_features(synthetic_wav, [0.0], "deadbeef") is None
    assert features.compute_features(synthetic_wav, [], "deadbeef") is None


def test_tonalness_high_for_tone_low_for_noise(synthetic_wav):
    feats = features.compute_features(synthetic_wav, _beats(), "deadbeef")
    assert feats is not None
    tone_beats = feats.beat_tonalness[:4]
    noise_beats = feats.beat_tonalness[4:]
    assert tone_beats.mean() > 0.5, tone_beats
    assert noise_beats.mean() < tone_beats.mean(), (noise_beats, tone_beats)


def test_bass_share_near_one_for_60hz_tone(synthetic_wav):
    feats = features.compute_features(synthetic_wav, _beats(), "deadbeef")
    assert feats is not None
    tone_beats = feats.beat_bass_share[:4]
    assert tone_beats.mean() > 0.9, tone_beats


def test_onsets_land_near_the_clicks(synthetic_wav):
    feats = features.compute_features(synthetic_wav, _beats(), "deadbeef")
    assert feats is not None
    # Quarter-beat index whose window contains "just after the beat starts" (where every click sits).
    for b in CLICK_BEATS:
        q = b * features.QUARTERS_PER_BEAT  # the first quarter of beat interval b
        window = feats.beat_onset_count[q:q + 1]
        strength_window = feats.beat_onset_strength[q:q + 1]
        assert window.sum() >= 1 or strength_window.max() > 0, (b, feats.beat_onset_count, feats.beat_onset_strength)
    # A quarter-beat with no click nearby should generally have zero detected onset events.
    quiet_q = 7 * features.QUARTERS_PER_BEAT + 2  # deep into a noise beat with no click
    assert feats.beat_onset_count[quiet_q] == 0


def test_array_shapes(synthetic_wav):
    feats = features.compute_features(synthetic_wav, _beats(), "deadbeef")
    assert feats is not None
    b = N_BEATS
    assert feats.beat_tonalness.shape == (b,)
    assert feats.beat_bass_share.shape == (b,)
    assert feats.beat_bands.shape == (b * 4, features.N_BANDS)
    assert feats.beat_onset_strength.shape == (b * 4,)
    assert feats.beat_onset_count.shape == (b * 4,)


# --------------------------------------------------------------------------- sidecar sha-keyed skip

def test_sidecar_sha_keyed_skip(tmp_path, synthetic_wav):
    feats = features.compute_features(synthetic_wav, _beats(), "shaAAA")
    assert feats is not None
    sidecar = tmp_path / "synthetic.fitfeat.npz"
    features.write_sidecar(sidecar, feats)

    assert features.is_up_to_date(sidecar, "shaAAA") is True
    assert features.is_up_to_date(sidecar, "shaBBB") is False
    assert features.read_sidecar_sha(sidecar) == "shaAAA"
    assert features.read_sidecar_sha(tmp_path / "missing.fitfeat.npz") is None


def test_sidecar_path_for():
    p = pathlib.Path("samples/loc/foo.wav.apricity.json")
    assert features.sidecar_path_for(p) == pathlib.Path("samples/loc/foo.wav.fitfeat.npz")


# --------------------------------------------------------------------------- CLAP: windowing (no model needed)

def test_bar_grid_windows_basic():
    # 9 downbeats (2-second bars) => one full 4-bar window [0, 8) with one bar left over.
    downbeats = [0.0, 2.0, 4.0, 6.0, 8.0, 10.0]
    beats = [i * 0.5 for i in range(21)]  # 0.5 s beats, plenty to cover 10 s
    windows = clap.bar_grid_windows(downbeats, beats, bars_per_window=4)
    assert len(windows) == 1
    w = windows[0]
    assert w.start_s == 0.0 and w.end_s == 8.0
    assert w.start_beat == pytest.approx(0.0)
    assert w.end_beat == pytest.approx(16.0)


def test_bar_grid_windows_too_short_is_empty():
    assert clap.bar_grid_windows([0.0, 2.0], [0.0, 1.0, 2.0], bars_per_window=4) == []


def test_bar_grid_windows_non_overlapping_and_covers_full_bars():
    downbeats = [float(i) for i in range(13)]  # 12 one-second bars
    beats = [i * 0.5 for i in range(25)]
    windows = clap.bar_grid_windows(downbeats, beats, bars_per_window=4)
    assert [round(w.start_s) for w in windows] == [0, 4, 8]
    assert [round(w.end_s) for w in windows] == [4, 8, 12]


def test_beat_at_interpolates():
    beats = [0.0, 1.0, 2.0, 3.0]
    assert clap._beat_at(0.0, beats) == pytest.approx(0.0)
    assert clap._beat_at(1.5, beats) == pytest.approx(1.5)
    assert clap._beat_at(-5.0, beats) == pytest.approx(0.0)  # clamps below range
    assert clap._beat_at(50.0, beats) == pytest.approx(3.0)  # clamps above range


def test_embed_windows_uses_a_fake_embed_function(monkeypatch, synthetic_wav):
    """Unit-test the windowing/slicing glue in `embed_windows` without loading the real model:
    monkeypatch `embed_audio_batch` with a fake that just checks it was handed the right number
    of (correctly sliced) clips."""
    calls = []

    def fake_embed_audio_batch(clips, sr, checkpoint=clap.CHECKPOINT):
        calls.append([len(c) for c in clips])
        return np.zeros((len(clips), clap.EMBED_DIM), dtype=np.float32)

    monkeypatch.setattr(clap, "embed_audio_batch", fake_embed_audio_batch)

    mono = _synthetic_signal(np.random.default_rng(0))
    windows = [clap.Window(start_s=0.0, end_s=2.0, start_beat=0.0, end_beat=2.0),
               clap.Window(start_s=2.0, end_s=5.0, start_beat=2.0, end_beat=5.0)]
    out = clap.embed_windows(mono, SR, windows)
    assert out.shape == (2, clap.EMBED_DIM)
    assert calls == [[int(2.0 * SR) - int(0.0 * SR), int(5.0 * SR) - int(2.0 * SR)]]


# --------------------------------------------------------------------------- CLAP: needs the real model

needs_clap_model = pytest.mark.skipif(
    not clap.is_model_cached(), reason=f"{clap.CHECKPOINT} not in the local HF cache (would need a download)"
)


@needs_clap_model
def test_embed_audio_and_text_are_l2_normalized_and_comparable():
    sig = _tone(220.0, 2.0)
    vec = clap.embed_audio(sig, SR)
    assert vec.shape == (clap.EMBED_DIM,)
    assert np.linalg.norm(vec) == pytest.approx(1.0, abs=1e-3)

    text_vec = clap.embed_text("a sine tone")
    assert text_vec.shape == (clap.EMBED_DIM,)
    assert np.linalg.norm(text_vec) == pytest.approx(1.0, abs=1e-3)
