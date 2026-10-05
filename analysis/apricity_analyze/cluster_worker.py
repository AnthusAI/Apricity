"""Ground-only execution of one leased private clustering job.

This module deliberately owns no transport, publication, or approval path.
Its inputs are trusted injected local ports and its sole durable output is an
M4 immutable draft which remains pending curator review.
"""
from __future__ import annotations

from datetime import datetime, timezone
import threading
import time
from typing import Any, Callable, Mapping

from .audio_clusters import AlgorithmDependencyError, cluster_snapshot
from .cluster_corpus import build_cluster_snapshot
from .cluster_jobs import LeaseError
from .cluster_runs import prepare_run, save_draft_run
from .cluster_summaries import build_cluster_summaries


def _timestamp(clock: Callable[[], float]) -> str:
    return datetime.fromtimestamp(clock(), timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _current(corpus_provider: Callable[[], object], catalog_provider: Callable[[], object]) -> tuple[dict[str, Any], dict[str, Any], dict[str, object]]:
    """Read and validate the current canonical corpus/catalog without caching it."""
    envelope, catalog = corpus_provider(), catalog_provider()
    if not isinstance(envelope, Mapping) or envelope.get("schemaVersion") != "apricity.semantic-corpus/1" or not isinstance(envelope.get("records"), list):
        raise ValueError("current corpus is unavailable")
    space, fingerprint = envelope.get("embeddingSpace"), envelope.get("processingFingerprint")
    if not isinstance(space, str) or not space or not isinstance(fingerprint, str) or not fingerprint or not isinstance(catalog, Mapping):
        raise ValueError("current corpus provenance is unavailable")
    snapshot = build_cluster_snapshot(envelope["records"], dict(catalog), embedding_space=space, processing_fingerprint=fingerprint)
    return dict(envelope), dict(catalog), snapshot


def _metadata(snapshot: Mapping[str, object], records: list[object], catalog: Mapping[str, object]) -> dict[str, dict[str, Any]]:
    """Copy only canonical playback metadata needed by the summary boundary."""
    by_id = {row.get("identity", {}).get("semanticId"): row for row in records if isinstance(row, dict)}
    if len(by_id) != len(records):
        raise ValueError("current corpus records are invalid")
    samples = {row.get("id"): row for row in catalog.get("samples", []) if isinstance(row, dict)}
    clips = {row.get("id"): row for row in catalog.get("clips", []) if isinstance(row, dict)}
    result: dict[str, dict[str, Any]] = {}
    for region in snapshot["regions"]:
        for alias in region["aliases"]:
            identity = alias["semanticIdentity"]; sample = samples.get(identity["sampleId"])
            if alias["semanticId"] not in by_id or not isinstance(sample, dict): raise ValueError("current canonical metadata is missing")
            audio, title = sample.get("audio"), sample.get("title")
            if not isinstance(audio, dict) or not isinstance(audio.get("key"), str) or not audio["key"] or not isinstance(title, str) or not title:
                raise ValueError("current canonical catalog lacks playable metadata")
            row = {key: identity[key] for key in ("semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint")}
            row.update(fileKey=audio["key"], sampleTitle=title)
            if identity["kind"] == "saved_clip":
                clip = clips.get(identity.get("clipId"))
                if not isinstance(clip, dict) or clip.get("sampleId") != sample.get("id") or not isinstance(clip.get("name"), str) or not clip["name"]:
                    raise ValueError("current canonical catalog lacks saved clip metadata")
                row.update(clipId=clip["id"], clipName=clip["name"])
            result[row["semanticId"]] = row
    return result


_HEARTBEAT_JOIN_SECONDS = 0.25


def _fail(service: Any, worker: object, claim: Mapping[str, Any], code: str, *, retryable: bool) -> str:
    try:
        service.fail(worker, claim["jobId"], claim["leaseToken"], claim["revision"], code, retryable=retryable)
        return "adopted"
    except LeaseError:
        return "lost"
    except Exception:
        # The service is the durability boundary.  A failure here has unknown
        # persistence, so leave its current lease reclaimable rather than
        # attempting another mutation with an uncertain revision.
        return "unavailable"


def run_once(service: Any, worker: object, corpus_provider: Callable[[], object], catalog_provider: Callable[[], object],
             runs_root: object, vocabulary: Mapping[str, object], *, clock: Callable[[], float] = time.time,
             heartbeat_interval: float = 300.0, cluster: Callable[..., dict[str, object]] = cluster_snapshot,
             summaries: Callable[..., dict[str, object]] = build_cluster_summaries,
             prepare: Callable[..., dict[str, object]] = prepare_run, save: Callable[..., object] = save_draft_run) -> dict[str, object]:
    """Claim and execute at most one job; never publish, approve, or retry it.

    A lease token is kept exclusively in this stack frame.  The heartbeat and
    final completion share one revision lock so an older revision can never be
    submitted after a successful renewal.
    """
    if isinstance(heartbeat_interval, bool) or not isinstance(heartbeat_interval, (int, float)) or not 0 < heartbeat_interval < 600:
        raise ValueError("heartbeat_interval must be greater than zero and less than 600 seconds")
    try:
        claim = service.claim(worker)
    except Exception:
        return {"state": "unavailable", "error": "temporary_capacity"}
    if claim is None:
        return {"state": "idle"}
    revision = {"value": claim["revision"]}
    revision_lock, stop, lost = threading.Lock(), threading.Event(), threading.Event()
    heartbeat_error = {"value": None}

    def unavailable() -> dict[str, object]:
        return {"state": "unavailable", "jobId": claim["jobId"], "error": "temporary_capacity"}

    def stopped() -> bool:
        stop.set()
        thread.join(_HEARTBEAT_JOIN_SECONDS)
        return not thread.is_alive()

    def lease_outcome() -> dict[str, object]:
        if heartbeat_error["value"] == "unavailable": return unavailable()
        return {"state": "lost", "jobId": claim["jobId"]}

    def current_revision() -> int:
        with revision_lock:
            return revision["value"]

    def record_failure(code: str, *, retryable: bool, state: str) -> dict[str, object]:
        if not stopped(): return unavailable()
        if lost.is_set(): return lease_outcome()
        result = _fail(service, worker, {**claim, "revision": current_revision()}, code, retryable=retryable)
        if result == "adopted": return {"state": state, "jobId": claim["jobId"], "error": code}
        if result == "lost": return {"state": "lost", "jobId": claim["jobId"]}
        return unavailable()

    def heartbeat() -> None:
        while not stop.wait(heartbeat_interval):
            if lost.is_set(): return
            with revision_lock:
                if lost.is_set() or stop.is_set(): return
                previous = revision["value"]
            try:
                # Never hold the completion lock during storage I/O: a blocked
                # renew must not prevent bounded worker shutdown.
                renewed = service.renew(worker, claim["jobId"], claim["leaseToken"], previous)
                renewed_revision = renewed["revision"]
                if isinstance(renewed_revision, bool) or not isinstance(renewed_revision, int): raise ValueError("invalid lease revision")
            except BaseException as error:
                # No exception from a daemon thread is observable or safe.  Do
                # not expose its message, which can contain paths or tokens.
                heartbeat_error["value"] = "lost" if isinstance(error, LeaseError) else "unavailable"
                lost.set(); stop.set(); return
            with revision_lock:
                # A successful renew changes the durable revision even if the
                # main thread has just begun shutdown.  Preserve it so a joined
                # worker never submits a stale revision.
                if lost.is_set(): return
                if revision["value"] != previous:
                    heartbeat_error["value"] = "unavailable"; lost.set(); stop.set(); return
                revision["value"] = renewed_revision
            if stop.is_set(): return

    thread = threading.Thread(target=heartbeat, name="cluster-job-heartbeat", daemon=True)
    thread.start()
    try:
        request = claim["request"]
        try:
            envelope, catalog, snapshot = _current(corpus_provider, catalog_provider)
        except ValueError:
            return record_failure("input_unavailable", retryable=False, state="failed")
        except Exception:
            return record_failure("worker_failure", retryable=True, state="failed")
        if snapshot["embeddingSpace"] != request["embeddingSpace"] or ("corpusRevision" in request and snapshot["corpusDigest"] != request["corpusRevision"]):
            return record_failure("input_unavailable", retryable=False, state="failed")
        if lost.is_set():
            return record_failure("worker_failure", retryable=True, state="failed")
        try:
            result = cluster(snapshot, request["preset"], parameters=request["params"])
        except AlgorithmDependencyError:
            return record_failure("input_unavailable", retryable=False, state="not_evaluated")
        except Exception:
            return record_failure("worker_failure", retryable=True, state="failed")
        if lost.is_set():
            return record_failure("worker_failure", retryable=True, state="failed")
        try:
            packet = prepare(snapshot, result, summaries(snapshot, result, vocabulary, metadata=_metadata(snapshot, envelope["records"], catalog)), _timestamp(clock))
        except Exception:
            return record_failure("worker_failure", retryable=True, state="failed")
        if lost.is_set():
            return record_failure("worker_failure", retryable=True, state="failed")
        try:
            save(runs_root, packet)  # An unadopted immutable draft is safe recovery evidence.
        except Exception:
            return record_failure("worker_failure", retryable=True, state="failed")
        if lost.is_set():
            return record_failure("worker_failure", retryable=True, state="failed")
        try:
            _envelope, _catalog, current = _current(corpus_provider, catalog_provider)
        except ValueError:
            return record_failure("input_unavailable", retryable=False, state="failed")
        except Exception:
            return record_failure("worker_failure", retryable=True, state="failed")
        if current["corpusDigest"] != snapshot["corpusDigest"] or current["embeddingSpace"] != snapshot["embeddingSpace"] or current["processingFingerprint"] != snapshot["processingFingerprint"]:
            return record_failure("input_unavailable", retryable=False, state="failed")
        if not stopped(): return unavailable()
        with revision_lock:
            if lost.is_set(): return lease_outcome()
            try:
                service.complete(worker, claim["jobId"], claim["leaseToken"], revision["value"], packet["runId"])
            except LeaseError:
                return {"state": "lost", "jobId": claim["jobId"]}
            except Exception:
                return unavailable()
        return {"state": "draft", "jobId": claim["jobId"]}
    except Exception:
        return record_failure("worker_failure", retryable=True, state="failed")
    finally:
        # Process cancellation is deliberately not caught above.  It still
        # stops the daemon promptly, leaving the running lease for expiry.
        stopped()
