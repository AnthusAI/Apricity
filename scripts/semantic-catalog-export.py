#!/usr/bin/env python3
"""Export a native Apricity library into the canonical semantic catalog shape."""
from __future__ import annotations
import argparse, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from apricity_analyze.semantic_catalog import export_catalog  # noqa: E402

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True, type=pathlib.Path); parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args(argv)
    result = export_catalog(args.library)
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(result["catalog"], indent=2, sort_keys=True) + "\n")
    except OSError as error:
        print(json.dumps({"error": {"code": "output_write_failed", "message": str(error)}}), file=sys.stderr); return 2
    print(json.dumps({"excluded": result["excluded"], "counts": {key: len(result["catalog"][key]) for key in ("samples", "clips", "recordings", "analyses")}}, sort_keys=True), file=sys.stderr)
    return 0 if not result["excluded"] else 2
if __name__ == "__main__": raise SystemExit(main())
