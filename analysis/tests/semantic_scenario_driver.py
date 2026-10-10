"""Ground observations for the initiative's executable Gherkin scenarios."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile

import numpy as np

from apricity_analyze import clap


def unit(index: int) -> np.ndarray:
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1
    return vector


def observations(action: str) -> dict:
    if action == "repeatability":
        if not clap.is_model_cached():
            raise RuntimeError("not_evaluated: pinned model is unavailable; this gate cannot be skipped")
        audio = (0.2 * np.sin(2 * np.pi * 220 * np.arange(576000) / 48000)).astype(np.float32)
        first = clap.embed_audio(audio, 48000)
        second = clap.embed_audio(audio, 48000)
        return {
            "status": "measured", "dimensions": len(first),
            "finite": bool(np.isfinite(first).all() and np.isfinite(second).all()),
            "equivalent": bool(np.allclose(first, second, atol=1e-6, rtol=1e-5)),
            "maxAbsDelta": float(np.max(np.abs(first - second))),
            "norms": [float(np.linalg.norm(first)), float(np.linalg.norm(second))],
            "cropFrames": len(clap.preprocess_audio(audio, 48000)),
        }
    with tempfile.TemporaryDirectory(prefix="apricity-semantic-bdd-") as folder:
        path = Path(folder) / "a.npz"
        clips = [dict(id="a1", name="a1", start=0., end=4.), dict(id="a2", name="a2", start=4., end=8.)]
        windows = [clap.Window(0., 8., 0., 16.)]
        fingerprint = clap.processing_fingerprint()
        clap.write_sidecar_v2(path, sha256="a" * 64, clips=clips, clip_embeddings=np.stack([unit(0), unit(1)]),
                              windows=windows, window_embeddings=np.stack([unit(2)]),
                              processing_fingerprint=fingerprint, window_grid_fingerprint="grid")
        if action == "freshness":
            changed = [dict(clips[0], end=3.), dict(clips[1], name="a2-renamed")]
            plan = clap.sidecar_reuse_plan(path, sha256="a" * 64, clips=changed, windows=windows,
                                          processing_fingerprint=fingerprint, window_grid_fingerprint="grid")
            recomputed = [changed[i]["id"] for i, v in enumerate(plan.clip_embeddings) if v is None]
            vectors = [unit(3) if v is None else v for v in plan.clip_embeddings]
            clap.write_sidecar_v2(path, sha256="a" * 64, clips=changed, clip_embeddings=np.stack(vectors),
                                  windows=windows, window_embeddings=np.stack(plan.window_embeddings),
                                  processing_fingerprint=fingerprint, window_grid_fingerprint="grid")
            with np.load(path, allow_pickle=False) as saved:
                return {
                    "recomputedClipIds": recomputed, "renamed": str(saved["clip_names"][1]),
                    "renamedVectorUnchanged": bool(np.array_equal(saved["clip_embeddings"][1], unit(1))),
                    "windowVectorUnchanged": bool(np.array_equal(saved["window_embeddings"][0], unit(2))),
                }
        if action == "invalid":
            cases = [("missing", None), ("zero", np.zeros(512)), ("nonfinite", np.full(512, np.nan)),
                     ("wrong_dimension", np.ones(511))]
            excluded = [name for name, value in cases if not clap._valid_embedding(value)]
            with np.load(path, allow_pickle=False) as saved:
                incompatible = {k: saved[k].copy() for k in saved.files}
            incompatible["embedding_space"] = np.array("incompatible-space")
            np.savez_compressed(path, **incompatible)
            plan = clap.sidecar_reuse_plan(path, sha256="a" * 64, clips=clips, windows=windows,
                                          processing_fingerprint=fingerprint, window_grid_fingerprint="grid")
            excluded.append("incompatible_space")
            return {"excluded": excluded, "incompatibleVectorReused": any(v is not None for v in plan.clip_embeddings),
                    "reports": [r["reason"] for r in plan.reports]}
    raise ValueError(f"unknown scenario action: {action}")


if __name__ == "__main__":
    print(json.dumps(observations(sys.argv[1])))
