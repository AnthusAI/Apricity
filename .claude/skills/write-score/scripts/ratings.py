#!/usr/bin/env python3
"""What the user has rated, best first: the best available signal of their taste.

    ratings.py                          # ~/Apricity-Library
    ratings.py --library /path/to/lib   # another library folder
    ratings.py --min 4                  # only 4★ and up

Reads the library's Rating, Clip and Sample records (the web app saves ratings there in local mode).
Each rated clip is printed ready for a score: `<sample path>  <saved clip>`, e.g.
`marine-band/stems/LibertyBell/other.wav  loop-1`. Ratings made on the live site live in its database,
not in this folder.
"""

import argparse
import json
import pathlib


def load(folder: pathlib.Path) -> dict:
    return {json.loads(p.read_text())["id"]: json.loads(p.read_text()) for p in folder.glob("*.json")} if folder.is_dir() else {}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", default=str(pathlib.Path.home() / "Apricity-Library"))
    ap.add_argument("--min", type=int, default=1)
    a = ap.parse_args()
    lib = pathlib.Path(a.library)
    clips, samples, scores = load(lib / "Clip"), load(lib / "Sample"), load(lib / "Score")
    rows = []
    for r in load(lib / "Rating").values():
        if r.get("stars", 0) < a.min:
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
        rows.append((r["stars"], what, detail))
    if not rows:
        print(f"no ratings in {lib}")
        return
    for stars, what, detail in sorted(rows, key=lambda x: (-x[0], x[1])):
        print(f"{'★' * stars:<5} {what:<70} {detail}")


if __name__ == "__main__":
    main()
