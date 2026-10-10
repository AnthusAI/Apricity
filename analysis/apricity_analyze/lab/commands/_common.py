"""Flags and small helpers shared by every `lab` subcommand: `--json` on all of them, `--bars`/
`--window` (same syntax, different name per command to match the tool it wraps), and `--keep`.
"""

from __future__ import annotations

import argparse
import json
import sys

from apricity_analyze.lab.context import LabContext, LabError, build_context


def parse_range(s: str) -> tuple[int, int]:
    try:
        a, b = s.split("-", 1)
        return int(a), int(b)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected A-B, e.g. 33-40, not {s!r}")


def add_json_flag(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--json", action="store_true", help="print machine-readable JSON instead of prose")


def add_keep_flag(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--keep", action="store_true", help="keep the render (wav/stems) under renders/lab/ instead of deleting it")


def get_context(args: argparse.Namespace, *, require_binary: bool = True) -> LabContext:
    try:
        return build_context(require_binary=require_binary)
    except LabError as e:
        die(str(e))


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def emit(args: argparse.Namespace, payload: dict, prose_fn) -> int:
    """`--json` prints `payload` as JSON; otherwise calls `prose_fn(payload)` to print the
    human-readable form."""
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=1, default=str))
    else:
        prose_fn(payload)
    return 0
