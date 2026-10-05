"""Regression contract for semantic-audio coverage in ordinary CI."""
from __future__ import annotations

import shlex
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
PACKAGE = ROOT / "web" / "package.json"
REQUIREMENTS = ROOT / "analysis" / "requirements-semantic-tests.txt"

CLUSTERING_PINS = {
    "umap-learn": "0.5.12",
    "hdbscan": "0.8.44",
    "numpy": "2.2.6",
    "scipy": "1.18.1",
    "scikit-learn": "1.9.1",
    "numba": "0.67.0",
    "pynndescent": "0.6.0",
}


def test_board_only_pushes_do_not_replace_product_ci_and_other_triggers_remain():
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf8"))
    triggers = workflow.get("on", workflow.get(True))
    assert triggers["push"] == {
        "branches": ["develop", "main"],
        "paths-ignore": ["project/issues/**", "project/events/**"],
    }
    assert triggers["pull_request"] == {"branches": ["develop", "main"]}
    assert "workflow_dispatch" in triggers
    assert workflow["concurrency"] == {
        "group": "ci-${{ github.ref }}", "cancel-in-progress": True,
    }

PYTHON_TESTS = (
    "analysis/tests/test_semantic_contract.py",
    "analysis/tests/test_semantic_freshness.py",
    "analysis/tests/test_semantic_records.py",
    "analysis/tests/test_semantic_publisher.py",
    "analysis/tests/test_semantic_backfill.py",
    "analysis/tests/test_semantic_catalog.py",
    "analysis/tests/test_semantic_evaluation.py",
    "analysis/tests/test_cluster_corpus.py",
    "analysis/tests/test_audio_clusters.py",
    "analysis/tests/test_cluster_summaries.py",
    "analysis/tests/test_cluster_runs.py",
    "analysis/tests/test_cluster_jobs.py",
    "analysis/tests/test_cluster_publication.py",
    "analysis/tests/test_semantic_ci.py",
)


def _requirements() -> dict[str, str]:
    requirements: dict[str, str] = {}
    for line in REQUIREMENTS.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, version = line.split("==", 1)
        requirements[name] = version
    return requirements


def _semantic_typescript_tests() -> set[str]:
    paths = set((ROOT / "web" / "test").rglob("semantic-*.test.ts"))
    paths.update((ROOT / "web" / "amplify" / "semantic").glob("*.test.ts"))
    return {path.relative_to(ROOT / "web").as_posix() for path in paths}


def test_semantic_ci_has_explicit_test_lists_and_pinned_isolated_dependencies():
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf8"))
    semantic_job = workflow["jobs"]["semantic-ground"]
    assert semantic_job["runs-on"] == "ubuntu-latest"
    assert any(step.get("with", {}).get("python-version") == "3.12" for step in semantic_job["steps"])

    commands = "\n".join(str(step.get("run", "")) for step in semantic_job["steps"])
    assert 'semantic_venv="$(mktemp -d)/venv"' in commands
    assert 'python -m venv "$semantic_venv"' in commands
    assert '"$semantic_venv/bin/python" -m pip install -r analysis/requirements-semantic-tests.txt' in commands
    assert 'PYTHONPATH=analysis "$semantic_venv/bin/python" -m pytest' in commands
    assert "analysis/.venv" not in commands
    for test in PYTHON_TESTS:
        assert test in commands
    assert "test_semantic*.py" not in commands
    assert "test_cluster*.py" not in commands

    requirements = _requirements()
    assert {name: requirements.get(name) for name in CLUSTERING_PINS} == CLUSTERING_PINS
    assert {"pytest", "jsonschema", "soundfile", "PyYAML"} <= requirements.keys()
    assert not {"soxr", "torch", "transformers", "huggingface-hub"} & requirements.keys()
    assert all("==" in line for line in REQUIREMENTS.read_text(encoding="utf8").splitlines() if line and not line.startswith("#"))

    package = __import__("json").loads(PACKAGE.read_text(encoding="utf8"))
    semantic_command = package["scripts"]["test:semantic"]
    assert "*" not in semantic_command
    tokens = shlex.split(semantic_command)
    assert tokens[:2] == ["tsx", "--test"]
    assert set(tokens[2:]) == _semantic_typescript_tests()
    assert "amplify/semantic/canonical.test.ts" in tokens
    assert "amplify/semantic/resource.test.ts" in tokens
    assert "amplify/semantic/search-service.test.ts" in tokens

    web_commands = "\n".join(str(step.get("run", "")) for step in workflow["jobs"]["web"]["steps"])
    assert "npx tsc --noEmit" in web_commands
    assert "npx tsc --noEmit --project amplify/tsconfig.json" in web_commands
    assert "npm run test:semantic" in web_commands
    assert "npx npm run test:semantic" not in web_commands
