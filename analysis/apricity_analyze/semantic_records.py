"""Materialize only current, rooted semantic records from CLAP v2 sidecars."""
from __future__ import annotations
from datetime import datetime
import hashlib, json, math
from pathlib import Path
from typing import Any
import numpy as np
from . import clap
from .semantic_contract import SemanticContractError, SemanticIdentity, round_half_up_microseconds, validate_vector

def _compact(value): return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
def _report(out, kind, reason, source_ref=""):
    row = {"kind": kind, "reason": reason}
    if source_ref: row["sourceRef"] = source_ref
    out.append(row)
def _result(records, excluded): return {"records": records, "excluded": excluded, "coverage": {"records": len(records), "excluded": len(excluded)}}

def load_catalog(source: dict) -> dict:
    required = {"samples", "clips", "recordings", "analyses"}
    if not isinstance(source, dict) or set(source) != required or not all(isinstance(source[k], list) for k in ("samples", "clips", "recordings")) or not isinstance(source["analyses"], dict): raise ValueError("catalog must be exactly samples, clips, recordings, and analyses")
    for name in ("samples", "clips", "recordings"):
        rows, ids = source[name], [row.get("id") for row in source[name] if isinstance(row, dict)]
        if len(rows) != len(ids) or any(not isinstance(x, str) or not x for x in ids) or len(ids) != len(set(ids)): raise ValueError(f"catalog {name} must contain unique canonical ids")
    return {"samples": tuple(source["samples"]), "clips": tuple(source["clips"]), "recordings": {r["id"]: r for r in source["recordings"]}, "analyses": dict(source["analyses"])}

def _sidecar(path: Path) -> dict[str, Any] | None:
    try:
        with np.load(path, allow_pickle=False) as z:
            if "sidecar_schema_version" not in z.files or int(z["sidecar_schema_version"]) != clap.SIDECAR_SCHEMA_VERSION: return None
            return {key: z[key].copy() for key in z.files}
    except Exception: return None
def _scalar(stored, key):
    value = stored.get(key)
    return str(value.item()) if isinstance(value, np.ndarray) and value.shape == () else ""
def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, np.number)): return None
    value = float(value)
    return value if math.isfinite(value) else None
def _bounds(start, end, duration):
    start, end = _finite(start), _finite(end)
    if start is None or end is None or start < 0 or end <= start or duration is None or end > duration: return None
    try: round_half_up_microseconds(start); round_half_up_microseconds(end)
    except SemanticContractError: return None
    return start, end
def _duration(sample):
    audio = sample.get("audio")
    for value in (sample.get("duration"), audio.get("duration") if isinstance(audio, dict) else None):
        value = _finite(value)
        if value is not None and value > 0: return value
    return None

def _rooted_path(value, root):
    if not isinstance(value, str) or not value: return None
    path = Path(value)
    if not path.is_absolute():
        if root is None: return None
        parts = path.parts[1:] if path.parts and path.parts[0] == "samples" else path.parts
        path = root.joinpath(*parts)
    try:
        resolved = path.resolve(strict=True)
        if root is not None: resolved.relative_to(root.resolve(strict=True))
        return resolved
    except (OSError, ValueError): return None
def _matching_samples(manifest_path, samples, root):
    suffix = ".apricity.json"
    if not manifest_path.name.endswith(suffix): return [], "invalid_manifest_path"
    actual = _rooted_path(str(manifest_path.with_name(manifest_path.name[:-len(suffix)])), root)
    if actual is None: return [], "samples_root_required" if root is None else "invalid_manifest_path"
    relative = any(not Path(v).is_absolute() for s in samples for v in [s.get("path"), *((s.get("aliases") or []) if isinstance(s.get("aliases"), list) else [])] if isinstance(v, str))
    if relative and root is None: return [], "samples_root_required"
    matches = []
    for sample in samples:
        aliases = sample.get("aliases")
        for value in [sample.get("path")] + (aliases if isinstance(aliases, list) else []):
            if _rooted_path(value, root) == actual: matches.append(sample); break
    return matches, None
def _grid(analysis):
    if not isinstance(analysis, dict) or not isinstance(analysis.get("rhythm"), dict): return None, None
    rhythm = analysis["rhythm"]
    fingerprint = hashlib.sha256(json.dumps({k: rhythm.get(k) for k in ("bpm", "meter", "beats", "downbeats")}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try: windows = {(round_half_up_microseconds(w.start_s), round_half_up_microseconds(w.end_s)) for w in clap.bar_grid_windows(rhythm.get("downbeats", []), rhythm.get("beats", []))}
    except (TypeError, ValueError, SemanticContractError): return fingerprint, None
    return fingerprint, windows
def _array(stored, key, dimensions):
    value = stored.get(key)
    return value if isinstance(value, np.ndarray) and value.ndim == dimensions else None
def _string_array_or_null(value):
    return value is None or (isinstance(value, list) and all(isinstance(item, str) for item in value))

def _record(sample, clip, kind, start, end, vector, fingerprint, updated_at, grid=""):
    audio = sample["audio"]
    identity = SemanticIdentity(sample_id=sample["id"], recording_id=sample["recordingId"], kind=kind, clip_id=clip["id"] if clip else None, start=start, end=end, audio_sha256=audio["sha256"], embedding_space=clap.EMBEDDING_SPACE, processing_fingerprint=fingerprint)
    display = {"samplePath": sample["path"], "sampleTitle": sample.get("title") or "", "tags": list(sample.get("tags") or [])}
    if clip:
        if "name" in clip: display["clipName"] = clip["name"]
        if "kind" in clip: display["clipKind"] = clip["kind"]
    semantic_id = identity.semantic_id
    return {"identity": {"semanticId": semantic_id, "sampleId": identity.sample_id, "recordingId": identity.recording_id, "kind": kind, **({"clipId": identity.clip_id} if clip else {}), "start": start, "end": end, "audioSha256": identity.audio_sha256, "embeddingSpace": identity.embedding_space, "processingFingerprint": identity.processing_fingerprint}, "vector": list(validate_vector(vector)), "display": display, "playback": {"fileKey": audio["key"], "start": start, "end": end}, "revision": hashlib.sha256(_compact([semantic_id, grid if kind == "window" else ""]).encode()).hexdigest(), "metadataUpdatedAt": updated_at}

def materialize_sidecar(manifest_path: Path, catalog: dict, metadata_updated_at: str, expected_processing_fingerprint: str | None = None, samples_root: Path | None = None) -> dict:
    try:
        timestamp = datetime.fromisoformat(metadata_updated_at.replace("Z", "+00:00")) if isinstance(metadata_updated_at, str) else None
        if timestamp is None or timestamp.tzinfo is None or timestamp.utcoffset() is None: raise ValueError
    except ValueError as error: raise ValueError("metadata_updated_at must be a timezone-aware canonical timestamp") from error
    excluded, records, root = [], [], Path(samples_root) if samples_root is not None else None
    matches, error = _matching_samples(Path(manifest_path), catalog["samples"], root)
    if error or len(matches) != 1:
        _report(excluded, "sample", error or ("missing_sample_mapping" if not matches else "ambiguous_sample_mapping")); return _result(records, excluded)
    sample = matches[0]
    if (sample.get("title") is not None and not isinstance(sample.get("title"), str)) or not _string_array_or_null(sample.get("aliases")) or not _string_array_or_null(sample.get("tags")):
        _report(excluded, "sample", "invalid_metadata"); return _result(records, excluded)
    audio = sample.get("audio")
    if not isinstance(audio, dict) or not isinstance(audio.get("sha256"), str) or not isinstance(audio.get("key"), str) or not audio["key"]: _report(excluded, "sample", "missing_current_audio"); return _result(records, excluded)
    if sample.get("recordingId") not in catalog["recordings"]: _report(excluded, "sample", "missing_recording_mapping"); return _result(records, excluded)
    stored = _sidecar(clap.sidecar_path_for(Path(manifest_path)))
    if stored is None: _report(excluded, "sidecar", "legacy_sidecar"); return _result(records, excluded)
    fingerprint = expected_processing_fingerprint or clap.processing_fingerprint()
    expected = {"sha256": audio["sha256"], "checkpoint": clap.CHECKPOINT, "checkpoint_revision": clap.CHECKPOINT_REVISION, "embedding_space": clap.EMBEDDING_SPACE, "processing_fingerprint": fingerprint}
    if any(_scalar(stored, key) != value for key, value in expected.items()): _report(excluded, "sidecar", "stale_provenance"); return _result(records, excluded)
    duration = _duration(sample)
    refs, starts, ends, vectors, fprints = (_array(stored, "clip_source_refs", 1), _array(stored, "clip_start_s", 1), _array(stored, "clip_end_s", 1), _array(stored, "clip_embeddings", 2), _array(stored, "clip_fingerprints", 1))
    if any(x is None for x in (refs, starts, ends, vectors)): _report(excluded, "sidecar", "invalid_sidecar_shape")
    else:
        count = min(map(len, (refs, starts, ends, vectors)))
        if any(len(x) != count for x in (refs, starts, ends, vectors)): _report(excluded, "sidecar", "invalid_sidecar_shape")
        for i in range(count):
            ref, bounds = str(refs[i]), _bounds(starts[i], ends[i], duration)
            if bounds is None: _report(excluded, "saved_clip", "boundary_past_duration", ref); continue
            if fprints is None or i >= len(fprints): _report(excluded, "saved_clip", "missing_clip_fingerprint", ref); continue
            region_fingerprint = clap._region_fingerprint("saved_clip", ref, *bounds, audio["sha256"], fingerprint)
            if str(fprints[i]) != region_fingerprint: _report(excluded, "saved_clip", "corrupt_region_fingerprint", ref); continue
            if ref.startswith("id:"):
                options = [c for c in catalog["clips"] if c.get("id") == ref[3:]]
            elif ref.startswith("alias:"):
                alias = ref[6:]
                options = [c for c in catalog["clips"] if c.get("sampleId") == sample["id"] and c.get("source_ref", c.get("sourceRef")) == alias]
            elif ref.startswith("source-boundary:"):
                options = [c for c in catalog["clips"] if c.get("sampleId") == sample["id"] and _bounds(c.get("start"), c.get("end"), duration) == bounds]
            else:
                options = []
            if not options: _report(excluded, "saved_clip", "missing_clip_mapping", ref); continue
            if len(options) != 1: _report(excluded, "saved_clip", "ambiguous_clip_mapping", ref); continue
            clip = options[0]; canonical = _bounds(clip.get("start"), clip.get("end"), duration)
            if canonical is None: _report(excluded, "saved_clip", "invalid_canonical_bounds", ref); continue
            if clip.get("sampleId") != sample["id"]: _report(excluded, "saved_clip", "clip_wrong_parent", ref); continue
            if clip.get("retired") is True: _report(excluded, "saved_clip", "retired_clip", ref); continue
            if tuple(map(round_half_up_microseconds, canonical)) != tuple(map(round_half_up_microseconds, bounds)): _report(excluded, "saved_clip", "clip_boundary_mismatch", ref); continue
            if any(key in clip and not isinstance(clip[key], str) for key in ("name", "kind")): _report(excluded, "saved_clip", "invalid_metadata", ref); continue
            try: records.append(_record(sample, clip, "saved_clip", *bounds, vectors[i], fingerprint, metadata_updated_at))
            except (SemanticContractError, TypeError): _report(excluded, "saved_clip", "invalid_vector", ref)
    grid, valid_windows = _grid(catalog["analyses"].get(sample["id"]))
    starts, ends, vectors, fprints = (_array(stored, "window_start_s", 1), _array(stored, "window_end_s", 1), _array(stored, "window_embeddings", 2), _array(stored, "window_fingerprints", 1))
    if any(x is None for x in (starts, ends, vectors)): _report(excluded, "sidecar", "invalid_sidecar_shape")
    elif grid is None or valid_windows is None: _report(excluded, "window", "missing_analysis")
    elif _scalar(stored, "window_grid_fingerprint") != grid: _report(excluded, "window", "stale_window_grid")
    else:
        count = min(map(len, (starts, ends, vectors)))
        if any(len(x) != count for x in (starts, ends, vectors)): _report(excluded, "sidecar", "invalid_sidecar_shape")
        for i in range(count):
            ref, bounds = f"window:{i}", _bounds(starts[i], ends[i], duration)
            if bounds is None: _report(excluded, "window", "boundary_past_duration", ref); continue
            if fprints is None or i >= len(fprints): _report(excluded, "window", "missing_window_fingerprint", ref); continue
            region_fingerprint = clap._region_fingerprint("window", ref, *bounds, audio["sha256"], fingerprint, grid)
            if str(fprints[i]) != region_fingerprint: _report(excluded, "window", "corrupt_region_fingerprint", ref); continue
            if tuple(map(round_half_up_microseconds, bounds)) not in valid_windows: _report(excluded, "window", "window_outside_current_grid", ref); continue
            try: records.append(_record(sample, None, "window", *bounds, vectors[i], fingerprint, metadata_updated_at, grid))
            except (SemanticContractError, TypeError): _report(excluded, "window", "invalid_vector", ref)
    return _result(records, excluded)
