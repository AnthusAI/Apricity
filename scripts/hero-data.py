#!/usr/bin/env python3
"""Bake the landing page's hero story from real material: examples/hero.apr.

Writes web/src/ui/flow/hero-data.json with, for the horns (track `h`): the waveform around their
slice (min/max peaks, as bytes), the beats the analysis found, the transients in the audio, the
slice, its chops, and every place a chop lands in the compiled score (with its transposition). For
the drum kit (the Salamander one-shots on the `drums.*` tracks), the pads laid end to end as one
strip, each pad a "chop", and every hit in the score mapped back to its pad.

It also writes the story's sound INTO A LIBRARY (the folder `apricity migrate` makes), as ordinary
library files under the fixed key prefix `hero/` (design/storage.md section 3.3: the library's
`files/` folder holds exactly the S3 keys):

    files/hero/horns-source.mp3  the horns (other) stem window as recorded, levelled to about -18 dBFS RMS
    files/hero/drums-source.mp3  the kit's pads end to end, as recorded, likewise
    files/hero/h-track.mp3       track h of examples/hero.apr rendered alone by the real engine
    files/hero/drums-track.mp3   every drums.* track, rendered together

The tracks carry the gain (gain_db in hero-data.json) that puts each back at its level in the full
mix. Being plain non-dot files they are picked up by `apricity sync push`, are served at
/files/hero/<name>.mp3 by `apricity serve --library`, and live in the bucket at files/hero/<name>.mp3.
The web app fetches them through web/src/data/files.ts, so the same key works locally and in the cloud.
The MP3s are never committed (*.mp3 is git-ignored); a fresh clone plays the hero silently until the
library has them. Everything is derived from the library's own stems and manifests: the script builds
a temporary samples folder of symlinks into the library, so no absolute path from any machine reaches
hero-data.json, which holds only library-relative keys.

    PATH=~/.cargo/bin:$PATH cargo build -p apricity-cli
    target/debug/apricity migrate --from . --to ~/Apricity.library --link   # or a fetched library
    analysis/.venv/bin/python scripts/hero-data.py --library ~/Apricity.library
"""

import argparse
import sys

import base64
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
SCORE = ROOT / "examples/hero.apr"
OUT = ROOT / "web/src/ui/flow/hero-data.json"
HERO_PREFIX = "hero"  # library key prefix of the hero audio: files/hero/<name>.mp3
NEEDS_LIBRARY = "the library lacks the Thunderer stems or the Salamander kit the hero is cut from: run apricity sources fetch salamander-drumkit, then apricity migrate"
COLUMNS = 600  # peak columns across each source window

PAD_SECONDS = 0.45  # each kit pad's stretch in the strip the story shows and plays
PAD_ORDER = ["kick", "snare", "ghost", "stick", "hat", "open", "tom", "floor", "crash"]

# The two stories the hero tells, in order: a sliced loop (its track, and how its slice was cut),
# then a kit of one-shots (the tracks that play its pads).
STORIES = [
    {"kind": "loop", "lane": "h", "tracks": ["h"], "name": "horns", "title": "The Thunderer — horns", "credit": "Sousa, 1889 · US Marine Band · horn stem", "slice": "riff", "chop_beats": 1.0, "key": True},
    {"kind": "kit", "lane": "drums", "tracks": ["drums.kick", "drums", "drums.hat", "drums.open", "drums.crash"], "name": "drums", "title": "Salamander Drumkit — drums", "credit": "Alexander Holm · CC BY-SA 3.0 · one-shots, overhead mic", "slice": "kit"},
]


def find_exe() -> Path:
    """$APRICITY, else the newer of target/release and target/debug (as the smoke scripts do)."""
    if os.environ.get("APRICITY"):
        return Path(os.environ["APRICITY"])
    found = [p for p in (ROOT / "target/release/apricity", ROOT / "target/debug/apricity") if p.exists()]
    if not found:
        sys.exit("apricity binary not found: cargo build -p apricity-cli")
    return max(found, key=lambda p: p.stat().st_mtime)


EXE = None  # set in main()
SAMPLES = None  # temporary samples folder of symlinks into the library
KEYS = {}  # samples-relative clip path -> the library key of its audio


def records(library: Path, model: str) -> dict[str, list[dict]]:
    """A model's records, grouped by the clip they belong to."""
    out: dict[str, list[dict]] = {}
    for f in (library / model).glob("*.json") if (library / model).is_dir() else []:
        r = json.loads(f.read_text())
        out.setdefault(r.get("clipId"), []).append(r)
    return out


def annotations(slices: list[dict], markers: list[dict]) -> dict:
    """The manifest's `annotations`, as crates/apricity-data/src/loader.rs builds them from the
    library's Slice and Marker records."""
    clips = []
    for s in sorted(slices, key=lambda s: (s["start"], s["name"])):
        c = {"name": s["name"], "start": s["start"], "end": s["end"], "source": s["source"]}
        for a, b in (("tags", "tags"), ("candidateId", "candidate"), ("retired", "retired")):
            if a in s:
                c[b] = s[a]
        if isinstance(s.get("evidence"), str):
            c["evidence"] = json.loads(s["evidence"])
        clips.append(c)
    marks = []
    for m in sorted(markers, key=lambda m: (m["seconds"], m["name"])):
        marks.append({k: m[k] for k in ("name", "seconds", "source", "note") if k in m})
    return {"clips": clips, "markers": marks}


def link_samples(library: Path, tmp: Path):
    """Lay the library's clips out as a samples folder the engine reads: <path> (a symlink into
    files/) and <path>.apricity.json (the clip's analysis plus its annotations from the library's
    records). Nothing large is copied."""
    global SAMPLES
    SAMPLES = tmp / "samples"
    slices, markers = records(library, "Slice"), records(library, "Marker")
    for rec in sorted((library / "Clip").glob("*.json")):
        c = json.loads(rec.read_text())
        audio, analysis = (c.get("audio") or {}).get("key"), (c.get("analysis") or {}).get("key")
        if not (c.get("path") and audio and analysis):
            continue
        a, m = library / "files" / audio, library / "files" / analysis
        if not (a.is_file() and m.is_file()):
            continue  # not downloaded
        dest = SAMPLES / c["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.symlink_to(a.resolve())
        manifest = json.loads(m.read_text())
        manifest["annotations"] = annotations(slices.get(c["id"], []), markers.get(c["id"], []))
        Path(str(dest) + ".apricity.json").write_text(json.dumps(manifest))
        KEYS[c["path"]] = audio
    if not SAMPLES.is_dir():
        sys.exit(NEEDS_LIBRARY)


def score_text() -> str:
    return SCORE.read_text().replace("samples ../samples", f"samples {SAMPLES}")


def compile_score(tmp: Path):
    score = tmp / "hero.apr"
    score.write_text(score_text())
    out = subprocess.run([str(EXE), "compile", str(score)], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"{NEEDS_LIBRARY}\n{out.stderr.strip()}")
    return json.loads(out.stdout)


def mp3(wav: Path, out: Path, mono=False, kbps=96):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), *(["-ac", "1"] if mono else []), "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", str(out)], check=True)


def render_tracks(tracks: list[str], tmp: Path):
    """Render the score with only `tracks`, return (wav, master make-up dB)."""
    text = score_text()
    keep = [ln for ln in text.splitlines() if not (m := re.match(r"track\s+(\S+)", ln)) or m.group(1) in tracks]
    score = tmp / f"{'-'.join(tracks)[:80]}.apr"
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
    global EXE
    ap = argparse.ArgumentParser(description="Bake the hero story: hero-data.json, and its audio into a library.")
    ap.add_argument("--library", required=True, type=Path, help="library folder made by apricity migrate (or a fetched one)")
    args = ap.parse_args()
    library = args.library.resolve()
    if not (library / "apricity-library.json").is_file():
        sys.exit(f"{library} is not an Apricity library (no apricity-library.json)")
    AUDIO = library / "files" / HERO_PREFIX
    EXE = find_exe()
    with tempfile.TemporaryDirectory() as t:
        bake(library, AUDIO, Path(t))


def kit_strip(tl, story, tmp: Path):
    """A kit of one-shots, told like a recording: its pads end to end, PAD_SECONDS each."""
    kit = next(t for t in tl["tracks"] if t["name"] == story["lane"])
    by_name = {p["name"]: p for p in kit["pieces"]}
    used = {name for t in story["tracks"] for name in hits_of(tl, t, kit)}
    pads = [n for n in PAD_ORDER if n in used] + sorted(used - set(PAD_ORDER))
    sr, strip = 48000, []
    for name in pads:
        path = Path(tl["sources"][by_name[name]["source"]]["path"])
        x, r = sf.read(str(path), frames=int(PAD_SECONDS * sf.info(str(path)).samplerate), always_2d=True)
        x = x.mean(axis=1)
        if r != sr:
            x = np.interp(np.arange(int(len(x) * sr / r)) * r / sr, np.arange(len(x)), x)
        x = np.pad(x, (0, max(0, int(PAD_SECONDS * sr) - len(x))))[: int(PAD_SECONDS * sr)]
        fade = int(0.03 * sr)
        x[-fade:] *= np.linspace(1, 0, fade)
        strip.append(x)
    wav = tmp / "kit-strip.wav"
    sf.write(str(wav), np.concatenate(strip), sr)
    return wav, pads, kit


def hits_of(tl, track: str, kit) -> list[str]:
    """The pad each note of a kit track plays: `drums` names its pad per note, `drums.hat` is one pad."""
    evs = [e for e in tl["events"] if e["track"] == track]
    if "." in track:
        return [track.split(".", 1)[1]] * len(evs)
    return [kit["pieces"][e["piece"]]["name"] for e in evs]


def bake(library: Path, AUDIO: Path, tmp: Path):
    link_samples(library, tmp)
    tl = compile_score(tmp)
    sources = []
    tiles = []
    strips = {}
    for n, story in enumerate(STORIES):
        if story["kind"] == "kit":
            wav, pads, kit = kit_strip(tl, story, tmp)
            total = round(len(pads) * PAD_SECONDS, 4)
            chops = [[round(i * PAD_SECONDS, 4), round((i + 1) * PAD_SECONDS, 4)] for i in range(len(pads))]
            strips[story["name"]] = wav
            first = next(p for p in kit["pieces"] if p["name"] == pads[0])
            sources.append({
                "id": story["name"],
                "kind": "kit",
                "title": story["title"],
                "credit": story["credit"],
                "path": KEYS[Path(tl["sources"][first["source"]]["path"]).relative_to(SAMPLES).as_posix()],
                "window": [0, total],
                "peaks": peaks(wav, 0, total),
                "beats": [],
                "downbeats": [],
                "transients": [c[0] for c in chops],
                "bpm": tl["tempo"],
                "meter": tl["meter"],
                "key": None,
                "tuning_cents": 0,
                "slice": {"name": story["slice"], "from": 0, "to": total, "machine": story["slice"]},
                "chop_beats": 0,
                "chops": chops,
                "pads": pads,
                "lane": story["lane"],
            })
            for track in story["tracks"]:
                evs = [e for e in tl["events"] if e["track"] == track]
                for e, pad in zip(evs, hits_of(tl, track, kit)):
                    tiles.append({"source": n, "chop": pads.index(pad), "start": round(e["start_beat"], 4), "dur": round(e["dur_beats"], 4), "semitones": 0, "cont": False})
            continue
        track = next(t for t in tl["tracks"] if t["name"] == story["lane"])
        evs = [e for e in tl["events"] if e["track"] in story["tracks"]]
        src = tl["sources"][evs[0]["source"]]
        audio = Path(src["path"])
        rel = audio.relative_to(SAMPLES).as_posix()
        m = json.loads(Path(str(audio) + ".apricity.json").read_text())
        beats = m["rhythm"]["beats"]

        # The region the score slices (a saved loop, or the clip's `beats a..b`), and its chops.
        first = min(e["src_start"] for e in evs)
        loop = next((s for s in m["annotations"]["clips"] if s["start"] <= first + 1e-6 < s["end"] and s["name"].startswith("loop")), None)
        pieces = track["pieces"]
        slice_ = {"name": loop["name"] if loop else "beats", "start": pieces[0]["src_start"], "end": pieces[-1]["src_end"], "tags": (loop or {}).get("tags", [])}
        chops = [[round(p["src_start"], 4), round(p["src_end"], 4)] for p in pieces]

        # A window of context around the slice: one slice-length either side.
        span = slice_["end"] - slice_["start"]
        w0, w1 = slice_["start"] - span, slice_["end"] + span
        in_w = lambda s: w0 <= s <= w1
        loop_key = track.get("region_key") if story["key"] else None
        sources.append({
            "id": story["name"],
            "kind": "loop",
            "title": story["title"],
            "credit": story["credit"],
            "path": KEYS[rel],  # the library key of the recording, never a machine path
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
            "lane": story["lane"],
        })

        # Every event, mapped back to the chop it plays. Events split at a chord change start
        # mid-chop; they are continuations (`cont`) of the chop that contains them.
        for e in evs:
            s = e["src_start"]
            i = next((k for k, (a, b) in enumerate(chops) if a - 0.01 <= s < b - 0.005), None)
            assert i is not None, f"event at {s}s is in no chop of {story['lane']}"
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
    tracks_of = {st["name"]: st["tracks"] for st in STORIES}
    for src in sources:
        name = f"{src['id']}-source.mp3"
        if src["kind"] == "kit":
            source_audio(strips[src["id"]], *src["window"], AUDIO / name, tmp)
        else:
            source_audio(SAMPLES / next(k for k, v in KEYS.items() if v == src["path"]), *src["window"], AUDIO / name, tmp)
        audio["sources"].append(f"{HERO_PREFIX}/{name}")
    _, full = render_tracks([t for src in sources for t in tracks_of[src["id"]]], tmp)
    for src in sources:
        wav, makeup = render_tracks(tracks_of[src["id"]], tmp)
        name = f"{src['lane']}-track.mp3"
        mp3(wav, AUDIO / name)
        audio["tracks"].append({"key": f"{HERO_PREFIX}/{name}", "gain_db": round(full - makeup, 2)})

    data = {
        "score": "examples/hero.apr",
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
    print(f"wrote {AUDIO}/ ({kb:.0f} KB of audio; library keys {HERO_PREFIX}/*.mp3)")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.1f} KB): "
          + ", ".join(f"{s['id']}: {len(s["chops"])} slices, {sum(t['source'] == i for t in tiles)} tiles" for i, s in enumerate(sources)))


if __name__ == "__main__":
    main()
