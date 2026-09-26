"""apricity-analyze: write <clip>.apricity.json manifests for audio files or folders."""

from __future__ import annotations

import argparse
import pathlib
import sys
import time

AUDIO = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="apricity-analyze", description=__doc__)
    ap.add_argument("paths", nargs="+", type=pathlib.Path, help="audio files or folders (searched recursively)")
    ap.add_argument("--no-notes", action="store_true", help="skip Basic Pitch note transcription (faster)")
    ap.add_argument("--force", action="store_true", help="re-analyze even if the manifest matches the audio")
    ap.add_argument("--no-markup", action="store_true", help="skip automatic sections/loops/hits markup")
    ap.add_argument("--denoise", default="off", metavar="SPEC",
                    help="analyze a noise-reduced copy (<name>.clean.wav, made if missing) instead of the file: "
                         "BACKEND[+BACKEND][:STRENGTH], e.g. neural:medium; the original is untouched. Default off.")
    args = ap.parse_args(argv)

    from .analyze import analyze, manifest_path, write
    import hashlib
    import json

    files = []
    for p in args.paths:
        files += sorted(f for f in p.rglob("*") if f.suffix.lower() in AUDIO) if p.is_dir() else [p]

    from . import denoise

    spec = denoise.parse_spec(args.denoise)
    jobs, seen = [], set()  # (file to analyze, its denoise record or None)
    for f in files:
        rec = None
        if spec and ".clean." in f.name:
            continue  # made from its original below
        if spec:
            chain, strength = spec
            clean = denoise.clean_path(f)
            if not clean.exists():
                print(f"  denoising   {f.name} ({args.denoise})", flush=True)
                denoise.clean(f, chain, strength, clean)
            rec, f = {"backend": "+".join(chain), "strength": strength, "original": f.name}, clean
        if f not in seen:
            seen.add(f)
            jobs.append((f, rec))

    failed = 0
    for f, rec in jobs:
        mp = manifest_path(f.resolve())
        if not args.force and mp.exists():
            old = json.loads(mp.read_text())
            if old.get("source", {}).get("sha256") == hashlib.sha256(f.read_bytes()).hexdigest():
                print(f"  up to date  {f}")
                continue
        t0 = time.time()
        try:
            m = analyze(f, with_notes=not args.no_notes)
        except Exception as e:  # keep going over a folder; report at the end
            failed += 1
            print(f"  FAILED      {f}: {e}", file=sys.stderr)
            continue
        if rec:
            m["source"]["denoise"] = rec
        write(m, f)
        if not args.no_markup:
            from .markup import run as markup

            markup(f)
        k, r = m["tonal"]["key"], m["rhythm"]
        print(f"  {time.time() - t0:5.1f}s  {f.name[:48]:48}  {r['bpm'] or '-':>7} bpm  "
              f"{k['tonic']:>2} {k['mode']:5} ({k['camelot']:>3})  A={m['tonal']['tuning_hz']} Hz"
              f"  {len(m.get('notes', []))} notes")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
