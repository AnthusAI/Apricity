"""Private local control store for curator-requested cluster jobs.

This is deliberately a transport-free boundary.  Callers supply server-trusted
actor/worker objects; browser JSON is never an authority source.  M4 manifests
are validated through ``cluster_runs._validate_manifest`` for compatibility.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import time
from typing import Any, Callable, Mapping

from .cluster_runs import _validate_manifest


EMBEDDING_SPACE = "clap-htsat-unfused-512-v1"
LEASE_SECONDS = 600
_RUN_ID = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_ID = re.compile(r"[A-Za-z0-9._:-]{1,160}\Z")
_PRESETS = {"broad", "useful", "fine"}


class ClusterJobError(Exception):
    status_code = 400


class ValidationError(ClusterJobError): pass
class ForbiddenError(ClusterJobError): status_code = 403
class ConflictError(ClusterJobError): status_code = 409
class LeaseError(ConflictError): pass


class StorageError(ClusterJobError):
    """Sanitized local-store failure suitable for a transport error response."""
    status_code = 503

    def __init__(self, code: str, *, retryable: bool):
        self.code, self.retryable = code, retryable
        super().__init__("cluster job control store is unavailable" if retryable else "cluster job control store is invalid")


def _safe_root(value: str | Path) -> Path:
    root = Path(value)
    if not root.is_absolute(): root = Path.cwd() / root
    if ".." in root.parts: raise ValidationError("control root may not contain traversal")
    root = root.absolute()
    for ancestor in (root, *root.parents):
        try:
            if stat.S_ISLNK(ancestor.lstat().st_mode): raise ValidationError("control root may not traverse symlinks")
        except FileNotFoundError:
            continue
    return root


def _reject_symlink_path(path: Path) -> None:
    """Reject every existing component; never follow a caller-controlled link."""
    for ancestor in (path, *path.parents):
        try:
            if stat.S_ISLNK(ancestor.lstat().st_mode):
                raise ValidationError("control path may not traverse symlinks")
        except FileNotFoundError:
            continue


def _identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not _SAFE_ID.fullmatch(value): raise ValidationError(f"invalid {label}")
    return value


def _actor_id(actor: object) -> str:
    if not bool(getattr(actor, "is_curator", False)): raise ForbiddenError("curator authority required")
    return _identifier(getattr(actor, "id", None), "actor identity")


def _worker_id(worker: object) -> str:
    # This is a server-issued capability, not a browser supplied identity string.
    if not bool(getattr(worker, "is_cluster_worker", False)):
        raise ForbiddenError("trusted worker capability required")
    return _identifier(getattr(worker, "id", None), "worker identity")


def _timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


_FAILURES = {
    "worker_failure": "The worker could not complete the job.",
    "temporary_capacity": "Cluster capacity is temporarily unavailable.",
    "input_unavailable": "The requested input is temporarily unavailable.",
}


class ClusterJobService:
    """Atomic JSON-backed job service, suitable only for private local control."""

    def __init__(self, control_root: str | Path, runs_root: str | Path, *, offline: bool = False,
                 clock: Callable[[], float] = time.time, token_factory: Callable[[], str] = secrets.token_hex):
        self.root, self.runs_root = _safe_root(control_root), _safe_root(runs_root)
        self.offline, self.clock, self.token_factory = offline, clock, token_factory
        self.path, self.lock_path = self.root / "cluster-jobs.json", self.root / ".cluster-jobs.lock"

    def _ensure_root(self) -> None:
        try:
            _reject_symlink_path(self.root)
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.root.is_symlink() or not self.root.is_dir(): raise ValidationError("unsafe control root")
            os.chmod(self.root, 0o700)
        except OSError as error:
            raise StorageError("control_store_unavailable", retryable=True) from error

    @contextmanager
    def _locked(self):
        self._ensure_root()
        if self.lock_path.is_symlink(): raise ValidationError("unsafe control lock")
        try:
            descriptor = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        except OSError as error:
            raise StorageError("control_store_unavailable", retryable=True) from error
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        except OSError as error:
            try: os.close(descriptor)
            except OSError: pass
            raise StorageError("control_store_unavailable", retryable=True) from error
        try:
            yield
        finally:
            release_error = None
            try: fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError as error: release_error = error
            try: os.close(descriptor)
            except OSError as error:
                if release_error is None: release_error = error
            if release_error is not None:
                raise StorageError("control_store_unavailable", retryable=True) from release_error

    @staticmethod
    def _validate_job(job_id: object, job: object) -> None:
        """Reject malformed persisted state before any mutation can rewrite it."""
        if not isinstance(job_id, str) or not _SAFE_ID.fullmatch(job_id) or not isinstance(job, Mapping):
            raise StorageError("invalid_control_store", retryable=False)
        request = job.get("request")
        required = {"jobId", "actorId", "requestedBy", "request", "state", "attempt", "revision", "createdAt", "queuedAt", "updatedAt", "history"}
        state = job.get("state")
        if not required.issubset(job) or job.get("jobId") != job_id or not isinstance(state, str) or state not in {"queued", "running", "failed", "draft"}:
            raise StorageError("invalid_control_store", retryable=False)
        if any(isinstance(job.get(key), bool) or not isinstance(job.get(key), int) or job[key] < 1 for key in ("attempt", "revision")):
            raise StorageError("invalid_control_store", retryable=False)
        if not all(isinstance(job.get(key), str) and job[key] for key in ("actorId", "requestedBy", "createdAt", "queuedAt", "updatedAt")) or job["requestedBy"] != job["actorId"]:
            raise StorageError("invalid_control_store", retryable=False)
        try:
            ClusterJobService._request_static(request)
        except ValidationError as error:
            raise StorageError("invalid_control_store", retryable=False) from error
        if not isinstance(job["history"], list) or not job["history"]:
            raise StorageError("invalid_control_store", retryable=False)
        if any(not isinstance(entry, Mapping) or entry.get("state") not in {"queued", "running", "failed", "draft"}
               or isinstance(entry.get("revision"), bool) or not isinstance(entry.get("revision"), int)
               or not isinstance(entry.get("at"), str) for entry in job["history"]):
            raise StorageError("invalid_control_store", retryable=False)
        retries = job.get("retryRequests", {})
        if not isinstance(retries, Mapping) or any(not isinstance(actor, str) or not isinstance(ids, list)
                                                    or any(not isinstance(item, str) for item in ids)
                                                    for actor, ids in retries.items()):
            raise StorageError("invalid_control_store", retryable=False)
        if job["state"] == "running":
            if (not isinstance(job.get("workerId"), str) or not isinstance(job.get("leaseToken"), str)
                    or isinstance(job.get("leaseExpiresEpoch"), bool) or not isinstance(job.get("leaseExpiresEpoch"), (int, float))):
                raise StorageError("invalid_control_store", retryable=False)
        if job["state"] == "failed":
            error = job.get("error")
            code = error.get("code") if isinstance(error, Mapping) else None
            if not isinstance(error, Mapping) or not isinstance(code, str) or code not in _FAILURES or error.get("message") != _FAILURES[code] or not isinstance(error.get("retryable"), bool):
                raise StorageError("invalid_control_store", retryable=False)
        if job["state"] == "draft" and (not isinstance(job.get("runId"), str) or not _RUN_ID.fullmatch(job["runId"])):
            raise StorageError("invalid_control_store", retryable=False)

    def _load(self) -> dict[str, Any]:
        if not self.path.exists(): return {"schemaVersion": 1, "jobs": {}}
        if self.path.is_symlink() or not self.path.is_file(): raise ValidationError("unsafe control store")
        try:
            value = json.loads(self.path.read_text(encoding="utf8"))
        except OSError as error:
            raise StorageError("control_store_unavailable", retryable=True) from error
        except json.JSONDecodeError as error:
            raise StorageError("invalid_control_store", retryable=False) from error
        if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("jobs"), dict):
            raise StorageError("invalid_control_store", retryable=False)
        for job_id, job in value["jobs"].items(): self._validate_job(job_id, job)
        return value

    def _replace(self, source: str, target: str) -> None: os.replace(source, target)

    def _save(self, value: Mapping[str, Any]) -> None:
        temporary: str | None = None
        try:
            descriptor, temporary = tempfile.mkstemp(prefix=".cluster-jobs-", dir=self.root)
            with os.fdopen(descriptor, "w", encoding="utf8") as handle:
                json.dump(value, handle, sort_keys=True, separators=(",", ":"), allow_nan=False)
                handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
            self._replace(temporary, str(self.path))
            directory = os.open(self.root, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
        except OSError as error:
            raise StorageError("control_store_unavailable", retryable=True) from error
        finally:
            if temporary is not None and os.path.exists(temporary): os.unlink(temporary)

    @staticmethod
    def _request_static(value: object) -> dict[str, Any]:
        if not isinstance(value, Mapping) or set(value) - {"requestId", "embeddingSpace", "preset", "params", "corpusRevision"} or not {"requestId", "embeddingSpace", "preset", "params"}.issubset(value):
            raise ValidationError("invalid job request")
        request_id = _identifier(value.get("requestId"), "requestId")
        preset = value.get("preset")
        if value.get("embeddingSpace") != EMBEDDING_SPACE or not isinstance(preset, str) or preset not in _PRESETS:
            raise ValidationError("unsupported model or preset")
        params = value.get("params")
        if not isinstance(params, Mapping) or set(params) != {"neighbors", "minClusterSize", "minSamples"}: raise ValidationError("invalid parameters")
        limits = {"neighbors": (2, 200), "minClusterSize": (2, 500), "minSamples": (1, 100)}
        clean = {}
        for name, (lower, upper) in limits.items():
            item = params.get(name)
            if isinstance(item, bool) or not isinstance(item, int) or not lower <= item <= upper: raise ValidationError(f"invalid {name}")
            clean[name] = item
        result = {"requestId": request_id, "embeddingSpace": EMBEDDING_SPACE, "preset": value["preset"], "params": clean}
        if "corpusRevision" in value:
            revision = value["corpusRevision"]
            if not isinstance(revision, str) or not _RUN_ID.fullmatch(revision): raise ValidationError("invalid corpusRevision")
            result["corpusRevision"] = revision
        return result

    def _request(self, value: object) -> dict[str, Any]:
        return self._request_static(value)

    @staticmethod
    def _public(job: Mapping[str, Any], *, lease: bool = False) -> dict[str, Any]:
        result = copy.deepcopy(dict(job))
        if not lease:
            for key in ("leaseToken", "leaseExpiresAt", "leaseExpiresEpoch", "workerId"):
                result.pop(key, None)
        return result

    def _event(self, job: dict[str, Any], state: str, now: float, **extra: Any) -> None:
        job["state"] = state; job["revision"] += 1; job["updatedAt"] = _timestamp(now)
        job["history"].append({"state": state, "revision": job["revision"], "at": job["updatedAt"], **extra})

    def enqueue(self, actor: object, request: object) -> dict[str, Any]:
        actor_id, normalized = _actor_id(actor), self._request(request)
        with self._locked():
            store = self._load()
            for job in store["jobs"].values():
                if job["actorId"] == actor_id and job["request"]["requestId"] == normalized["requestId"]:
                    if job["request"] != normalized: raise ConflictError("requestId already has different content")
                    return self._public(job)
            now = self.clock(); job_id = secrets.token_hex(16)
            while job_id in store["jobs"]: job_id = secrets.token_hex(16)
            stamp = _timestamp(now)
            job = {"jobId": job_id, "actorId": actor_id, "requestedBy": actor_id, "request": normalized, "state": "queued", "attempt": 1,
                   "revision": 1, "createdAt": stamp, "queuedAt": stamp, "updatedAt": stamp, "history": [{"state": "queued", "revision": 1, "at": stamp}]}
            store["jobs"][job_id] = job; self._save(store); return self._public(job)

    def list(self, actor: object) -> list[dict[str, Any]]:
        _actor_id(actor)
        with self._locked(): return [self._public(job) for job in self._load()["jobs"].values()]

    def get(self, actor: object, job_id: str) -> dict[str, Any]:
        _actor_id(actor); job_id = _identifier(job_id, "jobId")
        with self._locked():
            job = self._load()["jobs"].get(job_id)
            if job is None: raise ValidationError("unknown job")
            return self._public(job)

    def claim(self, worker: object) -> dict[str, Any] | None:
        worker_id = _worker_id(worker)
        if self.offline: return None
        with self._locked():
            store, now = self._load(), self.clock()
            candidates = sorted(store["jobs"].values(), key=lambda item: (item["createdAt"], item["jobId"]))
            job = next((item for item in candidates if item["state"] == "queued" or (item["state"] == "running" and item.get("leaseExpiresEpoch", 0) <= now)), None)
            if job is None: return None
            token = self.token_factory()
            if not isinstance(token, str) or len(token) < 32: raise RuntimeError("token factory returned an unsafe lease token")
            job["workerId"], job["leaseToken"], job["leaseExpiresEpoch"] = worker_id, token, now + LEASE_SECONDS
            self._event(job, "running", now, workerId=worker_id)
            self._save(store); result = self._public(job, lease=True); result["leaseExpiresAt"] = _timestamp(job["leaseExpiresEpoch"]); return result

    def _lease_inputs(self, worker: object, job_id: object, token: object, revision: object) -> tuple[str, str, str, int]:
        worker_id, job_id = _worker_id(worker), _identifier(job_id, "jobId")
        if not isinstance(token, str) or len(token) < 32: raise LeaseError("invalid lease token")
        if isinstance(revision, bool) or not isinstance(revision, int): raise LeaseError("invalid revision")
        return worker_id, job_id, token, revision

    def _lease(self, store: dict[str, Any], worker_id: str, job_id: str, token: str, revision: int) -> tuple[dict[str, Any], float]:
        job = store["jobs"].get(job_id); now = self.clock()
        if not job or job.get("state") != "running" or job.get("workerId") != worker_id or job.get("leaseToken") != token or job.get("revision") != revision or job.get("leaseExpiresEpoch", 0) <= now:
            raise LeaseError("lease is no longer valid")
        return job, now

    def renew(self, worker: object, job_id: object, token: object, revision: object) -> dict[str, Any]:
        worker_id, job_id, token, revision = self._lease_inputs(worker, job_id, token, revision)
        with self._locked():
            store = self._load(); job, now = self._lease(store, worker_id, job_id, token, revision)
            job["leaseExpiresEpoch"] = now + LEASE_SECONDS; self._event(job, "running", now, workerId=worker_id)
            self._save(store); result = self._public(job, lease=True); result["leaseExpiresAt"] = _timestamp(job["leaseExpiresEpoch"]); return result

    def fail(self, worker: object, job_id: object, token: object, revision: object, error: object, *, retryable: object) -> dict[str, Any]:
        if not isinstance(retryable, bool): raise ValidationError("retryable must be boolean")
        if not isinstance(error, str) or error not in _FAILURES: raise ValidationError("unsupported failure code")
        worker_id, job_id, token, revision = self._lease_inputs(worker, job_id, token, revision)
        with self._locked():
            store = self._load(); job, now = self._lease(store, worker_id, job_id, token, revision)
            job["error"] = {"code": error, "message": _FAILURES[error], "retryable": retryable}; job.pop("leaseToken"); job.pop("workerId"); job.pop("leaseExpiresEpoch")
            self._event(job, "failed", now, error=copy.deepcopy(job["error"])); self._save(store); return self._public(job)

    def retry(self, actor: object, job_id: object, retry_request_id: object) -> dict[str, Any]:
        actor_id, job_id, retry_request_id = _actor_id(actor), _identifier(job_id, "jobId"), _identifier(retry_request_id, "retryRequestId")
        with self._locked():
            store = self._load(); job = store["jobs"].get(job_id)
            if not job: raise ValidationError("unknown job")
            retries = job.setdefault("retryRequests", {})
            if not isinstance(retries, dict): raise StorageError("invalid_control_store", retryable=False)
            actor_requests = retries.setdefault(actor_id, [])
            if not isinstance(actor_requests, list) or any(not isinstance(item, str) for item in actor_requests): raise StorageError("invalid_control_store", retryable=False)
            if retry_request_id in actor_requests: return self._public(job)
            if job["state"] != "failed" or not job.get("error", {}).get("retryable"): raise ConflictError("job is not retryable")
            now = self.clock(); job["attempt"] += 1; job["error"] = None; actor_requests.append(retry_request_id); self._event(job, "queued", now, retryRequestId=retry_request_id)
            self._save(store); return self._public(job)

    def complete(self, worker: object, job_id: object, token: object, revision: object, run_id: object) -> dict[str, Any]:
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id): raise ValidationError("invalid draft run ID")
        worker_id, job_id, token, revision = self._lease_inputs(worker, job_id, token, revision)
        with self._locked():
            store = self._load(); job, now = self._lease(store, worker_id, job_id, token, revision)
            manifest_path = self.runs_root / "runs" / run_id / "manifest.json"
            try:
                _reject_symlink_path(manifest_path)
                if manifest_path.is_symlink() or not manifest_path.is_file(): raise OSError("missing")
                packet = json.loads(manifest_path.read_text(encoding="utf8")); _validate_manifest(packet)
            except (OSError, json.JSONDecodeError, ValueError) as error:
                raise ValidationError("draft run is absent or invalid") from error
            request = job["request"]
            if packet["runId"] != run_id or packet["embeddingSpace"] != request["embeddingSpace"] or packet["preset"] != request["preset"] or packet["requestedParams"] != request["params"] or ("corpusRevision" in request and packet["corpusDigest"] != request["corpusRevision"]):
                raise ValidationError("draft run does not match job request")
            job["runId"] = run_id; job.pop("leaseToken"); job.pop("workerId"); job.pop("leaseExpiresEpoch")
            self._event(job, "draft", now, runId=run_id); self._save(store); return self._public(job)
