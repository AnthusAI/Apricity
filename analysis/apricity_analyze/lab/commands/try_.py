"""`lab try SCORE (--suggestion N | --op JSON) [--bars A-B] [--min-gain 2] [--apply]`: apply an op
(or a numbered `lab measure` suggestion) to a copy of SCORE, measure before and after, and print
the delta with KEEP or REJECT. `--apply` writes the change back to SCORE when it's a KEEP;
otherwise SCORE is left untouched and the candidate is written next to the render outputs."""

from __future__ import annotations

import argparse
import json
import pathlib

from apricity_analyze import audition_form
from apricity_analyze.explore import ops as ops_mod
from apricity_analyze.lab.ops_bridge import UnsupportedOp, op_from_suggestion
from apricity_analyze.lab.rendercheck import MeasureError, render_and_measure

from . import _common

DEFAULT_MIN_GAIN = 2.0


def add_parser(sub) -> None:
    ap = sub.add_parser("try", help="apply an op (or a steer suggestion), measure before/after, KEEP or REJECT")
    ap.add_argument("score", type=pathlib.Path)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--suggestion", type=int, metavar="N", help="the Nth suggestion (1-based) from a fresh `lab measure`")
    group.add_argument("--op", metavar="JSON", help='an op dict, e.g. \'{"op": "track.eq_notch", "track": "bright", "hz": 247, "gain": -8, "q": 12}\'')
    ap.add_argument("--bars", type=_common.parse_range, default=None, metavar="A-B")
    ap.add_argument("--min-gain", type=float, default=DEFAULT_MIN_GAIN, help=f"minimum objective_v2 rise to KEEP (default {DEFAULT_MIN_GAIN})")
    ap.add_argument("--apply", action="store_true", help="on KEEP, write the change back to SCORE")
    _common.add_json_flag(ap)
    _common.add_keep_flag(ap)
    ap.set_defaults(func=run)


def _resolve_op(args: argparse.Namespace, ctx, before_measurement) -> dict:
    if args.op:
        try:
            return json.loads(args.op)
        except json.JSONDecodeError as e:
            _common.die(f"--op isn't valid JSON: {e}")
    suggestions = before_measurement.steer.get("suggestions", [])
    if not suggestions:
        _common.die("no suggestions from `apricity steer` for this score/window")
    if not (1 <= args.suggestion <= len(suggestions)):
        _common.die(f"--suggestion {args.suggestion} out of range (1-{len(suggestions)})")
    suggestion = suggestions[args.suggestion - 1]
    try:
        return op_from_suggestion(suggestion)
    except UnsupportedOp as e:
        _common.die(str(e))


def _prose(payload: dict) -> None:
    verdict = payload["verdict"]
    print(f"{payload['op_description']}")
    print(f"objective_v2: {payload['before']:.2f} -> {payload['after']:.2f}  ({payload['delta']:+.2f})")
    if payload["new_guard_violations"]:
        print("new guard violations:")
        for v in payload["new_guard_violations"]:
            print(f"  ! {v}")
    print(f"\n{verdict}" + (f" -- wrote {payload['written_to']}" if payload.get("written_to") else ""))


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args)
    score_text = args.score.read_text()

    with ctx.render_dir(keep=args.keep) as before_dir:
        try:
            before = render_and_measure(ctx, args.score, before_dir, bars=args.bars)
        except MeasureError as e:
            _common.die(f"measuring before: {e}")

        op = _resolve_op(args, ctx, before)
        try:
            candidate_text = ops_mod.apply(score_text, op)
        except (ops_mod.OpError, KeyError) as e:
            _common.die(f"couldn't apply op: {e}")

        candidate_path = before_dir / f"{args.score.stem}.candidate.apr"
        # The candidate lives in a scratch directory, not next to SCORE, so its `samples <path>`
        # line (usually relative, e.g. `../samples`) needs to be absolutized first.
        candidate_path.write_text(audition_form.absolutize_samples(candidate_text))

        after_dir = before_dir / "after"
        after_dir.mkdir()
        try:
            after = render_and_measure(ctx, candidate_path, after_dir, bars=args.bars)
        except MeasureError as e:
            _common.die(f"measuring after: {e}")

    delta = after.objective_v2 - before.objective_v2
    keep = delta >= args.min_gain
    new_guards = [v for v in after.check.get("guard_violations", []) if v not in before.check.get("guard_violations", [])]
    if new_guards:
        keep = False

    written_to = None
    if keep and args.apply:
        args.score.write_text(candidate_text)
        written_to = str(args.score)
    else:
        # SCORE stays untouched; the candidate lives next to the render outputs, in a directory
        # that (unlike the wav/stems) is kept whether or not `--keep` was given -- it's cheap
        # text, and the point of `try` is to hand it back for inspection.
        out_dir = ctx.repo_root / "renders" / "lab" / "try"
        out_dir.mkdir(parents=True, exist_ok=True)
        kept_path = out_dir / f"{args.score.stem}.candidate.apr"
        kept_path.write_text(audition_form.absolutize_samples(candidate_text))
        written_to = str(kept_path)

    payload = {
        "op": op,
        "op_description": ops_mod.describe(op),
        "before": before.objective_v2,
        "after": after.objective_v2,
        "delta": delta,
        "min_gain": args.min_gain,
        "new_guard_violations": new_guards,
        "verdict": "KEEP" if keep else "REJECT",
        "applied": bool(keep and args.apply),
        "written_to": written_to,
    }
    return _common.emit(args, payload, _prose)
