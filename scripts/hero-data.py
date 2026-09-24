#!/usr/bin/env python3
"""Bake the landing page's hero story from real material: examples/chop-shop.apr.

Writes web/src/ui/flow/hero-data.json with, for the break (track `b`) and the horns (track `h`):
the waveform around each slice (min/max peaks, as bytes), the beats the analysis found, the
transients in the audio, the slice, its chops, and every place a chop lands in the compiled score
(with its transposition).

It also writes the story's sound to web/public/hero/: each source window as heard, and each track
rendered alone by the real engine (warped and tuned), with the gain that puts it back at its level
in the full mix. The samples are git-ignored; these outputs are committed, so the landing page
needs no server.

    PATH=~/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH cargo build -p apricity-cli
    analysis/.venv/bin/python scripts/hero-data.py
"""

import base64
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
SCORE = ROOT / "examples/chop-shop.apr"
OUT = ROOT / "web/src/ui/flow/hero-data.json"
AUDIO = ROOT / "web/public/hero"  # served at /hero/
EXE = ROOT / "target/debug/apricity"
COLUMNS = 600  # peak columns across each source window

# The two stories the hero tells, in order: which track, and how its slice was cut.
STORIES = [
    {"track": "b", "name": "brk", "title": "The Thunderer — drums", "credit": "Sousa, 1889 · US Marine Band · drum stem", "slice": "break", "chop_beats": 0.5, "key": False},
    {"track": "h", "name": "horns", "title": "The Thunderer — horns", "credit": "Sousa, 1889 · US Marine Band · horn stem", "slice": "riff", "chop_beats": 1.0, "key": True},
]


def compile_score():
    out = subprocess.run([str(EXE), "compile", str(SCORE)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def mp3(wav: Path, out: Path, mono=False, kbps=96):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), *(["-ac", "1"] if mono else []), "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", str(out)], check=True)


def render_tracks(tracks: list[str], tmp: Path):
    """Render the score with only `tracks`, return (wav, master make-up dB)."""
    text = SCORE.read_text().replace("samples ../samples", f"samples {ROOT / 'samples'}")
    keep = [ln for ln in text.splitlines() if not (m := re.match(r"track\s+(\S+)", ln)) or m.group(1) in tracks]
    score = tmp / f"{'-'.join(tracks)}.apr"
    score.write_text("\n".join(keep) + "\n")
    wav = score.with_suffix(".wav")
    out = subprocess.run([str(EXE), "render", str(score), "-o", str(wav)], capture_output=True, text=True, check=True)
    makeup = float(re.search(r"make-up ([+-][\d.]+) dB", out.stdout + out.stderr).group(1))
    return wav, makeup


def source_audio(path: Path, t0: float, t1: float, out: Path, tmp: Path):
    """The window as recorded, at a steady level (about −18 dBFS RMS) to sit with the renders."""
    info = sf.info(str(path))
    x, sr = sf.read(str(path), start=int(t0 * info.samplerate), stop=int(t1 * info.samplerate), always_2d=True)
    x = x.mean(axis=1)
    x *= 10 ** (-18 / 20) / max(1e-9, np.sqrt(np.mean(x**2)))
    x = np.clip(x, -0.98, 0.98)
    wav = tmp / (out.stem + ".wav")
    sf.write(str(wav), x, sr)
    mp3(wav, out, mono=True, kbps=64)


def peaks(path: Path, t0: float, t1: float):
    info = sf.info(str(path))
    a = int(max(0, t0) * info.samplerate)
    b = int(min(info.duration, t1) * info.samplerate)
    x, _ = sf.read(str(path), start=a, stop=b, always_2d=True)
    x = x.mean(axis=1)
    cols = np.array_split(x, COLUMNS)
    lo = np.array([c.min() if len(c) else 0 for c in cols])
    hi = np.array([c.max() if len(c) else 0 for c in cols])
    scale = max(1e-9, np.abs(np.concatenate([lo, hi])).max())
    q = np.empty(COLUMNS * 2, dtype=np.int8)
    q[0::2] = np.round(lo / scale * 127)
    q[1::2] = np.round(hi / scale * 127)
    return base64.b64encode(q.tobytes()).decode()


def transients(path: Path, t0: float, t1: float):
    """Onsets in the window, like Live's transient markers: jumps in a short-time energy envelope."""
    info = sf.info(str(path))
    a = int(max(0, t0) * info.samplerate)
    x, _ = sf.read(str(path), start=a, stop=int(min(info.duration, t1) * info.samplerate), always_2d=True)
    x = x.mean(axis=1)
    hop = int(0.01 * info.samplerate)
    env = np.array([np.sqrt(np.mean(x[i:i + 2 * hop] ** 2)) for i in range(0, len(x) - 2 * hop, hop)])
    env = 20 * np.log10(env + 1e-6)
    rise = np.maximum(0, np.diff(env, prepend=env[0]))
    thresh = rise.mean() + 2.5 * rise.std()
    out, last = [], -1.0
    for i in range(1, len(rise) - 1):
        t = t0 + i * hop / info.samplerate
        if rise[i] > thresh and rise[i] >= rise[i - 1] and rise[i] >= rise[i + 1] and t - last > 0.09:
            out.append(round(t, 4))
            last = t
    return out


def beat_to_sec(beats: list[float], b: float) -> float:
    """Clip beat (index into the manifest's beat list, fractional) to seconds."""
    i = int(np.floor(b))
    i = max(0, min(len(beats) - 2, i))
    return beats[i] + (b - i) * (beats[i + 1] - beats[i])


def sec_to_beat(beats: list[float], s: float) -> float:
    return float(np.interp(s, beats, np.arange(len(beats))))


def main():
    tl = compile_score()
    sources = []
    tiles = []
    for n, story in enumerate(STORIES):
        track = next(t for t in tl["tracks"] if t["name"] == story["track"])
        evs = [e for e in tl["events"] if e["track"] == story["track"]]
        src = tl["sources"][evs[0]["source"]]
        audio = ROOT / src["path"]
        m = json.loads(Path(str(audio) + ".apricity.json").read_text())
        beats = m["rhythm"]["beats"]

        # The slice the score chops, and its chops (equal steps in clip beats).
        first = min(e["src_start"] for e in evs)
        slice_ = next(s for s in m["annotations"]["slices"] if s["start"] <= first + 1e-6 < s["end"] and s["name"].startswith("loop"))
        b0, b1 = sec_to_beat(beats, slice_["start"]), sec_to_beat(beats, slice_["end"])
        count = track["chops"]
        step = (b1 - b0) / count
        chops = [[round(beat_to_sec(beats, b0 + i * step), 4), round(beat_to_sec(beats, b0 + (i + 1) * step), 4)] for i in range(count)]
        chops[0][0], chops[-1][1] = slice_["start"], slice_["end"]

        # A window of context around the slice: one slice-length either side.
        span = slice_["end"] - slice_["start"]
        w0, w1 = slice_["start"] - span, slice_["end"] + span
        in_w = lambda s: w0 <= s <= w1
        loop_key = next((t for t in slice_.get("tags", []) if t[:1].isupper()), None) if story["key"] else None
        sources.append({
            "id": story["name"],
            "title": story["title"],
            "credit": story["credit"],
            "path": src["path"],
            "window": [round(w0, 4), round(w1, 4)],
            "peaks": peaks(audio, w0, w1),
            "beats": [round(b, 4) for b in beats if in_w(b)],
            "downbeats": [round(b, 4) for b in m["rhythm"]["downbeats"] if in_w(b)],
            "transients": transients(audio, w0, w1),
            "bpm": m["rhythm"]["bpm"],
            "meter": m["rhythm"]["meter"],
            "key": loop_key,
            "tuning_cents": m["tonal"].get("tuning_cents", 0),
            "slice": {"name": story["slice"], "from": slice_["start"], "to": slice_["end"], "machine": slice_["name"]},
            "chop_beats": story["chop_beats"],
            "chops": chops,
            "lane": story["track"],
        })

        # Every event, mapped back to the chop it plays. Events split at a chord change start
        # mid-chop; they are continuations (`cont`) of the chop that contains them.
        for e in evs:
            s = e["src_start"]
            i = next((k for k, (a, b) in enumerate(chops) if a - 0.01 <= s < b - 0.005), None)
            assert i is not None, f"event at {s}s is in no chop of {story['track']}"
            tiles.append({
                "source": n,
                "chop": i,
                "start": round(e["start_beat"], 4),
                "dur": round(e["dur_beats"], 4),
                "semitones": e["semitones"],
                "cont": abs(s - chops[i][0]) > 0.01,
            })

    chords = []
    for h in tl["harmony"]:
        label = h["label"]
        numeral, _, name = label.partition(" (")
        chords.append({"start": h["start_beat"], "end": h["end_beat"], "numeral": numeral, "name": name.rstrip(")")})

    # The sound: each source window, and each track alone, rendered by the engine.
    AUDIO.mkdir(parents=True, exist_ok=True)
    audio = {"sources": [], "tracks": []}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for src in sources:
            name = f"{src['id']}-source.mp3"
            source_audio(ROOT / src["path"], *src["window"], AUDIO / name, tmp)
            audio["sources"].append(f"hero/{name}")
        _, full = render_tracks([s["lane"] for s in sources], tmp)
        for src in sources:
            wav, makeup = render_tracks([src["lane"]], tmp)
            name = f"{src['lane']}-track.mp3"
            mp3(wav, AUDIO / name)
            audio["tracks"].append({"url": f"hero/{name}", "gain_db": round(full - makeup, 2)})

    data = {
        "score": "examples/chop-shop.apr",
        "audio": audio,
        "tempo": tl["tempo"],
        "meter": tl["meter"],
        "key": tl["key"],
        "beats": tl["length_beats"],
        "chords": chords,
        "sources": sources,
        "tiles": tiles,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    kb = sum(f.stat().st_size for f in AUDIO.glob("*.mp3")) / 1024
    print(f"wrote {AUDIO.relative_to(ROOT)}/ ({kb:.0f} KB of audio)")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.1f} KB): "
          + ", ".join(f"{s['id']}: {len(s['chops'])} chops, {sum(t['source'] == i for t in tiles)} tiles" for i, s in enumerate(sources)))


if __name__ == "__main__":
    main()
