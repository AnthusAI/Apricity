"""Safe, local regeneration of v2 CLAP sidecars from a canonical library export.

This module deliberately has no catalog persistence or publishing concerns: it consumes an
already-exported catalog and changes only the adjacent ``.clap.npz`` sidecar.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Callable

import numpy as np

from . import clap


def _grid_fingerprint(rhythm: dict) -> str:
    values = {key: rhythm.get(key) for key in ("bpm", "meter", "beats", "downbeats")}
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _valid_sha(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _report_sample() -> dict:
    return {"reused": {"saved_clip": 0, "window": 0}, "recomputed": {"saved_clip": 0, "window": 0},
            "excluded": [], "coverage": {"saved_clip": 0, "window": 0}}


def _exclude(row: dict, kind: str, reason: str, source_ref: str | None = None) -> None:
    item = {"kind": kind, "reason": reason}
    if source_ref is not None:
        item["source_ref"] = source_ref
    row["excluded"].append(item)


def _source_failure(report: dict, row: dict, sample_id: str, reason: str,
                    source_ref: str | None = None) -> None:
    """Record a terminal per-source failure without aborting healthy sources."""
    _exclude(row, "sample", reason, source_ref)
    report["sourceFailures"].append({"sampleId": sample_id, "reason": reason,
                                     **({"source_ref": source_ref} if source_ref else {})})
    report["hasSourceFailures"] = True


def _canonical_errors(samples: list, clips: list, recordings: list) -> list[str]:
    """Return catalog identity/alias errors which must stop *all* sidecar writes.

    IDs are the only stable identities used for catalog joins and sidecar source references.  A
    duplicate or malformed value would make a partial run silently overwrite another canonical
    record's result, so this is deliberately a whole-catalog preflight rather than a per-source
    exclusion.
    """
    errors: list[str] = []
    for label, entries in (("sample", samples), ("clip", clips), ("recording", recordings)):
        seen: set[str] = set()
        for entry in entries:
            value = entry.get("id") if isinstance(entry, dict) else None
            if not isinstance(value, str) or not value:
                errors.append(f"invalid_{label}_id")
            elif value in seen:
                errors.append(f"duplicate_{label}_id")
            else:
                seen.add(value)
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        aliases = sample.get("aliases")
        # `null`/omitted aliases are allowed, but a scalar string is never a sequence of paths.
        if aliases is not None and (not isinstance(aliases, list)
                                    or any(not isinstance(alias, str) or not alias for alias in aliases)):
            errors.append("invalid_sample_aliases")
    return sorted(set(errors))


def _safe_source(root: Path, sample: dict) -> tuple[Path | None, str | None]:
    candidates = []
    for raw in [sample.get("path"), *(sample.get("aliases") or [])]:
        if not isinstance(raw, str) or not raw:
            continue
        # Repository exports commonly retain this one repository-relative prefix.
        relative = raw.removeprefix("samples/")
        candidate = root / relative
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root.resolve(strict=True))
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            candidates.append(resolved)
    unique = sorted(set(candidates))
    if not unique:
        return None, "unsafe_source_path"
    if len(unique) != 1:
        return None, "ambiguous_source_path"
    return unique[0], None


def _safe_manifest(root: Path, source: Path) -> tuple[Path | None, str | None]:
    """Resolve the adjacent manifest without following a link out of the samples root."""
    candidate = source.with_name(source.name + ".apricity.json")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except FileNotFoundError:
        return None, "missing_source_manifest"
    except (OSError, ValueError):
        return None, "unsafe_source_manifest_path"
    return (resolved, None) if resolved.is_file() else (None, "missing_source_manifest")


def _valid_clip(clip: dict) -> bool:
    return (clip.get("retired") is not True and isinstance(clip.get("id"), str) and bool(clip["id"])
            and clap._valid_bounds(clip.get("start"), clip.get("end")))


def _run_embeddings(regions: list[tuple[str, str, np.ndarray]], sr: int, batch_size: int, row: dict) -> dict[str, np.ndarray]:
    accepted: dict[str, np.ndarray] = {}
    for offset in range(0, len(regions), batch_size):
        batch = regions[offset:offset + batch_size]
        try:
            vectors = clap.embed_audio_batch([region[2] for region in batch], sr)
            if len(vectors) != len(batch):
                raise ValueError("embedding batch size mismatch")
            outcomes = zip(batch, vectors, strict=True)
        except Exception:  # a batch failure must not hide healthy regions
            outcomes = []
            for region in batch:
                try:
                    vector = clap.embed_audio_batch([region[2]], sr)[0]
                except Exception as error:  # noqa: BLE001 - recorded per region
                    _exclude(row, region[0], f"embedding_error: {error}", region[1])
                    continue
                outcomes.append((region, vector))
        for region, vector in outcomes:
            if clap._valid_embedding(vector):
                accepted[region[1]] = np.asarray(vector, dtype=np.float32)
                row["recomputed"][region[0]] += 1
            else:
                _exclude(row, region[0], "invalid_vector", region[1])
    return accepted


def backfill(catalog: dict, samples_root: str | Path, selected_sample_ids=None, batch_size: int = 4,
             progress: Callable[[dict], None] | None = None) -> dict:
    """Backfill current canonical clips/windows, returning coverage and exclusion evidence.

    Invalid sources are source-fatal and never replace their existing sidecar. Region failures are
    partial: valid regions are atomically persisted and failed regions are omitted with evidence.
    """
    report = {"samples": {}, "fatal": [], "sourceFailures": [], "hasSourceFailures": False,
              "batchSize": batch_size}
    root = Path(samples_root)
    if (not isinstance(catalog, dict) or not root.is_dir() or type(batch_size) is not int
            or not 1 <= batch_size <= 8):
        report["fatal"].append("invalid_input")
        return report
    samples = catalog.get("samples")
    clips = catalog.get("clips")
    recordings = catalog.get("recordings")
    analyses = catalog.get("analyses")
    if not isinstance(samples, list) or not isinstance(clips, list) or not isinstance(recordings, list) or not isinstance(analyses, dict):
        report["fatal"].append("invalid_catalog_shape")
        return report
    canonical_errors = _canonical_errors(samples, clips, recordings)
    if canonical_errors:
        report["fatal"].extend(canonical_errors)
        return report
    if isinstance(selected_sample_ids, str):
        report["fatal"].append("invalid_requested_sample_id")
        return report
    try:
        wanted = set(selected_sample_ids) if selected_sample_ids is not None else None
    except TypeError:
        report["fatal"].append("invalid_requested_sample_id")
        return report
    if wanted is not None and (not all(isinstance(item, str) and item for item in wanted)):
        report["fatal"].append("invalid_requested_sample_id")
        return report
    available = {item.get("id") for item in samples if isinstance(item, dict)}
    missing = (wanted or set()) - available
    if missing:
        report["fatal"].append("unknown_requested_sample_id")
    for sample in samples:
        if not isinstance(sample, dict) or not isinstance(sample.get("id"), str) or (wanted is not None and sample["id"] not in wanted):
            continue
        sample_id = sample["id"]
        row = report["samples"][sample_id] = _report_sample()
        if progress:
            progress({"sampleId": sample_id, "state": "started"})
        source, source_error = _safe_source(root, sample)
        analysis = analyses.get(sample_id) if isinstance(analyses, dict) else None
        sample_sha = sample.get("audio", {}).get("sha256") if isinstance(sample.get("audio"), dict) else None
        if source_error:
            _source_failure(report, row, sample_id, source_error)
        elif not isinstance(analysis, dict):
            _source_failure(report, row, sample_id, "missing_analysis")
        elif not _valid_sha(sample_sha):
            _source_failure(report, row, sample_id, "invalid_audio_sha256")
        elif not isinstance(sample.get("recordingId"), str) or sample["recordingId"] not in {
                entry.get("id") for entry in recordings if isinstance(entry, dict)}:
            _source_failure(report, row, sample_id, "missing_recording")
        else:
            try:
                actual_sha = _file_sha256(source)
            except OSError as error:
                _source_failure(report, row, sample_id, f"audio_hash_error: {error}")
                actual_sha = None
            manifest_path, manifest_error = _safe_manifest(root, source)
            if actual_sha is None:
                pass
            elif actual_sha != sample_sha:
                _source_failure(report, row, sample_id, "audio_sha_mismatch")
            elif analysis.get("source", {}).get("sha256") != sample_sha:
                _source_failure(report, row, sample_id, "analysis_source_sha_mismatch")
            elif manifest_error:
                _source_failure(report, row, sample_id, manifest_error)
            else:
                try:
                    disk_manifest = json.loads(manifest_path.read_text())
                except Exception as error:  # noqa: BLE001
                    _source_failure(report, row, sample_id, f"unreadable_source_manifest: {error}")
                    disk_manifest = None
                if isinstance(disk_manifest, dict) and disk_manifest.get("source", {}).get("sha256") != sample_sha:
                    _source_failure(report, row, sample_id, "source_manifest_sha_mismatch")
                    disk_manifest = None
                if not isinstance(analysis.get("rhythm"), dict):
                    _source_failure(report, row, sample_id, "missing_analysis_grid")
                    disk_manifest = None
                if isinstance(disk_manifest, dict) and not isinstance(disk_manifest.get("rhythm"), dict):
                    _source_failure(report, row, sample_id, "missing_source_manifest_grid")
                    disk_manifest = None
                if (isinstance(disk_manifest, dict)
                        and _grid_fingerprint(disk_manifest["rhythm"]) != _grid_fingerprint(analysis["rhythm"])):
                    _source_failure(report, row, sample_id, "analysis_grid_mismatch")
                    disk_manifest = None
                if isinstance(disk_manifest, dict):
                    canonical = [item for item in clips if isinstance(item, dict) and item.get("sampleId") == sample_id]
                    live, windows = [], clap.bar_grid_windows(analysis.get("rhythm", {}).get("downbeats", []), analysis.get("rhythm", {}).get("beats", []))
                    for index, item in enumerate(canonical):
                        ref = clap._clip_source_ref(item, index)
                        if item.get("retired") is True:
                            _exclude(row, "saved_clip", "retired", ref)
                        elif not _valid_clip(item):
                            _exclude(row, "saved_clip", "invalid_boundary", ref)
                        else:
                            live.append(item)
                    fingerprint = clap.processing_fingerprint()
                    grid = _grid_fingerprint(analysis.get("rhythm", {}))
                    sidecar = clap.sidecar_path_for(manifest_path)
                    plan = clap.sidecar_reuse_plan(sidecar, sha256=sample_sha, clips=live, windows=windows,
                                                   processing_fingerprint=fingerprint, window_grid_fingerprint=grid)
                    for item in plan.reports:
                        _exclude(row, item.get("kind", "sidecar"), item["reason"], item.get("source_ref"))
                    try:
                        import soundfile as sf
                        audio, sr = sf.read(str(source), dtype="float32", always_2d=True)
                    except Exception as error:  # source decoding is fatal to any replacement
                        _source_failure(report, row, sample_id, f"decode_error: {error}")
                        audio, sr = None, 0
                    if audio is not None:
                        duration = len(audio) / sr
                        regions = []
                        for index, (clip_row, vector) in enumerate(zip(live, plan.clip_embeddings, strict=True)):
                            ref = clap._clip_source_ref(clip_row, index)
                            if clip_row["end"] > duration:
                                _exclude(row, "saved_clip", "boundary_past_source_duration", ref)
                            elif vector is None:
                                a, b = int(clip_row["start"] * sr), int(clip_row["end"] * sr)
                                if b <= a:
                                    _exclude(row, "saved_clip", "zero_length_after_frame_conversion", ref)
                                else:
                                    regions.append(("saved_clip", ref, audio[a:b]))
                            else:
                                row["reused"]["saved_clip"] += 1
                        for index, (window, vector) in enumerate(zip(windows, plan.window_embeddings, strict=True)):
                            ref = f"window:{index}"
                            if window.end_s > duration:
                                _exclude(row, "window", "boundary_past_source_duration", ref)
                            elif vector is None:
                                a, b = int(window.start_s * sr), int(window.end_s * sr)
                                if b <= a:
                                    _exclude(row, "window", "zero_length_after_frame_conversion", ref)
                                else:
                                    regions.append(("window", ref, audio[a:b]))
                            else:
                                row["reused"]["window"] += 1
                        fresh = _run_embeddings(regions, sr, batch_size, row)
                        accepted_clips, clip_vectors = [], []
                        for index, (item, vector) in enumerate(zip(live, plan.clip_embeddings, strict=True)):
                            ref = clap._clip_source_ref(item, index)
                            vector = vector if vector is not None else fresh.get(ref)
                            if vector is not None and item["end"] <= duration:
                                accepted_clips.append(item); clip_vectors.append(vector)
                        accepted_windows, window_vectors = [], []
                        for index, (item, vector) in enumerate(zip(windows, plan.window_embeddings, strict=True)):
                            ref = f"window:{index}"
                            vector = vector if vector is not None else fresh.get(ref)
                            if vector is not None and item.end_s <= duration:
                                accepted_windows.append(item); window_vectors.append(vector)
                        clip_matrix = np.stack(clip_vectors).astype(np.float32) if clip_vectors else np.zeros((0, clap.EMBED_DIM), dtype=np.float32)
                        window_matrix = np.stack(window_vectors).astype(np.float32) if window_vectors else np.zeros((0, clap.EMBED_DIM), dtype=np.float32)
                        if plan.metadata_changed or regions:
                            try:
                                clap.write_sidecar_v2(sidecar, sha256=sample_sha, clips=accepted_clips, clip_embeddings=clip_matrix,
                                                      windows=accepted_windows, window_embeddings=window_matrix,
                                                      processing_fingerprint=fingerprint, window_grid_fingerprint=grid,
                                                      reports=row["excluded"])
                            except Exception as error:  # atomic writer leaves its old destination intact
                                _source_failure(report, row, sample_id, f"sidecar_write_error: {error}")
                                # These vectors were never durably indexed.  Do not claim coverage
                                # from a failed atomic replacement, even if an old sidecar remains.
                                accepted_clips, accepted_windows = [], []
                        row["coverage"] = {"saved_clip": len(accepted_clips), "window": len(accepted_windows)}
        if progress:
            progress({"sampleId": sample_id, "state": "completed", "report": row})
    return report
