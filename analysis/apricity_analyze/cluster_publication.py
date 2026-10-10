"""Private local controls for publishing immutable cluster-run manifests.

This is a storage boundary, not a public endpoint and not a visibility claim.
An adapter may later project a stored published envelope for a map or another
consumer, but this module only records curator-approved immutable envelopes.
Its actor argument is a server-created capability (an object with
``is_curator`` and ``id``); request bodies and browser supplied role fields are
never considered authority.
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
import stat
import tempfile
from typing import Any, Callable, Mapping

from .cluster_runs import _validate_manifest


_RUN_ID = re.compile(r"[0-9a-f]{64}\Z")
_ACTOR_ID = re.compile(r"[A-Za-z0-9._:-]{1,160}\Z")


class PublicationError(Exception):
    """A sanitized local-control error suitable for a transport adapter."""
    status_code = 400
    retryable = False


class ValidationError(PublicationError): pass
class ForbiddenError(PublicationError): status_code = 403
class ConflictError(PublicationError): status_code = 409
class UnavailableError(PublicationError):
    status_code, retryable = 503, False
class StorageError(PublicationError):
    status_code, retryable = 503, True


def _safe_root(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute(): path = Path.cwd() / path
    if ".." in path.parts: raise ValidationError("unsafe storage root")
    path = path.absolute()
    _no_links(path)
    return path


def _no_links(path: Path) -> None:
    for part in (path, *path.parents):
        try:
            if stat.S_ISLNK(part.lstat().st_mode): raise ValidationError("unsafe storage path")
        except FileNotFoundError:
            pass


def _run_id(value: object) -> str:
    if not isinstance(value, str) or not _RUN_ID.fullmatch(value): raise ValidationError("invalid run ID")
    return value


def _curator(actor: object) -> str:
    # Deliberately do not accept mappings: a decoded HTTP body is not authority.
    if isinstance(actor, Mapping) or not bool(getattr(actor, "is_curator", False)):
        raise ForbiddenError("curator authority required")
    value = getattr(actor, "id", None)
    if not isinstance(value, str) or not _ACTOR_ID.fullmatch(value): raise ForbiddenError("invalid curator context")
    return value


def _revision(value: object, name: str, *, nullable: bool = False) -> int | None:
    if nullable and value is None: return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1: raise ValidationError(f"invalid {name}")
    return value


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _clean_notes(value: object) -> str:
    if not isinstance(value, str): raise ValidationError("review notes are required")
    value = value.strip()
    if not 1 <= len(value) <= 2000: raise ValidationError("review notes must be 1..2000 characters")
    return value


def _ids(value: object, allowed: set[str]) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValidationError("reviewed semantic IDs are invalid")
    if len(set(value)) != len(value) or any(item not in allowed for item in value):
        raise ValidationError("reviewed semantic IDs do not belong to this run")
    return sorted(value)


class ClusterPublicationRegistry:
    """Flock-protected private controls and immutable published envelopes."""

    def __init__(self, control_root: str | Path, runs_root: str | Path, *,
                 current_corpus_digest: Callable[[], str] | None = None,
                 current_corpus_digest_provider: Callable[[], str] | None = None,
                 enabled: bool = False, clock: Callable[[], str] | None = None):
        self.root, self.runs_root = _safe_root(control_root), _safe_root(runs_root)
        if current_corpus_digest is not None and current_corpus_digest_provider is not None:
            raise TypeError("provide one trusted corpus provider")
        provider = current_corpus_digest if current_corpus_digest is not None else current_corpus_digest_provider
        if not callable(provider): raise TypeError("current_corpus_digest must be a trusted provider")
        if not isinstance(enabled, bool): raise TypeError("enabled must be a trusted boolean")
        if clock is not None and not callable(clock): raise TypeError("clock must be a trusted callable")
        self.current_corpus_digest = provider
        # This is process configuration, never a curator/request field.
        self.enabled, self.clock = enabled, (clock or _stamp)
        self.path, self.lock_path = self.root / "cluster-publication.json", self.root / ".cluster-publication.lock"

    def _now(self) -> str:
        try: value = self.clock()
        except Exception as error: raise StorageError("publication clock unavailable") from error
        if not isinstance(value, str) or not value.endswith("Z"):
            raise StorageError("publication clock unavailable")
        return value

    def _ensure(self) -> None:
        try:
            _no_links(self.root); self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.root.is_symlink() or not self.root.is_dir(): raise ValidationError("unsafe storage root")
            os.chmod(self.root, 0o700)
        except PublicationError: raise
        except (OSError, TypeError, ValueError) as error: raise StorageError("publication storage unavailable") from error

    @contextmanager
    def _locked(self):
        self._ensure()
        try:
            if self.lock_path.is_symlink(): raise ValidationError("unsafe storage lock")
            descriptor = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            os.fchmod(descriptor, 0o600)
        except OSError as error: raise StorageError("publication storage unavailable") from error
        try:
            try: fcntl.flock(descriptor, fcntl.LOCK_EX)
            except OSError as error: raise StorageError("publication storage unavailable") from error
            yield
        finally:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)
            except OSError as error:
                raise StorageError("publication storage unavailable") from error

    def _load(self) -> dict[str, Any]:
        try:
            if not self.path.exists(): return {"schemaVersion": 1, "pointerRevision": 0, "controls": {}, "published": {}, "pointers": {}}
            if self.path.is_symlink() or not self.path.is_file(): raise ValidationError("unsafe publication storage")
            os.chmod(self.path, 0o600)
            value = json.loads(self.path.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError) as error: raise StorageError("publication storage unavailable") from error
        if (not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("controls"), dict)
                or not isinstance(value.get("published"), dict) or not isinstance(value.get("pointers"), dict)
                or isinstance(value.get("pointerRevision"), bool) or not isinstance(value.get("pointerRevision"), int)
                or value.get("pointerRevision") < 0):
            raise ValidationError("invalid publication storage")
        return value

    @staticmethod
    def _control(store: Mapping[str, Any], run_id: str) -> dict[str, Any]:
        control = store["controls"].get(run_id)
        if control is None: raise ValidationError("unknown publication control")
        if not isinstance(control, dict) or control.get("runId") != run_id:
            raise ValidationError("invalid publication control")
        _revision(control.get("runRevision"), "stored run revision")
        if not isinstance(control.get("overrides"), dict): raise ValidationError("invalid publication control")
        return control

    def _replace(self, source: str, target: str) -> None: os.replace(source, target)

    def _save(self, value: Mapping[str, Any]) -> None:
        try:
            descriptor, temporary = tempfile.mkstemp(prefix=".cluster-publication-", dir=self.root)
            os.fchmod(descriptor, 0o600)
            try:
                with os.fdopen(descriptor, "w", encoding="utf8") as handle:
                    json.dump(value, handle, sort_keys=True, separators=(",", ":"), allow_nan=False)
                    handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
                self._replace(temporary, str(self.path))
                directory = os.open(self.root, os.O_RDONLY)
                try: os.fsync(directory)
                finally: os.close(directory)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        except PublicationError: raise
        except (OSError, TypeError, ValueError) as error: raise StorageError("publication storage unavailable") from error

    def _manifest(self, run_id: str) -> dict[str, Any]:
        path = self.runs_root / "runs" / run_id / "manifest.json"
        try:
            _no_links(path)
            if path.is_symlink() or not path.is_file(): raise OSError("missing")
            value = json.loads(path.read_text(encoding="utf8")); _validate_manifest(value)
        except (OSError, ValueError, TypeError, AttributeError, json.JSONDecodeError) as error:
            raise ValidationError("draft manifest is absent or invalid") from error
        if value["runId"] != run_id: raise ValidationError("draft manifest is absent or invalid")
        return value

    @staticmethod
    def _private(control: Mapping[str, Any]) -> dict[str, Any]: return copy.deepcopy(dict(control))

    @staticmethod
    def _published(envelope: Mapping[str, Any]) -> dict[str, Any]:
        """Return a detached canonical stored envelope, including map coordinates."""
        return copy.deepcopy(dict(envelope))

    def initialize(self, actor: object, run_id: object) -> dict[str, Any]:
        _curator(actor); run_id = _run_id(run_id)
        manifest = self._manifest(run_id)
        with self._locked():
            store = self._load(); current = store["controls"].get(run_id)
            if current is not None and not isinstance(current, Mapping): raise ValidationError("invalid publication control")
            if current is not None: return self._private(current)
            control = {"runId": run_id, "runRevision": 1, "overrides": {}, "review": None,
                       "manifestDigest": manifest["corpusDigest"], "createdAt": self._now()}
            store["controls"][run_id] = control; self._save(store); return self._private(control)

    def get(self, actor: object, run_id: object) -> dict[str, Any]:
        _curator(actor); run_id = _run_id(run_id)
        with self._locked():
            control = self._control(self._load(), run_id)
            return self._private(control)

    def draft_manifest(self, actor: object, run_id: object) -> dict[str, Any]:
        """Return one immutable *draft* only to a trusted curator.

        This deliberately lives beside the private control surface rather than
        ``published_manifest``: callers of the latter must never gain a way to
        address an unpublished run.  The result is detached so a transport or
        preview presenter cannot mutate the stored artifact in memory.
        """
        _curator(actor)
        return copy.deepcopy(self._manifest(_run_id(run_id)))

    def pointer_revision(self, actor: object) -> int:
        """Read the publication CAS revision through the private boundary."""
        _curator(actor)
        with self._locked():
            return self._load()["pointerRevision"]

    def override(self, actor: object, run_id: object, cluster_id: object, label: object, *, expected_run_revision: object) -> dict[str, Any]:
        curator, run_id, expected = _curator(actor), _run_id(run_id), _revision(expected_run_revision, "run revision")
        if not isinstance(cluster_id, str) or not cluster_id.strip(): raise ValidationError("unknown cluster")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120: raise ValidationError("label must be 1..120 characters")
        label = label.strip()
        manifest = self._manifest(run_id)
        if cluster_id not in {row["clusterId"] for row in manifest["clusters"]}: raise ValidationError("unknown cluster")
        with self._locked():
            store = self._load(); control = self._control(store, run_id)
            if run_id in store["published"]: raise ConflictError("published run is immutable")
            if control["runRevision"] != expected: raise ConflictError("stale run revision")
            control["overrides"][cluster_id] = {"label": label, "curatorId": curator, "at": self._now()}
            control["review"] = None; control["runRevision"] += 1; self._save(store); return self._private(control)

    def review(self, actor: object, run_id: object, reviewed_semantic_ids: object, notes: object, *, expected_run_revision: object) -> dict[str, Any]:
        curator, run_id, expected = _curator(actor), _run_id(run_id), _revision(expected_run_revision, "run revision")
        manifest = self._manifest(run_id)
        allowed = {identifier for member in manifest["members"] for identifier in [member["semanticId"], *member["aliases"]]}
        allowed.update(item["semanticId"] for cluster in manifest["clusters"] for item in cluster["representatives"])
        reviewed = _ids(reviewed_semantic_ids, allowed); notes = _clean_notes(notes)
        representatives = {item["semanticId"] for cluster in manifest["clusters"] for item in cluster["representatives"]}
        if representatives and not representatives.issubset(reviewed): raise ValidationError("review must cover every cluster representative")
        if not representatives and allowed and not reviewed: raise ValidationError("unclustered run requires explicit reviewed semantic IDs")
        with self._locked():
            store = self._load(); control = self._control(store, run_id)
            if run_id in store["published"]: raise ConflictError("published run is immutable")
            if control["runRevision"] != expected: raise ConflictError("stale run revision")
            control["runRevision"] += 1
            control["review"] = {"status": "approved", "curatorId": curator, "at": self._now(), "notes": notes,
                                 "reviewedSemanticIds": reviewed, "runRevision": control["runRevision"]}
            self._save(store); return self._private(control)

    def publish(self, actor: object, run_id: object, *, expected_run_revision: object, expected_pointer_revision: object) -> dict[str, Any]:
        curator, run_id, expected = _curator(actor), _run_id(run_id), _revision(expected_run_revision, "run revision")
        pointer_expected = _revision(expected_pointer_revision, "pointer revision", nullable=True)
        if not self.enabled: raise ForbiddenError("publication rollout is disabled")
        # Validate the immutable draft before creating control-storage artifacts.
        manifest = self._manifest(run_id)
        with self._locked():
            try: current_digest = self.current_corpus_digest()
            except Exception as error: raise StorageError("current corpus unavailable") from error
            if not isinstance(current_digest, str) or current_digest != manifest["corpusDigest"]: raise ConflictError("current corpus has changed")
            store = self._load(); control = self._control(store, run_id)
            if control["runRevision"] != expected: raise ConflictError("stale run revision")
            if control.get("manifestDigest") != manifest["corpusDigest"]: raise ConflictError("draft control no longer matches manifest")
            if run_id in store["published"]: raise ConflictError("run has already been published")
            review = control.get("review")
            if not isinstance(review, Mapping) or review.get("status") != "approved" or review.get("runRevision") != expected:
                raise ConflictError("complete current review is required")
            allowed = {identifier for member in manifest["members"] for identifier in [member["semanticId"], *member["aliases"]]}
            allowed.update(item["semanticId"] for cluster in manifest["clusters"] for item in cluster["representatives"])
            try:
                reviewed = _ids(review.get("reviewedSemanticIds"), allowed)
                _clean_notes(review.get("notes"))
                if not isinstance(review.get("curatorId"), str) or not _ACTOR_ID.fullmatch(review["curatorId"]):
                    raise ValidationError("invalid review")
                if not isinstance(review.get("at"), str) or not review["at"].endswith("Z"):
                    raise ValidationError("invalid review")
            except ValidationError:
                raise ConflictError("complete current review is required")
            representatives = {item["semanticId"] for cluster in manifest["clusters"] for item in cluster["representatives"]}
            if not representatives.issubset(set(reviewed)):
                raise ConflictError("complete current review is required")
            actual_pointer = store["pointerRevision"]
            if (actual_pointer == 0 and pointer_expected is not None) or (actual_pointer != 0 and pointer_expected != actual_pointer):
                raise ConflictError("stale publication pointer")
            audit = {"curatorId": curator, "publishedAt": self._now(), "review": copy.deepcopy(dict(review)),
                     "runRevision": expected, "overrides": copy.deepcopy(control["overrides"])}
            envelope = {"schemaVersion": "apricity.published-cluster-manifest/1", "state": "published", "runId": run_id,
                        "manifest": copy.deepcopy(manifest), "reviewAudit": audit}
            store["published"][run_id] = envelope
            store["pointerRevision"] = actual_pointer + 1
            store["pointers"][manifest["preset"]] = {"runId": run_id, "pointerRevision": store["pointerRevision"]}
            self._save(store)
            return self._published(envelope)

    def published_manifest(self, run_id: object | None = None, *, preset: object | None = None) -> dict[str, Any]:
        if not self.enabled: raise UnavailableError("published manifests are unavailable")
        if run_id is not None and preset is not None: raise ValidationError("choose run ID or preset")
        if run_id is not None: run_id = _run_id(run_id)
        elif not isinstance(preset, str) or not preset: raise ValidationError("run ID or preset required")
        with self._locked():
            store = self._load()
            if run_id is None:
                pointer = store["pointers"].get(preset)
                if not isinstance(pointer, Mapping) or not isinstance(pointer.get("runId"), str): raise ValidationError("published manifest not available")
                run_id = pointer["runId"]
            envelope = store["published"].get(run_id)
            if not isinstance(envelope, Mapping) or envelope.get("state") != "published" or envelope.get("runId") != run_id:
                raise ValidationError("published manifest not available")
            return self._published(envelope)

    def list_published_manifests(self) -> list[dict[str, Any]]:
        if not self.enabled: raise UnavailableError("published manifests are unavailable")
        with self._locked():
            store = self._load()
            return [self._published(envelope) for run_id, envelope in sorted(store["published"].items())
                    if isinstance(envelope, Mapping) and envelope.get("state") == "published" and envelope.get("runId") == run_id]

    # Stable internal spellings for transport adapters.
    publishedManifest = published_manifest
    listPublishedManifests = list_published_manifests
    lookup = published_manifest
    list = list_published_manifests


PublicationRegistry = ClusterPublicationRegistry
ClusterPublicationService = ClusterPublicationRegistry
