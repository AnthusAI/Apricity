"""Executable M4 clustering-result contract tests."""
from __future__ import annotations

import copy
import math

import pytest

from apricity_analyze.audio_clusters import AlgorithmDependencyError, cluster_snapshot
from apricity_analyze.clap import EMBED_DIM, EMBEDDING_SPACE


def _vector(index: int, dimensions: int = EMBED_DIM) -> list[float]:
    values = [0.0] * dimensions
    values[index % dimensions] = 1.0
    return values


def snapshot(count: int = 6) -> dict[str, object]:
    regions = []
    for index in range(count):
        semantic_id = f"region-{index:02d}"
        regions.append({
            "semanticId": semantic_id,
            "vector": _vector(index),
            "aliases": [{"semanticId": semantic_id, "sample": {"id": f"sample-{index}"}}],
        })
    return {
        "schemaVersion": "apricity.cluster-corpus/1",
        "corpusDigest": "a" * 64,
        "embeddingSpace": EMBEDDING_SPACE,
        "processingFingerprint": "preprocess-v1",
        "regions": regions,
    }


class Reducer:
    calls = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls.append(kwargs)

    def fit_transform(self, values):
        return [[float(row[0]), float(index)] + [0.0] * (self.kwargs["n_components"] - 2) for index, row in enumerate(values)]


class Display:
    calls = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls.append(kwargs)

    def fit_transform(self, values):
        return [[float(index), float(-index)] for index, _ in enumerate(values)]


class Clusterer:
    values = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def fit(self, values):
        self.values.append(values)
        self.labels_ = [9, 9, -1, 4, 4, -1]
        self.probabilities_ = [0.7, 0.8, 0.0, 0.6, 0.9, 0.0]
        return self


class NonfiniteReducer(Reducer):
    def fit_transform(self, values):
        result = super().fit_transform(values)
        result[0][0] = math.nan
        return result


class NonfiniteMembershipClusterer(Clusterer):
    def fit(self, values):
        fitted = super().fit(values)
        fitted.probabilities_[0] = math.inf
        return fitted


class NegativeLabelClusterer(Clusterer):
    def fit(self, values):
        fitted = super().fit(values)
        fitted.labels_[0] = -2
        return fitted


def seams():
    Reducer.calls = []
    Display.calls = []
    Clusterer.values = []
    return {"reducer_factory": Reducer, "display_factory": Display, "clusterer_factory": Clusterer,
            "versions": {"umap-learn": "test", "hdbscan": "test", "numpy": "test", "scipy": "test", "scikit-learn": "test", "numba": "test", "pynndescent": "test"}}


@pytest.mark.parametrize("preset, requested", [
    ("broad", {"neighbors": 50, "minClusterSize": 40, "minSamples": 10}),
    ("useful", {"neighbors": 30, "minClusterSize": 15, "minSamples": 5}),
    ("fine", {"neighbors": 15, "minClusterSize": 5, "minSamples": 3}),
])
def test_accepted_presets_are_reproducible_and_record_requested_effective_parameters(preset, requested):
    source = snapshot()
    before = copy.deepcopy(source)
    first = cluster_snapshot(source, preset, **seams())
    second = cluster_snapshot(source, preset, **seams())

    assert first == second
    assert source == before
    assert first["schemaVersion"] == "apricity.clustering-result/1"
    assert first["requestedParams"] == requested
    assert first["effectiveParams"] == {
        "neighbors": 5, "dimensions": 4,
        "minClusterSize": min(max(requested["minClusterSize"], 2), 6),
        "minSamples": min(max(requested["minSamples"], 1), 6),
    }
    assert [member["semanticId"] for member in first["members"]] == [f"region-{index:02d}" for index in range(6)]
    assert [member["clusterLabel"] for member in first["members"]] == [0, 0, None, 1, 1, None]
    assert first["outliers"] == ["region-02", "region-05"]
    assert first["algorithmVersions"]["umap-learn"] == "test"
    assert first["members"][0]["x"] == 0.0 and first["members"][0]["y"] == 0.0
    assert Reducer.calls == [{"n_neighbors": 5, "n_components": 4, "metric": "cosine", "min_dist": 0, "random_state": 42, "n_jobs": 1}]
    assert Display.calls == [{"n_neighbors": 5, "n_components": 2, "metric": "cosine", "min_dist": 0.1, "random_state": 42, "n_jobs": 1}]
    assert len(Clusterer.values[0][0]) == 4
    first["members"][0]["aliases"][0]["sample"]["id"] = "changed"
    assert source == before


def test_small_corpus_bypasses_invalid_algorithms_and_has_deterministic_unclustered_positions():
    source = snapshot(4)
    result = cluster_snapshot(source, "fine", **seams())

    assert result["effectiveParams"] == {"neighbors": None, "dimensions": None, "minClusterSize": None, "minSamples": None}
    assert [member["clusterLabel"] for member in result["members"]] == [None] * 4
    assert result["outliers"] == [f"region-{index:02d}" for index in range(4)]
    assert all(math.isfinite(member["x"]) and math.isfinite(member["y"]) for member in result["members"])


def test_snapshot_contract_rejects_unsorted_regions_duplicate_aliases_wrong_size_nonunit_and_non_numeric_vectors_and_wrong_space():
    for mutate in (
        lambda value: value["regions"].reverse(),
        lambda value: [row.update(vector=_vector(index, 12)) for index, row in enumerate(value["regions"])],
        lambda value: value["regions"][0].update(vector=[0.5] + [0.0] * (EMBED_DIM - 1)),
        lambda value: value["regions"][1]["aliases"].__setitem__(0, {"semanticId": "region-00"}),
        lambda value: value.update(embeddingSpace="another-model-space"),
        lambda value: value["regions"][0].update(vector=["1"] + ["0"] * (EMBED_DIM - 1)),
        lambda value: value["regions"][0].update(vector=[True] + [False] * (EMBED_DIM - 1)),
        lambda value: value["regions"][0].update(vector=[None] + [0.0] * (EMBED_DIM - 1)),
    ):
        source = snapshot()
        mutate(source)
        with pytest.raises(ValueError):
            cluster_snapshot(source, "fine", **seams())


@pytest.mark.parametrize("override", [
    {"reducer_factory": NonfiniteReducer},
    {"clusterer_factory": NonfiniteMembershipClusterer},
    {"clusterer_factory": NegativeLabelClusterer},
])
def test_algorithm_output_rejects_nonfinite_coordinates_membership_and_labels_below_outlier_sentinel(override):
    factories = seams()
    factories.update(override)

    with pytest.raises(ValueError):
        cluster_snapshot(snapshot(), "fine", **factories)


def test_actual_algorithm_run_twice_is_reproducible_or_reports_missing_dependency_as_not_evaluated():
    source = snapshot(8)
    try:
        first = cluster_snapshot(source, "fine")
        second = cluster_snapshot(source, "fine")
    except AlgorithmDependencyError as error:
        pytest.fail(f"not_evaluated: {error}")
    assert first == second
    assert first["algorithmVersions"] == {
        "umap-learn": "0.5.12", "hdbscan": "0.8.44", "numpy": "2.2.6",
        "scipy": "1.18.1", "scikit-learn": "1.9.1", "numba": "0.67.0", "pynndescent": "0.6.0",
    }
