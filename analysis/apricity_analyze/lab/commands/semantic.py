"""Ground-only semantic clustering command; it creates draft artifacts only."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from ...audio_clusters import AlgorithmDependencyError, cluster_snapshot
from ...cluster_corpus import build_cluster_snapshot
from ...cluster_runs import prepare_run, save_draft_run
from ...cluster_summaries import build_cluster_summaries
from ...cluster_jobs import ClusterJobService
from ...cluster_worker import run_once


def add_parser(subparsers):
    semantic = subparsers.add_parser("semantic", help="semantic ground operations")
    commands = semantic.add_subparsers(dest="semantic_command", required=True)
    cluster = commands.add_parser("cluster", help="build one immutable semantic cluster draft")
    cluster.add_argument("--corpus", required=True, type=Path, help="published apricity.semantic-corpus/1 JSON")
    cluster.add_argument("--catalog", required=True, type=Path, help="current canonical catalog JSON")
    cluster.add_argument("--preset", required=True, choices=("broad", "useful", "fine"))
    cluster.add_argument("--output", required=True, type=Path, help="draft artifact root (runs/ is created below it)")
    cluster.add_argument("--json", action="store_true", help="print the complete immutable manifest")
    cluster.set_defaults(func=run_cluster)
    worker = commands.add_parser("worker", help="execute at most one leased local cluster job")
    worker.add_argument("--control-root", required=True, type=Path, help="private local cluster-job control root")
    worker.add_argument("--runs-root", required=True, type=Path, help="local immutable draft artifact root")
    worker.add_argument("--corpus", required=True, type=Path, help="current published semantic corpus JSON")
    worker.add_argument("--catalog", required=True, type=Path, help="current canonical catalog JSON")
    worker.add_argument("--worker-id", required=True, help="server-configured ground worker identity")
    worker.set_defaults(func=run_worker)


def _read(path: Path, label: str) -> dict[str, Any]:
    try: value = json.loads(path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError) as error: raise ValueError(f"invalid {label}: {error}") from error
    if not isinstance(value, dict): raise ValueError(f"{label} must be a JSON object")
    return value


def _catalog(raw: dict[str, Any]) -> dict[str, Any]:
    # Native exporter wraps the exact load_catalog shape; callers may also pass it directly.
    value = raw.get("catalog", raw)
    if not isinstance(value, dict): raise ValueError("catalog envelope is invalid")
    return value


def _metadata(snapshot: dict[str, Any], records: list[dict[str, Any]], catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_id = {row.get("identity", {}).get("semanticId"): row for row in records if isinstance(row, dict)}
    if len(by_id) != len(records): raise ValueError("corpus records must have unique semantic identities")
    samples = {row.get("id"): row for row in catalog.get("samples", []) if isinstance(row, dict)}
    clips = {row.get("id"): row for row in catalog.get("clips", []) if isinstance(row, dict)}
    result = {}
    for region in snapshot["regions"]:
        for alias in region["aliases"]:
            semantic_id, identity = alias["semanticId"], alias["semanticIdentity"]
            record, sample = by_id.get(semantic_id), samples.get(identity["sampleId"])
            if not isinstance(record, dict) or not isinstance(sample, dict): raise ValueError("current canonical metadata is missing")
            audio = sample.get("audio")
            title = sample.get("title")
            if not isinstance(audio, dict) or not isinstance(audio.get("key"), str) or not audio["key"] or not isinstance(title, str) or not title:
                raise ValueError("current canonical catalog lacks playable metadata")
            row = {"semanticId": semantic_id, "sampleId": identity["sampleId"], "recordingId": identity["recordingId"], "kind": identity["kind"], "start": identity["start"], "end": identity["end"], "audioSha256": identity["audioSha256"], "embeddingSpace": identity["embeddingSpace"], "processingFingerprint": identity["processingFingerprint"], "fileKey": audio["key"], "sampleTitle": title}
            if identity["kind"] == "saved_clip":
                clip = clips.get(identity.get("clipId"))
                if not isinstance(clip, dict) or clip.get("sampleId") != sample.get("id") or not isinstance(clip.get("name"), str) or not clip["name"]:
                    raise ValueError("current canonical catalog lacks saved clip metadata")
                row.update({"clipId": clip["id"], "clipName": clip["name"]})
            result[semantic_id] = row
    return result


def run_cluster(args) -> int:
    try:
        envelope, catalog = _read(args.corpus, "corpus"), _catalog(_read(args.catalog, "catalog"))
        if envelope.get("schemaVersion") != "apricity.semantic-corpus/1" or not isinstance(envelope.get("records"), list):
            raise ValueError("corpus must be apricity.semantic-corpus/1")
        space, fingerprint = envelope.get("embeddingSpace"), envelope.get("processingFingerprint")
        if not isinstance(space, str) or not space or not isinstance(fingerprint, str) or not fingerprint: raise ValueError("corpus model provenance is missing")
        snapshot = build_cluster_snapshot(envelope["records"], catalog, embedding_space=space, processing_fingerprint=fingerprint)
        result = cluster_snapshot(snapshot, args.preset)
        vocabulary = _read(Path(__file__).resolve().parents[4] / "fixtures" / "semantic-audio" / "concept-vocabulary-v1.json", "concept vocabulary")
        summaries = build_cluster_summaries(snapshot, result, vocabulary, metadata=_metadata(snapshot, envelope["records"], catalog))
        packet = prepare_run(snapshot, result, summaries, datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
        manifest = save_draft_run(args.output, packet)
    except AlgorithmDependencyError as error:
        print(json.dumps({"error": {"code": "not_evaluated", "message": str(error), "retryable": False}}, sort_keys=True)); return 3
    except Exception as error:
        print(json.dumps({"error": {"code": "cluster_failed", "message": str(error), "retryable": False}}, sort_keys=True)); return 2
    print(json.dumps(packet if args.json else {"runId": packet["runId"], "manifest": str(manifest), "state": "draft", "qualityReview": packet["qualityReview"]}, sort_keys=True))
    return 0


class _GroundWorker:
    """The CLI creates this trusted local capability; it is never request input."""
    is_cluster_worker = True

    def __init__(self, identifier: str): self.id = identifier


def run_worker(args) -> int:
    """Run one job only and emit a token-free JSON status line."""
    try:
        worker = _GroundWorker(args.worker_id)
        service = ClusterJobService(args.control_root, args.runs_root)
        vocabulary_path = Path(__file__).resolve().parents[4] / "fixtures" / "semantic-audio" / "concept-vocabulary-v1.json"
        outcome = run_once(service, worker, lambda: _read(args.corpus, "corpus"),
                           lambda: _catalog(_read(args.catalog, "catalog")), args.runs_root,
                           _read(vocabulary_path, "concept vocabulary"))
    except Exception:
        # Startup/control failures must not disclose local paths, credentials,
        # or tracebacks; they are retriable capacity failures to the operator.
        print(json.dumps({"state": "unavailable", "error": "temporary_capacity"}, sort_keys=True)); return 2
    # run_once deliberately returns only public state, job id, and allowlisted code.
    print(json.dumps(outcome, sort_keys=True))
    return 0 if outcome["state"] in {"idle", "draft"} else 2
