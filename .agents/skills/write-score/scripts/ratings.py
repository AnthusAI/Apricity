#!/usr/bin/env python3
"""Thin wrapper: `lab ratings` now owns this (Kanbus apricitus-daebf8). Kept only so old muscle
memory keeps working; prefer `scripts/lab ratings`.

    ratings.py                          # ~/Apricity-Library
    ratings.py --library /path/to/lib   # another library folder
    ratings.py --min 4                  # only 4★ and up
"""

import pathlib
import subprocess
import sys


def repo_root() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve().parent
    top = subprocess.run(["git", "-C", str(here), "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True, check=True).stdout.strip()
    return pathlib.Path(top)


def main() -> None:
    root = repo_root()
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "analysis"))
    from apricity_analyze.lab.cli import main as lab_main
    sys.exit(lab_main(["ratings", *sys.argv[1:]]))


if __name__ == "__main__":
    main()
