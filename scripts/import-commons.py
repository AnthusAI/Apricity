#!/usr/bin/env python3
"""Discover, verify, and import direct audio members of Apricity's Commons categories."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "analysis"))

from apricity_analyze.commons import main


if __name__ == "__main__":
    raise SystemExit(main())
