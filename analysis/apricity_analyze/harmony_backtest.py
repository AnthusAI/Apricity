"""Harmony v2 backtest harness (Kanbus `apricitus-85ebc7`, Task 7 of Harmony v2 Phase 1), as an
importable module -- moved out of `scripts/harmony-backtest.py`'s `main()` so `lab backtest` and
the script (now a thin wrapper) share one implementation.

Re-renders the windows behind a set of previously logged listening verdicts, runs `apricity
check` (chord recognition, `Q`, `objective_v1`/`objective_v2`) on each candidate, and reports
whether each objective's top pick agrees with what the listener actually preferred. Renders are
written to a scratch directory, checked, and deleted immediately after -- at most one candidate's
stems are ever on disk at a time.
"""

from __future__ import annotations

import dataclasses
import json
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
BACKTEST_SCORES = ROOT / "analysis" / "tests" / "fixtures" / "harmony2" / "backtest_scores"


@dataclasses.dataclass
class Candidate:
    name: str
    score: pathlib.Path
    stars: float | None = None  # the listener's rating, when logged as stars


@dataclasses.dataclass
class VerdictSet:
    """One backtest case: a set of candidates rendered over the same window, and which one (or
    more, tied) the listener actually preferred."""

    name: str
    bars: str
    candidates: list[Candidate]
    preferred: list[str]  # candidate name(s) the listener preferred (ties allowed)
    source: str  # where the verdict itself lives (never restated here as prose evidence)


# The two verdict sets the design's own validation identified as harmony-shaped (the others in
# `renders/log.jsonl` are about arrangement or instrumentation, not chord/register fit, or have no
# render on disk to re-check). See the Kanbus epic and `renders/log.jsonl` for the verdicts
# themselves -- this file only names which candidate rendered from which score.
def verdict_sets() -> list[VerdictSet]:
    d = BACKTEST_SCORES
    return [
        VerdictSet(
            name="lounge-bright-loop-swap",
            bars="33-40",
            candidates=[
                Candidate("1-absolutely-clear", d / "lounge-1-absolutely-clear.apr"),
                Candidate("2-come-up-for-air", d / "lounge-2-come-up-for-air.apr"),
                Candidate("3-emerge", d / "lounge-3-emerge.apr"),
                Candidate("4-stay-for-this-moment", d / "lounge-4-stay-for-this-moment.apr"),
            ],
            preferred=["3-emerge"],
            source="renders/log.jsonl (listen-note)",
        ),
        VerdictSet(
            name="c2-ave-bright",
            bars="33-40",
            candidates=[
                Candidate("aveloop2", d / "cycle2-aveloop2.apr", stars=2),
                Candidate("comeup", d / "cycle2-comeup.apr", stars=3),
                Candidate("csoul", d / "cycle2-csoul.apr", stars=3),
                Candidate("keep", d / "cycle2-keep.apr", stars=3),
            ],
            preferred=["keep"],
            source="renders/log.jsonl (ab-pair, cycle c2-ave-bright)",
        ),
    ]


def render_and_check(binary: pathlib.Path, score: pathlib.Path, bars: str, scratch: pathlib.Path) -> dict:
    """Renders `score --bars bars --stems scratch`, runs `apricity check --json` on it, and
    deletes `scratch` before returning. Raises on any failure (a missing score, a failed render,
    or a failed check) rather than silently skipping a candidate."""
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    try:
        proc = subprocess.run(
            [str(binary), "render", str(score), "--bars", bars, "--stems", str(scratch), "-o", str(scratch / "mix.wav")],
            cwd=str(score.parent), capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"render failed for {score.name}: {proc.stderr[-2000:]}")
        check = subprocess.run([str(binary), "check", str(scratch), "--json"], capture_output=True, text=True)
        if check.returncode != 0:
            raise RuntimeError(f"apricity check failed for {score.name}: {check.stderr[-2000:]}")
        return json.loads(check.stdout)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def run_backtest(binary: pathlib.Path, scratch_root: pathlib.Path) -> dict:
    """Runs every verdict set, returns `{"rows": [...], "sets": [{"name", "top_v1", "top_v2",
    "v1_agrees", "v2_agrees", "rows": [...]}], "agree_v1", "agree_v2", "total_sets"}`."""
    scratch_root.mkdir(parents=True, exist_ok=True)
    rows = []
    for vs in verdict_sets():
        for cand in vs.candidates:
            if not cand.score.exists():
                continue
            report = render_and_check(binary, cand.score, vs.bars, scratch_root / "current")
            rows.append({
                "verdict_set": vs.name, "candidate": cand.name, "stars": cand.stars,
                "objective_v1": report["objective"], "objective_v2": report["objective_v2"],
                "preferred": cand.name in vs.preferred, "source": vs.source,
            })
    shutil.rmtree(scratch_root, ignore_errors=True)

    sets = []
    agree_v1 = agree_v2 = total_sets = 0
    for vs in verdict_sets():
        set_rows = [r for r in rows if r["verdict_set"] == vs.name]
        if not set_rows:
            continue
        total_sets += 1
        top_v1 = max(set_rows, key=lambda r: r["objective_v1"])["candidate"]
        top_v2 = max(set_rows, key=lambda r: r["objective_v2"])["candidate"]
        v1_agrees = top_v1 in vs.preferred
        v2_agrees = top_v2 in vs.preferred
        agree_v1 += int(v1_agrees)
        agree_v2 += int(v2_agrees)
        sets.append({"name": vs.name, "rows": set_rows, "top_v1": top_v1, "top_v2": top_v2,
                      "v1_agrees": v1_agrees, "v2_agrees": v2_agrees})

    return {"rows": rows, "sets": sets, "agree_v1": agree_v1, "agree_v2": agree_v2, "total_sets": total_sets}
