"""Render (`apricity render --stems`, optionally `--bars`-restricted) and check one score's text,
with a cache keyed by the score's own sha256 (plus the bars range), and a small process pool for
evaluating many candidates at once. The render is a subprocess (the Rust binary); the check itself
runs in-process (`apricity_analyze.check`, already pure Python).
"""

from __future__ import annotations

import concurrent.futures
import dataclasses
import hashlib
import json
import pathlib
import re
import subprocess
import time

from .. import check as checker

ROOT = pathlib.Path(__file__).resolve().parents[3]
BIN = ROOT / "target/release/apricity"
RENDER_TIMEOUT_S = 300


@dataclasses.dataclass
class EvalResult:
    ok: bool
    objective: float = 0.0
    consonance: float = 0.0
    guard_violations: list = dataclasses.field(default_factory=list)
    report: dict | None = None
    error: str | None = None
    stems_dir: str | None = None
    seconds: float = 0.0
    cache_hit: bool = False

    def to_json(self) -> dict:
        return dataclasses.asdict(self)


def score_sha(text: str, bars: tuple[int, int] | None = None) -> str:
    """The cache key: the score text's own sha256, plus the bars range when this is a partial
    render (a different render range is a different render, not the same cached one)."""
    h = hashlib.sha256(text.encode())
    if bars:
        h.update(f"|bars:{bars[0]}-{bars[1]}".encode())
    return h.hexdigest()[:20]


def absolutize_samples(text: str) -> str:
    """Rewrite the score's `samples <path>` line to an absolute path, so a candidate written
    anywhere under `renders/` (not necessarily one directory below the repo root, like
    `examples/`) still resolves its clips correctly."""
    return re.sub(r"^samples\s+\S.*$", f"samples {ROOT / 'samples'}", text, count=1, flags=re.M)


class Evaluator:
    """Owns one search run's cache directory and its one shared baseline file. The *first* score
    evaluated in a run must be the incumbent (the outer/inner loops are responsible for this):
    that call writes `baseline.json` fresh (via `check.check`'s own write-if-missing behavior);
    every later call in the run reads that same file, so every candidate is judged against one
    fixed point of reference, not its own baseline."""

    def __init__(self, run_dir: pathlib.Path):
        self.run_dir = run_dir
        self.cache_dir = run_dir / ".cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.baseline_path = run_dir / "baseline.json"

    def evaluate(self, text: str, *, bars: tuple[int, int] | None = None, allow_mute: set | None = None) -> EvalResult:
        key = score_sha(text, bars)
        cache_json = self.cache_dir / f"{key}.json"
        if cache_json.exists():
            result = EvalResult(**json.loads(cache_json.read_text()))
            result.cache_hit = True
            return result
        result = self._render_and_check(text, key, bars, allow_mute)
        cache_json.write_text(json.dumps(result.to_json()))
        return result

    def _render_and_check(self, text: str, key: str, bars: tuple[int, int] | None, allow_mute: set | None) -> EvalResult:
        t0 = time.time()
        score_path = self.cache_dir / f"{key}.apr"
        score_path.write_text(absolutize_samples(text))
        wav = self.cache_dir / f"{key}.wav"
        stems_dir = self.cache_dir / f"{key}.stems"
        args = [str(BIN), "render", str(score_path), "--out", str(wav), "--stems", str(stems_dir)]
        if bars:
            args += ["--bars", f"{bars[0]}-{bars[1]}"]
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=RENDER_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return EvalResult(ok=False, error="render timed out", seconds=time.time() - t0)
        if r.returncode != 0:
            last = r.stderr.strip().splitlines()[-1][:300] if r.stderr.strip() else "render failed (no stderr)"
            return EvalResult(ok=False, error=last, seconds=time.time() - t0)
        try:
            report = checker.check(stems_dir, baseline_path=self.baseline_path, allow_mute=allow_mute, log_path=None)
        except Exception as e:  # noqa: BLE001 -- a check-time failure is a result, not a crash
            return EvalResult(ok=False, error=f"check failed: {e}", seconds=time.time() - t0)
        return EvalResult(ok=True, objective=report.objective, consonance=report.consonance,
                           guard_violations=list(report.guard_violations), report=report.to_json(),
                           stems_dir=str(stems_dir), seconds=time.time() - t0)


def _pool_worker(run_dir: str, text: str, bars: tuple[int, int] | None, allow_mute: list | None) -> dict:
    """Top-level (picklable) entry point for a `ProcessPoolExecutor` worker: evaluate one score
    and return its result as a plain dict (so it doesn't need `EvalResult` importable identically
    in the parent, which it is here, but keeping this boundary explicit and simple)."""
    ev = Evaluator(pathlib.Path(run_dir))
    result = ev.evaluate(text, bars=bars, allow_mute=set(allow_mute) if allow_mute else None)
    return result.to_json()


def evaluate_many(run_dir: pathlib.Path, texts: list[str], *, bars: tuple[int, int] | None = None,
                   allow_mute: set | None = None, workers: int = 4) -> list[EvalResult]:
    """Evaluate several score texts in parallel (up to `workers` at once). The caller must already
    have evaluated the incumbent (so `baseline.json` exists) before calling this with candidates --
    see `Evaluator`'s docstring."""
    if not texts:
        return []
    allow_mute_list = list(allow_mute) if allow_mute else None
    if workers <= 1 or len(texts) == 1:
        ev = Evaluator(run_dir)
        return [ev.evaluate(t, bars=bars, allow_mute=allow_mute) for t in texts]
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_pool_worker, str(run_dir), t, bars, allow_mute_list) for t in texts]
        return [EvalResult(**f.result()) for f in futures]
