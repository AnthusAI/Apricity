#!/usr/bin/env python3
"""Explorer v0: cast a different clip for one role, then hill-climb its EQ/transpose/octave/
release/highpass against the harmony checker, and report a leaderboard.

    scripts/explore.py <score.apr> --role <track> --candidates auto --workers 4
    scripts/explore.py <score.apr> --role <track> --candidates cands.txt

`--candidates auto` uses the user's own rated loops first, then licensed ccMixter loop-/sec-
clips at 90-130 bpm (see `apricity_analyze.explore.candidates`). A candidates FILE has one
"<sample path>  <saved clip>" per line (the same format `ratings.py` prints).

Writes `renders/explore/<run>/` (see `apricity_analyze.explore.notebook.Notebook`'s docstring for
the layout) and prints the leaderboard.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="explore.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("score", type=pathlib.Path, help="the base .apr score")
    ap.add_argument("--role", required=True, help="the clip/track name to re-cast, e.g. bright")
    ap.add_argument("--candidates", default="auto", help='"auto", or a file of "<sample>  <clip>" lines')
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--n", type=int, default=12, help="how many casts to try in stage 1")
    ap.add_argument("--inner-budget", type=int, default=8)
    ap.add_argument("--run", default=None, help="run name (default: the score's stem + a timestamp)")
    ap.add_argument("--library", type=pathlib.Path, default=pathlib.Path.home() / "Apricity-Library",
                    help="where the run's text is kept for good, beside the verdicts (notebooks/explore/<run>/)")
    ap.add_argument("--audition", action="store_true",
                    help="also write a 16-bar audition-form .m4a per finalist (audition/<label>.m4a), Kanbus apricitus-dbed5c")
    args = ap.parse_args(argv)

    from apricity_analyze.explore import candidates as candidates_mod
    from apricity_analyze.explore import search
    from apricity_analyze.explore import verdicts as verdicts_mod

    base_text = args.score.read_text()

    if args.candidates == "auto":
        source = _score_source_samples(base_text, args.role)
        cast_list = candidates_mod.auto_candidates(args.n, exclude_samples=source)
    else:
        cast_list = _read_candidates_file(pathlib.Path(args.candidates))
    if not cast_list:
        sys.exit("no candidates found")
    print(f"{len(cast_list)} candidate(s) for role {args.role!r}:")
    for c in cast_list:
        print(f"  {c.sample}  {c.clip}   {c.attribution}")

    run_name = args.run or f"{args.score.stem}-{args.role}-{int(time.time())}"
    run_dir = ROOT / "renders" / "explore" / run_name

    # renders/ is ignored by git and local to this checkout: the run's text is also kept in the library.
    archive = verdicts_mod.notebooks_dir(args.library) / "explore" / run_name if args.library.expanduser().is_dir() else None
    if archive is None:
        print(f"note: no library at {args.library}; this run's notebook lives only in {run_dir}")

    t0 = time.time()
    result = search.outer_loop(base_text, role=args.role, cast_list=cast_list, run_dir=run_dir,
                                workers=args.workers, inner_budget=args.inner_budget, archive=archive)
    elapsed = time.time() - t0

    print(f"\nleaderboard ({elapsed:.0f}s total):")
    for i, row in enumerate(result["rows"], 1):
        print(f"  {i}. {row['objective']:6.1f}  {row['label']:<60} {row['attribution']}")
    print(f"\nwrote {run_dir}")
    print(f"  best.apr / best.m4a, leaderboard.md, notebook.jsonl")

    if args.audition:
        _write_auditions(result["rows"], role=args.role, run_dir=run_dir)

    if archive:
        print(f"kept {archive} (the run's text, beside your verdicts)")
        print(f"  judge it: scripts/verdict.py stars {run_name} <experiment> <1-5> --note \"…\"")
    return 0


def _write_auditions(rows: list[dict], *, role: str, run_dir: pathlib.Path) -> None:
    """16-bar audition-form `.m4a` (Kanbus apricitus-dbed5c) for each non-incumbent finalist, so
    the human reviews `renders/explore/<run>/audition/*.m4a` (32s each) instead of full-song
    `best.m4a`-sized takes for every row. `role` is also the candidate track's name (a
    `cast.swap` re-casts it in place, it doesn't rename it)."""
    import tempfile

    from apricity_analyze import audition_form

    audition_dir = run_dir / "audition"
    for i, row in enumerate(rows, 1):
        if row["label"] == "(incumbent)" or not row.get("result") or not row["result"].ok:
            continue
        safe_label = "".join(ch if ch.isalnum() else "-" for ch in row["label"])[:40]
        out_path = audition_dir / f"{i:02d}-{safe_label}.m4a"
        with tempfile.NamedTemporaryFile("w", suffix=".apr", delete=False) as f:
            f.write(row["text"])
            tmp_path = pathlib.Path(f.name)
        try:
            result = audition_form.build_audition(tmp_path, track=role, out_path=out_path, check=True)
            print(f"  audition: {out_path.name}  (Δwindow {result.delta_window:+.2f}, window {result.window[0]}-{result.window[1]})")
        except audition_form.AuditionError as e:
            print(f"  audition: {row['label']}: failed ({e})")
        finally:
            tmp_path.unlink(missing_ok=True)


def _score_source_samples(text: str, role: str) -> set[str]:
    import re
    m = re.search(rf"^clip\s+{re.escape(role)}\s*=\s*(\S+)", text, re.M)
    return {m.group(1)} if m else set()


def _read_candidates_file(path: pathlib.Path):
    from apricity_analyze.explore.candidates import Candidate
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        sample, clip = parts
        out.append(Candidate(sample=sample, clip=clip, source=sample, attribution=sample))
    return out


if __name__ == "__main__":
    raise SystemExit(main())
