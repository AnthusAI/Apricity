#!/usr/bin/env python3
"""Import approved Library of Congress items (Lomax `lomaxbib000283`, National Jukebox `jukebox-651958`).

  PYTHONPATH=analysis analysis/.venv/bin/python scripts/catalog-add-loc.py ID [ID ...] [--denoise SPEC]

For each item: download the audio into samples/loc/<collection>/, add it to crates/apricity-sources/
catalog/sources.json and samples/sources.json, then analyze it. Noise reduction is ON by default
(neural:medium, or $APRICITY_DENOISE): the original is kept untouched and the analysis is of the
`.clean.wav` copy. `--denoise off` skips it; SPEC is BACKEND[+BACKEND][:STRENGTH]. Idempotent."""
import argparse, hashlib, json, pathlib, re

from apricity_analyze import cli, denoise, loc

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOMAX = dict(id="loc-lomax-1939", dir="lomax-1939",
    title="Library of Congress: Lomax 1939 Southern States Recording Trip (curated)",
    credit="John and Ruby Lomax 1939 southern states recording trip (AFC 1939/001), American Folklife Center, Library of Congress.",
    rights="No known U.S. copyright or other restrictions per the Library of Congress (AFC 1939/001); privacy and publicity rights may apply.",
    page="https://www.loc.gov/collections/john-and-ruby-lomax/about-this-collection/")
JUKEBOX = dict(id="loc-national-jukebox", dir="national-jukebox",
    title="Library of Congress: National Jukebox (curated)",
    credit="National Jukebox, Library of Congress (Victor Talking Machine Company recordings).",
    rights="Public domain (published before 1923; Music Modernization Act).",
    page="https://www.loc.gov/collections/national-jukebox/about-this-collection/")
JUKEBOX_LATE = dict(JUKEBOX, id="loc-national-jukebox-1923-25", title="Library of Congress: National Jukebox, 1923-1925 (curated)",
    rights="Public domain (published 1923-1925; 100 years since publication, Music Modernization Act).")

get, audio_url, people = loc.get, loc.audio_url, loc.people

def add(item_id):
    d = loc.item(item_id)
    item = d["item"]; lomax = item_id.startswith("lomaxbib")
    year = int(item["date"][:4]); title = item["title"]
    if year > 1925:
        raise SystemExit(f"{item_id} ({title}, {year}) is not public domain yet; not importing")
    col = LOMAX if lomax else (JUKEBOX if year < 1923 else JUKEBOX_LATE)
    who = people(item, lomax)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")
    path = f"loc/{col['dir']}/{slug}_{item_id}.mp3"
    url = audio_url(d); data = get(url)
    dest = ROOT / "samples" / path; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(data)
    sha, size = hashlib.sha256(data).hexdigest(), len(data)
    entry = {"path": path, "url": url, "fetch": "http", "title": title, "size": size, "sha256": sha}

    p = ROOT / "crates/apricity-sources/catalog/sources.json"
    cat = json.load(open(p)); src = next((s for s in cat if s["id"] == col["id"]), None)
    if not src:
        src = {"id": col["id"], "title": col["title"], "credit": col["credit"], "rights": col["rights"],
               "source_page": col["page"], "files": []}
        cat.append(src)
    src["files"] = [f for f in src["files"] if f["path"] != path] + [entry]
    p.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")

    p = ROOT / "samples/sources.json"; flat = json.load(open(p))
    credit = col["credit"] + (f" Performer: {', '.join(who)}." if who else "")
    flat["files"] = [f for f in flat["files"] if f["path"] != path] + [{
        "path": path, "url": url, "fetch": "http", "title": title, **({"performer": ", ".join(who)} if who else {}),
        "recorded": year, "source_page": item["url"], "credit": credit, "rights": col["rights"]}]
    p.write_text(json.dumps(flat, indent=2, ensure_ascii=False))
    print(f"{title} ({year}): {size} bytes {sha[:12]}  {path}")
    return dest

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("ids", nargs="+")
    ap.add_argument("--denoise", default=denoise.DEFAULT, metavar="SPEC", help=f"default {denoise.DEFAULT}; off to skip")
    ap.add_argument("--no-analyze", action="store_true")
    a = ap.parse_args()
    files = [add(i) for i in a.ids]
    if not a.no_analyze:
        cli.main(["--denoise", a.denoise, *map(str, files)])

main()
