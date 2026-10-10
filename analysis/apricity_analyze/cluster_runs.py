"""Immutable local draft artifacts for accepted M4 clustering packets.

This boundary deliberately has no publication or pointer operation.  A packet is
validated as one coherent snapshot/result/summary triple before its deterministic
run identifier is computed, and is then installed as ``runs/<runId>/manifest.json``.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import tempfile
from typing import Any, Mapping


SCHEMA = "apricity.cluster-run/1"


def _compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("utf-8")


def _finite(value: object, name: str, *, unit: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError(f"{name} must be finite")
    value = float(value)
    if unit and not 0 <= value <= 1:
        raise ValueError(f"{name} must be between zero and one")
    return value


def _sha(value: object, name: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError(f"{name} must be lowercase SHA-256")
    return value


def _created(value: object) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("created_at must be UTC RFC3339 ending Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError("created_at must be UTC RFC3339 ending Z") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError("created_at must be UTC")
    return value


def _provenance(snapshot: Mapping[str, object], result: Mapping[str, object], summaries: Mapping[str, object]) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    if snapshot.get("schemaVersion") != "apricity.cluster-corpus/1" or result.get("schemaVersion") != "apricity.clustering-result/1" or summaries.get("schemaVersion") != "apricity.cluster-summaries/1":
        raise ValueError("packet schema versions are not accepted")
    digest = _sha(snapshot.get("corpusDigest"), "corpusDigest")
    space, fingerprint = snapshot.get("embeddingSpace"), snapshot.get("processingFingerprint")
    if not isinstance(space, str) or not space or not isinstance(fingerprint, str) or not fingerprint:
        raise ValueError("snapshot model provenance is required")
    corpus, model = result.get("corpus"), result.get("model")
    if not isinstance(corpus, Mapping) or corpus.get("schemaVersion") != "apricity.cluster-corpus/1" or corpus.get("digest") != digest:
        raise ValueError("result corpus does not match snapshot")
    if not isinstance(model, Mapping) or model.get("embeddingSpace") != space or model.get("processingFingerprint") != fingerprint:
        raise ValueError("result model does not match snapshot")
    for key in ("corpus", "model", "preset", "requestedParams", "effectiveParams", "algorithmVersions", "seed"):
        if summaries.get(key) != result.get(key):
            raise ValueError(f"summary {key} does not match result")
    if result.get("preset") not in {"broad", "useful", "fine"} or result.get("seed") != 42:
        raise ValueError("result preset or seed is not accepted")
    versions = result.get("algorithmVersions")
    if not isinstance(versions, Mapping) or not versions or any(not isinstance(key, str) or not key or not isinstance(value, str) or not value for key, value in versions.items()):
        raise ValueError("algorithm versions are required")
    if not isinstance(result.get("requestedParams"), Mapping) or not isinstance(result.get("effectiveParams"), Mapping):
        raise ValueError("requested and effective parameters are required")
    for values in (result["requestedParams"], result["effectiveParams"]):
        for key, value in values.items():
            if key not in {"neighbors", "dimensions", "minClusterSize", "minSamples"}:
                raise ValueError("unknown clustering parameter")
            if value is not None: _finite(value, f"parameter {key}")
    return copy.deepcopy(dict(corpus)), copy.deepcopy(dict(model)), copy.deepcopy(dict(versions))


def _members(snapshot: Mapping[str, object], result: Mapping[str, object], summaries: Mapping[str, object]) -> tuple[list[dict[str, object]], list[str], dict[int, str], dict[str, Mapping[str, object]]]:
    regions = snapshot.get("regions")
    result_members, summary_members = result.get("members"), summaries.get("members")
    if not isinstance(regions, list) or not isinstance(result_members, list) or not isinstance(summary_members, list) or len(regions) != len(result_members) or len(regions) != len(summary_members):
        raise ValueError("all packets must contain exactly one member per region")
    source: dict[str, Mapping[str, object]] = {}
    aliases_by_region: dict[str, list[str]] = {}
    for region in regions:
        if not isinstance(region, Mapping) or not isinstance(region.get("semanticId"), str) or not isinstance(region.get("aliases"), list): raise ValueError("invalid snapshot member")
        aliases = region["aliases"]
        alias_ids = [row.get("semanticId") for row in aliases if isinstance(row, Mapping)]
        if len(alias_ids) != len(aliases) or alias_ids != sorted(alias_ids) or not alias_ids or region["semanticId"] != alias_ids[0]: raise ValueError("snapshot aliases must be canonical")
        source[region["semanticId"]] = region
        aliases_by_region[region["semanticId"]] = alias_ids
    if len(source) != len(regions): raise ValueError("duplicate snapshot member")
    by_result, by_summary = {}, {}
    for row in result_members:
        if not isinstance(row, Mapping) or row.get("semanticId") in by_result: raise ValueError("invalid result members")
        by_result[row["semanticId"]] = row
    for row in summary_members:
        if not isinstance(row, Mapping) or row.get("semanticId") in by_summary: raise ValueError("invalid summary members")
        by_summary[row["semanticId"]] = row
    if set(source) != set(by_result) or set(source) != set(by_summary): raise ValueError("members do not cover the same corpus")
    labels = set()
    members = []
    for semantic_id in sorted(source):
        raw, summary = by_result[semantic_id], by_summary[semantic_id]
        aliases = aliases_by_region[semantic_id]
        if raw.get("aliases") != source[semantic_id]["aliases"] or summary.get("aliases") != aliases:
            raise ValueError("member aliases do not exactly match corpus")
        label = raw.get("clusterLabel")
        if label is not None and (isinstance(label, bool) or not isinstance(label, int) or label < 0): raise ValueError("invalid cluster label")
        if summary.get("clusterId") != label: raise ValueError("summary cluster label does not match result")
        for key in ("membership", "x", "y"):
            value = _finite(raw.get(key), key, unit=key == "membership")
            if _finite(summary.get(key), key, unit=key == "membership") != value: raise ValueError("summary member values do not match result")
        if label is not None: labels.add(label)
        members.append({"semanticId": semantic_id, "aliases": aliases, "clusterLabel": label, "membership": _finite(raw["membership"], "membership", unit=True), "x": _finite(raw["x"], "x"), "y": _finite(raw["y"], "y")})
    outliers = [row["semanticId"] for row in members if row["clusterLabel"] is None]
    if result.get("outliers") != outliers or summaries.get("outliers") != [{"semanticId": key, "aliases": aliases_by_region[key]} for key in outliers]:
        raise ValueError("outliers must be explicit and exact")
    return members, outliers, {label: "" for label in labels}, source


def _unit_vector(value: object, name: str) -> None:
    if not isinstance(value, list) or len(value) != 512:
        raise ValueError(f"{name} must be 512 finite unit values")
    norm = math.sqrt(sum(_finite(item, name) ** 2 for item in value))
    if abs(norm - 1.0) > 1e-4:
        raise ValueError(f"{name} must have unit L2 norm")


def _safe_file_key(value: object) -> None:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or value.startswith("/"):
        raise ValueError("representative fileKey must be a safe relative path")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("representative fileKey must be a safe relative path")


def _suggested_label(value: object) -> None:
    if not isinstance(value, Mapping) or value.get("approved") is not False:
        raise ValueError("suggested labels must remain unapproved")
    if not isinstance(value.get("method"), str) or not value["method"] or not isinstance(value.get("vocabularyVersion"), str) or not value["vocabularyVersion"] or not isinstance(value.get("provenance"), Mapping) or not isinstance(value.get("conceptScores"), list):
        raise ValueError("suggested label provenance is invalid")
    if value["method"] == "clap_concept" and (not isinstance(value.get("label"), str) or not value["label"] or not value["conceptScores"]):
        raise ValueError("concept suggested label is invalid")


def _representatives(value: object, aliases: Mapping[str, Mapping[str, object]] | None = None) -> None:
    if not isinstance(value, list) or not value:
        raise ValueError("cluster representatives are required")
    seen: set[str] = set()
    required = {"semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "fileKey", "sampleTitle"}
    for row in value:
        if not isinstance(row, Mapping) or not required.issubset(row) or not isinstance(row.get("semanticId"), str) or not row["semanticId"] or row["semanticId"] in seen:
            raise ValueError("cluster representative is invalid")
        seen.add(row["semanticId"])
        if not all(isinstance(row.get(key), str) and row[key] for key in ("sampleId", "recordingId", "audioSha256", "sampleTitle")):
            raise ValueError("cluster representative provenance is invalid")
        if row.get("kind") not in {"saved_clip", "window"}:
            raise ValueError("cluster representative kind is invalid")
        _finite(row.get("start"), "representative start"); _finite(row.get("end"), "representative end")
        if row["start"] < 0 or row["end"] <= row["start"]:
            raise ValueError("cluster representative bounds are invalid")
        _sha(row["audioSha256"], "representative audioSha256"); _safe_file_key(row.get("fileKey"))
        if row["kind"] == "saved_clip":
            if not isinstance(row.get("clipId"), str) or not row["clipId"] or not isinstance(row.get("clipName"), str) or not row["clipName"]:
                raise ValueError("saved clip representative is invalid")
        elif "clipId" in row or "clipName" in row:
            raise ValueError("window representative cannot contain clip fields")
        if aliases is not None:
            alias = aliases.get(row["semanticId"])
            identity = alias.get("semanticIdentity") if isinstance(alias, Mapping) else None
            if not isinstance(identity, Mapping) or any(row.get(key) != identity.get(key) for key in ("semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256")):
                raise ValueError("representative does not match accepted alias provenance")
            if any(key in row and row[key] != identity.get(key) for key in ("embeddingSpace", "processingFingerprint")):
                raise ValueError("representative does not match accepted model provenance")


def prepare_run(snapshot: Mapping[str, object], result: Mapping[str, object], summaries: Mapping[str, object], created_at: str) -> dict[str, object]:
    """Return a detached immutable draft manifest from one coherent packet triple."""
    if not all(isinstance(packet, Mapping) for packet in (snapshot, result, summaries)):
        raise ValueError("packets must be mappings")
    created_at = _created(created_at)
    corpus, model, versions = _provenance(snapshot, result, summaries)
    members, outliers, labels, source = _members(snapshot, result, summaries)
    digest_input = {"corpusDigest": snapshot["corpusDigest"], "embeddingSpace": snapshot["embeddingSpace"], "processingFingerprint": snapshot["processingFingerprint"], "preset": result["preset"], "requestedParams": result["requestedParams"], "effectiveParams": result["effectiveParams"], "seed": result["seed"], "algorithmVersions": versions}
    run_id = hashlib.sha256(_compact(digest_input)).hexdigest()
    labels.update({label: f"{run_id}:{label}" for label in labels})
    summary_clusters = summaries.get("clusters")
    if not isinstance(summary_clusters, list): raise ValueError("summaries clusters must be a list")
    clusters = []
    seen_summary_labels: set[int] = set()
    for cluster in summary_clusters:
        if not isinstance(cluster, Mapping) or cluster.get("clusterId") not in labels or cluster["clusterId"] in seen_summary_labels:
            raise ValueError("summary cluster is not represented exactly once by members")
        seen_summary_labels.add(cluster["clusterId"])
        value = copy.deepcopy(dict(cluster)); value["clusterId"] = labels[cluster["clusterId"]]
        _unit_vector(value.get("centroid"), "cluster centroid")
        member_aliases = {alias["semanticId"]: alias for member in members if member["clusterLabel"] == cluster["clusterId"] for alias in source[member["semanticId"]]["aliases"]}
        _representatives(value.get("representatives"), member_aliases)
        _suggested_label(value.get("suggestedLabel"))
        clusters.append(value)
    if {row["clusterId"] for row in clusters} != set(labels.values()): raise ValueError("clusters do not exactly cover clustered members")
    for row in members: row["clusterId"] = labels.get(row.pop("clusterLabel"))
    quality = summaries.get("qualityReview")
    if quality != {"status": "pending"}: raise ValueError("quality review must remain pending")
    return {"schemaVersion": SCHEMA, "runId": run_id, "corpusDigest": snapshot["corpusDigest"], "embeddingSpace": snapshot["embeddingSpace"], "processingFingerprints": [snapshot["processingFingerprint"]], "algorithmVersions": versions, "preset": result["preset"], "requestedParams": copy.deepcopy(dict(result["requestedParams"])), "effectiveParams": copy.deepcopy(dict(result["effectiveParams"])), "seed": result["seed"], "createdAtUTC": created_at, "state": "draft", "corpus": corpus, "model": model, "clusters": sorted(clusters, key=lambda row: row["clusterId"]), "members": members, "outliers": outliers, "qualityReview": {"status": "pending"}}


def _content(packet: Mapping[str, object]) -> bytes:
    content = copy.deepcopy(dict(packet)); content.pop("createdAtUTC", None)
    return _compact(content)


def _safe_existing(path: Path) -> None:
    if path.is_symlink(): raise ValueError("output path must not traverse a symlink")


def _validate_manifest(packet: Mapping[str, object]) -> None:
    required = {"schemaVersion", "runId", "corpusDigest", "embeddingSpace", "processingFingerprints", "algorithmVersions", "preset", "requestedParams", "effectiveParams", "seed", "createdAtUTC", "state", "corpus", "model", "clusters", "members", "outliers", "qualityReview"}
    if set(packet) != required or packet.get("schemaVersion") != SCHEMA or packet.get("state") != "draft" or packet.get("qualityReview") != {"status": "pending"}:
        raise ValueError("invalid draft run packet")
    _sha(packet.get("runId"), "runId"); _sha(packet.get("corpusDigest"), "corpusDigest"); _created(packet.get("createdAtUTC"))
    fingerprints, versions = packet.get("processingFingerprints"), packet.get("algorithmVersions")
    if not isinstance(packet.get("embeddingSpace"), str) or not packet["embeddingSpace"] or not isinstance(fingerprints, list) or len(fingerprints) != 1 or not isinstance(fingerprints[0], str) or not fingerprints[0] or not isinstance(versions, Mapping) or not versions:
        raise ValueError("invalid draft provenance")
    expected_id = hashlib.sha256(_compact({"corpusDigest": packet["corpusDigest"], "embeddingSpace": packet["embeddingSpace"], "processingFingerprint": fingerprints[0], "preset": packet["preset"], "requestedParams": packet["requestedParams"], "effectiveParams": packet["effectiveParams"], "seed": packet["seed"], "algorithmVersions": versions})).hexdigest()
    if packet["runId"] != expected_id or packet.get("preset") not in {"broad", "useful", "fine"} or packet.get("seed") != 42:
        raise ValueError("draft run ID or configuration is invalid")
    corpus, model = packet.get("corpus"), packet.get("model")
    if (not isinstance(corpus, Mapping) or corpus.get("schemaVersion") != "apricity.cluster-corpus/1" or corpus.get("digest") != packet["corpusDigest"]
            or not isinstance(model, Mapping) or model.get("embeddingSpace") != packet["embeddingSpace"] or model.get("processingFingerprint") != fingerprints[0]):
        raise ValueError("draft corpus and model provenance are invalid")
    if any(not isinstance(key, str) or not key or not isinstance(value, str) or not value for key, value in versions.items()):
        raise ValueError("draft algorithm versions are invalid")
    for params in (packet.get("requestedParams"), packet.get("effectiveParams")):
        if not isinstance(params, Mapping):
            raise ValueError("draft clustering parameters are invalid")
        for key, value in params.items():
            if key not in {"neighbors", "dimensions", "minClusterSize", "minSamples"}:
                raise ValueError("draft clustering parameter is unknown")
            if value is not None:
                _finite(value, f"parameter {key}")
    members, outliers, clusters = packet.get("members"), packet.get("outliers"), packet.get("clusters")
    if not isinstance(members, list) or not isinstance(outliers, list) or not isinstance(clusters, list): raise ValueError("draft members are invalid")
    ids, found_outliers, cluster_ids = set(), [], set()
    for member in members:
        if not isinstance(member, Mapping) or not isinstance(member.get("semanticId"), str) or not member["semanticId"] or member["semanticId"] in ids or not isinstance(member.get("aliases"), list) or not member["aliases"]:
            raise ValueError("draft member identity is invalid")
        ids.add(member["semanticId"])
        for key in ("membership", "x", "y"): _finite(member.get(key), key, unit=key == "membership")
        cluster_id = member.get("clusterId")
        if cluster_id is None: found_outliers.append(member["semanticId"])
        elif not isinstance(cluster_id, str) or not cluster_id.startswith(packet["runId"] + ":"): raise ValueError("draft cluster ID is invalid")
        else: cluster_ids.add(cluster_id)
    if outliers != found_outliers: raise ValueError("draft outliers are not explicit")
    seen_clusters = set()
    for cluster in clusters:
        if not isinstance(cluster, Mapping) or not isinstance(cluster.get("clusterId"), str) or cluster["clusterId"] not in cluster_ids or cluster["clusterId"] in seen_clusters: raise ValueError("draft cluster is invalid")
        seen_clusters.add(cluster["clusterId"])
        _unit_vector(cluster.get("centroid"), "cluster centroid")
        _representatives(cluster.get("representatives"))
        _suggested_label(cluster.get("suggestedLabel"))
    if seen_clusters != cluster_ids: raise ValueError("draft clusters do not cover members")


def _output_root(root: str | Path) -> Path:
    root = Path(root)
    if not root.is_absolute():
        root = Path.cwd() / root
    if ".." in root.parts:
        raise ValueError("output root must not contain traversal")
    raw_temp = Path(tempfile.gettempdir()).absolute()
    resolved = root.resolve(strict=False)
    try:
        relative = root.relative_to(raw_temp)
    except ValueError:
        if resolved != root:
            raise ValueError("output path must not traverse a symlink")
    else:
        # macOS commonly exposes a system /var -> /private/var alias.  Accept
        # only that canonical temp-parent translation, never a caller child link.
        expected = raw_temp.resolve(strict=False) / relative
        if resolved != expected:
            raise ValueError("output path must not traverse a symlink")
        root = expected
    for ancestor in (root, *root.parents):
        try:
            if stat.S_ISLNK(ancestor.lstat().st_mode):
                raise ValueError("output path must not traverse a symlink")
        except FileNotFoundError:
            continue
    return root


def _existing_manifest(target: Path, manifest: Path, content: bytes) -> Path:
    if target.is_symlink() or not target.is_dir() or manifest.is_symlink() or not manifest.is_file():
        raise ValueError("existing run artifact is unsafe or incomplete")
    try:
        existing = json.loads(manifest.read_text(encoding="utf8"))
        _validate_manifest(existing)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise ValueError("existing run manifest is invalid") from error
    if _content(existing) != content:
        raise FileExistsError("immutable run ID collision has divergent content")
    return manifest


def save_draft_run(root: str | Path, packet: Mapping[str, object]) -> Path:
    """Atomically install one manifest, reusing only byte-equivalent draft content."""
    if not isinstance(packet, Mapping): raise ValueError("invalid draft run packet")
    _validate_manifest(packet)
    root = _output_root(root)
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir(): raise ValueError("output path must not traverse a symlink")
    runs = root / "runs"
    if runs.is_symlink(): raise ValueError("output path must not traverse a symlink")
    runs.mkdir(exist_ok=True); _safe_existing(runs)
    target = runs / packet["runId"]; manifest = target / "manifest.json"
    content = _content(packet)
    if target.exists() or target.is_symlink():
        return _existing_manifest(target, manifest, content)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".cluster-run-", dir=runs)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as handle:
            json.dump(dict(packet), handle, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False); handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
        try:
            os.mkdir(target)
        except FileExistsError:
            return _existing_manifest(target, manifest, content)
        # Hard-linking into the freshly reserved directory installs the manifest
        # with no replacement operation; a competing directory is never clobbered.
        os.link(temporary, manifest)
        return manifest
    finally:
        if temporary.exists():
            temporary.unlink()
