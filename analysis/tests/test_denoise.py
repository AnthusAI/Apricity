import hashlib

import numpy as np
import pytest
import soundfile as sf

from apricity_analyze import denoise


def _noisy(path, sr=16000, seconds=2):
    rng = np.random.default_rng(0)
    t = np.arange(sr * seconds) / sr
    y = 0.3 * np.sin(2 * np.pi * 440 * t) + 0.05 * rng.standard_normal(len(t))
    sf.write(str(path), y.astype(np.float32), sr)


def test_specs_parse_backends_and_strength():
    assert denoise.parse_spec("neural:medium") == (["neural"], "medium")
    assert denoise.parse_spec("declick+spectral") == (["declick", "spectral"], "medium")
    assert denoise.parse_spec("spectral:strong") == (["spectral"], "strong")
    assert denoise.parse_spec("off") is None


def test_clean_writes_a_copy_and_never_touches_the_original(tmp_path):
    src = tmp_path / "old.wav"
    _noisy(src)
    before = hashlib.sha256(src.read_bytes()).hexdigest()
    out = denoise.clean(src, ["spectral"], "medium")
    assert out == tmp_path / "old.clean.wav" and out.exists()
    assert hashlib.sha256(src.read_bytes()).hexdigest() == before
    assert sf.info(str(out)).frames == sf.info(str(src)).frames


def test_spectral_lowers_the_noise_floor(tmp_path):
    src = tmp_path / "old.wav"
    _noisy(src)
    y, _ = sf.read(str(src))
    c, _ = sf.read(str(denoise.clean(src, ["spectral"], "strong")))
    assert np.std(c[:4000] - 0) <= np.std(y[:4000]) * 1.05  # never louder; hiss is what goes
    assert np.quantile(np.abs(c), 0.1) < np.quantile(np.abs(y), 0.1)


def test_unknown_backend_says_what_is_available(tmp_path):
    src = tmp_path / "old.wav"
    _noisy(src)
    with pytest.raises(SystemExit, match="not available"):
        denoise.clean(src, ["nope"], "medium")


def test_bad_strength_is_refused(tmp_path):
    src = tmp_path / "old.wav"
    _noisy(src)
    with pytest.raises(SystemExit, match="strength"):
        denoise.clean(src, ["spectral"], "extreme")
