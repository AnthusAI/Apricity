"""Deterministic M4 UMAP/HDBSCAN clustering for a cluster-corpus snapshot.

The result is the deliberately narrow hand-off packet ``apricity.clustering-result/1``:
it records the source corpus/model identity, requested and effective parameters,
algorithm versions and seed, plus one member row per source region and explicit
outlier IDs.  It does not create a run, summaries, labels, publication state, or
make any listening-quality claim.
"""
from __future__ import annotations

import copy
import importlib.metadata
import math
import numbers
from typing import Any, Callable, Mapping

from .clap import EMBED_DIM, EMBEDDING_SPACE


CORPUS_SCHEMA = "apricity.cluster-corpus/1"
RESULT_SCHEMA = "apricity.clustering-result/1"
SEED = 42
ALGORITHM_REVISION = "umap-random-init-seed42-v1"
ALGORITHM_VERSION_KEY = "apricity-audio-clusters"
PRESETS = {
    "broad": {"neighbors": 50, "minClusterSize": 40, "minSamples": 10},
    "useful": {"neighbors": 30, "minClusterSize": 15, "minSamples": 5},
    "fine": {"neighbors": 15, "minClusterSize": 5, "minSamples": 3},
}
_VERSION_PACKAGES = ("umap-learn", "hdbscan", "numpy", "scipy", "scikit-learn", "numba", "pynndescent")


class AlgorithmDependencyError(RuntimeError):
    """The real algorithm was not evaluated because a required package is absent."""


def _versions() -> dict[str, str]:
    missing: list[str] = []
    result: dict[str, str] = {}
    for package in _VERSION_PACKAGES:
        try:
            result[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            missing.append(package)
    if missing:
        raise AlgorithmDependencyError("not_evaluated: missing " + ", ".join(missing))
    return result


def _factories() -> tuple[Callable[..., Any], Callable[..., Any], Callable[..., Any]]:
    try:
        import hdbscan
        import umap
    except ImportError as error:
        raise AlgorithmDependencyError(f"not_evaluated: missing {error.name}") from error
    return umap.UMAP, umap.UMAP, hdbscan.HDBSCAN


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise ValueError(f"{name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _validate_snapshot(snapshot: Mapping[str, object]) -> tuple[list[dict[str, object]], int]:
    if not isinstance(snapshot, Mapping) or snapshot.get("schemaVersion") != CORPUS_SCHEMA:
        raise ValueError(f"snapshot schemaVersion must be {CORPUS_SCHEMA}")
    digest = snapshot.get("corpusDigest")
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("snapshot corpusDigest must be lowercase SHA-256")
    if snapshot.get("embeddingSpace") != EMBEDDING_SPACE:
        raise ValueError(f"snapshot embeddingSpace must be {EMBEDDING_SPACE}")
    if not isinstance(snapshot.get("processingFingerprint"), str) or not snapshot["processingFingerprint"]:
        raise ValueError("snapshot processingFingerprint must be nonempty")
    source = snapshot.get("regions")
    if not isinstance(source, list):
        raise ValueError("snapshot regions must be a list")
    regions: list[dict[str, object]] = []
    ids: set[str] = set()
    alias_ids: set[str] = set()
    dimensions: int | None = None
    previous = ""
    for row in source:
        if not isinstance(row, dict):
            raise ValueError("snapshot region must be an object")
        semantic_id = row.get("semanticId")
        aliases = row.get("aliases")
        vector = row.get("vector")
        if not isinstance(semantic_id, str) or not semantic_id or semantic_id in ids or semantic_id <= previous:
            raise ValueError("snapshot regions must have unique, sorted semanticId values")
        if not isinstance(aliases, list) or not aliases:
            raise ValueError("snapshot region aliases must be nonempty")
        current_aliases: list[dict[str, object]] = []
        for alias in aliases:
            if not isinstance(alias, dict) or not isinstance(alias.get("semanticId"), str) or not alias["semanticId"]:
                raise ValueError("snapshot alias semanticId must be nonempty")
            if alias["semanticId"] in alias_ids:
                raise ValueError("snapshot aliases must have globally unique semanticId values")
            alias_ids.add(alias["semanticId"])
            current_aliases.append(copy.deepcopy(alias))
        if semantic_id != min(alias["semanticId"] for alias in current_aliases):
            raise ValueError("snapshot region semanticId must be its smallest alias semanticId")
        if not isinstance(vector, (list, tuple)) or len(vector) != EMBED_DIM:
            raise ValueError(f"snapshot vector must contain exactly {EMBED_DIM} entries")
        values = [_number(value, "snapshot vector value") for value in vector]
        if dimensions is None:
            dimensions = len(values)
        elif len(values) != dimensions:
            raise ValueError("snapshot vectors must have consistent dimensions")
        norm = math.sqrt(sum(value * value for value in values))
        if abs(norm - 1.0) > 1e-4:
            raise ValueError("snapshot vectors must have unit L2 norm")
        regions.append({"semanticId": semantic_id, "aliases": current_aliases, "vector": values})
        ids.add(semantic_id)
        previous = semantic_id
    return regions, dimensions or 0


def _small_positions(count: int) -> list[tuple[float, float]]:
    """Stable circle positions used only when UMAP is intentionally bypassed."""
    if not count:
        return []
    return [(math.cos(2 * math.pi * index / count), math.sin(2 * math.pi * index / count)) for index in range(count)]


def _as_coordinates(values: Any, count: int, dimensions: int) -> list[list[float]]:
    rows = list(values)
    if len(rows) != count:
        raise ValueError("algorithm returned an unexpected number of rows")
    result: list[list[float]] = []
    for row in rows:
        try:
            values = list(row)
        except TypeError as error:
            raise ValueError("algorithm returned a non-coordinate row") from error
        if len(values) != dimensions:
            raise ValueError("algorithm returned unexpected dimensions")
        result.append([_number(value, "algorithm coordinate") for value in values])
    return result


def cluster_snapshot(snapshot: Mapping[str, object], preset: str, *,
                     parameters: Mapping[str, object] | None = None,
                     reducer_factory: Callable[..., Any] | None = None,
                     display_factory: Callable[..., Any] | None = None,
                     clusterer_factory: Callable[..., Any] | None = None,
                     versions: Mapping[str, str] | None = None) -> dict[str, object]:
    """Cluster one validated immutable corpus snapshot without mutating it.

    Factory seams are test-only dependency injection points.  Normal operation
    imports pinned UMAP/HDBSCAN and records their installed versions.
    """
    if preset not in PRESETS:
        raise ValueError("preset must be broad, useful, or fine")
    regions, _dimensions = _validate_snapshot(snapshot)
    if parameters is None:
        requested = dict(PRESETS[preset])
    else:
        limits = {"neighbors": (2, 200), "minClusterSize": (2, 500), "minSamples": (1, 100)}
        if not isinstance(parameters, Mapping) or set(parameters) != set(limits):
            raise ValueError("parameters must contain exactly neighbors, minClusterSize, and minSamples")
        requested = {}
        for name, (lower, upper) in limits.items():
            value = parameters[name]
            if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
                raise ValueError(f"invalid {name}")
            requested[name] = value
    dependency_versions = dict(versions) if versions is not None else _versions()
    required_versions = set(_VERSION_PACKAGES)
    if set(dependency_versions) != required_versions or not all(isinstance(value, str) and value for value in dependency_versions.values()):
        raise ValueError("algorithmVersions must contain each pinned algorithm package")
    algorithm_versions = {**dependency_versions, ALGORITHM_VERSION_KEY: ALGORITHM_REVISION}
    count = len(regions)
    result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA,
        "corpus": {"schemaVersion": CORPUS_SCHEMA, "digest": snapshot["corpusDigest"], "regionCount": count},
        "model": {"embeddingSpace": snapshot["embeddingSpace"], "processingFingerprint": snapshot["processingFingerprint"]},
        "preset": preset,
        "requestedParams": requested,
        "algorithmVersions": algorithm_versions,
        "seed": SEED,
    }
    if count < 5:
        positions = _small_positions(count)
        result["effectiveParams"] = {"neighbors": None, "dimensions": None, "minClusterSize": None, "minSamples": None}
        result["members"] = [{"semanticId": row["semanticId"], "aliases": row["aliases"], "clusterLabel": None,
                              "membership": 0.0, "x": positions[index][0], "y": positions[index][1]}
                             for index, row in enumerate(regions)]
        result["outliers"] = [row["semanticId"] for row in regions]
        return result
    if reducer_factory is None or display_factory is None or clusterer_factory is None:
        reducer_factory, display_factory, clusterer_factory = _factories()
    effective = {
        "neighbors": min(max(requested["neighbors"], 2), count - 1),
        "dimensions": min(10, count - 2),
        "minClusterSize": min(max(requested["minClusterSize"], 2), count),
        "minSamples": min(max(requested["minSamples"], 1), count),
    }
    vectors = [row["vector"] for row in regions]
    reduced = _as_coordinates(reducer_factory(n_neighbors=effective["neighbors"], n_components=effective["dimensions"],
                                               metric="cosine", min_dist=0, init="random", random_state=SEED, n_jobs=1).fit_transform(vectors), count, effective["dimensions"])
    display = _as_coordinates(display_factory(n_neighbors=effective["neighbors"], n_components=2, metric="cosine",
                                               min_dist=0.1, init="random", random_state=SEED, n_jobs=1).fit_transform(vectors), count, 2)
    fitted = clusterer_factory(metric="euclidean", cluster_selection_method="eom", min_cluster_size=effective["minClusterSize"],
                               min_samples=effective["minSamples"]).fit(reduced)
    labels, probabilities = list(fitted.labels_), list(fitted.probabilities_)
    if len(labels) != count or len(probabilities) != count:
        raise ValueError("clusterer returned an unexpected number of labels")
    clusters: dict[int, list[str]] = {}
    for index, label in enumerate(labels):
        if not isinstance(label, numbers.Integral) or isinstance(label, bool):
            raise ValueError("clusterer labels must be integers")
        label = int(label)
        if label < -1:
            raise ValueError("clusterer labels must be -1 or nonnegative")
        labels[index] = label
        if label >= 0:
            clusters.setdefault(label, []).append(regions[index]["semanticId"])
    # HDBSCAN labels are implementation details: canonically relabel by each
    # cluster's smallest semantic ID so ties and repeated runs are observable.
    labels_by_original = {label: index for index, (label, _) in enumerate(sorted(clusters.items(), key=lambda item: min(item[1])))}
    members: list[dict[str, object]] = []
    outliers: list[str] = []
    for index, row in enumerate(regions):
        label = labels[index]
        probability = _number(probabilities[index], "membership")
        if probability < 0 or probability > 1:
            raise ValueError("membership must be between zero and one")
        output_label = labels_by_original[label] if label >= 0 else None
        if output_label is None:
            outliers.append(row["semanticId"])
        members.append({"semanticId": row["semanticId"], "aliases": row["aliases"], "clusterLabel": output_label,
                        "membership": probability, "x": display[index][0], "y": display[index][1]})
    result["effectiveParams"] = effective
    result["members"] = members
    result["outliers"] = outliers
    return result
