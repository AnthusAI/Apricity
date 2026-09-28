"""Respectful, provenance-first ingestion from Wikimedia Commons categories.

This module deliberately discovers direct file members only. It refuses media
containers other than audio-only files and only admits the license forms that
Apricity currently classifies.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import http.client
from html.parser import HTMLParser
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Iterable


USER_AGENT = "ApricityCommonsImporter/0.1 (https://github.com/AnthusAI/Apricity; sample catalog)"
API = "https://commons.wikimedia.org/w/api.php"
CATEGORIES = (
    "Category:Audio files of electronic music",
    "Category:Techno music samples",
    "Category:Audio files of house music",
    "Category:Audio files of funk carioca",
)
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus"}
MAX_RETRIES = 5


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value", "")
    parser = TextOnly()
    parser.feed(html.unescape(str(value or "")))
    return " ".join(" ".join(parser.parts).split())


def normalize_license(name: str, url: str, wikitext: str) -> tuple[str | None, str | None]:
    """Return an Apricity license code and its canonical URL, if supported."""
    label = plain(name).strip().casefold().replace("creative commons", "cc")
    candidate = (url or "").strip().lower().replace("http://", "https://")
    candidate = candidate.removesuffix("legalcode").removesuffix("deed")
    candidate = candidate.rstrip("/") + "/" if candidate else ""
    label_code: str | None = None
    label_url: str | None = None
    if "public domain" in label or re.search(r"\{\{\s*(?:pd-|public domain)", wikitext, re.I):
        label_code = "public-domain"
    elif "cc0" in label:
        label_code, label_url = "cc0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"
    else:
        match = re.fullmatch(r"cc\s+by(-sa)?\s+(3\.0|4\.0)(?:\s+\w+)?", label)
        if match:
            variant = "by-sa" if match.group(1) else "by"
            label_code = f"cc-{variant}-{match.group(2)}"
            label_url = f"https://creativecommons.org/licenses/{variant}/{match.group(2)}/"

    url_code: str | None = None
    url_canonical: str | None = None
    if "/publicdomain/zero/1.0" in candidate:
        url_code, url_canonical = "cc0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"
    else:
        match = re.search(r"/licenses/(by-sa|by)/(3\.0|4\.0)(?:/|$)", candidate)
        if match:
            url_code = f"cc-{match.group(1)}-{match.group(2)}"
            url_canonical = f"https://creativecommons.org/licenses/{match.group(1)}/{match.group(2)}/"

    # A Commons page whose displayed license and machine-readable URL disagree is not a
    # cleanly verified license, even when one of the two happens to be supported.
    if label and not label_code:
        return None, None
    if label_code and url_code and label_code != url_code:
        return None, None
    if label_code:
        return label_code, label_url
    if url_code and not label:
        return url_code, url_canonical
    return None, None


def public_domain_reference(wikitext: str) -> str:
    """Link to the Commons tag that records why the uploader claims public domain."""
    match = re.search(r"\{\{\s*(PD(?:-[\w-]+)?|cc-pd)\b", wikitext, re.I)
    if not match:
        return "https://commons.wikimedia.org/wiki/Commons:Copyright_tags"
    template = urllib.parse.quote(match.group(1).replace(" ", "_"), safe="-_")
    return f"https://commons.wikimedia.org/wiki/Template:{template}"


def merge_memberships(category_members: Iterable[tuple[str, Iterable[dict[str, Any]]]]) -> dict[int, dict[str, Any]]:
    """Deduplicate files by page id while retaining all configured category memberships."""
    merged: dict[int, dict[str, Any]] = {}
    for category, members in category_members:
        for member in members:
            if member.get("ns") not in (None, 6):
                continue
            pageid = int(member["pageid"])
            item = merged.setdefault(pageid, {"pageid": pageid, "title": member["title"], "categories": []})
            if category not in item["categories"]:
                item["categories"].append(category)
    return merged


def _revision(page: dict[str, Any]) -> dict[str, Any]:
    rev = (page.get("revisions") or [{}])[0]
    slots = rev.get("slots") or {}
    main = slots.get("main") or {}
    return {
        "revision_id": rev.get("revid"),
        "revision_timestamp": rev.get("timestamp"),
        "raw_wikitext": main.get("content", main.get("*", "")),
    }


@dataclass
class Decision:
    eligible: bool
    record: dict[str, Any] | None = None
    reason: str | None = None


def _page_snapshot(page: dict[str, Any], categories: list[str]) -> dict[str, Any]:
    info = (page.get("imageinfo") or [{}])[0]
    return {
        "platform": "Wikimedia Commons",
        "pageid": page.get("pageid"),
        "title": page.get("title"),
        **_revision(page),
        "categories": list(categories),
        "imageinfo": {k: info.get(k) for k in ("url", "mime", "size", "sha1", "mediatype", "timestamp", "user") if k in info},
        "extmetadata": info.get("extmetadata", {}),
    }


def _author(meta: dict[str, Any]) -> str:
    for key in ("Artist", "Author"):
        value = plain(meta.get(key))
        if value:
            return value
    return ""


def catalog_record(page: dict[str, Any], categories: list[str]) -> dict[str, Any]:
    info = (page.get("imageinfo") or [{}])[0]
    meta = info.get("extmetadata") or {}
    title = plain(meta.get("ObjectName")) or pathlib.PurePosixPath(page.get("title", "File:Untitled").removeprefix("File:")).stem
    author = _author(meta)
    license_name = plain(meta.get("LicenseShortName"))
    license_url = plain(meta.get("LicenseUrl"))
    wiki = _revision(page)["raw_wikitext"]
    license_code, canonical_license_url = normalize_license(license_name, license_url, wiki)
    preserved_license_url = canonical_license_url or license_url or None
    if license_code == "public-domain" and not preserved_license_url:
        preserved_license_url = public_domain_reference(wiki)
    page_title = page.get("title", "File:Untitled")
    source_page = "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(page_title.replace(" ", "_"), safe=":()!,._-')")
    url = info.get("url", "")
    raw_name = page_title.removeprefix("File:").replace("/", "_").replace("\\", "_")
    pageid = int(page["pageid"])
    extension = pathlib.PurePosixPath(raw_name).suffix.lower()
    path = f"wikimedia-commons/{pageid}/{raw_name}"
    explicit_credit = plain(meta.get("Attribution")) or plain(meta.get("Credit"))
    attribution = f"“{title}”" + (f" by {author}" if author else "")
    if explicit_credit and explicit_credit.casefold() not in attribution.casefold():
        attribution += f". {explicit_credit}"
    attribution += f" ({source_page}), {license_name or 'license statement on Commons'}"
    if preserved_license_url:
        attribution += f" ({preserved_license_url})"
    attribution += ". Sliced, time-stretched and re-pitched in Apricity."
    usage = plain(meta.get("UsageTerms"))
    rights = "; ".join(part for part in (license_name, usage, plain(meta.get("Permission")), plain(meta.get("Restrictions")), preserved_license_url) if part)
    extmetadata = meta
    return {
        "path": path,
        "url": url,
        "fetch": "http",
        "title": title,
        "collection": "wikimedia-commons",
        "source_page": source_page,
        "credit": attribution,
        "attribution": attribution,
        "rights": rights,
        "license": license_code,
        "license_url": preserved_license_url,
        "author": author or None,
        "categories": categories,
        "tags": [category.removeprefix("Category:").lower().replace(" ", "-") for category in categories],
        "size": info.get("size"),
        "commons_sha1": info.get("sha1"),
        "mime": info.get("mime"),
        "source_metadata": _page_snapshot(page, categories),
        "_license_name": license_name,
        "_extmetadata": extmetadata,
        "_extension": extension,
    }


def qualify_page(page: dict[str, Any], categories: list[str]) -> Decision:
    info = (page.get("imageinfo") or [{}])[0]
    mime = (info.get("mime") or "").lower()
    title = page.get("title", "(unknown Commons file)")
    extension = pathlib.PurePosixPath(title.removeprefix("File:")).suffix.lower()
    if mime.startswith("video/") or extension in {".ogv", ".webm", ".mp4", ".mov", ".avi"}:
        return Decision(False, reason="video container; only audio-only media is imported")
    if extension not in AUDIO_EXTENSIONS:
        return Decision(False, reason=f"unsupported or non-audio media type: {mime or extension or 'unknown'}")
    record = catalog_record(page, categories)
    if not record["license"]:
        return Decision(False, reason=f"unsupported or missing license: {record['_license_name'] or 'none'}")
    if record["license"].startswith("cc-by") and not record["author"]:
        return Decision(False, reason="required creator/author attribution is missing")
    if not record["url"] or not record["source_metadata"].get("revision_id"):
        return Decision(False, reason="Commons direct URL or revisioned source metadata is missing")
    # Internal parsing helpers are not part of the persisted source catalog.
    record.pop("_license_name", None)
    record.pop("_extmetadata", None)
    record.pop("_extension", None)
    return Decision(True, record=record)


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
            if when.tzinfo is None:
                when = when.replace(tzinfo=dt.timezone.utc)
            return max(0.0, (when - dt.datetime.now(dt.timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


class CommonsClient:
    """Small sequential client with an explicit minimum interval and server-directed retries."""

    def __init__(self, delay: float = 1.0, opener=urllib.request.urlopen, sleeper=time.sleep):
        self.delay = max(0.0, delay)
        self.opener = opener
        self.sleeper = sleeper
        self.last_request: float | None = None

    def _throttle(self) -> None:
        if self.last_request is not None:
            elapsed = time.monotonic() - self.last_request
            if elapsed < self.delay:
                self.sleeper(self.delay - elapsed)
        self.last_request = time.monotonic()

    def open(self, url: str):
        for attempt in range(MAX_RETRIES):
            self._throttle()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json, audio/*;q=0.9, */*;q=0.1"})
            try:
                return self.opener(req, timeout=120)
            except urllib.error.HTTPError as exc:
                if (exc.code != 429 and not 500 <= exc.code < 600) or attempt + 1 == MAX_RETRIES:
                    raise
                wait = _retry_after(exc.headers.get("Retry-After"))
                self.sleeper(max(self.delay, wait if wait is not None else 2 ** (attempt + 1)))
            except (urllib.error.URLError, TimeoutError):
                if attempt + 1 == MAX_RETRIES:
                    raise
                self.sleeper(max(self.delay, 2 ** (attempt + 1)))
        raise RuntimeError("Commons request retry loop exhausted")

    def api(self, params: dict[str, Any]) -> dict[str, Any]:
        url = API + "?" + urllib.parse.urlencode({"format": "json", "formatversion": 2, **params})
        with self.open(url) as response:
            payload = json.loads(response.read())
        if "error" in payload:
            raise RuntimeError(f"Commons API: {payload['error'].get('info', payload['error'])}")
        return payload

    def category_members(self, category: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        continuation: dict[str, Any] = {}
        while True:
            payload = self.api({"action": "query", "list": "categorymembers", "cmtitle": category, "cmtype": "file", "cmlimit": "max", **continuation})
            items.extend(payload.get("query", {}).get("categorymembers", []))
            continuation = payload.get("continue") or {}
            if not continuation:
                return items

    def pages(self, pageids: list[int]) -> list[dict[str, Any]]:
        payload = self.api({
            "action": "query",
            "pageids": "|".join(map(str, pageids)),
            "prop": "imageinfo|revisions",
            "iiprop": "url|mime|size|sha1|mediatype|timestamp|user|extmetadata",
            "iiextmetadatalanguage": "en",
            "rvprop": "ids|timestamp|content",
            "rvslots": "main",
        })
        return payload.get("query", {}).get("pages", [])

    def discover(self, categories: Iterable[str] = CATEGORIES) -> dict[int, dict[str, Any]]:
        found = []
        for category in categories:
            found.append((category, self.category_members(category)))
        return merge_memberships(found)

    def download(self, url: str, dest: pathlib.Path, *, expected_size: int | None, expected_sha1: str | None) -> tuple[str, str, int]:
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_suffix(dest.suffix + ".part")
        for attempt in range(MAX_RETRIES):
            sha1 = hashlib.sha1()
            sha256 = hashlib.sha256()
            total = 0
            try:
                with self.open(url) as response, part.open("wb") as out:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        sha1.update(chunk)
                        sha256.update(chunk)
                        total += len(chunk)
                    out.flush()
            except KeyboardInterrupt:
                part.unlink(missing_ok=True)
                raise
            except urllib.error.HTTPError:
                part.unlink(missing_ok=True)
                raise
            except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
                part.unlink(missing_ok=True)
                if attempt + 1 == MAX_RETRIES:
                    raise
                self.sleeper(max(self.delay, 2 ** (attempt + 1)))
                continue
            try:
                if expected_size is not None and total != expected_size:
                    raise ValueError(f"size mismatch: expected {expected_size}, got {total}")
                if expected_sha1 and sha1.hexdigest().lower() != expected_sha1.lower():
                    raise ValueError(f"sha1 mismatch: expected {expected_sha1}, got {sha1.hexdigest()}")
                part.replace(dest)
                return sha1.hexdigest(), sha256.hexdigest(), total
            except Exception:
                part.unlink(missing_ok=True)
                raise
        raise RuntimeError("Commons download retry loop exhausted")


def _sha1(path: pathlib.Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def import_categories(samples: pathlib.Path, *, client: CommonsClient | None = None, dry_run: bool = False, categories: Iterable[str] = CATEGORIES) -> dict[str, Any]:
    client = client or CommonsClient()
    categories = tuple(categories)
    memberships = client.discover(categories)
    pages: list[dict[str, Any]] = []
    ids = list(memberships)
    for offset in range(0, len(ids), 10):
        pages.extend(client.pages(ids[offset : offset + 10]))
    by_id = {int(p["pageid"]): p for p in pages if "pageid" in p}
    existing_path = samples / "sources.json"
    current = json.loads(existing_path.read_text()) if existing_path.exists() else {"about": "Apricity sample audio catalog.", "files": []}
    entries = current.setdefault("files", [])
    by_path = {e.get("path"): e for e in entries}
    report: dict[str, Any] = {
        "categories": list(categories),
        "category_memberships": {category: sum(category in item["categories"] for item in memberships.values()) for category in categories},
        "discovered_memberships": sum(len(x["categories"]) for x in memberships.values()),
        "unique_pages": len(memberships),
        "eligible_bytes": 0,
        "imported": [], "skipped": [], "failed": [],
    }
    additions: list[dict[str, Any]] = []
    for pageid, member in memberships.items():
        page = by_id.get(pageid)
        if page is None:
            report["failed"].append({"pageid": pageid, "title": member["title"], "source_page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(member["title"].replace(" ", "_"), safe=":()!,._-')"), "reason": "Commons did not return file metadata"})
            continue
        decision = qualify_page(page, member["categories"])
        if not decision.eligible:
            report["skipped"].append({"pageid": pageid, "title": member["title"], "source_page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(member["title"].replace(" ", "_"), safe=":()!,._-')"), "reason": decision.reason})
            continue
        entry = decision.record
        assert entry is not None
        report["eligible_bytes"] += int(entry.get("size") or 0)
        if dry_run:
            report["imported"].append({"pageid": pageid, "title": member["title"], "source_page": entry["source_page"], "path": entry["path"], "license": entry["license"], "mime": entry["mime"], "size": entry["size"]})
            continue
        dest = samples / entry["path"]
        expected_sha1, expected_size = entry.get("commons_sha1"), entry.get("size")
        old = by_path.get(entry["path"], {})
        already_verified = dest.is_file() and (
            (expected_sha1 and _sha1(dest).lower() == expected_sha1.lower())
            or (not expected_sha1 and old.get("sha256") and _sha256(dest).lower() == old["sha256"].lower())
        ) and (expected_size is None or dest.stat().st_size == expected_size)
        if already_verified:
            sha256 = _sha256(dest)
        else:
            try:
                _, sha256, _ = client.download(entry["url"], dest, expected_size=expected_size, expected_sha1=expected_sha1)
            except Exception as exc:
                report["failed"].append({"pageid": pageid, "title": member["title"], "source_page": entry["source_page"], "reason": f"download failed: {exc}"})
                continue
        entry["sha256"] = sha256
        additions.append(entry)
        report["imported"].append({"pageid": pageid, "title": member["title"], "source_page": entry["source_page"], "path": entry["path"], "license": entry["license"], "mime": entry["mime"], "size": entry["size"], "sha256": sha256})
    if not dry_run:
        for entry in additions:
            pageid = entry.get("source_metadata", {}).get("pageid")
            # A Commons page can be renamed without changing its page ID. Replace the old
            # catalog path for that identity so reruns cannot create a second sample.
            stale_paths = [
                path for path, old in by_path.items()
                if old.get("source_metadata", {}).get("pageid") == pageid
            ]
            for path in stale_paths:
                del by_path[path]
            by_path[entry["path"]] = entry
        current["files"] = list(by_path.values())
        _write_json(existing_path, current)
    _write_json(samples / "commons-review.json", report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=pathlib.Path, default=pathlib.Path("samples"), help="samples directory")
    parser.add_argument("--delay", type=float, default=1.0, help="minimum seconds between Commons requests (default: 1)")
    parser.add_argument("--dry-run", action="store_true", help="discover and qualify without downloading or updating sources.json")
    args = parser.parse_args(argv)
    try:
        report = import_categories(args.samples, client=CommonsClient(delay=args.delay), dry_run=args.dry_run)
    except Exception as exc:
        print(f"Commons import failed: {exc}", file=sys.stderr)
        return 1
    print(f"Commons: {report['unique_pages']} unique files, {len(report['imported'])} eligible/imported, {len(report['skipped'])} excluded, {len(report['failed'])} failed")
    print(f"Review report: {args.samples / 'commons-review.json'}")
    if report["failed"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
