"""`lab add SCORE [--roles ...] [--style T]`: the stochastic mash-up optimizer -- add (or re-cast)
a part and hill-climb it into a cycle-folder leaderboard. Thin over `scripts/optimize.py`'s own
`main(argv)` (a `--run` name is generated when not given, since that script requires one)."""

from __future__ import annotations

import argparse
import pathlib
import time

from scripts import optimize as optimize_script

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("add", help="the optimizer: add or re-cast a part and hill-climb it")
    ap.add_argument("score", type=pathlib.Path)
    ap.add_argument("--roles", default=None, help="comma-separated subset of loop,bass,pad,stab,chop,riff")
    ap.add_argument("--role", default=None, help="an existing track name to re-cast instead of adding a part")
    ap.add_argument("--style", default="smooth deep house")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--budget-l0", type=int, default=2000)
    ap.add_argument("--mutation-rounds", type=int, default=3)
    ap.add_argument("--mutation-per-round", type=int, default=150)
    ap.add_argument("--budget-l1", type=int, default=48)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--no-clap", action="store_true")
    ap.add_argument("--run", default=None, help="default: SCORE's stem + a timestamp")
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    _common.get_context(args)  # validates the binary/sample setup even though optimize.py finds its own
    run_name = args.run or f"{args.score.stem}-{time.strftime('%Y%m%d-%H%M%S')}"

    argv = [str(args.score), "--seed", str(args.seed), "--budget-l0", str(args.budget_l0),
            "--mutation-rounds", str(args.mutation_rounds), "--mutation-per-round", str(args.mutation_per_round),
            "--budget-l1", str(args.budget_l1), "--workers", str(args.workers), "--style", args.style,
            "--run", run_name]
    if args.roles:
        argv += ["--roles", args.roles]
    if args.role:
        argv += ["--role", args.role]
    if args.no_clap:
        argv += ["--no-clap"]

    if getattr(args, "json", False):
        print("note: lab add prints the optimizer's own leaderboard prose; --json isn't wired into scripts/optimize.py yet")
    return optimize_script.main(argv)
