"""Deterministic sidecar v2 freshness and preprocessing tests (apricitus-dbcb9b)."""

from __future__ import annotations

import importlib.util
import json
import pathlib

import numpy as np
import pytest

from apricity_analyze import clap


SHA = "a" * 64


def _unit(value: float = 1.0) -> np.ndarray:
    vector = np.zeros(clap.EMBED_DIM, dtype=np.float32)
    vector[0] = value
    return vector


def _clips(name: str = "intro", end: float = 4.0) -> list[dict]:
    return [{"id": "clip-1", "name": name, "start": 0.0, "end": end}]


def test_processing_fingerprint_is_pinned_and_needs_no_model_load(monkeypatch):
    monkeypatch.setattr(clap, "_load", lambda *_: pytest.fail("fingerprinting loaded a model"))
    assert clap.CHECKPOINT_REVISION == "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a"
    assert clap.EMBEDDING_SPACE == "clap-htsat-unfused-512-v1"
    assert clap.PREPROCESSING_VERSION == "clap-audio-center10s-v1"
    assert clap.processing_fingerprint() == clap.processing_fingerprint()


def test_preprocess_resamples_mixes_and_center_crops_without_random_truncation():
    frames = clap.TARGET_SAMPLE_RATE * 12
    stereo = np.stack([np.arange(frames, dtype=np.float32), np.arange(frames, dtype=np.float32)], axis=1)
    processed = clap.preprocess_audio(stereo, clap.TARGET_SAMPLE_RATE)
    assert processed.shape == (clap.MAX_AUDIO_FRAMES,)
    assert processed[0] == pytest.approx(float(clap.TARGET_SAMPLE_RATE))
    assert processed[-1] == pytest.approx(float(clap.TARGET_SAMPLE_RATE * 11 - 1))
    with pytest.raises(ValueError, match="nonfinite"):
        clap.preprocess_audio(np.array([np.nan], dtype=np.float32), clap.TARGET_SAMPLE_RATE)
    with pytest.raises(ValueError, match="empty"):
        clap.preprocess_audio(np.array([], dtype=np.float32), clap.TARGET_SAMPLE_RATE)


def test_v2_plan_reuses_rename_but_invalidates_boundaries_audio_preprocess_and_grid(tmp_path):
    path = tmp_path / "a.clap.npz"
    fingerprint = clap.processing_fingerprint()
    windows = [clap.Window(0.0, 8.0, 0.0, 16.0)]
    clap.write_sidecar_v2(path, sha256=SHA, clips=_clips(), clip_embeddings=np.array([_unit()]),
                          windows=windows, window_embeddings=np.array([_unit()]),
                          processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a")

    renamed = clap.sidecar_reuse_plan(path, sha256=SHA, clips=_clips("renamed"), windows=windows,
                                      processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a")
    assert renamed.clip_embeddings[0] is not None
    assert renamed.clip_names == ["renamed"]
    assert renamed.window_embeddings[0] is not None
    assert renamed.metadata_changed is True

    boundary = clap.sidecar_reuse_plan(path, sha256=SHA, clips=_clips(end=3.0), windows=windows,
                                       processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a")
    assert boundary.clip_embeddings == [None]
    assert boundary.window_embeddings[0] is not None

    changed_audio = clap.sidecar_reuse_plan(path, sha256="b" * 64, clips=_clips(), windows=windows,
                                            processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a")
    assert changed_audio.clip_embeddings == [None]
    assert changed_audio.window_embeddings == [None]

    changed_grid = clap.sidecar_reuse_plan(path, sha256=SHA, clips=_clips(), windows=windows,
                                           processing_fingerprint=fingerprint, window_grid_fingerprint="grid-b")
    assert changed_grid.clip_embeddings[0] is not None
    assert changed_grid.window_embeddings == [None]

    retired = clap.sidecar_reuse_plan(path, sha256=SHA, clips=[], windows=[],
                                      processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a")
    assert retired.clip_embeddings == []
    assert retired.window_embeddings == []
    assert retired.metadata_changed is True


def test_retired_clip_is_not_analyzed_or_stored_and_removal_requires_reconciliation(tmp_path):
    path = tmp_path / "a.clap.npz"
    fingerprint = clap.processing_fingerprint()
    windows = [clap.Window(0.0, 8.0, 0.0, 16.0)]
    clap.write_sidecar_v2(path, sha256=SHA, clips=_clips(), clip_embeddings=np.array([_unit()]),
                          windows=windows, window_embeddings=np.array([_unit()]),
                          processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a")

    retired = clap.sidecar_reuse_plan(
        path, sha256=SHA, clips=[{**_clips()[0], "retired": True}], windows=[],
        processing_fingerprint=fingerprint, window_grid_fingerprint="grid-a",
    )
    assert retired.clip_embeddings == []
    assert retired.window_embeddings == []
    assert retired.metadata_changed is True


def test_fallback_source_refs_survive_filter_failure_and_reorder(tmp_path):
    path = tmp_path / "a.clap.npz"
    fingerprint = clap.processing_fingerprint()
    original = [
        {"name": "first", "start": 0.0, "end": 2.0},
        {"name": "second", "start": 2.0, "end": 4.0},
    ]
    clap.write_sidecar_v2(path, sha256=SHA, clips=original, clip_embeddings=np.array([_unit(), _unit()]),
                          windows=[], window_embeddings=np.zeros((0, clap.EMBED_DIM), dtype=np.float32),
                          processing_fingerprint=fingerprint, window_grid_fingerprint="grid")
    reordered = [original[1], {"name": "bad", "start": 5.0, "end": 5.0}, original[0]]
    plan = clap.sidecar_reuse_plan(path, sha256=SHA, clips=reordered, windows=[],
                                   processing_fingerprint=fingerprint, window_grid_fingerprint="grid")
    assert plan.clip_embeddings[0] is not None
    assert plan.clip_embeddings[1] is None
    assert plan.clip_embeddings[2] is not None
    with np.load(path, allow_pickle=False) as sidecar:
        assert all(not str(ref).startswith("position:") for ref in sidecar["clip_source_refs"])


def test_legacy_corrupt_and_invalid_vectors_are_stale_and_reported(tmp_path):
    path = tmp_path / "a.clap.npz"
    np.savez(path, sha256=np.array(SHA), checkpoint=np.array(clap.CHECKPOINT))
    plan = clap.sidecar_reuse_plan(path, sha256=SHA, clips=_clips(), windows=[],
                                   processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    assert plan.clip_embeddings == [None]
    assert any(report["reason"] == "legacy_sidecar" for report in plan.reports)

    clap.write_sidecar_v2(path, sha256=SHA, clips=_clips(), clip_embeddings=np.array([_unit()]),
                          windows=[], window_embeddings=np.zeros((0, clap.EMBED_DIM)),
                          processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    with np.load(path, allow_pickle=False) as sidecar:
        corrupted = {key: sidecar[key] for key in sidecar.files}
    corrupted["clip_embeddings"] = np.array([np.zeros(clap.EMBED_DIM)])
    np.savez(path, **corrupted)
    plan = clap.sidecar_reuse_plan(path, sha256=SHA, clips=_clips(), windows=[],
                                   processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    assert plan.clip_embeddings == [None]
    assert any(report["reason"] == "invalid_vector" for report in plan.reports)


def test_malformed_v2_arrays_are_not_fresh(tmp_path):
    path = tmp_path / "a.clap.npz"
    clap.write_sidecar_v2(path, sha256=SHA, clips=_clips(), clip_embeddings=np.array([_unit()]),
                          windows=[], window_embeddings=np.zeros((0, clap.EMBED_DIM), dtype=np.float32),
                          processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    with np.load(path, allow_pickle=False) as sidecar:
        malformed = {key: sidecar[key] for key in sidecar.files}
    malformed["clip_end_s"] = np.array([], dtype=np.float64)
    np.savez(path, **malformed)
    assert clap.is_up_to_date(path, SHA) is False
    assert clap._read_v2(path) is None


def test_v2_writer_refuses_retired_regions_invalid_vectors_and_provenance(tmp_path):
    kwargs = dict(sha256=SHA, clips=_clips(), clip_embeddings=np.array([_unit()]), windows=[],
                  window_embeddings=np.zeros((0, clap.EMBED_DIM), dtype=np.float32),
                  processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    with pytest.raises(ValueError, match="retired"):
        clap.write_sidecar_v2(tmp_path / "retired.npz", **{**kwargs, "clips": [{**_clips()[0], "retired": True}]})
    with pytest.raises(ValueError, match="invalid embeddings"):
        clap.write_sidecar_v2(tmp_path / "zero.npz", **{**kwargs, "clip_embeddings": np.zeros((1, clap.EMBED_DIM))})
    with pytest.raises(ValueError, match="processing fingerprint"):
        clap.write_sidecar_v2(tmp_path / "provenance.npz", **{**kwargs, "processing_fingerprint": ""})


def test_text_limit_is_bounded_by_tokenizer_and_checkpoint():
    class Config:
        max_position_embeddings = 514

    class Model:
        class config:
            text_config = Config()

    class Tokenizer:
        model_max_length = 512

    class Processor:
        tokenizer = Tokenizer()

    assert clap._text_max_length(Model(), Processor()) == 512


def test_pipeline_keeps_valid_regions_when_one_embedding_fails_and_uses_native_decode(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("fit_features_for_test", pathlib.Path("scripts/fit-features.py"))
    assert spec and spec.loader
    fit_features = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fit_features)
    audio_path = tmp_path / "source.wav"
    import soundfile as sf
    sf.write(audio_path, np.zeros(22050 * 4, dtype=np.float32), 22050)
    manifest_path = tmp_path / "source.wav.apricity.json"
    manifest_path.write_text(json.dumps({
        "source": {"sha256": SHA}, "rhythm": {"beats": [], "downbeats": []},
        "annotations": {"clips": [
            {"id": "bad", "name": "bad", "start": 0.0, "end": 1.0},
            {"id": "good", "name": "good", "start": 1.0, "end": 2.0},
            {"id": "retired", "name": "old", "start": 2.0, "end": 3.0, "retired": True},
            {"id": "past", "name": "past", "start": 3.0, "end": 5.0},
        ]},
    }))
    from apricity_analyze import features
    monkeypatch.setattr(features, "is_up_to_date", lambda *_: True)
    calls = []

    def fake_embed(regions, sr):
        calls.append(sr)
        if len(calls) == 1:
            raise ValueError("bad model output")
        return np.array([_unit()])

    monkeypatch.setattr(clap, "embed_audio_batch", fake_embed)
    result = fit_features._process_one((str(manifest_path), True, False))
    assert calls == [22050, 22050]
    assert any(report["reason"].startswith("embedding_error") for report in result["clap_reports"])
    assert any(report["reason"] == "retired" for report in result["clap_reports"])
    assert any(report["reason"] == "boundary_past_source_duration" for report in result["clap_reports"])
    with np.load(clap.sidecar_path_for(manifest_path), allow_pickle=False) as sidecar:
        assert sidecar["clip_names"].tolist() == ["good"]


def test_empty_hash_and_invalid_bounds_are_excluded_without_inference(tmp_path, monkeypatch):
    monkeypatch.setattr(clap, "_load", lambda *_: pytest.fail("freshness planning loaded a model"))
    plan = clap.sidecar_reuse_plan(tmp_path / "missing.npz", sha256="", clips=_clips(), windows=[],
                                   processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    assert plan.clip_embeddings == []
    assert plan.reports == [{"kind": "sample", "reason": "invalid_audio_sha256"}]

    plan = clap.sidecar_reuse_plan(tmp_path / "missing.npz", sha256=SHA,
                                   clips=[{"id": "bad", "name": "bad", "start": 2.0, "end": 2.0}], windows=[],
                                   processing_fingerprint=clap.processing_fingerprint(), window_grid_fingerprint="grid")
    assert plan.clip_embeddings == [None]
    assert any(report["reason"] == "invalid_boundary" for report in plan.reports)
