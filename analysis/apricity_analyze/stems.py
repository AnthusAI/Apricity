"""Split recordings into stems (drums, bass, other, vocals) with Demucs, and analyze each stem.

    PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.stems samples/marine-band/WashingtonPost.mp3

Stems go to <folder>/stems/<name>/<stem>.wav next to the original. Each stem gets its own
manifest, but reuses the *parent's* beat grid: beat tracking on an isolated bass line or horn
part is unreliable, and sharing the grid keeps stems of one recording locked together.
Stems that are essentially silent (e.g. vocals in a band march) are skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time

import numpy as np

MODEL = "htdemucs"
SILENT_DBFS = -45.0


def stem_dir(audio: pathlib.Path) -> pathlib.Path:
    return audio.parent / "stems" / audio.stem


def separate(audio: pathlib.Path, threads: int = 4) -> dict[str, np.ndarray]:
    import torch
    import essentia.standard as es
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    torch.set_num_threads(threads)
    model = get_model(MODEL)
    model.eval()
    wav, sr, ch, *_ = es.AudioLoader(filename=str(audio))()
    if sr != model.samplerate:
        wav = np.stack([es.Resample(inputSampleRate=sr, outputSampleRate=model.samplerate)(wav[:, c].copy()) for c in range(wav.shape[1])], axis=1)
    if wav.shape[1] == 1:
        wav = np.repeat(wav, 2, axis=1)
    x = torch.from_numpy(np.ascontiguousarray(wav.T[:2], dtype=np.float32))
    ref = x.mean(0)
    x = (x - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        out = apply_model(model, x[None], split=True, overlap=0.25, progress=False)[0]
    out = out * (ref.std() + 1e-8) + ref.mean()
    return {name: out[i].numpy().T for i, name in enumerate(model.sources)}, model.samplerate


def run(audio: pathlib.Path, with_notes: bool = True, threads: int = 4) -> list[pathlib.Path]:
    import soundfile as sf
    from .analyze import analyze, write

    audio = audio.resolve()
    parent_manifest = audio.with_name(audio.name + ".apricity.json")
    if not parent_manifest.exists():
        raise SystemExit(f"{audio}: analyze it first (apricity-analyze), so stems can share its beat grid")
    parent = json.loads(parent_manifest.read_text())
    stems, sr = separate(audio, threads)
    out_dir = stem_dir(audio)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    root = pathlib.Path(__file__).resolve().parents[2]
    for name, data in stems.items():
        rms = float(np.sqrt(np.mean(data**2)) + 1e-12)
        if 20 * np.log10(rms) < SILENT_DBFS:
            print(f"    skip {name:7} (silent)")
            continue
        path = out_dir / f"{name}.wav"
        sf.write(path, data, sr, subtype="PCM_16")
        m = analyze(path, with_notes=with_notes and name != "drums", rhythm_from=parent)
        m["derived_from"] = {"source": str(audio.relative_to(root)), "stem": name, "model": MODEL}
        write(m, path)
        from .markup import run as markup

        markup(path)
        k = m["tonal"]["key"]
        print(f"    {name:7} {20 * np.log10(rms):6.1f} dBFS  key {k['tonic']} {k['mode']}")
        written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="apricity-stems", description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="+", type=pathlib.Path)
    ap.add_argument("--no-notes", action="store_true")
    ap.add_argument("--threads", type=int, default=4, help="CPU threads for Demucs (default 4, to keep the machine responsive)")
    args = ap.parse_args(argv)
    try:
        os.nice(10)
    except OSError:
        pass
    for f in args.files:
        t0 = time.time()
        print(f"{f}")
        run(f, with_notes=not args.no_notes, threads=args.threads)
        print(f"    done in {time.time() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
