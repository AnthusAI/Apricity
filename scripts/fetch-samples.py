#!/usr/bin/env python3
"""Download the sample audio listed in samples/sources.json (skips files already present).

Entries with "fetch": "browser" come from a site that refuses non-browser clients; download
them from the listed source_page in a browser and drop them at samples/<path>.
"""
import json
import pathlib
import sys
import urllib.request

UA = "ApricitusSampleFetcher/0.1 (personal music research tool)"

root = pathlib.Path(__file__).resolve().parent.parent / "samples"
sources = json.loads((root / "sources.json").read_text())["files"]
missing_browser = []
for e in sources:
    dest = root / e["path"]
    if dest.exists():
        continue
    if e["fetch"] != "http":
        if not e.get("optional"):
            missing_browser.append(e)
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"fetching {e['path']}", flush=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(e["url"], headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as out:
        out.write(r.read())
    tmp.rename(dest)
if missing_browser:
    print(f"\n{len(missing_browser)} file(s) need a browser download:", file=sys.stderr)
    for e in missing_browser:
        print(f"  samples/{e['path']}  <-  {e['source_page']}", file=sys.stderr)
