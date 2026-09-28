"""`lab ratings [--min 4]`: what the user has rated, best first -- the best available signal of
their taste. Reads the library's Rating/Clip/Sample/Score records. Moved out of the skill's
`ratings.py` main()."""

from __future__ import annotations

import argparse
import json
import pathlib

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("ratings", help="what the user has rated, best first")
    ap.add_argument("--library", type=pathlib.Path, default=pathlib.Path.home() / "Apricity-Library")
    ap.add_argument("--min", type=int, default=1)
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def _load(folder: pathlib.Path) -> dict:
    if not folder.is_dir():
        return {}
    return {json.loads(p.read_text())["id"]: json.loads(p.read_text()) for p in folder.glob("*.json")}


def collect(library: pathlib.Path, min_stars: int) -> list[dict]:
    clips, samples, scores = _load(library / "Clip"), _load(library / "Sample"), _load(library / "Score")
    rows = []
    for r in _load(library / "Rating").values():
        if r.get("stars", 0) < min_stars:
            continue
        kind, tid = r.get("targetType"), r.get("targetId")
        if kind == "clip" and tid in clips:
            c = clips[tid]
            s = samples.get(c.get("sampleId"), {})
            what = f"{s.get('path', '?')}  {c['name']}"
            detail = f"{c['end'] - c['start']:.1f}s  {','.join(t for t in c.get('tags', []) if not t.endswith('s'))}"
        elif kind == "sample" and tid in samples:
            s = samples[tid]
            what, detail = s.get("path", tid), f"whole sample  {s.get('key', '')}  {s.get('bpm', '')} bpm"
        elif kind == "score" and tid in scores:
            what, detail = f"score {scores[tid].get('title', tid)}", ""
        else:
            what, detail = f"{kind} {tid}", "(no longer in the library)"
        rows.append({"stars": r["stars"], "what": what, "detail": detail})
    rows.sort(key=lambda x: (-x["stars"], x["what"]))
    return rows


def _prose(payload: dict) -> None:
    if not payload["ratings"]:
        print(f"no ratings in {payload['library']}")
        return
    for row in payload["ratings"]:
        print(f"{'★' * row['stars']:<5} {row['what']:<70} {row['detail']}")


def run(args: argparse.Namespace) -> int:
    rows = collect(args.library, args.min)
    payload = {"ratings": rows, "library": str(args.library)}
    return _common.emit(args, payload, _prose)
