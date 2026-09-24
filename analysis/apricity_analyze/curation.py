"""The curation feed: analyzers and agents propose slices; people judge them.

    PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.curation propose samples
    PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.curation feed

Vocabulary (design/framework.md): a **candidate** is a proposed slice of a clip, with the
**evidence** for it and who proposed it. The **feed** is the candidates awaiting a person, best
first. A **verdict** (keep / skip / later) is always given; kept material can have **stars**,
**tags**, a **name**, and belong to **crates**. Keeping writes a named slice into the clip's
manifest (`"source": "curated"`), so a score can use it at once: `clip b = … slice brk-1`.

The store is plain JSON in `library/` (readable and diffable like the manifests):
    candidates.json   {"candidates": [candidate, …]}
    verdicts.json     {"verdicts": {candidate id: verdict}}
    crates.json       {"crates": {name: {"items": [candidate id, …], "note": str}}}

Ranking learns taste from verdicts with smoothed keep rates per kind, proposer and recording, and
says why ("you kept 7 of 9 breaks"), so a person can see what the machine thinks it has learned.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import pathlib
import re
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
LIBRARY = ROOT / "library"
KINDS = ("loop", "break", "hit", "phrase", "section", "chop", "other")
VERDICTS = ("keep", "skip", "later")
NAME = re.compile(r"^[A-Za-z0-9_-]+$")


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------ store

class Store:
    """The library folder. Writes are atomic and serialized with a lock file, so the server, the
    terminal feed and agents can all use it at once."""

    def __init__(self, library: pathlib.Path = LIBRARY, samples: pathlib.Path = SAMPLES):
        self.dir = pathlib.Path(library)
        self.samples = pathlib.Path(samples)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> pathlib.Path:
        return self.dir / f"{name}.json"

    def read(self, name: str) -> dict:
        p = self._path(name)
        default = {"candidates": {"candidates": []}, "verdicts": {"verdicts": {}}, "crates": {"crates": {}}}[name]
        return json.loads(p.read_text()) if p.exists() else default

    def _write(self, name: str, data: dict) -> None:
        p = self._path(name)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        tmp.replace(p)

    @contextlib.contextmanager
    def edit(self, name: str):
        """Read, modify and write one file under the library lock."""
        with open(self.dir / ".lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            data = self.read(name)
            yield data
            self._write(name, data)

    # ---- manifests

    def manifest_path(self, clip: str) -> pathlib.Path:
        return self.samples / f"{clip}.apricity.json"

    def manifest(self, clip: str) -> dict:
        p = self.manifest_path(clip)
        if not p.exists():
            raise ValueError(f"{clip}: no analysis (no {p.name}); analyze the clip first")
        return json.loads(p.read_text())


def candidate_id(clip: str, start: float, end: float, kind: str) -> str:
    """Stable: the same span of the same clip proposed twice is one candidate."""
    key = f"{clip}|{round(start, 2):.2f}|{round(end, 2):.2f}|{kind}"
    return "c-" + hashlib.sha1(key.encode()).hexdigest()[:10]


def recording(clip: str) -> str:
    """The recording a clip comes from ("marine-band/stems/Thunderer/drums.wav" → "Thunderer")."""
    parts = pathlib.PurePosixPath(clip).parts
    if "stems" in parts and parts.index("stems") + 1 < len(parts) - 1:
        return parts[parts.index("stems") + 1]
    return pathlib.PurePosixPath(clip).stem


def prepare(store: Store, clip: str, start: float, end: float, kind: str, by: str, why: str,
            score: float = 0.5, evidence: dict | None = None, name: str | None = None, manifest: dict | None = None) -> dict:
    """Validate one proposal (agents call this too, so everything is checked) and build its
    candidate, with this proposer as its only entry. `add` merges it into the store."""
    if kind not in KINDS:
        raise ValueError(f"kind {kind!r}: use one of {', '.join(KINDS)}")
    if not (by.startswith("analyzer:") or by.startswith("agent:")) or len(by.split(":", 1)[1]) == 0:
        raise ValueError(f"proposer {by!r}: write analyzer:<name> or agent:<name>")
    if not why.strip():
        raise ValueError("say why: every candidate carries its reason")
    if name is not None and not NAME.match(name):
        raise ValueError(f"name {name!r}: letters, digits, - and _ only")
    m = manifest or store.manifest(clip)
    dur = m["source"]["duration"]
    if not (0 <= start < end <= dur + 1e-6):
        raise ValueError(f"{clip}: span {start:.3f}–{end:.3f} s is outside the clip (0–{dur:.3f} s) or backwards")
    if end - start < 0.05:
        raise ValueError(f"span {start:.3f}–{end:.3f} s is too short to hear")
    cid = candidate_id(clip, start, end, kind)
    r = m["rhythm"]
    spb = float(np.median(np.diff(r["beats"]))) if len(r.get("beats") or []) > 1 else None
    return {
        "id": cid, "clip": clip, "start": round(start, 3), "end": round(end, 3), "kind": kind,
        "name": name or f"{kind}-{cid[2:6]}",
        "recording": recording(clip),
        "context": {"seconds": round(end - start, 3), "bpm": r.get("bpm"), "beats": round((end - start) / spb, 1) if spb else None,
                    "key": f"{m['tonal']['key']['tonic']} {m['tonal']['key']['mode']}", "stem": (m.get("derived_from") or {}).get("stem")},
        "proposers": [{"by": by, "score": round(float(min(1.0, max(0.0, score))), 3), "why": why.strip(),
                       "evidence": {k: float(v) for k, v in (evidence or {}).items()}, "at": now()}],
    }


def add(store: Store, prepared: list[dict]) -> list[dict]:
    """Merge prepared candidates into the store in one write: a span already proposed gains (or
    updates) this proposer instead of becoming a duplicate."""
    out = []
    with store.edit("candidates") as data:
        by_id = {c["id"]: c for c in data["candidates"]}
        for p in prepared:
            c = by_id.get(p["id"])
            if c is None:
                c = by_id[p["id"]] = p
                data["candidates"].append(c)
            else:
                who = p["proposers"][0]["by"]
                c["proposers"] = [q for q in c["proposers"] if q["by"] != who] + p["proposers"]
            out.append(c)
    return out


def propose(store: Store, clip: str, start: float, end: float, kind: str, by: str, why: str,
            score: float = 0.5, evidence: dict | None = None, name: str | None = None) -> dict:
    """Propose one candidate (the agent entry point)."""
    return add(store, [prepare(store, clip, start, end, kind, by, why, score, evidence, name)])[0]


# ------------------------------------------------------------------ analyzers

def _loop_why(ev: dict, key: str, beats: str) -> str:
    bits = [f"{beats} that loop cleanly (the next {beats} match {ev['repeat']:.2f})" if "repeat" in ev else f"{beats} loop"]
    if ev.get("steady", 0) > 0.95:
        bits.append("a steady beat")
    if ev.get("static", 0) > 0.9:
        bits.append(f"harmony holds still ({key})")
    if ev.get("level_db", 0) < -6:
        bits.append(f"but {-ev['level_db']:.0f} dB quieter than the rest")
    return "; ".join(bits)


def from_markup(store: Store, clip: str) -> list[dict]:
    """Candidates (prepared, not yet added) from a clip's automatic markup: loops, hits, phrases
    and sections."""
    m = store.manifest(clip)
    out = []
    ann = m.get("annotations", {})
    for s in ann.get("clips", []):
        if s.get("source") != "ml":
            continue
        ev, tags, name = s.get("evidence", {}), s.get("tags", []), s["name"]
        if name.startswith("loop-"):
            beats = next((t for t in tags if t.endswith("beats")), "beats").replace("beats", " beats")
            key = tags[2] if len(tags) > 2 else "?"
            # markup's loop score: repeat + ½ steady + ½ still − quietness (≈ 0–2)
            score = (ev.get("repeat", 0.5) + 0.5 * ev.get("steady", 0.5) + 0.5 * ev.get("static", 0.5) - max(0.0, -ev.get("level_db", 0) / 10)) / 2
            out.append(prepare(store, clip, s["start"], s["end"], "loop", "analyzer:markup/loops", _loop_why(ev, key, beats), score, ev, manifest=m))
        elif name.startswith("shot-"):
            st = ev.get("standout", 0.0)
            why = f"a hit standing out {st:.0f}× over its surroundings" if st else "a standout hit"
            out.append(prepare(store, clip, s["start"], s["end"], "hit", "analyzer:markup/hits", why, min(1.0, 0.3 + st / 30), ev, manifest=m))
        elif name.startswith("phrase-"):
            d = s["end"] - s["start"]
            # Speech (no beat grid) is what phrases are for; in music they're rests between lines.
            speech = len(m["rhythm"].get("beats") or []) < 8
            why = f"a {d:.1f} s spoken phrase between pauses" if speech else f"a {d:.1f} s musical phrase between rests"
            out.append(prepare(store, clip, s["start"], s["end"], "phrase", "analyzer:markup/phrases", why, 0.6 if speech else 0.2, {"seconds": d}, manifest=m))
        elif "section" in tags:
            why = f"section {name}" + (f" ({', '.join(t for t in tags if t != 'section')})" if len(tags) > 1 else "")
            out.append(prepare(store, clip, s["start"], s["end"], "section", "analyzer:markup/sections", why, 0.35, manifest=m))
    return out


def find_breaks(store: Store, source_clip: str, sizes=(4, 8), min_lift_db: float = 6.0, max_breaks: int = 4) -> list[dict]:
    """Breaks: spans where the drums carry the recording and the rest drops out. Needs the
    recording's stems (drums plus others), which share its beat grid, so their per-beat loudness
    lines up. Proposes (prepared) the span on the full recording, the classic break; evidence: how
    far the drums stand over the loudest other stem."""
    m = store.manifest(source_clip)
    stem_dir = pathlib.PurePosixPath(source_clip).parent / "stems" / pathlib.PurePosixPath(source_clip).stem
    stems = {}
    for p in sorted((store.samples / stem_dir).glob("*.apricity.json")):
        sm = json.loads(p.read_text())
        stems[(sm.get("derived_from") or {}).get("stem", p.name.split(".")[0])] = np.asarray(sm["rhythm"].get("beat_loudness") or [], float)
    if "drums" not in stems or len(stems) < 2:
        return []
    beats = m["rhythm"]["beats"]
    n = min(len(v) for v in stems.values())
    if n < 8:
        return []
    drums = stems["drums"][:n]
    others = np.max(np.vstack([v[:n] for k, v in stems.items() if k != "drums"]), axis=0)
    playing = float(np.percentile(drums, 90))
    down = set()
    if m["rhythm"].get("downbeats"):
        bt = np.asarray(beats)
        down = {int(np.argmin(np.abs(bt - d))) for d in m["rhythm"]["downbeats"]}
    found = []
    for size in sizes:
        for a in range(0, n - size + 1):
            if down and a not in down:
                continue
            p = lambda v: 10 * np.log10(np.mean(10 ** (v[a:a + size] / 10)))  # noqa: E731
            lift, level = float(p(drums) - p(others)), float(p(drums))
            if lift >= min_lift_db and level >= playing - 9:
                found.append((lift + 0.1 * size, a, size, lift, level - playing))
    chosen = []
    for score, a, size, lift, rel in sorted(found, reverse=True):
        if all(a + size <= b or b + s <= a for _, b, s, _, _ in chosen):
            chosen.append((score, a, size, lift, rel))
        if len(chosen) == max_breaks:
            break
    out = []
    for _, a, size, lift, rel in chosen:
        if a + size >= len(beats):
            continue
        why = f"{size} beats where the drums stand {lift:.0f} dB over everything else"
        out.append(prepare(store, source_clip, beats[a], beats[a + size], "break", "analyzer:breaks", why, min(1.0, lift / 20), {"drum_lift_db": round(lift, 1), "drum_level_db": round(rel, 1)}, manifest=m))
    return out


def propose_all(store: Store, root: pathlib.Path) -> list[dict]:
    """Run the analyzers over every analyzed clip under `root` (a folder in samples, or one clip)
    and add what they find in one write."""
    root = pathlib.Path(root).resolve()
    manifests = sorted(root.rglob("*.apricity.json")) if root.is_dir() else [root.with_name(root.name + ".apricity.json")]
    out = []
    for mp in manifests:
        clip = str(mp.relative_to(store.samples.resolve()))[: -len(".apricity.json")]
        out += from_markup(store, clip)
        if "stems" not in pathlib.PurePosixPath(clip).parts:
            out += find_breaks(store, clip)
    return add(store, out)


# ------------------------------------------------------------------ verdicts

def _slice_name(taken: set[str], want: str) -> str:
    if want not in taken:
        return want
    k = 2
    while f"{want}-{k}" in taken:
        k += 1
    return f"{want}-{k}"


def judge(store: Store, cid: str, verdict: str, stars: int | None = None, tags: list[str] | None = None,
          name: str | None = None, crates: list[str] | None = None, by: str = "person") -> dict:
    """Record a verdict. Keep writes (or updates) a curated slice in the clip's manifest; skip or
    later removes one this candidate made earlier."""
    if verdict not in VERDICTS:
        raise ValueError(f"verdict {verdict!r}: keep, skip or later")
    if stars is not None and not (1 <= int(stars) <= 5):
        raise ValueError("stars run 1–5")
    if stars is not None and verdict != "keep":
        raise ValueError("stars go on kept material")
    if name is not None and not NAME.match(name):
        raise ValueError(f"name {name!r}: letters, digits, - and _ only")
    for c in crates or []:
        if not NAME.match(c):
            raise ValueError(f"crate {c!r}: letters, digits, - and _ only")
    cand = next((c for c in store.read("candidates")["candidates"] if c["id"] == cid), None)
    if cand is None:
        raise KeyError(f"no candidate {cid}")
    v = {"verdict": verdict, "at": now(), "by": by}
    if stars is not None:
        v["stars"] = int(stars)
    if tags:
        v["tags"] = sorted(set(tags))
    if name:
        v["name"] = name
    with store.edit("verdicts") as data:
        data["verdicts"][cid] = v
    with store.edit("crates") as data:
        for cr in data["crates"].values():
            if verdict != "keep" and cid in cr["items"]:
                cr["items"].remove(cid)
        for cr in crates or []:
            items = data["crates"].setdefault(cr, {"items": [], "note": ""})["items"]
            if cid not in items:
                items.append(cid)
    v["slice"] = _write_slice(store, cand, v if verdict == "keep" else None)
    return v


def _write_slice(store: Store, cand: dict, v: dict | None) -> str | None:
    """Mirror a verdict into the clip's manifest: one curated slice per kept candidate."""
    mp = store.manifest_path(cand["clip"])
    with open(store.dir / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        m = json.loads(mp.read_text())
        ann = m.setdefault("annotations", {})
        slices = [s for s in ann.get("clips", []) if s.get("candidate") != cand["id"]]
        made = None
        if v is not None:
            made = _slice_name({s["name"] for s in slices}, v.get("name") or cand["name"])
            s = {"name": made, "start": cand["start"], "end": cand["end"], "source": "curated", "tags": [cand["kind"]] + v.get("tags", []), "candidate": cand["id"]}
            if "stars" in v:
                s["stars"] = v["stars"]
            ev = {k: val for p in cand["proposers"] for k, val in p.get("evidence", {}).items()}
            if ev:
                s["evidence"] = ev
            slices.append(s)
        ann["clips"] = slices
        m["apricity_manifest"] = 2
        tmp = mp.with_suffix(".tmp")
        tmp.write_text(json.dumps(m, indent=1) + "\n")
        tmp.replace(mp)
    return made


# ------------------------------------------------------------------ taste

def _weight(v: dict) -> float | None:
    """How much a verdict says "more like this": keep 1 (low stars less), skip 0, later: nothing."""
    if v["verdict"] == "skip":
        return 0.0
    if v["verdict"] == "keep":
        return {1: 0.4, 2: 0.7}.get(v.get("stars"), 1.0)
    return None


def _traits(c: dict) -> dict[str, str]:
    return {"kind": c["kind"], "proposer": c["proposers"][0]["by"], "recording": c["recording"], "stem": c["context"].get("stem") or "full mix"}


TRAIT_WORDS = {"kind": lambda v: f"{v}s", "proposer": lambda v: f"{v}'s picks", "recording": lambda v: f"from {v}", "stem": lambda v: f"{v} clips"}


def rank(candidates: list[dict], verdicts: dict[str, dict]) -> list[dict]:
    """Unjudged candidates (then ones put off for later), best first. Rank = the proposers' best
    score × a lift per trait (kind, proposer, recording, stem): that trait's smoothed keep rate
    over the overall keep rate, from the verdicts so far."""
    judged = [(c, w) for c in candidates if (v := verdicts.get(c["id"])) and (w := _weight(v)) is not None]
    total, kept = len(judged), sum(w for _, w in judged)
    base = (kept + 1) / (total + 2)
    stats: dict[tuple[str, str], list[float]] = {}
    for c, w in judged:
        for t, val in _traits(c).items():
            s = stats.setdefault((t, val), [0.0, 0])
            s[0] += w
            s[1] += 1
    out = []
    for c in candidates:
        v = verdicts.get(c["id"])
        if v and v["verdict"] != "later":
            continue
        score = max(p["score"] for p in c["proposers"])
        lift, reasons = 1.0, []
        for t, val in _traits(c).items():
            k, n = stats.get((t, val), (0.0, 0))
            if n == 0:
                continue
            f = ((k + 1) / (n + 2)) / base
            lift *= f
            # Only say it when it's true in plain words: "kept" needs a keep, "skipped" a skip.
            if n >= 2 and abs(f - 1) > 0.15 and (k >= 1 if f > 1 else n - k >= 1):
                reasons.append((abs(np.log(f)), f"you kept {k:g} of {n} {TRAIT_WORDS[t](val)}" if f > 1 else f"you skipped {n - k:g} of {n} {TRAIT_WORDS[t](val)}"))
        why = [r for _, r in sorted(reasons, reverse=True)[:2]]
        out.append({**c, "rank": round(score * lift, 4), "score": score, "why_ranked": why, "later": bool(v)})
    out.sort(key=lambda c: (c["later"], -c["rank"]))
    return out


def feed(store: Store, kind: str | None = None, recording_: str | None = None, include_later: bool = True, limit: int | None = None) -> list[dict]:
    cands = store.read("candidates")["candidates"]
    ranked = rank(cands, store.read("verdicts")["verdicts"])
    ranked = [c for c in ranked if (kind is None or c["kind"] == kind) and (recording_ is None or c["recording"] == recording_) and (include_later or not c["later"])]
    return ranked[:limit] if limit else ranked


# ------------------------------------------------------------------ crates

def crate_items(store: Store, name: str) -> list[dict]:
    crates = store.read("crates")["crates"]
    if name not in crates:
        raise KeyError(f"no crate {name!r}; crates: {', '.join(sorted(crates)) or 'none yet'}")
    by_id = {c["id"]: c for c in store.read("candidates")["candidates"]}
    verdicts = store.read("verdicts")["verdicts"]
    return [{**by_id[i], "verdict": verdicts.get(i, {})} for i in crates[name]["items"] if i in by_id]


def export_apr(store: Store, name: str) -> str:
    """A crate as `.apr` text: a clip line per source, and a drum-kit block with a pad per item
    (the pad plays the curated slice). Paste it into a score, or let an agent build on it."""
    items = crate_items(store, name)
    clips: dict[str, str] = {}
    lines, pads = [f"# crate {name}: {len(items)} item{'s' if len(items) != 1 else ''}"], []
    for it in items:
        cn = clips.setdefault(it["clip"], re.sub(r"[^A-Za-z0-9_-]", "-", f"{it['recording']}-{it['context'].get('stem') or 'mix'}").lower())
        m = store.manifest(it["clip"])
        ann = m.get("annotations", {})
        sl = next((s["name"] for s in ann.get("clips", []) if s.get("candidate") == it["id"]), None)
        where = sl if sl else f"seconds {it['start']}..{it['end']}"
        pad = re.sub(r"[^A-Za-z0-9_-]", "-", sl or it["name"])
        stars = it["verdict"].get("stars")
        pads.append(f"  {pad} = {cn}  {where}" + (f"   # {'★' * stars}" if stars else ""))
    for clip, cn in clips.items():
        lines.append(f"clip {cn} = {clip}")
    kit = re.sub(r"[^A-Za-z0-9_-]", "-", name)
    return "\n".join(lines + ["", f"kit {kit}"] + pads) + "\n"


# ------------------------------------------------------------------ audition

@contextlib.contextmanager
def _quiet_stderr():
    """Silence C libraries writing straight to file descriptor 2."""
    import os

    sys.stderr.flush()
    saved = os.dup(2)
    try:
        with open(os.devnull, "w") as null:
            os.dup2(null.fileno(), 2)
            yield
    finally:
        os.dup2(saved, 2)
        os.close(saved)


def audition(store: Store, cand: dict, repeats: int | None = None) -> tuple[np.ndarray, int]:
    """The candidate's audio (loops and breaks twice, to hear the join)."""
    import soundfile as sf

    path = store.samples / cand["clip"]
    with _quiet_stderr():  # libmpg123 complains about harmless ID3 oddities on stderr
        info = sf.info(str(path))
        a, b = int(cand["start"] * info.samplerate), int(cand["end"] * info.samplerate)
        x, sr = sf.read(str(path), start=a, stop=b, always_2d=True, dtype="float32")
    fade = min(len(x) // 2, int(0.004 * sr))
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)[:, None]
        x[:fade] *= ramp
        x[-fade:] *= ramp[::-1]
    n = repeats or (2 if cand["kind"] in ("loop", "break") else 1)
    return np.concatenate([x] * n), sr


# ------------------------------------------------------------------ terminal feed

def _card(c: dict, i: int, n: int) -> str:
    ctx = c["context"]
    head = f"[{i}/{n}] {c['kind'].upper()}  {c['recording']}{' · ' + ctx['stem'] if ctx.get('stem') else ''}  {c['start']:.2f}–{c['end']:.2f} s"
    facts = ", ".join(x for x in [f"{ctx['seconds']:.1f} s", f"{ctx['beats']:g} beats" if ctx.get("beats") else "", f"{ctx['bpm']:.0f} BPM" if ctx.get("bpm") else "", ctx.get("key") or ""] if x)
    lines = [head, f"    {facts}"]
    for p in c["proposers"]:
        lines.append(f"    {p['by']}: {p['why']}")
    if c["why_ranked"]:
        lines.append(f"    ranked here because {'; '.join(c['why_ranked'])}")
    if c["later"]:
        lines.append("    (you put this off for later)")
    return "\n".join(lines)


def _key() -> str:
    import termios
    import tty

    if not sys.stdin.isatty():
        return sys.stdin.read(1) or "q"
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def terminal_feed(store: Store, kind: str | None = None, audio: bool = True) -> int:
    import subprocess
    import tempfile

    import soundfile as sf

    if not feed(store, kind=kind, limit=1):
        print("The feed is empty. Propose some: python -m apricity_analyze.curation propose samples")
        return 0
    print("keys: k keep · 1–5 keep with stars · s skip · l later · t tags · n name · c crate · r replay · q quit\n")
    player = None
    tmp = pathlib.Path(tempfile.gettempdir()) / "apricity-audition.wav"
    seen: set[str] = set()
    i = 0
    while True:
        # Re-rank after every verdict, so what you teach it shows at once.
        items = [c for c in feed(store, kind=kind) if c["id"] not in seen]
        if not items:
            break
        c = items[0]
        seen.add(c["id"])
        i += 1
        print(_card(c, i, i - 1 + len(items)))
        tags, name, crates = [], None, []
        while True:
            if player is None or player.poll() is not None:
                x, sr = audition(store, c)
                sf.write(tmp, x, sr)
                player = subprocess.Popen(["afplay", str(tmp)]) if audio and sys.platform == "darwin" else None
            k = _key()
            if k == "r":
                if player:
                    player.kill()
                player = None
                continue
            if k in "tnc":
                if player:
                    player.kill()
                prompt = {"t": "tags (space-separated): ", "n": "name: ", "c": "crates (space-separated): "}[k]
                print(prompt, end="", flush=True)
                text = sys.stdin.readline().split()
                if k == "t":
                    tags += text
                elif k == "n" and text:
                    name = text[0]
                elif k == "c":
                    crates += text
                continue
            if player:
                player.kill()
                player = None
            if k == "q":
                return 0
            verdict, stars = {"k": ("keep", None), "s": ("skip", None), "l": ("later", None)}.get(k, ("keep", int(k)) if k in "12345" else (None, None))
            if verdict is None:
                continue
            try:
                v = judge(store, c["id"], verdict, stars=stars, tags=tags, name=name, crates=crates)
            except ValueError as e:
                print(f"    ✗ {e}")
                continue
            print(f"    → {verdict}{' ' + '★' * stars if stars else ''}{' as slice ' + v['slice'] if v.get('slice') else ''}\n")
            break
    print("That's the whole feed.")
    return 0


# ------------------------------------------------------------------ CLI

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="curation", description=__doc__.split("\n\n")[0])
    ap.add_argument("--library", type=pathlib.Path, default=LIBRARY)
    ap.add_argument("--samples", type=pathlib.Path, default=SAMPLES)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("propose", help="run the analyzers over analyzed clips")
    p.add_argument("paths", nargs="+", type=pathlib.Path)
    p = sub.add_parser("add", help="propose one candidate (for agents and people)")
    p.add_argument("clip", help="path relative to samples/")
    p.add_argument("start", type=float)
    p.add_argument("end", type=float)
    p.add_argument("--kind", required=True, choices=KINDS)
    p.add_argument("--by", required=True, help="agent:<name> or analyzer:<name>")
    p.add_argument("--why", required=True)
    p.add_argument("--score", type=float, default=0.5)
    p.add_argument("--name")
    p.add_argument("--evidence", nargs="*", default=[], help="name=value …")
    p = sub.add_parser("feed", help="audition and judge the feed in the terminal")
    p.add_argument("--kind", choices=KINDS)
    p.add_argument("--no-audio", action="store_true", help="don't play the candidates")
    p = sub.add_parser("list", help="print the ranked feed")
    p.add_argument("--kind", choices=KINDS)
    p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("judge", help="record a verdict")
    p.add_argument("id")
    p.add_argument("verdict", choices=VERDICTS)
    p.add_argument("--stars", type=int)
    p.add_argument("--tags", nargs="*", default=[])
    p.add_argument("--name")
    p.add_argument("--crate", nargs="*", default=[])
    p = sub.add_parser("crates", help="list crates, or export one as .apr text")
    p.add_argument("name", nargs="?")
    a = ap.parse_args(argv)
    store = Store(a.library, a.samples)
    try:
        if a.cmd == "propose":
            made = [c for path in a.paths for c in propose_all(store, path)]
            kinds = {}
            for c in made:
                kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
            print(f"{len(made)} candidates proposed: " + ", ".join(f"{n} {k}{'s' if n != 1 else ''}" for k, n in sorted(kinds.items())))
        elif a.cmd == "add":
            ev = dict(e.split("=", 1) for e in a.evidence)
            c = propose(store, a.clip, a.start, a.end, a.kind, a.by, a.why, a.score, {k: float(v) for k, v in ev.items()}, a.name)
            print(c["id"])
        elif a.cmd == "feed":
            return terminal_feed(store, a.kind, audio=not a.no_audio)
        elif a.cmd == "list":
            items = feed(store, kind=a.kind)
            for i, c in enumerate(items[: a.limit], 1):
                print(f"{c['id']}  rank {c['rank']:.2f}  " + _card(c, i, len(items)).split("\n", 1)[0].split("] ", 1)[1])
                print("\n".join(_card(c, i, len(items)).split("\n")[1:]))
        elif a.cmd == "judge":
            v = judge(store, a.id, a.verdict, a.stars, a.tags, a.name, a.crate)
            print(json.dumps(v))
        elif a.cmd == "crates":
            if a.name:
                print(export_apr(store, a.name), end="")
            else:
                for n, cr in sorted(store.read("crates")["crates"].items()):
                    print(f"{n}: {len(cr['items'])} items")
    except (ValueError, KeyError) as e:
        print(f"✗ {e.args[0] if e.args else e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
