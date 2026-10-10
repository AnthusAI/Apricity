"""`lab cycle publish|list|pull`: listening cycles (the Listen page). Same inputs as
`scripts/cycle.py`, plus a convenience form for `publish`: `--score S --candidates A.apr B.apr ...
--window A-B` builds the 16-bar audition .m4a for each candidate and for the incumbent itself
(via `apricity_analyze.audition_form.build_scene_audition`, the same "keep option" audition the
optimizer's cycle folders already use) instead of requiring pre-rendered audio.

`--target cloud` shells out to the authenticated cloud CLI (`apricity cycle ...`; `apricity login`,
crates/apricity-cli/src/cloud.rs), so owner is set server-side from the signed-in person's session --
there is no `--owner` flag for it, and nothing here touches AWS credentials. `--target local` (the
default) still writes straight to a library folder through `cycle.LocalBackend`, and keeps
`renders/log.jsonl` (the blind key `pull` reads back, and a durable local record `--target cloud`
has no equivalent of, since the cloud is the record).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random

from apricity_analyze import audition_form, cycle

from . import _common
from ..cloud_cli import CloudCliError, run_json


def add_parser(sub) -> None:
    ap = sub.add_parser("cycle", help="publish, list or pull a listening cycle")
    ap.add_argument("--target", choices=["local", "cloud"], default="local")
    ap.add_argument("--library", type=pathlib.Path, help="the library folder (local target)")
    ap.add_argument("--owner", help="the library's identity (local target only; the cloud target uses the signed-in session)")
    ap.add_argument("--log", type=pathlib.Path, default=None, help="default: renders/log.jsonl (local target only)")
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
    p.add_argument("--lab", help="a Lab id to publish this cycle into (sets labId)")
    p.add_argument("--seed", type=int, default=None, help="seed the letter shuffle (local target only; default: unseeded)")

    sub2.add_parser("list", help="list open cycles")

    p = sub2.add_parser("pull", help="log a cycle's ratings and verdicts")
    p.add_argument("cycle_id")
    p.add_argument("--close", action="store_true")

    ap.set_defaults(func=run)


def _backend(args: argparse.Namespace) -> cycle.LocalBackend:
    return cycle.LocalBackend(args.library, owner=args.owner)


def _build_convenience_audio(score_path: pathlib.Path, out_path: pathlib.Path, window: tuple[int, int]) -> pathlib.Path:
    result = audition_form.build_scene_audition(score_path, out_path=out_path, window=window)
    return result.m4a_path


def _resolve_candidates(args: argparse.Namespace, ctx) -> tuple[pathlib.Path, list[tuple[pathlib.Path, pathlib.Path]]]:
    """The incumbent's audio and the candidates' (apr, audio) pairs, building them with the
    convenience form (`--candidates`/`--window`) when given. Shared by both targets: only where the
    result goes (a local `cycle.Candidate` list vs `--candidate` pairs for the cloud CLI) differs."""
    incumbent_audio = args.incumbent_audio
    if args.candidates:
        if not args.window:
            _common.die("--candidates needs --window (the convenience form auditions over one window)")
        out_dir = ctx.repo_root / "renders" / "lab" / "cycle"
        out_dir.mkdir(parents=True, exist_ok=True)
        if incumbent_audio is None:
            incumbent_audio = _build_convenience_audio(args.score, out_dir / f"{args.score.stem}-incumbent.m4a", args.window)
        pairs = []
        for apr in args.candidates:
            apr_path = pathlib.Path(apr)
            audio_path = _build_convenience_audio(apr_path, out_dir / f"{apr_path.stem}.m4a", args.window)
            pairs.append((apr_path, audio_path))
    elif args.candidate:
        pairs = [(pathlib.Path(apr), pathlib.Path(audio)) for apr, audio in args.candidate]
    else:
        _common.die("give --candidate APR AUDIO (repeatable) or --candidates APR... --window A-B")
    if incumbent_audio is None:
        _common.die("give --incumbent-audio, or --candidates --window to build it")
    return incumbent_audio, pairs


def _publish_local(args: argparse.Namespace, ctx, log_path: pathlib.Path) -> dict:
    backend = _backend(args)
    rng = random.Random(args.seed) if args.seed is not None else random.SystemRandom()
    incumbent_audio, pairs = _resolve_candidates(args, ctx)
    candidates = [cycle.Candidate(apr, audio) for apr, audio in pairs]
    published = cycle.publish(
        backend, score_path=args.score, incumbent_score_id=args.incumbent_score_id,
        incumbent_audio=incumbent_audio, candidates=candidates, question=args.question,
        title=args.title, lab_id=args.lab, log_path=log_path, rng=rng,
    )
    return {"cycle": published, "log": str(log_path)}


def _publish_cloud(args: argparse.Namespace, ctx) -> dict:
    incumbent_audio, pairs = _resolve_candidates(args, ctx)
    cmd = ["cycle", "publish", "--score", str(args.score), "--incumbent-score-id", args.incumbent_score_id,
           "--incumbent-audio", str(incumbent_audio)]
    for apr, audio in pairs:
        cmd += ["--candidate", str(apr), str(audio)]
    if args.question:
        cmd += ["--question", args.question]
    if args.title:
        cmd += ["--title", args.title]
    if args.lab:
        cmd += ["--lab", args.lab]
    try:
        return run_json(ctx.binary, cmd)
    except CloudCliError as e:
        _common.die(str(e))


def run(args: argparse.Namespace) -> int:
    # Every path here can shell out to the `apricity` binary (the cloud target always does; the
    # convenience `publish` form's own audition rendering finds its own binary through
    # `audition_form`, which is why this only *requires* one when the cloud target needs it).
    ctx = _common.get_context(args, require_binary=args.target == "cloud")

    if args.cycle_command == "publish":
        if args.target == "cloud":
            payload = _publish_cloud(args, ctx)
            return _common.emit(args, payload, lambda p: print(f"published {p['cycleId']}: {len(p['options'])} options"))
        log_path = args.log or (ctx.repo_root / "renders" / "log.jsonl")
        payload = _publish_local(args, ctx, log_path)
        return _common.emit(args, payload, lambda p: print(
            f"published {p['cycle']['id']}: {len(p['cycle']['options'])} options (the blind key is in {p['log']})"))

    if args.target == "cloud":
        if args.cycle_command == "list":
            try:
                payload = run_json(ctx.binary, ["cycle", "list"])
            except CloudCliError as e:
                _common.die(str(e))

            def prose(p):
                for c in p["cycles"]:
                    print(f"{c['id']}  {c.get('createdAt', '')[:16]}  {c['title']}  ({len(c['options'])} options)")
            return _common.emit(args, payload, prose)

        try:
            payload = run_json(ctx.binary, ["cycle", "pull", args.cycle_id, *(["--close"] if args.close else [])])
        except CloudCliError as e:
            _common.die(str(e))

        def prose(p):
            for e in p["entries"]:
                print(json.dumps(e))
            print(f"{len(p['entries'])} finding(s)" + ("; cycle closed" if p["closed"] else ""))
        return _common.emit(args, payload, prose)

    backend = _backend(args)
    log_path = args.log or (ctx.repo_root / "renders" / "log.jsonl")
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
