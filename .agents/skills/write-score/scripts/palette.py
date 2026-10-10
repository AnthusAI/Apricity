#!/usr/bin/env python3
"""Thin wrapper: `lab palette` now owns this (Kanbus apricitus-daebf8). Kept only so old muscle
memory keeps working; prefer `scripts/lab palette`.

    palette.py                      # every sample, one line each
    palette.py marine-band/stems    # only samples under this path
    palette.py Thunderer/other -v   # one sample in detail: every saved clip, its length and first note
"""

import subprocess
import sys


def repo_root():
    import pathlib
    here = pathlib.Path(__file__).resolve().parent
    top = subprocess.run(["git", "-C", str(here), "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True, check=True).stdout.strip()
    return pathlib.Path(top)


def main(args: list) -> None:
    root = repo_root()
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "analysis"))
    from apricity_analyze.lab.cli import main as lab_main
    sys.exit(lab_main(["palette", *args]))


if __name__ == "__main__":
    main(sys.argv[1:])
