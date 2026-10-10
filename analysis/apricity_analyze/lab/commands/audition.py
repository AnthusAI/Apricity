"""`lab audition SCORE --layer TRACK [--window A-B]`: the 16-bar audition form (scene alone, the
layer solo, then both together) as one small .m4a, plus Δwindow against a scene-alone baseline.
Wraps `apricity_analyze.audition_form.build_audition` -- see that module for the render/assemble/
loudness-normalize pipeline; this command only owns the CLI and the output path."""

from __future__ import annotations

import argparse
import pathlib

from apricity_analyze import audition_form

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("audition", help="the 16-bar audition form for one candidate layer")
    ap.add_argument("score", type=pathlib.Path)
    ap.add_argument("--layer", "--track", dest="track", required=True)
    ap.add_argument("--window", type=_common.parse_range, default=None, metavar="A-B")
    ap.add_argument("--scene-bars", type=int, default=4)
    ap.add_argument("-o", "--out", type=pathlib.Path, default=None, help="default: renders/lab/audition/<score>-<layer>.m4a")
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def _prose(payload: dict) -> None:
    print(f"window: bars {payload['window'][0]}-{payload['window'][1]} ({payload['tempo']:g} BPM, {payload['meter']}/4)")
    li = payload["loudness"]
    print(f"loudness: {li['method']}, gain {li['gain_db']:+.1f} dB, peak {li['peak_dbfs']:.1f} dBFS")
    if payload.get("delta_window") is not None:
        print(f"Δwindow: {payload['delta_window']:+.2f}  (together {payload['together_objective']:.2f} - scene {payload['scene_objective']:.2f})")
    print(f"wrote {payload['m4a']}")


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args)
    out_path = args.out
    if out_path is None:
        out_dir = ctx.repo_root / "renders" / "lab" / "audition"
        out_dir.mkdir(parents=True, exist_ok=True)
        window_tag = f"-{args.window[0]}-{args.window[1]}" if args.window else ""
        out_path = out_dir / f"{args.score.stem}-{args.track}{window_tag}.m4a"

    try:
        result = audition_form.build_audition(
            args.score, track=args.track, out_path=out_path, window=args.window,
            scene_bars=args.scene_bars, check=True,
        )
    except audition_form.AuditionError as e:
        _common.die(str(e))

    payload = {
        "m4a": str(result.m4a_path), "json": str(result.json_path),
        "window": list(result.window), "tempo": result.tempo, "meter": result.meter,
        "loudness": result.loudness_info,
        "delta_window": getattr(result, "delta_window", None),
        "together_objective": getattr(result, "together_objective", None),
        "scene_objective": getattr(result, "scene_objective", None),
    }
    return _common.emit(args, payload, _prose)
