#!/usr/bin/env python3
"""Bake a score into a *breakdown*: the animated "how it was made" story the web app shows (the
landing hero is one), from real material and with no hand-written story data.

    analysis/.venv/bin/python scripts/breakdown.py examples/chop-shop.apr --library ~/Apricity-Library

Writes web/src/breakdowns/<slug>.json (the web app picks up every bundle there automatically) and
the breakdown's sound INTO THE LIBRARY as ordinary files under the key prefix breakdowns/<slug>/,
which `apricity sync push` sends to the bucket (guest-readable: web/amplify/storage/resource.ts).

What the story shows is derived from the compiled score. Every group of tracks that shares a kit or
a clip is one *source*, in the score's order:

  loop  a kit sliced from one recording: the waveform around the slice, its beats and transients,
        the slice, its chops, and every note mapped back to its chop (with its transposition);
  kit   a kit whose pads come from several recordings (drum one-shots): the pads end to end as
        one strip, each pad a chop;
  clip  a clip played whole: the window around its region, one chop.

Titles, credits and provenance come from the library's Recording and Clip records (title, composed,
recorded, performer, credit, rights, source page, stem). The bundle's title and blurb come from the
score's first comment line ("# Title — what it shows"). Anything can be overridden in an optional
sidecar, <score>.breakdown.yaml:

    title: The groove
    blurb: Horn stabs over a drum kit
    sources:                      # which sources to show, in order (default: all), and overrides
      - tracks: [h]
        title: The Thunderer — horns
      - tracks: [drums.kick, drums, drums.hat, drums.open, drums.crash]

The sound: each source as heard while it's analyzed (its window, levelled to about -18 dBFS RMS),
and each source's tracks rendered alone by the real engine, with the gain back to their mix level.
Everything is derived from the library's own files; bundles hold only library-relative keys.
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import yaml

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web/src/breakdowns"
PREFIX = "breakdowns"  # library key prefix of breakdown audio: files/breakdowns/<slug>/<name>.mp3
NEEDS_LIBRARY = "the library lacks samples this score uses: run apricity sources fetch / apricity migrate"
COLUMNS = 600  # peak columns across each source window
PAD_SECONDS = 0.45  # each kit pad's stretch in the strip the story shows and plays
PAD_ORDER = ["kick", "snare", "ghost", "stick", "clap", "hat", "open", "tom", "floor", "ride", "crash"]
STEMS = {"other": "horns", "drums": "drums", "bass": "bass", "vocals": "vocals", "piano": "piano", "guitar": "guitar"}

SCORE: Path = None  # the score being baked
EXE = None  # the apricity binary
SAMPLES = None  # temporary samples folder of symlinks into the library
KEYS = {}  # samples-relative clip path -> the library key of its audio
CLIPS = {}  # samples-relative clip path -> its Clip record


def find_exe() -> Path:
    """$APRICITY, else the newer of target/release and target/debug (as the smoke scripts do)."""
    if os.environ.get("APRICITY"):
        return Path(os.environ["APRICITY"])
    found = [p for p in (ROOT / "target/release/apricity", ROOT / "target/debug/apricity") if p.exists()]
    if not found:
        sys.exit("apricity binary not found: cargo build -p apricity-cli")
    return max(found, key=lambda p: p.stat().st_mtime)


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
        CLIPS[c["path"]] = c
    if not SAMPLES.is_dir():
        sys.exit(NEEDS_LIBRARY)


def score_text() -> str:
    return re.sub(r"^samples\s+\S+", f"samples {SAMPLES}", SCORE.read_text(), flags=re.M)


def compile_score(tmp: Path):
    score = tmp / "breakdown.apr"
    score.write_text(score_text())
    out = subprocess.run([str(EXE), "compile", str(score)], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"{NEEDS_LIBRARY}\n{out.stderr.strip()}")
    return json.loads(out.stdout)


def mp3(wav: Path, out: Path, mono=False, kbps=96):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), *(["-ac", "1"] if mono else []), "-codec:a", "libmp3lame", "-b:a", f"{kbps}k", str(out)], check=True)


def render_tracks(tracks: list[str], tmp: Path):
    """Render the score with only `tracks` (and the effect lines indented under them), return
    (wav, master make-up dB)."""
    keep, dropping = [], False
    for ln in score_text().splitlines():
        m = re.match(r"track\s+(\S+)", ln)
        if m:
            dropping = m.group(1) not in tracks
        elif ln[:1] not in (" ", "\t"):
            dropping = False
        if not dropping:
            keep.append(ln)
    score = tmp / f"{abs(hash(tuple(tracks)))}.apr"
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




# ---- what the score is made of


def groups(tl) -> list[dict]:
    """The score's sources: tracks grouped by the kit or clip they play, in the score's order."""
    kits = {t["kit"] for t in tl["tracks"] if t.get("kit")}
    out: dict[str, dict] = {}
    for t in tl["tracks"]:
        head = t["name"].split(".", 1)[0]
        key = t.get("kit") or (head if head in kits else t["clip"])
        out.setdefault(key, {"key": key, "tracks": []})["tracks"].append(t["name"])
    for g in out.values():
        kit = next((t for t in tl["tracks"] if t.get("kit") == g["key"]), None)
        if kit is None:
            g["kind"] = "clip"
        else:
            g["kind"] = "loop" if len({p["source"] for p in kit["pieces"]}) == 1 else "kit"
    return list(out.values())


def rel_of(tl, source: int) -> str:
    return Path(tl["sources"][source]["path"]).relative_to(SAMPLES).as_posix()


def recording(library: Path, rel: str) -> dict:
    clip = CLIPS.get(rel, {})
    f = library / "Recording" / f"{clip.get('recordingId', '')}.json"
    return json.loads(f.read_text()) if clip.get("recordingId") and f.is_file() else {}


def part_of(rel: str) -> str | None:
    """What part of a recording a clip is: a stem's name ("horns"), or None for the whole thing."""
    clip = CLIPS.get(rel, {})
    stem = clip.get("stem") or (Path(rel).stem if "/stems/" in rel else None)
    return STEMS.get(stem, stem) if stem else None


def licence(rights: str) -> str:
    """The short form of a rights statement: "CC BY-SA 3.0", "Public domain"."""
    m = re.search(r"CC[ -][A-Z-]+ ?[\d.]*|CC0|Public domain", rights or "", re.I)
    return m.group(0) if m else ""


def recording_of(library: Path, rel: str) -> dict:
    """One recording a source uses: what it is, when, by whom, and its rights."""
    rec = recording(library, rel)
    return {
        "title": rec.get("title") or Path(rel).stem,
        "part": part_of(rel),
        "composed": rec.get("composed"),
        "recorded": rec.get("recorded"),
        "performer": rec.get("performer"),
        "credit": rec.get("credit"),
        "rights": rec.get("rights"),
        "licence": licence(rec.get("rights", "")),
        "source_page": rec.get("sourcePage"),
    }


def provenance(library: Path, rels: list[str]) -> list[dict]:
    """Every recording a source's sounds come from, once each (a stem and its parts count once)."""
    out = []
    for r in (recording_of(library, rel) for rel in rels):
        same = next((o for o in out if o["title"] == r["title"]), None)
        if same is None:
            out.append({**r, "parts": [r["part"]] if r["part"] else []})
        elif r["part"] and r["part"] not in same["parts"]:
            same["parts"].append(r["part"])
    return out


def credit_line(recs: list[dict], kind: str) -> str:
    """The short credit under a source's title bar."""
    if len(recs) > 1:
        return f"one-shots from {len(recs)} recordings: " + ", ".join(r["title"] for r in recs)
    p = recs[0]
    bits = []
    if p["composed"]:
        bits.append(f"composed {p['composed']}")
    if p["recorded"]:
        bits.append(f"recorded {p['recorded']}" + (f" by {p['performer']}" if p["performer"] else ""))
    elif p["performer"]:
        bits.append(p["performer"])
    if not bits and p["credit"]:
        bits.append(p["credit"].rstrip("."))
    if p["licence"] and not p["composed"]:
        bits.append(p["licence"])
    if kind == "kit":
        bits.append("one-shots")
    elif p["part"]:
        bits.append(f"{p['part']} stem")
    return " · ".join(bits)


def title_line(recs: list[dict], kind: str, key: str) -> str:
    if len(recs) > 1:
        return "Drum kit" if kind == "kit" else f"{recs[0]['title']} and more"
    p = recs[0]
    part = p["part"] or (key if kind == "kit" else None)
    return f"{p['title']} — {part}" if part else p["title"]


def score_title() -> tuple[str, str]:
    """"# Title — what it shows", from the comment block the score opens with."""
    block = []
    for ln in SCORE.read_text().splitlines():
        if not ln.startswith("#"):
            break
        block.append(ln.lstrip("#").strip())
    text = " ".join(b for b in block if b)
    title, _, blurb = text.partition(" — ")
    return title or SCORE.stem, blurb


# ---- one source


def loop_source(tl, g, n, track):
    evs = [e for e in tl["events"] if e["track"] in g["tracks"]]
    audio = Path(tl["sources"][evs[0]["source"]]["path"])
    rel = audio.relative_to(SAMPLES).as_posix()
    m = json.loads(Path(str(audio) + ".apricity.json").read_text())
    beats = m["rhythm"]["beats"]
    pieces = track["pieces"]
    chops = [[round(p["src_start"], 4), round(p["src_end"], 4)] for p in pieces]
    s0, s1 = chops[0][0], chops[-1][1]
    first = min(e["src_start"] for e in evs)
    loop = next((s for s in m["annotations"]["clips"] if s["start"] <= first + 1e-6 < s["end"] and s["name"].startswith("loop")), None)
    span = s1 - s0
    w0, w1 = max(0.0, s0 - span), s1 + span
    in_w = lambda s: w0 <= s <= w1
    step = round(float(np.median(np.diff([sec_to_beat(beats, a) for a, _ in chops] + [sec_to_beat(beats, s1)]))), 3) if len(chops) > 1 else round(sec_to_beat(beats, s1) - sec_to_beat(beats, s0), 3)
    src = {
        "kind": "loop",
        "path": KEYS[rel],
        "window": [round(w0, 4), round(w1, 4)],
        "peaks": peaks(audio, w0, w1),
        "beats": [round(b, 4) for b in beats if in_w(b)],
        "downbeats": [round(b, 4) for b in m["rhythm"]["downbeats"] if in_w(b)],
        "transients": transients(audio, w0, w1),
        "bpm": m["rhythm"]["bpm"],
        "meter": m["rhythm"]["meter"],
        "key": track.get("region_key"),
        "tuning_cents": m["tonal"].get("tuning_cents", 0),
        "slice": {"name": track["clip"], "from": s0, "to": s1, "machine": loop["name"] if loop else "beats"},
        "chop_beats": step,
        "chops": chops,
        "lane": g["key"],
    }
    tiles = []
    for e in evs:
        s = e["src_start"]
        i = next((k for k, (a, b) in enumerate(chops) if a - 0.01 <= s < b - 0.005), None)
        if i is None:
            continue
        tiles.append({"source": n, "chop": i, "start": round(e["start_beat"], 4), "dur": round(e["dur_beats"], 4), "semitones": e["semitones"], "cont": abs(s - chops[i][0]) > 0.01})
    return src, tiles, audio, [rel]


def hits_of(tl, track: str, kit) -> list[str]:
    """The pad each note of a kit track plays: the kit track names its pad per note, `kit.pad` is one pad."""
    evs = [e for e in tl["events"] if e["track"] == track]
    if "." in track:
        return [track.split(".", 1)[1]] * len(evs)
    return [kit["pieces"][e["piece"]]["name"] for e in evs]


def kit_source(tl, g, n, kit, tmp):
    """A kit of one-shots, told like a recording: its pads end to end, PAD_SECONDS each."""
    by_name = {p["name"]: p for p in kit["pieces"]}
    used = {name for t in g["tracks"] for name in hits_of(tl, t, kit)}
    pads = [p for p in PAD_ORDER if p in used] + sorted(used - set(PAD_ORDER))
    sr, strip = 48000, []
    for name in pads:
        piece = by_name[name]
        path = Path(tl["sources"][piece["source"]]["path"])
        r = sf.info(str(path)).samplerate
        x, _ = sf.read(str(path), start=int(piece["src_start"] * r), frames=int(min(PAD_SECONDS, piece["src_end"] - piece["src_start"]) * r), always_2d=True)
        x = x.mean(axis=1)
        if r != sr:
            x = np.interp(np.arange(int(len(x) * sr / r)) * r / sr, np.arange(len(x)), x)
        x = np.pad(x, (0, max(0, int(PAD_SECONDS * sr) - len(x))))[: int(PAD_SECONDS * sr)]
        fade = int(0.03 * sr)
        x[-fade:] *= np.linspace(1, 0, fade)
        strip.append(x)
    wav = tmp / f"kit-{n}.wav"
    sf.write(str(wav), np.concatenate(strip), sr)
    total = round(len(pads) * PAD_SECONDS, 4)
    chops = [[round(i * PAD_SECONDS, 4), round((i + 1) * PAD_SECONDS, 4)] for i in range(len(pads))]
    rels = [rel_of(tl, by_name[p]["source"]) for p in pads]
    src = {
        "kind": "kit",
        "path": KEYS[rels[0]],
        "window": [0, total],
        "peaks": peaks(wav, 0, total),
        "beats": [],
        "downbeats": [],
        "transients": [c[0] for c in chops],
        "bpm": tl["tempo"],
        "meter": tl["meter"],
        "key": None,
        "tuning_cents": 0,
        "slice": {"name": "kit", "from": 0, "to": total, "machine": "kit"},
        "chop_beats": 0,
        "chops": chops,
        "pads": pads,
        "lane": g["key"],
    }
    tiles = []
    for t in g["tracks"]:
        evs = [e for e in tl["events"] if e["track"] == t]
        for e, pad in zip(evs, hits_of(tl, t, kit)):
            tiles.append({"source": n, "chop": pads.index(pad), "start": round(e["start_beat"], 4), "dur": round(e["dur_beats"], 4), "semitones": 0, "cont": False})
    return src, tiles, wav, rels


def clip_source(tl, g, n):
    """A clip played whole: the window around it, one chop."""
    evs = [e for e in tl["events"] if e["track"] in g["tracks"]]
    audio = Path(tl["sources"][evs[0]["source"]]["path"])
    rel = audio.relative_to(SAMPLES).as_posix()
    m = json.loads(Path(str(audio) + ".apricity.json").read_text())
    beats = m["rhythm"]["beats"]
    # The clip's own stretch of the recording (its pieces), not the whole region it may pick from.
    track = next(t for t in tl["tracks"] if t["name"] in g["tracks"])
    s0, s1 = track["pieces"][0]["src_start"], track["pieces"][-1]["src_end"]
    span = s1 - s0
    w0, w1 = max(0.0, s0 - span / 2), s1 + span / 2
    in_w = lambda s: w0 <= s <= w1
    src = {
        "kind": "clip",
        "path": KEYS[rel],
        "window": [round(w0, 4), round(w1, 4)],
        "peaks": peaks(audio, w0, w1),
        "beats": [round(b, 4) for b in beats if in_w(b)],
        "downbeats": [round(b, 4) for b in m["rhythm"]["downbeats"] if in_w(b)],
        "transients": transients(audio, w0, w1),
        "bpm": m["rhythm"]["bpm"],
        "meter": m["rhythm"]["meter"],
        "key": next((t.get("region_key") for t in tl["tracks"] if t["name"] in g["tracks"]), None),
        "tuning_cents": m["tonal"].get("tuning_cents", 0),
        "slice": {"name": g["key"], "from": round(s0, 4), "to": round(s1, 4), "machine": "clip"},
        "chop_beats": round(sec_to_beat(beats, s1) - sec_to_beat(beats, s0), 3) if len(beats) > 1 else 0,
        "chops": [[round(s0, 4), round(s1, 4)]],
        "lane": g["key"],
    }
    tiles = [{"source": n, "chop": 0, "start": round(e["start_beat"], 4), "dur": round(e["dur_beats"], 4), "semitones": e["semitones"], "cont": abs(e["src_start"] - s0) > 0.01} for e in evs]
    return src, tiles, audio, [rel]


# ---- the bundle


def bake(library: Path, slug: str, sidecar: dict, tmp: Path):
    link_samples(library, tmp)
    tl = compile_score(tmp)
    found = groups(tl)
    chosen = []
    for want in sidecar.get("sources") or [{"tracks": g["tracks"]} for g in found]:
        g = next((g for g in found if set(want["tracks"]) <= set(g["tracks"]) or set(g["tracks"]) <= set(want["tracks"])), None)
        if g is None:
            sys.exit(f"{SCORE}: no source plays tracks {want['tracks']}")
        chosen.append({**g, "tracks": [t for t in g["tracks"] if t in want["tracks"]] if want.get("tracks") else g["tracks"], "override": want})
    sources, tiles, heard, provs = [], [], [], []
    for n, g in enumerate(chosen):
        if g["kind"] == "kit":
            kit = next(t for t in tl["tracks"] if t.get("kit") == g["key"])
            src, t, audio, rels = kit_source(tl, g, n, kit, tmp)
        elif g["kind"] == "loop":
            track = next(t for t in tl["tracks"] if t.get("kit") == g["key"])
            src, t, audio, rels = loop_source(tl, g, n, track)
        else:
            src, t, audio, rels = clip_source(tl, g, n)
        recs = provenance(library, rels)
        o = g["override"]
        src = {"id": re.sub(r"[^a-z0-9-]+", "-", g["key"].lower()), "title": o.get("title") or title_line(recs, g["kind"], g["key"]), "credit": o.get("credit") or credit_line(recs, g["kind"]), **src}
        sources.append(src)
        tiles += t
        heard.append((audio, src["window"]))
        provs.append({"source": src["id"], "title": src["title"], "kind": g["kind"], "tracks": g["tracks"], "recordings": recs})

    chords = []
    for h in tl["harmony"]:
        numeral, _, name = h["label"].partition(" (")
        chords.append({"start": h["start_beat"], "end": h["end_beat"], "numeral": numeral, "name": name.rstrip(")")})

    # The sound: each source as it's heard while analyzed, and each source's tracks rendered alone.
    out = library / "files" / PREFIX / slug
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.mp3"):
        f.unlink()
    audio = {"sources": [], "tracks": []}
    for src, (path, window) in zip(sources, heard):
        name = f"{src['id']}-source.mp3"
        source_audio(path, *window, out / name, tmp)
        audio["sources"].append(f"{PREFIX}/{slug}/{name}")
    _, full = render_tracks([t for g in chosen for t in g["tracks"]], tmp)
    for src, g in zip(sources, chosen):
        wav, makeup = render_tracks(g["tracks"], tmp)
        name = f"{src['id']}-track.mp3"
        mp3(wav, out / name)
        audio["tracks"].append({"key": f"{PREFIX}/{slug}/{name}", "gain_db": round(full - makeup, 2)})

    title, blurb = score_title()
    rel_score = SCORE.resolve().relative_to(ROOT).as_posix()
    data = {
        "slug": slug,
        "title": sidecar.get("title") or title,
        "blurb": sidecar.get("blurb") or blurb,
        "score": rel_score,
        "code": SCORE.read_text(),
        "provenance": provs,
        "captions": sidecar.get("captions") or {},
        "audio": audio,
        "tempo": tl["tempo"],
        "meter": tl["meter"],
        "key": tl["key"],
        "beats": tl["length_beats"],
        "chords": chords,
        "sources": sources,
        "tiles": tiles,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{slug}.json"
    path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    kb = sum(f.stat().st_size for f in out.glob("*.mp3")) / 1024
    print(f"wrote {out}/ ({kb:.0f} KB of audio; library keys {PREFIX}/{slug}/*.mp3)")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.1f} KB): "
          + ", ".join(f"{s['id']} ({s['kind']}): {len(s['chops'])} chops, {sum(t['source'] == i for t in tiles)} notes" for i, s in enumerate(sources)))


def main():
    global EXE, SCORE
    ap = argparse.ArgumentParser(description="Bake a score into a breakdown: web/src/breakdowns/<slug>.json, and its audio into a library.")
    ap.add_argument("score", type=Path, help="the score (.apr or .yaml)")
    ap.add_argument("--library", required=True, type=Path, help="library folder made by apricity migrate (or a fetched one)")
    ap.add_argument("--slug", help="the breakdown's name (default: the score's file name)")
    args = ap.parse_args()
    library = args.library.resolve()
    if not (library / "apricity-library.json").is_file():
        sys.exit(f"{library} is not an Apricity library (no apricity-library.json)")
    SCORE = args.score.resolve()
    side = SCORE.with_name(SCORE.stem + ".breakdown.yaml")
    sidecar = yaml.safe_load(side.read_text()) if side.is_file() else {}
    EXE = find_exe()
    with tempfile.TemporaryDirectory() as t:
        bake(library, args.slug or SCORE.stem, sidecar or {}, Path(t))


if __name__ == "__main__":
    main()
