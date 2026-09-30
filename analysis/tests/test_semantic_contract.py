"""Executable M0 contract for semantic region interchange."""

from __future__ import annotations

import json
import math
import pathlib

import jsonschema
import pytest

from apricity_analyze.semantic_contract import (
    EMBEDDING_DIMENSIONS,
    SemanticContractError,
    SemanticIdentity,
    normalize_vector,
    round_half_up_microseconds,
    validate_vector,
)


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "schema" / "semantic-audio.schema.json"
FIXTURE_PATH = ROOT / "fixtures" / "semantic-audio" / "contracts.json"
SPACE = "clap-htsat-unfused-512-v1"
FINGERPRINT = "preprocess-v1"
SHA_A = "a" * 64


def identity(**changes: object) -> SemanticIdentity:
    values: dict[str, object] = {
        "sample_id": "smp_A",
        "recording_id": "rec_R1",
        "kind": "saved_clip",
        "clip_id": "clp_a1",
        "start": 0.0000005,
        "end": 4.0000005,
        "audio_sha256": SHA_A,
        "embedding_space": SPACE,
        "processing_fingerprint": FINGERPRINT,
    }
    values.update(changes)
    return SemanticIdentity(**values)  # type: ignore[arg-type]


def basis(index: int, sign: float = 1.0) -> list[float]:
    vector = [0.0] * EMBEDDING_DIMENSIONS
    vector[index] = sign
    return vector


def test_saved_clip_identity_uses_canonical_tuple_and_half_up_microseconds():
    region = identity()

    assert round_half_up_microseconds(0.0000005) == 1
    assert region.canonical_tuple == (
        "smp_A", "rec_R1", "saved_clip", "clp_a1", 1, 4_000_001,
        SHA_A, SPACE, FINGERPRINT,
    )
    assert region.semantic_id == "28a939c4ed0c0375bddc1465eed8b798b97823bee8f026b9e3323a6b71d88914"


def test_saved_clips_and_windows_are_distinct_and_display_is_not_identity():
    clip = identity()
    window = identity(kind="window", clip_id=None, start=0, end=4)
    renamed_clip = identity()

    assert clip.semantic_id != window.semantic_id
    assert renamed_clip.semantic_id == clip.semantic_id


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"kind": "window", "clip_id": "clp_a1"}, "clip_id"),
        ({"kind": "saved_clip", "clip_id": None}, "clip_id"),
        ({"sample_id": ""}, "sample_id"),
        ({"audio_sha256": "A" * 64}, "audio_sha256"),
        ({"start": -0.1}, "start"),
        ({"end": math.inf}, "end"),
        ({"start": 4, "end": 4}, "end"),
    ],
)
def test_identity_rejects_noncanonical_regions(changes, message):
    with pytest.raises(SemanticContractError, match=message):
        identity(**changes)


def test_vector_validation_requires_a_finite_512d_unit_vector():
    assert validate_vector(basis(0)) == tuple(basis(0))

    for invalid in (
        basis(0)[:-1],
        [0.0] * EMBEDDING_DIMENSIONS,
        [math.nan] + [0.0] * (EMBEDDING_DIMENSIONS - 1),
        [2.0] + [0.0] * (EMBEDDING_DIMENSIONS - 1),
    ):
        with pytest.raises(SemanticContractError):
            validate_vector(invalid)


def test_normalization_is_explicit_and_rejects_near_zero_vectors():
    vector = [3.0, 4.0] + [0.0] * (EMBEDDING_DIMENSIONS - 2)

    assert normalize_vector(vector) == pytest.approx((0.6, 0.8) + (0.0,) * (EMBEDDING_DIMENSIONS - 2))
    with pytest.raises(SemanticContractError, match="near-zero"):
        normalize_vector([1e-10] + [0.0] * (EMBEDDING_DIMENSIONS - 1))


def test_normalization_requires_512_entries_and_handles_finite_overflow():
    with pytest.raises(SemanticContractError, match="exactly 512"):
        normalize_vector([3.0, 4.0])

    normalized = normalize_vector([1e308] * EMBEDDING_DIMENSIONS)

    assert len(normalized) == EMBEDDING_DIMENSIONS
    assert all(math.isfinite(value) for value in normalized)
    assert math.hypot(*normalized) == pytest.approx(1.0)


def test_vector_validation_rejects_finite_overflow_as_not_unit_norm():
    with pytest.raises(SemanticContractError, match="unit norm"):
        validate_vector([1e308] * EMBEDDING_DIMENSIONS)


def test_contract_fixture_valid_records_agree_with_json_schema_and_hashes():
    fixture = json.loads(FIXTURE_PATH.read_text())
    schema = json.loads(SCHEMA_PATH.read_text())

    jsonschema.validate(fixture, schema)
    assert fixture["schemaVersion"] == "apricity.semantic-audio/1"
    for record in fixture["records"]:
        identity_data = record["identity"]
        region = SemanticIdentity(
            sample_id=identity_data["sampleId"],
            recording_id=identity_data["recordingId"],
            kind=identity_data["kind"],
            clip_id=identity_data.get("clipId"),
            start=identity_data["start"],
            end=identity_data["end"],
            audio_sha256=identity_data["audioSha256"],
            embedding_space=identity_data["embeddingSpace"],
            processing_fingerprint=identity_data["processingFingerprint"],
        )
        assert identity_data["semanticId"] == region.semantic_id
        assert validate_vector(record["vector"])


def test_fixture_carries_required_invalid_and_alias_cases_without_claiming_them_as_records():
    fixture = json.loads(FIXTURE_PATH.read_text())

    assert {case["reason"] for case in fixture["invalidVectors"]} == {
        "missing", "zero", "nonfinite", "wrong_dimension", "wrong_embedding_space",
    }
    assert fixture["aliases"][0]["semanticIds"] != fixture["aliases"][1]["semanticIds"]
    assert fixture["outliers"] == ["e9c8fdae94238bcb1396bad8dc44ea669f551f272140280ba6ce01bf4379c0a4"]
    assert fixture["stateCases"] == {
        "boundaryEdit": {
            "previousSemanticId": "d30d29aa8a16907b4755783fad1f2fa76847db717615eb21cffd8f40d09d5a0f",
            "currentSemanticId": "6df922936608c0ec127ad53988d0f8b7697e97a0df6fa072643dabfb6c0b2014",
        },
        "renamed": {"semanticId": "4558db8aecb4748c645c02908c58d7687ea4302f2ee05e84e0e309b73baaa796", "clipName": "A2 renamed"},
        "retired": "d30d29aa8a16907b4755783fad1f2fa76847db717615eb21cffd8f40d09d5a0f",
        "hidden": "bd47e8f9a606e482b1734254b94550daaf2b718afd07a400de442f491c933727",
    }
