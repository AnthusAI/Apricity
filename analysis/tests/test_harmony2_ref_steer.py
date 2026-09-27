"""`apricity_analyze.harmony2_ref.build_steer_report` (Kanbus apricitus-c46688, Harmony v2 Phase 1
Task 6's Python side). Renders a small `--bars --stems` window of `examples/ave-emerge.apr` (real
audio; skips when the sample library isn't checked out, same convention as
`tests/fixtures/harmony2/emerge_fixture.py`) and checks the report's shape and its agreement with
`apricity check`/`apricity steer` (the Rust port) on the same render.

Regression coverage for a real bug this task's own development caught: `build_steer_report`
zipped `analyze_stems_dir`'s already-window-filtered spans against the FULL, unfiltered
`manifest["harmony"]` list, so every span's `a`/`b` (beat offsets into the window) were computed
from the wrong span and came out negative -- `wrong_notes` and `transposition_map` were silently
empty for every span. Fixed by filtering `manifest["harmony"]` the same way before zipping.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

import pytest

from apricity_analyze import harmony2_ref as h2

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = next((p for p in (REPO_ROOT / "target/debug/apricity", pathlib.Path("/Users/home/Projects/Apricity/target/debug/apricity")) if p.exists()), REPO_ROOT / "target/debug/apricity")
SCORE = REPO_ROOT / "examples/ave-emerge.apr"
NEEDED_SAMPLES = [
    REPO_ROOT / "samples/ccmixter/AlexBeroza/Ave_34409.mp3",
    REPO_ROOT / "samples/ccmixter/AlexBeroza/Emerge_30132.mp3",
]

pytestmark = [
    pytest.mark.skipif(not BIN.exists(), reason="apricity binary not built (cargo build -p apricity-cli)"),
    pytest.mark.skipif(any(not p.exists() for p in NEEDED_SAMPLES), reason="Emerge/Ave samples not symlinked into samples/"),
]


@pytest.fixture(scope="module")
def stems_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("steer_ref")
    mix = d / "mix.wav"
    stems = d / "stems"
    r = subprocess.run([str(BIN), "render", str(SCORE), "--out", str(mix), "--bars", "33-40", "--stems", str(stems)], capture_output=True, text=True, cwd=REPO_ROOT)
    assert r.returncode == 0, r.stderr
    return stems


def test_every_span_gets_a_nonempty_beat_window(stems_dir):
    """The regression: before the fix, every span's `a`/`b` came from the wrong (unfiltered) list
    entry and `b <= a`, so wrong_notes/transposition_map were empty for every span even though the
    loop stem clearly has audio in every span."""
    report = h2.build_steer_report(stems_dir, against="written")
    assert len(report["spans"]) == 4
    for span in report["spans"]:
        # `bright` is the one loop stem in this fixture; it should get a transposition map entry
        # in every span (it has audio throughout the window).
        assert "bright" in span["transposition_map"], f"{span['label']}: empty transposition_map (the windowing regression)"
        assert len(span["transposition_map"]["bright"]) == 12


def test_report_agrees_with_the_rust_cli_on_q_and_weakest_span(stems_dir):
    report = h2.build_steer_report(stems_dir, against="written")
    check_out = subprocess.run([str(BIN), "check", str(stems_dir), "--json"], capture_output=True, text=True, cwd=REPO_ROOT, check=True).stdout
    check_report = json.loads(check_out)

    py_by_label = {s["label"]: s["Q"]["Q"] for s in report["spans"]}
    rs_by_label = {s["label"]: s["Q"] for s in check_report["spans"]}
    assert set(py_by_label) == set(rs_by_label)
    for label, py_q in py_by_label.items():
        assert abs(py_q - rs_by_label[label]) < 1e-3, f"{label}: Q drifted between the Python reference ({py_q}) and the Rust port ({rs_by_label[label]})"

    weakest_py = min(report["spans"], key=lambda s: s["Q"]["Q"])["label"]
    weakest_rs = min(check_report["spans"], key=lambda s: s["Q"])["label"]
    assert weakest_py == weakest_rs == "VII (G)"


def test_suggestions_include_the_eq_notch_and_retune_rows(stems_dir):
    """`build_steer_report` doesn't have the Rust solver's per-span chosen shift (only the CLI's
    `--score` path does, sec 3.2's docstring on `steer_suggestions`), so it can't emit
    `track.transpose_span`; it should still emit the `track.eq_notch` and `clip.retune` rows the
    Rust CLI also finds on this fixture."""
    report = h2.build_steer_report(stems_dir, against="written")
    ops = {s["op"] for s in report["suggestions"]}
    assert "track.eq_notch" in ops
    assert "clip.retune" in ops
    retune = next(s for s in report["suggestions"] if s["op"] == "clip.retune")
    assert retune["clip"] == "low"
    assert abs(retune["cents"]) > h2.TUNING_CORRECTION_THRESHOLD_CENTS
