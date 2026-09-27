"""The 16-bar audition form (Kanbus apricitus-dbed5c): judge a candidate layer the way the user
actually listens to it, not by rendering (and keeping) a full 40-bar take.

    apricity render <candidate.apr> --bars W -o tmp.wav --stems tmp.stems   # once
    bars 1-4 of W:  the existing scene alone
    bars 5-8 of W:  the new/re-cast track (TRACK) alone
    bars 9-16 of W: both together, TRACK ramped in (linear gain) over the first 2 bars

16 bars at 120 BPM = 32 s. Documented for humans in
`.agents/skills/write-score/references/recipes.md` ("Auditioning a layer (the 16-bar form)").

A window W is 8 bars chosen where the scene is in full groove (`choose_window`); the candidate's
TRACK is rewritten (comment-safe, via `explore.ops._split_comment`/`_edit_code`) so it plays
across all of W for the audition render only -- the source `.apr` file on disk is never touched.

Everything is rendered exactly once (`--bars W --stems`); the WAV and stems directory are deleted
as soon as the audition (and, with `--check`, the harmony objective) have been computed from them
-- only the final `.m4a` and a small JSON of numbers survive (Kanbus apricitus-ae80d4: the explorer
and, before it, the optimizer, blew the disk by keeping renders around).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile

import numpy as np

from .explore import ops as ops_mod

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "target/release/apricity"
RENDER_TIMEOUT_S = 300

SCENE_BARS_DEFAULT = 4
SOLO_BARS_DEFAULT = 4
BUILD_BARS = 2          # bars 9-10 of the 16-bar form: TRACK ramps 0 -> 1
TOGETHER_BARS = 8       # bars 9-16 of the 16-bar form (all of W)
WINDOW_BARS = 8         # |W|
CROSSFADE_MS = 20.0
TARGET_LUFS = -14.0
PEAK_CEILING_DBFS = -1.0


class AuditionError(RuntimeError):
    """A render, or the audition assembly, failed in a way the caller should surface, not retry."""


# --------------------------------------------------------------------------- score text helpers

def absolutize_samples(text: str) -> str:
    """Same fix as `explore.evaluate.absolutize_samples`: a tmp copy of the score, written under
    a scratch directory, still needs to resolve `samples <path>` relative to the repo, not to
    wherever the tmp copy happens to live."""
    import re
    return re.sub(r"^samples\s+\S.*$", f"samples {ROOT / 'samples'}", text, count=1, flags=re.M)


def compiled_song_shape(text: str) -> tuple[float, int, float]:
    """`(tempo, meter, length_beats)` from `apricity compile` (<10ms; no render), so the default
    window can be chosen before anything is rendered."""
    with tempfile.NamedTemporaryFile("w", suffix=".apr", delete=False) as f:
        f.write(absolutize_samples(text))
        tmp_path = pathlib.Path(f.name)
    try:
        r = subprocess.run([str(BIN), "compile", str(tmp_path)], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AuditionError(f"compile failed: {r.stderr.strip()[-500:]}")
        d = json.loads(r.stdout)
        return float(d["tempo"]), int(d["meter"]), float(d["length_beats"])
    finally:
        tmp_path.unlink(missing_ok=True)


def choose_window(text: str, explicit: tuple[int, int] | None = None) -> tuple[int, int]:
    """The 8-bar window W (1-based, inclusive) where the scene is judged: an explicit `--window`
    always wins (recommended -- e.g. bars 33-40, the drop, for an Ave-House-shaped score). Absent
    that, the default is the 8 bars right before the song's last 8 bars when the song is >= 24
    bars, else its first 8 bars."""
    if explicit is not None:
        a, b = explicit
        if b - a + 1 != WINDOW_BARS:
            raise AuditionError(f"--window must span exactly {WINDOW_BARS} bars, not {a}-{b}")
        return explicit
    _, meter, length_beats = compiled_song_shape(text)
    total_bars = int(round(length_beats / meter))
    if total_bars >= 24:
        return (total_bars - 15, total_bars - 8)
    return (1, min(WINDOW_BARS, total_bars))


def rewrite_track_bars(text: str, track: str, window: tuple[int, int]) -> str:
    """Rewrite `track TRACK ...` (and any `track TRACK.<pad> ...` kit sub-track lines) so `bars`
    covers all of `window`, for the audition render only. Comment-safe: uses `ops._split_comment`
    / `ops._edit_code` so an option is never written into, or matched inside, a trailing comment.
    Doesn't touch any other track."""
    import re

    a, b = window

    def edit(code: str) -> str:
        code = re.sub(r"\s+bars\s+\S+", "", code).rstrip()
        return f"{code}  bars {a}-{b}"

    pat = re.compile(rf"^track\s+{re.escape(track)}(\.[\w-]+)?(\s|$)")
    lines = text.splitlines()
    touched = False
    for i, line in enumerate(lines):
        if not pat.match(line):
            continue
        lines[i] = ops_mod._edit_code(line, edit)
        touched = True
    if not touched:
        raise AuditionError(f"no `track {track}` line in the candidate score")
    return "\n".join(lines) + "\n"


def scene_text(text: str, track: str) -> str:
    """The scene alone: `text` with TRACK's clip/kit/track block(s) removed (reuses the same
    private removal helpers `explore.ops.track_add_part` uses for a recast)."""
    lines = text.splitlines()
    lines = ops_mod._remove_track_blocks(lines, track)
    lines = ops_mod._remove_kit_block(lines, track)
    lines = ops_mod._remove_clip_decl(lines, track)
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- render + stems

def score_sha(text: str, window: tuple[int, int]) -> str:
    h = hashlib.sha256(text.encode())
    h.update(f"|window:{window[0]}-{window[1]}".encode())
    return h.hexdigest()[:20]


def _render_stems(text: str, window: tuple[int, int], work_dir: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    """Render once: `apr` written to `work_dir`, `--bars window --stems <work_dir>/stems`.
    Returns `(wav_path, stems_dir)`. Raises `AuditionError` on any render failure."""
    work_dir.mkdir(parents=True, exist_ok=True)
    score_path = work_dir / "candidate.apr"
    score_path.write_text(absolutize_samples(text))
    wav = work_dir / "tmp.wav"
    stems_dir = work_dir / "stems"
    args = [str(BIN), "render", str(score_path), "--bars", f"{window[0]}-{window[1]}", "-o", str(wav), "--stems", str(stems_dir)]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=RENDER_TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        raise AuditionError("render timed out") from e
    if r.returncode != 0:
        last = r.stderr.strip().splitlines()[-1][:300] if r.stderr.strip() else "render failed (no stderr)"
        raise AuditionError(f"render failed: {last}")
    return wav, stems_dir


def _load_track_stems(stems_dir: pathlib.Path) -> tuple[dict, dict[str, np.ndarray], int]:
    """`(manifest, {stem_name: stereo float32 array}, sample_rate)`, skipping `mix.wav`."""
    import soundfile as sf

    manifest = json.loads((stems_dir / "stems.json").read_text())
    sr = int(manifest["sample_rate"])
    stems = {}
    for t in manifest["tracks"]:
        name = t["name"]
        path = stems_dir / f"{name}.wav"
        if not path.exists():
            continue  # a silent stem the renderer skipped
        data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
        if file_sr != sr:
            raise AuditionError(f"{path}: sample rate {file_sr} != stems.json's {sr}")
        stems[name] = data
    return manifest, stems, sr


def split_scene_and_track(stems: dict[str, np.ndarray], track: str) -> tuple[np.ndarray, np.ndarray]:
    """`(scene, solo)`: `solo` is the sum of TRACK's own stem(s) (its main stem, plus any
    `TRACK.<pad>` kit sub-tracks); `scene` is the sum of every other stem -- the same "sum the
    per-track WAVs" construction the renderer itself uses for `mix.wav`."""
    if not stems:
        raise AuditionError("no stems in the render")
    length = next(iter(stems.values())).shape[0]
    channels = next(iter(stems.values())).shape[1]
    scene = np.zeros((length, channels), dtype=np.float64)
    solo = np.zeros((length, channels), dtype=np.float64)
    matched = False
    for name, data in stems.items():
        is_track = name == track or name.startswith(f"{track}.")
        (solo if is_track else scene)[: data.shape[0]] += data
        matched = matched or is_track
    if not matched:
        raise AuditionError(f"no stem named {track!r} (or {track}.*) in the render")
    return scene, solo


def sum_all_stems(stems: dict[str, np.ndarray]) -> np.ndarray:
    """Every stem summed (the same construction as `mix.wav`, pre-master) -- the scene, when there
    is no candidate track to exclude (e.g. the incumbent/keep option's own audition)."""
    if not stems:
        raise AuditionError("no stems in the render")
    length = next(iter(stems.values())).shape[0]
    channels = next(iter(stems.values())).shape[1]
    out = np.zeros((length, channels), dtype=np.float64)
    for data in stems.values():
        out[: data.shape[0]] += data
    return out


# --------------------------------------------------------------------------- assembly

def _bar_samples(tempo: float, meter: int, sr: int) -> float:
    return sr * 60.0 / tempo * meter


def _equal_power_crossfade(a_tail: np.ndarray, b_head: np.ndarray) -> np.ndarray:
    """Equal-power crossfade of two equal-length segments (a's tail fading out, b's head fading
    in), replacing the join so there's no discontinuity."""
    n = a_tail.shape[0]
    if n == 0:
        return a_tail
    t = np.linspace(0.0, 1.0, n, endpoint=False)[:, None]
    fade_out = np.cos(t * np.pi / 2.0)
    fade_in = np.sin(t * np.pi / 2.0)
    return a_tail * fade_out + b_head * fade_in


def _ramp_in(track_audio: np.ndarray, build_samples: int) -> np.ndarray:
    """A copy of `track_audio` with a linear 0 -> 1 gain ramp over its first `build_samples`
    samples, 1.0 after."""
    out = track_audio.copy()
    n = min(build_samples, out.shape[0])
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, endpoint=False)[:, None]
        out[:n] *= ramp
    return out


def assemble(scene: np.ndarray, solo: np.ndarray, *, tempo: float, meter: int, sr: int,
             scene_bars: int = SCENE_BARS_DEFAULT) -> np.ndarray:
    """Build the 16-bar audition mono/stereo array from full-window `scene`/`solo` stem sums
    (each `WINDOW_BARS` bars long, sample-aligned to bar 1 of the window):

        bars 1..scene_bars        scene alone
        bars scene_bars+1..+4     solo alone (SOLO_BARS_DEFAULT bars)
        bars 9..16 (all of W)     scene + solo, solo ramped 0->1 over the first BUILD_BARS bars
    """
    bar = _bar_samples(tempo, meter, sr)
    bar_n = int(round(bar))
    scene_n = int(round(bar * scene_bars))
    solo_n = int(round(bar * SOLO_BARS_DEFAULT))
    window_n = min(scene.shape[0], solo.shape[0])
    expected = int(round(bar * WINDOW_BARS))
    if window_n < expected - bar_n:  # allow a little slack; a short last stem is a real bug, not this
        raise AuditionError(f"rendered window is only {window_n} samples, expected ~{expected}")

    scene_seg = scene[:scene_n]
    solo_seg = solo[:solo_n]
    build_n = int(round(bar * BUILD_BARS))
    together = scene[:window_n].copy()
    together[:window_n] += _ramp_in(solo[:window_n], build_n)

    fade_n = max(1, int(round(sr * CROSSFADE_MS / 1000.0)))
    fade_n = min(fade_n, scene_seg.shape[0], solo_seg.shape[0], together.shape[0])

    # Join 1: scene -> solo.
    join1 = _equal_power_crossfade(scene_seg[-fade_n:], solo_seg[:fade_n])
    # Join 2: solo -> together.
    join2 = _equal_power_crossfade(solo_seg[-fade_n:], together[:fade_n])

    out = np.concatenate([
        scene_seg[:-fade_n], join1, solo_seg[fade_n:-fade_n], join2, together[fade_n:],
    ], axis=0)
    return out


def assemble_scene_only(scene: np.ndarray, *, tempo: float, meter: int, sr: int,
                         scene_bars: int = SCENE_BARS_DEFAULT) -> np.ndarray:
    """The "keep" option's 16-bar layout, for a cycle folder entry that has no candidate part to
    audition: the scene alone, laid out to the same length and shape as `assemble`'s output --
    `scene_bars` (the scene alone) + `scene_bars` (the scene again, standing in for where a
    candidate's solo would play) + `WINDOW_BARS` (the scene again, standing in for "together") --
    so a listener can A/B "keep" against the candidates at the same 32s runtime without a second,
    differently-shaped file. There is no ramp (there's nothing to ramp in): every section is
    exactly the scene, with the same short equal-power crossfades at the two joins."""
    bar = _bar_samples(tempo, meter, sr)
    scene_n = int(round(bar * scene_bars))
    window_n = scene.shape[0]
    expected = int(round(bar * WINDOW_BARS))
    if window_n < expected - int(round(bar)):
        raise AuditionError(f"rendered window is only {window_n} samples, expected ~{expected}")

    scene_seg = scene[:scene_n]
    together_seg = scene[:window_n]

    fade_n = max(1, int(round(sr * CROSSFADE_MS / 1000.0)))
    fade_n = min(fade_n, scene_seg.shape[0], together_seg.shape[0])

    join1 = _equal_power_crossfade(scene_seg[-fade_n:], scene_seg[:fade_n])
    join2 = _equal_power_crossfade(scene_seg[-fade_n:], together_seg[:fade_n])

    out = np.concatenate([
        scene_seg[:-fade_n], join1, scene_seg[fade_n:-fade_n], join2, together_seg[fade_n:],
    ], axis=0)
    return out


# --------------------------------------------------------------------------- loudness

def loudness_normalize(audio: np.ndarray, sr: int, *, target_lufs: float = TARGET_LUFS,
                        peak_ceiling_dbfs: float = PEAK_CEILING_DBFS) -> tuple[np.ndarray, dict]:
    """Loudness-normalize `audio` (float, any peak) to `target_lufs`, then make sure its peak sits
    under `peak_ceiling_dbfs` (pulling the gain back further if needed -- the ceiling always wins).
    Uses `pyloudnorm` (ITU-R BS.1770) when it's importable; otherwise falls back to simple RMS
    normalization and says so in the returned info dict (`method`)."""
    info: dict = {}
    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(sr)
        loudness = meter.integrated_loudness(audio)
        if not np.isfinite(loudness) or loudness < -70:
            method, current = "rms-fallback (silent/invalid LUFS measurement)", _rms_dbfs(audio)
        else:
            method, current = "pyloudnorm-lufs", loudness
    except ImportError:
        method, current = "rms-fallback (pyloudnorm not installed)", _rms_dbfs(audio)

    gain_db = target_lufs - current
    out = audio * (10.0 ** (gain_db / 20.0))
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    peak_dbfs = 20 * np.log10(peak + 1e-12)
    if peak_dbfs > peak_ceiling_dbfs:
        extra_db = peak_ceiling_dbfs - peak_dbfs
        out = out * (10.0 ** (extra_db / 20.0))
        gain_db += extra_db
    info.update(method=method, measured_before_db=current, gain_db=gain_db,
                peak_dbfs=float(20 * np.log10(np.max(np.abs(out)) + 1e-12)))
    return out, info


def _rms_dbfs(audio: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(audio)) + 1e-20))
    return 20 * np.log10(rms + 1e-12)


# --------------------------------------------------------------------------- write .m4a

def write_m4a(audio: np.ndarray, sr: int, out_path: pathlib.Path) -> None:
    import soundfile as sf

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        wav_path = pathlib.Path(td) / "audition.wav"
        sf.write(str(wav_path), audio.astype(np.float32), sr, subtype="FLOAT")
        r = subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "192000", str(wav_path), str(out_path)],
                            capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AuditionError(f"afconvert failed: {r.stderr.strip()[-500:]}")


# --------------------------------------------------------------------------- Δwindow (--check)

def _baseline_cache_path(cache_dir: pathlib.Path, base_sha: str) -> pathlib.Path:
    return cache_dir / f"{base_sha}.json"


def scene_baseline_objective(scene_text_: str, window: tuple[int, int], cache_dir: pathlib.Path) -> dict:
    """The scene-alone objective over `window`, cached per (scene text, window) so repeated
    candidates sharing the same scene/window don't re-render it. Renders + checks + deletes."""
    from . import check as checker

    base_sha = score_sha(scene_text_, window)
    cache_path = _baseline_cache_path(cache_dir, base_sha)
    if cache_path.exists():
        return json.loads(cache_path.read_text())

    with tempfile.TemporaryDirectory(prefix="audition-baseline-") as td:
        _wav, stems_dir = _render_stems(scene_text_, window, pathlib.Path(td))
        manifest, stems = checker.load_stems(stems_dir)
        report = checker.evaluate(manifest, stems)
        result = {"objective": report.objective, "consonance": report.consonance, "window": list(window)}
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(result))
    return result


def together_objective(stems_dir: pathlib.Path) -> dict:
    from . import check as checker

    manifest, stems = checker.load_stems(stems_dir)
    report = checker.evaluate(manifest, stems)
    return {"objective": report.objective, "consonance": report.consonance}


# --------------------------------------------------------------------------- top-level entry point

@dataclasses.dataclass
class AuditionResult:
    m4a_path: pathlib.Path
    json_path: pathlib.Path
    window: tuple[int, int]
    tempo: float
    meter: int
    loudness_info: dict
    delta_window: float | None = None
    together_objective: float | None = None
    scene_objective: float | None = None


def build_audition(candidate_path: pathlib.Path, *, track: str, out_path: pathlib.Path,
                    window: tuple[int, int] | None = None, scene_bars: int = SCENE_BARS_DEFAULT,
                    check: bool = False, baseline_cache_dir: pathlib.Path | None = None) -> AuditionResult:
    """Build the 16-bar audition `.m4a` for `candidate_path`'s TRACK, and a small `<out>.json` of
    numbers beside it. Renders exactly once; deletes its WAV and stems directory (and the scene
    baseline's, when `--check` needs one) before returning."""
    text = candidate_path.read_text()
    w = choose_window(text, window)
    rewritten = rewrite_track_bars(text, track, w)

    with tempfile.TemporaryDirectory(prefix="audition-form-") as td:
        work_dir = pathlib.Path(td)
        wav, stems_dir = _render_stems(rewritten, w, work_dir)
        manifest, stems, sr = _load_track_stems(stems_dir)
        scene, solo = split_scene_and_track(stems, track)
        tempo, meter = float(manifest["tempo"]), int(manifest["meter"])

        together_obj = None
        if check:
            together_obj = together_objective(stems_dir)["objective"]

        audio = assemble(scene, solo, tempo=tempo, meter=meter, sr=sr, scene_bars=scene_bars)
        audio, loud_info = loudness_normalize(audio, sr)
        # wav / stems_dir are removed automatically when this `with` block exits (nothing outside
        # it keeps them): only the .m4a and the numbers JSON below outlive this call.

    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_m4a(audio, sr, out_path)

    delta_window = scene_obj = None
    if check:
        base_dir = baseline_cache_dir or (out_path.parent / ".audition-baseline-cache")
        scene_obj = scene_baseline_objective(scene_text(text, track), w, base_dir)["objective"]
        delta_window = together_obj - scene_obj

    result = AuditionResult(m4a_path=out_path, json_path=out_path.with_suffix(".json"), window=w,
                             tempo=tempo, meter=meter, loudness_info=loud_info,
                             delta_window=delta_window, together_objective=together_obj, scene_objective=scene_obj)
    payload = {
        "m4a": str(out_path), "track": track, "window": list(w), "tempo": tempo, "meter": meter,
        "loudness": loud_info,
        "check": ({"delta_window": delta_window, "together_objective": together_obj, "scene_objective": scene_obj}
                   if check else None),
    }
    result.json_path.write_text(json.dumps(payload, indent=1) + "\n")
    return result


def build_scene_audition(scene_path_or_text: pathlib.Path | str, *, out_path: pathlib.Path,
                          window: tuple[int, int] | None = None,
                          scene_bars: int = SCENE_BARS_DEFAULT) -> AuditionResult:
    """The "keep" cycle-folder option's audition: the scene alone (no candidate track), laid out
    to the same 16-bar/32s runtime as a candidate's audition via `assemble_scene_only`. `window`
    picked the same way as `build_audition` (an explicit window wins; pass the winning finalist's
    own window so "keep" plays over the same music a listener just heard the candidates against).
    Renders exactly once; deletes its WAV and stems directory before returning."""
    text = scene_path_or_text.read_text() if isinstance(scene_path_or_text, pathlib.Path) else scene_path_or_text
    w = choose_window(text, window)

    with tempfile.TemporaryDirectory(prefix="audition-form-scene-") as td:
        work_dir = pathlib.Path(td)
        wav, stems_dir = _render_stems(text, w, work_dir)
        manifest, stems, sr = _load_track_stems(stems_dir)
        scene = sum_all_stems(stems)
        tempo, meter = float(manifest["tempo"]), int(manifest["meter"])

        audio = assemble_scene_only(scene, tempo=tempo, meter=meter, sr=sr, scene_bars=scene_bars)
        audio, loud_info = loudness_normalize(audio, sr)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_m4a(audio, sr, out_path)

    result = AuditionResult(m4a_path=out_path, json_path=out_path.with_suffix(".json"), window=w,
                             tempo=tempo, meter=meter, loudness_info=loud_info)
    payload = {"m4a": str(out_path), "track": None, "window": list(w), "tempo": tempo, "meter": meter,
               "loudness": loud_info, "note": "scene alone (keep), laid out scene_bars+scene_bars+WINDOW_BARS"}
    result.json_path.write_text(json.dumps(payload, indent=1) + "\n")
    return result
