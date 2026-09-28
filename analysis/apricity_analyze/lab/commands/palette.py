"""`lab palette [filter] [-v]`: every sample a score can use, its key, tempo and saved clips, read
from the manifests under `samples/` (tracked in git, so this works without the audio). Moved out
of the skill's `palette.py` main()."""

from __future__ import annotations

import argparse
import json

from . import _common

NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def add_parser(sub) -> None:
    ap = sub.add_parser("palette", help="list every analyzed sample: key, tempo, saved clips")
    ap.add_argument("filters", nargs="*", help="only samples whose path contains every filter")
    ap.add_argument("-v", "--verbose", action="store_true", help="one sample in detail: every saved clip, its length and first note")
    _common.add_json_flag(ap)
    ap.set_defaults(func=run)


def _note_name(midi: int) -> str:
    return f"{NAMES[midi % 12]}{midi // 12 - 1}"


def _first_note(notes: list, start: float, end: float) -> str:
    onset = [n for n in notes if start - 0.03 <= n["start"] <= min(start + 0.12, end)]
    if not onset:
        return ""
    loudest = max(n.get("velocity", 0) for n in onset)
    return _note_name(min(n["midi"] for n in onset if n.get("velocity", 0) >= loudest * 0.5))


def collect(samples_dir, filters: list[str]) -> list[dict]:
    rows = []
    for path in sorted(samples_dir.rglob("*.apricity.json")):
        rel = str(path.relative_to(samples_dir))[: -len(".apricity.json")]
        if filters and not all(f in rel for f in filters):
            continue
        m = json.loads(path.read_text())
        key = m.get("tonal", {}).get("key") or {}
        clips = m.get("annotations", {}).get("clips", [])
        notes = m.get("notes", [])
        rows.append({
            "sample": rel, "tonic": key.get("tonic"), "mode": key.get("mode"),
            "bpm": m.get("rhythm", {}).get("bpm"), "duration": m.get("source", {}).get("duration", 0),
            "clips": [
                {"name": c["name"], "length": c["end"] - c["start"],
                 "note": _first_note(notes, c["start"], c["end"]) if notes else "",
                 "tags": [t for t in c.get("tags", []) if not t.endswith("s")]}
                for c in clips
            ],
        })
    return rows


def _prose(payload: dict) -> None:
    for row in payload["samples"]:
        head = f"{row['sample']}  {row['tonic'] or '?'} {row['mode'] or ''}  {row['bpm'] or '-'} bpm  {row['duration']:.0f}s"
        if not payload["verbose"]:
            kinds: dict[str, list] = {}
            for c in row["clips"]:
                kinds.setdefault(c["name"].rsplit("-", 1)[0], []).append(c["name"])
            print(head + "  " + " ".join(f"{k}×{len(v)}" for k, v in kinds.items()))
            continue
        print(head)
        for c in row["clips"]:
            print(f"  {c['name']:<10} {c['length']:6.2f}s  {c['note']:<4} {','.join(c['tags'])}")


def run(args: argparse.Namespace) -> int:
    ctx = _common.get_context(args, require_binary=False)
    rows = collect(ctx.repo_root / "samples", args.filters)
    if not rows:
        _common.die("no samples/ manifests matched")
    payload = {"samples": rows, "verbose": args.verbose}
    return _common.emit(args, payload, _prose)
