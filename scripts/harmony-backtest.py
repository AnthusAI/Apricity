#!/usr/bin/env python3
"""Thin wrapper: `lab backtest` now owns this (Kanbus apricitus-daebf8); the implementation moved
to `analysis/apricity_analyze/harmony_backtest.py`. Kept only so old muscle memory keeps working;
prefer `scripts/lab backtest`.

    scripts/harmony-backtest.py
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    from apricity_analyze.lab.cli import main as lab_main
    return lab_main(["backtest", *(argv if argv is not None else sys.argv[1:])])


if __name__ == "__main__":
    raise SystemExit(main())
