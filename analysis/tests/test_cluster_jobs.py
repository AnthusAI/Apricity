"""Executable contract for the isolated local M5 cluster-job control plane."""
from __future__ import annotations

import copy
import json
import multiprocessing as mp
from pathlib import Path

import pytest

from apricity_analyze.cluster_jobs import ClusterJobService, ConflictError, ForbiddenError, LeaseError, StorageError, ValidationError
from apricity_analyze.cluster_runs import prepare_run, save_draft_run

SPACE = "clap-htsat-unfused-512-v1"

class FrozenClock:
    def __init__(self, now: float = 1_700_000_000): self.now = now
    def __call__(self): return self.now

class Actor:
    def __init__(self, identifier="curator", curator=True): self.id, self.is_curator = identifier, curator

class Worker:
    is_cluster_worker = True
    def __init__(self, identifier="worker-a"): self.id = identifier

def request(**changes):
    value = {"requestId": "request-1", "embeddingSpace": SPACE, "preset": "useful", "params": {"neighbors": 30, "minClusterSize": 15, "minSamples": 5}}
    value.update(changes); return value

def service(tmp_path: Path, clock=None, *, offline=False):
    tokens = iter(["a" * 48, "b" * 48, "c" * 48, "d" * 48])
    return ClusterJobService(tmp_path / "control", tmp_path / "drafts", clock=clock or FrozenClock(), token_factory=lambda: next(tokens), offline=offline)

def valid_draft(root: Path, *, preset="useful", params=None, corpus="b" * 64):
    """Build via M4's public preparation and save boundary, never hand-roll JSON."""
    from test_cluster_runs import packets
    snapshot, result, summaries = packets()
    snapshot["corpusDigest"] = corpus
    result["corpus"]["digest"] = corpus; summaries["corpus"]["digest"] = corpus
    result["preset"] = summaries["preset"] = preset
    requested = params or {"neighbors": 30, "minClusterSize": 15, "minSamples": 5}
    result["requestedParams"] = copy.deepcopy(requested); summaries["requestedParams"] = copy.deepcopy(requested)
    packet = prepare_run(snapshot, result, summaries, "2026-10-05T00:00:00Z")
    save_draft_run(root, packet)
    return packet

def _race_claim(control, drafts, ready, release, queue):
    jobs = ClusterJobService(control, drafts, clock=lambda: 100, token_factory=lambda: "z" * 48)
    ready.set(); release.wait(5)
    claimed = jobs.claim(Worker("contender"))
    queue.put(None if claimed is None else claimed["jobId"])

@pytest.mark.parametrize("value", [None, True, [], {}, {"requestId": "x"}, {**request(), "extra": 1}, {**request(), "preset": []}, {**request(), "preset": "wrong"}, {**request(), "embeddingSpace": "other"}, {**request(), "corpusRevision": None}, {**request(), "params": []}, {**request(), "params": {"neighbors": True, "minClusterSize": 2, "minSamples": 1}}])
def test_enqueue_request_boundary_rejects_all_invalid_json_shapes_without_persistence(tmp_path, value):
    jobs = service(tmp_path)
    with pytest.raises(ValidationError): jobs.enqueue(Actor(), value)
    assert jobs.list(Actor()) == []
    assert not (tmp_path / "control" / "cluster-jobs.json").exists()

def test_authorization_and_worker_capability_are_explicit_and_persistence_free(tmp_path):
    jobs = service(tmp_path)
    with pytest.raises(ForbiddenError): jobs.enqueue(Actor(curator=False), request())
    with pytest.raises(ForbiddenError): jobs.claim(Actor("guest", curator=False))
    assert jobs.list(Actor()) == []
    assert not (tmp_path / "control" / "cluster-jobs.json").exists()

@pytest.mark.parametrize("mutation", [
    lambda jobs: jobs.renew(Actor("guest", curator=False), "job-1", "a" * 48, 1),
    lambda jobs: jobs.fail(Actor("guest", curator=False), "job-1", "a" * 48, 1, "worker_failure", retryable=True),
    lambda jobs: jobs.complete(Actor("guest", curator=False), "job-1", "a" * 48, 1, "a" * 64),
])
def test_unauthorized_worker_mutations_never_create_control_files(tmp_path, mutation):
    jobs = service(tmp_path)
    with pytest.raises(ForbiddenError): mutation(jobs)
    assert not (tmp_path / "control").exists()

@pytest.mark.parametrize("mutation", [
    lambda jobs: jobs.renew(Worker(), [], "a" * 48, 1),
    lambda jobs: jobs.renew(Worker(), "job-1", [], 1),
    lambda jobs: jobs.renew(Worker(), "job-1", "a" * 48, []),
    lambda jobs: jobs.fail(Worker(), "job-1", "a" * 48, 1, "worker_failure", retryable=[]),
    lambda jobs: jobs.fail(Worker(), "job-1", "a" * 48, 1, [], retryable=True),
    lambda jobs: jobs.complete(Worker(), "job-1", "a" * 48, 1, []),
])
def test_invalid_worker_mutation_inputs_never_create_control_files(tmp_path, mutation):
    jobs = service(tmp_path)
    with pytest.raises((LeaseError, ValidationError)): mutation(jobs)
    assert not (tmp_path / "control").exists()

@pytest.mark.parametrize("mutation", [
    lambda jobs: jobs.renew(Actor("guest", curator=False), "job-1", "a" * 48, 1),
    lambda jobs: jobs.fail(Worker(), "job-1", "a" * 48, [], "worker_failure", retryable=True),
    lambda jobs: jobs.complete(Worker(), "job-1", "a" * 48, 1, []),
])
def test_rejected_worker_mutations_leave_existing_store_bytes_unchanged(tmp_path, mutation):
    jobs = service(tmp_path); jobs.enqueue(Actor(), request())
    store = tmp_path / "control" / "cluster-jobs.json"; before = store.read_bytes()
    with pytest.raises((ForbiddenError, LeaseError, ValidationError)): mutation(jobs)
    assert store.read_bytes() == before

def test_enqueue_contract_names_idempotency_and_no_private_lease_bookkeeping(tmp_path):
    jobs = service(tmp_path, offline=True); actor = Actor(); first = jobs.enqueue(actor, request())
    assert first["state"] == "queued" and first["attempt"] == 1
    assert first["requestedBy"] == "curator" and first["queuedAt"] == first["createdAt"]
    assert jobs.enqueue(actor, request()) == first
    with pytest.raises(ConflictError): jobs.enqueue(actor, request(preset="fine"))
    assert jobs.claim(Worker()) is None

def test_synchronized_multiprocess_race_on_queued_job_has_exactly_one_winner(tmp_path):
    jobs = service(tmp_path, FrozenClock(100)); job = jobs.enqueue(Actor(), request())
    context = mp.get_context("fork"); ready = [context.Event(), context.Event()]; release, queue = context.Event(), context.Queue()
    processes = [context.Process(target=_race_claim, args=(tmp_path / "control", tmp_path / "drafts", item, release, queue)) for item in ready]
    for process in processes: process.start()
    for item in ready: assert item.wait(3)
    release.set()
    for process in processes: process.join(5); assert not process.is_alive()
    results = [queue.get(timeout=2) for _ in processes]
    assert results.count(job["jobId"]) == 1 and results.count(None) == 1

def test_lease_mutations_reject_wrong_worker_token_revision_and_expiry(tmp_path):
    clock = FrozenClock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request()); claim = jobs.claim(Worker())
    assert claim and "leaseToken" in claim and "leaseExpiresEpoch" in claim
    for worker, token, revision in [(Worker("other"), claim["leaseToken"], claim["revision"]), (Worker(), "x" * 48, claim["revision"]), (Worker(), claim["leaseToken"], claim["revision"] + 1)]:
        with pytest.raises(LeaseError): jobs.renew(worker, job["jobId"], token, revision)
    clock.now += 601
    with pytest.raises(LeaseError): jobs.fail(Worker(), job["jobId"], claim["leaseToken"], claim["revision"], "worker_failure", retryable=True)

def test_curator_views_never_expose_lease_worker_or_token_bookkeeping(tmp_path):
    jobs = service(tmp_path); job = jobs.enqueue(Actor(), request()); jobs.claim(Worker()); public = jobs.get(Actor(), job["jobId"])
    assert public["state"] == "running"
    assert not {"leaseToken", "leaseExpiresAt", "leaseExpiresEpoch", "workerId"} & set(public)

def test_failure_codes_are_allowlisted_sanitized_and_retry_ids_remain_idempotent(tmp_path):
    jobs = service(tmp_path); actor, worker = Actor(), Worker(); job = jobs.enqueue(actor, request()); claim = jobs.claim(worker)
    with pytest.raises(ValidationError): jobs.fail(worker, job["jobId"], claim["leaseToken"], claim["revision"], "/tmp/private TOKEN=abc", retryable=True)
    failed = jobs.fail(worker, job["jobId"], claim["leaseToken"], claim["revision"], "worker_failure", retryable=True)
    assert failed["error"] == {"code": "worker_failure", "message": "The worker could not complete the job.", "retryable": True}
    assert "/tmp" not in json.dumps(failed) and "TOKEN" not in json.dumps(failed)
    one = jobs.retry(actor, job["jobId"], "retry-1")
    claim2 = jobs.claim(worker); failed2 = jobs.fail(worker, job["jobId"], claim2["leaseToken"], claim2["revision"], "temporary_capacity", retryable=True)
    two = jobs.retry(actor, job["jobId"], "retry-2")
    assert two["attempt"] == 3 and jobs.retry(actor, job["jobId"], "retry-1") == two
    assert one["attempt"] == 2 and failed2["error"]["code"] == "temporary_capacity"

def test_completion_requires_real_complete_matching_m4_draft_and_preserves_pointer(tmp_path):
    jobs = service(tmp_path); actor, worker = Actor(), Worker(); corpus = "b" * 64
    job = jobs.enqueue(actor, request(corpusRevision=corpus)); claim = jobs.claim(worker)
    pointer = tmp_path / "drafts" / "published.json"; pointer.parent.mkdir(parents=True); pointer.write_text('{"sentinel":true}')
    packet = valid_draft(tmp_path / "drafts", preset="useful", corpus=corpus)
    completed = jobs.complete(worker, job["jobId"], claim["leaseToken"], claim["revision"], packet["runId"])
    assert completed["state"] == "draft" and completed["runId"] == packet["runId"] and pointer.read_text() == '{"sentinel":true}'

@pytest.mark.parametrize("change", [{"preset": "fine"}, {"params": {"neighbors": 31, "minClusterSize": 15, "minSamples": 5}}, {"corpus": "c" * 64}])
def test_completion_rejects_mismatched_draft_guards_and_symlinks(tmp_path, change):
    jobs = service(tmp_path); job = jobs.enqueue(Actor(), request(corpusRevision="b" * 64)); claim = jobs.claim(Worker())
    packet = valid_draft(tmp_path / "drafts", preset=change.get("preset", "useful"), params=change.get("params"), corpus=change.get("corpus", "b" * 64))
    with pytest.raises(ValidationError): jobs.complete(Worker(), job["jobId"], claim["leaseToken"], claim["revision"], packet["runId"])
    link = tmp_path / "drafts" / "runs" / ("0" * 64); link.symlink_to(tmp_path / "outside")
    with pytest.raises(ValidationError): jobs.complete(Worker(), job["jobId"], claim["leaseToken"], claim["revision"], "0" * 64)

def test_storage_errors_are_structured_retryable_and_never_replace_prior_json(tmp_path, monkeypatch):
    jobs = service(tmp_path); first = jobs.enqueue(Actor(), request()); original = (tmp_path / "control" / "cluster-jobs.json").read_bytes()
    monkeypatch.setattr(jobs, "_replace", lambda source, target: (_ for _ in ()).throw(OSError("/private/path TOKEN=abc")))
    with pytest.raises(StorageError) as caught: jobs.enqueue(Actor("second"), request(requestId="request-2"))
    assert caught.value.status_code == 503 and caught.value.code == "control_store_unavailable" and caught.value.retryable is True
    assert "/private" not in str(caught.value) and "TOKEN" not in str(caught.value)
    assert (tmp_path / "control" / "cluster-jobs.json").read_bytes() == original and jobs.get(Actor(), first["jobId"])["state"] == "queued"

def test_control_root_is_private_even_if_it_already_exists(tmp_path):
    jobs = service(tmp_path); jobs.enqueue(Actor(), request())
    root = tmp_path / "control"; root.chmod(0o755)
    jobs.list(Actor())
    assert root.stat().st_mode & 0o777 == 0o700

@pytest.mark.parametrize("phase", ["open", "flock", "release"])
def test_lock_failures_are_sanitized_storage_errors_without_rewriting(tmp_path, monkeypatch, phase):
    jobs = service(tmp_path); jobs.enqueue(Actor(), request()); store = tmp_path / "control" / "cluster-jobs.json"; before = store.read_bytes()
    if phase == "open":
        monkeypatch.setattr("apricity_analyze.cluster_jobs.os.open", lambda *args: (_ for _ in ()).throw(OSError("/private TOKEN=abc")))
    else:
        from apricity_analyze import cluster_jobs
        calls = []
        def flock(*args):
            calls.append(args[1])
            if phase == "flock" or len(calls) == 2: raise OSError("/private TOKEN=abc")
        monkeypatch.setattr(cluster_jobs.fcntl, "flock", flock)
    with pytest.raises(StorageError) as caught: jobs.list(Actor())
    assert caught.value.code == "control_store_unavailable" and caught.value.retryable is True
    assert "/private" not in str(caught.value) and "TOKEN" not in str(caught.value)
    assert store.read_bytes() == before

def test_corrupt_store_fails_structured_without_rewriting(tmp_path):
    jobs = service(tmp_path); jobs.enqueue(Actor(), request()); store = tmp_path / "control" / "cluster-jobs.json"; store.write_text('{"schemaVersion":1,"jobs":{"bad":{}}}')
    before = store.read_bytes()
    with pytest.raises(StorageError) as caught: jobs.list(Actor())
    assert caught.value.code == "invalid_control_store" and store.read_bytes() == before

@pytest.mark.parametrize("corrupt", [
    '{"schemaVersion":1,"jobs":{"bad":{"state":[]}}}',
    '{"schemaVersion":1,"jobs":{"bad":{"state":"failed","error":[]}}}',
])
def test_corrupt_store_list_values_are_structured_invalid_store_errors(tmp_path, corrupt):
    jobs = service(tmp_path); root = tmp_path / "control"; root.mkdir(parents=True)
    store = root / "cluster-jobs.json"; store.write_text(corrupt); before = store.read_bytes()
    with pytest.raises(StorageError) as caught: jobs.list(Actor())
    assert caught.value.code == "invalid_control_store" and store.read_bytes() == before
