"""Run-level bookkeeping for an explore run.

    renders/explore/<run>/
      run.json            -- run metadata (role, workers, budgets, started)
      notebook.jsonl       -- every trial, accepted or not, appended (never rewritten)
      <exp-id>/
        experiment.json    -- base score sha + ordered ops + the pre-registered `explain`
                              prediction: an experiment is exactly reproducible from this file
        score.apr          -- the candidate's full score text
        check.json          -- the checker's full report for this experiment (when rendered)
      leaderboard.md
      best.apr
      best.m4a
"""

from __future__ import annotations

import itertools
import json
import pathlib
import subprocess
import time

from . import ops as ops_mod


class Notebook:
    def __init__(self, run_dir: pathlib.Path, meta: dict):
        self.run_dir = run_dir
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "run.json").write_text(json.dumps(meta, indent=1, default=str))
        self._log_path = run_dir / "notebook.jsonl"
        self._log_path.touch(exist_ok=True)
        self._exp_counter = itertools.count(1)

    def log(self, record: dict) -> None:
        """Append one trial record. Never rewrites or truncates the log -- a run that crashes
        halfway still leaves every trial up to that point on disk."""
        record = dict(record)
        record.setdefault("at", time.time())
        with self._log_path.open("a") as f:
            f.write(json.dumps(record, default=str) + "\n")

    def read_log(self) -> list[dict]:
        if not self._log_path.exists():
            return []
        return [json.loads(line) for line in self._log_path.read_text().splitlines() if line.strip()]

    def new_experiment_id(self, stage: str) -> str:
        return f"{stage}-{next(self._exp_counter):04d}"

    def save_experiment(self, exp_id: str, *, base_sha: str, ops_list: list[dict], predicted: str | None,
                         score_text: str, check_json: dict | None) -> pathlib.Path:
        d = self.run_dir / exp_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "experiment.json").write_text(json.dumps({
            "base_sha": base_sha,
            "ops": ops_list,
            "predicted": predicted,
            "description": [ops_mod.describe(o) for o in ops_list],
        }, indent=1))
        (d / "score.apr").write_text(score_text)
        if check_json is not None:
            (d / "check.json").write_text(json.dumps(check_json, indent=1, default=str))
        return d

    def write_leaderboard(self, rows: list[dict]) -> None:
        """`rows`: `{"label", "objective", "consonance", "attribution"}`, best first."""
        lines = ["| rank | objective | consonance | cast | attribution |", "|---|---|---|---|---|"]
        for i, r in enumerate(rows, 1):
            lines.append(f"| {i} | {r['objective']:.1f} | {r.get('consonance', 0.0):.1f} | {r['label']} | {r.get('attribution', '')} |")
        (self.run_dir / "leaderboard.md").write_text("\n".join(lines) + "\n")

    def finalize_best(self, score_text: str, wav_path: pathlib.Path | None) -> None:
        (self.run_dir / "best.apr").write_text(score_text)
        if not wav_path or not wav_path.exists():
            return
        m4a = self.run_dir / "best.m4a"
        try:
            r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path), "-c:a", "aac", "-b:a", "256k", str(m4a)],
                                capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                (self.run_dir / "best.m4a.error").write_text(r.stderr[-2000:])
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            (self.run_dir / "best.m4a.error").write_text(str(e))
