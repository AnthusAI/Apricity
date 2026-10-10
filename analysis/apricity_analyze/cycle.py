"""Listening cycles: publish a blind A/B/C/D round of a score's candidates, and pull the verdict back.

The human-in-the-loop loop (Kanbus apricitus-2101dd): the local explorer (`scripts/explore.py`) leaves
finalists; `cycle.py publish` makes each one a fork Score (tagged "candidate", folder "cycles/<id>"),
uploads its cached render, and writes a `ListeningCycle` with the incumbent as one lettered option among
them, letters shuffled so nobody knows which is which. A person rates the options and saves a verdict in
the web app (cloud), or locally through `apricity serve`. `cycle.py pull` reads the Ratings and the
CycleVerdict back, maps the letters back through the cycle's own record, and appends what it found to
`renders/log.jsonl` (never rewritten, like `check-stems.py` and `verdict.py`'s notebook).

Two backends, chosen by `--target`:
  local   the library folder (`~/Apricity-Library` by default): one JSON file per record
          (`<Model>/<key>.json`, as Virtuus writes them: crates/apricity-data/src/library.rs,
          design/storage.md §3.3) and files under `files/`.
  cloud   DynamoDB tables and the S3 bucket behind the deployed app (the `apricity_analyze.prune_aws`
          pattern: table names discovered from `Score-<suffix>-NONE`, the bucket from
          `amplify_outputs.json`). Never guesses an owner: `--owner <sub>::<username>` names the
          Cognito identity whose ratings/scores these become (Amplify's owner format, `web/src/data/
          import-library.ts` `isLocalIdentity`/ranking-lambda tests' `"u1::u1"`).

Both backends implement the same small protocol below, so `publish`/`list_open`/`pull` are backend-
agnostic and unit-tested against a temp local library and a fake DynamoDB/S3 client.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
import mimetypes
import pathlib
import random
import re
import urllib.request
import uuid
from typing import Any, Iterable, Protocol

LETTERS = "ABCD"
# A FileRef key is library-relative (`cycles/<id>/A.m4a`, like `audio/...`): the file lives under the library's
# `files/` folder locally and under `files/` in the bucket (web/src/data/files.ts CLOUD_PREFIX).
FILES_PREFIX = "files/"
OUTPUTS = "https://apricity.anth.us/amplify_outputs.json"

CONTENT_TYPES = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}


# --------------------------------------------------------------------------- small helpers

def library_dir(library: pathlib.Path | None = None) -> pathlib.Path:
    return (library or pathlib.Path.home() / "Apricity-Library").expanduser()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def new_cycle_id() -> str:
    return f"cyc_{uuid.uuid4().hex[:16]}"


def new_lab_id() -> str:
    return f"lab_{uuid.uuid4().hex[:16]}"


def score_id_for(folder: str, title: str, fmt: str = "apr") -> str:
    """The same id shape `apricity migrate` gives a score (crates/apricity-data/src/migration.rs):
    `scr_<folder, / -> _>_<title>_<format>`. Deterministic, so re-publishing the same candidate file
    into the same cycle is idempotent."""
    return f"scr_{folder.replace('/', '_')}_{title}_{fmt}"


def content_type_for(path: pathlib.Path) -> str:
    ext = path.suffix.lower()
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    guess, _ = mimetypes.guess_type(str(path))
    return guess or "application/octet-stream"


def append_log(log_path: pathlib.Path, entry: dict) -> None:
    log_path = pathlib.Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def read_cycle_key(log_path: pathlib.Path, cycle_id: str) -> dict[str, dict] | None:
    """The blind key `publish` logged for this cycle (letter -> {scoreId, source}), or None if the
    log doesn't have it (a different machine, or a rotated log) -- `pull` falls back to the
    ListeningCycle's own `options` in that case."""
    log_path = pathlib.Path(log_path)
    if not log_path.exists():
        return None
    key: dict[str, dict] | None = None
    for line in log_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("kind") == "listening-cycle" and rec.get("cycleId") == cycle_id:
            key = rec.get("key")
    return key


# --------------------------------------------------------------------------- DynamoDB attribute values (no boto3
# import needed for this: the low-level client's put_item/get_item/query/scan all take and return this same plain
# {"S": ...} / {"N": ...} shape, so a fake client in tests needs nothing beyond dicts).

def to_ddb(value: Any) -> dict:
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        return {"L": [to_ddb(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: to_ddb(v) for k, v in value.items()}}
    raise TypeError(f"unsupported DynamoDB value: {value!r}")


def from_ddb(av: dict) -> Any:
    if "S" in av:
        return av["S"]
    if "N" in av:
        n = av["N"]
        return int(n) if re.fullmatch(r"-?\d+", n) else float(n)
    if "BOOL" in av:
        return av["BOOL"]
    if "NULL" in av:
        return None
    if "L" in av:
        return [from_ddb(v) for v in av["L"]]
    if "M" in av:
        return {k: from_ddb(v) for k, v in av["M"].items()}
    raise TypeError(f"unsupported DynamoDB attribute value: {av!r}")


def item_to_ddb(record: dict) -> dict:
    return {k: to_ddb(v) for k, v in record.items() if v is not None}


def item_from_ddb(item: dict) -> dict:
    return {k: from_ddb(v) for k, v in item.items()}


# --------------------------------------------------------------------------- backend protocol

class Backend(Protocol):
    owner: str | None

    def get_score(self, score_id: str) -> dict | None: ...
    def create_score(self, record: dict) -> dict: ...
    def upload_file(self, key: str, local_path: pathlib.Path, content_type: str) -> dict: ...
    def put_listening_cycle(self, record: dict) -> dict: ...
    def get_cycle(self, cycle_id: str) -> dict | None: ...
    def list_open_cycles(self) -> list[dict]: ...
    def ratings_for(self, score_ids: Iterable[str]) -> list[dict]: ...
    def cycle_verdicts(self, cycle_id: str) -> list[dict]: ...
    def close_cycle(self, cycle_id: str, closed_at: str) -> None: ...


# --------------------------------------------------------------------------- local backend: the library folder

class LocalBackend:
    """Reads and writes a library folder directly, in the same file-per-record shape Virtuus writes
    (crates/apricity-data/src/library.rs `Library::create`, design/storage.md §3.3): `<Model>/<key>.json`
    for a simple id, `<Model>/<partition>__<sort>.json` for a composite one (Virtuus
    `Table::filename_for_key`). No PyO3 binding exists yet (design/storage.md §3.2, "not yet"), so this
    writes the files a local `apricity serve` reads, rather than going through the engine."""

    def __init__(self, library: pathlib.Path | None = None, owner: str | None = None):
        self.library = library_dir(library)
        meta_path = self.library / "apricity-library.json"
        sub = "local"
        if meta_path.exists():
            try:
                sub = json.loads(meta_path.read_text()).get("identity", {}).get("sub", "local") or "local"
            except (json.JSONDecodeError, OSError):
                pass
        self.judge = sub
        self.owner = owner or sub

    def _dir(self, model: str) -> pathlib.Path:
        d = self.library / model
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _write(self, model: str, filename: str, record: dict) -> None:
        (self._dir(model) / f"{filename}.json").write_text(json.dumps(record) + "\n")

    def _read(self, model: str, filename: str) -> dict | None:
        p = self.library / model / f"{filename}.json"
        if not p.exists():
            return None
        return json.loads(p.read_text())

    def get_score(self, score_id: str) -> dict | None:
        return self._read("Score", score_id)

    def create_score(self, record: dict) -> dict:
        now = now_iso()
        rec = {**record, "__typename": "Score", "createdAt": now, "updatedAt": now}
        self._write("Score", record["id"], rec)
        return rec

    def upload_file(self, key: str, local_path: pathlib.Path, content_type: str) -> dict:
        data = pathlib.Path(local_path).read_bytes()
        dest = self.library / "files" / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return {"key": key, "sha256": sha256_bytes(data), "size": len(data), "contentType": content_type}

    def put_listening_cycle(self, record: dict) -> dict:
        now = now_iso()
        rec = {**record, "__typename": "ListeningCycle", "createdAt": now, "updatedAt": now}
        self._write("ListeningCycle", record["id"], rec)
        return rec

    def get_cycle(self, cycle_id: str) -> dict | None:
        return self._read("ListeningCycle", cycle_id)

    def list_open_cycles(self) -> list[dict]:
        d = self.library / "ListeningCycle"
        if not d.exists():
            return []
        return [rec for p in sorted(d.glob("*.json")) if (rec := json.loads(p.read_text())).get("status") == "open"]

    def ratings_for(self, score_ids: Iterable[str]) -> list[dict]:
        wanted = set(score_ids)
        d = self.library / "Rating"
        if not d.exists():
            return []
        out = []
        for p in sorted(d.glob("*.json")):
            rec = json.loads(p.read_text())
            if rec.get("targetType") == "score" and rec.get("targetId") in wanted:
                out.append(rec)
        return out

    def cycle_verdicts(self, cycle_id: str) -> list[dict]:
        d = self.library / "CycleVerdict"
        if not d.exists():
            return []
        return [json.loads(p.read_text()) for p in sorted(d.glob(f"{cycle_id}__*.json"))]

    def close_cycle(self, cycle_id: str, closed_at: str) -> None:
        cyc = self.get_cycle(cycle_id)
        if cyc is None:
            raise ValueError(f"no such cycle: {cycle_id}")
        cyc = {**cyc, "status": "closed", "closedAt": closed_at, "updatedAt": now_iso()}
        self._write("ListeningCycle", cycle_id, cyc)

    # ----------------------------------------------------------------------- labs (apricitus-e59a0b)

    def create_lab(self, scene_score_id: str, title: str, brief: str | None = None) -> dict:
        lab_id = new_lab_id()
        now = now_iso()
        rec = {"id": lab_id, "title": title, "brief": brief, "sceneScoreId": scene_score_id, "status": "open",
               "owner": self.owner, "__typename": "Lab", "createdAt": now, "updatedAt": now}
        self._write("Lab", lab_id, rec)
        return rec

    def get_lab(self, lab_id: str) -> dict | None:
        return self._read("Lab", lab_id)

    def list_labs(self) -> list[dict]:
        """This backend's identity's own labs, newest first (matches the web's `labsByOwner`)."""
        d = self.library / "Lab"
        if not d.exists():
            return []
        labs = [rec for p in sorted(d.glob("*.json")) if (rec := json.loads(p.read_text())).get("owner") == self.owner]
        labs.sort(key=lambda lab: lab.get("createdAt", ""), reverse=True)
        return labs

    def attach_lab(self, cycle_id: str, lab_id: str) -> dict:
        cyc = self.get_cycle(cycle_id)
        if cyc is None:
            raise ValueError(f"no such cycle: {cycle_id}")
        cyc = {**cyc, "labId": lab_id, "updatedAt": now_iso()}
        self._write("ListeningCycle", cycle_id, cyc)
        return cyc


# --------------------------------------------------------------------------- cloud backend: DynamoDB + S3

class CloudBackend:
    """The production backend, `analysis/apricity_analyze/prune_aws.py`'s pattern extended to write:
    table names discovered from `Score-<suffix>-NONE` (every table shares the suffix), the bucket from
    `amplify_outputs.json`. Never writes to the real cloud in tests: `ddb`/`s3`/`bucket` are injected
    fakes there; production code only constructs real `boto3.client(...)`s when they're not supplied.
    `owner` (`<sub>::<username>`, Amplify's format) is required to publish -- it is never guessed."""

    def __init__(self, *, region: str = "us-east-1", owner: str | None = None, ddb=None, s3=None, bucket: str | None = None):
        if ddb is None or s3 is None or bucket is None:
            import boto3  # only needed for the real backend; tests inject fakes and never import this

            out = json.loads(urllib.request.urlopen(OUTPUTS).read())
            ddb = ddb or boto3.client("dynamodb", region_name=region)
            s3 = s3 or boto3.client("s3", region_name=region)
            bucket = bucket or out["storage"]["bucket_name"]
        self.ddb = ddb
        self.s3 = s3
        self.bucket = bucket
        self.owner = owner
        self.judge = owner.split("::")[0] if owner else None
        self._suffix: str | None = None

    def _find_suffix(self) -> str:
        if self._suffix:
            return self._suffix
        names: list[str] = []
        start = None
        for _ in range(1000):  # bounded: DynamoDB accounts don't have thousands of tables
            kwargs = {"ExclusiveStartTableName": start} if start else {}
            resp = self.ddb.list_tables(**kwargs)
            names += resp.get("TableNames", [])
            start = resp.get("LastEvaluatedTableName")
            if not start:
                break
        suffix = next((t.split("-", 1)[1] for t in names if t.startswith("Score-") and t.endswith("-NONE")), None)
        if not suffix:
            raise RuntimeError("cannot find the Score table (checked list_tables)")
        self._suffix = suffix
        return suffix

    def table(self, model: str) -> str:
        return f"{model}-{self._find_suffix()}"

    def get_score(self, score_id: str) -> dict | None:
        resp = self.ddb.get_item(TableName=self.table("Score"), Key={"id": {"S": score_id}})
        item = resp.get("Item")
        return item_from_ddb(item) if item else None

    def create_score(self, record: dict) -> dict:
        now = now_iso()
        rec = {**record, "__typename": "Score", "createdAt": now, "updatedAt": now}
        self.ddb.put_item(TableName=self.table("Score"), Item=item_to_ddb(rec))
        return rec

    def upload_file(self, key: str, local_path: pathlib.Path, content_type: str) -> dict:
        data = pathlib.Path(local_path).read_bytes()
        sha = sha256_bytes(data)
        self.s3.put_object(Bucket=self.bucket, Key=FILES_PREFIX + key, Body=data, ContentType=content_type, Metadata={"sha256": sha})
        return {"key": key, "sha256": sha, "size": len(data), "contentType": content_type}

    def put_listening_cycle(self, record: dict) -> dict:
        now = now_iso()
        rec = {**record, "__typename": "ListeningCycle", "createdAt": now, "updatedAt": now}
        self.ddb.put_item(TableName=self.table("ListeningCycle"), Item=item_to_ddb(rec))
        return rec

    def get_cycle(self, cycle_id: str) -> dict | None:
        resp = self.ddb.get_item(TableName=self.table("ListeningCycle"), Key={"id": {"S": cycle_id}})
        item = resp.get("Item")
        return item_from_ddb(item) if item else None

    def list_open_cycles(self) -> list[dict]:
        out = []
        start = None
        for _ in range(10_000):
            kwargs = {"ExclusiveStartKey": start} if start else {}
            resp = self.ddb.scan(TableName=self.table("ListeningCycle"), **kwargs)
            out += [item_from_ddb(it) for it in resp.get("Items", []) if item_from_ddb(it).get("status") == "open"]
            start = resp.get("LastEvaluatedKey")
            if not start:
                break
        return out

    def ratings_for(self, score_ids: Iterable[str]) -> list[dict]:
        wanted = set(score_ids)
        out = []
        start = None
        for _ in range(10_000):
            kwargs = {"ExclusiveStartKey": start} if start else {}
            resp = self.ddb.scan(TableName=self.table("Rating"), **kwargs)
            for it in resp.get("Items", []):
                rec = item_from_ddb(it)
                if rec.get("targetType") == "score" and rec.get("targetId") in wanted:
                    out.append(rec)
            start = resp.get("LastEvaluatedKey")
            if not start:
                break
        return out

    def cycle_verdicts(self, cycle_id: str) -> list[dict]:
        out = []
        start = None
        for _ in range(10_000):
            kwargs = {"ExclusiveStartKey": start} if start else {}
            resp = self.ddb.query(
                TableName=self.table("CycleVerdict"),
                IndexName="cycleVerdictsByCycleId",
                KeyConditionExpression="#c = :c",
                ExpressionAttributeNames={"#c": "cycleId"},
                ExpressionAttributeValues={":c": {"S": cycle_id}},
                **kwargs,
            )
            out += [item_from_ddb(it) for it in resp.get("Items", [])]
            start = resp.get("LastEvaluatedKey")
            if not start:
                break
        return out

    def close_cycle(self, cycle_id: str, closed_at: str) -> None:
        self.ddb.update_item(
            TableName=self.table("ListeningCycle"),
            Key={"id": {"S": cycle_id}},
            UpdateExpression="SET #s = :s, closedAt = :c, updatedAt = :u",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": {"S": "closed"}, ":c": {"S": closed_at}, ":u": {"S": now_iso()}},
        )


# --------------------------------------------------------------------------- publish / list / pull

@dataclasses.dataclass
class Candidate:
    apr_path: pathlib.Path
    audio_path: pathlib.Path


def publish(
    backend: Backend,
    *,
    score_path: pathlib.Path,
    incumbent_score_id: str,
    incumbent_audio: pathlib.Path,
    candidates: list[Candidate],
    question: str | None = None,
    title: str | None = None,
    lab_id: str | None = None,
    log_path: pathlib.Path,
    rng: random.Random | None = None,
) -> dict:
    """Publish a listening cycle: the incumbent plus each candidate, blind-lettered A-D. Each
    candidate becomes a fork Score (tagged "candidate", folder "cycles/<id>"); the incumbent is not
    re-created, only relettered. The blind key (letter -> scoreId, and the local source path) is
    appended to `renders/log.jsonl` so `pull` can map ratings back to what they actually rated."""
    if backend.owner is None:
        raise ValueError("no owner to publish as: pass --owner (local defaults to the library's identity)")
    if not candidates:
        raise ValueError("at least one --candidate is required")
    n = 1 + len(candidates)
    if n > len(LETTERS):
        raise ValueError(f"at most {len(LETTERS)} options (A-{LETTERS[len(LETTERS) - 1]}); got {n}")

    incumbent = backend.get_score(incumbent_score_id)
    if incumbent is None:
        raise ValueError(f"no such score: {incumbent_score_id}")

    cycle_id = new_cycle_id()
    folder = f"cycles/{cycle_id}"
    letters = list(LETTERS[:n])
    (rng or random).shuffle(letters)

    # The incumbent first, then each candidate, in the order given; `letters` (already shuffled)
    # assigns which letter each one gets.
    slots: list[tuple[str, str | None, pathlib.Path, pathlib.Path]] = [("incumbent", incumbent_score_id, score_path, incumbent_audio)]
    slots += [("candidate", None, c.apr_path, c.audio_path) for c in candidates]

    options = []
    key: dict[str, dict] = {}
    for letter, (kind, existing_id, source_path, audio_path) in zip(letters, slots):
        if kind == "incumbent":
            sid = existing_id
        else:
            candidate_title = pathlib.Path(source_path).stem
            sid = score_id_for(folder, candidate_title)
            text = pathlib.Path(source_path).read_text()
            backend.create_score({
                "id": sid,
                "title": candidate_title,
                "folder": folder,
                "format": "apr",
                "text": text,
                "tags": ["candidate"],
                "owner": backend.owner,
                "forkOf": incumbent_score_id,
                "forkRoot": incumbent.get("forkRoot") or incumbent_score_id,
            })
        audio_path = pathlib.Path(audio_path)
        audio_key = f"cycles/{cycle_id}/{letter}{audio_path.suffix}"
        file_ref = backend.upload_file(audio_key, audio_path, content_type_for(audio_path))
        options.append({"letter": letter, "scoreId": sid, "audio": file_ref})
        key[letter] = {"scoreId": sid, "source": str(source_path)}

    # Keep the stored options in letter order (A, B, C, D): easier to read back, and the shuffle
    # itself is already what hides which is which.
    options.sort(key=lambda o: o["letter"])

    cycle = {
        "id": cycle_id,
        "title": title or f"{pathlib.Path(score_path).stem}: {question or 'which is better?'}",
        "question": question,
        "incumbentScoreId": incumbent_score_id,
        "options": options,
        "status": "open",
        "owner": backend.owner,
        **({"labId": lab_id} if lab_id else {}),
    }
    backend.put_listening_cycle(cycle)
    append_log(log_path, {"kind": "listening-cycle", "at": now_iso(), "cycleId": cycle_id, "key": key})
    return cycle


def list_open(backend: Backend) -> list[dict]:
    return backend.list_open_cycles()


def pull(backend: Backend, cycle_id: str, *, log_path: pathlib.Path, close: bool = False) -> list[dict]:
    """Read every Rating and CycleVerdict on this cycle's options, map their letters back (from the
    published log when it's there, else from the cycle's own `options`), and append one
    `cycle-verdict` line per finding to `renders/log.jsonl`. Optionally closes the cycle."""
    cycle = backend.get_cycle(cycle_id)
    if cycle is None:
        raise ValueError(f"no such cycle: {cycle_id}")

    logged_key = read_cycle_key(log_path, cycle_id)
    if logged_key:
        score_to_letter = {v["scoreId"]: letter for letter, v in logged_key.items()}
    else:
        score_to_letter = {o["scoreId"]: o["letter"] for o in cycle["options"]}

    score_ids = [o["scoreId"] for o in cycle["options"]]
    # A Rating is per score, not per cycle: the incumbent may carry stars from before this cycle
    # (or an earlier cycle), so only ratings made since the cycle was published count here.
    since = cycle.get("createdAt") or ""
    entries: list[dict] = []
    for r in backend.ratings_for(score_ids):
        if (r.get("ratedAt") or "") < since:
            continue
        entries.append({
            "kind": "cycle-verdict", "at": now_iso(), "cycleId": cycle_id, "type": "rating",
            "judge": r.get("owner"), "letter": score_to_letter.get(r.get("targetId")), "stars": r.get("stars"),
            "ratedAt": r.get("ratedAt"),
        })
    for v in backend.cycle_verdicts(cycle_id):
        notes = v.get("notes") or []
        entries.append({
            "kind": "cycle-verdict", "at": now_iso(), "cycleId": cycle_id, "type": "verdict",
            "judge": v.get("judge"), "best": v.get("best"),
            "notes": [{**n, "letter": n.get("letter")} for n in notes],
            "note": v.get("note"), "savedAt": v.get("savedAt"),
        })
    for entry in entries:
        append_log(log_path, entry)

    if close:
        backend.close_cycle(cycle_id, now_iso())

    return entries
