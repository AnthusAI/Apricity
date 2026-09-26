"""ccMixter search: a cappellas, stems, loops and remixes, mostly CC BY / CC0."""
from __future__ import annotations

import http.client
import json
import urllib.parse

from . import cclicense, loc

# ccMixter answers GETs with one very long header line, which Python's client refuses by default.
http.client._MAXLINE = 1 << 20


def search(tags: str = "", text: str = "", count: int = 25) -> list[dict]:
    """Candidates whose license Apricity can use. `tags` like a_cappella,drums; `text` free words."""
    q = {"f": "json", "limit": count * 4, "sort": "rank"}
    if tags:
        q["tags"] = tags
    if text:
        q["search"] = text
    rows = json.loads(loc.get("http://ccmixter.org/api/query?" + urllib.parse.urlencode(q), pause=0.5))
    out = []
    for r in rows:
        code, why = cclicense.classify(r.get("license_url"))
        mp3 = next((f for f in r.get("files", []) if f.get("file_nicname") == "mp3"), None)
        if not code or not mp3:
            continue
        out.append({
            "id": f"ccmixter:{r['upload_id']}", "title": r["upload_name"], "who": r.get("user_real_name") or r["user_name"],
            "year": (r.get("upload_date_format") or "")[5:17].split(",")[-1].strip()[-4:] if r.get("upload_date_format") else "",
            "license": code, "license_url": r["license_url"], "audio": mp3["download_url"], "page": r["file_page_url"],
            "duration": mp3.get("file_format_info", {}).get("ps", ""), "tags": (r.get("upload_tags") or "").strip(",")[:120],
            "notes": "", "size": mp3.get("file_rawsize"),
        })
        if len(out) >= count:
            break
    return out
