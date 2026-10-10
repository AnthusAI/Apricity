"""Build the immutable, current-only input artifact for M4 clustering.

``build_cluster_snapshot`` returns a newly allocated dictionary with this exact
schema (all lists are deterministically sorted and contain no caller-owned
objects)::

    {
      "schemaVersion": "apricity.cluster-corpus/1",
      "embeddingSpace": str,
      "processingFingerprint": str,
      "corpusDigest": lowercase_sha256,
      "regions": [{"semanticId": str, "vector": tuple[float, ...],
                   "aliases": [{"semanticId": str,
                                "semanticIdentity": {canonical identity fields},
                                "sample": {"id": str},
                                "recording": {"id": str},
                                "clip": {"id": str} | None}]}],
      "excluded": [{"reason": str, "semanticId": str | None}],
      "disagreements": [{"reason": "alias_vector_disagreement",
                           "semanticIds": [str, ...]}],
      "coverage": {"records": int, "regions": int, "excluded": int}
    }

The digest is SHA-256 over every globally semantic-ID-sorted alias's compact canonical
identity tuple and that alias's vector as 512 IEEE-754 binary32 little-endian
values.  Every signed zero is converted to +0.0 before packing.  Thus even a
non-representative alias-vector change invalidates the corpus.  The visible
representative is the smallest semantic ID; an alias-vector disagreement is
retained and reported, never silently averaged.
Any repeated semantic ID is instead excluded in full: a collision never picks
the first input record as a representative.
This is deliberately only the corpus packet for the next UMAP/HDBSCAN task:
it does no reduction, clustering, labels, publication, or quality assessment.
"""
from __future__ import annotations

import hashlib
import json
import struct
from typing import Any, Callable, Iterable

from .semantic_contract import SemanticContractError, SemanticIdentity, round_half_up_microseconds, validate_vector
from .semantic_records import _grid, load_catalog


SCHEMA_VERSION = "apricity.cluster-corpus/1"


def _compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _revision(semantic_id: str, grid: str) -> str:
    return hashlib.sha256(_compact([semantic_id, grid])).hexdigest()


def _catalog(value: dict[str, Any]) -> dict[str, Any]:
    """Accept the raw ``load_catalog`` input or its already-loaded result."""
    if isinstance(value, dict) and isinstance(value.get("samples"), list):
        return load_catalog(value)
    if (isinstance(value, dict) and isinstance(value.get("samples"), tuple)
            and isinstance(value.get("recordings"), dict) and isinstance(value.get("clips"), tuple)
            and isinstance(value.get("analyses"), dict)):
        return value
    raise ValueError("catalog must be semantic_records.load_catalog input or result")


def _audio_duration(sample: dict[str, Any]) -> float | None:
    audio = sample.get("audio")
    values = (sample.get("duration"), audio.get("duration") if isinstance(audio, dict) else None)
    for value in values:
        if isinstance(value, bool):
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        if value > 0 and value != float("inf"):
            return value
    return None


def _identity(record: object) -> tuple[SemanticIdentity, dict[str, Any]]:
    if not isinstance(record, dict) or not isinstance(record.get("identity"), dict):
        raise SemanticContractError("record must contain an identity")
    source = record["identity"]
    identity = SemanticIdentity(
        sample_id=source.get("sampleId"), recording_id=source.get("recordingId"), kind=source.get("kind"),
        clip_id=source.get("clipId"), start=source.get("start"), end=source.get("end"),
        audio_sha256=source.get("audioSha256"), embedding_space=source.get("embeddingSpace"),
        processing_fingerprint=source.get("processingFingerprint"),
    )
    return identity, source


def _visibility_result(policy: Callable[..., object] | None, sample: dict[str, Any], recording: dict[str, Any], clip: dict[str, Any] | None) -> tuple[bool, str]:
    """Use injected canonical policy; no status field is interpreted here."""
    if policy is None:
        return True, ""
    decision = policy(sample, recording, clip)
    if isinstance(decision, tuple) and len(decision) == 2:
        permitted, reason = decision
        return bool(permitted), str(reason) if reason else "visibility_denied"
    return bool(decision), "visibility_denied"


def _canonical_identity(identity: SemanticIdentity) -> dict[str, object]:
    return {
        "semanticId": identity.semantic_id, "sampleId": identity.sample_id, "recordingId": identity.recording_id,
        "kind": identity.kind, **({"clipId": identity.clip_id} if identity.clip_id is not None else {}),
        "start": identity.start, "end": identity.end, "audioSha256": identity.audio_sha256,
        "embeddingSpace": identity.embedding_space, "processingFingerprint": identity.processing_fingerprint,
    }


def _exclude(rows: list[dict[str, object]], reason: str, semantic_id: object = None) -> None:
    rows.append({"reason": reason, "semanticId": semantic_id if isinstance(semantic_id, str) else None})


def _valid_region(record: object, catalog: dict[str, Any], embedding_space: str, processing_fingerprint: str,
                  visibility: Callable[..., object] | None) -> tuple[tuple[object, ...], dict[str, object]] | tuple[None, tuple[str, object]]:
    try:
        identity, supplied = _identity(record)
    except SemanticContractError:
        return None, ("invalid_identity", None)
    supplied_id = supplied.get("semanticId")
    if supplied_id != identity.semantic_id:
        return None, ("tampered_semantic_id", supplied_id)
    if identity.embedding_space != embedding_space:
        return None, ("incompatible_embedding_space", identity.semantic_id)
    if identity.processing_fingerprint != processing_fingerprint:
        return None, ("incompatible_processing_fingerprint", identity.semantic_id)
    sample = next((row for row in catalog["samples"] if row.get("id") == identity.sample_id), None)
    if sample is None:
        return None, ("missing_sample", identity.semantic_id)
    recording = catalog["recordings"].get(identity.recording_id)
    if recording is None:
        return None, ("missing_recording", identity.semantic_id)
    if sample.get("recordingId") != identity.recording_id:
        return None, ("sample_recording_mismatch", identity.semantic_id)
    if sample.get("retired") is True:
        return None, ("retired_sample", identity.semantic_id)
    if recording.get("retired") is True:
        return None, ("retired_recording", identity.semantic_id)
    audio = sample.get("audio")
    if not isinstance(audio, dict) or audio.get("sha256") != identity.audio_sha256:
        return None, ("current_audio_mismatch", identity.semantic_id)
    duration = _audio_duration(sample)
    if duration is None or identity.end > duration:
        return None, ("boundary_past_duration", identity.semantic_id)

    clip = None
    grid = ""
    if identity.kind == "saved_clip":
        clip = next((row for row in catalog["clips"] if row.get("id") == identity.clip_id), None)
        if clip is None:
            return None, ("missing_clip", identity.semantic_id)
        if clip.get("sampleId") != identity.sample_id:
            return None, ("clip_wrong_parent", identity.semantic_id)
        if clip.get("retired") is True:
            return None, ("retired_clip", identity.semantic_id)
        try:
            current = (round_half_up_microseconds(clip.get("start")), round_half_up_microseconds(clip.get("end")))
        except SemanticContractError:
            return None, ("invalid_current_bounds", identity.semantic_id)
        if current != (identity.start_us, identity.end_us):
            return None, ("current_boundary_mismatch", identity.semantic_id)
    else:
        analysis = catalog["analyses"].get(identity.sample_id)
        if not isinstance(analysis, dict) or not isinstance(analysis.get("rhythm"), dict):
            return None, ("missing_analysis", identity.semantic_id)
        if not isinstance(analysis.get("source"), dict) or analysis["source"].get("sha256") != audio.get("sha256"):
            return None, ("analysis_source_sha_mismatch", identity.semantic_id)
        grid, windows = _grid(analysis)
        if not grid or windows is None:
            return None, ("missing_analysis", identity.semantic_id)
        if (identity.start_us, identity.end_us) not in windows:
            return None, ("window_outside_current_grid", identity.semantic_id)
    if record.get("revision") != _revision(identity.semantic_id, grid):
        return None, ("stale_revision", identity.semantic_id)
    allowed, reason = _visibility_result(visibility, sample, recording, clip)
    if not allowed:
        return None, (reason, identity.semantic_id)
    try:
        vector = validate_vector(record.get("vector"))
    except (SemanticContractError, TypeError):
        return None, ("invalid_vector", identity.semantic_id)
    key = (identity.recording_id, identity.audio_sha256, identity.start_us, identity.end_us,
           identity.embedding_space, identity.processing_fingerprint)
    alias = {"semanticId": identity.semantic_id, "semanticIdentity": _canonical_identity(identity),
             "sample": {"id": identity.sample_id}, "recording": {"id": identity.recording_id},
             "clip": {"id": identity.clip_id} if identity.clip_id is not None else None}
    return key, {"semanticId": identity.semantic_id, "identity": identity, "vector": tuple(vector), "alias": alias}


def _digest(regions: Iterable[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    digest.update((SCHEMA_VERSION + "\n").encode("ascii"))
    aliases = sorted((alias for region in regions for alias in region["aliases"]), key=lambda row: row["semanticId"])
    for alias in aliases:
        digest.update(_compact(alias["_tuple"]))
        digest.update(b"\0")
        vector = tuple(0.0 if value == 0.0 else value for value in alias["_vector"])
        digest.update(struct.pack("<512f", *vector))
        digest.update(b"\n")
    return digest.hexdigest()


def build_cluster_snapshot(records: Iterable[object], catalog: dict[str, Any], *, embedding_space: str,
                           processing_fingerprint: str, visibility: Callable[..., object] | None = None) -> dict[str, object]:
    """Return a current, single-space semantic corpus snapshot without mutating inputs.

    ``visibility`` is an injected existing canonical policy callable receiving
    ``(sample, recording, clip_or_none)``.  It returns a bool or
    ``(bool, exclusion_reason)``.  ``None`` is an explicit trusted-local
    policy, intentionally not an interpretation of any catalog status field.
    """
    if not isinstance(embedding_space, str) or not embedding_space:
        raise ValueError("embedding_space must be a nonempty string")
    if not isinstance(processing_fingerprint, str) or not processing_fingerprint:
        raise ValueError("processing_fingerprint must be a nonempty string")
    current_catalog = _catalog(catalog)
    excluded: list[dict[str, object]] = []
    grouped: dict[tuple[object, ...], list[dict[str, object]]] = {}
    candidates_by_id: dict[str, list[tuple[tuple[object, ...], dict[str, object]]]] = {}
    for record in records:
        result = _valid_region(record, current_catalog, embedding_space, processing_fingerprint, visibility)
        if result[0] is None:
            _exclude(excluded, result[1][0], result[1][1])
            continue
        key, row = result
        candidates_by_id.setdefault(row["semanticId"], []).append((key, row))

    for semantic_id in sorted(candidates_by_id):
        candidates = candidates_by_id[semantic_id]
        if len(candidates) > 1:
            for _ in candidates:
                _exclude(excluded, "duplicate_semantic_id", semantic_id)
            continue
        key, row = candidates[0]
        grouped.setdefault(key, []).append(row)

    regions: list[dict[str, object]] = []
    disagreements: list[dict[str, object]] = []
    for aliases in grouped.values():
        aliases.sort(key=lambda row: row["semanticId"])
        representative = aliases[0]
        semantic_ids = [row["semanticId"] for row in aliases]
        if any(row["vector"] != representative["vector"] for row in aliases[1:]):
            disagreements.append({"reason": "alias_vector_disagreement", "semanticIds": semantic_ids})
        snapshot_aliases = []
        for row in aliases:
            alias = dict(row["alias"])
            alias["_tuple"] = row["identity"].canonical_tuple
            alias["_vector"] = row["vector"]
            snapshot_aliases.append(alias)
        regions.append({"semanticId": representative["semanticId"], "vector": representative["vector"], "aliases": snapshot_aliases})
    regions.sort(key=lambda row: row["semanticId"])
    excluded.sort(key=lambda row: (row["reason"], row["semanticId"] or ""))
    disagreements.sort(key=lambda row: row["semanticIds"])
    corpus_digest = _digest(regions)
    for region in regions:
        for alias in region["aliases"]:
            del alias["_tuple"]
            del alias["_vector"]
    return {"schemaVersion": SCHEMA_VERSION, "embeddingSpace": embedding_space,
            "processingFingerprint": processing_fingerprint, "corpusDigest": corpus_digest,
            "regions": regions, "excluded": excluded, "disagreements": disagreements,
            "coverage": {"records": sum(len(rows) for rows in grouped.values()), "regions": len(regions), "excluded": len(excluded)}}
