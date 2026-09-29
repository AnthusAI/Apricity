"""Internet Archive search, keeping only items with a license Apricity can use."""
from __future__ import annotations

import json
import re
import urllib.parse

from . import cclicense, loc


def search(text: str = "", count: int = 25, per_item: int = 3, max_seconds: int = 480) -> list[dict]:
    q = "mediatype:audio AND licenseurl:[* TO *] AND collection:(netlabels OR audio_music OR folksoundomy OR opensource_audio OR etree OR 78rpm)" + (f" AND ({text})" if text else "")
    params = [("q", q), ("rows", count * 4), ("output", "json"), ("sort[]", "downloads desc")] + \
             [("fl[]", f) for f in ("identifier", "title", "creator", "licenseurl", "year", "collection")]
    docs = json.loads(loc.get("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params), pause=0.5))["response"]["docs"]
    out = []
    for d in docs:
        code, why = cclicense.classify(d.get("licenseurl"))
        # Public-domain audiobook readings are not music.
        colls = d.get("collection") or []
        if "librivox" in d["identifier"].lower() or any("librivox" in c or c.startswith("audio_books") for c in ([colls] if isinstance(colls, str) else colls)):
            continue
        if not code:
            continue
        meta = json.loads(loc.get(f"https://archive.org/metadata/{d['identifier']}", pause=0.5))
        # One entry per track: the archive keeps the same mp3 again at 64 and 128 kbps.
        files = [f for f in meta.get("files", []) if f.get("name", "").lower().endswith(".mp3")
                 and not re.search(r"_(64|128)kb\.mp3$", f["name"], re.I)]
        for f in files[:per_item]:
            secs = float(f["length"]) if str(f.get("length", "")).replace(".", "", 1).isdigit() else 0
            if secs and not 2 <= secs <= max_seconds:  # skip fragments and hour-long sets
                continue
            out.append({
                "id": f"ia:{d['identifier']}/{f['name']}", "title": f.get("title") or d.get("title", d["identifier"]),
                "who": d.get("creator") if isinstance(d.get("creator"), str) else ", ".join(d.get("creator") or []) or "—",
                "year": str(d.get("year") or ""), "license": code, "license_url": d["licenseurl"],
                "audio": f"https://archive.org/download/{d['identifier']}/{urllib.parse.quote(f['name'])}",
                "page": f"https://archive.org/details/{d['identifier']}", "duration": f"{int(secs // 60)}:{int(secs % 60):02d}" if secs else "",
                "tags": "", "notes": ((d.get("title") or "") + " · " if f.get("title") else "") + "license is as declared by the uploader; verify before importing", "size": int(f["size"]) if f.get("size", "").isdigit() else None,
            })
        if len({o["id"].split("/")[0] for o in out}) >= count:
            break
    return out
