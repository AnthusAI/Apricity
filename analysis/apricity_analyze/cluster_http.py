"""One-shot, fail-closed stdin transport for public cluster projections.

This is intentionally not a web server.  The Rust caller starts it for one
query, supplies trusted roots at process start, and consumes its single JSON
envelope from stdout.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from .cluster_exploration import (ClusterExploration, ExplorationBadRequest,
                                  ExplorationError, ExplorationNotFound)
from .cluster_publication import ClusterPublicationRegistry
from .semantic_catalog import export_catalog


_MAX_INPUT = 64 * 1024
_MAX_OUTPUT = 32 * 1024 * 1024
_MAX_FILE = 16 * 1024 * 1024
# The current ground corpus is hundreds of MiB.  It is an input-only artifact,
# so it needs its own bounded allowance; public responses remain capped above.
_MAX_CORPUS = 512 * 1024 * 1024
_MAX_ROWS = 100_000
_RUN = re.compile(r"[0-9a-f]{64}\Z")
_LICENSES = {"public-domain", "us-gov", "loc-free", "cc0-1.0", "cc-by-3.0", "cc-by-4.0", "cc-by-sa-3.0", "cc-by-sa-4.0"}
_CREDIT = {"cc-by-3.0", "cc-by-4.0", "cc-by-sa-3.0", "cc-by-sa-4.0"}


class _Bad(ValueError):
    pass


class _Unavailable(RuntimeError):
    pass


def _strict_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise _Bad("duplicate JSON field")
        value[key] = item
    return value


def _json(value: object, *, limit: int = _MAX_FILE) -> object:
    if not isinstance(value, (bytes, bytearray)) or len(value) > limit:
        raise _Unavailable("unsafe file")
    try:
        return json.loads(value.decode("utf8"), object_pairs_hook=_strict_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, _Bad) as error:
        raise _Unavailable("invalid file") from error


def _read(path: Path, root: Path, *, limit: int = _MAX_FILE) -> object:
    try:
        resolved_root = root.resolve(strict=True)
        resolved = path.resolve(strict=True)
        if path.is_symlink() or not resolved.is_file() or resolved.parent != resolved_root and resolved_root not in resolved.parents:
            raise _Unavailable("unsafe file")
        # Check the size before allocating.  Reading one extra byte makes a
        # concurrent growth fail closed too, rather than turning an intended
        # bound into an unbounded allocation.
        if resolved.stat().st_size > limit:
            raise _Unavailable("unsafe file")
        with resolved.open("rb") as handle:
            data = handle.read(limit + 1)
        return _json(data, limit=limit)
    except _Unavailable:
        raise
    except OSError as error:
        raise _Unavailable("native data unavailable") from error


def _license(recording: Mapping[str, Any]) -> str | None:
    raw = recording.get("license")
    if isinstance(raw, str) and raw in _LICENSES:
        return raw
    rights = recording.get("rights")
    if not isinstance(rights, str) or not rights.strip():
        return None
    text = rights.lower()
    match = re.search(r"cc[ -](by(?:-sa)?)[ -]?(\d\.\d)", text)
    if match:
        candidate = f"cc-{match.group(1)}-{match.group(2)}"
        return candidate if candidate in _LICENSES else None
    if re.search(r"\bcc0\b", text): return "cc0-1.0"
    if re.search(r"work of the u\.?s\.? government", text): return "us-gov"
    if "public domain" in text: return "public-domain"
    if "free to use and reuse" in text: return "loc-free"
    return None


def _author(recording: Mapping[str, Any]) -> str | None:
    author = recording.get("author")
    if isinstance(author, str) and author.strip(): return author.strip()
    rights = recording.get("rights")
    if isinstance(rights, str):
        match = re.search(r"cc[ -]by(?:-sa)? ?[\d.]*,\s*([^;.]+)", rights, re.I)
        if match and match.group(1).strip(): return match.group(1).strip()
    credit = recording.get("credit")
    if isinstance(credit, str) and credit.split(",")[0].strip(): return credit.split(",")[0].strip()
    return None


def _public(sample: Mapping[str, Any], recording: Mapping[str, Any], _clip: object) -> bool:
    """The documented TS license policy plus the mandatory native ready state."""
    if sample.get("status") != "ready": return False
    license_code = _license(recording)
    return license_code is not None and (license_code not in _CREDIT or _author(recording) is not None)


class ClusterHttp:
    def __init__(self, library: str | Path, controls_root: str | Path, runs_root: str | Path, *, enabled: bool = False):
        self.library, self.controls_root, self.runs_root = Path(library), Path(controls_root), Path(runs_root)
        if not all(path.is_absolute() for path in (self.library, self.controls_root, self.runs_root)):
            raise ValueError("trusted roots must be absolute")
        if not isinstance(enabled, bool): raise TypeError("enabled must be boolean")
        self.enabled = enabled

    def _corpus(self) -> dict[str, Any]:
        value = _read(self.library / "semantic" / "corpus.json", self.library, limit=_MAX_CORPUS)
        if not isinstance(value, dict): raise _Unavailable("invalid corpus")
        return value

    def _catalog(self) -> dict[str, Any]:
        # Preflight every known native metadata file so a corrupt/symlinked row
        # is an outage, never a silently incomplete public result.
        try:
            root = self.library.resolve(strict=True)
            if self.library.is_symlink() or not root.is_dir(): raise _Unavailable("unsafe native root")
            for table in ("Sample", "Clip", "Recording"):
                directory = root / table
                if not directory.exists() or directory.is_symlink() or not directory.is_dir():
                    raise _Unavailable("native table unavailable")
                rows = sorted(directory.glob("*.json"))
                if len(rows) > _MAX_ROWS: raise _Unavailable("too many rows")
                for row in rows: _read(row, directory)
            exported = export_catalog(root)
            catalog = exported.get("catalog") if isinstance(exported, Mapping) else None
            if not isinstance(catalog, dict): raise _Unavailable("invalid catalog")
            return catalog
        except _Unavailable: raise
        except Exception as error: raise _Unavailable("native catalog unavailable") from error

    def _ratings(self) -> dict[str, float]:
        corpus = self._corpus()
        records = corpus.get("records")
        if not isinstance(records, list): raise _Unavailable("invalid corpus")
        targets: dict[str, tuple[str, str]] = {}
        for record in records:
            identity = record.get("identity") if isinstance(record, Mapping) else None
            if not isinstance(identity, Mapping): continue
            semantic_id, kind = identity.get("semanticId"), identity.get("kind")
            target = identity.get("clipId") if kind == "saved_clip" else identity.get("sampleId") if kind == "window" else None
            target_type = "clip" if kind == "saved_clip" else "sample" if kind == "window" else None
            if isinstance(semantic_id, str) and isinstance(target, str) and target_type:
                targets[semantic_id] = (target_type, target)
        directory = self.library / "Rating"
        if not directory.exists(): return {}
        if directory.is_symlink() or not directory.is_dir(): raise _Unavailable("unsafe rating table")
        totals: dict[tuple[str, str], tuple[int, int]] = {}
        rows = sorted(directory.glob("*.json"))
        if len(rows) > _MAX_ROWS: raise _Unavailable("too many ratings")
        for path in rows:
            value = _read(path, directory)
            if not isinstance(value, Mapping): raise _Unavailable("invalid rating")
            kind, target, owner, stars, rated = (value.get("targetType"), value.get("targetId"), value.get("owner"),
                                                 value.get("stars"), value.get("ratedAt"))
            if (kind not in {"sample", "clip"} or not isinstance(target, str) or not target or not isinstance(owner, str)
                    or not isinstance(stars, int) or isinstance(stars, bool) or not 0 <= stars <= 5
                    or not isinstance(rated, str)):
                continue
            try: datetime.fromisoformat(rated.replace("Z", "+00:00"))
            except ValueError: continue
            if value.get("id") != f"{kind}#{target}#{owner}": continue
            count, total = totals.get((kind, target), (0, 0)); totals[(kind, target)] = (count + 1, total + stars)
        return {semantic: (3 * 2.5 + total) / (3 + count) for semantic, target in targets.items()
                if (count := totals.get(target, (0, 0))[0]) and (total := totals[target][1]) >= 0}

    def service(self) -> ClusterExploration:
        registry = ClusterPublicationRegistry(self.controls_root, self.runs_root,
                                              current_corpus_digest=lambda: "unused-read-only", enabled=True)
        return ClusterExploration(registry, self._corpus, self._catalog, visibility=_public,
                                  ratings=self._ratings, enabled=self.enabled)

    def query(self, query: Mapping[str, Any]) -> dict[str, Any]:
        return _dispatch(self.service(), query)


def _dispatch(service: ClusterExploration, query: Mapping[str, Any]) -> dict[str, Any]:
    _validate_query(query)
    view = query.get("view", "leaderboard")
    run, preset, order = query.get("run"), query.get("preset"), query.get("order")
    if view == "leaderboard":
        return service.leaderboard(run, preset=preset, order=order)
    if view == "detail":
        return service.detail(query["clusterId"], run, preset=preset, order=order)
    if view == "map":
        return service.map(run, preset=preset, limit=query.get("limit"))
    return service.list_members(run, preset=preset)


def _validate_query(query: Mapping[str, Any]) -> None:
    if not isinstance(query, Mapping): raise _Bad("query")
    allowed = {"view", "run", "preset", "order", "clusterId", "limit"}
    if set(query) - allowed or not all(isinstance(key, str) for key in query): raise _Bad("unknown field")
    view = query.get("view", "leaderboard")
    if view not in {"leaderboard", "detail", "map", "list"}: raise _Bad("view")
    run, preset, order = query.get("run"), query.get("preset"), query.get("order")
    if run is not None and (not isinstance(run, str) or not _RUN.fullmatch(run)): raise _Bad("run")
    if preset is not None and preset not in {"broad", "useful", "fine"}: raise _Bad("preset")
    if view == "leaderboard":
        if "clusterId" in query or "limit" in query: raise _Bad("field")
        return
    if view == "detail":
        if set(query) - {"view", "run", "preset", "order", "clusterId"} or not isinstance(query.get("clusterId"), str): raise _Bad("cluster")
        return
    if view == "map":
        if "order" in query or "clusterId" in query: raise _Bad("field")
        if "limit" in query and (isinstance(query["limit"], bool) or not isinstance(query["limit"], int) or not 1 <= query["limit"] <= 10_000): raise _Bad("limit")
        return
    if "order" in query or "clusterId" in query or "limit" in query: raise _Bad("field")


def run_query(query: object, *, library: str | Path, controls_root: str | Path, runs_root: str | Path, enabled: bool = False) -> dict[str, Any]:
    try:
        if not isinstance(query, Mapping): raise _Bad("query")
        if not enabled: return {"statusCode": 503, "body": {"error": "service unavailable"}}
        _validate_query(query)
        result = ClusterHttp(library, controls_root, runs_root, enabled=True).query(query)
        response = {"statusCode": 200, "body": result}
    except (ValueError, TypeError, _Bad, ExplorationBadRequest):
        response = {"statusCode": 400, "body": {"error": "bad request"}}
    except ExplorationNotFound:
        response = {"statusCode": 404, "body": {"error": "not found"}}
    except (ExplorationError, _Unavailable, OSError, json.JSONDecodeError):
        response = {"statusCode": 503, "body": {"error": "service unavailable"}}
    except Exception:
        response = {"statusCode": 503, "body": {"error": "service unavailable"}}
    try:
        wire = json.dumps(response, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return {"statusCode": 503, "body": {"error": "service unavailable"}}
    return response if len(wire.encode("utf8")) <= _MAX_OUTPUT else {"statusCode": 503, "body": {"error": "service unavailable"}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--library", required=True)
    parser.add_argument("--controls-root", required=True)
    parser.add_argument("--runs-root", required=True)
    parser.add_argument("--enabled", action="store_true")
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read(_MAX_INPUT + 1)
    if len(raw) > _MAX_INPUT:
        response = {"statusCode": 400, "body": {"error": "bad request"}}
    else:
        try: query = json.loads(raw.decode("utf8"), object_pairs_hook=_strict_pairs)
        except (UnicodeDecodeError, json.JSONDecodeError, _Bad): query = None
        response = run_query(query, library=args.library, controls_root=args.controls_root,
                             runs_root=args.runs_root, enabled=args.enabled)
    sys.stdout.write(json.dumps(response, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
