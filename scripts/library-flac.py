#!/usr/bin/env python3
"""Store a library's big WAV samples as lossless FLAC (about half the size, the same samples).

For every Sample whose audio is a WAV of at least --min-mb, it encodes a FLAC beside it
(files/audio/<id>/<name>.flac; the WAV is left in place: it may be hard-linked to the repo's samples/),
decodes both and checks they are sample-for-sample identical, and only then repoints the record's audio
(key, sha256, size, contentType). The Sample's id, path and aliases don't change, so every score that
names it (".../drums.wav") keeps working. Running it again skips what's done.

Afterwards: `apricity sync push` uploads the FLACs and records to the bucket, and the production Sample
records' `audio` are updated from the ids it prints (see --ids-out). Re-running `apricity migrate` from
the repo points records back at the WAVs; run this again after it.

Usage: analysis/.venv/bin/python scripts/library-flac.py --library ~/Apricity-Library [--min-mb 2] [--dry-run] [--ids-out FILE]
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def same_audio(a: Path, b: Path) -> bool:
    """Both decode to the same samples (as integers, so nothing is compared after rounding)."""
    ia, ib = sf.info(str(a)), sf.info(str(b))
    if (ia.samplerate, ia.channels, ia.frames) != (ib.samplerate, ib.channels, ib.frames):
        return False
    da, _ = sf.read(str(a), dtype="int32", always_2d=True)
    db, _ = sf.read(str(b), dtype="int32", always_2d=True)
    return np.array_equal(da, db)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", type=Path, required=True)
    ap.add_argument("--min-mb", type=float, default=2.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--ids-out", type=Path, help="write the converted Sample ids here, one per line")
    args = ap.parse_args()
    lib = args.library.expanduser()
    converted, saved = [], 0
    for rec_path in sorted((lib / "Sample").glob("*.json")):
        rec = json.loads(rec_path.read_text())
        audio = rec.get("audio") or {}
        key = audio.get("key", "")
        if not key.endswith(".wav"):
            continue
        wav = lib / "files" / key
        if not wav.exists() or wav.stat().st_size < args.min_mb * 2**20:
            continue
        flac_key = key[: -len(".wav")] + ".flac"
        flac = lib / "files" / flac_key
        print(f"{rec['id']}  {rec['path']}  {wav.stat().st_size / 2**20:.1f} MB", end="", flush=True)
        if args.dry_run:
            print("  (would convert)")
            continue
        tmp = flac.with_suffix(".flac.part")
        subprocess.run(["flac", "--silent", "--best", "--force", "--output-name", str(tmp), str(wav)], check=True)
        if not same_audio(wav, tmp):
            tmp.unlink(missing_ok=True)
            print("  DIFFERS after decoding: left as WAV", file=sys.stderr)
            return 1
        os.replace(tmp, flac)
        size = flac.stat().st_size
        rec["audio"] = {**audio, "key": flac_key, "sha256": sha256(flac), "size": size, "contentType": "audio/flac"}
        rec["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        tmp_rec = rec_path.with_suffix(".json.part")
        tmp_rec.write_text(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        os.replace(tmp_rec, rec_path)
        saved += wav.stat().st_size - size
        converted.append(rec["id"])
        print(f"  -> {size / 2**20:.1f} MB, identical")
    print(f"{len(converted)} converted, {saved / 2**20:.0f} MB smaller")
    if args.ids_out:
        args.ids_out.write_text("".join(f"{i}\n" for i in converted))
    return 0


if __name__ == "__main__":
    sys.exit(main())
