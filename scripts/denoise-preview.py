#!/usr/bin/env python3
"""Denoise every Library of Congress recording in samples/ and lay each out beside its original,
with an index.html of players, in renders/denoise-preview/ (git-ignored).

  PYTHONPATH=analysis analysis/.venv/bin/python scripts/denoise-preview.py [--strength medium]
                                                                          [--variants spectral adaptive]
Each recording gets a folder: original.<ext>, and one `<variant>.wav` per variant. Variants are
backend chains such as `spectral` or `declick+spectral`, optionally with a strength: `neural:strong`. Re-runs skip finished files."""
import argparse, html, pathlib, shutil, sys
from apricity_analyze import denoise

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOC = ["samples/citizen-dj/loc-*", "samples/loc/*"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strength", default="medium", choices=denoise.STRENGTHS)
    ap.add_argument("--variants", nargs="+", default=["spectral", "adaptive"])
    ap.add_argument("--out", type=pathlib.Path, default=ROOT / "renders/denoise-preview")
    a = ap.parse_args()
    files = sorted(f for pat in LOC for d in ROOT.glob(pat) for f in d.iterdir()
                   if f.suffix in (".wav", ".mp3") and ".clean." not in f.name)
    rows = []
    for i, f in enumerate(files, 1):
        coll = f.parent.name
        d = a.out / coll / f.stem
        d.mkdir(parents=True, exist_ok=True)
        orig = d / f"original{f.suffix}"
        if not orig.exists(): shutil.copy2(f, orig)
        made = []
        for spec in a.variants:
            v, _, st = spec.partition(":")          # "neural" or "neural:strong"
            st = st or a.strength
            out = d / f"{v.replace('+', '-')}-{st}.wav"
            if not out.exists():
                print(f"[{i}/{len(files)}] {coll}/{f.stem} {v} {st}", flush=True)
                denoise.clean(f, v.split("+"), st, out)
            made.append(out)
        rows.append((coll, f.stem, orig, made))
    cells = []
    for coll, name, orig, made in rows:
        rel = lambda p: p.relative_to(a.out).as_posix()
        players = "".join(f"<td><b>{p.stem}</b><br><audio controls preload=none src='{rel(p)}'></audio></td>"
                          for p in [orig, *made])
        cells.append(f"<tr><th>{html.escape(coll)}<br>{html.escape(name)}</th>{players}</tr>")
    (a.out / "index.html").write_text(
        "<meta charset=utf-8><title>Denoise preview</title><style>body{font:14px system-ui;margin:20px}"
        "td,th{padding:6px 10px;text-align:left;border-bottom:1px solid #ccc}audio{width:260px}</style>"
        f"<h1>Denoise preview ({a.strength})</h1><table>{''.join(cells)}</table>")
    print(f"done: {len(rows)} recordings -> {a.out}/index.html")

main()
