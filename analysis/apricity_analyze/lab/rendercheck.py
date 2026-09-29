"""The measuring loop shared by `lab measure` and `lab try`: render a score's window with
`--stems`, run `apricity check --json` and `apricity steer --score`, and hand back the numbers.
Thin over the Rust CLI on purpose -- Harmony v2's chord recognition, Q and steering suggestions
live there, not in Python (see `schema/steer.schema.json`).
"""

from __future__ import annotations

import dataclasses
import json
import pathlib
import subprocess

from .context import LabContext


class MeasureError(RuntimeError):
    pass


def _run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    proc = subprocess.run(argv, capture_output=True, text=True, **kwargs)
    return proc


def bars_arg(bars: tuple[int, int] | None) -> list[str]:
    return ["--bars", f"{bars[0]}-{bars[1]}"] if bars else []


@dataclasses.dataclass
class Measurement:
    score: pathlib.Path
    bars: tuple[int, int] | None
    stems_dir: pathlib.Path
    check: dict
    steer: dict

    @property
    def objective_v2(self) -> float:
        return self.check["objective_v2"]

    @property
    def objective_v1(self) -> float:
        return self.check["objective"]

    def to_json(self) -> dict:
        return {
            "score": str(self.score),
            "bars": list(self.bars) if self.bars else None,
            "objective": self.objective_v1,
            "objective_v2": self.objective_v2,
            "q_mean": self.check.get("q_mean"),
            "guard_violations": self.check.get("guard_violations", []),
            "spans": self.check.get("spans", []),
            "steer_spans": self.steer.get("spans", []),
            "suggestions": self.steer.get("suggestions", []),
        }


def render_and_measure(ctx: LabContext, score: pathlib.Path, work_dir: pathlib.Path, *,
                        bars: tuple[int, int] | None = None, baseline: pathlib.Path | None = None) -> Measurement:
    """Renders `score` (the given bars window, or the whole thing) with `--stems` into `work_dir`,
    then runs `apricity check --json` and `apricity steer --json --score` on the result. Raises
    `MeasureError` with the tool's own stderr on any failure."""
    score = score.resolve()
    stems_dir = work_dir / "stems"
    wav_path = work_dir / "render.wav"

    render_argv = [str(ctx.binary), "render", str(score), "-o", str(wav_path), "--stems", str(stems_dir)]
    render_argv += bars_arg(bars)
    proc = _run(render_argv, cwd=str(score.parent))
    if proc.returncode != 0:
        raise MeasureError(f"render failed: {proc.stderr.strip()[-4000:]}")

    check_argv = [str(ctx.binary), "check", str(stems_dir), "--json"]
    if baseline is not None:
        check_argv += ["--baseline", str(baseline)]
    proc = _run(check_argv)
    if proc.returncode != 0:
        raise MeasureError(f"apricity check failed: {proc.stderr.strip()[-4000:]}")
    check_report = json.loads(proc.stdout)

    steer_argv = [str(ctx.binary), "steer", str(stems_dir), "--score", str(score)]
    proc = _run(steer_argv)
    if proc.returncode != 0:
        raise MeasureError(f"apricity steer failed: {proc.stderr.strip()[-4000:]}")
    steer_report = json.loads(proc.stdout)

    return Measurement(score=score, bars=bars, stems_dir=stems_dir, check=check_report, steer=steer_report)


def to_m4a(wav_path: pathlib.Path, out_path: pathlib.Path) -> str | None:
    """`afconvert` (macOS) to a small AAC copy, matching `audition.sh`/the audition form. Returns
    an error string on failure, or `None` on success."""
    try:
        proc = subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", "-b", "192000", str(wav_path), str(out_path)],
            capture_output=True, text=True, timeout=120,
        )
        return None if proc.returncode == 0 else proc.stderr.strip()[-1000:]
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return str(e)
