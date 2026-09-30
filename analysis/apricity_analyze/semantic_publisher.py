"""Validate and atomically publish canonical semantic records.

The publisher is intentionally the last contract boundary before local or cloud
storage: malformed materialization output must never partially replace a corpus.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any

from .semantic_contract import SemanticContractError, SemanticIdentity, validate_vector
from .semantic_records import load_catalog, materialize_sidecar

SCHEMA = "apricity.semantic-corpus/1"
KINDS = ("saved_clip", "window")

def _counts(): return {kind: 0 for kind in KINDS}
def _record_counts(records):
    counts = _counts()
    for row in records: counts[_kind(row)] += 1
    return counts
def _kind(row): return row["identity"]["kind"]
def _id(row): return row["identity"]["semanticId"]
def _space(row): return row["identity"]["embeddingSpace"]
def _sample(row): return row["identity"]["sampleId"]
def _sha(value): return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)
def _compact(value): return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".corpus-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as target:
            json.dump(value, target, separators=(",", ":"), ensure_ascii=False); target.write("\n")
            target.flush(); os.fsync(target.fileno())
        os.replace(temporary, path)
    except BaseException:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
        raise

def _load(path: Path) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if not path.exists(): return None, []
    try: value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error: raise ValueError(f"invalid existing corpus: {error}") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA or not isinstance(value.get("records"), list):
        raise ValueError("invalid existing corpus envelope")
    return value, value["records"]

def _timestamp(value: object) -> None:
    if not isinstance(value, str): raise ValueError("metadataUpdatedAt must be a canonical timestamp")
    try: parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error: raise ValueError("metadataUpdatedAt must be a canonical timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None: raise ValueError("metadataUpdatedAt must include timezone")

def _validate_record(row: object) -> None:
    if not isinstance(row, dict) or set(row) != {"identity", "vector", "display", "playback", "revision", "metadataUpdatedAt"}:
        raise ValueError("semantic record has invalid fields")
    identity = row["identity"]
    if not isinstance(identity, dict): raise ValueError("semantic identity must be an object")
    required = {"semanticId", "sampleId", "recordingId", "kind", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint"}
    if not required.issubset(identity) or set(identity) - (required | {"clipId"}): raise ValueError("semantic identity has invalid fields")
    if identity.get("kind") == "window" and "clipId" in identity: raise ValueError("window identity must not contain clipId")
    try:
        canonical = SemanticIdentity(sample_id=identity["sampleId"], recording_id=identity["recordingId"], kind=identity["kind"],
            clip_id=identity.get("clipId"), start=identity["start"], end=identity["end"], audio_sha256=identity["audioSha256"],
            embedding_space=identity["embeddingSpace"], processing_fingerprint=identity["processingFingerprint"])
        validate_vector(row["vector"])
    except (KeyError, SemanticContractError, TypeError) as error: raise ValueError(f"invalid semantic record: {error}") from error
    if identity["semanticId"] != canonical.semantic_id: raise ValueError("semantic identity is not canonical")
    if not _sha(row["revision"]): raise ValueError("semantic revision must be 64 lowercase hexadecimal characters")
    # Saved clips have no grid component, so their revision is fully recomputable here.
    if canonical.kind == "saved_clip" and row["revision"] != hashlib.sha256(_compact([canonical.semantic_id, ""]).encode()).hexdigest():
        raise ValueError("semantic revision is not canonical")
    display = row["display"]
    if not isinstance(display, dict) or set(display) - {"samplePath", "sampleTitle", "clipName", "clipKind", "tags"} or not {"samplePath", "sampleTitle", "tags"}.issubset(display): raise ValueError("invalid semantic display")
    if not all(isinstance(display[x], str) for x in ("samplePath", "sampleTitle", "clipName", "clipKind") if x in display) or not isinstance(display["tags"], list) or not all(isinstance(x, str) for x in display["tags"]): raise ValueError("invalid semantic display")
    playback = row["playback"]
    if not isinstance(playback, dict) or set(playback) != {"fileKey", "start", "end"} or not isinstance(playback["fileKey"], str) or not playback["fileKey"]: raise ValueError("invalid semantic playback")
    if any(isinstance(playback[key], bool) or not isinstance(playback[key], (int, float)) or not math.isfinite(playback[key]) for key in ("start", "end")) or playback["start"] != identity["start"] or playback["end"] != identity["end"]: raise ValueError("playback bounds must equal canonical identity")
    _timestamp(row["metadataUpdatedAt"])

def _validate(records: list[dict[str, Any]], *, allow_empty=False) -> tuple[str | None, str | None]:
    if not records:
        if allow_empty: return None, None
        raise ValueError("no eligible semantic records")
    for row in records: _validate_record(row)
    spaces, fingerprints, ids = {_space(x) for x in records}, {x["identity"]["processingFingerprint"] for x in records}, [_id(x) for x in records]
    if len(spaces) != 1: raise ValueError("embedding space must not mix")
    if len(fingerprints) != 1: raise ValueError("processing fingerprint must not mix")
    if len(ids) != len(set(ids)): raise ValueError("semantic identities must be unique")
    return spaces.pop(), fingerprints.pop()

def _report(records, excluded, indexed, retired, *, dry_run, persisted):
    eligible, excluded_counts = _record_counts(records), _counts()
    for row in excluded:
        if row.get("kind") in excluded_counts: excluded_counts[row["kind"]] += 1
    reasons = dict(sorted(Counter(row.get("reason", "unknown") for row in excluded).items()))
    timestamps = [row["metadataUpdatedAt"] for row in records]
    source_failures = [row for row in excluded if row.get("kind") in {"sample", "sidecar", "analysis"}]
    record_failures = [row for row in excluded if row not in source_failures]
    return {"schemaVersion": SCHEMA, "dryRun": dry_run, "counts": {"eligible": eligible, "projected": eligible, "indexed": indexed, "excluded": excluded_counts, "retired": retired},
        "coverage": {"persisted": _record_counts(persisted), "projected": eligible, "excluded": excluded_counts}, "excludedReasons": reasons,
        "embeddingSpace": _space(records[0]) if records else None, "newestMetadataUpdatedAt": max(timestamps, default=None),
        "lagSeconds": None, "sourceFailures": source_failures, "recordFailures": record_failures, "excluded": excluded}

class LocalCorpusPublisher:
    def __init__(self, output: str | Path, *, checkpoint: str | Path | None = None):
        self.output, self.checkpoint = Path(output), Path(checkpoint) if checkpoint else None

    def publish(self, materialized: dict[str, Any], *, scope: set[str] | None = None, dry_run=False, batch_size=100,
                embedding_space: str | None = None, processing_fingerprint: str | None = None) -> dict[str, Any]:
        records, excluded = list(materialized.get("records", [])), list(materialized.get("excluded", []))
        if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size < 1: raise ValueError("batch_size must be a positive integer")
        old_envelope, old = _load(self.output)
        old_space, old_fingerprint = _validate(old, allow_empty=True)
        if old_envelope:
            if old:
                if old_envelope.get("embeddingSpace") != old_space or old_envelope.get("processingFingerprint") != old_fingerprint: raise ValueError("existing corpus envelope does not match validated records")
            else:
                old_space, old_fingerprint = old_envelope.get("embeddingSpace"), old_envelope.get("processingFingerprint")
                if not isinstance(old_space, str) or not old_space or not isinstance(old_fingerprint, str) or not old_fingerprint: raise ValueError("existing empty corpus lacks embedding contract")
        incoming_space, incoming_fingerprint = _validate(records, allow_empty=True)
        reported_sources = {row.get("sampleId") for row in excluded if isinstance(row, dict) and isinstance(row.get("sampleId"), str) and row["sampleId"]}
        actual_scope = set(scope) if scope is not None else {_sample(row) for row in old} | {_sample(row) for row in records} | reported_sources
        if any(not isinstance(item, str) or not item for item in actual_scope): raise ValueError("sample scope must contain nonempty sample ids")
        if scope is not None and any(_sample(row) not in actual_scope for row in records): raise ValueError("incoming record outside explicit scope")
        space = incoming_space or old_space or embedding_space
        fingerprint = incoming_fingerprint or old_fingerprint or processing_fingerprint
        if not isinstance(space, str) or not space or not isinstance(fingerprint, str) or not fingerprint: raise ValueError("empty publication requires explicit embedding space and processing fingerprint")
        if (incoming_space and incoming_space != space) or (old_space and old_space != space): raise ValueError("embedding space must not mix")
        if (incoming_fingerprint and incoming_fingerprint != fingerprint) or (old_fingerprint and old_fingerprint != fingerprint): raise ValueError("processing fingerprint must not mix")
        old_by_id, incoming = {_id(row): row for row in old}, {_id(row): row for row in records}
        retained = {key: row for key, row in old_by_id.items() if _sample(row) not in actual_scope}
        changed = [row for key, row in incoming.items() if old_by_id.get(key) != row]
        retired_rows = [row for row in old if _sample(row) in actual_scope and _id(row) not in incoming]
        indexed, retired = _counts(), _counts()
        for row in changed: indexed[_kind(row)] += 1
        for row in retired_rows: retired[_kind(row)] += 1
        persisted = [*retained.values(), *incoming.values()]
        report = _report(persisted, excluded, indexed, retired, dry_run=dry_run, persisted=old if dry_run else persisted)
        if dry_run: return report
        envelope = {"schemaVersion": SCHEMA, "embeddingSpace": space, "processingFingerprint": fingerprint, "records": [({**retained, **incoming})[key] for key in sorted({**retained, **incoming})]}
        _atomic_json(self.output, envelope)
        if self.checkpoint: _atomic_json(self.checkpoint, {"schemaVersion": SCHEMA, "completed": True, "output": str(self.output), "recordCount": len(envelope["records"])})
        return report

def publish_catalog(materialized, output, *, scope=None, dry_run=False, checkpoint=None, batch_size=100, embedding_space=None, processing_fingerprint=None):
    return LocalCorpusPublisher(output, checkpoint=checkpoint).publish(materialized, scope=scope, dry_run=dry_run, batch_size=batch_size, embedding_space=embedding_space, processing_fingerprint=processing_fingerprint)

def materialize_catalog(catalog: dict[str, Any], samples_root: str | Path, *, sample_ids: set[str] | None = None, metadata_updated_at: str | None = None) -> dict[str, Any]:
    root, accepted, records, excluded = Path(samples_root), load_catalog(catalog), [], []
    if sample_ids is not None:
        known = {sample["id"] for sample in accepted["samples"]}
        unknown = sorted(sample_ids - known)
        if unknown: raise ValueError(f"unknown sample id: {', '.join(unknown)}")
    stamp = metadata_updated_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for sample in accepted["samples"]:
        sample_id = sample["id"]
        if sample_ids is not None and sample_id not in sample_ids: continue
        raw = sample.get("path")
        if not isinstance(raw, str): excluded.append({"kind": "sample", "reason": "missing_source_path", "sampleId": sample_id}); continue
        candidate = root / raw.removeprefix("samples/")
        try: source = candidate.resolve(strict=True); source.relative_to(root.resolve(strict=True))
        except (OSError, ValueError): excluded.append({"kind": "sample", "reason": "unsafe_source_path", "sampleId": sample_id}); continue
        result = materialize_sidecar(source.with_name(source.name + ".apricity.json"), accepted, stamp, samples_root=root)
        records.extend(result["records"]); excluded.extend([{**row, "sampleId": sample_id} for row in result["excluded"]])
    return {"records": records, "excluded": excluded}

def _ddb_value(value: Any) -> dict[str, Any]:
    if isinstance(value, str): return {"S": value}
    if isinstance(value, bool): return {"BOOL": value}
    if isinstance(value, (int, float)) and math.isfinite(value): return {"N": str(value)}
    if isinstance(value, list): return {"L": [_ddb_value(item) for item in value]}
    if isinstance(value, dict): return {"M": {key: _ddb_value(item) for key, item in value.items()}}
    raise ValueError("unsupported Dynamo record attribute")

class DynamoCorpusPublisher:
    """Injected DynamoDB adapter. It uses paginated Query only; no Scan is available."""
    def __init__(self, client, table_name: str, *, checkpoint: str | Path | None = None): self.client, self.table_name, self.checkpoint = client, table_name, Path(checkpoint) if checkpoint else None
    def reconcile(self, records: list[dict[str, Any]], *, sample_id: str, embedding_space: str):
        if not isinstance(sample_id, str) or not sample_id or not isinstance(embedding_space, str) or not embedding_space: raise ValueError("sample_id and embedding_space are required")
        space, _ = _validate(records, allow_empty=True)
        if space is not None and space != embedding_space: raise ValueError("incoming records do not match embedding space")
        if any(_sample(row) != sample_id for row in records): raise ValueError("incoming record outside sample scope")
        existing, last_key = {}, None
        while True:
            query = {"TableName": self.table_name, "KeyConditionExpression": "embeddingSpace = :space", "FilterExpression": "sampleId = :sample", "ExpressionAttributeValues": {":space": {"S": embedding_space}, ":sample": {"S": sample_id}}}
            if last_key is not None: query["ExclusiveStartKey"] = last_key
            response = self.client.query(**query)
            for item in response.get("Items", []):
                if item.get("sampleId", {}).get("S") == sample_id and isinstance(item.get("semanticId", {}).get("S"), str): existing[item["semanticId"]["S"]] = item
            last_key = response.get("LastEvaluatedKey")
            if not last_key: break
        wanted = {_id(row): row for row in records}
        for key, row in wanted.items():
            item = {"embeddingSpace": {"S": embedding_space}, "semanticId": {"S": key}, "sampleId": {"S": sample_id}, "kind": {"S": _kind(row)}, "processingFingerprint": {"S": row["identity"]["processingFingerprint"]}, "vector": {"L": [{"N": str(x)} for x in row["vector"]]}, "identity": _ddb_value(row["identity"]), "revision": {"S": row["revision"]}, "display": _ddb_value(row["display"]), "playback": _ddb_value(row["playback"]), "metadataUpdatedAt": {"S": row["metadataUpdatedAt"]}}
            self.client.put_item(TableName=self.table_name, Item=item)
        for key in existing.keys() - wanted.keys(): self.client.delete_item(TableName=self.table_name, Key={"embeddingSpace": {"S": embedding_space}, "semanticId": {"S": key}})
        if self.checkpoint:
            completed = []
            if self.checkpoint.exists():
                try: completed = json.loads(self.checkpoint.read_text()).get("completedSamples", [])
                except (OSError, json.JSONDecodeError): raise ValueError("invalid cloud checkpoint")
            _atomic_json(self.checkpoint, {"schemaVersion": SCHEMA, "completedSamples": sorted(set(completed) | {sample_id})})
