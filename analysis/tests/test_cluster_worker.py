"""Observable ground-worker contract for leased clustering jobs."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import threading

import pytest

from apricity_analyze.audio_clusters import AlgorithmDependencyError, _VERSION_PACKAGES, cluster_snapshot
from apricity_analyze.cluster_jobs import ClusterJobService, StorageError
import apricity_analyze.cluster_worker as cluster_worker
from apricity_analyze.cluster_worker import run_once

SPACE = "clap-htsat-unfused-512-v1"


class Clock:
    def __init__(self): self.now = 1_700_000_000
    def __call__(self): return self.now


class Actor:
    id = "curator"
    is_curator = True


class Worker:
    is_cluster_worker = True
    def __init__(self, identifier="ground-a"): self.id = identifier


def request(**changes):
    value = {"requestId": "worker-request", "embeddingSpace": SPACE, "preset": "fine",
             "params": {"neighbors": 7, "minClusterSize": 4, "minSamples": 2}}
    value.update(changes)
    return value


def corpus():
    return {"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE,
            "processingFingerprint": "process-v1", "records": []}


def catalog(): return {"samples": [], "clips": [], "recordings": [], "analyses": {}}


def vocabulary():
    return json.loads((Path(__file__).parents[2] / "fixtures" / "semantic-audio" / "concept-vocabulary-v1.json").read_text())


def service(tmp_path, clock, *, offline=False):
    return ClusterJobService(tmp_path / "control", tmp_path / "drafts", offline=offline, clock=clock,
                             token_factory=lambda: "a" * 48)


def cluster(snapshot, preset, *, parameters):
    return cluster_snapshot(snapshot, preset, parameters=parameters,
                            versions={name: "test" for name in _VERSION_PACKAGES})


def test_worker_claims_one_job_builds_pending_immutable_draft_with_exact_requested_parameters(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock)
    job = jobs.enqueue(Actor(), request())

    outcome = run_once(jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock, cluster=cluster)

    assert outcome == {"state": "draft", "jobId": job["jobId"]}
    completed = jobs.get(Actor(), job["jobId"])
    assert completed["state"] == "draft"
    manifest = json.loads((tmp_path / "drafts" / "runs" / completed["runId"] / "manifest.json").read_text())
    assert manifest["requestedParams"] == request()["params"]
    assert manifest["qualityReview"] == {"status": "pending"}


def test_idle_or_offline_worker_leaves_queue_untouched(tmp_path):
    clock = Clock(); offline = service(tmp_path, clock, offline=True)
    job = offline.enqueue(Actor(), request())
    assert run_once(offline, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock, cluster=cluster) == {"state": "idle"}
    assert offline.get(Actor(), job["jobId"])["state"] == "queued"


def test_mismatched_requested_corpus_fails_with_existing_safe_error_and_never_fabricates_draft(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock)
    job = jobs.enqueue(Actor(), request(corpusRevision="b" * 64))
    outcome = run_once(jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock, cluster=cluster)
    assert outcome == {"state": "failed", "jobId": job["jobId"], "error": "input_unavailable"}
    assert jobs.get(Actor(), job["jobId"])["error"]["retryable"] is False


def test_missing_algorithm_dependency_is_explicitly_not_evaluated_and_never_success(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request())
    def unavailable(*args, **kwargs): raise AlgorithmDependencyError("not_evaluated: missing hdbscan")
    outcome = run_once(jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock, cluster=unavailable)
    assert outcome == {"state": "not_evaluated", "jobId": job["jobId"], "error": "input_unavailable"}
    assert jobs.get(Actor(), job["jobId"])["state"] == "failed"


def test_changed_corpus_before_completion_is_not_adopted(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request())
    readings = [corpus(), {**corpus(), "processingFingerprint": "changed"}]
    outcome = run_once(jobs, Worker(), lambda: readings.pop(0), catalog, tmp_path / "drafts", vocabulary(), clock=clock, cluster=cluster)
    assert outcome == {"state": "failed", "jobId": job["jobId"], "error": "input_unavailable"}
    assert jobs.get(Actor(), job["jobId"])["state"] == "failed"


def test_heartbeat_renews_the_serialized_lease_while_computation_is_blocked(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); jobs.enqueue(Actor(), request())
    renewed, release = threading.Event(), threading.Event()
    original_renew = jobs.renew

    def renew(*args):
        value = original_renew(*args); renewed.set(); return value
    jobs.renew = renew

    def blocking(snapshot, preset, *, parameters):
        assert renewed.wait(3)
        assert release.wait(3)
        return cluster(snapshot, preset, parameters=parameters)

    thread = threading.Thread(target=lambda: run_once(jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(),
                                                       clock=clock, heartbeat_interval=0.01, cluster=blocking))
    thread.start(); assert renewed.wait(3); release.set(); thread.join(5)
    assert not thread.is_alive()
    assert any(row["state"] == "running" and row["revision"] > 2 for row in jobs.list(Actor())[0]["history"])


def test_reclaimed_lease_prevents_old_worker_from_adopting_or_failing_its_result(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request())
    started, release, result = threading.Event(), threading.Event(), []

    def blocking(snapshot, preset, *, parameters):
        started.set(); assert release.wait(3)
        return cluster(snapshot, preset, parameters=parameters)

    thread = threading.Thread(target=lambda: result.append(run_once(jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(),
                                                                       clock=clock, heartbeat_interval=500, cluster=blocking)))
    thread.start(); assert started.wait(3)
    clock.now += 601
    claimed = jobs.claim(Worker("ground-b"))
    assert claimed and claimed["jobId"] == job["jobId"]
    release.set(); thread.join(5)
    assert result == [{"state": "lost", "jobId": job["jobId"]}]
    assert jobs.get(Actor(), job["jobId"])["state"] == "running"


def test_heartbeat_storage_outage_never_adopts_the_inflight_draft(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request())
    heartbeat_failed, release, result = threading.Event(), threading.Event(), []

    def unavailable(*_args):
        heartbeat_failed.set()
        raise StorageError("control_store_unavailable", retryable=True)
    jobs.renew = unavailable

    def blocking(*_args, **_kwargs):
        assert heartbeat_failed.wait(3)
        assert release.wait(3)
        return cluster(*_args, **_kwargs)

    thread = threading.Thread(target=lambda: result.append(run_once(
        jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock,
        heartbeat_interval=0.01, cluster=blocking)))
    thread.start(); assert heartbeat_failed.wait(3); release.set(); thread.join(3)

    assert not thread.is_alive()
    assert result == [{"state": "unavailable", "jobId": job["jobId"], "error": "temporary_capacity"}]
    assert not (tmp_path / "drafts" / "runs").exists()
    assert jobs.get(Actor(), job["jobId"])["state"] == "running"


def test_blocked_renewal_does_not_block_worker_shutdown_or_mutate_job(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request())
    renew_started, release_renewal, release_work = (threading.Event() for _ in range(3)); result = []

    def blocked_renew(*_args):
        renew_started.set()
        assert release_renewal.wait(3)
        raise StorageError("control_store_unavailable", retryable=True)
    jobs.renew = blocked_renew

    def blocking(*_args, **_kwargs):
        assert renew_started.wait(3)
        assert release_work.wait(3)
        return cluster(*_args, **_kwargs)

    thread = threading.Thread(target=lambda: result.append(run_once(
        jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock,
        heartbeat_interval=0.01, cluster=blocking)))
    thread.start(); assert renew_started.wait(3); release_work.set(); thread.join(2)
    release_renewal.set(); thread.join(3)

    assert not thread.is_alive()
    assert result == [{"state": "unavailable", "jobId": job["jobId"], "error": "temporary_capacity"}]
    assert jobs.get(Actor(), job["jobId"])["state"] == "running"


def test_transient_provider_algorithm_and_save_failures_are_retryable_worker_failures(tmp_path):
    cases = [
        (lambda: (_ for _ in ()).throw(OSError("provider secret=hidden")), cluster, None),
        (corpus, lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("provider secret=hidden")), None),
        (corpus, cluster, lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk secret=hidden"))),
    ]
    for index, (corpus_provider, implementation, save) in enumerate(cases):
        clock = Clock(); jobs = service(tmp_path / str(index), clock); job = jobs.enqueue(Actor(), request())
        kwargs = {"cluster": implementation}
        if save is not None: kwargs["save"] = save
        outcome = run_once(jobs, Worker(), corpus_provider, catalog, tmp_path / str(index) / "drafts", vocabulary(), clock=clock, **kwargs)
        assert outcome == {"state": "failed", "jobId": job["jobId"], "error": "worker_failure"}
        assert jobs.get(Actor(), job["jobId"])["error"] == {"code": "worker_failure", "message": "The worker could not complete the job.", "retryable": True}


def test_failure_recording_and_completion_control_outages_are_safe_and_reclaimable(tmp_path):
    clock = Clock(); jobs = service(tmp_path, clock); job = jobs.enqueue(Actor(), request(corpusRevision="b" * 64))
    jobs.fail = lambda *_args, **_kwargs: (_ for _ in ()).throw(StorageError("control_store_unavailable", retryable=True))
    outcome = run_once(jobs, Worker(), corpus, catalog, tmp_path / "drafts", vocabulary(), clock=clock, cluster=cluster)
    assert outcome == {"state": "unavailable", "jobId": job["jobId"], "error": "temporary_capacity"}
    assert jobs.get(Actor(), job["jobId"])["state"] == "running"


@pytest.mark.parametrize("interruption", (KeyboardInterrupt, SystemExit))
@pytest.mark.parametrize("stage", ("claim", "provider", "compute", "save", "complete", "fail"))
def test_process_cancellation_propagates_and_leaves_the_job_reclaimable(tmp_path, monkeypatch, interruption, stage):
    """Cancellation is never turned into a worker result or durable mutation."""
    clock = Clock(); jobs = service(tmp_path, clock)
    job = jobs.enqueue(Actor(), request(corpusRevision="b" * 64) if stage == "fail" else request())
    created = []
    original_thread = threading.Thread

    def tracked_thread(*args, **kwargs):
        thread = original_thread(*args, **kwargs); created.append(thread); return thread

    monkeypatch.setattr(cluster_worker.threading, "Thread", tracked_thread)
    bomb = lambda *_args, **_kwargs: (_ for _ in ()).throw(interruption())
    kwargs = {"cluster": cluster}
    corpus_provider = corpus
    if stage == "claim":
        monkeypatch.setattr(jobs, "claim", bomb)
    elif stage == "provider":
        corpus_provider = bomb
    elif stage == "compute":
        kwargs["cluster"] = bomb
    elif stage == "save":
        kwargs["save"] = bomb
    elif stage == "complete":
        monkeypatch.setattr(jobs, "complete", bomb)
    else:
        monkeypatch.setattr(jobs, "fail", bomb)

    with pytest.raises(interruption):
        run_once(jobs, Worker(), corpus_provider, catalog, tmp_path / "drafts", vocabulary(), clock=clock, **kwargs)

    assert all(not thread.is_alive() for thread in created)
    current = jobs.get(Actor(), job["jobId"])
    if stage == "claim":
        assert current["state"] == "queued"
    else:
        assert current["state"] == "running"
        assert all(row["state"] not in {"draft", "failed"} for row in current["history"])
        clock.now += 601
        reclaimed = jobs.claim(Worker("ground-b"))
        assert reclaimed and reclaimed["jobId"] == job["jobId"]

    clock = Clock(); jobs = service(tmp_path / "completion", clock); job = jobs.enqueue(Actor(), request())
    jobs.complete = lambda *_args, **_kwargs: (_ for _ in ()).throw(StorageError("control_store_unavailable", retryable=True))
    outcome = run_once(jobs, Worker(), corpus, catalog, tmp_path / "completion" / "drafts", vocabulary(), clock=clock, cluster=cluster)
    assert outcome == {"state": "unavailable", "jobId": job["jobId"], "error": "temporary_capacity"}
    assert jobs.get(Actor(), job["jobId"])["state"] == "running"
