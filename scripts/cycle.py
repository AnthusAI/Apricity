#!/usr/bin/env python3
"""Listening cycles: publish a blind round of a score's candidates for people to rate, and pull the
verdicts back (Kanbus apricitus-2101dd).

    scripts/cycle.py publish --score examples/ave-house.apr --incumbent-score-id scr_examples_ave-house_apr \\
        --incumbent-audio renders/ave-house.m4a \\
        --candidate renders/c/a.apr renders/c/a.m4a --candidate renders/c/b.apr renders/c/b.m4a \\
        --question "Which main loop should it keep?" --target local
    scripts/cycle.py list --target cloud --owner '<sub>::<username>'
    scripts/cycle.py pull cyc_0123456789abcdef --target local --close

`--target local` writes the library folder a local `apricity serve` reads (`--library`, default
~/Apricity-Library); `--target cloud` writes the deployed app's DynamoDB tables and bucket with your
AWS credentials, as `--owner` (Amplify's `<sub>::<username>`; never guessed). The blind key and every
verdict go to `renders/log.jsonl` (see `apricity_analyze.cycle`).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))


def main(argv: list[str] | None = None) -> int:
    from apricity_analyze import cycle

    ap = argparse.ArgumentParser(prog="cycle.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", choices=["local", "cloud"], default="local")
    ap.add_argument("--library", type=pathlib.Path, help="the library folder (local target)")
    ap.add_argument("--owner", help="the owner to write as (cloud: '<sub>::<username>'; local: the library's identity)")
    ap.add_argument("--log", type=pathlib.Path, default=ROOT / "renders/log.jsonl")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("publish", help="publish a cycle")
    p.add_argument("--score", type=pathlib.Path, required=True, help="the incumbent's .apr")
    p.add_argument("--incumbent-score-id", required=True)
    p.add_argument("--incumbent-audio", type=pathlib.Path, required=True)
    p.add_argument("--candidate", nargs=2, action="append", metavar=("APR", "AUDIO"), required=True)
    p.add_argument("--question")
    p.add_argument("--title")
    p.add_argument("--seed", type=int, help="seed the letter shuffle (default: unseeded)")

    sub.add_parser("list", help="list open cycles")

    p = sub.add_parser("pull", help="log a cycle's ratings and verdicts")
    p.add_argument("cycle_id")
    p.add_argument("--close", action="store_true", help="close the cycle afterwards")

    a = ap.parse_args(argv)
    if a.target == "local":
        backend = cycle.LocalBackend(a.library, owner=a.owner)
    else:
        backend = cycle.CloudBackend(owner=a.owner)

    if a.cmd == "publish":
        rng = random.Random(a.seed) if a.seed is not None else random.SystemRandom()
        c = cycle.publish(
            backend,
            score_path=a.score,
            incumbent_score_id=a.incumbent_score_id,
            incumbent_audio=a.incumbent_audio,
            candidates=[cycle.Candidate(pathlib.Path(apr), pathlib.Path(audio)) for apr, audio in a.candidate],
            question=a.question,
            title=a.title,
            log_path=a.log,
            rng=rng,
        )
        print(f"published {c['id']}: {len(c['options'])} options (the blind key is in {a.log})")
    elif a.cmd == "list":
        for c in cycle.list_open(backend):
            print(f"{c['id']}  {c.get('createdAt', '')[:16]}  {c['title']}  ({len(c['options'])} options)")
    else:
        entries = cycle.pull(backend, a.cycle_id, log_path=a.log, close=a.close)
        for e in entries:
            print(json.dumps(e))
        print(f"{len(entries)} finding(s) logged to {a.log}" + ("; cycle closed" if a.close else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
