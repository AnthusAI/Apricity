#!/usr/bin/env python3
"""Create a bounded immutable semantic cluster draft using the ground lab command."""
from __future__ import annotations
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "analysis"))
from apricity_analyze.lab.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main(["semantic", "cluster", *sys.argv[1:]]))
