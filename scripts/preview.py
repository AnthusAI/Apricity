#!/usr/bin/env python3
"""Audition candidate recordings before importing any. Nothing is downloaded: each player streams from
the source. Listen, tick the ones you want, copy the ids.

  PYTHONPATH=analysis analysis/.venv/bin/python scripts/preview.py loc  ID [ID ...]
  PYTHONPATH=analysis analysis/.venv/bin/python scripts/preview.py loc  --search Gershwin [--in collections/national-jukebox]
  PYTHONPATH=analysis analysis/.venv/bin/python scripts/preview.py ccmixter --tags a_cappella [--search words]
  PYTHONPATH=analysis analysis/.venv/bin/python scripts/preview.py ia   --search "acapella OR chant"
Common: --count N (default 25)  --title NAME  --max-minutes M (default 8: longer items are hidden)

ccMixter and Internet Archive results are filtered to licenses Apricity can sample from (public
domain, CC0, CC BY, CC BY-SA); NC and ND are dropped. Writes renders/preview/<title>.html (git-ignored)."""
import argparse, html, pathlib, re

from apricity_analyze import archive_org, cclicense, ccmixter, loc

ROOT = pathlib.Path(__file__).resolve().parent.parent

def card(c):
    lic = ""
    if c.get("license"):
        name = cclicense.NAMES[c["license"]]
        flags = (" · credit required" if c["license"].startswith("cc-by") else "") + (" · <b>share-alike</b>" if "-sa-" in c["license"] else "")
        lic = f" <span class=lic><a href='{html.escape(c['license_url'])}' target=_blank>{name}</a>{flags}</span>"
    dur = f" · {html.escape(c['duration'])}" if c.get("duration") else ""
    meta = " · ".join(x for x in (c.get("year"), c.get("who")) if x)
    extra = "".join(f"<br><small class={k}>{html.escape(c[k])}</small>" for k in ("notes", "tags", "rights") if c.get(k))
    warn = f" <span class=warn>{html.escape(c['warn'])}</span>" if c.get("warn") else ""
    return (f"<li><label><input type=checkbox value='{html.escape(c['id'])}'> <b>{html.escape(c['title'])}</b></label> "
            f"<span class=meta>{html.escape(meta)}{dur}</span>{lic}{warn}<br>"
            f"<audio controls preload=none src='{html.escape(c['audio'])}'></audio> <a href='{html.escape(c['page'])}' target=_blank>page</a> "
            f"<code>{html.escape(c['id'])}</code>{extra}</li>")

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("source", choices=["loc", "ccmixter", "ia"])
    ap.add_argument("ids", nargs="*"); ap.add_argument("--search", default=""); ap.add_argument("--tags", default="")
    ap.add_argument("--in", dest="path", default="collections/national-jukebox"); ap.add_argument("--count", type=int, default=25)
    ap.add_argument("--title", default="")
    ap.add_argument("--max-minutes", type=float, default=8, help="hide anything longer (default 8; 0 = no limit)")
    a = ap.parse_args()
    if a.source == "loc":
        ids = list(dict.fromkeys(a.ids + (loc.search(a.path, a.search, a.count) if a.search else [])))
        cands = []
        for i, x in enumerate(ids, 1):
            print(f"[{i}/{len(ids)}] {x}", flush=True)
            cands.append(loc.candidate(x) or {"id": x, "title": x, "audio": "", "page": "", "warn": "no playable audio"})
    elif a.source == "ccmixter":
        cands = ccmixter.search(a.tags, a.search, a.count)
    else:
        cands = archive_org.search(a.search, a.count)
    if a.max_minutes:  # the importer refuses the same
        cands = [c for c in cands if (cclicense.seconds(c.get("duration")) or 0) <= a.max_minutes * 60]
    title = a.title or " ".join([a.source, a.tags, a.search]).strip()
    out = ROOT / "renders/preview" / (re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-") + ".html")
    out.parent.mkdir(parents=True, exist_ok=True)
    if a.source == "ccmixter":  # its server refuses streaming from other sites: keep a preview copy locally
        cands = [ccmixter.fetch_for_preview(c, out.parent) for c in cands]
    out.write_text(f"""<meta charset=utf-8><title>{html.escape(title)}</title>
<style>body{{font:14px system-ui;max-width:900px;margin:20px auto;padding:0 16px}}li{{margin:0 0 16px;list-style:none;border-bottom:1px solid #ddd;padding-bottom:10px}}
audio{{width:340px;vertical-align:middle}}.meta{{color:#666}}.warn{{color:#b00}}.lic{{background:#eef;padding:1px 6px;border-radius:4px}}small{{color:#777}}
#bar{{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:2px solid #333}}</style>
<div id=bar><b>{html.escape(title)}</b> · {len(cands)} candidates · <span id=n>0</span> ticked <button onclick="copy()">Copy ids</button> <code id=out></code></div>
<ul>{''.join(card(c) for c in cands)}</ul>
<script>const q=()=>[...document.querySelectorAll('input:checked')].map(e=>e.value);
document.addEventListener('change',()=>{{n.textContent=q().length;out.textContent=q().join(' ')}});
function copy(){{navigator.clipboard.writeText(q().join(' '))}}</script>""")
    print(f"{len(cands)} candidates -> {out}")

main()
