"""Backfill rhythm.beat_loudness and rhythm.loudness into existing manifests (cheap; no re-analysis).

    PYTHONPATH=analysis analysis/.venv/bin/python -m apricitus_analyze.loudness samples
"""

import json
import pathlib
import sys

from .analyze import beat_loudness, time_loudness, validate


def main(paths: list[str]) -> int:
    for root in map(pathlib.Path, paths):
        for mpath in sorted(root.rglob("*.apricitus.json")) if root.is_dir() else [root]:
            m = json.loads(mpath.read_text())
            audio = mpath.with_name(mpath.name[: -len(".apricitus.json")])
            m["rhythm"]["beat_loudness"] = beat_loudness(audio, m["rhythm"]["beats"])
            m["rhythm"]["loudness"] = time_loudness(audio)
            validate(m)
            mpath.write_text(json.dumps(m, indent=1) + "\n")
            print(f"  {mpath.relative_to(root.parent if root.is_dir() else root.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["samples"]))
