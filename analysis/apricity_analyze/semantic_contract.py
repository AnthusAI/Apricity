"""Canonical, model-independent semantic-audio interchange contract.

This module deliberately accepts values extracted from the existing canonical
Sample, Recording, and Clip models.  It neither resolves nor invents those
parents; it makes their stable region identity and vector requirements explicit.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import json
import math
from numbers import Real
from typing import Iterable, Literal


EMBEDDING_DIMENSIONS = 512
UNIT_NORM_TOLERANCE = 1e-4
NEAR_ZERO_NORM = 1e-9
SemanticKind = Literal["saved_clip", "window"]


class SemanticContractError(ValueError):
    """A semantic interchange value violates the accepted cross-runtime contract."""


def _finite_number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise SemanticContractError(f"{name} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise SemanticContractError(f"{name} must be a finite number")
    return number


def round_half_up_microseconds(seconds: object) -> int:
    """Convert a finite, non-negative source time to canonical microseconds."""
    value = _finite_number(seconds, "time")
    if value < 0:
        raise SemanticContractError("time must not be negative")
    try:
        return int((Decimal(str(seconds)) * Decimal("1000000")).to_integral_value(rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError) as error:
        raise SemanticContractError("time must be a finite number") from error


def _required_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise SemanticContractError(f"{name} must be a nonempty string")
    return value


@dataclass(frozen=True, slots=True)
class SemanticIdentity:
    sample_id: str
    recording_id: str
    kind: SemanticKind
    clip_id: str | None
    start: float
    end: float
    audio_sha256: str
    embedding_space: str
    processing_fingerprint: str

    def __post_init__(self) -> None:
        _required_string(self.sample_id, "sample_id")
        _required_string(self.recording_id, "recording_id")
        if self.kind not in ("saved_clip", "window"):
            raise SemanticContractError("kind must be saved_clip or window")
        if self.kind == "saved_clip" and not isinstance(self.clip_id, str):
            raise SemanticContractError("clip_id is required for saved_clip")
        if self.kind == "saved_clip" and not self.clip_id:
            raise SemanticContractError("clip_id is required for saved_clip")
        if self.kind == "window" and self.clip_id is not None:
            raise SemanticContractError("clip_id must be absent for window")
        start = _finite_number(self.start, "start")
        end = _finite_number(self.end, "end")
        if start < 0:
            raise SemanticContractError("start must not be negative")
        if end <= start:
            raise SemanticContractError("end must be greater than start")
        if not isinstance(self.audio_sha256, str) or not _is_sha256(self.audio_sha256):
            raise SemanticContractError("audio_sha256 must be 64 lowercase hexadecimal characters")
        _required_string(self.embedding_space, "embedding_space")
        _required_string(self.processing_fingerprint, "processing_fingerprint")

    @property
    def start_us(self) -> int:
        return round_half_up_microseconds(self.start)

    @property
    def end_us(self) -> int:
        return round_half_up_microseconds(self.end)

    @property
    def canonical_tuple(self) -> tuple[str, str, SemanticKind, str | None, int, int, str, str, str]:
        return (
            self.sample_id,
            self.recording_id,
            self.kind,
            self.clip_id,
            self.start_us,
            self.end_us,
            self.audio_sha256,
            self.embedding_space,
            self.processing_fingerprint,
        )

    @property
    def semantic_id(self) -> str:
        canonical = json.dumps(self.canonical_tuple, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _coerce_vector(vector: Iterable[object]) -> tuple[float, ...]:
    try:
        values = tuple(_finite_number(value, "vector entry") for value in vector)
    except TypeError as error:
        raise SemanticContractError("vector must be an iterable of finite numbers") from error
    return values


def _require_embedding_dimensions(values: tuple[float, ...]) -> None:
    if len(values) != EMBEDDING_DIMENSIONS:
        raise SemanticContractError(f"vector must contain exactly {EMBEDDING_DIMENSIONS} entries")


def _scaled_normalize(values: tuple[float, ...]) -> tuple[float, ...]:
    """Normalize finite values without overflowing their intermediate L2 norm."""
    scale = max(abs(value) for value in values)
    if scale == 0.0:
        raise SemanticContractError("vector has near-zero norm")

    scaled_values = tuple(value / scale for value in values)
    scaled_norm = math.hypot(*scaled_values)
    if not math.isfinite(scaled_norm):
        raise SemanticContractError("vector must have a finite norm")
    if scale <= NEAR_ZERO_NORM / scaled_norm:
        raise SemanticContractError("vector has near-zero norm")
    return tuple(value / scaled_norm for value in scaled_values)


def normalize_vector(vector: Iterable[object]) -> tuple[float, ...]:
    """Normalize a producer vector, rejecting nonfinite and near-zero inputs."""
    values = _coerce_vector(vector)
    _require_embedding_dimensions(values)
    return _scaled_normalize(values)


def validate_vector(vector: Iterable[object]) -> tuple[float, ...]:
    """Validate a retrieval/interchange vector without silently rescaling it."""
    values = _coerce_vector(vector)
    _require_embedding_dimensions(values)
    norm = math.hypot(*values)
    if not math.isfinite(norm):
        raise SemanticContractError(f"vector must have unit norm within {UNIT_NORM_TOLERANCE}")
    if norm <= NEAR_ZERO_NORM:
        raise SemanticContractError("vector has near-zero norm")
    if abs(norm - 1.0) > UNIT_NORM_TOLERANCE:
        raise SemanticContractError(f"vector must have unit norm within {UNIT_NORM_TOLERANCE}")
    return values
