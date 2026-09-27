"""Ported from the write-score skill's `notch-finder.py`: per stem, which exact notes (with
octave) sound off the chord, how much energy they carry, and under how many different chords
they're wrong -- EQ notch candidates for `search.py`'s proposal generator. Uses a CQT (one bin per
semitone, C2-B6) rather than the checker's 12-bin chroma, since a notch needs an actual frequency,
not just a pitch class.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np

PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
      "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def find_notches(stems_dir: pathlib.Path, stem_names: list[str], top_n: int = 6) -> dict[str, list[dict]]:
    """`{stem_name: [{"note", "hz", "share", "wrong_under": [chord labels]}, ...]}`, sorted by
    (most chords it's wrong under, then energy share), highest first."""
    import librosa

    d = pathlib.Path(stems_dir)
    meta = json.loads((d / "stems.json").read_text())
    spb = 60.0 / meta["tempo"]
    off = meta.get("offset_beats", 0.0)
    spans = meta.get("harmony", [])
    names = librosa.midi_to_note(range(36, 96), unicode=False)

    out: dict[str, list[dict]] = {}
    for stem in stem_names:
        path = d / f"{stem}.wav"
        if not path.exists():
            continue
        y, sr = librosa.load(path, sr=22050, mono=True)
        h = librosa.effects.harmonic(y, margin=3.0)
        C = np.abs(librosa.cqt(h, sr=sr, fmin=librosa.midi_to_hz(36), n_bins=60, hop_length=512))
        t = librosa.frames_to_time(np.arange(C.shape[1]), sr=sr, hop_length=512)
        total = C.sum()
        acc: dict[str, list] = {}
        for sp in spans:
            tones = {PC[x] if isinstance(x, str) else x for x in (sp.get("chord_tones") or [])}
            if not tones:
                continue
            a, b = (sp["start_beat"] - off) * spb, (sp["end_beat"] - off) * spb
            sel = (t >= a) & (t < b)
            if not sel.any():
                continue
            e = np.median(C[:, sel], axis=1) * sel.sum()
            for i in range(60):
                if (36 + i) % 12 not in tones and e[i] > 0:
                    k = names[i]
                    acc.setdefault(k, [0.0, set()])
                    acc[k][0] += float(e[i])
                    label = sp.get("label", "")
                    acc[k][1].add(label.split(" (")[1].rstrip(")") if " (" in label else label)
        ranked = sorted(acc.items(), key=lambda kv: (-len(kv[1][1]), -kv[1][0]))
        out[stem] = [
            {"note": k, "hz": float(librosa.note_to_hz(k)), "share": (v / total if total > 0 else 0.0), "wrong_under": sorted(ch)}
            for k, (v, ch) in ranked[:top_n]
        ]
    return out
