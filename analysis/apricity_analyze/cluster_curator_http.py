"""One-shot private transport for curator cluster controls.

This module is deliberately separate from ``cluster_http``.  Its caller must
derive the actor from verified server configuration/authentication and pass it
here; JSON request fields can never grant curator authority.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .cluster_corpus import build_cluster_snapshot
from .cluster_curator import CuratorClusterService, CuratorPreviewError
from .cluster_http import (_MAX_INPUT, _MAX_OUTPUT, _Bad, _Unavailable, _json,
                           _public, _strict_pairs, ClusterHttp)
from .cluster_publication import (ClusterPublicationRegistry, ForbiddenError,
                                  PublicationError)


@dataclass(frozen=True)
class CuratorActor:
    """Server-created local identity; never decode this from request JSON."""
    id: str
    is_curator: bool = True


class CuratorHttp:
    def __init__(self, library: str | Path, controls_root: str | Path, runs_root: str | Path, *,
                 actor: CuratorActor, enabled: bool = False):
        if not isinstance(actor, CuratorActor):
            raise TypeError("trusted curator actor required")
        self.data = ClusterHttp(library, controls_root, runs_root, enabled=True)
        self.actor, self.enabled = actor, enabled
        self.registry = ClusterPublicationRegistry(controls_root, runs_root,
                                                   current_corpus_digest=self._current_digest,
                                                   enabled=enabled)
        self.service = CuratorClusterService(self.registry, self.data._corpus, self.data._catalog,
                                             visibility=_public)

    def _current_digest(self) -> str:
        corpus, catalog = self.data._corpus(), self.data._catalog()
        records, space, fingerprint = corpus.get("records"), corpus.get("embeddingSpace"), corpus.get("processingFingerprint")
        if not isinstance(records, list) or not isinstance(space, str) or not isinstance(fingerprint, str):
            raise CuratorPreviewError("current cluster data is unavailable")
        snapshot = build_cluster_snapshot(records, catalog, embedding_space=space,
                                          processing_fingerprint=fingerprint, visibility=_public)
        digest = snapshot.get("corpusDigest")
        if not isinstance(digest, str): raise CuratorPreviewError("current cluster data is unavailable")
        return digest

    def request(self, value: Mapping[str, Any]) -> dict[str, Any]:
        if not self.enabled: raise ForbiddenError("curator controls are disabled")
        if not isinstance(value, Mapping) or not isinstance(value.get("op"), str) or not isinstance(value.get("runId"), str):
            raise _Bad("request")
        op, run_id = value["op"], value["runId"]
        common = {"op", "runId"}
        if op == "control" and set(value) == common:
            return self.service.control(self.actor, run_id)
        if op == "preview" and set(value) == common:
            return self.service.preview(self.actor, run_id)
        if op == "override" and set(value) == common | {"clusterId", "label", "expectedRunRevision"}:
            return self.service.override(self.actor, run_id, value["clusterId"], value["label"],
                                         expected_run_revision=value["expectedRunRevision"])
        if op == "review" and set(value) == common | {"reviewedSemanticIds", "notes", "expectedRunRevision"}:
            return self.service.review(self.actor, run_id, value["reviewedSemanticIds"], value["notes"],
                                       expected_run_revision=value["expectedRunRevision"])
        if op == "publish" and set(value) == common | {"expectedRunRevision", "expectedPointerRevision"}:
            return self.service.publish(self.actor, run_id, expected_run_revision=value["expectedRunRevision"],
                                        expected_pointer_revision=value["expectedPointerRevision"])
        raise _Bad("request")


def run_request(value: object, *, library: str | Path, controls_root: str | Path, runs_root: str | Path,
                actor: CuratorActor, enabled: bool = False) -> dict[str, Any]:
    try:
        if not isinstance(value, Mapping): raise _Bad("request")
        result = CuratorHttp(library, controls_root, runs_root, actor=actor, enabled=enabled).request(value)
        response = {"statusCode": 200, "body": result}
    except ForbiddenError:
        response = {"statusCode": 403, "body": {"error": "forbidden"}}
    except (ValueError, TypeError, _Bad, PublicationError):
        response = {"statusCode": 400, "body": {"error": "bad request"}}
    except (CuratorPreviewError, _Unavailable, OSError, json.JSONDecodeError):
        response = {"statusCode": 503, "body": {"error": "service unavailable"}}
    except Exception:
        response = {"statusCode": 503, "body": {"error": "service unavailable"}}
    try:
        return response if len(json.dumps(response, allow_nan=False, separators=(",", ":")).encode()) <= _MAX_OUTPUT else {"statusCode": 503, "body": {"error": "service unavailable"}}
    except (TypeError, ValueError):
        return {"statusCode": 503, "body": {"error": "service unavailable"}}


def main(argv: list[str] | None = None) -> int:
    # This is only a process protocol.  A native/cloud bridge must pass the
    # trusted actor from startup/auth, rather than accepting identity flags on
    # every browser request.
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--library", required=True); parser.add_argument("--controls-root", required=True)
    parser.add_argument("--runs-root", required=True); parser.add_argument("--curator-id", required=True)
    parser.add_argument("--enabled", action="store_true")
    args = parser.parse_args(argv)
    raw = sys.stdin.buffer.read(_MAX_INPUT + 1)
    if len(raw) > _MAX_INPUT: response = {"statusCode": 400, "body": {"error": "bad request"}}
    else:
        try: request = json.loads(raw.decode("utf8"), object_pairs_hook=_strict_pairs)
        except (UnicodeDecodeError, json.JSONDecodeError, _Bad): request = None
        response = run_request(request, library=args.library, controls_root=args.controls_root, runs_root=args.runs_root,
                               actor=CuratorActor(args.curator_id), enabled=args.enabled)
    sys.stdout.write(json.dumps(response, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
