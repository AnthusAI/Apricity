"""`lab backtest`: the harmony v2 backtest -- re-renders the windows behind previously logged
listening verdicts and checks whether `objective_v1`/`objective_v2` agree with what the listener
preferred. Wraps `apricity_analyze.harmony_backtest` (moved out of `scripts/harmony-backtest.py`'s
`main()`, which is now a thin wrapper over this)."""

from __future__ import annotations

import argparse

from apricity_analyze import harmony_backtest

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("backtest", help="the harmony v2 backtest against logged listening verdicts")
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def _prose(payload: dict) -> None:
    print(f"{'set':<24}{'candidate':<20}{'stars':>6}{'v1':>10}{'v2':>10}  preferred?")
    for s in payload["sets"]:
        for r in s["rows"]:
            print(f"{r['verdict_set']:<24}{r['candidate']:<20}{(r['stars'] if r['stars'] is not None else ''):>6}{r['objective_v1']:>10.2f}{r['objective_v2']:>10.2f}  {'*' if r['preferred'] else ''}")
        print(f"  -> v1 top pick: {s['top_v1']} ({'agrees' if s['v1_agrees'] else 'disagrees'} with the listener)")
        print(f"  -> v2 top pick: {s['top_v2']} ({'agrees' if s['v2_agrees'] else 'disagrees'} with the listener)")
        print()
    print(f"Agreement with the logged verdicts: v1 {payload['agree_v1']}/{payload['total_sets']}, v2 {payload['agree_v2']}/{payload['total_sets']}")


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args)
    scratch_root = ctx.repo_root / ".harmony-backtest-scratch"
    payload = harmony_backtest.run_backtest(ctx.binary, scratch_root)
    return _common.emit(args, payload, _prose)
