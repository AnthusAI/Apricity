"""Reproducible relevance-reference export and browser parity evaluation.

This module intentionally does not fall back to a different model or remote
encoder.  ``--generate`` is only allowed once the ground preprocessing handoff
is available from :mod:`apricity_analyze.clap`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np

from .semantic_contract import SemanticContractError, SemanticIdentity, normalize_vector, validate_vector


EMBEDDING_SPACE = "clap-htsat-unfused-512-v1"
CHECKPOINT = "laion/clap-htsat-unfused"
CHECKPOINT_REVISION = "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a"
PREPROCESSING_VERSION = "clap-audio-center10s-v1"
REFERENCE_VERSION = "apricity.semantic-evaluation/1"
FIXED_PROMPTS = (
    "the sound of a drum beat",
    "the sound of rain falling",
    "the sound of a bass guitar",
    "the sound of a person singing",
    "the sound of ambient music",
    "the sound of metal being struck",
)
FIXED_PROMPT_IDS = ("drums", "rain", "bass", "vocal", "ambient", "metal")
_PROMPT_BY_ID = dict(zip(FIXED_PROMPT_IDS, FIXED_PROMPTS, strict=True))


class EvaluationError(ValueError):
    """Evaluation data cannot safely be used for a claimed result."""


class GroundHandoffError(EvaluationError):
    """The local pinned ground implementation has not been accepted yet."""


class EvaluationGateFailed(EvaluationError):
    """A gate was measured and failed; this is distinct from unavailable evidence."""

    def __init__(self, message: str, report: dict[str, object]) -> None:
        super().__init__(message)
        self.report = report


@dataclass(frozen=True)
class GroundProvenance:
    processing_fingerprint: str
    preprocessing_version: str
    embedding_space: str
    checkpoint_revision: str
    installed_versions: dict[str, str]


def _root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_prompts(path: Path | None = None) -> tuple[str, ...]:
    path = path or _root() / "fixtures" / "semantic-audio" / "evaluation-prompts.json"
    data = json.loads(path.read_text())
    prompts = tuple(data.get("prompts", ()))
    if prompts != FIXED_PROMPTS:
        raise EvaluationError("evaluation prompts must be the fixed six versioned prompt texts")
    return prompts


def _valid_reviewed_at(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def load_judgments(path: Path | None = None, prompts: Sequence[str] = FIXED_PROMPTS, *,
                   require_reviewed: bool = False) -> list[dict[str, object]]:
    path = path or _root() / "fixtures" / "semantic-audio" / "evaluation-judgments.json"
    data = json.loads(path.read_text())
    judgments = data.get("judgments")
    _validate_judgments(judgments, prompts, require_reviewed=require_reviewed)
    return judgments


def _validate_judgments(judgments: object, prompts: Sequence[str], *, require_reviewed: bool) -> None:
    if not isinstance(judgments, list) or not judgments:
        raise EvaluationError("relevance judgments must be a nonempty list")
    for judgment in judgments:
        if not isinstance(judgment, dict) or judgment.get("prompt") not in prompts:
            raise EvaluationError("relevance judgment has an unknown prompt")
        prompt_id = judgment.get("promptId")
        if not isinstance(prompt_id, str) or _PROMPT_BY_ID.get(prompt_id) != judgment["prompt"]:
            raise EvaluationError("relevance judgment requires matching promptId provenance")
        fixture_label, semantic_id = judgment.get("fixtureLabel"), judgment.get("semanticId")
        if not isinstance(fixture_label, str) and not isinstance(semantic_id, str):
            raise EvaluationError("relevance judgment requires fixtureLabel or semanticId provenance")
        if semantic_id is not None and (not isinstance(semantic_id, str) or len(semantic_id) != 64 or
                                        any(char not in "0123456789abcdef" for char in semantic_id)):
            raise EvaluationError("relevance judgment semanticId provenance must be a canonical hash")
        relevance = judgment.get("ordinalRelevance")
        if isinstance(relevance, bool) or not isinstance(relevance, int) or not 0 <= relevance <= 3:
            raise EvaluationError("relevance judgment ordinalRelevance must be an integer from 0 to 3")
        proposed = judgment.get("status") == "proposed" and judgment.get("reviewStatus") == "unreviewed"
        reviewed = judgment.get("status") == "reviewed" and judgment.get("reviewStatus") == "reviewed"
        if not proposed and not reviewed:
            raise EvaluationError("relevance judgment status must be proposed/unreviewed or reviewed/reviewed")
        if reviewed and (not isinstance(judgment.get("reviewer"), str) or not judgment["reviewer"].strip() or
                         not _valid_reviewed_at(judgment.get("reviewedAt"))):
            raise EvaluationError("reviewed relevance judgment requires nonempty reviewer and valid reviewedAt timestamp")
        if require_reviewed and not reviewed:
            raise EvaluationError("reviewed relevance judgments are required for final acceptance")


def _synth_audio(generator: str, seed: int, frames: int = 48_000) -> np.ndarray:
    """Return deterministic mono float32 audio without writing audio to git."""
    rng = np.random.default_rng(seed)
    t = np.arange(frames, dtype=np.float32) / 48_000.0
    if generator == "tone":
        audio = 0.35 * np.sin(2 * np.pi * (55 + seed % 700) * t)
    elif generator == "noise":
        audio = (rng.standard_normal(frames).astype(np.float32) * np.exp(-2.0 * t) * 0.15)
    elif generator == "chirp":
        start, end = 120 + seed % 300, 800 + seed % 1_800
        audio = 0.3 * np.sin(2 * np.pi * (start * t + (end - start) * t * t / 2))
    elif generator == "percussive":
        audio = np.zeros(frames, dtype=np.float32)
        for onset in range(0, frames, 6_000 + seed % 1_200):
            length = min(2_400, frames - onset)
            envelope = np.exp(-np.arange(length, dtype=np.float32) / 500)
            audio[onset:onset + length] += rng.standard_normal(length).astype(np.float32) * envelope * 0.45
    else:
        raise EvaluationError(f"unknown synthetic generator {generator!r}")
    return np.asarray(audio, dtype="<f4")


def synthetic_audio_fixtures(ground: GroundProvenance | None = None) -> list[dict[str, object]]:
    """At least forty source-distinct local synthetic regions, stable across runs."""
    fixtures: list[dict[str, object]] = []
    ground = ground or test_ground_provenance()
    generators = ("tone", "noise", "chirp", "percussive")
    for index in range(48):
        generator = generators[index % len(generators)]
        seed = 49_700 + index * 101
        frames = _synth_audio(generator, seed)
        raw_hash = hashlib.sha256(frames.tobytes()).hexdigest()
        label = f"synthetic-{generator}-{index:02d}"
        identity = SemanticIdentity(
            sample_id=f"synthetic-sample-{index:02d}", recording_id=f"synthetic-recording-{index:02d}",
            kind="window", clip_id=None, start=0.0, end=1.0, audio_sha256=raw_hash,
            embedding_space=ground.embedding_space, processing_fingerprint=ground.processing_fingerprint,
        )
        fixtures.append({
            "fixtureLabel": label,
            "semanticId": identity.semantic_id,
            "sampleId": identity.sample_id,
            "recordingId": identity.recording_id,
            "kind": identity.kind,
            "start": identity.start,
            "end": identity.end,
            "processingFingerprint": identity.processing_fingerprint,
            "generator": generator,
            "seed": seed,
            "sampleRate": 48_000,
            "rawFrameCount": int(frames.size),
            "rawFramesSha256": raw_hash,
            "sourceAudioSha256": raw_hash,
        })
    return fixtures


def test_ground_provenance() -> GroundProvenance:
    """Only for model-free unit tests; never used by the CLI's generate path."""
    return GroundProvenance("test-fingerprint", PREPROCESSING_VERSION, EMBEDDING_SPACE, CHECKPOINT_REVISION,
                            {"transformers": "test", "torch": "test", "numpy": "test", "soxr": "test"})


def accepted_ground_provenance() -> GroundProvenance:
    """Require the exact handoff API before any local model is loaded."""
    if os.environ.get("APRICITY_GROUND_HANDOFF_ACCEPTED") != "1":
        raise GroundHandoffError("ground handoff unavailable: supervisor acceptance is required")
    from . import clap

    required = ("processing_fingerprint", "PREPROCESSING_VERSION", "EMBEDDING_SPACE", "CHECKPOINT_REVISION")
    missing = [name for name in required if not hasattr(clap, name)]
    if missing:
        raise GroundHandoffError("ground handoff unavailable: missing " + ", ".join(missing))
    provenance = GroundProvenance(
        processing_fingerprint=clap.processing_fingerprint(),
        preprocessing_version=clap.PREPROCESSING_VERSION,
        embedding_space=clap.EMBEDDING_SPACE,
        checkpoint_revision=clap.CHECKPOINT_REVISION,
        installed_versions={name: importlib.metadata.version(name) for name in ("transformers", "torch", "numpy", "soxr")},
    )
    if provenance.preprocessing_version != PREPROCESSING_VERSION:
        raise GroundHandoffError("ground handoff preprocessing version is not the accepted version")
    if provenance.embedding_space != EMBEDDING_SPACE or provenance.checkpoint_revision != CHECKPOINT_REVISION:
        raise GroundHandoffError("ground handoff model identity is not the accepted pinned checkpoint")
    if not provenance.processing_fingerprint:
        raise GroundHandoffError("ground handoff returned an empty processing fingerprint")
    return provenance


def _normalized(vector: Iterable[object]) -> list[float]:
    try:
        return list(normalize_vector(vector))
    except SemanticContractError as error:
        raise EvaluationError(str(error)) from error


def _validated(vector: Iterable[object]) -> tuple[float, ...]:
    try:
        return validate_vector(vector)
    except SemanticContractError as error:
        raise EvaluationError(str(error)) from error


def _validate_fixture_identity(fixture: dict[str, object], ground: GroundProvenance) -> str:
    """Reject readable labels or stale provenance where a canonical ID is required."""
    try:
        identity = SemanticIdentity(
            sample_id=str(fixture["sampleId"]), recording_id=str(fixture["recordingId"]),
            kind=fixture["kind"], clip_id=None, start=fixture["start"], end=fixture["end"],
            audio_sha256=str(fixture["sourceAudioSha256"]), embedding_space=ground.embedding_space,
            processing_fingerprint=str(fixture["processingFingerprint"]),
        )
    except (KeyError, SemanticContractError) as error:
        raise EvaluationError(f"audio fixture has invalid canonical identity provenance: {error}") from error
    if identity.kind != "window" or identity.start != 0.0 or identity.end != 1.0:
        raise EvaluationError("evaluation audio fixtures must be canonical window identities for [0,1)")
    if identity.processing_fingerprint != ground.processing_fingerprint:
        raise EvaluationError("audio fixture processingFingerprint does not match ground provenance")
    if fixture.get("semanticId") != identity.semantic_id:
        raise EvaluationError("audio fixture semanticId is not its canonical SemanticIdentity hash")
    return identity.semantic_id


def reference_from_vectors(*, prompts: Sequence[str], text_vectors: Sequence[Iterable[object]],
                           audio_fixtures: Sequence[dict[str, object]], audio_vectors: Sequence[Iterable[object]],
                           ground: GroundProvenance,
                           judgments: Sequence[dict[str, object]] | None = None) -> dict[str, object]:
    if tuple(prompts) != FIXED_PROMPTS or len(text_vectors) != len(FIXED_PROMPTS):
        raise EvaluationError("reference must contain exactly the fixed six prompts")
    if len(audio_fixtures) < 40 or len(audio_vectors) != len(audio_fixtures):
        raise EvaluationError("reference must contain at least forty audio candidates")
    audio = []
    for fixture, vector in zip(audio_fixtures, audio_vectors, strict=True):
        semantic_id = _validate_fixture_identity(fixture, ground)
        audio.append({"semanticId": semantic_id, "vector512": _normalized(vector)})
    fixture_ids = {str(fixture["fixtureLabel"]): str(fixture["semanticId"]) for fixture in audio_fixtures
                   if isinstance(fixture.get("fixtureLabel"), str) and isinstance(fixture.get("semanticId"), str)}
    if len(fixture_ids) != len(audio_fixtures):
        raise EvaluationError("audio fixtures require unique fixtureLabel and canonical semanticId")
    source_judgments = list(judgments) if judgments is not None else load_judgments()
    _validate_judgments(source_judgments, prompts, require_reviewed=False)
    resolved_judgments = []
    for judgment in source_judgments:
        resolved = dict(judgment)
        label = resolved.get("fixtureLabel")
        if isinstance(label, str):
            if label not in fixture_ids:
                raise EvaluationError("relevance judgment fixtureLabel is absent from exported audio")
            if resolved.get("semanticId") not in (None, fixture_ids[label]):
                raise EvaluationError("relevance judgment semanticId does not match fixtureLabel provenance")
            resolved["semanticId"] = fixture_ids[label]
        resolved_judgments.append(resolved)
    metadata = {
        "referenceVersion": REFERENCE_VERSION,
        "checkpoint": CHECKPOINT,
        "checkpointRevision": ground.checkpoint_revision,
        "preprocessingVersion": ground.preprocessing_version,
        "processingFingerprint": ground.processing_fingerprint,
        "installedVersions": ground.installed_versions,
        "audioFixtures": list(audio_fixtures),
        "fixtureLabelToSemanticId": fixture_ids,
        "semanticIdToFixtureLabel": {semantic_id: label for label, semantic_id in fixture_ids.items()},
        "judgments": resolved_judgments,
    }
    return {"schemaVersion": 1, "embeddingSpace": ground.embedding_space,
            "prompts": [{"text": text, "vector512": _normalized(vector)} for text, vector in zip(prompts, text_vectors, strict=True)],
            "audio": audio, "metadata": metadata}


def export_reference(output: Path, *, prompts: Sequence[str], audio_fixtures: Sequence[dict[str, object]],
                     text_encoder: Callable[[Sequence[str]], Sequence[Iterable[object]]],
                     audio_encoder: Callable[[Sequence[dict[str, object]]], Sequence[Iterable[object]]],
                     ground: GroundProvenance) -> dict[str, object]:
    reference = reference_from_vectors(prompts=prompts, text_vectors=text_encoder(prompts), audio_fixtures=audio_fixtures,
                                       audio_vectors=audio_encoder(audio_fixtures), ground=ground)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(reference, indent=2, sort_keys=True) + "\n")
    return reference


def generate_local_reference(output: Path) -> dict[str, object]:
    """Explicit, handoff-gated real local CLAP generation; never called by unit tests."""
    ground = accepted_ground_provenance()
    from . import clap
    fixtures = synthetic_audio_fixtures(ground)
    waves = [_synth_audio(str(item["generator"]), int(item["seed"])) for item in fixtures]
    first_audio = clap.embed_audio_batch(waves, 48_000)
    repeated_audio = clap.embed_audio_batch(waves, 48_000)
    repeated_analysis = evaluate_repeated_audio_equivalence(first_audio, repeated_audio)
    if repeated_analysis["state"] != "passed":
        raise EvaluationGateFailed("repeated audio analysis equivalence failed", repeated_analysis)
    reference = reference_from_vectors(prompts=load_prompts(), text_vectors=clap.embed_text_batch(load_prompts()),
                                       audio_fixtures=fixtures, audio_vectors=first_audio, ground=ground)
    reference["metadata"]["repeatedAnalysis"] = repeated_analysis  # type: ignore[index]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(reference, indent=2, sort_keys=True) + "\n")
    return reference


def evaluate_repeated_audio_equivalence(first: Sequence[Iterable[object]], repeated: Sequence[Iterable[object]]) -> dict[str, object]:
    """Measure numeric repeatability independently of browser cosine parity."""
    if len(first) != len(repeated):
        raise EvaluationError("repeated audio analysis returned a different number of vectors")
    vectors = []
    for index, (original, retry) in enumerate(zip(first, repeated, strict=True)):
        original_array = np.asarray(tuple(original), dtype=float)
        retry_array = np.asarray(tuple(retry), dtype=float)
        if original_array.shape != retry_array.shape:
            raise EvaluationError("repeated audio analysis returned vectors with different dimensions")
        _validated(original_array)
        _validated(retry_array)
        delta = float(np.max(np.abs(original_array - retry_array)))
        cosine = float(np.dot(original_array, retry_array))
        equivalent = bool(np.allclose(original_array, retry_array, atol=1e-6, rtol=1e-5))
        vectors.append({"index": index, "equivalent": equivalent, "maxAbsDelta": delta, "cosine": cosine})
    return {"state": "passed" if all(row["equivalent"] for row in vectors) else "failed",
            "atol": 1e-6, "rtol": 1e-5, "vectors": vectors,
            "maxAbsDelta": max((float(row["maxAbsDelta"]) for row in vectors), default=0.0)}


def _reference_rows(reference: dict[str, object], key: str) -> list[dict[str, object]]:
    if reference.get("schemaVersion") != 1 or reference.get("embeddingSpace") != EMBEDDING_SPACE:
        raise EvaluationError("reference has an unsupported schema or embedding space")
    rows = reference.get(key)
    if not isinstance(rows, list):
        raise EvaluationError(f"reference {key} must be a list")
    for row in rows:
        if not isinstance(row, dict):
            raise EvaluationError(f"reference {key} contains an invalid row")
        _validated(row.get("vector512", ()))
    return rows


def _canonical_audio_vectors(rows: Sequence[dict[str, object]], corpus: str) -> dict[str, np.ndarray]:
    """Return a lossless ID-indexed corpus only after rejecting ambiguous IDs."""
    semantic_ids = [row.get("semanticId") for row in rows]
    canonical_ids = [
        semantic_id for semantic_id in semantic_ids
        if isinstance(semantic_id, str) and len(semantic_id) == 64
        and all(character in "0123456789abcdef" for character in semantic_id)
    ]
    if len(rows) < 40 or len(canonical_ids) != len(rows) or len(set(canonical_ids)) != len(rows):
        raise EvaluationError(f"{corpus} audio corpus requires at least forty unique canonical lowercase64hex semantic IDs")
    return {semantic_id: np.asarray(row["vector512"], dtype=float)
            for semantic_id, row in zip(canonical_ids, rows, strict=True)}


def _top_audio_ids(text_vector: np.ndarray, audio_by_id: dict[str, np.ndarray]) -> list[str]:
    """Rank deterministically, preserving score order and canonical-ID tie breaking."""
    scored = ((semantic_id, float(np.dot(text_vector, audio_vector)))
              for semantic_id, audio_vector in audio_by_id.items())
    return [semantic_id for semantic_id, _ in sorted(scored, key=lambda item: (-item[1], item[0]))[:20]]


def evaluate_browser_parity(python_reference: dict[str, object], browser_reference: dict[str, object]) -> dict[str, object]:
    python_prompts, browser_prompts = _reference_rows(python_reference, "prompts"), _reference_rows(browser_reference, "prompts")
    python_audio, browser_audio = _reference_rows(python_reference, "audio"), _reference_rows(browser_reference, "audio")
    if len(python_prompts) != 6 or [row.get("text") for row in python_prompts] != list(FIXED_PROMPTS) or [row.get("text") for row in browser_prompts] != list(FIXED_PROMPTS):
        raise EvaluationError("references must retain the exact fixed prompts")
    python_audio_by_id = _canonical_audio_vectors(python_audio, "Python")
    browser_audio_by_id = _canonical_audio_vectors(browser_audio, "browser")
    if python_audio_by_id.keys() != browser_audio_by_id.keys():
        raise EvaluationError("references must contain the same audio semantic IDs")
    for semantic_id, python_vector in python_audio_by_id.items():
        if not np.array_equal(python_vector, browser_audio_by_id[semantic_id]):
            raise EvaluationError("Python and browser references must retain exact same stored audio vectors by semantic ID")
    results = []
    for py, web in zip(python_prompts, browser_prompts, strict=True):
        py_vector, web_vector = np.asarray(py["vector512"], dtype=float), np.asarray(web["vector512"], dtype=float)
        cosine = float(np.dot(py_vector, web_vector))
        py_top = _top_audio_ids(py_vector, python_audio_by_id)
        web_top = _top_audio_ids(web_vector, browser_audio_by_id)
        results.append({"text": py["text"], "cosine": cosine, "top20Overlap": len(set(py_top) & set(web_top)) / 20,
                        "pythonTop20": py_top, "browserTop20": web_top})
    mean_overlap = sum(float(row["top20Overlap"]) for row in results) / len(results)
    passed = all(float(row["cosine"]) >= .98 for row in results) and mean_overlap >= .90
    return {"state": "passed" if passed else "failed", "embeddingSpace": EMBEDDING_SPACE,
            "prompts": results, "meanTop20Overlap": mean_overlap,
            "thresholds": {"cosine": .98, "meanTop20Overlap": .90}}


def not_evaluated_report(reasons: Sequence[str]) -> dict[str, object]:
    return {"state": "not_evaluated", "referenceVersion": REFERENCE_VERSION, "reasons": list(reasons),
            "requiredGates": {"cosine": .98, "meanTop20Overlap": .90, "desktopWarmP95Ms": 2_000, "mobileWarmP95Ms": 5_000}}


def evaluate_warm_measurement(path: Path, *, limit_ms: int, label: str) -> dict[str, object]:
    """Validate a measured (never fabricated) warm timing record and nearest-rank p95."""
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise EvaluationError(f"{label} warm measurement must be an object")
    timings = data.get("warmTimingsMs")
    if not all(isinstance(data.get(key), str) and data[key] for key in ("device", "browser", "runtime", "cacheState")) or not isinstance(timings, list) or not timings:
        raise EvaluationError(f"{label} warm measurement requires device/browser/runtime/cacheState and timings")
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in timings):
        raise EvaluationError(f"{label} warm measurement has invalid timings")
    ordered = sorted(float(value) for value in timings)
    p95 = ordered[math.ceil(.95 * len(ordered)) - 1]
    return {"state": "passed" if p95 <= limit_ms else "failed", "p95Ms": p95, "limitMs": limit_ms,
            "sampleCount": len(ordered), "device": data["device"], "browser": data["browser"],
            "runtime": data["runtime"], "cacheState": data["cacheState"]}
