#!/usr/bin/env python3
"""Score one candidate layer against a fixed stack (the layer-by-layer optimizer's validator).

    scripts/check-layer.py renders/stack.stems renders/candidate.stems [--stack-cache F] [--json]

Both directories are `apricity render --stems` output. The candidate directory's `stems.json`
tracks list is used to pick which stem is "the candidate" (all of them, scored one at a time,
against the whole stack) -- pass a directory with just the one track you're auditioning.

Tonight's slice (see `apricity_analyze.layer`'s module docstring): the composite is
`clash*0.6 + masking*0.2 + onset*0.2`, and the only hard gates are "not silent" and "not a
double" of something already in the stack.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="check-layer.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stack", type=pathlib.Path, help="the stack's --stems render directory")
    ap.add_argument("candidate", type=pathlib.Path, help="the candidate's --stems render directory")
    ap.add_argument("--stack-cache", type=pathlib.Path, default=None, help="cache the stack's features here (.npz)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    from apricity_analyze import layer

    stack_manifest, stack_feats = layer.load_stack(args.stack, cache_path=args.stack_cache)
    cand_manifest, cand_feats = layer.load_stack(args.candidate)  # same shape; no cache for a one-off candidate

    reports = []
    for cand in cand_feats:
        report = layer.check_layer(stack_manifest, cand, stack_feats)
        reports.append((cand.name, report))

    if args.json:
        print(json.dumps({name: r.to_json() for name, r in reports}, indent=1))
        return 0

    for name, r in reports:
        print(f"{name}: score {r.score:.1f}  gates {'PASS' if r.gates.passed else 'FAIL'}")
        print(f"  clash {r.terms.clash:.3f}  masking {r.terms.masking:.3f}  rhythm {r.terms.rhythm:.3f}")
        for f in r.findings:
            print(f"  ! {f}")
        for p in r.pairs:
            print(f"    vs {p['stem']:<14} onset r {p['onset_r']:+.3f}  chroma cos {p['chroma_cosine']:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
