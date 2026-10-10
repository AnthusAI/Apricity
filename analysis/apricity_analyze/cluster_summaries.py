"""Pure, deterministic M4 summary packet construction.

This module deliberately stops before run manifests, publication, overrides, or
listening review.  It validates the accepted corpus/algorithm packets again so
the summary cannot turn an inconsistent algorithm result into playable output.
"""
from __future__ import annotations

import copy
import math
import numbers
from typing import Any, Mapping

from .clap import EMBED_DIM, EMBEDDING_SPACE


CORPUS_SCHEMA = "apricity.cluster-corpus/1"
RESULT_SCHEMA = "apricity.clustering-result/1"
SCHEMA_VERSION = "apricity.cluster-summaries/1"
VOCABULARY_SCHEMA = "apricity.concept-vocabulary/1"


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, numbers.Real) or not math.isfinite(float(value)):
        raise ValueError(f"{name} must be finite")
    return float(value)


def _vector(value: object, name: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != EMBED_DIM:
        raise ValueError(f"{name} must contain exactly {EMBED_DIM} entries")
    values = [_number(item, name) for item in value]
    if abs(math.sqrt(sum(item * item for item in values)) - 1.0) > 1e-4:
        raise ValueError(f"{name} must have unit L2 norm")
    return values


def _digest(value: object) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("corpus digest must be lowercase SHA-256")
    return value


def _alias_ids(aliases: object) -> list[str]:
    if not isinstance(aliases, list) or not aliases:
        raise ValueError("aliases must be a nonempty list")
    result = []
    for alias in aliases:
        if not isinstance(alias, Mapping) or not isinstance(alias.get("semanticId"), str) or not alias["semanticId"]:
            raise ValueError("alias semanticId must be nonempty")
        result.append(alias["semanticId"])
    if result != sorted(result) or len(set(result)) != len(result):
        raise ValueError("aliases must be uniquely sorted")
    return result


def _validate_snapshot(snapshot: Mapping[str, object]) -> dict[str, dict[str, object]]:
    if not isinstance(snapshot, Mapping) or snapshot.get("schemaVersion") != CORPUS_SCHEMA:
        raise ValueError(f"snapshot schemaVersion must be {CORPUS_SCHEMA}")
    _digest(snapshot.get("corpusDigest"))
    if snapshot.get("embeddingSpace") != EMBEDDING_SPACE:
        raise ValueError(f"snapshot embeddingSpace must be {EMBEDDING_SPACE}")
    if not isinstance(snapshot.get("processingFingerprint"), str) or not snapshot["processingFingerprint"]:
        raise ValueError("snapshot processingFingerprint must be nonempty")
    regions = snapshot.get("regions")
    if not isinstance(regions, list):
        raise ValueError("snapshot regions must be a list")
    output: dict[str, dict[str, object]] = {}
    previous = ""
    aliases_seen: set[str] = set()
    for row in regions:
        if not isinstance(row, Mapping):
            raise ValueError("snapshot region must be an object")
        semantic_id = row.get("semanticId")
        if not isinstance(semantic_id, str) or not semantic_id or semantic_id <= previous or semantic_id in output:
            raise ValueError("snapshot region semanticIds must be unique and sorted")
        aliases = _alias_ids(row.get("aliases"))
        if semantic_id != aliases[0] or aliases_seen.intersection(aliases):
            raise ValueError("snapshot aliases must be globally unique and representative-first")
        aliases_seen.update(aliases)
        output[semantic_id] = {"semanticId": semantic_id, "aliases": copy.deepcopy(row["aliases"]), "vector": _vector(row.get("vector"), "snapshot vector")}
        previous = semantic_id
    return output


def _safe_file_key(value: object) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or value.startswith("/"):
        raise ValueError("metadata fileKey must be a safe relative path")
    segments = value.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        raise ValueError("metadata fileKey must be a safe relative path")
    return value


def _metadata(metadata: Mapping[str, object], aliases: Mapping[str, Mapping[str, object]]) -> dict[str, dict[str, object]]:
    if not isinstance(metadata, Mapping):
        raise ValueError("metadata must be a mapping keyed by semanticId")
    if set(metadata) != set(aliases):
        raise ValueError("metadata must cover exactly every canonical alias")
    output: dict[str, dict[str, object]] = {}
    for semantic_id, alias in aliases.items():
        row = metadata[semantic_id]
        identity = alias.get("semanticIdentity")
        if not isinstance(row, Mapping) or not isinstance(identity, Mapping):
            raise ValueError("metadata and alias canonical identity are required")
        required = ("semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint")
        if any(row.get(key) != identity.get(key) for key in required) or row.get("semanticId") != semantic_id:
            raise ValueError("metadata does not match canonical alias identity")
        kind = identity.get("kind")
        if kind == "saved_clip":
            expected_clip = identity.get("clipId")
            if not isinstance(expected_clip, str) or not expected_clip or row.get("clipId") != expected_clip:
                raise ValueError("metadata clipId does not match canonical alias identity")
            if not isinstance(row.get("clipName"), str) or not row["clipName"]:
                raise ValueError("saved clip metadata requires its current name")
        elif kind == "window":
            if "clipId" in row or "clipName" in row:
                raise ValueError("window metadata must not contain saved clip fields")
        else:
            raise ValueError("metadata kind must be saved_clip or window")
        if (not isinstance(row.get("sampleTitle"), str) or not row["sampleTitle"]):
            raise ValueError("metadata requires real playable file and display fields")
        _safe_file_key(row.get("fileKey"))
        start, end = _number(row.get("start"), "metadata start"), _number(row.get("end"), "metadata end")
        if start < 0 or end <= start:
            raise ValueError("metadata playback bounds are invalid")
        output[semantic_id] = copy.deepcopy(dict(row))
    return output


def _vocabulary(vocabulary: Mapping[str, object], embedding_space: str) -> tuple[dict[str, object], list[dict[str, object]] | None, str | None]:
    if not isinstance(vocabulary, Mapping) or vocabulary.get("schemaVersion") != VOCABULARY_SCHEMA:
        raise ValueError(f"vocabulary schemaVersion must be {VOCABULARY_SCHEMA}")
    version, provenance = vocabulary.get("vocabularyVersion"), vocabulary.get("provenance")
    if not isinstance(version, str) or not version or not isinstance(provenance, Mapping):
        raise ValueError("vocabulary version and provenance are required")
    base = {"vocabularyVersion": version, "provenance": copy.deepcopy(dict(provenance))}
    if vocabulary.get("embeddingSpace") != embedding_space:
        return base, None, "incompatible_embedding_space"
    concepts = vocabulary.get("concepts")
    if not isinstance(concepts, list) or not concepts:
        raise ValueError("compatible vocabulary concepts must be nonempty")
    result = []
    ids: set[str] = set()
    for concept in concepts:
        if not isinstance(concept, Mapping) or not isinstance(concept.get("conceptId"), str) or not concept["conceptId"] or concept["conceptId"] in ids or not isinstance(concept.get("label"), str) or not concept["label"]:
            raise ValueError("vocabulary concepts require unique IDs and labels")
        ids.add(concept["conceptId"])
        result.append({"conceptId": concept["conceptId"], "label": concept["label"], "vector": _vector(concept.get("vector512"), "concept vector")})
    return base, result, None


def _label(centroid: list[float], base: dict[str, object], concepts: list[dict[str, object]] | None, reason: str | None) -> dict[str, object]:
    if concepts is None:
        return {"label": None, "method": "unlabelled", "reason": reason, "approved": False, **base, "conceptScores": []}
    scores = sorted(({"conceptId": concept["conceptId"], "label": concept["label"], "score": sum(a * b for a, b in zip(centroid, concept["vector"]))} for concept in concepts), key=lambda row: (-row["score"], row["conceptId"]))
    return {"label": scores[0]["label"], "method": "clap_concept", "approved": False, **base, "conceptScores": scores}


def build_cluster_summaries(snapshot: Mapping[str, object], result: Mapping[str, object], vocabulary: Mapping[str, object], *, metadata: Mapping[str, object]) -> dict[str, object]:
    """Build the exact, detached ``apricity.cluster-summaries/1`` packet."""
    regions = _validate_snapshot(snapshot)
    if not isinstance(result, Mapping) or result.get("schemaVersion") != RESULT_SCHEMA:
        raise ValueError(f"result schemaVersion must be {RESULT_SCHEMA}")
    corpus, model = result.get("corpus"), result.get("model")
    if not isinstance(corpus, Mapping) or corpus.get("schemaVersion") != CORPUS_SCHEMA or corpus.get("digest") != snapshot["corpusDigest"] or corpus.get("regionCount") != len(regions):
        raise ValueError("result must refer to exactly this corpus snapshot")
    if not isinstance(model, Mapping) or model.get("embeddingSpace") != snapshot["embeddingSpace"] or model.get("processingFingerprint") != snapshot["processingFingerprint"]:
        raise ValueError("result model must match snapshot model")
    algorithm_versions = result.get("algorithmVersions")
    if (result.get("preset") not in {"broad", "useful", "fine"} or not isinstance(result.get("requestedParams"), Mapping)
            or not isinstance(result.get("effectiveParams"), Mapping) or not isinstance(algorithm_versions, Mapping)
            or not algorithm_versions or any(not isinstance(name, str) or not name or not isinstance(version, str) or not version for name, version in algorithm_versions.items())
            or result.get("seed") != 42 or isinstance(result.get("seed"), bool)):
        raise ValueError("result provenance is incomplete")
    alias_rows = {alias["semanticId"]: alias for region in regions.values() for alias in region["aliases"]}
    canonical_metadata = _metadata(metadata, alias_rows)
    base, concepts, label_reason = _vocabulary(vocabulary, snapshot["embeddingSpace"])
    members = result.get("members")
    if not isinstance(members, list) or len(members) != len(regions):
        raise ValueError("result must contain exactly one member per snapshot region")
    member_by_id: dict[str, dict[str, object]] = {}
    for member in members:
        if not isinstance(member, Mapping) or member.get("semanticId") not in regions or member.get("semanticId") in member_by_id:
            raise ValueError("result members must cover each snapshot region exactly once")
        region = regions[member["semanticId"]]
        if member.get("aliases") != region["aliases"]:
            raise ValueError("result member aliases must exactly join snapshot aliases")
        label = member.get("clusterLabel")
        if label is not None and (isinstance(label, bool) or not isinstance(label, int) or label < 0):
            raise ValueError("clusterLabel must be null or a nonnegative algorithm label")
        membership = _number(member.get("membership"), "membership")
        if not 0 <= membership <= 1:
            raise ValueError("membership must be between zero and one")
        member_by_id[member["semanticId"]] = {"semanticId": member["semanticId"], "aliases": [alias["semanticId"] for alias in region["aliases"]], "clusterId": label, "membership": membership, "x": _number(member.get("x"), "x"), "y": _number(member.get("y"), "y")}
    outliers = result.get("outliers")
    expected_outliers = sorted(semantic_id for semantic_id, row in member_by_id.items() if row["clusterId"] is None)
    if not isinstance(outliers, list) or outliers != expected_outliers:
        raise ValueError("result outliers must exactly and explicitly match unclustered members")
    grouped: dict[int, list[dict[str, object]]] = {}
    for row in member_by_id.values():
        if row["clusterId"] is not None:
            grouped.setdefault(row["clusterId"], []).append(row)
    clusters = []
    for cluster_id in sorted(grouped):
        rows = sorted(grouped[cluster_id], key=lambda row: row["semanticId"])
        mean = [sum(regions[row["semanticId"]]["vector"][index] for row in rows) / len(rows) for index in range(EMBED_DIM)]
        norm = math.sqrt(sum(value * value for value in mean))
        if norm <= 1e-9:
            centroid, method = list(regions[rows[0]["semanticId"]]["vector"]), "representative_fallback"
        else:
            centroid, method = [value / norm for value in mean], "mean_normalized"
        ranked = sorted(rows, key=lambda row: (-sum(a * b for a, b in zip(regions[row["semanticId"]]["vector"], centroid)), row["semanticId"]))
        first, recordings = [], set()
        for row in ranked:
            recording = canonical_metadata[row["semanticId"]]["recordingId"]
            if recording not in recordings:
                first.append(row); recordings.add(recording)
        chosen = (first + [row for row in ranked if row not in first])[:4]
        representatives = []
        for row in chosen:
            meta = canonical_metadata[row["semanticId"]]
            representative = {key: meta[key] for key in ("semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "fileKey", "sampleTitle")}
            if meta["kind"] == "saved_clip":
                representative.update({key: meta[key] for key in ("clipId", "clipName")})
            representatives.append(representative)
        alias_meta = [canonical_metadata[alias_id] for row in rows for alias_id in row["aliases"]]
        clusters.append({"clusterId": cluster_id, "centroid": centroid, "centroidMethod": method, "memberCount": len(rows),
                         "distinctSampleCount": len({row["sampleId"] for row in alias_meta}), "savedClipCount": sum(row["kind"] == "saved_clip" for row in alias_meta),
                         "representatives": representatives, "suggestedLabel": _label(centroid, base, concepts, label_reason)})
    return {"schemaVersion": SCHEMA_VERSION, "corpus": copy.deepcopy(dict(corpus)), "model": copy.deepcopy(dict(model)), "preset": result["preset"],
            "requestedParams": copy.deepcopy(dict(result["requestedParams"])), "effectiveParams": copy.deepcopy(dict(result["effectiveParams"])), "algorithmVersions": copy.deepcopy(dict(result["algorithmVersions"])), "seed": result.get("seed"),
            "clusters": clusters, "members": [member_by_id[key] for key in sorted(member_by_id)],
            "outliers": [{"semanticId": key, "aliases": member_by_id[key]["aliases"]} for key in expected_outliers], "qualityReview": {"status": "pending"}}
