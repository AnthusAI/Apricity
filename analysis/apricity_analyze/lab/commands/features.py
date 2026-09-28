"""`lab features [--samples DIR] [--only PATTERN] [--no-clap] [--workers N]`: fit the per-sample
feature sidecars (chroma/rhythm/CLAP) that `lab neighbors`, `lab swap` and the optimizer read.
Thin over `scripts/fit-features.py`'s own `main(argv)` (loaded dynamically -- its filename has a
hyphen, so it isn't a normal importable module)."""

from __future__ import annotations

import argparse

from apricity_analyze.lab.legacy import load_script

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("features", help="fit the per-sample feature sidecars (chroma/rhythm/CLAP)")
    ap.add_argument("--samples", default=None, help="default: <repo>/samples")
    ap.add_argument("--only", default=None, metavar="PATTERN")
    ap.add_argument("--no-clap", action="store_true")
    ap.add_argument("--workers", type=int, default=None)
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args, require_binary=False)
    fit_features = load_script(ctx.repo_root, "fit-features")

    argv: list[str] = []
    if args.samples:
        argv += ["--samples", args.samples]
    if args.only:
        argv += ["--only", args.only]
    if args.no_clap:
        argv += ["--no-clap"]
    if args.workers:
        argv += ["--workers", str(args.workers)]

    if getattr(args, "json", False):
        print("note: lab features prints fit-features.py's own progress; --json isn't wired into it yet")
    return fit_features.main(argv)
