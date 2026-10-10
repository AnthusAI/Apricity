#!/usr/bin/env python3
"""Materialize and atomically publish a local semantic corpus from a canonical catalog."""
from __future__ import annotations
import argparse, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
from apricity_analyze import clap  # noqa: E402
from apricity_analyze.semantic_publisher import materialize_catalog, publish_catalog  # noqa: E402

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=pathlib.Path); parser.add_argument("--samples", required=True, type=pathlib.Path); parser.add_argument("--output", type=pathlib.Path); parser.add_argument("--dry-run", action="store_true"); parser.add_argument("--checkpoint", type=pathlib.Path); parser.add_argument("--sample-id", action="append", dest="sample_ids"); parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args(argv); output = args.output or args.samples / "semantic" / "corpus.json"
    try: catalog = json.loads(args.catalog.read_text())
    except Exception as error: print(json.dumps({"error": {"code": "invalid_catalog", "message": str(error)}}), file=sys.stderr); return 2
    try:
        materialized = materialize_catalog(catalog, args.samples, sample_ids=set(args.sample_ids) if args.sample_ids else None)
        scope, contract = (set(args.sample_ids), {}) if args.sample_ids else (None, {})
        if not output.exists() and not materialized["records"]:
            if scope is None:
                scope = {row["id"] for row in catalog.get("samples", []) if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]}
            contract = {"embedding_space": clap.EMBEDDING_SPACE, "processing_fingerprint": clap.processing_fingerprint()}
        report = publish_catalog(materialized, output, scope=scope, dry_run=args.dry_run, checkpoint=args.checkpoint, batch_size=args.batch_size, **contract)
    except Exception as error: print(json.dumps({"error": {"code": "publish_failed", "message": str(error), "retryable": False}}), file=sys.stderr); return 2
    print(json.dumps(report, sort_keys=True)); return 0
if __name__ == "__main__": raise SystemExit(main())
