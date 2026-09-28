#!/usr/bin/env python3
"""Search the user's locally rated sounds, best first by default.

    ratings.py                          # ~/Apricity-Library
    ratings.py --library /path/to/lib   # another library folder
    ratings.py --min 4                  # only 4★ and up
    ratings.py --sort recent            # newest clips/samples first
    ratings.py --sort rated             # most recently rated first
    ratings.py --search "house loop"    # match clip/sample metadata

Reads the library's Rating records first, then opens only the referenced Clip, Sample or Score records. This matters
for large local libraries: a ratings query should not read every Clip JSON just to show a few favorites.
Each rated clip is printed ready for a score: `<sample path>  <saved clip>`, e.g.
`marine-band/stems/LibertyBell/other.wav  loop-1`. Ratings made on the live site live in its database,
not in this folder.
"""

import argparse
import json
import pathlib


def load(folder: pathlib.Path) -> dict:
    """Read each file once; used for the small Rating folder."""
    if not folder.is_dir():
        return {}
    rows = {}
    for path in folder.glob("*.json"):
        record = json.loads(path.read_text())
        if record.get("id"):
            rows[record["id"]] = record
    return rows


def read_record(folder: pathlib.Path, record_id: str) -> dict | None:
    """Read one record by its library key without enumerating the model folder."""
    try:
        return json.loads((folder / f"{record_id}.json").read_text())
    except FileNotFoundError:
        return None


def find_rated(lib: pathlib.Path, minimum: int = 1, query: str = "", sort: str = "stars") -> list[dict]:
    """Return matching local ratings, loading only records those ratings refer to."""
    if sort not in ("stars", "recent", "rated"):
        raise ValueError(f"unknown sort: {sort}")
    terms = query.casefold().split()
    rows = []
    folders = {name: lib / name for name in ("Clip", "Sample", "Score")}
    for rating in load(lib / "Rating").values():
        stars = int(rating.get("stars", 0))
        if stars < minimum:
            continue
        kind, target_id = rating.get("targetType"), rating.get("targetId", "")
        rated_at = rating.get("ratedAt") or rating.get("updatedAt") or ""
        created_at = ""
        if kind == "clip":
            clip = read_record(folders["Clip"], target_id)
            if clip:
                sample = read_record(folders["Sample"], clip.get("sampleId", "")) or {}
                path = sample.get("path", "?")
                name = clip.get("name", target_id)
                what = f"{path}  {name}"
                created_at = clip.get("createdAt") or ""
                duration = max(0, float(clip.get("end", 0)) - float(clip.get("start", 0)))
                tags = ",".join(str(t) for t in clip.get("tags", []) if not str(t).endswith("s"))
                kind_hint = clip.get("kind") or name.rsplit("-", 1)[0]
                detail_parts = [f"{duration:.1f}s", kind_hint, tags]
                for value, suffix in ((sample.get("key"), ""), (sample.get("bpm"), " BPM")):
                    if value:
                        detail_parts.append(f"{value}{suffix}")
                if clip.get("createdAt"):
                    detail_parts.append(f"added {str(clip['createdAt'])[:10]}")
                detail = "  ".join(p for p in detail_parts if p)
                search = " ".join([what, detail, sample.get("title", ""), *map(str, clip.get("tags", []))])
            else:
                what, detail = f"clip {target_id}", "(no longer in the library)"
                search = what
        elif kind == "sample":
            sample = read_record(folders["Sample"], target_id)
            if sample:
                created_at = sample.get("createdAt") or ""
                what = sample.get("path", target_id)
                detail = f"whole sample  {sample.get('key', '')}  {sample.get('bpm', '')} bpm"
                search = " ".join([what, detail, sample.get("title", ""), *map(str, sample.get("tags", []))])
            else:
                what, detail = f"sample {target_id}", "(no longer in the library)"
                search = what
        elif kind == "score":
            score = read_record(folders["Score"], target_id)
            created_at = (score.get("createdAt") or "") if score else ""
            what = f"score {score.get('title', target_id)}" if score else f"score {target_id}"
            detail = "" if score else "(no longer in the library)"
            search = " ".join([what, detail, *map(str, score.get("tags", []) if score else [])])
        else:
            what, detail = f"{kind} {target_id}", "(no longer in the library)"
            search = what
        if all(term in search.casefold() for term in terms):
            rows.append({"stars": stars, "ratedAt": rated_at, "createdAt": created_at, "what": what, "detail": detail})
    if sort == "recent":
        rows.sort(key=lambda row: (row["createdAt"], row["stars"], row["what"]), reverse=True)
    elif sort == "rated":
        rows.sort(key=lambda row: (row["ratedAt"], row["stars"], row["what"]), reverse=True)
    else:
        rows.sort(key=lambda row: (-row["stars"], row["what"]))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", default=str(pathlib.Path.home() / "Apricity-Library"))
    ap.add_argument("--min", type=int, default=1)
    ap.add_argument("--sort", choices=("stars", "recent", "rated"), default="stars", help="stars (default), newest item, or most recently rated")
    ap.add_argument("--search", "--query", "--q", default="", help="match words in clip/sample path, name, title, kind or tags")
    a = ap.parse_args()
    lib = pathlib.Path(a.library)
    rows = find_rated(lib, minimum=a.min, query=a.search, sort=a.sort)
    if not rows:
        print(f"no ratings in {lib}")
        return
    for row in rows:
        rated = f"rated {row['ratedAt'][:10]}" if row["ratedAt"] else ""
        print(f"{'★' * row['stars']:<5} {row['what']:<70} {row['detail']}  {rated}".rstrip())


if __name__ == "__main__":
    main()
