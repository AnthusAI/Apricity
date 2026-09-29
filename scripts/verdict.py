#!/usr/bin/env python3
"""Record what you think of an explorer run, where it can't be lost (the library's notebooks).

    scripts/verdict.py stars ave-house-bright-1790000000 stage3-0002 4 --note "warmer, the pad sits back"
    scripts/verdict.py pick  ave-house-bright-1790000000 stage3-0002 --over stage3-0001 stage3-0003
    scripts/verdict.py none  ave-house-bright-1790000000 --over stage3-0001 stage3-0002 stage3-0003 --note "the stack alone is better"
    scripts/verdict.py list  [--run ave-house-bright-1790000000]
    scripts/verdict.py taste marine-band/stems/Thunderer/other.wav loop-1

A pick or none counts against what it beat; the layer validator's taste term reads them all
(`apricity_analyze.explore.verdicts`). Verdicts are appended to ~/Apricity-Library/notebooks/verdicts.jsonl.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    from apricity_analyze.explore import verdicts as vs

    ap = argparse.ArgumentParser(prog="verdict.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", type=pathlib.Path, default=None, help="the library folder (default ~/Apricity-Library)")
    ap.add_argument("--by", default="person", help="who is judging")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stars", help="rate one experiment 1–5")
    s.add_argument("run"), s.add_argument("experiment"), s.add_argument("stars", type=int)
    p = sub.add_parser("pick", help="prefer one experiment over others")
    p.add_argument("run"), p.add_argument("experiment"), p.add_argument("--over", nargs="+", required=True)
    n = sub.add_parser("none", help="none of these was better than what was there")
    n.add_argument("run"), n.add_argument("--over", nargs="+", required=True)
    for x in (s, p, n):
        x.add_argument("--note", default="", help="what you heard, in your words")
    ls = sub.add_parser("list", help="the verdicts so far")
    ls.add_argument("--run", default=None)
    t = sub.add_parser("taste", help="a clip's taste term, from the verdicts (0 loved, 1 disliked, 0.5 unrated)")
    t.add_argument("sample"), t.add_argument("clip")
    args = ap.parse_args(argv)

    if args.cmd == "list":
        for v in vs.read(library=args.library, run=args.run):
            what = f"{v.stars}★ {v.experiment}" if v.kind == "stars" else f"{v.kind} {v.experiment or '(nothing new)'} over {', '.join(v.over)}"
            cast = f"  [{v.sample} {v.clip}]" if v.sample else ""
            print(f"{v.at}  {v.run}  {what}{cast}  {v.note}")
        return 0
    if args.cmd == "taste":
        print(vs.taste(args.sample, args.clip, library=args.library))
        return 0
    v = vs.Verdict(kind=args.cmd, run=args.run, experiment=getattr(args, "experiment", None), stars=getattr(args, "stars", None),
                   over=getattr(args, "over", None) or [], note=args.note, by=args.by)
    try:
        v = vs.record(v, library=args.library)
    except ValueError as e:
        sys.exit(str(e))
    cast = f" ({v.sample} {v.clip})" if v.sample else ""
    print(f"kept: {v.kind} {v.experiment or ''}{cast} in {vs.notebooks_dir(args.library) / 'verdicts.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
