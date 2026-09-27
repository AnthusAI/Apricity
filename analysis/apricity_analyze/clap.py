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
`CHECKPOINT_SR` / `processor().feature_extractor.sampling_rate`). CLAP's own feature extractor
pads/truncates every input to a fixed `chunk_length_s` (10 s) window, so a saved clip or a 4-bar
window longer than that is randomly truncated by the model's own preprocessing (`truncation:
"rand_trunc"`), not by this module.

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
import pathlib

import numpy as np

CHECKPOINT = "laion/clap-htsat-unfused"
EMBED_DIM = 512
SIDECAR_SUFFIX = ".clap.npz"
BARS_PER_WINDOW = 4

_model = None
_processor = None
_checkpoint_sr: int | None = None


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
    global _model, _processor, _checkpoint_sr
    if _model is None:
        import torch
        from transformers import ClapModel, ClapProcessor

        _processor = ClapProcessor.from_pretrained(checkpoint)
        _model = ClapModel.from_pretrained(checkpoint)
        _model.eval()
        _checkpoint_sr = int(_processor.feature_extractor.sampling_rate)
        torch.set_grad_enabled(False)
    return _model, _processor


def checkpoint_sample_rate(checkpoint: str = CHECKPOINT) -> int:
    _load(checkpoint)
    assert _checkpoint_sr is not None
    return _checkpoint_sr


def _resample(mono: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return np.asarray(mono, dtype=np.float32)
    import soxr

    return soxr.resample(np.asarray(mono, dtype=np.float32), sr_in, sr_out).astype(np.float32)


def embed_audio(mono: np.ndarray, sr: int, checkpoint: str = CHECKPOINT) -> np.ndarray:
    """One L2-normalized 512-d embedding for a mono waveform (any length; CLAP's own feature
    extractor pads/truncates to its `chunk_length_s` window)."""
    import torch

    model, processor = _load(checkpoint)
    audio = _resample(mono, sr, checkpoint_sample_rate(checkpoint))
    inputs = processor(audio=audio, sampling_rate=checkpoint_sample_rate(checkpoint), return_tensors="pt")
    with torch.no_grad():
        feats = model.get_audio_features(**inputs)
    # `get_audio_features`/`get_text_features` return a `BaseModelOutputWithPooling`, not a bare
    # tensor: `.pooler_output` is the projected (512-d) embedding CLAP's audio/text space is
    # defined in (`.last_hidden_state` is the pre-projection spectrogram-shaped encoder output).
    vec = feats.pooler_output[0].numpy().astype(np.float32)
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 1e-9 else vec


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
        audios = [_resample(c, sr, target_sr) for c in sub]
        inputs = processor(audio=audios, sampling_rate=target_sr, return_tensors="pt")
        with torch.no_grad():
            feats = model.get_audio_features(**inputs)
        vecs = feats.pooler_output.numpy().astype(np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms < 1e-9] = 1.0
        out.append(vecs / norms)
        del inputs, feats, vecs
        gc.collect()
    return np.concatenate(out, axis=0)


def embed_text(text: str, checkpoint: str = CHECKPOINT) -> np.ndarray:
    """One L2-normalized 512-d embedding for a text prompt, comparable by cosine similarity to
    `embed_audio`'s output (CLAP's shared audio/text space)."""
    import torch

    model, processor = _load(checkpoint)
    inputs = processor(text=[text], return_tensors="pt", padding=True)
    with torch.no_grad():
        feats = model.get_text_features(**inputs)
    vec = feats.pooler_output[0].numpy().astype(np.float32)
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 1e-9 else vec


def embed_text_batch(texts: list[str], checkpoint: str = CHECKPOINT) -> np.ndarray:
    import torch

    if not texts:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)
    model, processor = _load(checkpoint)
    inputs = processor(text=list(texts), return_tensors="pt", padding=True)
    with torch.no_grad():
        feats = model.get_text_features(**inputs)
    vecs = feats.pooler_output.numpy().astype(np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms < 1e-9] = 1.0
    return vecs / norms


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


def write_sidecar(path: pathlib.Path, *, sha256: str, checkpoint: str, clip_names: list[str],
                   clip_embeddings: np.ndarray, windows: list[Window], window_embeddings: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        sha256=np.array(sha256),
        checkpoint=np.array(checkpoint),
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
        with np.load(path, allow_pickle=True) as z:
            return str(z["sha256"]), str(z["checkpoint"])
    except Exception:  # noqa: BLE001 -- a corrupt/partial sidecar is just "not up to date"
        return None


def is_up_to_date(path: pathlib.Path, manifest_sha: str, checkpoint: str = CHECKPOINT) -> bool:
    meta = read_sidecar_meta(path)
    return meta is not None and meta == (manifest_sha, checkpoint)
