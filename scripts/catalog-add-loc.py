#!/usr/bin/env python3
"""Import approved Library of Congress items (Lomax `lomaxbib000283`, National Jukebox `jukebox-651958`).

  PYTHONPATH=analysis analysis/.venv/bin/python scripts/catalog-add-loc.py ID [ID ...] [--denoise SPEC]

For each item: download the audio into samples/loc/<collection>/, add it to crates/apricity-sources/
catalog/sources.json and samples/sources.json, then analyze it. Noise reduction is ON by default
(neural:medium, or $APRICITY_DENOISE): the original is kept untouched and the analysis is of the
`.clean.wav` copy. `--denoise off` skips it; SPEC is BACKEND[+BACKEND][:STRENGTH]. Idempotent."""
import argparse, hashlib, json, os, pathlib, re, urllib.request

from apricity_analyze import cli, denoise

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

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Apricity/0.1"})).read()

def audio_url(d):
    urls = [f for r in d["resources"] for g in r.get("files", []) for f in g if isinstance(f, dict)]
    for f in urls:  # a directly downloadable mp3, else the storage-service mp3
        if f.get("canDownload") and f.get("download", "").endswith(".mp3"): return f["download"]
    for r in d["resources"]:
        if r.get("filename", "").endswith(".mp3"): return r["filename"]
        if r.get("derivativeUrl", "").endswith(".mp3"): return r["derivativeUrl"]
    raise SystemExit("no downloadable mp3 for this item")

def people(item, lomax):
    out = []
    for n in item.get("contributor_names", []):
        if lomax:
            if "(Performer)" in n: out.append(n.replace(" (Performer)", ""))
        else:
            name, _, role = n.partition(" -- ")
            if not re.search(r"Composer|Lyricist|Author|Arranger", role): out.append(name)
    return out

def add(item_id):
    d = json.loads(get(f"https://www.loc.gov/item/{item_id}/?fo=json"))
    item = d["item"]; lomax = item_id.startswith("lomaxbib")
    year = int(item["date"][:4]); title = item["title"]
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
