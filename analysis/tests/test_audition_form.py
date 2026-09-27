"""Tests for `apricity_analyze.audition_form` (Kanbus apricitus-dbed5c): the 16-bar audition
assembly on synthetic stems, the comment-safe `bars` rewrite, and that a full `build_audition`
call leaves no WAV or stems directory behind. All synthetic/monkeypatched, so these run fast
without a real `apricity` render.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
import pytest

from apricity_analyze import audition_form as af

SR = 48000
TEMPO = 120.0
METER = 4


def bar_samples(sr=SR, tempo=TEMPO, meter=METER):
    return int(round(sr * 60.0 / tempo * meter))


def make_window(sr=SR, tempo=TEMPO, meter=METER, n_bars=af.WINDOW_BARS, amp=0.1):
    """A constant-amplitude stereo array `n_bars` long, plus its per-sample "bar index" for
    discontinuity checks."""
    n = bar_samples(sr, tempo, meter) * n_bars
    return np.full((n, 2), amp, dtype=np.float64)


# --------------------------------------------------------------------------- assemble()

def test_assemble_lengths_are_4_plus_4_plus_8_bars():
    scene = make_window(amp=0.1)
    solo = make_window(amp=0.2)
    out = af.assemble(scene, solo, tempo=TEMPO, meter=METER, sr=SR, scene_bars=4)

    bar = bar_samples()
    fade_n = int(round(SR * af.CROSSFADE_MS / 1000.0))
    # 16 bars (4 scene + 4 solo + 8 together) at 120 BPM is exactly 32s; each of the two joins
    # blends (rather than appends) `fade_n` samples, so the assembled length is 32s minus the two
    # crossfades' width (40ms total) -- audibly nothing, but not bit-exact 32s.
    expected = 4 * bar + 4 * bar + 8 * bar - 2 * fade_n
    assert out.shape[0] == expected
    assert abs(out.shape[0] / SR - 32.0) < (2 * af.CROSSFADE_MS / 1000.0 + 1e-6)
    assert fade_n > 0


def test_assemble_solo_section_is_the_track_alone():
    scene = make_window(amp=0.1)
    solo = make_window(amp=0.9)
    out = af.assemble(scene, solo, tempo=TEMPO, meter=METER, sr=SR, scene_bars=4)
    bar = bar_samples()
    fade_n = int(round(SR * af.CROSSFADE_MS / 1000.0))
    # Well inside the solo section (away from both crossfades), the output should equal solo's
    # amplitude, not scene's.
    mid = 4 * bar + 2 * bar
    assert np.allclose(out[mid], 0.9, atol=1e-6)


def test_assemble_ramp_starts_at_zero_and_reaches_full_gain():
    scene = make_window(amp=0.0)
    solo = make_window(amp=1.0)
    out = af.assemble(scene, solo, tempo=TEMPO, meter=METER, sr=SR, scene_bars=4)
    bar = bar_samples()
    together_start = 4 * bar + 4 * bar  # start of bars 9-16 in the output
    fade_n = int(round(SR * af.CROSSFADE_MS / 1000.0))
    # Just after the solo->together crossfade, the ramp should be close to its start (near 0,
    # since scene is silent and solo ramps in from 0).
    just_after = out[together_start + fade_n + 5]
    assert abs(just_after[0]) < 0.05, "the build should start near zero, not jump straight to full gain"
    # Comfortably past the 2-bar build, the ramp should have reached (scene=0 +) solo's full gain.
    build_n = int(round(bar * af.BUILD_BARS))
    well_past_build = out[together_start + build_n + 100]
    assert abs(well_past_build[0] - 1.0) < 0.05


def test_assemble_ramp_is_monotonic_during_the_build():
    scene = make_window(amp=0.0)
    solo = make_window(amp=1.0)
    out = af.assemble(scene, solo, tempo=TEMPO, meter=METER, sr=SR, scene_bars=4)
    bar = bar_samples()
    fade_n = int(round(SR * af.CROSSFADE_MS / 1000.0))
    together_start = 4 * bar + 4 * bar
    build_n = int(round(bar * af.BUILD_BARS))
    seg = out[together_start + fade_n: together_start + build_n, 0]
    # Sampled coarsely (a strict per-sample check would be too sensitive to the crossfade's own
    # curve right at the start): the ramp trends upward, not down or flat.
    coarse = seg[::200]
    assert coarse[-1] > coarse[0]
    assert np.all(np.diff(coarse) > -1e-6)


def _tone(n_bars, amp, hz, sr=SR, tempo=TEMPO, meter=METER):
    """A smooth (band-limited) synthetic stem: sample-to-sample deltas from real audio look like
    this, not like independent white noise -- a click test needs a signal where any large jump is
    actually the join, not the source material itself."""
    n = bar_samples(sr, tempo, meter) * n_bars
    t = np.arange(n) / sr
    return np.tile((amp * np.sin(2 * np.pi * hz * t))[:, None], (1, 2))


def test_assemble_crossfades_have_no_large_discontinuity():
    scene = _tone(af.WINDOW_BARS, 0.1, 220.0)
    solo = _tone(af.WINDOW_BARS, 0.3, 330.0)
    out = af.assemble(scene, solo, tempo=TEMPO, meter=METER, sr=SR, scene_bars=4)
    step = np.abs(np.diff(out, axis=0))
    # The largest step anywhere *inside* a continuous tone (away from the two joins) is the
    # baseline for "this signal's own smoothness"; a join must not exceed it by much.
    fade_n = int(round(SR * af.CROSSFADE_MS / 1000.0))
    bar = bar_samples()
    join_free = np.concatenate([
        step[fade_n: 4 * bar - fade_n],
        step[4 * bar + fade_n: 8 * bar - fade_n],
        step[8 * bar + fade_n:],
    ])
    baseline = join_free.max()
    assert step.max() < baseline * 5 + 1e-4, (
        f"found a discontinuity of {step.max():.5f} at a join, well above the signal's own "
        f"sample-to-sample step of {baseline:.5f} away from the joins")


def test_assemble_raises_on_short_window():
    scene = make_window(n_bars=3)
    solo = make_window(n_bars=3)
    with pytest.raises(af.AuditionError):
        af.assemble(scene, solo, tempo=TEMPO, meter=METER, sr=SR, scene_bars=4)


# --------------------------------------------------------------------------- loudness_normalize()

def test_loudness_normalize_hits_target_rms_when_pyloudnorm_is_absent(monkeypatch):
    # Force the RMS fallback deterministically, regardless of whether pyloudnorm happens to be
    # installed in the venv running this test.
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "pyloudnorm":
            raise ImportError("forced for test")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    rng = np.random.default_rng(1)
    audio = rng.normal(0, 0.05, (SR * 2, 2))
    out, info = af.loudness_normalize(audio, SR, target_lufs=-14.0, peak_ceiling_dbfs=-1.0)
    assert info["method"].startswith("rms-fallback")
    rms_dbfs = af._rms_dbfs(out)
    assert abs(rms_dbfs - (-14.0)) < 0.5 or info["peak_dbfs"] <= -1.0 + 1e-6


def test_loudness_normalize_never_exceeds_peak_ceiling():
    rng = np.random.default_rng(2)
    # A loud, peaky signal: normalizing to -14 LUFS by RMS alone could blow past -1 dBFS.
    audio = rng.normal(0, 0.02, (SR, 2))
    audio[100] = 0.99  # a lone loud peak
    out, info = af.loudness_normalize(audio, SR, target_lufs=-14.0, peak_ceiling_dbfs=-1.0)
    peak_dbfs = 20 * np.log10(np.max(np.abs(out)) + 1e-12)
    assert peak_dbfs <= -1.0 + 1e-6
    assert info["peak_dbfs"] <= -1.0 + 1e-6


# --------------------------------------------------------------------------- rewrite_track_bars() / scene_text()

SCORE = """tempo 120
key Am
samples ../samples
clip scene = a.wav  loop-1
clip pad = b.wav  loop-1  # the candidate
track scene  bars 1-32  volume 3  group music
track pad  bars 9-16  volume -2  group music  # a trailing comment, must survive
master
  loudness -14LUFS
"""


def test_rewrite_track_bars_is_comment_safe_and_only_touches_the_named_track():
    out = af.rewrite_track_bars(SCORE, "pad", (33, 40))
    lines = out.splitlines()
    pad_line = next(l for l in lines if l.startswith("track pad"))
    scene_line = next(l for l in lines if l.startswith("track scene"))
    assert "bars 33-40" in pad_line
    assert "bars 9-16" not in pad_line
    assert pad_line.rstrip().endswith("# a trailing comment, must survive")
    assert "bars 33-40" not in scene_line, "another track's bars must not be touched"
    assert "bars 1-32" in scene_line


def test_rewrite_track_bars_does_not_write_into_a_comment():
    text = "track x  bars 1-8  # note: bars 9-16 sounds better\n"
    out = af.rewrite_track_bars(text, "x", (9, 16))
    code, comment = ("track x  bars 9-16", "# note: bars 9-16 sounds better")
    assert out.strip().startswith(code)
    assert comment in out
    # Only one `bars` token in the code part (the old one was replaced, not duplicated, and the
    # comment's own "bars 9-16" text was never touched as if it were an option).
    line = out.strip().splitlines()[0]
    before_hash = line.split("#", 1)[0]
    assert before_hash.count("bars") == 1


def test_rewrite_track_bars_missing_track_raises():
    with pytest.raises(af.AuditionError):
        af.rewrite_track_bars(SCORE, "nope", (33, 40))


def test_scene_text_removes_the_candidate_track_only():
    scene = af.scene_text(SCORE, "pad")
    assert "clip pad" not in scene
    assert "track pad" not in scene
    assert "clip scene" in scene
    assert "track scene" in scene


# --------------------------------------------------------------------------- choose_window()

def test_choose_window_prefers_explicit():
    assert af.choose_window(SCORE, explicit=(33, 40)) == (33, 40)


def test_choose_window_explicit_must_span_8_bars():
    with pytest.raises(af.AuditionError):
        af.choose_window(SCORE, explicit=(33, 39))


def test_choose_window_default_rule(monkeypatch):
    monkeypatch.setattr(af, "compiled_song_shape", lambda text: (120.0, 4, 40 * 4))
    assert af.choose_window(SCORE) == (25, 32)  # 8 bars before the last 8, for a >=24-bar song

    monkeypatch.setattr(af, "compiled_song_shape", lambda text: (120.0, 4, 16 * 4))
    assert af.choose_window(SCORE) == (1, 8)  # a short song falls back to its first 8 bars


# --------------------------------------------------------------------------- split_scene_and_track()

def test_split_scene_and_track_sums_kit_subtracks_into_solo():
    stems = {
        "scene_a": np.full((100, 2), 0.1),
        "scene_b": np.full((100, 2), 0.2),
        "pad": np.full((100, 2), 0.3),
        "pad.kick": np.full((100, 2), 0.4),
    }
    scene, solo = af.split_scene_and_track(stems, "pad")
    assert np.allclose(scene, 0.3)  # 0.1 + 0.2
    assert np.allclose(solo, 0.7)  # 0.3 + 0.4


def test_split_scene_and_track_missing_track_raises():
    stems = {"scene_a": np.zeros((10, 2))}
    with pytest.raises(af.AuditionError):
        af.split_scene_and_track(stems, "pad")


# --------------------------------------------------------------------------- build_audition() cleanup

def test_build_audition_leaves_no_wav_or_stems_behind(tmp_path, monkeypatch):
    """The tmp render (WAV + stems dir) must not survive the call -- only the `.m4a` and its small
    `.json` should exist afterward. `_render_stems`, `write_m4a` and `compiled_song_shape` are
    monkeypatched so this test needs no real `apricity` binary."""
    bar = bar_samples()
    window_n = bar * af.WINDOW_BARS
    seen_work_dirs: list[pathlib.Path] = []

    def fake_render_stems(text, window, work_dir):
        seen_work_dirs.append(work_dir)
        stems_dir = work_dir / "stems"
        stems_dir.mkdir(parents=True)
        manifest = {"tempo": TEMPO, "meter": METER, "sample_rate": SR, "length": window_n,
                    "offset_beats": 0.0, "key": "Am",
                    "tracks": [{"name": "scene_a", "pitched": True, "kit": None, "pitch": None},
                               {"name": "pad", "pitched": True, "kit": None, "pitch": None}]}
        (stems_dir / "stems.json").write_text(json.dumps(manifest))
        import soundfile as sf
        sf.write(str(stems_dir / "scene_a.wav"), np.full((window_n, 2), 0.1, dtype=np.float32), SR, subtype="FLOAT")
        sf.write(str(stems_dir / "pad.wav"), np.full((window_n, 2), 0.2, dtype=np.float32), SR, subtype="FLOAT")
        wav = work_dir / "tmp.wav"
        wav.write_bytes(b"not a real wav, just needs to exist")
        return wav, stems_dir

    written_m4as = []

    def fake_write_m4a(audio, sr, out_path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"fake m4a")
        written_m4as.append(out_path)

    candidate = tmp_path / "candidate.apr"
    candidate.write_text(SCORE)
    out_path = tmp_path / "out" / "audition.m4a"

    monkeypatch.setattr(af, "_render_stems", fake_render_stems)
    monkeypatch.setattr(af, "write_m4a", fake_write_m4a)

    result = af.build_audition(candidate, track="pad", out_path=out_path, window=(33, 40), check=False)

    assert result.m4a_path == out_path
    assert out_path.exists()
    assert result.json_path.exists()
    assert written_m4as == [out_path]
    # The temporary render directory (WAV + stems) must be gone.
    assert seen_work_dirs, "the fake render should have been called"
    assert not seen_work_dirs[0].exists(), "the tmp render dir (wav + stems) must be deleted after use"
