#!/usr/bin/env python3
"""Regenerate local v2 CLAP sidecars from an explicit canonical catalog export."""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from apricity_analyze.semantic_backfill import backfill  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=pathlib.Path)
    parser.add_argument("--samples", required=True, type=pathlib.Path)
    parser.add_argument("--report", required=True, type=pathlib.Path)
    parser.add_argument("--sample-id", action="append", dest="sample_ids")
    parser.add_argument("--batch-size", type=int, default=4, choices=range(1, 9))
    args = parser.parse_args(argv)
    try:
        catalog = json.loads(args.catalog.read_text())
    except Exception as error:  # noqa: BLE001
        print(f"semantic-backfill: invalid catalog: {error}", file=sys.stderr)
        return 2
    report = backfill(catalog, args.samples, args.sample_ids, args.batch_size,
                      lambda event: print(f"{event['state']}: {event['sampleId']}", file=sys.stderr))
    try:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    except Exception as error:  # noqa: BLE001
        print(f"semantic-backfill: report write failed: {error}", file=sys.stderr)
        return 2
    return 2 if report["fatal"] or report["hasSourceFailures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
