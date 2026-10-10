"""`lab start|list|attach`: labs (Kanbus apricitus-e59a0b) group the listening cycles published while
working one scene. `--target cloud` shells out to `apricity lab ...` / `apricity cycle attach` (the
authenticated cloud CLI -- `apricity login`, crates/apricity-cli/src/cloud.rs -- so `owner` is set
server-side and this never touches AWS credentials itself); `--target local` writes to the library
folder directly, like `apricity_analyze.cycle.LocalBackend`.
"""

from __future__ import annotations

import argparse
import pathlib

from apricity_analyze import cycle

from . import _common
from ..cloud_cli import CloudCliError, run_json


def add_parser(sub) -> None:
    start = sub.add_parser("start", help="start a lab")
    start.add_argument("score", help="the scene: an existing Score id (local library id, or cloud Score id for --target cloud)")
    start.add_argument("--title", required=True)
    start.add_argument("--brief")
    start.add_argument("--target", choices=["local", "cloud"], default="local")
    start.add_argument("--library", type=pathlib.Path, help="the library folder (local target)")
    _common.add_json_flag(start)
    start.set_defaults(func=run_start)

    lst = sub.add_parser("list", help="list your labs")
    lst.add_argument("--target", choices=["local", "cloud"], default="local")
    lst.add_argument("--library", type=pathlib.Path, help="the library folder (local target)")
    _common.add_json_flag(lst)
    lst.set_defaults(func=run_list)

    attach = sub.add_parser("attach", help="attach an existing cycle to a lab")
    attach.add_argument("cycle_id")
    attach.add_argument("--lab", required=True)
    attach.add_argument("--target", choices=["local", "cloud"], default="local")
    attach.add_argument("--library", type=pathlib.Path, help="the library folder (local target)")
    _common.add_json_flag(attach)
    attach.set_defaults(func=run_attach)


def _binary(args: argparse.Namespace) -> pathlib.Path:
    ctx = _common.get_context(args, require_binary=True)
    return ctx.binary


def run_start(args: argparse.Namespace) -> int:
    if args.target == "cloud":
        cmd = ["lab", "start", args.score, "--title", args.title]
        if args.brief:
            cmd += ["--brief", args.brief]
        try:
            payload = run_json(_binary(args), cmd)
        except CloudCliError as e:
            _common.die(str(e))
        return _common.emit(args, payload, lambda p: print(p["id"]))

    backend = cycle.LocalBackend(args.library)
    if backend.get_score(args.score) is None:
        _common.die(f"no such score: {args.score}")
    lab = backend.create_lab(args.score, args.title, args.brief)
    return _common.emit(args, lab, lambda p: print(p["id"]))


def _prose_labs(payload: dict) -> None:
    for l in payload["labs"]:
        print(f"{l['id']}\t{l.get('status', '')}\t{l['title']}")


def run_list(args: argparse.Namespace) -> int:
    if args.target == "cloud":
        try:
            payload = run_json(_binary(args), ["lab", "list"])
        except CloudCliError as e:
            _common.die(str(e))
        return _common.emit(args, payload, _prose_labs)

    backend = cycle.LocalBackend(args.library)
    return _common.emit(args, {"labs": backend.list_labs()}, _prose_labs)


def run_attach(args: argparse.Namespace) -> int:
    if args.target == "cloud":
        try:
            payload = run_json(_binary(args), ["cycle", "attach", args.cycle_id, "--lab", args.lab])
        except CloudCliError as e:
            _common.die(str(e))
        return _common.emit(args, payload, lambda p: print(f"attached {args.cycle_id} to lab {args.lab}"))

    backend = cycle.LocalBackend(args.library)
    if backend.get_lab(args.lab) is None:
        _common.die(f"no such lab: {args.lab}")
    if backend.get_cycle(args.cycle_id) is None:
        _common.die(f"no such cycle: {args.cycle_id}")
    backend.attach_lab(args.cycle_id, args.lab)
    return _common.emit(args, {"cycleId": args.cycle_id, "labId": args.lab}, lambda p: print(f"attached {args.cycle_id} to lab {args.lab}"))
