"""`lab measure SCORE [--bars A-B]`: render the window with stems, run `apricity check --json`
and `apricity steer --score`, and print the objective, each span's written/heard chord with Q,
and the top suggestions. Replaces the by-hand render + check + steer loop."""

from __future__ import annotations

import argparse
import pathlib

from apricity_analyze.lab.rendercheck import MeasureError, render_and_measure

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("measure", help="render + check + steer a score's window")
    ap.add_argument("score", type=pathlib.Path)
    ap.add_argument("--bars", type=_common.parse_range, default=None, metavar="A-B")
    ap.add_argument("--baseline", type=pathlib.Path, default=None)
    _common.add_json_flag(ap)
    _common.add_keep_flag(ap)
    ap.set_defaults(func=run)


def _prose(payload: dict) -> None:
    print(f"{payload['score']}" + (f"  bars {payload['bars'][0]}-{payload['bars'][1]}" if payload["bars"] else ""))
    print(f"objective_v2 {payload['objective_v2']:.2f}   (v1 {payload['objective']:.2f}, Q_mean {payload.get('q_mean', float('nan')):.2f})")
    if payload["guard_violations"]:
        print("guard violations:")
        for v in payload["guard_violations"]:
            print(f"  ! {v}")

    print("\nspans:")
    steer_spans = payload.get("steer_spans") or [None] * len(payload["spans"])
    for s, ss in zip(payload["spans"], steer_spans):
        heard = s.get("heard") or {}
        heard_label = f"{heard.get('root','?')}{heard.get('quality','')}" if heard else "?"
        bars = (ss or {}).get("bars", [None, None])
        bars_label = f"{bars[0]:>4.0f}-{bars[1]:<4.0f}" if bars[0] is not None else " -- "
        q = s.get("Q")
        q_val = q.get("Q", float("nan")) if isinstance(q, dict) else (q if q is not None else float("nan"))
        print(f"  bars {bars_label} written {s.get('label',''):<16} heard {heard_label:<10} Q {q_val:.2f}")

    suggestions = payload.get("suggestions", [])
    if suggestions:
        print("\ntop suggestions:")
        for i, sug in enumerate(suggestions[:5], 1):
            print(f"  {i}. {sug.get('op')}  {sug.get('why', '')}")
    else:
        print("\nno suggestions")


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args)
    with ctx.render_dir(keep=args.keep) as work_dir:
        try:
            m = render_and_measure(ctx, args.score, work_dir, bars=args.bars, baseline=args.baseline)
        except MeasureError as e:
            _common.die(str(e))
        payload = m.to_json()
        if args.keep:
            payload["stems_dir"] = str(m.stems_dir)
    return _common.emit(args, payload, _prose)
