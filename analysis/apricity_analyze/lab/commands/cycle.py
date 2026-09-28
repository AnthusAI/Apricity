"""`lab cycle publish|list|pull`: listening cycles (the Listen page). Same inputs as
`scripts/cycle.py`, plus a convenience form for `publish`: `--score S --candidates A.apr B.apr ...
--window A-B` builds the 16-bar audition .m4a for each candidate and for the incumbent itself
(via `apricity_analyze.audition_form.build_scene_audition`, the same "keep option" audition the
optimizer's cycle folders already use) instead of requiring pre-rendered audio.

`--target cloud` always requires `--owner` (Amplify's `<sub>::<username>`); never guessed."""

from __future__ import annotations

import argparse
import json
import pathlib
import random

from apricity_analyze import audition_form, cycle

from . import _common


def add_parser(sub) -> None:
    ap = sub.add_parser("cycle", help="publish, list or pull a listening cycle")
    ap.add_argument("--target", choices=["local", "cloud"], default="local")
    ap.add_argument("--library", type=pathlib.Path, help="the library folder (local target)")
    ap.add_argument("--owner", help="'<sub>::<username>' for cloud; the library's identity for local")
    ap.add_argument("--log", type=pathlib.Path, default=None, help="default: renders/log.jsonl")
    _common.add_json_flag(ap)
    sub2 = ap.add_subparsers(dest="cycle_command", required=True)

    p = sub2.add_parser("publish", help="publish a cycle")
    p.add_argument("--score", type=pathlib.Path, required=True, help="the incumbent's .apr")
    p.add_argument("--incumbent-score-id", required=True)
    p.add_argument("--incumbent-audio", type=pathlib.Path, default=None, help="omit with --window to build it")
    p.add_argument("--candidate", nargs=2, action="append", default=None, metavar=("APR", "AUDIO"),
                    help="the classic form: an already-rendered candidate (repeatable)")
    p.add_argument("--candidates", nargs="+", default=None, metavar="APR",
                    help="the convenience form: candidate .apr files to audition and publish (needs --window)")
    p.add_argument("--window", type=_common.parse_range, default=None, metavar="A-B",
                    help="the convenience form's audition window")
    p.add_argument("--question")
    p.add_argument("--title")
    p.add_argument("--seed", type=int, default=None, help="seed the letter shuffle (default: unseeded)")

    sub2.add_parser("list", help="list open cycles")

    p = sub2.add_parser("pull", help="log a cycle's ratings and verdicts")
    p.add_argument("cycle_id")
    p.add_argument("--close", action="store_true")

    ap.set_defaults(func=run)


def _backend(args: argparse.Namespace):
    if args.target == "local":
        return cycle.LocalBackend(args.library, owner=args.owner)
    if not args.owner:
        _common.die("--target cloud needs --owner ('<sub>::<username>'); never guessed")
    return cycle.CloudBackend(owner=args.owner)


def _build_convenience_audio(score_path: pathlib.Path, out_path: pathlib.Path, window: tuple[int, int]) -> pathlib.Path:
    result = audition_form.build_scene_audition(score_path, out_path=out_path, window=window)
    return result.m4a_path


def _publish(args: argparse.Namespace, ctx, log_path: pathlib.Path) -> dict:
    backend = _backend(args)
    rng = random.Random(args.seed) if args.seed is not None else random.SystemRandom()

    candidates: list[cycle.Candidate]
    incumbent_audio = args.incumbent_audio

    if args.candidates:
        if not args.window:
            _common.die("--candidates needs --window (the convenience form auditions over one window)")
        out_dir = ctx.repo_root / "renders" / "lab" / "cycle"
        out_dir.mkdir(parents=True, exist_ok=True)
        if incumbent_audio is None:
            incumbent_audio = _build_convenience_audio(args.score, out_dir / f"{args.score.stem}-incumbent.m4a", args.window)
        candidates = []
        for apr in args.candidates:
            apr_path = pathlib.Path(apr)
            audio_path = _build_convenience_audio(apr_path, out_dir / f"{apr_path.stem}.m4a", args.window)
            candidates.append(cycle.Candidate(apr_path, audio_path))
    elif args.candidate:
        candidates = [cycle.Candidate(pathlib.Path(apr), pathlib.Path(audio)) for apr, audio in args.candidate]
    else:
        _common.die("give --candidate APR AUDIO (repeatable) or --candidates APR... --window A-B")

    if incumbent_audio is None:
        _common.die("give --incumbent-audio, or --candidates --window to build it")

    published = cycle.publish(
        backend, score_path=args.score, incumbent_score_id=args.incumbent_score_id,
        incumbent_audio=incumbent_audio, candidates=candidates, question=args.question,
        title=args.title, log_path=log_path, rng=rng,
    )
    return {"cycle": published, "log": str(log_path)}


def run(args: argparse.Namespace) -> int:
    # The convenience `publish` form renders through `audition_form`, which finds its own
    # `apricity` binary (this checkout's `target/release/apricity`); `list`/`pull` don't render
    # at all, so this context never needs `lab`'s own binary discovery to succeed.
    ctx = _common.get_context(args, require_binary=False)
    log_path = args.log or (ctx.repo_root / "renders" / "log.jsonl")

    if args.cycle_command == "publish":
        payload = _publish(args, ctx, log_path)
        return _common.emit(args, payload, lambda p: print(
            f"published {p['cycle']['id']}: {len(p['cycle']['options'])} options (the blind key is in {p['log']})"))

    backend = _backend(args)
    if args.cycle_command == "list":
        cycles = cycle.list_open(backend)
        payload = {"cycles": cycles}

        def prose(p):
            for c in p["cycles"]:
                print(f"{c['id']}  {c.get('createdAt', '')[:16]}  {c['title']}  ({len(c['options'])} options)")
        return _common.emit(args, payload, prose)

    entries = cycle.pull(backend, args.cycle_id, log_path=log_path, close=args.close)
    payload = {"entries": entries, "closed": args.close, "log": str(log_path)}

    def prose(p):
        for e in p["entries"]:
            print(json.dumps(e))
        print(f"{len(p['entries'])} finding(s) logged to {p['log']}" + ("; cycle closed" if p["closed"] else ""))
    return _common.emit(args, payload, prose)
