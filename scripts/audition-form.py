#!/usr/bin/env python3
"""Thin wrapper: `lab audition` now owns this (Kanbus apricitus-daebf8). Kept only so old muscle
memory keeps working; prefer `scripts/lab audition`.

    scripts/audition-form.py CANDIDATE.apr --layer <track> -o out.m4a
    scripts/audition-form.py CANDIDATE.apr --layer <track> --window 33-40 -o out.m4a --check
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    from apricity_analyze.lab.cli import main as lab_main

    argv = list(argv if argv is not None else sys.argv[1:])
    # The old CLI's `--check` just meant "score it" -- `lab audition` always does.
    argv = [a for a in argv if a != "--check"]
    return lab_main(["audition", *argv])


if __name__ == "__main__":
    raise SystemExit(main())
