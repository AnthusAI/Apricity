"""Small loc.gov client shared by scripts/catalog-add-loc.py and scripts/preview.py (also the polite fetch
the ccMixter and Internet Archive adapters use)."""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

UA = {"User-Agent": "Apricity/0.1"}


def get(url: str, pause: float = 1.5, headers: dict | None = None) -> bytes:
    """Fetch with a pause and backoff: loc.gov answers 429 to fast callers."""
    for wait in (2, 15, 45, 120, 0):
        time.sleep(pause)
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **(headers or {})})).read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or not wait:
                raise
            print(f"  loc.gov says {e.code}; waiting {wait}s", flush=True)
            time.sleep(wait)
    raise AssertionError("unreachable")


def item(item_id: str) -> dict:
    return json.loads(get(f"https://www.loc.gov/item/{item_id}/?fo=json"))


def search(path: str, query: str, count: int = 25) -> list[str]:
    """Item ids from a loc.gov collection search, e.g. path='collections/national-jukebox'."""
    q = urllib.parse.urlencode({"q": query, "fo": "json", "c": count})
    d = json.loads(get(f"https://www.loc.gov/{path.strip('/')}/?{q}"))
    return [m.group(1) for r in d.get("results", []) if (m := re.search(r"/item/([^/]+)/?", r.get("id", "")))]


def audio_url(d: dict) -> str:
    files = [f for r in d["resources"] for g in r.get("files", []) for f in g if isinstance(f, dict)]
    for f in files:  # a directly downloadable mp3, else the storage-service mp3
        if f.get("canDownload") and f.get("download", "").endswith(".mp3"):
            return f["download"]
    for r in d["resources"]:
        for k in ("filename", "derivativeUrl"):
            if r.get(k, "").endswith(".mp3"):
                return r[k]
    raise SystemExit("no downloadable mp3 for this item")


def people(it: dict, lomax: bool) -> list[str]:
    out = []
    for n in it.get("contributor_names", []):
        if lomax:
            if "(Performer)" in n:
                out.append(n.replace(" (Performer)", ""))
        else:
            name, _, role = n.partition(" -- ")
            if not re.search(r"Composer|Lyricist|Author|Arranger", role):
                out.append(name)
    return out


def candidate(item_id: str) -> dict | None:
    """A loc.gov item as a preview candidate (see scripts/preview.py), or None with no playable audio."""
    import html
    import re as _re
    try:
        d = item(item_id)
        it = d["item"]
        url = audio_url(d)
    except (SystemExit, KeyError, StopIteration):
        return None
    rights = _re.sub(r"\s+", " ", _re.sub(r"<[^>]+>", " ", " ".join(it.get("rights") or [it.get("rights_advisory") or ""]))).strip()
    year = it.get("date", "")[:4]
    return {"id": item_id, "title": it["title"], "who": ", ".join(people(it, item_id.startswith("lomaxbib"))) or "—",
            "year": year, "license": None, "license_url": None, "audio": url, "page": it["url"], "duration": "", "tags": "",
            "notes": " ".join(it.get("notes") or [])[:260], "rights": rights[:260],
            "warn": "after 1925: not public domain" if year.isdigit() and int(year) > 1925 else ""}
