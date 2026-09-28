"""`lab swap SCORE --role TRACK (--candidates F | --neighbors)`: the explorer -- cast a different
clip for one role, hill-climb its EQ/transpose/octave/release/highpass against the harmony
checker, and report a leaderboard. Thin over `scripts/explore.py`'s own `main(argv)`; `--neighbors`
is `lab`'s own convenience, building the candidates file with `apricity_analyze.clap.neighbors`
first (see `lab neighbors`)."""

from __future__ import annotations

import argparse
import pathlib

from apricity_analyze import clap
from scripts import explore as explore_script

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("swap", help="the explorer: re-cast one role and hill-climb it")
    ap.add_argument("score", type=pathlib.Path)
    ap.add_argument("--role", required=True, help="the clip/track name to re-cast")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--candidates", help='"auto", or a file of "<sample>  <clip>" lines')
    group.add_argument("--neighbors", action="store_true", help="build the candidates file with the CLAP shortlist first")
    ap.add_argument("--ref", help="with --neighbors: a clip already in the scene (default: --role's current clip, read from SCORE)")
    ap.add_argument("--prompt", help="with --neighbors: a text description of the style")
    ap.add_argument("--top", type=int, default=20, help="with --neighbors: how many candidates to shortlist")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--n", type=int, default=12, help="how many casts to try in stage 1")
    ap.add_argument("--inner-budget", type=int, default=8)
    ap.add_argument("--run", default=None)
    ap.add_argument("--library", type=pathlib.Path, default=pathlib.Path.home() / "Apricity-Library")
    ap.add_argument("--audition", action="store_true", help="also write a 16-bar audition .m4a per finalist")
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def _current_clip_line(score_text: str, role: str) -> str | None:
    import re
    m = re.search(rf"^clip\s+{role}\s*=\s*(\S+)\s+(\S+)", score_text, re.M)
    return f"{m.group(1)} {m.group(2)}" if m else None


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args)

    candidates = args.candidates
    if args.neighbors:
        ref = args.ref or _current_clip_line(args.score.read_text(), args.role)
        if not ref and not args.prompt:
            _common.die("--neighbors needs --ref or --prompt (couldn't find --role's current clip in SCORE either)")
        try:
            rows = clap.neighbors(ctx.repo_root / "samples", ref=ref, prompt=args.prompt, top=args.top)
        except ValueError as e:
            _common.die(str(e))
        candidates_dir = ctx.repo_root / "renders" / "lab" / "swap"
        candidates_dir.mkdir(parents=True, exist_ok=True)
        candidates = str(candidates_dir / f"{args.score.stem}-{args.role}-neighbors.txt")
        pathlib.Path(candidates).write_text("".join(f"{r['sample']}  {r['clip']}\n" for r in rows))

    argv = [str(args.score), "--role", args.role, "--candidates", candidates,
            "--workers", str(args.workers), "--n", str(args.n), "--inner-budget", str(args.inner_budget),
            "--library", str(args.library)]
    if args.run:
        argv += ["--run", args.run]
    if args.audition:
        argv += ["--audition"]

    if getattr(args, "json", False):
        print("note: lab swap prints the explorer's own leaderboard prose; --json isn't wired into scripts/explore.py yet")
    return explore_script.main(argv)
