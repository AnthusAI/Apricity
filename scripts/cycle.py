#!/usr/bin/env python3
"""Thin wrapper: `lab cycle` now owns this (Kanbus apricitus-daebf8). Kept only so old muscle
memory and any external callers of `scripts/cycle.py` keep working; prefer `scripts/lab cycle`.

    scripts/cycle.py publish --score <score.apr> --incumbent-score-id <score id> \\
        --incumbent-audio <incumbent audio> \\
        --candidate renders/c/a.apr renders/c/a.m4a --candidate renders/c/b.apr renders/c/b.m4a \\
        --question "Which main loop should it keep?" --target local
    scripts/cycle.py list --target cloud --owner '<sub>::<username>'
    scripts/cycle.py pull cyc_0123456789abcdef --target local --close
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    from apricity_analyze.lab.cli import main as lab_main
    return lab_main(["cycle", *(argv if argv is not None else sys.argv[1:])])


if __name__ == "__main__":
    sys.exit(main())
