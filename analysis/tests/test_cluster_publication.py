"""M5 explicit atomic publication and label-override scenarios.

Feature: Explicit atomic cluster-manifest publication
  Scenario: A curator reviews, labels, and atomically publishes an accepted draft
    Given an immutable M4 draft and a server-trusted curator context
    When the curator approves current representative evidence and wins both CAS checks
    Then the preset pointer and review audit change together without rewriting the draft

  Scenario: A label override changes the reviewable control surface
    Given an approved review
    When a curator overrides an existing cluster label
    Then that review is invalidated and a fresh explicit review is required
"""
from __future__ import annotations

import multiprocessing
from types import SimpleNamespace

import pytest

import apricity_analyze.cluster_publication as publication
from apricity_analyze.cluster_publication import (ClusterPublicationRegistry, ConflictError,
                                                   ForbiddenError, StorageError, UnavailableError, ValidationError)
from apricity_analyze.cluster_runs import prepare_run, save_draft_run
from test_cluster_runs import packets, representative, suggested_label, vector


CURATOR = SimpleNamespace(id="curator-1", is_curator=True)
GUEST = SimpleNamespace(id="guest", is_curator=False)


def _simultaneous_publish(control_root, runs_root, digest, run_id, run_revision, gate, results):
    service = ClusterPublicationRegistry(control_root, runs_root, current_corpus_digest=lambda: digest, enabled=True)
    gate.wait(5)
    try:
        service.publish(CURATOR, run_id, expected_run_revision=run_revision, expected_pointer_revision=None)
        results.put("published")
    except ConflictError:
        results.put("conflict")


def registry(tmp_path, *, clustered=False, preset="fine", enabled=True, clock=None):
    snapshot, result, summaries = packets()
    result["preset"] = summaries["preset"] = preset
    if clustered:
        result["members"][0]["clusterLabel"] = 2; result["outliers"] = []
        summaries["members"][0]["clusterId"] = 2; summaries["outliers"] = []
        summaries["clusters"] = [{"clusterId": 2, "centroid": vector(0),
                                  "representatives": [representative()], "suggestedLabel": suggested_label()}]
    packet = prepare_run(snapshot, result, summaries, "2026-10-01T00:00:00Z")
    save_draft_run(tmp_path / "drafts", packet)
    service = ClusterPublicationRegistry(tmp_path / "controls", tmp_path / "drafts", current_corpus_digest=lambda: packet["corpusDigest"], enabled=enabled, clock=clock)
    return service, packet


def approve(service, packet, *, ids=None):
    control = service.initialize(CURATOR, packet["runId"])
    return service.review(CURATOR, packet["runId"], ids or ["a"], "explicit curator review", expected_run_revision=control["runRevision"])


def test_gherkin_guest_private_access_is_denied_without_writes(tmp_path):
    service, packet = registry(tmp_path)
    for action in (
        lambda: service.initialize(GUEST, packet["runId"]),
        lambda: service.get(GUEST, packet["runId"]),
        lambda: service.override(GUEST, packet["runId"], "bad", "x", expected_run_revision=1),
        lambda: service.review(GUEST, packet["runId"], ["a"], "notes", expected_run_revision=1),
        lambda: service.publish(GUEST, packet["runId"], expected_run_revision=1, expected_pointer_revision=None),
    ):
        with pytest.raises(ForbiddenError): action()
    assert not (tmp_path / "controls").exists()


def test_gherkin_explicit_review_override_invalidation_and_atomic_publication(tmp_path):
    service, packet = registry(tmp_path, clustered=True)
    control = service.initialize(CURATOR, packet["runId"])
    reviewed = service.review(CURATOR, packet["runId"], ["a"], "looked at the representative", expected_run_revision=control["runRevision"])
    cluster_id = packet["clusters"][0]["clusterId"]
    changed = service.override(CURATOR, packet["runId"], cluster_id, "deliberate label", expected_run_revision=reviewed["runRevision"])
    assert changed["review"] is None
    with pytest.raises(ConflictError): service.publish(CURATOR, packet["runId"], expected_run_revision=changed["runRevision"], expected_pointer_revision=None)
    reviewed = service.review(CURATOR, packet["runId"], ["a"], "reviewed again after deliberate control change", expected_run_revision=changed["runRevision"])
    published = service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    assert published["state"] == "published" and published["manifest"]["state"] == "draft"
    assert published["manifest"]["members"][0]["x"] == 1.0 and published["manifest"]["members"][0]["y"] == 2.0


def test_rejects_unknown_bounds_and_stale_revisions(tmp_path):
    service, packet = registry(tmp_path); control = service.initialize(CURATOR, packet["runId"])
    with pytest.raises(ValidationError): service.override(CURATOR, packet["runId"], "bad", "x", expected_run_revision=1)
    with pytest.raises(ValidationError): service.override(CURATOR, packet["runId"], "x", " " * 121, expected_run_revision=1)
    reviewed = service.review(CURATOR, packet["runId"], ["a"], "enough", expected_run_revision=1)
    assert reviewed["runRevision"] == reviewed["review"]["runRevision"] == 2
    with pytest.raises(ConflictError): service.review(CURATOR, packet["runId"], ["a"], "stale", expected_run_revision=1)


def test_current_corpus_and_pointer_cas_protect_old_publication(tmp_path):
    service, packet = registry(tmp_path); reviewed = approve(service, packet)
    service.current_corpus_digest = lambda: "0" * 64
    with pytest.raises(ConflictError): service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    service.current_corpus_digest = lambda: packet["corpusDigest"]
    service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    with pytest.raises(ConflictError): service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=1)


def test_publication_never_rewrites_immutable_draft_and_global_gate_is_not_curator_control(tmp_path):
    service, packet = registry(tmp_path); manifest = tmp_path / "drafts" / "runs" / packet["runId"] / "manifest.json"
    before = manifest.read_bytes(); reviewed = approve(service, packet)
    service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    assert service.published_manifest(packet["runId"])["reviewAudit"]["runRevision"] == reviewed["runRevision"]
    assert manifest.read_bytes() == before
    disabled, disabled_packet = registry(tmp_path / "disabled", enabled=False)
    reviewed = approve(disabled, disabled_packet)
    with pytest.raises(ForbiddenError): disabled.publish(CURATOR, disabled_packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    with pytest.raises(TypeError): disabled.initialize(CURATOR, disabled_packet["runId"], enabled=True)


def test_genuine_multiprocess_publish_cas_allows_exactly_one_winner(tmp_path):
    service, packet = registry(tmp_path); reviewed = approve(service, packet)
    context = multiprocessing.get_context("fork")
    gate, results = context.Event(), context.Queue()
    processes = [context.Process(target=_simultaneous_publish, args=(str(tmp_path / "controls"), str(tmp_path / "drafts"),
                 packet["corpusDigest"], packet["runId"], reviewed["runRevision"], gate, results)) for _ in range(2)]
    for process in processes: process.start()
    gate.set()
    for process in processes:
        process.join(5)
        assert process.exitcode == 0
    assert sorted(results.get(timeout=1) for _ in processes) == ["conflict", "published"]
    stored = service.published_manifest(packet["runId"])
    assert stored["reviewAudit"]["runRevision"] == reviewed["runRevision"]
    assert service.published_manifest(preset="fine")["reviewAudit"] == stored["reviewAudit"]


def test_alias_representative_is_a_valid_review_target_and_coverage_is_exact(tmp_path):
    snapshot, result, summaries = packets()
    alias = {**snapshot["regions"][0]["aliases"][0]}
    alias["semanticId"] = "alias-a"; alias["semanticIdentity"] = {**alias["semanticIdentity"], "semanticId": "alias-a"}
    snapshot["regions"][0]["aliases"].append(alias)
    result["members"][0]["aliases"] = snapshot["regions"][0]["aliases"]
    result["members"][0]["clusterLabel"] = 2; result["outliers"] = []
    summaries["members"][0].update(aliases=["a", "alias-a"], clusterId=2); summaries["outliers"] = []
    rep = representative(); rep["semanticId"] = "alias-a"
    summaries["clusters"] = [{"clusterId": 2, "centroid": vector(0), "representatives": [rep], "suggestedLabel": suggested_label()}]
    packet = prepare_run(snapshot, result, summaries, "2026-10-01T00:00:00Z")
    save_draft_run(tmp_path / "drafts", packet)
    service = ClusterPublicationRegistry(tmp_path / "controls", tmp_path / "drafts", current_corpus_digest=lambda: packet["corpusDigest"], enabled=True)
    control = service.initialize(CURATOR, packet["runId"])
    with pytest.raises(ValidationError): service.review(CURATOR, packet["runId"], ["a"], "missing exact representative", expected_run_revision=1)
    reviewed = service.review(CURATOR, packet["runId"], ["a", "alias-a"], "reviewed accepted alias representative", expected_run_revision=control["runRevision"])
    assert reviewed["review"]["reviewedSemanticIds"] == ["a", "alias-a"]


@pytest.mark.parametrize("bad", [None, True, "x" * 63, "A" * 64, "0" * 65])
def test_invalid_run_ids_and_request_shapes_create_no_controls(tmp_path, bad):
    service, _packet = registry(tmp_path)
    with pytest.raises(ValidationError): service.initialize(CURATOR, bad)
    assert not (tmp_path / "controls").exists()


@pytest.mark.parametrize("value", [None, True, 0, "1", ["a"], {"value": 1}])
def test_revision_fields_reject_null_boolean_and_non_integer_values(tmp_path, value):
    service, packet = registry(tmp_path); service.initialize(CURATOR, packet["runId"])
    with pytest.raises(ValidationError): service.review(CURATOR, packet["runId"], ["a"], "notes", expected_run_revision=value)


def test_prior_run_remains_addressable_after_pointer_advances(tmp_path):
    first, one = registry(tmp_path, preset="fine"); first_review = approve(first, one)
    first.publish(CURATOR, one["runId"], expected_run_revision=first_review["runRevision"], expected_pointer_revision=None)
    second, two = registry(tmp_path, preset="useful"); second_review = approve(second, two)
    second.publish(CURATOR, two["runId"], expected_run_revision=second_review["runRevision"], expected_pointer_revision=1)
    assert first.published_manifest(one["runId"])["runId"] == one["runId"]
    assert second.published_manifest(preset="useful")["runId"] == two["runId"]
    assert {item["runId"] for item in second.list_published_manifests()} == {one["runId"], two["runId"]}


def test_unapproved_or_missing_drafts_are_never_returned_as_published(tmp_path):
    service, packet = registry(tmp_path)
    with pytest.raises(ValidationError): service.published_manifest(packet["runId"])
    with pytest.raises(ValidationError): service.published_manifest("0" * 64)
    assert service.list_published_manifests() == []


def test_disabled_published_reads_are_unavailable_without_storage_or_data_leakage(tmp_path, monkeypatch):
    enabled, packet = registry(tmp_path)
    reviewed = approve(enabled, packet)
    enabled.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    disabled = ClusterPublicationRegistry(tmp_path / "controls", tmp_path / "drafts",
                                          current_corpus_digest=lambda: packet["corpusDigest"], enabled=False)
    monkeypatch.setattr(disabled, "_locked", lambda: (_ for _ in ()).throw(AssertionError("disabled read used storage")))
    for lookup in (
        lambda: disabled.published_manifest(packet["runId"]),
        lambda: disabled.publishedManifest(preset="fine"),
        lambda: disabled.lookup(packet["runId"]),
    ):
        with pytest.raises(UnavailableError) as error: lookup()
        assert error.value.status_code == 503 and error.value.retryable is False
    for listing in (disabled.list_published_manifests, disabled.listPublishedManifests, disabled.list):
        with pytest.raises(UnavailableError) as error: listing()
        assert error.value.status_code == 503 and error.value.retryable is False


def test_disabled_published_reads_do_not_create_a_missing_control_root(tmp_path):
    service, packet = registry(tmp_path, enabled=False)
    assert not (tmp_path / "controls").exists()
    for action in (
        lambda: service.published_manifest(packet["runId"]),
        lambda: service.publishedManifest(preset="fine"),
        lambda: service.lookup(packet["runId"]),
        service.list_published_manifests,
        service.listPublishedManifests,
        service.list,
    ):
        with pytest.raises(UnavailableError): action()
    assert not (tmp_path / "controls").exists()


def test_published_run_rejects_mutation_instead_of_replacing_its_audit(tmp_path):
    service, packet = registry(tmp_path, clustered=True)
    reviewed = approve(service, packet)
    service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"], expected_pointer_revision=None)
    before = service.published_manifest(packet["runId"])["reviewAudit"]
    with pytest.raises(ConflictError): service.review(CURATOR, packet["runId"], ["a"], "another review", expected_run_revision=reviewed["runRevision"])
    with pytest.raises(ConflictError): service.override(CURATOR, packet["runId"], packet["clusters"][0]["clusterId"], "new label", expected_run_revision=reviewed["runRevision"])
    assert service.published_manifest(packet["runId"])["reviewAudit"] == before


def test_clock_permissions_and_storage_failures_are_sanitized(tmp_path, monkeypatch):
    service, packet = registry(tmp_path, clock=lambda: "2026-10-01T00:00:00Z")
    control = service.initialize(CURATOR, packet["runId"])
    assert control["createdAt"] == "2026-10-01T00:00:00Z"
    assert (tmp_path / "controls").stat().st_mode & 0o777 == 0o700
    assert (tmp_path / "controls" / "cluster-publication.json").stat().st_mode & 0o777 == 0o600
    monkeypatch.setattr(service, "_replace", lambda *_args: (_ for _ in ()).throw(OSError("interrupted")))
    with pytest.raises(StorageError): service.review(CURATOR, packet["runId"], ["a"], "notes", expected_run_revision=1)
    assert service.get(CURATOR, packet["runId"])["review"] is None


def test_corrupt_store_and_unsafe_draft_are_structured_errors(tmp_path):
    service, packet = registry(tmp_path); service.initialize(CURATOR, packet["runId"])
    service.path.write_text('{"schemaVersion":1,"pointerRevision":0,"controls":{"' + packet["runId"] + '":[]},"published":{},"pointers":{}}')
    with pytest.raises(ValidationError): service.get(CURATOR, packet["runId"])
    unsafe, unsafe_packet = registry(tmp_path / "unsafe")
    manifest = tmp_path / "unsafe" / "drafts" / "runs" / unsafe_packet["runId"] / "manifest.json"
    manifest.unlink(); manifest.symlink_to(tmp_path / "elsewhere")
    with pytest.raises(ValidationError): unsafe.initialize(CURATOR, unsafe_packet["runId"])


@pytest.mark.parametrize("failure", ["open", "lock", "read"])
def test_lock_open_and_read_failures_are_sanitized_and_retryable(tmp_path, monkeypatch, failure):
    service, packet = registry(tmp_path); service.initialize(CURATOR, packet["runId"])
    if failure == "open":
        monkeypatch.setattr(publication.os, "open", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("no lock")))
    elif failure == "lock":
        monkeypatch.setattr(publication.fcntl, "flock", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("no flock")))
    else:
        original = publication.Path.read_text
        monkeypatch.setattr(publication.Path, "read_text", lambda path, **kwargs: (_ for _ in ()).throw(OSError("no read")) if path == service.path else original(path, **kwargs))
    with pytest.raises(StorageError) as error: service.get(CURATOR, packet["runId"])
    assert error.value.retryable is True
