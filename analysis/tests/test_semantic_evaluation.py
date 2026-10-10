"""Observable scaffold tests for the semantic-audio relevance corpus."""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import numpy as np
import pytest

from apricity_analyze import semantic_evaluation as evaluation


ROOT = pathlib.Path(__file__).resolve().parents[2]
PROMPTS = ROOT / "fixtures" / "semantic-audio" / "evaluation-prompts.json"
JUDGMENTS = ROOT / "fixtures" / "semantic-audio" / "evaluation-judgments.json"
SCRIPT = ROOT / "scripts" / "semantic-eval-reference.py"


def unit(index: int) -> np.ndarray:
    vector = np.zeros(512, dtype=np.float32)
    vector[index] = 1.0
    return vector


def test_fixed_prompts_synthetic_catalog_and_unreviewed_judgments_are_deterministic():
    prompts = evaluation.load_prompts(PROMPTS)
    judgments = evaluation.load_judgments(JUDGMENTS, prompts)
    fixtures = evaluation.synthetic_audio_fixtures()

    assert prompts == evaluation.FIXED_PROMPTS
    assert len(fixtures) >= 40
    assert len({fixture["semanticId"] for fixture in fixtures}) == len(fixtures)
    assert all(len(fixture["semanticId"]) == 64 for fixture in fixtures)
    assert all(fixture["fixtureLabel"].startswith("synthetic-") for fixture in fixtures)
    assert len({fixture["rawFramesSha256"] for fixture in fixtures}) == len(fixtures)
    assert {fixture["generator"] for fixture in fixtures} >= {"tone", "noise", "chirp", "percussive"}
    assert all(judgment["status"] == "proposed" for judgment in judgments)
    assert all(judgment["reviewStatus"] == "unreviewed" for judgment in judgments)
    assert all(judgment["promptId"] in evaluation.FIXED_PROMPT_IDS for judgment in judgments)
    assert all("fixtureLabel" in judgment for judgment in judgments)


def test_invalid_prompt_fixture_is_rejected(tmp_path):
    invalid = tmp_path / "prompts.json"
    invalid.write_text(json.dumps({"prompts": list(evaluation.FIXED_PROMPTS[:-1]) + ["metal sound"]}))

    with pytest.raises(evaluation.EvaluationError, match="fixed six"):
        evaluation.load_prompts(invalid)


def test_exporter_normalizes_mocked_projected_vectors_and_has_exact_provenance(tmp_path):
    fixtures = evaluation.synthetic_audio_fixtures()[:40]
    output = tmp_path / "reference.json"

    reference = evaluation.export_reference(
        output,
        prompts=evaluation.FIXED_PROMPTS,
        audio_fixtures=fixtures,
        text_encoder=lambda values: [unit(index) * 3 for index, _ in enumerate(values)],
        audio_encoder=lambda values: [unit(index % 512) * 2 for index, _ in enumerate(values)],
        ground=evaluation.GroundProvenance(
            processing_fingerprint="test-fingerprint",
            preprocessing_version="clap-audio-center10s-v1",
            embedding_space=evaluation.EMBEDDING_SPACE,
            checkpoint_revision=evaluation.CHECKPOINT_REVISION,
            installed_versions={"transformers": "test", "torch": "test", "numpy": "test", "soxr": "test"},
        ),
    )

    assert output.exists()
    assert reference["schemaVersion"] == 1
    assert reference["embeddingSpace"] == evaluation.EMBEDDING_SPACE
    assert len(reference["prompts"]) == 6
    assert len(reference["audio"]) == 40
    assert all(np.isclose(np.linalg.norm(row["vector512"]), 1.0) for row in reference["prompts"] + reference["audio"])
    assert reference["metadata"]["referenceVersion"] == evaluation.REFERENCE_VERSION
    assert reference["metadata"]["audioFixtures"][0]["sourceAudioSha256"]
    assert reference["metadata"]["fixtureLabelToSemanticId"]
    assert reference["metadata"]["judgments"][0]["semanticId"] == reference["metadata"]["fixtureLabelToSemanticId"]["synthetic-percussive-03"]


def test_repeated_analysis_requires_allclose_not_browser_cosine_threshold():
    first = [unit(0)]
    drift = unit(0) * .99 + unit(1) * np.sqrt(1 - .99 ** 2)

    report = evaluation.evaluate_repeated_audio_equivalence(first, [drift])

    assert report["state"] == "failed"
    assert report["vectors"][0]["cosine"] == pytest.approx(.99)
    assert report["vectors"][0]["maxAbsDelta"] > 1e-6


def test_reviewed_judgments_require_reviewer_timestamp_and_provenance(tmp_path):
    reviewed = tmp_path / "reviewed.json"
    reviewed.write_text(json.dumps({"judgments": [{
        "prompt": evaluation.FIXED_PROMPTS[0], "promptId": "drums",
        "fixtureLabel": "synthetic-percussive-03", "semanticId": "a" * 64,
        "ordinalRelevance": 3, "status": "reviewed", "reviewStatus": "reviewed",
        "reviewer": "supervisor", "reviewedAt": "2026-09-30T12:00:00Z",
    }]}))
    assert evaluation.load_judgments(reviewed, require_reviewed=True)[0]["reviewer"] == "supervisor"

    invalid = json.loads(reviewed.read_text())
    invalid["judgments"][0]["reviewedAt"] = "not-a-timestamp"
    reviewed.write_text(json.dumps(invalid))
    with pytest.raises(evaluation.EvaluationError, match="reviewedAt"):
        evaluation.load_judgments(reviewed, require_reviewed=True)


def test_reference_validation_and_mocked_top20_evaluation_reject_bad_data(tmp_path):
    fixtures = evaluation.synthetic_audio_fixtures()[:40]
    reference = evaluation.reference_from_vectors(
        prompts=evaluation.FIXED_PROMPTS,
        text_vectors=[unit(index) for index in range(6)],
        audio_fixtures=fixtures,
        audio_vectors=[unit(index % 6) for index in range(40)],
        ground=evaluation.test_ground_provenance(),
    )
    browser = json.loads(json.dumps(reference))
    report = evaluation.evaluate_browser_parity(reference, browser)
    assert report["state"] == "passed"
    assert report["meanTop20Overlap"] == pytest.approx(1.0)

    browser["audio"][0]["vector512"] = [0.0] * 512
    with pytest.raises(evaluation.EvaluationError, match="near-zero"):
        evaluation.evaluate_browser_parity(reference, browser)


def test_browser_parity_rejects_duplicate_or_malformed_audio_semantic_ids_before_top20_scoring():
    fixtures = evaluation.synthetic_audio_fixtures()[:40]
    reference = evaluation.reference_from_vectors(
        prompts=evaluation.FIXED_PROMPTS,
        text_vectors=[unit(index) for index in range(6)],
        audio_fixtures=fixtures,
        audio_vectors=[unit(index % 6) for index in range(40)],
        ground=evaluation.test_ground_provenance(),
    )
    duplicate_ids = json.loads(json.dumps(reference))
    duplicate_ids["audio"][-1]["semanticId"] = duplicate_ids["audio"][0]["semanticId"]

    # Before the corpus preflight this kept 40 rows but collapsed to 39 map entries,
    # allowing the comparison to report a trivial top-20 match.
    with pytest.raises(evaluation.EvaluationError, match="unique canonical"):
        evaluation.evaluate_browser_parity(duplicate_ids, duplicate_ids)

    malformed_ids = json.loads(json.dumps(reference))
    malformed_ids["audio"][0]["semanticId"] = "A" * 64
    with pytest.raises(evaluation.EvaluationError, match="unique canonical"):
        evaluation.evaluate_browser_parity(reference, malformed_ids)


def test_browser_parity_rejects_changed_audio_vectors_and_ranks_by_score_then_id():
    fixtures = evaluation.synthetic_audio_fixtures()[:40]
    reference = evaluation.reference_from_vectors(
        prompts=evaluation.FIXED_PROMPTS,
        text_vectors=[unit(index) for index in range(6)],
        audio_fixtures=fixtures,
        audio_vectors=[unit(index % 6) for index in range(40)],
        ground=evaluation.test_ground_provenance(),
    )
    browser = json.loads(json.dumps(reference))
    browser["audio"][0]["vector512"] = unit(10).tolist()
    with pytest.raises(evaluation.EvaluationError, match="stored audio vectors"):
        evaluation.evaluate_browser_parity(reference, browser)

    report = evaluation.evaluate_browser_parity(reference, json.loads(json.dumps(reference)))
    expected_top20 = sorted(
        (row["semanticId"] for row in reference["audio"] if row["vector512"][0] == 1.0),
    )
    assert report["prompts"][0]["pythonTop20"][:len(expected_top20)] == expected_top20


def test_gate_reports_not_evaluated_and_nonzero_when_reference_or_ground_is_missing(tmp_path):
    output = tmp_path / "gate.json"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--output", str(output)],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    report = json.loads(output.read_text())
    assert report["state"] == "not_evaluated"
    assert "missing browser reference" in report["reasons"]


def test_final_acceptance_does_not_treat_unreviewed_fixture_proposals_as_approval(tmp_path):
    fixtures = evaluation.synthetic_audio_fixtures()[:40]
    reference = evaluation.reference_from_vectors(
        prompts=evaluation.FIXED_PROMPTS,
        text_vectors=[unit(index) for index in range(6)],
        audio_fixtures=fixtures,
        audio_vectors=[unit(index % 6) for index in range(40)],
        ground=evaluation.test_ground_provenance(),
    )
    reference_path = tmp_path / "python.json"
    browser_path = tmp_path / "browser.json"
    reference_path.write_text(json.dumps(reference))
    browser_path.write_text(json.dumps(reference))
    desktop = tmp_path / "desktop.json"
    mobile = tmp_path / "mobile.json"
    measurement = {"device": "test", "browser": "test", "runtime": "test", "cacheState": "warm", "warmTimingsMs": [1]}
    desktop.write_text(json.dumps(measurement))
    mobile.write_text(json.dumps(measurement))
    output = tmp_path / "gate.json"

    result = subprocess.run([sys.executable, str(SCRIPT), "--output", str(output),
                             "--python-reference", str(reference_path), "--browser-reference", str(browser_path),
                             "--desktop-measurement", str(desktop), "--mobile-measurement", str(mobile)],
                            cwd=ROOT, text=True, capture_output=True)

    assert result.returncode != 0
    report = json.loads(output.read_text())
    assert report["state"] == "not_evaluated"
    assert any("reviewed relevance judgments" in reason for reason in report["reasons"])


def test_final_acceptance_reports_a_measured_browser_gate_failure_not_not_evaluated(tmp_path):
    fixtures = evaluation.synthetic_audio_fixtures()[:40]
    reference = evaluation.reference_from_vectors(
        prompts=evaluation.FIXED_PROMPTS, text_vectors=[unit(index) for index in range(6)],
        audio_fixtures=fixtures, audio_vectors=[unit(index % 6) for index in range(40)],
        ground=evaluation.test_ground_provenance(),
    )
    browser = json.loads(json.dumps(reference))
    browser["prompts"][0]["vector512"] = unit(10).tolist()
    python_path, browser_path = tmp_path / "python.json", tmp_path / "browser.json"
    python_path.write_text(json.dumps(reference))
    browser_path.write_text(json.dumps(browser))
    judgments = tmp_path / "reviewed.json"
    judgments.write_text(json.dumps({"judgments": [{
        "prompt": evaluation.FIXED_PROMPTS[0], "promptId": "drums",
        "fixtureLabel": fixtures[3]["fixtureLabel"], "semanticId": fixtures[3]["semanticId"],
        "ordinalRelevance": 3, "status": "reviewed", "reviewStatus": "reviewed",
        "reviewer": "supervisor", "reviewedAt": "2026-09-30T12:00:00Z",
    }]}))
    measurement = {"device": "test", "browser": "test", "runtime": "test", "cacheState": "warm", "warmTimingsMs": [1]}
    desktop, mobile, output = tmp_path / "desktop.json", tmp_path / "mobile.json", tmp_path / "gate.json"
    desktop.write_text(json.dumps(measurement))
    mobile.write_text(json.dumps(measurement))

    result = subprocess.run([sys.executable, str(SCRIPT), "--output", str(output),
                             "--python-reference", str(python_path), "--browser-reference", str(browser_path),
                             "--judgments", str(judgments), "--desktop-measurement", str(desktop),
                             "--mobile-measurement", str(mobile)], cwd=ROOT, text=True, capture_output=True)

    assert result.returncode != 0
    assert json.loads(output.read_text())["state"] == "failed"


def test_generate_requires_ground_handoff_and_help_never_loads_model(tmp_path):
    help_result = subprocess.run([sys.executable, str(SCRIPT), "--help"], cwd=ROOT, text=True, capture_output=True)
    generated = subprocess.run(
        [sys.executable, str(SCRIPT), "--generate", "--output", str(tmp_path / "generated.json")],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )

    assert help_result.returncode == 0
    assert "--generate" in help_result.stdout
    assert generated.returncode != 0
    assert "ground handoff" in generated.stderr
