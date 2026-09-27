#!/usr/bin/env python3
"""Harmony checker for a `--stems` render: measures interval clashes per stem and per beat, and
prints one objective (0-100) to hill-climb toward music that isn't discordant, with guards
against gaming it and findings in prose.

    apricity render score.apr --out renders/score.wav --stems renders/score.stems
    scripts/check-stems.py renders/score.stems

On first use it writes `renders/<name>.baseline.json` next to the stems directory; later runs
compare against it (refresh only when you mean to accept the new baseline as normal). Every run
appends one line to `renders/log.jsonl`.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="check-stems.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", type=pathlib.Path, help="a --stems render directory (holds stems.json and <track>.wav files)")
    ap.add_argument("--json", action="store_true", help="print the full report as JSON instead of prose")
    ap.add_argument("--baseline", type=pathlib.Path, default=None, metavar="FILE",
                     help="baseline file to compare against (written on first use); default renders/<name>.baseline.json "
                          "next to the render's parent, where <name> is the stems directory's own name")
    ap.add_argument("--allow-mute", action="append", default=[], metavar="TRACK",
                     help="don't flag this track as suspiciously quiet vs the baseline (repeatable)")
    ap.add_argument("--log", type=pathlib.Path, default=None, metavar="FILE", help="append a summary line here (default renders/log.jsonl)")
    args = ap.parse_args(argv)

    from apricity_analyze import check

    stems_dir = args.dir.resolve()
    if not (stems_dir / "stems.json").exists():
        sys.exit(f"{stems_dir}: no stems.json here (render with --stems first)")

    renders_root = stems_dir.parent if stems_dir.parent.name == "renders" else stems_dir.parent
    baseline_path = args.baseline or (renders_root / f"{stems_dir.name}.baseline.json")
    log_path = args.log or (renders_root / "log.jsonl")

    report = check.check(stems_dir, baseline_path=baseline_path, allow_mute=set(args.allow_mute), log_path=log_path)

    if args.json:
        print(json.dumps(report.to_json(), indent=1))
        return 0

    print_report(report, stems_dir, baseline_path)
    return 0


def print_report(report, stems_dir: pathlib.Path, baseline_path: pathlib.Path) -> None:
    print(f"{stems_dir}")
    print(f"consonance {report.consonance:.1f}  →  objective {report.objective:.1f}" + (f"  (penalties: " + ", ".join(f"{k} -{v:.1f}" for k, v in report.penalties.items() if v > 0) + ")" if any(report.penalties.values()) else ""))
    if baseline_path.exists() and report.baseline is None:
        print(f"  (baseline written to {baseline_path})")

    if report.guard_violations:
        print("\nguard violations (this render may be gamed, not actually better):")
        for v in report.guard_violations:
            print(f"  ! {v}")

    lo, med, hi = report.span_clash_spread
    print(f"\nspan clash spread (min/median/max, over every harmony span): {lo:.4f} / {med:.4f} / {hi:.4f}")
    print("\nworst spans:")
    for s in report.worst_spans:
        print(f"  bars {s.start_bar:>4.0f}-{s.end_bar:<4.0f} {s.label:<14} clash {s.clash:.3f}   {s.detail}")

    if report.leave_one_out:
        print("\nleave-one-out (removing this stem cuts the most clash):")
        for name, delta in report.leave_one_out[:5]:
            print(f"  {name:<14} would cut clash by {delta:.4f}" if delta > 0 else f"  {name:<14} isn't the problem (removing it changes clash by {delta:+.4f})")

    print("\nper-stem on-chord / off-key:")
    for name in report.on_chord:
        oc = report.on_chord[name]
        ok = report.off_key.get(name, 0.0)
        oc_s = f"{oc * 100:.0f}%" if oc == oc else "n/a"  # NaN check
        print(f"  {name:<14} on-chord {oc_s:<6} off-key {ok * 100:.0f}%")

    if report.smear:
        print("\nchord-change smear (on-chord share: first 0.4s after the change minus the rest; negative = smeared in):")
        for name, v in report.smear.items():
            print(f"  {name:<14} {v:+.3f}")

    print(f"\nloop-wrap clash (bar 40 into bar 1): {report.loop_wrap:.4f}")


if __name__ == "__main__":
    raise SystemExit(main())
