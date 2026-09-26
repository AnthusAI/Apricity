"""Automatic markup: sections, loops, transients and one-shots, and held notes, saved as clips and markers in a sample's manifest.

    PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.markup samples/marine-band

Everything found here is saved with `"source": "ml"`. Re-running replaces earlier ML markup but
never touches annotations a person made (`source` "user" or unset); ML clips whose names collide
with one of yours are skipped.

Method (beat-synchronous, so results land on the beat grid):
- features per beat: the manifest's chroma plus MFCC timbre (librosa), standardized;
- sections: a self-similarity matrix and Foote's checkerboard novelty; boundaries at novelty peaks,
  snapped to bar lines; sections labelled A, B, C… by similarity, so repeated strains share a letter;
  a section in the subdominant of the clip's key is tagged "trio";
- loops: windows of 4, 8 and 16 beats scored for self-repetition (does the next window sound the
  same?), steady beat, static harmony and level;
- transients: onset-strength peaks well above their surroundings, one per few bars at most, each
  also saved as a one-shot clip (`shot-1`, `shot-2`, …);
- held notes: sustained notes or chords, from attack to release, for pads, bass, and melodies;
  tagged with the pitch a pitched track hears and numbered in time order (`hold-1`, `hold-2`, …);
- phrases: what lies between pauses (a quarter second or more well below the clip's speaking
  level). Made for speech (`slice … by phrases` cuts a talk into sentences), but a horn line with
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




# ------------------------------------------------------------------ holds

def holds(notes: list[dict], duration: float, beats: list[float] | None = None, beat_loudness: list[float] | None = None, max_holds: int = 12) -> list[dict]:
    """Sustained notes or chords: from attack to release, tagged by pitch and duration.
    
    Candidates are notes lasting >= 0.8 s with velocity >= 0.35. Reject only when a note
    starting inside the candidate is louder than the candidate by more than 0.1 velocity.
    
    Tags: "clean" (≤ 2 notes start inside and none is louder) or "busy" (otherwise).
    Rank clean candidates first, then all candidates by duration × velocity.
    
    Loudness check (applied before ranking): uses beat_loudness if both beats and beat_loudness
    are provided. Rejects candidate if mean beat loudness over its region is > 15 dB below
    median sample loudness, or if the region falls outside the beat grid.
    
    Region: start = max(0, candidate_start - 0.02), end = min(candidate_end + 0.15, duration).
    Greedy overlap removal (higher-ranked first). Max max_holds, numbered in time order.
    
    Tags: ["hold", <pitch>, "<length>s"], plus "clean" or "busy", plus "chord" when >= 2
    other notes start within 0.08 s of the start and last >= 70% of the candidate.
    
    Pitch is the lowest loud note starting at [clip_start - 0.03, clip_start + 0.12], with
    velocity >= 0.5 × the loudest note there (mirrors Rust rule: crates/apricity-score/src/manifest.rs:313).
    """
    if not notes:
        return []
    
    # Filter candidates: duration >= 0.8 s, velocity >= 0.35
    candidates = [n for n in notes if (n["end"] - n["start"]) >= 0.8 and n["velocity"] >= 0.35]
    
    if not candidates:
        return []
    
    # Prepare loudness check (before ranking)
    use_loudness_check = beats is not None and beat_loudness is not None and len(beats) > 1 and len(beat_loudness) > 0
    median_loudness = None
    if use_loudness_check:
        median_loudness = np.median(beat_loudness)
    
    # Filter by loudness check first, then classify by cleanliness
    classified_candidates = []
    for cand in candidates:
        cand_start, cand_end, cand_midi, cand_vel = cand["start"], cand["end"], cand["midi"], cand["velocity"]
        region_start = max(0.0, cand_start - 0.02)
        region_end = min(cand_end + 0.15, duration)
        
        # Loudness check first
        if use_loudness_check:
            beats_array = np.array(beats)
            overlapping_beat_indices = []
            for bi, bt in enumerate(beats_array):
                if bt >= region_start and bt < region_end and bi < len(beat_loudness):
                    overlapping_beat_indices.append(bi)
            
            if overlapping_beat_indices:
                region_loudnesses = [beat_loudness[bi] for bi in overlapping_beat_indices]
                mean_region_loudness = np.mean(region_loudnesses)
                # Reject if more than 15 dB below median
                if mean_region_loudness < median_loudness - 15.0:
                    continue  # Skip this candidate entirely
            else:
                # Region falls outside beat grid: reject candidate
                continue
        
        # Classify by cleanliness (new rule: reject only if louder by >0.1 velocity)
        during = [n for n in notes if cand_start + 0.08 <= n["start"] < cand_end and n["velocity"] >= 0.3]
        
        # Reject if any note inside is louder by more than 0.1 velocity
        too_loud = any(n["velocity"] > cand_vel + 0.1 for n in during)
        if too_loud:
            continue  # Skip this candidate
        
        # Classify as clean or busy
        is_clean = len(during) <= 2 and all(n["velocity"] <= cand_vel for n in during)
        classified_candidates.append((cand, is_clean))
    
    if not classified_candidates:
        return []
    
    # Rank: clean candidates first, then by duration * velocity (descending)
    def rank_key(item):
        cand, is_clean = item
        duration = cand["end"] - cand["start"]
        # Clean sorts first (False < True when negated), then by duration*velocity descending
        return (not is_clean, -(duration * cand["velocity"]))
    
    ranked = sorted(classified_candidates, key=rank_key)
    
    # Greedy overlap removal
    chosen = []
    for cand, is_clean in ranked:
        cand_start, cand_end = cand["start"], cand["end"]
        region_start = max(0.0, cand_start - 0.02)
        region_end = min(cand_end + 0.15, duration)
        
        # Check no overlap with already chosen
        overlaps = False
        for chosen_cand, _ in chosen:
            chosen_start = max(0.0, chosen_cand["start"] - 0.02)
            chosen_end = min(chosen_cand["end"] + 0.15, duration)
            if region_start < chosen_end and chosen_start < region_end:
                overlaps = True
                break
        
        if not overlaps:
            chosen.append((cand, is_clean))
            if len(chosen) >= max_holds:
                break
    
    # Sort by time
    chosen.sort(key=lambda x: x[0]["start"])
    
    # Build clips
    clips = []
    for i, (cand, is_clean) in enumerate(chosen, 1):
        cand_start, cand_end, cand_midi, cand_vel = cand["start"], cand["end"], cand["midi"], cand["velocity"]
        region_start = max(0.0, cand_start - 0.02)
        region_end = min(cand_end + 0.15, duration)
        cand_dur = cand_end - cand_start
        
        # Determine pitch: of notes starting at [region_start - 0.03, min(region_start + 0.12, region_end)], 
        # the lowest with velocity >= 0.5 * loudest (Rust rule: crates/apricity-score/src/manifest.rs:313)
        onset_start = region_start - 0.03
        onset_end = min(region_start + 0.12, region_end)
        onset_notes = [n for n in notes if n["start"] >= onset_start and n["start"] <= onset_end]
        
        if onset_notes:
            loudest = max(n["velocity"] for n in onset_notes)
            loud_notes = [n for n in onset_notes if n["velocity"] >= loudest * 0.5]
            pitch_midi = min(n["midi"] for n in loud_notes) if loud_notes else cand_midi
        else:
            pitch_midi = cand_midi
        
        # Convert MIDI to pitch name using PITCH_NAMES (flat notation: Ab, Db, etc.)
        pitch_name = f"{PITCH_NAMES[pitch_midi % 12]}{pitch_midi // 12 - 1}"
        
        # Check for chord: >= 2 notes starting within 0.08 s of cand_start, lasting >= 70% of cand_dur
        within_0_08 = [n for n in notes if cand_start <= n["start"] <= cand_start + 0.08 and n != cand]
        is_chord = sum(1 for n in within_0_08 if (n["end"] - n["start"]) >= 0.7 * cand_dur) >= 2
        
        # Tags
        length_s = f"{cand_dur:.2f}".rstrip('0').rstrip('.')
        tags = ["hold", pitch_name, f"{length_s}s"]
        tags.append("clean" if is_clean else "busy")
        if is_chord:
            tags.append("chord")
        
        clips.append({
            "name": f"hold-{i}",
            "start": round(region_start, 3),
            "end": round(region_end, 3),
            "source": "ml",
            "tags": tags,
            "evidence": {"held": pitch_midi, "velocity": round(cand_vel, 3)}
        })
    
    return clips


# ------------------------------------------------------------------ annotations

def markup(audio_path: pathlib.Path) -> dict:
    """Compute ML annotations for one sample (reads its manifest; returns the new annotations)."""
    import essentia.standard as es

    mpath = audio_path.with_name(audio_path.name + ".apricity.json")
    m = json.loads(mpath.read_text())
    r, t = m["rhythm"], m["tonal"]
    beats, downbeats = r["beats"], r["downbeats"]
    audio = es.MonoLoader(filename=str(audio_path), sampleRate=SR)()
    dur = m["source"]["duration"]
    beat_loudness = r.get("beat_loudness", [])
    notes = m.get("notes", [])
    
    phr = [{"name": f"phrase-{i}", "start": a, "end": b, "source": "ml", "tags": ["phrase", f"{b - a:.1f}s"]} for i, (a, b) in enumerate(phrases(audio), 1)]
    if len(beats) < 8:  # free time / fragments / speech: no grid to hang sections or loops on
        hts = hits(audio, beats, max_hits=4) if len(beats) >= 2 else []
        spb = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
        shot_clips = [{"name": f"shot-{i}", "start": round(h, 3), "end": round(min(h + spb, dur), 3), "source": "ml", "tags": ["shot"], "evidence": {"standout": st}} for i, (h, st) in enumerate(hts, 1) if h < dur]
        
        # Add holds for free-time (no beat grid check)
        hold_clips = holds(notes, dur, beats=None, beat_loudness=None, max_holds=12)
        
        return {
            "markers": [{"name": "transient", "seconds": round(h, 3), "source": "ml"} for h, _ in hts],
            "clips": phr + shot_clips + hold_clips,
        }
    f = beat_features(audio, beats, t.get("beat_chroma", []))
    pcps = t.get("beat_chroma", [])
    down_idx = {int(np.argmin(np.abs(np.asarray(beats) - d))) for d in downbeats} if beats else set()

    stem = m.get("derived_from", {}).get("stem")
    secs = [] if stem == "drums" else sections(f, beats, downbeats, t["key"], pcps)
    lps = loops(f, beats, beat_loudness, pcps, down_idx)
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
        markers.append({"name": "transient", "seconds": round(h, 3), "source": "ml"})
        slices.append({"name": f"shot-{i}", "start": round(h, 3), "end": round(min(h + spb, dur), 3), "source": "ml", "tags": ["shot"], "evidence": {"standout": st}})
    
    # Add holds after shots, but skip for drum stems
    if stem != "drums":
        hold_clips = holds(notes, dur, beats=beats, beat_loudness=beat_loudness, max_holds=12)
        slices.extend(hold_clips)

    slices = [s for s in slices if 0 <= s["start"] < s["end"] <= dur]
    markers = [x for x in markers if 0 <= x["seconds"] <= dur]
    return {"clips": slices, "markers": markers}


def merge(existing: dict, ml: dict) -> dict:
    """Keep everything a person made; replace earlier ML markup; never clobber a name you gave."""
    keep_slices = [s for s in existing.get("clips", []) if s.get("source") != "ml"]
    keep_markers = [x for x in existing.get("markers", []) if x.get("source") != "ml"]
    taken = {s["name"] for s in keep_slices}
    out = dict(existing)
    out["clips"] = keep_slices + [s for s in ml["clips"] if s["name"] not in taken]
    out["markers"] = keep_markers + ml["markers"]
    return out


def run(path: pathlib.Path) -> dict:
    mpath = path.with_name(path.name + ".apricity.json")
    m = json.loads(mpath.read_text())
    m["annotations"] = merge(m.get("annotations", {}), markup(path))
    m["apricity_manifest"] = 2
    validate(m)
    mpath.write_text(json.dumps(m, indent=1) + "\n")
    return m["annotations"]


def main(argv: list[str]) -> int:
    AUDIO = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a"}
    
    # Check for --holds flag
    if argv and argv[0] == "--holds":
        # Holds refresh mode: update only hold-* ML clips
        paths = argv[1:] or ["samples"]
        for root in map(pathlib.Path, paths):
            files = sorted(p for p in root.rglob("*") if p.suffix.lower() in AUDIO) if root.is_dir() else [root]
            for p in files:
                mpath = p.with_name(p.name + ".apricity.json")
                if not mpath.exists():
                    continue
                
                # Read manifest
                m = json.loads(mpath.read_text())
                r = m["rhythm"]
                dur = m["source"]["duration"]
                beat_loudness = r.get("beat_loudness", [])
                notes = m.get("notes", [])
                beats = r["beats"]
                
                # Generate new holds
                new_holds = holds(notes, dur, beats=beats if len(beats) > 1 else None, beat_loudness=beat_loudness if len(beat_loudness) > 0 else None, max_holds=12)
                
                # Merge: keep user clips and non-hold ML clips
                existing = m.get("annotations", {})
                keep_clips = [s for s in existing.get("clips", []) if s.get("source") != "ml" or not s["name"].startswith("hold-")]
                taken_names = {s["name"] for s in keep_clips}
                
                # Add new holds, skipping user-taken names
                merged_clips = keep_clips + [h for h in new_holds if h["name"] not in taken_names]
                
                # Validate and write
                updated_annotations = dict(existing)
                updated_annotations["clips"] = merged_clips
                updated_annotations["markers"] = existing.get("markers", [])
                
                m["annotations"] = updated_annotations
                m["apricity_manifest"] = 2
                validate(m)
                mpath.write_text(json.dumps(m, indent=1) + "\n")
                
                hold_count = len([h for h in new_holds if h["name"] not in taken_names])
                print(f"  {str(p.relative_to(root.parent if root.is_dir() else p.parent))[:60]:60} {hold_count} holds")
        return 0
    
    # Full analysis mode
    for root in map(pathlib.Path, argv or ["samples"]):
        files = sorted(p for p in root.rglob("*") if p.suffix.lower() in AUDIO) if root.is_dir() else [root]
        for p in files:
            if not p.with_name(p.name + ".apricity.json").exists():
                continue
            ann = run(p)
            secs = [s for s in ann["clips"] if s.get("source") == "ml" and "section" in s.get("tags", [])]
            form = " ".join(s["name"].removeprefix("sec-") for s in secs)
            nl = sum(1 for s in ann["clips"] if s["name"].startswith("loop-") and s.get("source") == "ml")
            nh = sum(1 for x in ann["markers"] if x["name"] == "transient")
            nh_holds = sum(1 for s in ann["clips"] if s["name"].startswith("hold-") and s.get("source") == "ml")
            print(f"  {str(p.relative_to(root.parent if root.is_dir() else p.parent))[:60]:60} {form or '-':40} {nl} loops, {nh} transients, {nh_holds} holds")
    return 0



if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
