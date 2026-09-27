"""A sample's audio file can be a symlink (e.g. into another checkout or worktree's copy of the
library). Its manifest must always land as a real file next to the symlink itself -- never next
to whatever the symlink resolves to -- or a "refresh this worktree's manifests" run silently edits
a completely different checkout instead. See analyze()/write()/manifest_path()'s docstrings and
cli.py's up-to-date check for where this is enforced by NOT calling .resolve() on the audio path.
"""

import json

import numpy as np
import soundfile as sf

from apricity_analyze.analyze import manifest_path, write


def _write_tiny_wav(path, sr=8000, dur=0.05, freq=440.0):
    t = np.arange(int(sr * dur)) / sr
    sig = (0.1 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    sf.write(str(path), sig, sr)


def test_manifest_path_follows_the_given_path_not_its_symlink_target(tmp_path):
    real_dir, link_dir = tmp_path / "real", tmp_path / "link"
    real_dir.mkdir()
    link_dir.mkdir()

    real_audio = real_dir / "tone.wav"
    _write_tiny_wav(real_audio)
    symlinked_audio = link_dir / "tone.wav"
    symlinked_audio.symlink_to(real_audio)

    beside_the_symlink = link_dir / "tone.wav.apricity.json"
    beside_the_target = real_dir / "tone.wav.apricity.json"

    assert manifest_path(symlinked_audio) == beside_the_symlink
    # Resolving first (the bug) would have landed here instead -- the two must differ, or this
    # test can't tell a fixed manifest_path() from a still-broken one.
    assert manifest_path(symlinked_audio.resolve()) == beside_the_target
    assert beside_the_symlink != beside_the_target


def test_write_puts_the_manifest_beside_a_symlinked_audio_file_not_its_target(tmp_path):
    real_dir, link_dir = tmp_path / "real", tmp_path / "link"
    real_dir.mkdir()
    link_dir.mkdir()

    real_audio = real_dir / "tone.wav"
    _write_tiny_wav(real_audio)
    symlinked_audio = link_dir / "tone.wav"
    symlinked_audio.symlink_to(real_audio)

    fake_manifest = {"apricity_manifest": 2, "tonal": {"tuning_hz": 440.0, "tuning_cents": 0.0}}
    out = write(fake_manifest, symlinked_audio)

    beside_the_symlink = link_dir / "tone.wav.apricity.json"
    beside_the_target = real_dir / "tone.wav.apricity.json"

    assert out == beside_the_symlink
    assert beside_the_symlink.exists()
    assert not beside_the_target.exists(), "write() must not follow the symlink to its target's directory"
    assert json.loads(beside_the_symlink.read_text()) == fake_manifest
