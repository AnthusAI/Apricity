"""Executable contract for the bounded M4 cluster-summary packet."""
from __future__ import annotations

import copy
import inspect
import json
import math
from pathlib import Path

import pytest

from apricity_analyze.cluster_summaries import build_cluster_summaries
from apricity_analyze import clap
from apricity_analyze.clap import CHECKPOINT, CHECKPOINT_REVISION, EMBED_DIM, EMBEDDING_SPACE


SPACE = EMBEDDING_SPACE
DIGEST = "a" * 64


def vector(*entries: tuple[int, float]) -> list[float]:
    values = [0.0] * EMBED_DIM
    for index, value in entries:
        values[index] = value
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values]


def alias(semantic_id: str, sample_id: str, recording_id: str, *, kind: str = "saved_clip", clip_id: str | None = None) -> dict:
    return {"semanticId": semantic_id, "semanticIdentity": {"semanticId": semantic_id, "sampleId": sample_id,
            "recordingId": recording_id, "kind": kind, **({"clipId": clip_id or semantic_id} if kind == "saved_clip" else {}),
            "start": 0.0, "end": 4.0, "audioSha256": "b" * 64, "embeddingSpace": SPACE,
            "processingFingerprint": "preprocess-v1"}, "sample": {"id": sample_id}, "recording": {"id": recording_id},
            "clip": {"id": clip_id or semantic_id} if kind == "saved_clip" else None}


def inputs(*, zero_centroid: bool = False):
    rows = [
        ("a", vector((0, 1)), [alias("a", "sample-a", "recording-1"), alias("a-alias", "sample-a", "recording-1", kind="window")]),
        ("b", vector((0, -1)) if zero_centroid else vector((0, .95), (1, .05)), [alias("b", "sample-b", "recording-1")]),
        ("c", vector((0, .9), (1, .1)), [alias("c", "sample-c", "recording-2")]),
        ("d", vector((1, 1)), [alias("d", "sample-d", "recording-3")]),
    ]
    snapshot = {"schemaVersion": "apricity.cluster-corpus/1", "corpusDigest": DIGEST, "embeddingSpace": SPACE,
                "processingFingerprint": "preprocess-v1", "regions": [{"semanticId": sid, "vector": values, "aliases": aliases} for sid, values, aliases in rows]}
    result = {"schemaVersion": "apricity.clustering-result/1", "corpus": {"schemaVersion": "apricity.cluster-corpus/1", "digest": DIGEST, "regionCount": 4},
              "model": {"embeddingSpace": SPACE, "processingFingerprint": "preprocess-v1"}, "preset": "fine",
              "requestedParams": {"neighbors": 15, "minClusterSize": 5, "minSamples": 3}, "effectiveParams": {"neighbors": 3, "dimensions": 2, "minClusterSize": 4, "minSamples": 3},
              "algorithmVersions": {"umap-learn": "test", "hdbscan": "test"}, "seed": 42,
              "members": [{"semanticId": "a", "aliases": rows[0][2], "clusterLabel": 7, "membership": .9, "x": 1., "y": 2.},
                          {"semanticId": "b", "aliases": rows[1][2], "clusterLabel": 7, "membership": .8, "x": 2., "y": 3.},
                          {"semanticId": "c", "aliases": rows[2][2], "clusterLabel": 7, "membership": .7, "x": 3., "y": 4.},
                          {"semanticId": "d", "aliases": rows[3][2], "clusterLabel": None, "membership": 0., "x": 4., "y": 5.}], "outliers": ["d"]}
    def flattened_metadata(row: dict) -> dict:
        identity = row["semanticIdentity"]
        return {"semanticId": row["semanticId"], "sampleId": row["sample"]["id"], "recordingId": row["recording"]["id"],
                "kind": identity["kind"], "start": identity["start"], "end": identity["end"], "audioSha256": identity["audioSha256"],
                "embeddingSpace": identity["embeddingSpace"], "processingFingerprint": identity["processingFingerprint"],
                "fileKey": f"audio/{row['sample']['id']}.wav", "sampleTitle": row["sample"]["id"],
                **({"clipId": row["clip"]["id"], "clipName": row["semanticId"]} if row["clip"] else {})}

    metadata = {row["semanticId"]: flattened_metadata(row) for _, _, aliases in rows for row in aliases}
    vocabulary = {"schemaVersion": "apricity.concept-vocabulary/1", "vocabularyVersion": "semantic-audio-concepts-v1", "embeddingSpace": SPACE,
                  "provenance": {"source": "fixtures/semantic-audio/browser-parity-fp32.json", "checkpoint": "laion/clap-htsat-unfused", "checkpointRevision": "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a", "tokenizer": "roberta-base", "tokenizerRevision": "main"},
                  "concepts": [{"conceptId": "drum-beat", "label": "drum beat", "vector512": vector((0, 1))}, {"conceptId": "ambient-music", "label": "ambient music", "vector512": vector((1, 1))}]}
    return snapshot, result, vocabulary, metadata


def test_builds_frozen_traceable_summary_with_diverse_playable_representatives_and_no_mutation():
    snapshot, result, vocabulary, metadata = inputs()
    before = copy.deepcopy((snapshot, result, vocabulary, metadata))
    packet = build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)

    assert packet["schemaVersion"] == "apricity.cluster-summaries/1"
    assert packet["corpus"] == result["corpus"] and packet["model"] == result["model"] and packet["preset"] == "fine"
    assert packet["algorithmVersions"] == result["algorithmVersions"] and packet["qualityReview"] == {"status": "pending"}
    assert [row["clusterId"] for row in packet["clusters"]] == [7]
    cluster = packet["clusters"][0]
    assert cluster["centroidMethod"] == "mean_normalized" and abs(math.sqrt(sum(x*x for x in cluster["centroid"])) - 1) < 1e-12
    assert [row["semanticId"] for row in cluster["representatives"]] == ["b", "c", "a"]
    assert [row["recordingId"] for row in cluster["representatives"][:2]] == ["recording-1", "recording-2"]
    assert cluster["distinctSampleCount"] == 3 and cluster["savedClipCount"] == 3
    assert cluster["suggestedLabel"]["method"] == "clap_concept"
    assert cluster["suggestedLabel"]["approved"] is False
    assert [row["conceptId"] for row in cluster["suggestedLabel"]["conceptScores"]] == ["drum-beat", "ambient-music"]
    assert packet["outliers"] == [{"semanticId": "d", "aliases": ["d"]}]
    assert (snapshot, result, vocabulary, metadata) == before


def test_zero_mean_uses_smallest_semantic_id_vector_and_explicit_fallback_label_when_vocabulary_is_incompatible():
    snapshot, result, vocabulary, metadata = inputs(zero_centroid=True)
    vocabulary["embeddingSpace"] = "other-space"
    result["members"][2]["clusterLabel"] = None
    result["outliers"] = ["c", "d"]
    packet = build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)
    cluster = packet["clusters"][0]
    assert cluster["centroidMethod"] == "representative_fallback"
    assert cluster["centroid"] == vector((0, 1))
    assert cluster["suggestedLabel"] == {"label": None, "method": "unlabelled", "reason": "incompatible_embedding_space", "approved": False,
                                          "vocabularyVersion": "semantic-audio-concepts-v1", "provenance": vocabulary["provenance"], "conceptScores": []}


@pytest.mark.parametrize("mutate", [
    lambda s, r, v, m: s.update(corpusDigest="z" * 64),
    lambda s, r, v, m: r["model"].update(embeddingSpace="other-space"),
    lambda s, r, v, m: r["members"].append(copy.deepcopy(r["members"][0])),
    lambda s, r, v, m: r["members"][0].update(membership=math.nan),
    lambda s, r, v, m: r["members"][0].update(x=math.inf),
    lambda s, r, v, m: m.pop("a"),
    lambda s, r, v, m: m["a"].update(fileKey="", start=9),
])
def test_rejects_malformed_or_different_version_packets_and_fake_playback_metadata(mutate):
    snapshot, result, vocabulary, metadata = inputs()
    mutate(snapshot, result, vocabulary, metadata)
    with pytest.raises(ValueError):
        build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)


def test_fixture_is_versioned_six_prompt_ground_vectors_extracted_from_fp32_reference():
    fixture = json.loads(Path("fixtures/semantic-audio/concept-vocabulary-v1.json").read_text())
    parity = json.loads(Path("fixtures/semantic-audio/browser-parity-fp32.json").read_text())
    reference = parity["reference"]
    assert fixture["schemaVersion"] == "apricity.concept-vocabulary/1"
    assert fixture["embeddingSpace"] == reference["embeddingSpace"] == SPACE
    assert fixture["provenance"]["source"] == "fixtures/semantic-audio/browser-parity-fp32.json"
    assert fixture["provenance"]["checkpoint"] == CHECKPOINT
    assert fixture["provenance"]["checkpointRevision"] == CHECKPOINT_REVISION
    assert fixture["provenance"]["tokenizerAssetSource"] == {"checkpoint": CHECKPOINT, "checkpointRevision": CHECKPOINT_REVISION}
    assert "tokenizer" not in fixture["provenance"] and "tokenizerRevision" not in fixture["provenance"]
    assert fixture["provenance"]["browserManifestParityEvidence"] == parity["pinnedManifest"]
    assert "ClapProcessor.from_pretrained(checkpoint, revision=CHECKPOINT_REVISION" in inspect.getsource(clap._load)
    assert [row["prompt"] for row in fixture["concepts"]] == [row["text"] for row in reference["prompts"]]
    assert [row["vector512"] for row in fixture["concepts"]] == [row["vector512"] for row in reference["prompts"]]
    assert all(len(row["vector512"]) == EMBED_DIM and abs(math.sqrt(sum(value * value for value in row["vector512"])) - 1) <= 1e-4 for row in fixture["concepts"])


def test_flattened_semantic_record_window_omits_saved_clip_fields_from_metadata_and_output():
    snapshot, result, vocabulary, metadata = inputs()
    identity = snapshot["regions"][0]["aliases"][0]["semanticIdentity"]
    identity.pop("clipId")
    identity["kind"] = "window"
    metadata["a"] = {
        "semanticId": "a", "sampleId": "sample-a", "recordingId": "recording-1", "kind": "window",
        "start": 0.0, "end": 4.0, "audioSha256": "b" * 64, "embeddingSpace": SPACE,
        "processingFingerprint": "preprocess-v1", "fileKey": "audio/sample-a.wav", "sampleTitle": "sample-a",
    }

    packet = build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)

    representative = next(row for row in packet["clusters"][0]["representatives"] if row["semanticId"] == "a")
    assert "clipId" not in representative and "clipName" not in representative


@pytest.mark.parametrize("file_key", ["", "/audio/a.wav", "audio\\\\a.wav", "audio/../a.wav", "audio/./a.wav", "audio//a.wav", "audio/\x00a.wav"])
def test_rejects_unsafe_playback_file_keys(file_key):
    snapshot, result, vocabulary, metadata = inputs()
    metadata["a"]["fileKey"] = file_key
    with pytest.raises(ValueError):
        build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)


@pytest.mark.parametrize("mutate", [
    lambda s, r, v, m: s.update(embeddingSpace="other-space"),
    lambda s, r, v, m: r.update(seed=None),
    lambda s, r, v, m: r.update(seed=7),
    lambda s, r, v, m: r.update(algorithmVersions={}),
    lambda s, r, v, m: r.update(algorithmVersions={"umap-learn": ""}),
    lambda s, r, v, m: r.update(preset="invented"),
    lambda s, r, v, m: m["a"].update(embeddingSpace=None),
    lambda s, r, v, m: m["a"].update(processingFingerprint="unknown"),
    lambda s, r, v, m: m["a"].pop("embeddingSpace"),
    lambda s, r, v, m: m["a"].pop("processingFingerprint"),
    lambda s, r, v, m: m["a"].update(clipId="current-but-wrong"),
    lambda s, r, v, m: m["a"].pop("clipName"),
])
def test_rejects_incoherent_run_provenance_and_noncanonical_flattened_metadata(mutate):
    snapshot, result, vocabulary, metadata = inputs()
    mutate(snapshot, result, vocabulary, metadata)
    with pytest.raises(ValueError):
        build_cluster_summaries(snapshot, result, vocabulary, metadata=metadata)
