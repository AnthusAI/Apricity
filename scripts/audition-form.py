#!/usr/bin/env python3
"""Build the 16-bar audition form for one candidate layer (Kanbus apricitus-dbed5c): bars 1-4 the
existing scene alone, 5-8 the new/re-cast TRACK solo, 9-16 both together with a 2-bar build --
instead of a full 40-bar render, which takes about 80s to review and fills the disk.

    scripts/audition-form.py CANDIDATE.apr --layer <track> -o out.m4a
    scripts/audition-form.py CANDIDATE.apr --layer <track> --window 33-40 -o out.m4a --check

`--window a-b` picks the 8-bar window W where the scene is judged (default: the 8 bars before the
score's last 8, or its first 8 for a song under 24 bars -- prefer an explicit window when the
score has a section, such as a drop or hook, that should be judged specifically). `--check` also
scores the together-window against a scene-alone baseline over the same W (cached per
score+window) and reports Δwindow.

Renders exactly once; deletes the render's WAV and stems directory before exiting -- only the
`.m4a` and a small `<out>.json` of numbers are kept. See `.agents/skills/write-score/references/
recipes.md` ("Auditioning a layer (the 16-bar form)") for the human-facing recipe this implements.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def _parse_window(s: str) -> tuple[int, int]:
    a, b = s.split("-", 1)
    return int(a), int(b)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="audition-form.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("candidate", type=pathlib.Path, help="the candidate .apr (scene + the new/re-cast track)")
    ap.add_argument("--layer", "--track", dest="track", required=True, help="the track name to audition (the new or re-cast part)")
    ap.add_argument("--window", type=_parse_window, default=None, metavar="A-B", help="the 8-bar window W, 1-based inclusive, e.g. 33-40")
    ap.add_argument("--scene-bars", type=int, default=4, help="how many bars of the scene-alone / solo sections to play (default 4)")
    ap.add_argument("-o", "--out", type=pathlib.Path, required=True, help="output .m4a path")
    ap.add_argument("--check", action="store_true", help="also score the together-window against a scene-alone baseline over W (Δwindow)")
    args = ap.parse_args(argv)

    from apricity_analyze import audition_form

    try:
        result = audition_form.build_audition(
            args.candidate, track=args.track, out_path=args.out, window=args.window,
            scene_bars=args.scene_bars, check=args.check,
        )
    except audition_form.AuditionError as e:
        sys.exit(f"error: {e}")

    print(f"window: bars {result.window[0]}-{result.window[1]} ({result.tempo:g} BPM, {result.meter}/4)")
    print(f"loudness: {result.loudness_info['method']}, gain {result.loudness_info['gain_db']:+.1f} dB, "
          f"peak {result.loudness_info['peak_dbfs']:.1f} dBFS")
    if args.check:
        print(f"Δwindow: {result.delta_window:+.2f}  (together {result.together_objective:.2f} - scene {result.scene_objective:.2f})")
    print(f"wrote {result.m4a_path}")
    print(f"wrote {result.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
