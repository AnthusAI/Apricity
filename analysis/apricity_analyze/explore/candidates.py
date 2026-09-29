"""Candidate clips to swap into one role. `auto` mode: the user's own rated loops first (the
best signal of their taste -- never mixed into the objective, only used to order candidates),
then loop-/sec- clips from ccMixter source recordings at 90-130 bpm, filtered by license (no ND,
no NC -- sampling means slicing/warping/re-pitching the clip).
"""

from __future__ import annotations

import dataclasses
import json
import pathlib

from .. import cclicense

ROOT = pathlib.Path(__file__).resolve().parents[3]
SAMPLES = ROOT / "samples"
BPM_MIN, BPM_MAX = 90.0, 130.0


@dataclasses.dataclass
class Candidate:
    sample: str    # e.g. "ccmixter/CSoul/we-lived-....mp3"
    clip: str      # e.g. "loop-1"
    source: str    # dedup key: the recording this clip comes from (its sample path)
    attribution: str
    rated: bool = False
    stars: int = 0


def _manifest_for(sample_rel: str) -> dict | None:
    p = SAMPLES / f"{sample_rel}.apricity.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _license_ok(entry: dict) -> tuple[bool, str]:
    code = entry.get("license")
    if code and code in cclicense.NAMES:
        return True, cclicense.NAMES[code]
    code, reason = cclicense.classify(entry.get("rights"))
    return code is not None, reason


def rated_candidates(library: pathlib.Path, min_stars: int = 1) -> list[Candidate]:
    """The user's own rated clips (best first), reusing the write-score skill's `ratings.py`
    logic: read the library's Rating/Clip/Sample records. Empty when there's no library (a fresh
    checkout, or a CI/sandbox with no `~/Apricity-Library`) -- that's not an error, just no prior."""
    def load(folder: pathlib.Path) -> dict:
        return {json.loads(p.read_text())["id"]: json.loads(p.read_text()) for p in folder.glob("*.json")} if folder.is_dir() else {}

    clips, samples = load(library / "Clip"), load(library / "Sample")
    out = []
    for r in load(library / "Rating").values():
        stars = r.get("stars", 0)
        if stars < min_stars or r.get("targetType") != "clip":
            continue
        c = clips.get(r.get("targetId"))
        if not c:
            continue
        s = samples.get(c.get("sampleId"), {})
        path = s.get("path")
        if not path:
            continue
        out.append(Candidate(sample=path, clip=c["name"], source=path, attribution=f"{path} (rated {'*' * stars})", rated=True, stars=stars))
    out.sort(key=lambda c: -c.stars)
    return out


def ccmixter_candidates(exclude_samples: set[str] | None = None) -> list[Candidate]:
    """Every loop-/sec- saved clip on a ccMixter recording at 90-130 bpm with an allowed license,
    one candidate per (sample, clip) pair, attribution included for the leaderboard."""
    exclude_samples = exclude_samples or set()
    sources_path = SAMPLES / "sources.json"
    entries = {}
    if sources_path.exists():
        try:
            for f in json.loads(sources_path.read_text()).get("files", []):
                entries[f["path"]] = f
        except (json.JSONDecodeError, OSError, KeyError):
            pass

    out: list[Candidate] = []
    for manifest_path in sorted((SAMPLES / "ccmixter").rglob("*.apricity.json")) if (SAMPLES / "ccmixter").is_dir() else []:
        sample_rel = str(manifest_path.relative_to(SAMPLES))[: -len(".apricity.json")]
        if sample_rel in exclude_samples:
            continue
        entry = entries.get(sample_rel)
        if entry is None:
            continue  # no catalog record: can't confirm its license, so it's not a candidate
        ok, reason = _license_ok(entry)
        if not ok:
            continue
        m = _manifest_for(sample_rel)
        if not m:
            continue
        bpm = m.get("rhythm", {}).get("bpm")
        if bpm is None or not (BPM_MIN <= bpm <= BPM_MAX):
            continue
        credit = entry.get("credit", entry.get("author", sample_rel))
        source_page = entry.get("source_page", "")
        attribution = f"{credit} ({reason}){', ' + source_page if source_page else ''}"
        for c in m.get("annotations", {}).get("clips", []):
            name = c.get("name", "")
            if name.startswith("loop-") or name.startswith("sec-"):
                out.append(Candidate(sample=sample_rel, clip=name, source=sample_rel, attribution=attribution))
    return out


def region_candidates(prefixes: tuple[str, ...], *, exclude_samples: set[str] | None = None,
                       bpm_range: tuple[float, float] = (BPM_MIN, BPM_MAX)) -> list[Candidate]:
    """Every saved clip whose name starts with one of `prefixes` (e.g. `("hold-",)` for a pitched
    role, `("shot-",)` for a kit role, `("loop-", "sec-")` for a loop role), on any recording
    catalogued in `sources.json` with an allowed license -- across every source family the catalog
    covers, not restricted to a single one (an earlier pass scanned only one source subtree, which
    collapsed the MAP-Elites archive's `source_family` axis to a single value). A sample subtree
    with no `sources.json` entry is silently excluded by the same `entries.get(sample_rel) is None`
    check `ccmixter_candidates` already used -- this is the explorer's existing license filter,
    reused verbatim, not a new or looser one."""
    exclude_samples = exclude_samples or set()
    sources_path = SAMPLES / "sources.json"
    entries = {}
    if sources_path.exists():
        try:
            for f in json.loads(sources_path.read_text()).get("files", []):
                entries[f["path"]] = f
        except (json.JSONDecodeError, OSError, KeyError):
            pass

    out: list[Candidate] = []
    for manifest_path in sorted(SAMPLES.rglob("*.apricity.json")) if SAMPLES.is_dir() else []:
        sample_rel = str(manifest_path.relative_to(SAMPLES))[: -len(".apricity.json")]
        if sample_rel in exclude_samples:
            continue
        entry = entries.get(sample_rel)
        if entry is None:
            continue  # no catalog record (e.g. salamander-drumkit/, voice/): can't confirm license
        ok, reason = _license_ok(entry)
        if not ok:
            continue
        m = _manifest_for(sample_rel)
        if not m:
            continue
        bpm = m.get("rhythm", {}).get("bpm")
        if bpm is None or not (bpm_range[0] <= bpm <= bpm_range[1]):
            continue
        credit = entry.get("credit", entry.get("author", sample_rel))
        source_page = entry.get("source_page", "")
        attribution = f"{credit} ({reason}){', ' + source_page if source_page else ''}"
        for c in m.get("annotations", {}).get("clips", []):
            name = c.get("name", "")
            if any(name.startswith(p) for p in prefixes):
                out.append(Candidate(sample=sample_rel, clip=name, source=sample_rel, attribution=attribution))
    return out


def auto_candidates(n: int, *, library: pathlib.Path | None = None, exclude_samples: set[str] | None = None) -> list[Candidate]:
    """Rated clips first (best stars first), then ccMixter loop-/sec- clips (licensed, 90-130
    bpm), stopping at `n` total. No dedup beyond what each source already offers -- the outer
    loop's "one survivor per source recording" diversity rule is a *search* concern, applied
    after these are scored, not a candidate-generation one."""
    library = library or (pathlib.Path.home() / "Apricity-Library")
    exclude_samples = exclude_samples or set()
    rated = [c for c in rated_candidates(library) if c.sample not in exclude_samples]
    rest = ccmixter_candidates(exclude_samples=exclude_samples)
    seen = {(c.sample, c.clip) for c in rated}
    rest = [c for c in rest if (c.sample, c.clip) not in seen]
    return (rated + rest)[:n]
