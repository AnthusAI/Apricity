#!/usr/bin/env python3
"""Shortlist clips that sound like they belong with a scene: CLAP similarity to a clip already in the
score, optionally blended with a text prompt for the style.

    clap-neighbors.py --ref "<sample path> <saved clip>"
    clap-neighbors.py --ref "<sample path> <saved clip>" --prompt "<a style, in words>"
    clap-neighbors.py --prompt "<a style, in words>" --kinds phrase --top 20

Prints the best clip per recording: the blended score, similarity to the reference clip and to the
prompt, the sample and the saved clip. Feed the list to `swap-audition.py` or `scripts/explore.py
--candidates FILE` (`--out FILE` writes it in that "<sample>  <clip>" format).

Needs the CLAP sidecars (`scripts/fit-features.py`, `<file>.clap.npz` next to each manifest) and, with
`--prompt`, the CLAP model in the Hugging Face cache (downloaded on first use).
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

import numpy as np


def main_checkout() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve().parent
    common = subprocess.run(["git", "-C", str(here), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            capture_output=True, text=True, check=True).stdout.strip()
    return pathlib.Path(common).parent


def load(samples: pathlib.Path):
    rows = []
    for f in samples.rglob("*.clap.npz"):
        z = np.load(f, allow_pickle=False)
        if "clip_names" not in z.files or "clip_embeddings" not in z.files:
            continue
        rel = str(f.relative_to(samples)).removesuffix(".clap.npz")
        for name, e in zip(z["clip_names"], z["clip_embeddings"]):
            rows.append((rel, str(name), e / (np.linalg.norm(e) + 1e-9)))
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", help='a clip already in the scene: "<sample path> <saved clip>"')
    ap.add_argument("--prompt", help="a text description of the style you want")
    ap.add_argument("--kinds", default="loop,sec,phrase", help="saved-clip kinds to consider (prefixes): loop,sec,phrase,hold,shot")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--out", type=pathlib.Path, help="also write the list as a candidates file")
    a = ap.parse_args(argv)
    if not a.ref and not a.prompt:
        ap.error("give --ref, --prompt or both")

    root = main_checkout()
    sys.path.insert(0, str(root / "analysis"))
    samples = root / "samples"
    rows = load(samples)
    if not rows:
        sys.exit(f"no CLAP sidecars under {samples}: run scripts/fit-features.py first")

    ref = None
    if a.ref:
        sample, clip = a.ref.split()
        ref = next((e for r, n, e in rows if r == sample and n == clip), None)
        if ref is None:
            sys.exit(f"no CLAP embedding for {a.ref!r}")
    text = None
    if a.prompt:
        from apricity_analyze import clap  # loads the model on first use
        text = clap.embed_text(a.prompt)
        text = text / np.linalg.norm(text)

    kinds = tuple(k.strip() + "-" for k in a.kinds.split(","))
    ref_sample = a.ref.split()[0] if a.ref else None
    scored = []
    for r, n, e in rows:
        if not n.startswith(kinds) or r == ref_sample:
            continue
        s_ref = float(e @ ref) if ref is not None else None
        s_txt = float(e @ text) if text is not None else None
        parts = [s for s in (s_ref, s_txt) if s is not None]
        scored.append((sum(parts) / len(parts), s_ref, s_txt, r, n))
    scored.sort(reverse=True)

    seen, best = set(), []
    for row in scored:
        if row[3] in seen:
            continue
        seen.add(row[3])
        best.append(row)
        if len(best) == a.top:
            break
    fmt = lambda v: "   -  " if v is None else f"{v:.3f}"
    print("score  scene  prompt  sample  clip")
    for s, sr, st, r, n in best:
        print(f"{s:.3f}  {fmt(sr)}  {fmt(st)}  {r}  {n}")
    if a.out:
        a.out.write_text("".join(f"{r}  {n}\n" for _, _, _, r, n in best))
        print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
