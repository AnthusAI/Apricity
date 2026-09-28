"""`lab neighbors --ref 'SAMPLE CLIP' [--prompt T]`: the CLAP shortlist -- clips that sound like
they belong with a scene, optionally blended with a text prompt. Replaces the skill's
`clap-neighbors.py`; wraps `apricity_analyze.clap.neighbors`."""

from __future__ import annotations

import argparse
import pathlib

from apricity_analyze import clap

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("neighbors", help="CLAP shortlist of clips that fit a scene/style")
    ap.add_argument("--ref", help='a clip already in the scene: "<sample path> <saved clip>"')
    ap.add_argument("--prompt", help="a text description of the style you want")
    ap.add_argument("--kinds", default="loop,sec,phrase", help="saved-clip kinds to consider (prefixes)")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--out", type=pathlib.Path, help='also write the list as a candidates file ("<sample>  <clip>" per line)')
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def _prose(payload: dict) -> None:
    print("score  scene  prompt  sample  clip")
    for row in payload["neighbors"]:
        fmt = lambda v: "   -  " if v is None else f"{v:.3f}"
        print(f"{row['score']:.3f}  {fmt(row['scene_similarity'])}  {fmt(row['prompt_similarity'])}  {row['sample']}  {row['clip']}")
    if payload.get("out"):
        print(f"wrote {payload['out']}")


def run(args: argparse.Namespace) -> int:
    if not args.ref and not args.prompt:
        _common.die("give --ref, --prompt or both")
    ctx = _common.get_context(args, require_binary=False)
    samples_dir = ctx.repo_root / "samples"
    try:
        rows = clap.neighbors(samples_dir, ref=args.ref, prompt=args.prompt, kinds=args.kinds, top=args.top)
    except ValueError as e:
        _common.die(str(e))

    if args.out:
        args.out.write_text("".join(f"{r['sample']}  {r['clip']}\n" for r in rows))

    payload = {"neighbors": rows, "out": str(args.out) if args.out else None}
    return _common.emit(args, payload, _prose)
