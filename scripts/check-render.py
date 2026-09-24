#!/usr/bin/env python3
"""Round-trip check for a Apricity render: re-analyze the WAV and compare it with the score.

    scripts/check-render.py examples/iv-of-ab-minor.yaml renders/iv-of-ab-minor.wav

Reports how far detected beats sit from the score's grid, the tuning of the mix, and for each
chord span the share of pitch-class energy on the target chord's tones (3 random notes ≈ 25%).
"""

import json
import pathlib
import subprocess
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def main(score: str, wav: str) -> None:
    tl = json.loads(subprocess.run([str(ROOT / "target/release/apricity"), "compile", score], check=True, capture_output=True, text=True).stdout)
    from apricity_analyze.analyze import SR, analyze, write  # noqa: F401  (heavy imports after arg parsing)

    m = analyze(pathlib.Path(wav), with_notes=False)
    write(m, pathlib.Path(wav))
    spb = 60 / tl["tempo"]
    beats = np.array(m["rhythm"]["beats"])
    err = np.abs(beats / spb - np.round(beats / spb)) * spb * 1000
    print(f"tempo: detected {m['rhythm']['bpm']} BPM, score {tl['tempo']}")
    print(f"beats vs score grid: median {np.median(err):.0f} ms, 90th percentile {np.percentile(err, 90):.0f} ms")
    print(f"tuning of the mix: A = {m['tonal']['tuning_hz']} Hz ({m['tonal']['tuning_cents']:+.0f}¢)")

    # Chroma per chord span, straight from frames (independent of the detected beats).
    import essentia.standard as es
    from apricity_analyze.analyze import FRAME, HOP

    audio = es.MonoLoader(filename=wav, sampleRate=SR)()
    w, spec = es.Windowing(type="blackmanharris62"), es.Spectrum()
    peaks = es.SpectralPeaks(orderBy="magnitude", magnitudeThreshold=1e-5, minFrequency=40, maxFrequency=5000, maxPeaks=60, sampleRate=SR)
    hpcp = es.HPCP(size=12, referenceFrequency=440.0, harmonics=8, bandPreset=True, minFrequency=40, maxFrequency=5000,
                   weightType="cosine", nonLinear=False, windowSize=1.0, sampleRate=SR)
    frames = [hpcp(*peaks(spec(w(f)))) for f in es.FrameGenerator(audio, frameSize=FRAME, hopSize=HOP, startFromZero=True)]
    chroma = np.roll(np.array(frames), 9, axis=1)
    times = (np.arange(len(chroma)) * HOP + FRAME / 2) / SR

    shares = []
    for span in tl["harmony"]:
        if not span["fit"]:
            continue
        tones = set(span["fit"]["chord_tones"])
        a, b = span["start_beat"] * spb, span["end_beat"] * spb
        p = chroma[(times >= a) & (times < b)].sum(axis=0)
        p = p / p.sum() if p.sum() > 0 else p
        share = sum(p[t] for t in tones)
        shares.append(share)
        top = " ".join(NAMES[i] for i in np.argsort(p)[::-1][:4])
        bar0 = span["start_beat"] / tl["meter"] + 1
        print(f"  bar {bar0:>4.0f}  {span['label']:<12} chord tones {' '.join(NAMES[t] for t in sorted(tones)):<10} share {share * 100:4.0f}%   strongest: {top}")
    if shares:
        print(f"mean chord-tone share {np.mean(shares) * 100:.0f}% (random ≈ 25%)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
