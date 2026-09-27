#!/usr/bin/env python3
"""List the sounds a score can use: every sample's key, tempo and saved clips, from the manifests.

    palette.py                      # every sample, one line each
    palette.py marine-band/stems    # only samples under this path
    palette.py Thunderer/other -v   # one sample in detail: every saved clip, its length and first note

Reads `<audio>.apricity.json` manifests under samples/ (tracked in git, so this works without the
audio). Paths printed are relative to samples/, ready for a `clip name = <path> <saved clip>` line.
"""

import json
import pathlib
import sys

NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]  # as theory.PITCH_NAMES


def samples_dir() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve()
    for root in [pathlib.Path.cwd(), *here.parents]:
        if (root / "samples").is_dir() and any((root / "samples").rglob("*.apricity.json")):
            return root / "samples"
    sys.exit("no samples/ folder with manifests found above here")


def note_name(midi: int) -> str:
    return f"{NAMES[midi % 12]}{midi // 12 - 1}"


def first_note(notes: list, start: float, end: float) -> str:
    """What a pitched track hears, by the compiler's rule (crates/apricity-score/src/manifest.rs,
    `Clip::pitch`): of the notes starting from 30 ms before the clip to 120 ms after, the lowest one
    at least half as loud as the loudest there."""
    onset = [n for n in notes if start - 0.03 <= n["start"] <= min(start + 0.12, end)]
    if not onset:
        return ""
    loudest = max(n.get("velocity", 0) for n in onset)
    return note_name(min(n["midi"] for n in onset if n.get("velocity", 0) >= loudest * 0.5))


def main(args: list) -> None:
    verbose = "-v" in args
    filters = [a for a in args if not a.startswith("-")]
    base = samples_dir()
    for path in sorted(base.rglob("*.apricity.json")):
        rel = str(path.relative_to(base))[: -len(".apricity.json")]
        if filters and not all(f in rel for f in filters):
            continue
        m = json.loads(path.read_text())
        key = m.get("tonal", {}).get("key") or {}
        bpm = m.get("rhythm", {}).get("bpm")
        dur = m.get("source", {}).get("duration", 0)
        clips = m.get("annotations", {}).get("clips", [])
        head = f"{rel}  {key.get('tonic', '?')} {key.get('mode', '')}  {bpm or '-'} bpm  {dur:.0f}s"
        if not verbose:
            kinds = {}
            for c in clips:
                kinds.setdefault(c["name"].rsplit("-", 1)[0], []).append(c["name"])
            print(head + "  " + " ".join(f"{k}×{len(v)}" for k, v in kinds.items()))
            continue
        print(head)
        notes = m.get("notes", [])
        for c in clips:
            length = c["end"] - c["start"]
            note = first_note(notes, c["start"], c["end"]) if notes else ""
            tags = ",".join(t for t in c.get("tags", []) if not t.endswith("s"))
            print(f"  {c['name']:<10} {length:6.2f}s  {note:<4} {tags}")


if __name__ == "__main__":
    main(sys.argv[1:])
