"""`apricity steer`'s output validates against `schema/steer.schema.json` (Kanbus
apricitus-c46688). Renders a small `--bars --stems` window of `examples/ave-emerge.apr`, runs
`apricity steer` on it, validates the result, then deletes the render (no audio in git, and
renders aren't kept on disk between test runs)."""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess

import jsonschema
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
# `CARGO_TARGET_DIR` is set to the main checkout's `target/` for every build in this repo's
# worktrees (disk is shared and tight -- see CONTRIBUTING_AGENT.md/AGENTS.md), so the binary
# doesn't necessarily live under this worktree's own `target/`; check both.
BIN = next((p for p in (ROOT / "target/debug/apricity", pathlib.Path("/Users/home/Projects/Apricity/target/debug/apricity")) if p.exists()), ROOT / "target/debug/apricity")
SCHEMA_PATH = ROOT / "schema/steer.schema.json"
SCORE = ROOT / "examples/ave-emerge.apr"
NEEDED_SAMPLES = [
    ROOT / "samples/ccmixter/AlexBeroza/Ave_34409.mp3",
    ROOT / "samples/ccmixter/AlexBeroza/Emerge_30132.mp3",
    ROOT / "samples/salamander-drumkit/OH/kick_OH_F_1.wav",
    ROOT / "samples/salamander-drumkit/OH/snare_OH_F_1.wav",
    ROOT / "samples/salamander-drumkit/OH/hihatOpen_OH_F_1.wav",
    ROOT / "samples/salamander-drumkit/OH/crash1_OH_FF_1.wav",
]

pytestmark = [
    pytest.mark.skipif(not BIN.exists(), reason="apricity binary not built (cargo build -p apricity-cli)"),
    pytest.mark.skipif(any(not p.exists() for p in NEEDED_SAMPLES), reason="Emerge/Ave/drum samples not symlinked into samples/"),
]


def test_steer_output_validates_against_the_schema(tmp_path):
    stems_dir = tmp_path / "stems"
    mix = tmp_path / "mix.wav"
    r = subprocess.run(
        [str(BIN), "render", str(SCORE), "--out", str(mix), "--bars", "33-40", "--stems", str(stems_dir)],
        capture_output=True, text=True, cwd=ROOT,
    )
    assert r.returncode == 0, r.stderr

    out_path = tmp_path / "steer.json"
    r = subprocess.run(
        [str(BIN), "steer", str(stems_dir), "--score", str(SCORE), "-o", str(out_path)],
        capture_output=True, text=True, cwd=ROOT,
    )
    assert r.returncode == 0, r.stderr

    report = json.loads(out_path.read_text())
    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.validate(report, schema)  # raises on any violation

    assert report["schema"] == "apricity.steer/1"
    assert len(report["spans"]) == 4
    # The Emerge fixture's own top finding (spec-harmony-v2.md sec 3.5 step 1): the bright loop's
    # own A-minor notes over the VII span's G bass read better at shift 0 than the solver's -5.
    top = report["suggestions"][0]
    assert top["op"] == "track.transpose_span"
    assert top["track"] == "bright"
    assert top["value"] == 0
    assert tuple(top["bars"]) == (39.0, 41.0)


def test_check_and_steer_agree_on_which_span_is_weakest(tmp_path):
    """A cheap parity check against `apricity check` on the same render: the span `steer` marks
    least-fit should be the one `check` gives the lowest `Q` (both read the same underlying
    `objective_v2_for_span` result -- `check.rs` and `steer.rs` just present it differently)."""
    stems_dir = tmp_path / "stems"
    mix = tmp_path / "mix.wav"
    subprocess.run([str(BIN), "render", str(SCORE), "--out", str(mix), "--bars", "33-40", "--stems", str(stems_dir)], check=True, cwd=ROOT, capture_output=True)

    check_out = subprocess.run([str(BIN), "check", str(stems_dir), "--json"], capture_output=True, text=True, cwd=ROOT, check=True).stdout
    steer_out = subprocess.run([str(BIN), "steer", str(stems_dir)], capture_output=True, text=True, cwd=ROOT, check=True).stdout

    check_report = json.loads(check_out)
    steer_report = json.loads(steer_out)

    weakest_check = min(check_report["spans"], key=lambda s: s["Q"])["label"]
    weakest_steer = min(steer_report["spans"], key=lambda s: s["Q"]["Q"])["label"]
    assert weakest_check == weakest_steer


@pytest.fixture(autouse=True, scope="module")
def _no_leftover_renders():
    """Belt and suspenders: `tmp_path` is pytest's own temp dir and is cleaned up on its own, but
    this guards against a stray `renders/` this test might otherwise leave in the repo root."""
    yield
    stray = ROOT / "renders" / "_steer_schema_test"
    if stray.exists():
        shutil.rmtree(stray)
