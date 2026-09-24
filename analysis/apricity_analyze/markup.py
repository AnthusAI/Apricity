"""Automatic markup: sections, loop candidates and hits, written into a clip's annotations.

    PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.markup samples/marine-band

Everything found here is saved with `"source": "ml"`. Re-running replaces earlier ML markup but
never touches annotations a person made (`source` "user" or unset); ML slices whose names collide
with a user slice are skipped.

Method (beat-synchronous, so results land on the beat grid):
- features per beat: the manifest's chroma plus MFCC timbre (librosa), standardized;
- sections: a self-similarity matrix and Foote's checkerboard novelty; boundaries at novelty peaks,
  snapped to bar lines; sections labelled A, B, C… by similarity, so repeated strains share a letter;
  a section in the subdominant of the clip's key is tagged "trio";
- loops: windows of 4, 8 and 16 beats scored for self-repetition (does the next window sound the
  same?), steady beat, static harmony and level;
- hits: onset-strength peaks well above their surroundings, one per few bars at most;
- phrases: what lies between pauses (a quarter second or more well below the clip's speaking
  level). Made for speech (`chop … by phrases` cuts a talk into sentences), but a horn line with
  rests gets its phrases too. Found without a beat grid, so free-time clips get them as well.
"""

from __future__ import annotations

import json
import pathlib
import sys

import numpy as np

from .analyze import SR, validate
from .theory import PITCH_NAMES, rank_keys

HOP = 512
# Smoothed beat-aligned similarity above which a section in a different key still counts as a
# repeat (calibrated on the Marine Band marches: true repeats 0.4–0.9, unrelated below ~0.3)…
REPEAT = 0.5
# …and the lower bar when both sections are in the same key.
REPEAT_SAME_KEY = 0.3


# ------------------------------------------------------------------ features

def beat_features(audio: np.ndarray, beats: list[float], chroma: list[list[float]]) -> np.ndarray:
    """One row per beat interval: 12 chroma + 13 MFCC (z-scored columns, each half weighted equally)."""
    import librosa

    mfcc = librosa.feature.mfcc(y=audio, sr=SR, n_mfcc=13, hop_length=HOP)
    frames = librosa.time_to_frames(np.asarray(beats), sr=SR, hop_length=HOP)
    rows = []
    for i in range(len(beats) - 1):
        a, b = frames[i], max(frames[i] + 1, frames[i + 1])
        rows.append(mfcc[:, a:b].mean(axis=1))
    timbre = np.array(rows) if rows else np.zeros((0, 13))
    pitch = np.array(chroma[: len(rows)]) if chroma else np.zeros((len(rows), 12))

    def z(m):
        return (m - m.mean(axis=0)) / (m.std(axis=0) + 1e-9)

    return np.hstack([z(pitch), z(timbre)])


def ssm(f: np.ndarray) -> np.ndarray:
    n = f / (np.linalg.norm(f, axis=1, keepdims=True) + 1e-9)
    return n @ n.T


def novelty(s: np.ndarray, half: int) -> np.ndarray:
    """Foote novelty: correlate a Gaussian-tapered checkerboard kernel along the diagonal."""
    k = np.arange(-half, half) + 0.5
    g = np.exp(-(k / (half * 0.6)) ** 2)
    kernel = np.outer(g, g) * np.sign(np.outer(k, k))
    n = len(s)
    padded = np.pad(s, half, mode="edge")
    out = np.array([np.sum(padded[i:i + 2 * half, i:i + 2 * half] * kernel) for i in range(n)])
    return np.maximum(out - np.median(out), 0)


def peaks(curve: np.ndarray, min_gap: int, rel: float) -> list[int]:
    """Local maxima at least `min_gap` apart and above `rel` × the curve's max, strongest first."""
    if not len(curve) or curve.max() <= 0:
        return []
    cand = [i for i in range(1, len(curve) - 1) if curve[i] >= curve[i - 1] and curve[i] > curve[i + 1] and curve[i] >= rel * curve.max()]
    chosen: list[int] = []
    for i in sorted(cand, key=lambda i: -curve[i]):
        if all(abs(i - j) >= min_gap for j in chosen):
            chosen.append(i)
    return sorted(chosen)


# ------------------------------------------------------------------ sections

def sections(f: np.ndarray, beats: list[float], downbeats: list[float], key: dict, pcps: list[list[float]]) -> list[dict]:
    n = len(f)
    if n < 24:
        return []
    s = ssm(f)
    nov = novelty(s, half=min(16, n // 4))
    bounds = peaks(nov, min_gap=12, rel=0.25)
    # Snap each boundary to the nearest bar line (downbeat) and drop near-duplicates.
    beat_t = np.asarray(beats)
    snapped = []
    for i in bounds:
        t = beat_t[i]
        if len(downbeats):
            t = min(downbeats, key=lambda d: abs(d - t))
        j = int(np.argmin(np.abs(beat_t - t)))
        if 8 <= j <= n - 8 and all(abs(j - k) >= 8 for k in snapped):
            snapped.append(j)
    edges = [0, *sorted(snapped), n]

    segs = [(a, b) for a, b in zip(edges, edges[1:]) if b > a]
    # For recognizing repeats, smooth features over 4 beats: single beats are noisy, phrases aren't.
    smooth = np.apply_along_axis(lambda c: np.convolve(c, np.ones(4) / 4, mode="same"), 0, f)
    rs_ssm = ssm(smooth)

    def repeat_sim(x: tuple[int, int], y: tuple[int, int]) -> float:
        """How well y repeats x, beat against aligned beat (best of small shifts): the mean of the
        self-similarity matrix along the diagonal from x's start to y's start. Exact repeats
        (a strain played twice) score near 1 even if their averages are unremarkable."""
        L = min(x[1] - x[0], y[1] - y[0])
        best = -1.0
        for shift in range(-2, 3):
            xs = [x[0] + k for k in range(L) if 0 <= x[0] + k < n and 0 <= y[0] + k + shift < n]
            if len(xs) < 4:
                continue
            best = max(best, float(np.mean([rs_ssm[i, i - x[0] + y[0] + shift] for i in xs])))
        return best

    # Fold short transitions (< 16 beats, except an opening intro) into the neighbour they resemble.
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, (a, b) in enumerate(segs):
            if b - a >= 16 or (i == 0 and b - a <= 12):
                continue
            left = repeat_sim(segs[i - 1], (a, b)) if i > 0 else -2
            right = repeat_sim(segs[i + 1], (a, b)) if i + 1 < len(segs) else -2
            j = i - 1 if left >= right else i + 1
            lo, hi = min(segs[j][0], a), max(segs[j][1], b)
            segs[min(i, j)] = (lo, hi)
            del segs[max(i, j)]
            changed = True
            break

    # Label: a section repeating an earlier one takes its letter. Same key makes a repeat more
    # likely (a strain returning, perhaps re-orchestrated); a different key needs strong evidence.
    def seg_key(seg):
        k = rank_keys(np.sum(np.asarray(pcps[seg[0]:seg[1]]), axis=0)) if pcps else []
        return (k[0]["tonic"], k[0]["mode"]) if k else None

    keys = [seg_key(x) for x in segs]
    labels: list[str] = []
    letters = iter("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    for i, seg in enumerate(segs):
        best, best_sim = None, -1.0
        for j in range(i):
            sim = repeat_sim(segs[j], seg)
            same_key = keys[i] is not None and keys[i] == keys[j]
            if sim > (REPEAT_SAME_KEY if same_key else REPEAT) and sim > best_sim:
                best, best_sim = j, sim
        labels.append(labels[best] if best is not None else next(letters, "Z"))

    home = PITCH_NAMES.index(key["tonic"])
    subdominant = PITCH_NAMES[(home + 5) % 12]
    out = []
    counts: dict[str, int] = {}
    for (a, b), label in zip(segs, labels):
        pcp = np.sum(np.asarray(pcps[a:b]), axis=0) if pcps else np.zeros(12)
        k = rank_keys(pcp)
        seg_key = f"{k[0]['tonic']}{'m' if k[0]['mode'] == 'minor' else ''}" if k else "?"
        counts[label] = counts.get(label, 0) + 1
        tags = ["section", f"{b - a}beats", seg_key]
        if k and k[0]["tonic"] == subdominant and key["mode"] == "major":
            tags.append("trio")
        if a == 0 and b - a <= 12:
            tags.append("intro")
        end = beats[b] if b < len(beats) else beats[-1]
        out.append({"label": label, "n": counts[label], "start": beats[a], "end": end, "tags": tags, "novelty": float(nov[a]) if a else 0.0})
    return out


# ------------------------------------------------------------------ loops + hits

def loops(f: np.ndarray, beats: list[float], loudness: list[float], pcps: list[list[float]], downbeat_idx: set[int]) -> list[dict]:
    n = len(f)
    if n < 16:
        return []
    playing = np.percentile(loudness, 90) if loudness else 0.0
    ibi = np.diff(beats)
    cands = []
    for size in (4, 8, 16):
        for a in range(0, n - 2 * size):
            if downbeat_idx and a not in downbeat_idx:
                continue
            w, nxt = f[a:a + size], f[a + size:a + 2 * size]
            repeat = float(np.mean(np.sum(w * nxt, axis=1) / (np.linalg.norm(w, axis=1) * np.linalg.norm(nxt, axis=1) + 1e-9)))
            steady = 1.0 - float(np.std(ibi[a:a + size]) / (np.mean(ibi[a:a + size]) + 1e-9))
            p = np.asarray(pcps[a:a + size]) if pcps else np.ones((size, 12))
            mean = p.mean(axis=0)
            static = float(np.mean(p @ mean / (np.linalg.norm(p, axis=1) * np.linalg.norm(mean) + 1e-9)))
            level = np.mean(loudness[a:a + size]) if loudness else playing
            score = repeat + 0.5 * steady + 0.5 * static - max(0.0, (playing - level) / 10.0)
            ev = {"repeat": round(repeat, 3), "steady": round(steady, 3), "static": round(static, 3), "level_db": round(float(level - playing), 1)}
            cands.append((score, a, size, ev))
    chosen = []
    for score, a, size, ev in sorted(cands, key=lambda c: -c[0]):
        if all(a + size <= b or b + s <= a for _, b, s, _ in chosen):
            chosen.append((score, a, size, ev))
        if len(chosen) == 4:
            break
    out = []
    for score, a, size, ev in chosen:
        k = rank_keys(np.sum(np.asarray(pcps[a:a + size]), axis=0)) if pcps else []
        key = f"{k[0]['tonic']}{'m' if k[0]['mode'] == 'minor' else ''}" if k else "?"
        out.append({"start": beats[a], "end": beats[a + size], "size": size, "key": key, "score": round(score, 3), "evidence": ev})
    return sorted(out, key=lambda x: -x["score"])


def hits(audio: np.ndarray, beats: list[float], max_hits: int) -> list[tuple[float, float]]:
    """(onset time s, standout strength ×) of standout hits: well above their surroundings *and* loud in absolute
    terms (in near-silence, noise looks like a big relative jump). Placed at the onset itself,
    a few ms early so the attack is kept, not snapped to the beat: a pad must start on its hit."""
    import librosa

    env = librosa.onset.onset_strength(y=audio, sr=SR, hop_length=HOP)
    t = librosa.times_like(env, sr=SR, hop_length=HOP)
    # Strength relative to the local surroundings (±2 s), so a crash in a loud passage still counts.
    w = int(2 * SR / HOP)
    local = np.array([np.median(env[max(0, i - w):i + w]) + 1e-9 for i in range(len(env))])
    rel = env / local
    # Level just after each frame (the hit's body), against the clip's playing level.
    n = len(audio)
    body = int(0.1 * SR)
    db = np.array([20 * np.log10(np.sqrt(np.mean(audio[int(x * SR):min(n, int(x * SR) + body)] ** 2)) + 1e-9) if int(x * SR) < n else -120.0 for x in t])
    frame = 2048
    idx = np.arange(0, max(1, n - frame), frame)
    playing = np.percentile([20 * np.log10(np.sqrt(np.mean(audio[i:i + frame] ** 2)) + 1e-9) for i in idx], 90) if len(idx) else 0.0
    gap = int(8 * np.median(np.diff(beats)) * SR / HOP) if len(beats) > 1 else w
    onsets = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=HOP, backtrack=True, units="frames")
    found = []
    for i in peaks(rel, min_gap=max(1, gap), rel=0.5):
        if rel[i] < 4.0 or db[i] < playing - 20.0:
            continue
        # Start at the backtracked onset nearest before the peak (the attack), minus 5 ms.
        before = onsets[onsets <= i]
        start = t[before[-1]] if len(before) and i - before[-1] < 8 else t[i]
        found.append((rel[i], max(0.0, float(start) - 0.005)))
    found.sort(reverse=True)
    best = {round(x, 4): round(float(r), 1) for r, x in found[:max_hits]}
    return sorted(best.items())


PAUSE_S = 0.25  # a gap at least this long ends a phrase
MIN_PHRASE_S = 0.3
MAX_PHRASES = 200


def phrases(audio: np.ndarray) -> list[tuple[float, float]]:
    """(start, end) seconds of each phrase between pauses."""
    frame, hop = 1024, 256
    n = 1 + max(0, len(audio) - frame) // hop
    if n < 4:
        return []
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(audio[idx] ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    loud = np.percentile(db, 95)
    # Silence: 30 dB under the speaking level, or just above the noise floor if that's higher.
    thresh = max(loud - 30.0, np.percentile(db, 5) + 6.0)
    if loud - thresh < 10.0:  # no real pauses (dense music, noise)
        return []
    on = db > thresh
    t = lambda i: i * hop / SR  # noqa: E731
    runs, i = [], 0
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            runs.append([i, j])
            i = j
        else:
            i += 1
    # Bridge gaps shorter than a pause (breaths between words, stop consonants).
    merged: list[list[int]] = []
    for r in runs:
        if merged and t(r[0]) - t(merged[-1][1]) < PAUSE_S:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    dur = len(audio) / SR
    out = []
    for a, b in merged:
        start, end = max(0.0, t(a) - 0.03), min(dur, t(b) + frame / SR + 0.06)  # keep the attack and the release
        if end - start >= MIN_PHRASE_S:
            out.append((round(start, 3), round(end, 3)))
    # Only worth marking when there are several (one "phrase" is just the whole clip).
    return out[:MAX_PHRASES] if len(out) >= 2 else []


# ------------------------------------------------------------------ annotations

def markup(audio_path: pathlib.Path) -> dict:
    """Compute ML annotations for one clip (reads its manifest; returns the new annotations)."""
    import essentia.standard as es

    mpath = audio_path.with_name(audio_path.name + ".apricity.json")
    m = json.loads(mpath.read_text())
    r, t = m["rhythm"], m["tonal"]
    beats, downbeats = r["beats"], r["downbeats"]
    audio = es.MonoLoader(filename=str(audio_path), sampleRate=SR)()
    phr = [{"name": f"phrase-{i}", "start": a, "end": b, "source": "ml", "tags": ["phrase", f"{b - a:.1f}s"]} for i, (a, b) in enumerate(phrases(audio), 1)]
    if len(beats) < 8:  # free time / fragments / speech: no grid to hang sections or loops on
        hts = hits(audio, beats, max_hits=4) if len(beats) >= 2 else []
        spb = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
        dur = m["source"]["duration"]
        return {
            "markers": [{"name": "hit", "seconds": round(h, 3), "source": "ml"} for h, _ in hts],
            "slices": phr + [{"name": f"hit-{i}", "start": round(h, 3), "end": round(min(h + spb, dur), 3), "source": "ml", "tags": ["hit"], "evidence": {"standout": st}} for i, (h, st) in enumerate(hts, 1) if h < dur],
        }
    f = beat_features(audio, beats, t.get("beat_chroma", []))
    pcps = t.get("beat_chroma", [])
    down_idx = {int(np.argmin(np.abs(np.asarray(beats) - d))) for d in downbeats} if beats else set()

    stem = m.get("derived_from", {}).get("stem")
    secs = [] if stem == "drums" else sections(f, beats, downbeats, t["key"], pcps)
    lps = loops(f, beats, r.get("beat_loudness", []), pcps, down_idx)
    hts = hits(audio, beats, max_hits=max(4, int(len(beats) / 32)))
    spb = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5

    slices, markers = list(phr), []
    for s in secs:
        name = "trio" if "trio" in s["tags"] and not any(x["name"] == "trio" for x in slices) else ("intro" if "intro" in s["tags"] else f"sec-{s['label']}{s['n']}")
        slices.append({"name": name, "start": round(s["start"], 3), "end": round(s["end"], 3), "source": "ml", "tags": s["tags"]})
        if s["start"] > 0:
            markers.append({"name": f"section {s['label']}", "seconds": round(s["start"], 3), "source": "ml", "note": ", ".join(s["tags"][1:])})
    for i, lp in enumerate(lps, 1):
        slices.append({"name": f"loop-{i}", "start": round(lp["start"], 3), "end": round(lp["end"], 3), "source": "ml", "tags": ["loop", f"{lp['size']}beats", lp["key"]], "evidence": lp["evidence"]})
    for i, (h, st) in enumerate(hts, 1):
        markers.append({"name": "hit", "seconds": round(h, 3), "source": "ml"})
        slices.append({"name": f"hit-{i}", "start": round(h, 3), "end": round(min(h + spb, m["source"]["duration"]), 3), "source": "ml", "tags": ["hit"], "evidence": {"standout": st}})

    dur = m["source"]["duration"]
    slices = [s for s in slices if 0 <= s["start"] < s["end"] <= dur]
    markers = [x for x in markers if 0 <= x["seconds"] <= dur]
    return {"slices": slices, "markers": markers}


def merge(existing: dict, ml: dict) -> dict:
    """Keep everything a person made; replace earlier ML markup; never clobber a user slice name."""
    keep_slices = [s for s in existing.get("slices", []) if s.get("source") != "ml"]
    keep_markers = [x for x in existing.get("markers", []) if x.get("source") != "ml"]
    taken = {s["name"] for s in keep_slices}
    out = dict(existing)
    out["slices"] = keep_slices + [s for s in ml["slices"] if s["name"] not in taken]
    out["markers"] = keep_markers + ml["markers"]
    return out


def run(path: pathlib.Path) -> dict:
    mpath = path.with_name(path.name + ".apricity.json")
    m = json.loads(mpath.read_text())
    m["annotations"] = merge(m.get("annotations", {}), markup(path))
    validate(m)
    mpath.write_text(json.dumps(m, indent=1) + "\n")
    return m["annotations"]


def main(argv: list[str]) -> int:
    AUDIO = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a"}
    for root in map(pathlib.Path, argv or ["samples"]):
        files = sorted(p for p in root.rglob("*") if p.suffix.lower() in AUDIO) if root.is_dir() else [root]
        for p in files:
            if not p.with_name(p.name + ".apricity.json").exists():
                continue
            ann = run(p)
            secs = [s for s in ann["slices"] if s.get("source") == "ml" and "section" in s.get("tags", [])]
            form = " ".join(s["name"].removeprefix("sec-") for s in secs)
            nl = sum(1 for s in ann["slices"] if s["name"].startswith("loop-") and s.get("source") == "ml")
            nh = sum(1 for x in ann["markers"] if x["name"] == "hit")
            print(f"  {str(p.relative_to(root.parent if root.is_dir() else p.parent))[:60]:60} {form or '-':40} {nl} loops, {nh} hits")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
