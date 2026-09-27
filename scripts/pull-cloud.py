#!/usr/bin/env python3
"""Copy what people did on the hosted site (ratings, comments, handles) into the library.

    aws login
    scripts/pull-cloud.py            # mirror production into ~/Apricity-Library
    scripts/pull-cloud.py --dry-run  # say what would change

Records made locally are left alone; see `apricity_analyze.cloud_pull`.
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    from apricity_analyze import cloud_pull

    ap = argparse.ArgumentParser(prog="pull-cloud.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", type=pathlib.Path, default=pathlib.Path.home() / "Apricity-Library")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    try:
        plans = cloud_pull.pull(args.library.expanduser(), dry_run=args.dry_run)
    except subprocess.CalledProcessError as e:
        sys.exit(f"aws failed (signed in? run `aws login`):\n{e.stderr.strip()}")
    verb = "would write" if args.dry_run else "wrote"
    for model, p in plans.items():
        print(f"{model}: {verb} {len(p.write)}, removed {len(p.remove)}, unchanged {p.same}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
