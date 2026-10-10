"""Deterministic fixtures for the M4 current, deduplicated corpus snapshot."""
from __future__ import annotations

import copy
import hashlib
import json
import math

from apricity_analyze.semantic_contract import SemanticIdentity
from apricity_analyze.semantic_records import _grid, load_catalog

from apricity_analyze.cluster_corpus import build_cluster_snapshot


SPACE = "clap-htsat-unfused-512-v1"
FINGERPRINT = "preprocess-v1"
SHA_A = "a" * 64
SHA_C = "c" * 64


def vector(index=0, *, sign=1):
    value = [0.0] * 512
    value[index] = float(sign)
    return value


def catalog():
    return load_catalog({
        "samples": [
            {"id": "smp_A", "recordingId": "rec_R1", "path": "A.wav", "audio": {"sha256": SHA_A, "key": "A.wav", "duration": 8}},
            {"id": "smp_B", "recordingId": "rec_R1", "path": "B.wav", "audio": {"sha256": SHA_A, "key": "B.wav", "duration": 8}},
            {"id": "smp_C", "recordingId": "rec_R2", "path": "C.wav", "audio": {"sha256": SHA_C, "key": "C.wav", "duration": 8}},
        ],
        "recordings": [{"id": "rec_R1"}, {"id": "rec_R2"}],
        "clips": [
            {"id": "clp_a1", "sampleId": "smp_A", "start": 0, "end": 4},
            {"id": "clp_b1", "sampleId": "smp_B", "start": 0, "end": 4},
            {"id": "clp_c1", "sampleId": "smp_C", "start": 1, "end": 5},
            {"id": "clp_retired", "sampleId": "smp_A", "start": 4, "end": 8, "retired": True},
        ],
        "analyses": {
            "smp_A": {"source": {"sha256": SHA_A}, "rhythm": {"bpm": 120, "meter": 4, "beats": [0, 1, 2, 3, 4], "downbeats": [0, 1, 2, 3, 4]}},
            "smp_B": {"source": {"sha256": SHA_A}, "rhythm": {"bpm": 120, "meter": 4, "beats": [0, 1, 2, 3, 4], "downbeats": [0, 1, 2, 3, 4]}},
            "smp_C": {"source": {"sha256": SHA_C}, "rhythm": {"bpm": 120, "meter": 4, "beats": [1, 2, 3, 4, 5], "downbeats": [1, 2, 3, 4, 5]}},
        },
    })


def record(sample_id="smp_A", *, clip_id="clp_a1", start=0, end=4, vector512=None,
           space=SPACE, fingerprint=FINGERPRINT, semantic_id=None, revision=None):
    data = {"smp_A": ("rec_R1", SHA_A), "smp_B": ("rec_R1", SHA_A), "smp_C": ("rec_R2", SHA_C)}
    recording_id, audio_sha = data[sample_id]
    identity = SemanticIdentity(sample_id, recording_id, "saved_clip", clip_id, start, end, audio_sha, space, fingerprint)
    semantic_id = semantic_id or identity.semantic_id
    revision = revision or hashlib.sha256(json.dumps([semantic_id, ""], separators=(",", ":")).encode()).hexdigest()
    return {
        "identity": {"semanticId": semantic_id, "sampleId": sample_id, "recordingId": recording_id,
                     "kind": "saved_clip", "clipId": clip_id, "start": start, "end": end,
                     "audioSha256": audio_sha, "embeddingSpace": space, "processingFingerprint": fingerprint},
        "vector": vector512 if vector512 is not None else vector(),
        "revision": revision,
    }


def window_record(sample_id="smp_A", *, start=0, end=4, vector512=None):
    loaded = catalog()
    recording_id, audio_sha = ("rec_R1", SHA_A) if sample_id in {"smp_A", "smp_B"} else ("rec_R2", SHA_C)
    identity = SemanticIdentity(sample_id, recording_id, "window", None, start, end, audio_sha, SPACE, FINGERPRINT)
    grid, _ = _grid(loaded["analyses"][sample_id])
    semantic_id = identity.semantic_id
    return {
        "identity": {"semanticId": semantic_id, "sampleId": sample_id, "recordingId": recording_id, "kind": "window",
                     "start": start, "end": end, "audioSha256": audio_sha, "embeddingSpace": SPACE, "processingFingerprint": FINGERPRINT},
        "vector": vector512 if vector512 is not None else vector(),
        "revision": hashlib.sha256(json.dumps([semantic_id, grid], separators=(",", ":")).encode()).hexdigest(),
    }


def test_snapshot_deduplicates_saved_clip_and_aliases_with_traceable_parents_and_stable_digest():
    source_catalog = catalog()
    catalog_before = copy.deepcopy(source_catalog)
    first = record("smp_A", clip_id="clp_a1")
    alias = record("smp_B", clip_id="clp_b1")
    other = record("smp_C", clip_id="clp_c1", start=1, end=5, vector512=vector(1))
    before = copy.deepcopy([first, alias, other])

    snapshot = build_cluster_snapshot([other, alias, first], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    repeated = build_cluster_snapshot([first, other, alias], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)

    assert snapshot == repeated
    assert snapshot["schemaVersion"] == "apricity.cluster-corpus/1"
    assert [region["semanticId"] for region in snapshot["regions"]] == sorted([min(first["identity"]["semanticId"], alias["identity"]["semanticId"]), other["identity"]["semanticId"]])
    merged = next(region for region in snapshot["regions"] if len(region["aliases"]) == 2)
    assert [alias_row["semanticId"] for alias_row in merged["aliases"]] == sorted([first["identity"]["semanticId"], alias["identity"]["semanticId"]])
    assert {row["sample"]["id"] for row in merged["aliases"]} == {"smp_A", "smp_B"}
    assert {row["clip"]["id"] for row in merged["aliases"]} == {"clp_a1", "clp_b1"}
    assert [first, alias, other] == before
    assert source_catalog == catalog_before

    changed = copy.deepcopy([first, alias, other])
    changed[0]["vector"] = vector(2)
    assert build_cluster_snapshot(changed, source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["corpusDigest"] != snapshot["corpusDigest"]


def test_snapshot_rechecks_current_parents_identity_revision_bounds_visibility_and_vectors():
    source_catalog = catalog()
    accepted = record()
    invalid = [
        record(semantic_id="0" * 64),
        record(revision="wrong"),
        record(start=0, end=3),
        record(clip_id="clp_retired", start=4, end=8),
        record(space="another-512-space"),
        record(fingerprint="old-preprocess"),
        record(vector512=[0.0] * 512),
        record(vector512=[math.nan] + [0.0] * 511),
        record(clip_id="missing"),
    ]
    snapshot = build_cluster_snapshot([accepted, *invalid], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT,
                                      visibility=lambda sample, recording, clip: sample["id"] != "smp_A" or clip["id"] == "clp_a1")
    assert [region["semanticId"] for region in snapshot["regions"]] == [accepted["identity"]["semanticId"]]
    reasons = {row["reason"] for row in snapshot["excluded"]}
    assert {"tampered_semantic_id", "stale_revision", "current_boundary_mismatch", "retired_clip",
            "incompatible_embedding_space", "incompatible_processing_fingerprint", "invalid_vector", "missing_clip"} <= reasons


def test_snapshot_reports_alias_vector_disagreement_and_canonicalizes_signed_zero_for_digest():
    source_catalog = catalog()
    first = record("smp_A", clip_id="clp_a1", vector512=[-0.0] + [0.0] * 511)
    # -0.0 is a valid unit value only after retaining the e0 component; keep a signed zero elsewhere.
    first["vector"] = [1.0, -0.0] + [0.0] * 510
    alias = record("smp_B", clip_id="clp_b1", vector512=vector(1))
    snapshot = build_cluster_snapshot([alias, first], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    assert snapshot["regions"][0]["semanticId"] == min(first["identity"]["semanticId"], alias["identity"]["semanticId"])
    assert snapshot["disagreements"] == [{"reason": "alias_vector_disagreement", "semanticIds": sorted([first["identity"]["semanticId"], alias["identity"]["semanticId"]])}]

    unsigned = copy.deepcopy(first)
    unsigned["vector"] = [1.0, 0.0] + [0.0] * 510
    assert build_cluster_snapshot([unsigned], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["corpusDigest"] == build_cluster_snapshot([first], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["corpusDigest"]


def test_snapshot_excludes_every_valid_duplicate_semantic_id_without_representative_or_digest_input_order_dependence():
    source_catalog = catalog()
    first = record(vector512=vector(0))
    duplicate = copy.deepcopy(first)
    duplicate["vector"] = vector(1)

    forward = build_cluster_snapshot([first, duplicate], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    reversed_input = build_cluster_snapshot([duplicate, first], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)

    expected = [{"reason": "duplicate_semantic_id", "semanticId": first["identity"]["semanticId"]}] * 2
    assert forward == reversed_input
    assert forward["regions"] == []
    assert forward["excluded"] == expected
    assert forward["coverage"] == {"records": 0, "regions": 0, "excluded": 2}


def test_snapshot_requires_window_analysis_source_and_current_window_revision():
    source_catalog = catalog()
    current = window_record()
    missing_source = copy.deepcopy(source_catalog)
    del missing_source["analyses"]["smp_A"]["source"]
    stale_source = copy.deepcopy(source_catalog)
    stale_source["analyses"]["smp_A"]["source"]["sha256"] = SHA_C
    changed_grid = copy.deepcopy(source_catalog)
    changed_grid["analyses"]["smp_A"]["rhythm"]["bpm"] = 121
    missing_revision = copy.deepcopy(current)
    missing_revision.pop("revision")

    for changed in (missing_source, stale_source):
        snapshot = build_cluster_snapshot([current], changed, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
        assert snapshot["regions"] == []
        assert snapshot["excluded"] == [{"reason": "analysis_source_sha_mismatch", "semanticId": current["identity"]["semanticId"]}]
    assert build_cluster_snapshot([current], changed_grid, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["excluded"] == [{"reason": "stale_revision", "semanticId": current["identity"]["semanticId"]}]
    assert build_cluster_snapshot([missing_revision], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["excluded"] == [{"reason": "stale_revision", "semanticId": current["identity"]["semanticId"]}]


def test_snapshot_window_empty_analysis_visibility_policy_and_rename_only_digest_are_current_only():
    source_catalog = catalog()
    current = window_record()
    empty = copy.deepcopy(source_catalog)
    empty["analyses"]["smp_A"] = {}
    hidden = build_cluster_snapshot([current], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT,
                                    visibility=lambda sample, recording, clip: (False, "hidden_by_policy"))
    renamed = copy.deepcopy(source_catalog)
    renamed["samples"][0]["path"] = "renamed-A.wav"

    assert build_cluster_snapshot([current], empty, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["excluded"] == [{"reason": "missing_analysis", "semanticId": current["identity"]["semanticId"]}]
    assert hidden["regions"] == [] and hidden["excluded"] == [{"reason": "hidden_by_policy", "semanticId": current["identity"]["semanticId"]}]
    assert build_cluster_snapshot([current], renamed, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["corpusDigest"] == build_cluster_snapshot([current], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)["corpusDigest"]


def test_snapshot_handles_empty_missing_parents_and_saved_clip_window_source_aliases():
    source_catalog = catalog()
    saved = record()
    window = window_record()
    snapshot = build_cluster_snapshot([saved, window], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    assert len(snapshot["regions"]) == 1
    assert {row["semanticIdentity"]["kind"] for row in snapshot["regions"][0]["aliases"]} == {"saved_clip", "window"}

    missing_sample = copy.deepcopy(saved)
    no_sample = SemanticIdentity("missing", "rec_R1", "saved_clip", "clp_a1", 0, 4, SHA_A, SPACE, FINGERPRINT)
    missing_sample["identity"].update({"semanticId": no_sample.semantic_id, "sampleId": "missing"})
    missing_sample["revision"] = hashlib.sha256(json.dumps([no_sample.semantic_id, ""], separators=(",", ":")).encode()).hexdigest()
    missing_recording = copy.deepcopy(saved)
    no_recording = SemanticIdentity("smp_A", "missing", "saved_clip", "clp_a1", 0, 4, SHA_A, SPACE, FINGERPRINT)
    missing_recording["identity"].update({"semanticId": no_recording.semantic_id, "recordingId": "missing"})
    missing_recording["revision"] = hashlib.sha256(json.dumps([no_recording.semantic_id, ""], separators=(",", ":")).encode()).hexdigest()
    missing = build_cluster_snapshot([missing_sample, missing_recording], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    assert missing["regions"] == []
    assert {row["reason"] for row in missing["excluded"]} == {"missing_sample", "missing_recording"}
    empty = build_cluster_snapshot([], source_catalog, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    assert empty["regions"] == [] and empty["excluded"] == [] and empty["coverage"] == {"records": 0, "regions": 0, "excluded": 0}
