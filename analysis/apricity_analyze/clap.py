"""CLAP audio/text embeddings (Kanbus apricitus-798704, the stochastic mash-up optimizer's Phase
1 CLAP decision -- genre/timbre fit is the compile-informed surrogate's blind spot; see the
apricitus-7e51f2 epic's first comment, end of section 4 and open question 5).

Checkpoint: `laion/clap-htsat-unfused` (Hugging Face `transformers`' `ClapModel`), chosen by
comparing candidate checkpoints' download size via the HF API (`hf_model_size`) without
downloading weights:

  laion/larger_clap_music            779.8 MB  (pytorch_model.bin 776.4 MB + tokenizer.json 2.1 MB)
  laion/clap-htsat-unfused           617.9 MB  (general-purpose CLAP, not music-specific)
  laion/larger_clap_music_and_speech 779.8 MB
  laion/larger_clap_general          779.8 MB

`larger_clap_music` is LAION's music-specialized checkpoint and was tried first (under the 1 GB
budget; disk was ~13 GB free at the time this was written), but its text tower is degenerate under
this `transformers` version: `get_text_features(...).pooler_output` for genuinely different
prompts ("the sound of a cat" vs "the sound of a dog", or even HF's own docstring example) comes
back with cosine similarity > 0.999 -- effectively constant regardless of the text. `clap-htsat-
unfused` (617.9 MB, also under budget, and the smaller download of the two) does not have this
problem: the same prompts score 0.79 (related) down to 0.01-0.29 (unrelated), and it is what
`scripts/fit-features.py --probe` uses. It is *not* LAION's music-specialized checkpoint (general-
purpose CLAP), which is the tradeoff for a text tower that actually discriminates; see the CLAP
probe's output in the task's verification report for how it does on this library's real clips.
The checkpoint downloads to the default Hugging Face cache (`~/.cache/huggingface`, outside the
repo and outside git) on first use, not at import time.

For one saved clip or window, embeddings are 512-d L2-normalized vectors from `ClapModel.
get_audio_features`, computed on mono audio resampled to the model's own rate (48 kHz;
`TARGET_SAMPLE_RATE`). Native source frames are decoded without resampling, mixed to mono,
resampled using soxr HQ, and deterministically center-cropped to ten seconds here. The pinned
feature extractor retains its repeat-padding behavior for shorter inputs; it never receives a
longer waveform that would trigger random truncation. Model and processing revisions are
recorded in v2 sidecars; legacy sidecars are intentionally stale.

`<file>.clap.npz` (next to `<file>.apricity.json`, same layout question as
`features.sidecar_path_for`):

  sha256              0-d str     the manifest's `source.sha256` (re-run invalidation key)
  checkpoint           0-d str    the HF checkpoint name embeddings were computed with (a cached
                                   sidecar from a different checkpoint is stale -- see `is_up_to_date`)
  clip_names           (C,) str   `annotations.clips[*].name`, in the same order as `clip_embeddings`
  clip_embeddings       (C, 512) f32   one CLAP audio embedding per saved clip
  window_start_s        (W,) f32   4-bar window start, in source seconds
  window_end_s          (W,) f32   4-bar window end, in source seconds
  window_start_beat     (W,) f32   window start, in the sample's own beat index (interpolated;
                                    matches `rhythm.beats`' units -- fractional when the window
                                    boundary falls between two tracked beats)
  window_end_beat       (W,) f32   window end, same units
  window_embeddings     (W, 512) f32   one CLAP audio embedding per 4-bar window

A text-embedding helper (`embed_text`) lets a prompt ("smooth deep house pad") be scored against
clip/window embeddings by cosine similarity, for a text-prompt probe or (later) a cell-level
search prior; see `scripts/fit-features.py --probe`.
"""

from __future__ import annotations

import dataclasses
import hashlib
import importlib.metadata
import json
import math
import os
import pathlib
import tempfile

import numpy as np

CHECKPOINT = "laion/clap-htsat-unfused"
CHECKPOINT_REVISION = "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a"
EMBEDDING_SPACE = "clap-htsat-unfused-512-v1"
PREPROCESSING_VERSION = "clap-audio-center10s-v1"
EMBED_DIM = 512
SIDECAR_SUFFIX = ".clap.npz"
BARS_PER_WINDOW = 4
TARGET_SAMPLE_RATE = 48_000
MAX_AUDIO_FRAMES = TARGET_SAMPLE_RATE * 10
SIDECAR_SCHEMA_VERSION = 2

_models: dict[tuple[str, str], tuple[object, object, int]] = {}


def hf_model_size(repo_id: str) -> int:
    """Total size in bytes of `repo_id`'s files, from the HF API's `?blobs=true` listing --
    answers "how big is this checkpoint" without downloading any weights."""
    import requests

    r = requests.get(f"https://huggingface.co/api/models/{repo_id}", params={"blobs": "true"}, timeout=15)
    r.raise_for_status()
    return sum(s.get("size") or 0 for s in r.json().get("siblings", []))


def is_model_cached(checkpoint: str = CHECKPOINT) -> bool:
    """True when `checkpoint`'s weights are already in the local HF cache (used to skip CLAP
    tests/work rather than trigger an ~780 MB download)."""
    from huggingface_hub import scan_cache_dir

    try:
        info = scan_cache_dir()
    except Exception:  # noqa: BLE001 -- an unreadable/missing cache just means "not cached"
        return False
    for repo in info.repos:
        if repo.repo_id == checkpoint and repo.size_on_disk > 0:
            return True
    return False


def _load(checkpoint: str = CHECKPOINT):
    """Load only the requested pinned checkpoint; never reuse another checkpoint's cache."""
    key = (checkpoint, CHECKPOINT_REVISION)
    if key not in _models:
        import torch
        from transformers import ClapModel, ClapProcessor

        # Ground analysis is pinned and offline-safe: absence of this exact revision is an error,
        # never permission to fetch or substitute another checkpoint.
        processor = ClapProcessor.from_pretrained(checkpoint, revision=CHECKPOINT_REVISION, local_files_only=True)
        model = ClapModel.from_pretrained(checkpoint, revision=CHECKPOINT_REVISION, local_files_only=True)
        model.eval()
        _models[key] = (model, processor, int(processor.feature_extractor.sampling_rate))
        torch.set_grad_enabled(False)
    model, processor, _ = _models[key]
    return model, processor


def checkpoint_sample_rate(checkpoint: str = CHECKPOINT) -> int:
    _load(checkpoint)
    return _models[(checkpoint, CHECKPOINT_REVISION)][2]


def _resample(mono: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return np.asarray(mono, dtype=np.float32)
    import soxr

    return soxr.resample(np.asarray(mono, dtype=np.float32), sr_in, sr_out, quality="HQ").astype(np.float32)


def processing_fingerprint(checkpoint: str = CHECKPOINT) -> str:
    """Digest the pinned model/preprocessing/runtime manifest without model inference."""
    versions = {}
    for package in ("transformers", "torch", "soxr", "soundfile", "numpy"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = "unavailable"
    manifest = {"checkpoint": checkpoint, "checkpointRevision": CHECKPOINT_REVISION,
                "embeddingSpace": EMBEDDING_SPACE, "preprocessingVersion": PREPROCESSING_VERSION,
                "targetSampleRate": TARGET_SAMPLE_RATE, "maxAudioFrames": MAX_AUDIO_FRAMES,
                "decode": "soundfile-native-frames", "mix": "frames-by-channels-arithmetic-mean",
                "resample": "soxr-HQ-once-in-clap",
                "runtimeVersions": versions}
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def preprocess_audio(audio: np.ndarray, sr: int) -> np.ndarray:
    """Mono float32 48kHz audio with the deterministic centered ten-second crop."""
    if not isinstance(sr, int) or sr <= 0:
        raise ValueError("sample rate must be a positive integer")
    waveform = np.asarray(audio, dtype=np.float32)
    if waveform.ndim == 0 or waveform.size == 0:
        raise ValueError("empty waveform")
    if waveform.ndim == 2:
        waveform = waveform.mean(axis=1, dtype=np.float32)
    elif waveform.ndim != 1:
        raise ValueError("waveform must be mono or frames-by-channels")
    if not np.isfinite(waveform).all():
        raise ValueError("nonfinite waveform")
    waveform = _resample(waveform, sr, TARGET_SAMPLE_RATE)
    if len(waveform) > MAX_AUDIO_FRAMES:
        start = (len(waveform) - MAX_AUDIO_FRAMES) // 2
        waveform = waveform[start:start + MAX_AUDIO_FRAMES]
    return np.ascontiguousarray(waveform, dtype=np.float32)


def _normalize_model_vector(vector: object) -> np.ndarray:
    """Apply the one producer contract; never turn a failed embedding into zeros."""
    from .semantic_contract import normalize_vector

    return np.asarray(normalize_vector(np.asarray(vector, dtype=np.float32).reshape(-1)), dtype=np.float32)


def _normalize_model_matrix(vectors: object) -> np.ndarray:
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim != 2:
        raise ValueError("model output must be a matrix of embedding vectors")
    return np.stack([_normalize_model_vector(vector) for vector in array]).astype(np.float32)


def embed_audio(mono: np.ndarray, sr: int, checkpoint: str = CHECKPOINT) -> np.ndarray:
    """One L2-normalized 512-d embedding for a mono waveform (any length; CLAP's own feature
    extractor pads/truncates to its `chunk_length_s` window)."""
    import torch

    model, processor = _load(checkpoint)
    audio = preprocess_audio(mono, sr)
    inputs = processor(audio=audio, sampling_rate=TARGET_SAMPLE_RATE, return_tensors="pt")
    with torch.no_grad():
        feats = model.get_audio_features(**inputs)
    # `get_audio_features`/`get_text_features` return a `BaseModelOutputWithPooling`, not a bare
    # tensor: `.pooler_output` is the projected (512-d) embedding CLAP's audio/text space is
    # defined in (`.last_hidden_state` is the pre-projection spectrogram-shaped encoder output).
    return _normalize_model_vector(feats.pooler_output[0].numpy())


MAX_FORWARD_BATCH = 8
# A track with many saved clips or bar-grid windows (a multi-minute march can have 50+ clips,
# 20-30 4-bar windows) was pushing a single `get_audio_features` forward pass to tens of clips at
# once; peak measured process RSS for that one file's batch was observed at ~1 GB above a
# single-clip baseline, and (being CPU tensors freed back to the process allocator rather than
# GPU-cached) that peak doesn't reliably shrink again for the rest of the process's life --
# several such files in one run pushed a fresh subprocess past the 6 GB safe-run cap even with
# small chunk sizes (see `scripts/fit-features.py`'s module docstring). Capping the forward-pass
# batch size bounds that peak regardless of how many clips/windows one file has.


def embed_audio_batch(clips: list[np.ndarray], sr: int, checkpoint: str = CHECKPOINT) -> np.ndarray:
    """`(N, 512)` L2-normalized embeddings for several mono waveforms, `MAX_FORWARD_BATCH` at a
    time (see `MAX_FORWARD_BATCH`'s comment for why)."""
    import gc

    import torch

    if not clips:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)
    model, processor = _load(checkpoint)
    target_sr = checkpoint_sample_rate(checkpoint)
    out = []
    for i in range(0, len(clips), MAX_FORWARD_BATCH):
        sub = clips[i:i + MAX_FORWARD_BATCH]
        audios = [preprocess_audio(c, sr) for c in sub]
        inputs = processor(audio=audios, sampling_rate=TARGET_SAMPLE_RATE, return_tensors="pt")
        with torch.no_grad():
            feats = model.get_audio_features(**inputs)
        vecs = feats.pooler_output.numpy()
        out.append(_normalize_model_matrix(vecs))
        del inputs, feats, vecs
        gc.collect()
    return np.concatenate(out, axis=0)


def embed_text(text: str, checkpoint: str = CHECKPOINT) -> np.ndarray:
    """One L2-normalized 512-d embedding for a text prompt, comparable by cosine similarity to
    `embed_audio`'s output (CLAP's shared audio/text space)."""
    import torch

    model, processor = _load(checkpoint)
    max_length = _text_max_length(model, processor)
    inputs = processor(text=[text], return_tensors="pt", padding=True, truncation=True, max_length=max_length)
    with torch.no_grad():
        feats = model.get_text_features(**inputs)
    return _normalize_model_vector(feats.pooler_output[0].numpy())


def embed_text_batch(texts: list[str], checkpoint: str = CHECKPOINT) -> np.ndarray:
    import torch

    if not texts:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)
    model, processor = _load(checkpoint)
    max_length = _text_max_length(model, processor)
    inputs = processor(text=list(texts), return_tensors="pt", padding=True, truncation=True, max_length=max_length)
    with torch.no_grad():
        feats = model.get_text_features(**inputs)
    return _normalize_model_matrix(feats.pooler_output.numpy())


def _text_max_length(model, processor) -> int:
    """Use the checkpoint's actual configured text limit, avoiding tokenizer sentinel limits."""
    configured = getattr(getattr(model, "config", None), "text_config", None)
    candidates = [getattr(configured, "max_position_embeddings", None),
                  getattr(processor.tokenizer, "model_max_length", None)]
    usable = [value for value in candidates if isinstance(value, int) and 0 < value < 1_000_000]
    if usable:
        return min(usable)
    raise ValueError("checkpoint does not expose a usable maximum text length")


# --------------------------------------------------------------------------- windowing (testable without the model)

@dataclasses.dataclass
class Window:
    start_s: float
    end_s: float
    start_beat: float
    end_beat: float


def _beat_at(t: float, beats: list[float]) -> float:
    """Fractional beat index of source time `t` on `beats` (linear interpolation; extrapolates
    flatly past the ends, matching how a warp map would clamp)."""
    arr = np.asarray(beats, dtype=np.float64)
    if len(arr) < 2:
        return 0.0
    if t <= arr[0]:
        return 0.0
    if t >= arr[-1]:
        return float(len(arr) - 1)
    i = int(np.searchsorted(arr, t, side="right") - 1)
    i = max(0, min(i, len(arr) - 2))
    span = arr[i + 1] - arr[i]
    frac = (t - arr[i]) / span if span > 1e-9 else 0.0
    return float(i + frac)


def bar_grid_windows(downbeats: list[float], beats: list[float], bars_per_window: int = BARS_PER_WINDOW) -> list[Window]:
    """Non-overlapping `bars_per_window`-bar windows over `downbeats` (bar-start seconds), each
    stamped with its `[start_beat, end_beat)` on `beats` (fractional -- see `_beat_at`). Empty
    when there are fewer than `bars_per_window + 1` downbeats (no full window)."""
    if len(downbeats) < bars_per_window + 1:
        return []
    out = []
    for i in range(0, len(downbeats) - bars_per_window, bars_per_window):
        a, b = downbeats[i], downbeats[i + bars_per_window]
        out.append(Window(start_s=a, end_s=b, start_beat=_beat_at(a, beats), end_beat=_beat_at(b, beats)))
    return out


def embed_windows(mono: np.ndarray, sr: int, windows: list[Window], checkpoint: str = CHECKPOINT) -> np.ndarray:
    clips = [mono[int(w.start_s * sr):int(w.end_s * sr)] for w in windows]
    return embed_audio_batch(clips, sr, checkpoint)


# --------------------------------------------------------------------------- sidecar I/O

def sidecar_path_for(manifest_path: pathlib.Path) -> pathlib.Path:
    name = manifest_path.name
    assert name.endswith(".apricity.json"), name
    return manifest_path.with_name(name[: -len(".apricity.json")] + SIDECAR_SUFFIX)


def _region_fingerprint(kind: str, source_ref: str, start: float, end: float, sha256: str,
                        fingerprint: str, grid_fingerprint: str = "") -> str:
    payload = [kind, source_ref, float(start), float(end), sha256, EMBEDDING_SPACE, fingerprint, grid_fingerprint]
    return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()


def _clip_source_ref(clip: dict, index: int) -> str:
    """Prefer a canonical manifest ID; aliases remain source references, never invented IDs."""
    clip_id = clip.get("id")
    if isinstance(clip_id, str) and clip_id:
        return f"id:{clip_id}"
    source_ref = clip.get("source_ref", clip.get("sourceRef"))
    if isinstance(source_ref, str) and source_ref:
        return f"alias:{source_ref}"
    start, end = clip.get("start"), clip.get("end")
    if _valid_bounds(start, end):
        from .semantic_contract import round_half_up_microseconds
        return f"source-boundary:{round_half_up_microseconds(start)}:{round_half_up_microseconds(end)}"
    return f"source-invalid:{index}"


def _valid_bounds(start: object, end: object) -> bool:
    return (isinstance(start, (int, float)) and not isinstance(start, bool)
            and isinstance(end, (int, float)) and not isinstance(end, bool)
            and math.isfinite(start) and math.isfinite(end) and start >= 0 and end > start)


def _valid_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


@dataclasses.dataclass
class SidecarReusePlan:
    clip_names: list[str]
    clip_embeddings: list[np.ndarray | None]
    window_embeddings: list[np.ndarray | None]
    reports: list[dict]
    metadata_changed: bool = False


def _valid_embedding(vector: np.ndarray) -> bool:
    try:
        from .semantic_contract import validate_vector
        validate_vector(vector)
        return True
    except (ValueError, TypeError):
        return False


def _read_v2(path: pathlib.Path) -> dict | None:
    if not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as z:
            required = {"sidecar_schema_version", "sha256", "checkpoint", "checkpoint_revision",
                        "embedding_space", "processing_fingerprint", "clip_source_refs", "clip_names",
                        "clip_start_s", "clip_end_s", "clip_fingerprints", "clip_embeddings",
                        "window_start_s", "window_end_s", "window_start_beat", "window_end_beat",
                        "window_grid_fingerprint", "window_fingerprints", "window_embeddings"}
            if not required.issubset(z.files) or int(z["sidecar_schema_version"]) != SIDECAR_SCHEMA_VERSION:
                return None
            stored = {name: z[name].copy() for name in z.files}
            clip_count, window_count = len(stored["clip_source_refs"]), len(stored["window_fingerprints"])
            clip_fields = ("clip_names", "clip_start_s", "clip_end_s", "clip_fingerprints")
            window_fields = ("window_start_s", "window_end_s", "window_start_beat", "window_end_beat")
            if (any(len(stored[field]) != clip_count for field in clip_fields)
                    or any(len(stored[field]) != window_count for field in window_fields)
                    or stored["clip_embeddings"].shape != (clip_count, EMBED_DIM)
                    or stored["window_embeddings"].shape != (window_count, EMBED_DIM)):
                return None
            if any(not _valid_bounds(start, end) for start, end in zip(stored["clip_start_s"], stored["clip_end_s"])):
                return None
            if any(not _valid_bounds(start, end) for start, end in zip(stored["window_start_s"], stored["window_end_s"])):
                return None
            if (not _valid_sha256(str(stored["sha256"])) or not str(stored["checkpoint"])
                    or not str(stored["checkpoint_revision"]) or not str(stored["embedding_space"])
                    or not str(stored["processing_fingerprint"]) or not str(stored["window_grid_fingerprint"])):
                return None
            expected_clip_fingerprints = [_region_fingerprint("saved_clip", str(ref), start, end,
                                                              str(stored["sha256"]), str(stored["processing_fingerprint"]))
                                          for ref, start, end in zip(stored["clip_source_refs"], stored["clip_start_s"], stored["clip_end_s"])]
            expected_window_fingerprints = [_region_fingerprint("window", f"window:{index}", start, end,
                                                                str(stored["sha256"]), str(stored["processing_fingerprint"]),
                                                                str(stored["window_grid_fingerprint"]))
                                            for index, (start, end) in enumerate(zip(stored["window_start_s"], stored["window_end_s"]))]
            if (expected_clip_fingerprints != [str(value) for value in stored["clip_fingerprints"]]
                    or expected_window_fingerprints != [str(value) for value in stored["window_fingerprints"]]
                    or len(set(map(str, stored["clip_source_refs"]))) != clip_count
                    or len(set(map(str, stored["window_fingerprints"]))) != window_count):
                return None
            return stored
    except Exception:  # corrupt/partial files are stale and reported by the caller
        return None


def sidecar_reuse_plan(path: pathlib.Path, *, sha256: str, clips: list[dict], windows: list[Window],
                       processing_fingerprint: str, window_grid_fingerprint: str,
                       checkpoint: str = CHECKPOINT) -> SidecarReusePlan:
    """Select only valid v2 vectors whose region provenance still exactly matches."""
    reports: list[dict] = []
    if not _valid_sha256(sha256):
        reports.append({"kind": "sample", "reason": "invalid_audio_sha256"})
        return SidecarReusePlan([], [], [], reports, False)
    current_clips: list[tuple[str, str, float, float, str]] = []
    for index, clip in enumerate(clips):
        if clip.get("retired") is True:
            continue
        start, end = clip.get("start"), clip.get("end")
        source_ref = _clip_source_ref(clip, index)
        name = str(clip.get("name", ""))
        if not _valid_bounds(start, end):
            reports.append({"kind": "saved_clip", "source_ref": source_ref, "reason": "invalid_boundary"})
            current_clips.append((source_ref, name, math.nan, math.nan, ""))
            continue
        current_clips.append((source_ref, name, float(start), float(end),
                              _region_fingerprint("saved_clip", source_ref, start, end, sha256, processing_fingerprint)))
    stored = _read_v2(path)
    if stored is None:
        reason = "missing_sidecar" if not path.exists() else "legacy_sidecar"
        reports.append({"kind": "sidecar", "reason": reason})
        return SidecarReusePlan([row[1] for row in current_clips], [None] * len(current_clips), [None] * len(windows), reports, True)

    global_match = (str(stored["sha256"]) == sha256 and str(stored["checkpoint"]) == checkpoint
                    and str(stored["checkpoint_revision"]) == CHECKPOINT_REVISION
                    and str(stored["embedding_space"]) == EMBEDDING_SPACE
                    and str(stored["processing_fingerprint"]) == processing_fingerprint)
    if not global_match:
        reports.append({"kind": "sidecar", "reason": "provenance_changed"})
        return SidecarReusePlan([row[1] for row in current_clips], [None] * len(current_clips), [None] * len(windows), reports, True)

    old_clips = {str(ref): (str(fingerprint), vector) for ref, fingerprint, vector in zip(
        stored["clip_source_refs"], stored["clip_fingerprints"], stored["clip_embeddings"])}
    clip_embeddings: list[np.ndarray | None] = []
    for source_ref, _name, _start, _end, fingerprint in current_clips:
        previous = old_clips.get(source_ref)
        if not fingerprint or previous is None or previous[0] != fingerprint:
            clip_embeddings.append(None)
        elif _valid_embedding(previous[1]):
            clip_embeddings.append(np.asarray(previous[1], dtype=np.float32))
        else:
            clip_embeddings.append(None)
            reports.append({"kind": "saved_clip", "source_ref": source_ref, "reason": "invalid_vector"})

    old_windows = {str(fingerprint): vector for fingerprint, vector in zip(stored["window_fingerprints"], stored["window_embeddings"])}
    window_embeddings: list[np.ndarray | None] = []
    for index, window in enumerate(windows):
        if not _valid_bounds(window.start_s, window.end_s):
            window_embeddings.append(None)
            reports.append({"kind": "window", "source_ref": f"window:{index}", "reason": "invalid_boundary"})
            continue
        fingerprint = _region_fingerprint("window", f"window:{index}", window.start_s, window.end_s, sha256,
                                          processing_fingerprint, window_grid_fingerprint)
        previous = old_windows.get(fingerprint)
        if previous is not None and _valid_embedding(previous):
            window_embeddings.append(np.asarray(previous, dtype=np.float32))
        else:
            window_embeddings.append(None)
            if previous is not None:
                reports.append({"kind": "window", "source_ref": f"window:{index}", "reason": "invalid_vector"})
    names = [row[1] for row in current_clips]
    current_refs = [row[0] for row in current_clips]
    current_fingerprints = [row[4] for row in current_clips]
    current_window_fingerprints = [_region_fingerprint("window", f"window:{index}", w.start_s, w.end_s, sha256,
                                                        processing_fingerprint, window_grid_fingerprint)
                                   for index, w in enumerate(windows)]
    metadata_changed = (
        names != [str(name) for name in stored["clip_names"]]
        or current_refs != [str(ref) for ref in stored["clip_source_refs"]]
        or current_fingerprints != [str(fingerprint) for fingerprint in stored["clip_fingerprints"]]
        or current_window_fingerprints != [str(fingerprint) for fingerprint in stored["window_fingerprints"]]
        or str(stored["window_grid_fingerprint"]) != window_grid_fingerprint
    )
    return SidecarReusePlan(names, clip_embeddings, window_embeddings, reports, metadata_changed)


def write_sidecar_v2(path: pathlib.Path, *, sha256: str, clips: list[dict], clip_embeddings: np.ndarray,
                     windows: list[Window], window_embeddings: np.ndarray, processing_fingerprint: str,
                     window_grid_fingerprint: str, checkpoint: str = CHECKPOINT, reports: list[dict] | None = None) -> None:
    """Atomically persist v2 sidecar provenance; callers must exclude failed regions first."""
    if len(clips) != len(clip_embeddings) or len(windows) != len(window_embeddings):
        raise ValueError("every stored region must have exactly one embedding")
    if not _valid_sha256(sha256):
        raise ValueError("sidecar requires a valid audio sha256")
    if checkpoint != CHECKPOINT or not isinstance(processing_fingerprint, str) or not processing_fingerprint:
        raise ValueError("sidecar requires the pinned checkpoint and a processing fingerprint")
    if not isinstance(window_grid_fingerprint, str) or not window_grid_fingerprint:
        raise ValueError("sidecar requires a window grid fingerprint")
    if any(clip.get("retired") is True for clip in clips):
        raise ValueError("sidecar refuses retired clips")
    if any(not _valid_bounds(clip.get("start"), clip.get("end")) for clip in clips) or any(
            not _valid_bounds(window.start_s, window.end_s) for window in windows):
        raise ValueError("sidecar refuses invalid region boundaries")
    if any(not _valid_embedding(vector) for vector in clip_embeddings) or any(not _valid_embedding(vector) for vector in window_embeddings):
        raise ValueError("sidecar refuses invalid embeddings")
    path.parent.mkdir(parents=True, exist_ok=True)
    refs = [_clip_source_ref(clip, index) for index, clip in enumerate(clips)]
    clip_fingerprints = [_region_fingerprint("saved_clip", ref, clip["start"], clip["end"], sha256, processing_fingerprint)
                         for ref, clip in zip(refs, clips)]
    window_fingerprints = [_region_fingerprint("window", f"window:{index}", window.start_s, window.end_s, sha256,
                                              processing_fingerprint, window_grid_fingerprint)
                           for index, window in enumerate(windows)]
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as tmp:
        tmp_path = pathlib.Path(tmp.name)
        np.savez_compressed(tmp, sidecar_schema_version=np.array(SIDECAR_SCHEMA_VERSION), sha256=np.array(sha256),
                            checkpoint=np.array(checkpoint), checkpoint_revision=np.array(CHECKPOINT_REVISION),
                            embedding_space=np.array(EMBEDDING_SPACE), processing_fingerprint=np.array(processing_fingerprint),
                            clip_source_refs=np.array(refs, dtype=str), clip_names=np.array([str(c.get("name", "")) for c in clips], dtype=str),
                            clip_start_s=np.array([c["start"] for c in clips], dtype=np.float64), clip_end_s=np.array([c["end"] for c in clips], dtype=np.float64),
                            clip_fingerprints=np.array(clip_fingerprints, dtype=str), clip_embeddings=np.asarray(clip_embeddings, dtype=np.float32),
                            window_start_s=np.array([w.start_s for w in windows], dtype=np.float64), window_end_s=np.array([w.end_s for w in windows], dtype=np.float64),
                            window_start_beat=np.array([w.start_beat for w in windows], dtype=np.float64), window_end_beat=np.array([w.end_beat for w in windows], dtype=np.float64),
                            window_grid_fingerprint=np.array(window_grid_fingerprint), window_fingerprints=np.array(window_fingerprints, dtype=str),
                            window_embeddings=np.asarray(window_embeddings, dtype=np.float32), reports=np.array(json.dumps(reports or [], separators=(",", ":"))))
    os.replace(tmp_path, path)


def write_sidecar(path: pathlib.Path, *, sha256: str, checkpoint: str, clip_names: list[str],
                   clip_embeddings: np.ndarray, windows: list[Window], window_embeddings: np.ndarray) -> None:
    """Legacy writer retained for optimizer callers; its v1 output is intentionally stale."""
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        sha256=np.array(sha256), checkpoint=np.array(checkpoint),
        clip_names=np.array(clip_names, dtype=str) if clip_names else np.zeros(0, dtype=str),
        clip_embeddings=clip_embeddings.astype(np.float32),
        window_start_s=np.array([w.start_s for w in windows], dtype=np.float32),
        window_end_s=np.array([w.end_s for w in windows], dtype=np.float32),
        window_start_beat=np.array([w.start_beat for w in windows], dtype=np.float32),
        window_end_beat=np.array([w.end_beat for w in windows], dtype=np.float32),
        window_embeddings=window_embeddings.astype(np.float32),
    )


def read_sidecar_meta(path: pathlib.Path) -> tuple[str, str] | None:
    """`(sha256, checkpoint)`, cheaply -- `None` if missing/unreadable."""
    if not path.exists():
        return None
    try:
        stored = _read_v2(path)
        if stored is None:
            return None
        return str(stored["sha256"]), str(stored["checkpoint"])
    except Exception:  # noqa: BLE001 -- a corrupt/partial sidecar is just "not up to date"
        return None


def is_up_to_date(path: pathlib.Path, manifest_sha: str, checkpoint: str = CHECKPOINT) -> bool:
    stored = _read_v2(path)
    return stored is not None and all(_valid_embedding(vector) for vector in stored["clip_embeddings"]) \
        and all(_valid_embedding(vector) for vector in stored["window_embeddings"]) \
        and str(stored["sha256"]) == manifest_sha and str(stored["checkpoint"]) == checkpoint \
        and str(stored["checkpoint_revision"]) == CHECKPOINT_REVISION and str(stored["embedding_space"]) == EMBEDDING_SPACE \
        and str(stored["processing_fingerprint"]) == processing_fingerprint()


def load_clip_embeddings(samples_dir: pathlib.Path) -> list[tuple[str, str, np.ndarray]]:
    """Every saved clip's CLAP embedding (L2-normalized) from the `.clap.npz` sidecars under
    `samples_dir` (written by `scripts/fit-features.py`): `(sample path relative to samples_dir,
    clip name, embedding)`."""
    rows = []
    for f in samples_dir.rglob("*.clap.npz"):
        z = np.load(f, allow_pickle=False)
        if "clip_names" not in z.files or "clip_embeddings" not in z.files:
            continue
        rel = str(f.relative_to(samples_dir)).removesuffix(".clap.npz")
        for name, e in zip(z["clip_names"], z["clip_embeddings"]):
            rows.append((rel, str(name), e / (np.linalg.norm(e) + 1e-9)))
    return rows


def neighbors(samples_dir: pathlib.Path, *, ref: str | None = None, prompt: str | None = None,
              kinds: str = "loop,sec,phrase", top: int = 12) -> list[dict]:
    """Shortlist clips that sound like they belong with a scene: CLAP similarity to `ref` (a
    `"<sample path> <saved clip>"` already in the score), optionally blended with `prompt` (a text
    description of the style). One best clip per recording, best first. Raises `ValueError` if
    neither `ref` nor `prompt` is given, or if the sidecars/the referenced clip aren't found."""
    if not ref and not prompt:
        raise ValueError("give ref, prompt, or both")
    rows = load_clip_embeddings(samples_dir)
    if not rows:
        raise ValueError(f"no CLAP sidecars under {samples_dir}: run `lab features` first")

    ref_embedding = None
    ref_sample = None
    if ref:
        ref_sample, ref_clip = ref.split(None, 1)
        ref_embedding = next((e for r, n, e in rows if r == ref_sample and n == ref_clip), None)
        if ref_embedding is None:
            raise ValueError(f"no CLAP embedding for {ref!r}")

    text_embedding = None
    if prompt:
        text_embedding = embed_text(prompt)
        text_embedding = text_embedding / np.linalg.norm(text_embedding)

    kind_prefixes = tuple(k.strip() + "-" for k in kinds.split(","))
    scored = []
    for r, n, e in rows:
        if not n.startswith(kind_prefixes) or r == ref_sample:
            continue
        s_ref = float(e @ ref_embedding) if ref_embedding is not None else None
        s_txt = float(e @ text_embedding) if text_embedding is not None else None
        parts = [s for s in (s_ref, s_txt) if s is not None]
        scored.append((sum(parts) / len(parts), s_ref, s_txt, r, n))
    scored.sort(key=lambda row: row[0], reverse=True)

    seen: set[str] = set()
    best = []
    for score, s_ref, s_txt, r, n in scored:
        if r in seen:
            continue
        seen.add(r)
        best.append({"score": score, "scene_similarity": s_ref, "prompt_similarity": s_txt, "sample": r, "clip": n})
        if len(best) == top:
            break
    return best
