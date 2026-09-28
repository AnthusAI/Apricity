"""The `lab` dispatcher: `scripts/lab <subcommand> ...`. Kept importable (`main(argv)`) so tests
can drive it without a subprocess. Each subcommand is a small module in `lab/commands/` with a
`add_parser(subparsers)` and a `run(args) -> int`.
"""

from __future__ import annotations

import argparse
import sys

from .commands import (
    add as add_cmd,
    audition as audition_cmd,
    backtest as backtest_cmd,
    cycle as cycle_cmd,
    features as features_cmd,
    measure as measure_cmd,
    neighbors as neighbors_cmd,
    palette as palette_cmd,
    ratings as ratings_cmd,
    swap as swap_cmd,
    try_ as try_cmd,
)

SUBCOMMANDS = [
    measure_cmd,
    try_cmd,
    audition_cmd,
    neighbors_cmd,
    swap_cmd,
    add_cmd,
    cycle_cmd,
    backtest_cmd,
    palette_cmd,
    ratings_cmd,
    features_cmd,
]


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="lab",
        description="One front door for the Apricity music tools: measure, try, audition, "
                     "neighbors, swap, add, cycle, backtest, palette, ratings, features.",
    )
    sub = ap.add_subparsers(dest="command", required=True)
    for mod in SUBCOMMANDS:
        mod.add_parser(sub)
    return ap


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
