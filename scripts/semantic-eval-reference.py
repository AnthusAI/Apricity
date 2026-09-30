#!/usr/bin/env python3
"""Export pinned local references or evaluate browser/Python parity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "analysis"))

from apricity_analyze.semantic_evaluation import (  # noqa: E402
    EvaluationError, EvaluationGateFailed, GroundHandoffError, evaluate_browser_parity, evaluate_warm_measurement, generate_local_reference,
    load_judgments, not_evaluated_report,
)


def write_report(path: Path, report: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="JSON output path (only supplied paths are written)")
    parser.add_argument("--generate", action="store_true", help="explicitly generate local pinned CLAP references after ground handoff")
    parser.add_argument("--python-reference", type=Path, help="existing local reference JSON")
    parser.add_argument("--browser-reference", type=Path, help="browser interchange JSON")
    parser.add_argument("--judgments", type=Path, help="reviewed relevance-judgment JSON for final acceptance")
    parser.add_argument("--desktop-measurement", type=Path, help="measured warm desktop timing JSON")
    parser.add_argument("--mobile-measurement", type=Path, help="measured warm designated-mobile timing JSON")
    args = parser.parse_args(argv)
    if args.generate:
        try:
            generate_local_reference(args.output)
        except EvaluationGateFailed as error:
            write_report(args.output, {"state": "failed", "referenceVersion": "apricity.semantic-evaluation/1",
                                       "repeatedAnalysis": error.report})
            print(str(error), file=sys.stderr)
            return 2
        except GroundHandoffError as error:
            write_report(args.output, not_evaluated_report([str(error)]))
            print(str(error), file=sys.stderr)
            return 2
        except Exception as error:  # model/cache/runtime failures are never green
            write_report(args.output, not_evaluated_report([f"reference generation failed: {error}"]))
            print(f"reference generation failed: {error}", file=sys.stderr)
            return 2
        return 0
    reasons = []
    if not args.python_reference:
        reasons.append("missing Python reference")
    if not args.browser_reference:
        reasons.append("missing browser reference")
    try:
        load_judgments(args.judgments, require_reviewed=True)
    except (OSError, json.JSONDecodeError, EvaluationError) as error:
        reasons.append(f"missing, invalid, or unreviewed relevance judgments: {error}")
    if not args.desktop_measurement:
        reasons.append("missing desktop device measurement")
    if not args.mobile_measurement:
        reasons.append("missing designated mobile device measurement")
    if reasons:
        write_report(args.output, not_evaluated_report(reasons))
        return 2
    try:
        report = evaluate_browser_parity(json.loads(args.python_reference.read_text()), json.loads(args.browser_reference.read_text()))
        report["desktopWarm"] = evaluate_warm_measurement(args.desktop_measurement, limit_ms=2_000, label="desktop")
        report["mobileWarm"] = evaluate_warm_measurement(args.mobile_measurement, limit_ms=5_000, label="mobile")
        if report["desktopWarm"]["state"] != "passed" or report["mobileWarm"]["state"] != "passed":
            report["state"] = "failed"
    except (OSError, json.JSONDecodeError, EvaluationError) as error:
        write_report(args.output, not_evaluated_report([str(error)]))
        return 2
    write_report(args.output, report)
    return 0 if report["state"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
