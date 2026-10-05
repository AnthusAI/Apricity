"""Current-only public projections of curator-published cluster runs.

This is deliberately a Python boundary, not an HTTP handler.  It never reads
drafts, exposes publication audits, or treats catalog flags as a visibility
policy.  Consumers receive only the narrow cards produced from a newly read
canonical corpus and catalog.
"""
from __future__ import annotations

import copy
import math
import re
from typing import Any, Callable, Mapping
from urllib.parse import quote

from .cluster_corpus import build_cluster_snapshot
from .cluster_publication import PublicationError
from .cluster_runs import _validate_manifest


_RUN_ID = re.compile(r"[0-9a-f]{64}\Z")
_PRESETS = {"broad", "useful", "fine"}
_ORDERS = {"samples", "clips"}
_DETAIL_ORDERS = {"similarity", "rating"}


class ExplorationError(Exception):
    """Sanitized public-boundary failure."""
    status_code = 400
    retryable = False


class ExplorationBadRequest(ExplorationError):
    status_code = 400


class ExplorationNotFound(ExplorationError):
    status_code = 404


class ExplorationUnavailable(ExplorationError):
    status_code = 503


class ExplorationStorageUnavailable(ExplorationUnavailable):
    retryable = True


def _safe_id(value: object) -> str:
    if not isinstance(value, str) or not _RUN_ID.fullmatch(value):
        raise ExplorationBadRequest("invalid run ID")
    return value


def _preset(value: object) -> str:
    if value is None:
        return "useful"
    if not isinstance(value, str) or value not in _PRESETS:
        raise ExplorationBadRequest("invalid preset")
    return value


def _order(value: object, permitted: set[str], default: str) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or value not in permitted:
        raise ExplorationBadRequest("invalid order")
    return value


def _limit(value: object) -> int:
    if value is None:
        return 10_000
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10_000:
        raise ExplorationBadRequest("limit must be an integer from 1 to 10000")
    return value


def _finite(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return None
    return float(value)


def _safe_path(value: object) -> str | None:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or value.startswith("/"):
        return None
    if any(part in {"", ".", ".."} for part in value.split("/")):
        return None
    return value


class ClusterExploration:
    """Project immutable published membership through a current trusted corpus.

    All providers are server-injected callables.  ``visibility`` is mandatory:
    public reads must never fall back to the trusted-local ``None`` policy.
    ``enabled`` is an independent rollout gate and is checked before registry
    or current-data providers are touched.
    """

    def __init__(self, registry: object, corpus: Callable[[], object], catalog: Callable[[], object], *,
                 visibility: Callable[..., object], ratings: Callable[[], object], enabled: bool = False):
        if registry is None or not callable(getattr(registry, "published_manifest", None)):
            raise TypeError("registry must provide published_manifest")
        if not callable(corpus) or not callable(catalog) or not callable(visibility) or not callable(ratings):
            raise TypeError("trusted providers and visibility policy are required")
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be a trusted boolean")
        self.registry = registry
        self.corpus_provider, self.catalog_provider = corpus, catalog
        self.visibility, self.ratings_provider, self.enabled = visibility, ratings, enabled

    def _enabled(self) -> None:
        if not self.enabled:
            raise ExplorationUnavailable("public cluster exploration is unavailable")

    def _published(self, run_id: object, preset: object) -> dict[str, Any]:
        self._enabled()
        # Validate every request field before consulting a provider.  Bookmarks
        # legitimately carry both fields; the preset is then a consistency
        # check on the explicitly selected immutable run.
        safe_run_id = _safe_id(run_id) if run_id is not None else None
        safe_preset = _preset(preset) if preset is not None else None
        try:
            envelope = (self.registry.published_manifest(safe_run_id) if safe_run_id is not None
                        else self.registry.published_manifest(preset=safe_preset or "useful"))
        except PublicationError as error:
            if getattr(error, "status_code", None) == 503:
                failure = ExplorationStorageUnavailable if getattr(error, "retryable", False) else ExplorationUnavailable
                raise failure("public cluster exploration is unavailable") from error
            # The registry uses its validation type for both a genuinely absent
            # published envelope and corrupt private storage.  Only the former
            # is a public 404; corruption must remain a sanitized outage.
            if getattr(error, "status_code", None) == 400 and str(error) == "published manifest not available":
                raise ExplorationNotFound("published cluster run not found") from error
            raise ExplorationUnavailable("public cluster exploration is unavailable") from error
        except Exception as error:
            raise ExplorationStorageUnavailable("public cluster exploration is unavailable") from error
        if not isinstance(envelope, Mapping) or envelope.get("schemaVersion") != "apricity.published-cluster-manifest/1" or envelope.get("state") != "published":
            raise ExplorationStorageUnavailable("public cluster exploration is unavailable")
        manifest = envelope.get("manifest")
        try:
            if not isinstance(manifest, Mapping):
                raise ValueError("invalid manifest")
            _validate_manifest(manifest)
        except (TypeError, ValueError, KeyError) as error:
            raise ExplorationStorageUnavailable("public cluster exploration is unavailable") from error
        if envelope.get("runId") != manifest.get("runId"):
            raise ExplorationStorageUnavailable("public cluster exploration is unavailable")
        if safe_preset is not None and manifest.get("preset") != safe_preset:
            raise ExplorationBadRequest("run ID does not match preset")
        # Only retain the narrow, reviewed label surface; no audit identity/notes
        # can escape this boundary.
        audit = envelope.get("reviewAudit")
        if not isinstance(audit, Mapping) or not isinstance(audit.get("review"), Mapping):
            raise ExplorationStorageUnavailable("public cluster exploration is unavailable")
        review = audit["review"]
        reviewed = review.get("reviewedSemanticIds")
        overrides = audit.get("overrides")
        revision = review.get("runRevision")
        audit_revision = audit.get("runRevision")
        representatives = {item.get("semanticId") for cluster in manifest["clusters"]
                           for item in cluster.get("representatives", []) if isinstance(item, Mapping)}
        allowed = {identifier for member in manifest["members"] for identifier in [member["semanticId"], *member["aliases"]]}
        allowed.update(representatives)
        valid_overrides = (isinstance(overrides, Mapping)
                           and all(cluster_id in {cluster["clusterId"] for cluster in manifest["clusters"]}
                                   and isinstance(value, Mapping) and isinstance(value.get("label"), str) and value["label"]
                                   for cluster_id, value in overrides.items()))
        if (review.get("status") != "approved" or not isinstance(review.get("curatorId"), str) or not review["curatorId"]
                or not isinstance(review.get("at"), str) or not review["at"].endswith("Z")
                or isinstance(revision, bool) or not isinstance(revision, int) or revision < 1
                or isinstance(audit_revision, bool) or audit_revision != revision or not isinstance(reviewed, list)
                or any(not isinstance(item, str) for item in reviewed) or len(set(reviewed)) != len(reviewed)
                or not set(reviewed).issubset(allowed) or not representatives.issubset(set(reviewed))
                or not valid_overrides):
            raise ExplorationStorageUnavailable("public cluster exploration is unavailable")
        return {"manifest": copy.deepcopy(dict(manifest)), "reviewed": frozenset(reviewed),
                "overrides": copy.deepcopy(dict(overrides))}

    def _current(self, manifest: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        """Read fresh trusted providers and rebuild the current visible snapshot."""
        try:
            envelope, catalog = self.corpus_provider(), self.catalog_provider()
            if not isinstance(envelope, Mapping) or envelope.get("schemaVersion") != "apricity.semantic-corpus/1" or not isinstance(envelope.get("records"), list):
                raise ValueError("corpus")
            space, fingerprint = envelope.get("embeddingSpace"), envelope.get("processingFingerprint")
            if (not isinstance(space, str) or not space or not isinstance(fingerprint, str) or not fingerprint
                    or not isinstance(catalog, Mapping)):
                raise ValueError("provenance")
            # A run can be addressed after unrelated corpus changes, but never
            # across a model-space or processing-fingerprint boundary.
            if space != manifest["embeddingSpace"] or fingerprint != manifest["processingFingerprints"][0]:
                raise ValueError("incompatible current corpus")
            snapshot = build_cluster_snapshot(envelope["records"], dict(catalog), embedding_space=space,
                                              processing_fingerprint=fingerprint, visibility=self.visibility)
            return dict(envelope), dict(catalog), snapshot
        except ExplorationError:
            raise
        except Exception as error:
            raise ExplorationStorageUnavailable("current cluster data is unavailable") from error

    @staticmethod
    def _catalog_rows(catalog: Mapping[str, Any]) -> tuple[dict[str, Mapping[str, Any]], dict[str, Mapping[str, Any]]]:
        samples = catalog.get("samples")
        clips = catalog.get("clips")
        if not isinstance(samples, (list, tuple)) or not isinstance(clips, (list, tuple)):
            return {}, {}
        return ({row.get("id"): row for row in samples if isinstance(row, Mapping) and isinstance(row.get("id"), str)},
                {row.get("id"): row for row in clips if isinstance(row, Mapping) and isinstance(row.get("id"), str)})

    def _members(self, public: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        manifest = public["manifest"]
        _envelope, catalog, snapshot = self._current(manifest)
        samples, clips = self._catalog_rows(catalog)
        # Match through the immutable run's complete alias membership rather
        # than today's region representative.  A newly ingested alias can sort
        # before the old representative without making the still-current
        # published aliases disappear or borrowing another run's membership.
        stored_by_alias = {alias: row for row in manifest["members"] for alias in row["aliases"]}
        regions: list[dict[str, Any]] = []
        for region in snapshot["regions"]:
            matched = {id(stored_by_alias[alias["semanticId"]]): stored_by_alias[alias["semanticId"]]
                       for alias in region["aliases"] if alias.get("semanticId") in stored_by_alias}
            if len(matched) != 1:
                continue
            member = next(iter(matched.values()))
            permitted = set(member.get("aliases", []))
            aliases = [alias for alias in region["aliases"] if alias.get("semanticId") in permitted]
            if not aliases:
                continue
            # Membership and coordinates always come from this exact immutable
            # published run, while aliases must be current and visible.
            x, y = _finite(member.get("x")), _finite(member.get("y"))
            if x is None or y is None:
                continue
            safe_aliases = [self._card(alias, samples, clips) for alias in aliases]
            safe_aliases = [row for row in safe_aliases if row is not None]
            if not safe_aliases:
                continue
            regions.append({"semanticId": min(row["semanticId"] for row in safe_aliases), "aliases": safe_aliases,
                            "vector": tuple(region["vector"]), "clusterId": member.get("clusterId"),
                            "membership": _finite(member.get("membership")) or 0.0, "x": x, "y": y})
        regions.sort(key=lambda row: row["semanticId"])
        return manifest, regions

    @staticmethod
    def _card(alias: Mapping[str, Any], samples: Mapping[str, Mapping[str, Any]], clips: Mapping[str, Mapping[str, Any]]) -> dict[str, Any] | None:
        identity = alias.get("semanticIdentity")
        if not isinstance(identity, Mapping):
            return None
        semantic_id, sample_id, recording_id = identity.get("semanticId"), identity.get("sampleId"), identity.get("recordingId")
        if not all(isinstance(value, str) and value for value in (semantic_id, sample_id, recording_id)):
            return None
        sample = samples.get(sample_id)
        if not isinstance(sample, Mapping):
            return None
        audio = sample.get("audio")
        file_key = _safe_path(audio.get("key") if isinstance(audio, Mapping) else None)
        title = sample.get("title")
        # No filename/audio fallback: absence of canonical current metadata means
        # no public playback card.
        if file_key is None or not isinstance(title, str) or not title:
            return None
        sample_path = _safe_path(sample.get("path"))
        if sample_path is None:
            return None
        sample_key = sample_path.rsplit(".", 1)[0]
        if not sample_key:
            return None
        parent_link = "/samples/" + "/".join(quote(part, safe="") for part in sample_key.split("/"))
        start, end = _finite(identity.get("start")), _finite(identity.get("end"))
        if start is None or end is None or start < 0 or end <= start:
            return None
        kind = identity.get("kind")
        card = {"semanticId": semantic_id, "sampleId": sample_id, "recordingId": recording_id,
                "kind": kind, "start": start, "end": end, "sampleTitle": title,
                "playback": {"fileKey": file_key, "start": start, "end": end}, "parentLink": parent_link}
        if kind == "saved_clip":
            clip = clips.get(identity.get("clipId"))
            if not isinstance(clip, Mapping) or clip.get("sampleId") != sample_id or not isinstance(clip.get("name"), str) or not clip["name"]:
                return None
            card.update(clipId=identity["clipId"], clipName=clip["name"],
                        link="/clips/" + "/".join(quote(part, safe="") for part in [*sample_key.split("/"), clip["name"]]))
        elif kind != "window":
            return None
        else:
            card["link"] = parent_link
        return card

    @staticmethod
    def _cluster_map(manifest: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
        return {row["clusterId"]: row for row in manifest["clusters"]}

    @staticmethod
    def _counts(regions: list[dict[str, Any]]) -> tuple[int, int]:
        aliases = [alias for region in regions for alias in region["aliases"]]
        return len({alias["sampleId"] for alias in aliases}), sum(alias["kind"] == "saved_clip" for alias in aliases)

    def leaderboard(self, run_id: object | None = None, *, preset: object | None = None, order: object | None = None) -> dict[str, Any]:
        mode = _order(order, _ORDERS, "samples")
        public = self._published(run_id, preset)
        manifest, regions = self._members(public)
        clusters = self._cluster_map(manifest)
        grouped: dict[str, list[dict[str, Any]]] = {}
        for region in regions:
            if isinstance(region["clusterId"], str) and region["clusterId"] in clusters:
                grouped.setdefault(region["clusterId"], []).append(region)
        rows = []
        for cluster_id, members in grouped.items():
            samples, clips = self._counts(members)
            if samples == 0:
                continue
            cluster = clusters[cluster_id]
            override = public["overrides"].get(cluster_id)
            label = override.get("label") if isinstance(override, Mapping) and isinstance(override.get("label"), str) else None
            suggested = cluster.get("suggestedLabel")
            suggested_label = suggested.get("label") if isinstance(suggested, Mapping) and isinstance(suggested.get("label"), str) else None
            reps = self._representatives(cluster, members, public["reviewed"])
            row = {"clusterId": cluster_id, "distinctSampleCount": samples, "savedClipCount": clips,
                   "representatives": reps, "suggestedLabel": suggested_label}
            if label is not None:
                row["curatedLabel"] = label
            rows.append(row)
        count = "distinctSampleCount" if mode == "samples" else "savedClipCount"
        rows.sort(key=lambda row: (-row[count], row["clusterId"]))
        return {"runId": manifest["runId"], "preset": manifest["preset"],
                "algorithmVersions": copy.deepcopy(dict(manifest["algorithmVersions"])), "clusters": rows}

    def _representatives(self, cluster: Mapping[str, Any], regions: list[dict[str, Any]], reviewed: frozenset[str]) -> list[dict[str, Any]]:
        by_id = {alias["semanticId"]: alias for region in regions for alias in region["aliases"]}
        result, seen = [], set()
        for representative in cluster.get("representatives", []):
            semantic_id = representative.get("semanticId") if isinstance(representative, Mapping) else None
            if semantic_id in reviewed and semantic_id in by_id and semantic_id not in seen:
                result.append(copy.deepcopy(by_id[semantic_id])); seen.add(semantic_id)
            if len(result) == 4:
                break
        return result

    def detail(self, cluster_id: object, run_id: object | None = None, *, preset: object | None = None,
               order: object | None = None) -> dict[str, Any]:
        if not isinstance(cluster_id, str) or not cluster_id:
            raise ExplorationBadRequest("invalid cluster ID")
        mode = _order(order, _DETAIL_ORDERS, "similarity")
        public = self._published(run_id, preset)
        manifest, regions = self._members(public)
        clusters = self._cluster_map(manifest)
        cluster = clusters.get(cluster_id)
        if cluster is None:
            raise ExplorationNotFound("cluster not found")
        members = [row for row in regions if row["clusterId"] == cluster_id]
        if not members:
            raise ExplorationNotFound("cluster not found")
        try:
            centroid = tuple(float(value) for value in cluster["centroid"])
        except (TypeError, ValueError, KeyError) as error:
            raise ExplorationStorageUnavailable("published cluster run is unavailable") from error
        cards = {alias["semanticId"]: alias for region in members for alias in region["aliases"]}
        first = self._representatives(cluster, members, public["reviewed"])
        first_ids = {card["semanticId"] for card in first}
        ratings = self._ratings() if mode == "rating" else {}
        remaining = []
        for semantic_id, card in cards.items():
            if semantic_id in first_ids:
                continue
            region = next(row for row in members if any(alias["semanticId"] == semantic_id for alias in row["aliases"]))
            score = (sum(a * b for a, b in zip(region["vector"], centroid)) if mode == "similarity"
                     else ratings.get(semantic_id))
            # Missing ratings rank below every finite rating and must remain
            # JSON-safe at this public boundary.
            remaining.append((score is None, -float(score) if score is not None else 0.0, semantic_id, card, score))
        remaining.sort(key=lambda row: (row[0], row[1], row[2]))
        payload = [{**copy.deepcopy(card), "score": score} for _missing, _ranking, _semantic_id, card, score in remaining]
        return {"runId": manifest["runId"], "clusterId": cluster_id, "order": mode,
                "representatives": first, "members": payload}

    def _ratings(self) -> dict[str, float]:
        try:
            value = self.ratings_provider()
            if not isinstance(value, Mapping):
                raise ValueError("ratings")
            return {key: score for key, raw in value.items() if isinstance(key, str) and (score := _finite(raw)) is not None}
        except Exception as error:
            raise ExplorationStorageUnavailable("current ratings are unavailable") from error

    def map(self, run_id: object | None = None, *, preset: object | None = None, limit: object | None = None) -> dict[str, Any]:
        maximum = _limit(limit)
        public = self._published(run_id, preset)
        manifest, regions = self._members(public)
        selected = regions[:maximum]
        points = []
        for region in selected:
            # One current deduplicated region is one coordinate; aliases remain
            # only as safe identity cards and never leak its vector.
            points.append({"semanticId": region["semanticId"], "clusterId": region["clusterId"],
                           "membership": region["membership"], "x": region["x"], "y": region["y"],
                           "cards": copy.deepcopy(region["aliases"])})
        return {"runId": manifest["runId"], "displayedCount": len(points), "totalVisibleCount": len(regions),
                "truncated": len(regions) > len(points), "points": points}

    def list_members(self, run_id: object | None = None, *, preset: object | None = None) -> dict[str, Any]:
        """Uncapped deterministic alternative to :meth:`map` with identical membership."""
        public = self._published(run_id, preset)
        manifest, regions = self._members(public)
        return {"runId": manifest["runId"], "totalVisibleCount": len(regions),
                "members": [{"semanticId": row["semanticId"], "clusterId": row["clusterId"],
                             "membership": row["membership"], "x": row["x"], "y": row["y"],
                             "cards": copy.deepcopy(row["aliases"])} for row in regions]}


# Readable names for adapters without making a transport contract here.
ClusterExplorationService = ClusterExploration
PublicClusterExploration = ClusterExploration
