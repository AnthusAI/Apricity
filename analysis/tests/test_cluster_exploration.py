"""Public projections only admit current, reviewed published cluster data.

Feature: Published cluster exploration
  Scenario: Disabled exploration does not read trusted providers
    Given a disabled public exploration service
    When a caller requests a leaderboard
    Then it receives a retryable unavailable error and no provider is called

  Scenario: A published run is projected through the current visible corpus
    Given a genuinely prepared, reviewed, and published run
    When a caller requests its leaderboard, detail, and map
    Then each response contains current safe cards but no vectors or audit data
"""
from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest

from apricity_analyze.cluster_exploration import (ClusterExploration, ExplorationBadRequest,
                                                  ExplorationNotFound, ExplorationStorageUnavailable, ExplorationUnavailable)
from apricity_analyze.cluster_corpus import build_cluster_snapshot
from apricity_analyze.cluster_publication import ClusterPublicationRegistry
from apricity_analyze.cluster_runs import prepare_run, save_draft_run
from test_cluster_corpus import FINGERPRINT, SPACE, catalog, record, vector, window_record


CURATOR = SimpleNamespace(id="curator-1", is_curator=True)


def _mutable_catalog(loaded):
    """Convert the shared loaded fixture back to accepted raw catalog input."""
    return {"samples": copy.deepcopy(list(loaded["samples"])),
            "recordings": copy.deepcopy(list(loaded["recordings"].values())),
            "clips": copy.deepcopy(list(loaded["clips"])), "analyses": copy.deepcopy(loaded["analyses"])}


def _published_service(tmp_path):
    current_catalog = catalog()
    current_catalog["samples"][0]["title"] = "Current A"
    current_catalog["samples"][1]["title"] = "Current B"
    current_catalog["clips"][0]["name"] = "Current clip"
    current_catalog["clips"][1]["name"] = "Current B clip"
    current_records = [record(), record("smp_B", clip_id="clp_b1")]
    snapshot = build_cluster_snapshot(current_records, current_catalog, embedding_space=SPACE,
                                      processing_fingerprint=FINGERPRINT, visibility=lambda *_: True)
    region, alias = snapshot["regions"][0], snapshot["regions"][0]["aliases"][0]
    identity = alias["semanticIdentity"]
    result = {"schemaVersion": "apricity.clustering-result/1",
              "corpus": {"schemaVersion": "apricity.cluster-corpus/1", "digest": snapshot["corpusDigest"], "regionCount": 1},
              "model": {"embeddingSpace": SPACE, "processingFingerprint": FINGERPRINT}, "preset": "fine",
              "requestedParams": {"neighbors": 15, "minClusterSize": 5, "minSamples": 3},
              "effectiveParams": {"neighbors": None, "dimensions": None, "minClusterSize": None, "minSamples": None},
              "algorithmVersions": {"fixture": "1"}, "seed": 42,
              "members": [{"semanticId": region["semanticId"], "aliases": region["aliases"], "clusterLabel": 2,
                           "membership": 0.9, "x": 1.0, "y": 2.0}], "outliers": []}
    representative = {key: identity[key] for key in ("semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint")}
    representative.update(fileKey="A.wav", sampleTitle="Current A", clipName="clip")
    summaries = {"schemaVersion": "apricity.cluster-summaries/1", "corpus": copy.deepcopy(result["corpus"]),
                 "model": copy.deepcopy(result["model"]), "preset": "fine", "requestedParams": copy.deepcopy(result["requestedParams"]),
                 "effectiveParams": copy.deepcopy(result["effectiveParams"]), "algorithmVersions": {"fixture": "1"}, "seed": 42,
                 "clusters": [{"clusterId": 2, "centroid": vector(0), "representatives": [representative],
                               "suggestedLabel": {"label": "suggested", "method": "fixture", "approved": False,
                                                  "vocabularyVersion": "fixture", "provenance": {}, "conceptScores": []}}],
                 "members": [{"semanticId": region["semanticId"], "aliases": [row["semanticId"] for row in region["aliases"]], "clusterId": 2,
                              "membership": 0.9, "x": 1.0, "y": 2.0}], "outliers": [], "qualityReview": {"status": "pending"}}
    packet = prepare_run(snapshot, result, summaries, "2026-10-01T00:00:00Z")
    save_draft_run(tmp_path / "drafts", packet)
    registry = ClusterPublicationRegistry(tmp_path / "controls", tmp_path / "drafts",
                                          current_corpus_digest=lambda: packet["corpusDigest"], enabled=True)
    control = registry.initialize(CURATOR, packet["runId"])
    changed = registry.override(CURATOR, packet["runId"], packet["clusters"][0]["clusterId"], "Reviewed label",
                                expected_run_revision=control["runRevision"])
    reviewed = registry.review(CURATOR, packet["runId"], [region["semanticId"]], "reviewed representative",
                               expected_run_revision=changed["runRevision"])
    registry.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"],
                     expected_pointer_revision=None)
    return registry, packet, {"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE,
                              "processingFingerprint": FINGERPRINT, "records": current_records}, current_catalog


def _packet(snapshot, source_catalog, labels):
    """Make a genuine draft packet from a current snapshot, not a projection mock."""
    by_sample = {row["id"]: row for row in source_catalog["samples"]}
    by_clip = {row["id"]: row for row in source_catalog["clips"]}
    members, summary_members, outliers, clusters = [], [], [], {}
    for index, region in enumerate(snapshot["regions"]):
        label = labels.get(region["semanticId"])
        member = {"semanticId": region["semanticId"], "aliases": copy.deepcopy(region["aliases"]),
                  "clusterLabel": label, "membership": 0.9, "x": float(index), "y": float(-index)}
        members.append(member)
        summary_members.append({key: copy.deepcopy(member[key]) for key in ("semanticId", "membership", "x", "y")}
                               | {"aliases": [row["semanticId"] for row in region["aliases"]], "clusterId": label})
        if label is None:
            outliers.append(region["semanticId"])
            continue
        clusters.setdefault(label, []).append(region)
    result = {"schemaVersion": "apricity.clustering-result/1",
              "corpus": {"schemaVersion": "apricity.cluster-corpus/1", "digest": snapshot["corpusDigest"], "regionCount": len(members)},
              "model": {"embeddingSpace": SPACE, "processingFingerprint": FINGERPRINT}, "preset": "fine",
              "requestedParams": {"neighbors": 15, "minClusterSize": 5, "minSamples": 3},
              "effectiveParams": {"neighbors": None, "dimensions": None, "minClusterSize": None, "minSamples": None},
              "algorithmVersions": {"fixture": "1"}, "seed": 42, "members": members, "outliers": outliers}
    summary_clusters = []
    for label, grouped in sorted(clusters.items()):
        identity = grouped[0]["aliases"][0]["semanticIdentity"]
        sample, clip = by_sample[identity["sampleId"]], by_clip[identity["clipId"]]
        representative = {key: identity[key] for key in ("semanticId", "sampleId", "recordingId", "kind", "clipId", "start", "end", "audioSha256", "embeddingSpace", "processingFingerprint")}
        representative.update(fileKey=sample["audio"]["key"], sampleTitle=sample["title"], clipName=clip["name"])
        summary_clusters.append({"clusterId": label, "centroid": vector(0), "representatives": [representative],
                                 "suggestedLabel": {"label": f"cluster {label}", "method": "fixture", "approved": False,
                                                    "vocabularyVersion": "fixture", "provenance": {}, "conceptScores": []}})
    summaries = {"schemaVersion": "apricity.cluster-summaries/1", **{key: copy.deepcopy(result[key]) for key in ("corpus", "model", "preset", "requestedParams", "effectiveParams", "algorithmVersions", "seed")},
                 "clusters": summary_clusters, "members": summary_members,
                 "outliers": [{"semanticId": row["semanticId"], "aliases": row["aliases"]} for row in summary_members if row["clusterId"] is None],
                 "qualityReview": {"status": "pending"}}
    return prepare_run(snapshot, result, summaries, "2026-10-01T00:00:00Z")


def _pipeline_service(tmp_path, records, source_catalog, labels, *, ratings=lambda: {}, visibility=lambda *_: True):
    """Publish a fixture, then independently re-read the current semantic corpus."""
    current_catalog = copy.deepcopy(source_catalog)
    for sample in current_catalog["samples"]:
        sample.setdefault("title", sample["id"])
    for clip in current_catalog["clips"]:
        clip.setdefault("name", clip["id"])
    snapshot = build_cluster_snapshot(records, current_catalog, embedding_space=SPACE,
                                      processing_fingerprint=FINGERPRINT, visibility=lambda *_: True)
    packet = _packet(snapshot, current_catalog, labels)
    save_draft_run(tmp_path / "drafts", packet)
    registry = ClusterPublicationRegistry(tmp_path / "controls", tmp_path / "drafts",
                                          current_corpus_digest=lambda: packet["corpusDigest"], enabled=True)
    control = registry.initialize(CURATOR, packet["runId"])
    for cluster in packet["clusters"]:
        control = registry.override(CURATOR, packet["runId"], cluster["clusterId"], "Approved",
                                    expected_run_revision=control["runRevision"])
    representatives = [row["semanticId"] for cluster in packet["clusters"] for row in cluster["representatives"]]
    control = registry.review(CURATOR, packet["runId"], representatives, "complete review",
                              expected_run_revision=control["runRevision"])
    registry.publish(CURATOR, packet["runId"], expected_run_revision=control["runRevision"], expected_pointer_revision=None)
    envelope = {"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE,
                "processingFingerprint": FINGERPRINT, "records": copy.deepcopy(records)}
    service = ClusterExploration(registry, lambda: copy.deepcopy(envelope), lambda: copy.deepcopy(current_catalog),
                                 visibility=visibility, ratings=ratings, enabled=True)
    return service, registry, packet, envelope, current_catalog


def test_disabled_service_returns_503_before_any_provider_call(tmp_path):
    registry, _packet, _corpus, _catalog = _published_service(tmp_path)
    calls = []
    service = ClusterExploration(registry, lambda: calls.append("corpus"), lambda: calls.append("catalog"),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=False)

    with pytest.raises(ExplorationUnavailable) as error:
        service.leaderboard()

    assert error.value.status_code == 503 and error.value.retryable is False
    assert calls == []


def test_disabled_service_blocks_every_operation_before_registry_or_current_providers():
    class Registry:
        def __init__(self):
            self.calls = 0

        def published_manifest(self, *args, **kwargs):
            self.calls += 1
            raise AssertionError("disabled reads must not reach the registry")

    registry, calls = Registry(), []
    service = ClusterExploration(registry, lambda: calls.append("corpus"), lambda: calls.append("catalog"),
                                 visibility=lambda *_: True, ratings=lambda: calls.append("ratings"), enabled=False)
    for operation in (lambda: service.leaderboard(), lambda: service.detail("cluster"), lambda: service.map(), lambda: service.list_members()):
        with pytest.raises(ExplorationUnavailable) as error:
            operation()
        assert error.value.status_code == 503
    assert registry.calls == 0 and calls == []


def test_current_visible_projection_has_only_safe_cards_order_and_no_audit_or_vectors(tmp_path):
    registry, packet, corpus, current_catalog = _published_service(tmp_path)
    service = ClusterExploration(registry, lambda: copy.deepcopy(corpus), lambda: copy.deepcopy(current_catalog),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=True)

    board = service.leaderboard(packet["runId"])
    cluster = board["clusters"][0]
    detail = service.detail(cluster["clusterId"], packet["runId"])
    mapped = service.map(packet["runId"], limit=1)

    assert cluster["curatedLabel"] == "Reviewed label" and cluster["suggestedLabel"] == "suggested"
    assert cluster["distinctSampleCount"] == cluster["savedClipCount"] == 2
    assert detail["representatives"][0]["playback"]["fileKey"] in {"A.wav", "B.wav"}
    assert "vector" not in repr((board, detail, mapped)) and "reviewAudit" not in repr((board, detail, mapped))
    assert mapped["displayedCount"] == mapped["totalVisibleCount"] == 1 and mapped["truncated"] is False


def test_request_validation_happens_before_registry_or_current_providers(tmp_path):
    registry, _packet, _corpus, _catalog = _published_service(tmp_path)
    calls = []
    service = ClusterExploration(registry, lambda: calls.append("corpus"), lambda: calls.append("catalog"),
                                 visibility=lambda *_: True, ratings=lambda: calls.append("ratings"), enabled=True)

    for request in (
        lambda: service.leaderboard("../invalid"),
        lambda: service.leaderboard(order="wrong"),
        lambda: service.detail("", order="wrong"),
        lambda: service.map(limit=10_001),
    ):
        with pytest.raises(ExplorationBadRequest) as error:
            request()
        assert error.value.status_code == 400
    assert calls == []


def test_bookmark_accepts_matching_run_and_preset_but_rejects_mismatch(tmp_path):
    registry, packet, corpus, current_catalog = _published_service(tmp_path)
    service = ClusterExploration(registry, lambda: copy.deepcopy(corpus), lambda: copy.deepcopy(current_catalog),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=True)

    assert service.leaderboard(packet["runId"], preset="fine")["runId"] == packet["runId"]
    with pytest.raises(ExplorationBadRequest):
        service.leaderboard(packet["runId"], preset="useful")


def test_publication_audit_must_be_approved_current_and_cover_representatives(tmp_path):
    registry, packet, corpus, current_catalog = _published_service(tmp_path)

    class CorruptAuditRegistry:
        def published_manifest(self, *args, **kwargs):
            envelope = registry.published_manifest(*args, **kwargs)
            envelope["reviewAudit"]["review"].update(status="pending", runRevision=999, reviewedSemanticIds=[])
            return envelope

    service = ClusterExploration(CorruptAuditRegistry(), lambda: copy.deepcopy(corpus), lambda: copy.deepcopy(current_catalog),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=True)
    with pytest.raises(ExplorationStorageUnavailable) as error:
        service.leaderboard(packet["runId"])
    assert error.value.status_code == 503


def test_rating_members_use_json_safe_null_after_finite_scores_and_cards_link_to_parents(tmp_path):
    registry, packet, corpus, current_catalog = _published_service(tmp_path)
    service = ClusterExploration(registry, lambda: copy.deepcopy(corpus), lambda: copy.deepcopy(current_catalog),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=True)

    cluster_id = service.leaderboard(packet["runId"])["clusters"][0]["clusterId"]
    detail = service.detail(cluster_id, packet["runId"], order="rating")

    assert [member["score"] for member in detail["members"]] == [None]
    assert json.dumps(detail, allow_nan=False)
    assert detail["representatives"][0]["parentLink"] in {"/samples/A", "/samples/B"}


def test_unrelated_current_corpus_additions_do_not_hide_an_explicit_old_run(tmp_path):
    registry, packet, corpus, current_catalog = _published_service(tmp_path)
    current = copy.deepcopy(corpus)
    current["records"].append(record("smp_C", clip_id="clp_c1", start=1, end=5, vector512=vector(1)))
    service = ClusterExploration(registry, lambda: copy.deepcopy(current), lambda: copy.deepcopy(current_catalog),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=True)

    board = service.leaderboard(packet["runId"])

    assert board["runId"] == packet["runId"] and board["clusters"][0]["distinctSampleCount"] == 2


def test_actual_over_ten_thousand_member_map_caps_while_list_remains_complete(tmp_path, monkeypatch):
    registry, packet, corpus, current_catalog = _published_service(tmp_path)
    service = ClusterExploration(registry, lambda: copy.deepcopy(corpus), lambda: copy.deepcopy(current_catalog),
                                 visibility=lambda *_: True, ratings=lambda: {}, enabled=True)
    card = {"semanticId": "safe", "sampleId": "sample", "recordingId": "recording", "kind": "window",
            "start": 0.0, "end": 1.0, "sampleTitle": "safe", "parentLink": "/samples/safe", "link": "/samples/safe",
            "playback": {"fileKey": "safe.wav", "start": 0.0, "end": 1.0}}
    regions = [{"semanticId": f"{index:064x}", "clusterId": None, "membership": 0.0,
                "x": float(index), "y": 0.0, "aliases": [{**card, "semanticId": f"{index:064x}"}]}
               for index in range(10_001)]
    monkeypatch.setattr(service, "_members", lambda _public: (packet, regions))

    mapped, listed = service.map(packet["runId"]), service.list_members(packet["runId"])

    assert mapped["displayedCount"] == 10_000 and mapped["totalVisibleCount"] == 10_001 and mapped["truncated"] is True
    assert len(listed["members"]) == listed["totalVisibleCount"] == 10_001
    assert json.dumps((mapped, listed), allow_nan=False)


@pytest.mark.parametrize("change, reason", [
    (lambda data: data["samples"][0].update(retired=True), "retired_sample"),
    (lambda data: data.update(clips=[]), "missing_clip"),
    (lambda data: data["clips"][0].update(end=3), "current_boundary_mismatch"),
    (lambda data: data["samples"][0]["audio"].update(sha256="b" * 64), "current_audio_mismatch"),
])
def test_published_pipeline_filters_each_current_parent_negative_with_exact_zero_counts(tmp_path, change, reason):
    accepted = record()
    initial = catalog()
    source = build_cluster_snapshot([accepted], initial, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    service, _registry, packet, envelope, current_catalog = _pipeline_service(
        tmp_path, [accepted], initial, {source["regions"][0]["semanticId"]: 2})
    changed = _mutable_catalog(current_catalog)
    change(changed)
    service.catalog_provider = lambda: copy.deepcopy(changed)

    assert build_cluster_snapshot(envelope["records"], changed, embedding_space=SPACE,
                                  processing_fingerprint=FINGERPRINT, visibility=lambda *_: True)["excluded"] == [
        {"reason": reason, "semanticId": accepted["identity"]["semanticId"]}]
    assert service.leaderboard(packet["runId"])["clusters"] == []
    assert service.map(packet["runId"]) == {"runId": packet["runId"], "displayedCount": 0,
                                              "totalVisibleCount": 0, "truncated": False, "points": []}
    assert service.list_members(packet["runId"])["totalVisibleCount"] == 0


def test_hidden_grid_and_wrong_model_records_are_independently_filtered_from_published_projection(tmp_path):
    accepted, off_grid, wrong_model = record(), window_record(start=1, end=5), record(space="other-model")
    initial = catalog()
    # The grid record has a valid identity but is not a current beat-grid window.
    labels = {build_cluster_snapshot([accepted], initial, embedding_space=SPACE,
                                     processing_fingerprint=FINGERPRINT)["regions"][0]["semanticId"]: 2}
    hidden, _registry, packet, _envelope, _current = _pipeline_service(tmp_path / "hidden", [accepted], initial, labels,
                                                                         visibility=lambda *_: (False, "hidden_by_policy"))
    assert hidden.leaderboard(packet["runId"])["clusters"] == []

    visible, _registry, packet, envelope, current = _pipeline_service(tmp_path / "other", [accepted], initial, labels)
    visible.corpus_provider = lambda: {**copy.deepcopy(envelope), "records": [accepted, off_grid, wrong_model]}
    snapshot = build_cluster_snapshot([accepted, off_grid, wrong_model], current, embedding_space=SPACE,
                                      processing_fingerprint=FINGERPRINT, visibility=lambda *_: True)
    assert snapshot["coverage"] == {"records": 1, "regions": 1, "excluded": 2}
    assert {row["reason"] for row in snapshot["excluded"]} == {"window_outside_current_grid", "incompatible_embedding_space"}
    assert visible.leaderboard(packet["runId"])["clusters"][0]["distinctSampleCount"] == 1


@pytest.mark.parametrize("mutate", [
    lambda envelope: envelope["reviewAudit"]["review"].update(status="pending"),
    lambda envelope: envelope["reviewAudit"]["review"].update(runRevision=99),
    lambda envelope: envelope["reviewAudit"]["review"].update(reviewedSemanticIds=[]),
    lambda envelope: envelope["reviewAudit"]["review"].update(reviewedSemanticIds=[{}]),
])
def test_each_published_audit_guard_rejects_status_revision_or_representative_coverage(tmp_path, mutate):
    accepted, initial = record(), catalog()
    snapshot = build_cluster_snapshot([accepted], initial, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    service, registry, packet, envelope, current = _pipeline_service(tmp_path, [accepted], initial,
                                                                       {snapshot["regions"][0]["semanticId"]: 2})

    class BadAudit:
        def published_manifest(self, *args, **kwargs):
            value = registry.published_manifest(*args, **kwargs)
            mutate(value)
            return value

    rejected = ClusterExploration(BadAudit(), lambda: copy.deepcopy(envelope), lambda: copy.deepcopy(current),
                                  visibility=lambda *_: True, ratings=lambda: {}, enabled=True)
    with pytest.raises(ExplorationStorageUnavailable) as error:
        rejected.leaderboard(packet["runId"])
    assert error.value.status_code == 503
    assert service.leaderboard(packet["runId"])["clusters"][0]["clusterId"] == packet["clusters"][0]["clusterId"]


def test_detail_sorts_similarity_and_ratings_stably_after_reviewed_representative_and_keeps_outliers(tmp_path):
    base = _mutable_catalog(catalog())
    base["clips"].extend([{ "id": "clp_a2", "sampleId": "smp_A", "start": 4, "end": 8},
                          {"id": "clp_c2", "sampleId": "smp_C", "start": 4, "end": 8}])
    first, alias, other = record(), record("smp_B", clip_id="clp_b1"), record("smp_C", clip_id="clp_c1", start=1, end=5, vector512=vector(1))
    secondary, outlier = record("smp_A", clip_id="clp_a2", start=4, end=8), record("smp_C", clip_id="clp_c2", start=4, end=8, vector512=vector(2))
    snapshot = build_cluster_snapshot([first, alias, other, secondary, outlier], base, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    clustered = next(row for row in snapshot["regions"] if first["identity"]["semanticId"] in {item["semanticId"] for item in row["aliases"]})
    labels = {clustered["semanticId"]: 2, other["identity"]["semanticId"]: 2,
              secondary["identity"]["semanticId"]: 3, outlier["identity"]["semanticId"]: None}
    scores = {first["identity"]["semanticId"]: 0.5, other["identity"]["semanticId"]: 0.5}
    service, _registry, packet, _envelope, _current = _pipeline_service(tmp_path, [first, alias, other, secondary, outlier], base, labels,
                                                                          ratings=lambda: scores)
    cluster_id = packet["clusters"][0]["clusterId"]
    similarity = service.detail(cluster_id, packet["runId"])
    rated = service.detail(cluster_id, packet["runId"], order="rating")
    rated_ids = sorted(scores)
    scores.pop(other["identity"]["semanticId"])
    missing = service.detail(cluster_id, packet["runId"], order="rating")

    assert similarity["representatives"][0]["semanticId"] not in {row["semanticId"] for row in similarity["members"]}
    assert [row["score"] for row in similarity["members"]] == [1.0, 0.0]
    assert [row["semanticId"] for row in rated["members"]] == rated_ids
    assert [row["score"] for row in missing["members"]] == [0.5, None]
    assert service.list_members(packet["runId"])["totalVisibleCount"] == 4
    assert len(service.leaderboard(packet["runId"])["clusters"]) == 2
    assert service.leaderboard(packet["runId"])["clusters"][0]["distinctSampleCount"] == 3


def test_explicit_old_published_run_survives_pointer_advance_and_missing_or_outage_is_sanitized(tmp_path):
    first, source = record(), catalog()
    snap = build_cluster_snapshot([first], source, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    service, registry, old, envelope, current = _pipeline_service(tmp_path, [first], source, {snap["regions"][0]["semanticId"]: 2})
    current = _mutable_catalog(current)
    current["clips"].append({"id": "clp_a2", "sampleId": "smp_A", "start": 4, "end": 8, "name": "clp_a2"})
    second_record = record("smp_A", clip_id="clp_a2", start=4, end=8)
    second_snapshot = build_cluster_snapshot([first, second_record], current, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    second = _packet(second_snapshot, current, {row["semanticId"]: 2 for row in second_snapshot["regions"]})
    save_draft_run(tmp_path / "drafts", second)
    registry.current_corpus_digest = lambda: second["corpusDigest"]
    control = registry.initialize(CURATOR, second["runId"])
    control = registry.override(CURATOR, second["runId"], second["clusters"][0]["clusterId"], "Approved", expected_run_revision=control["runRevision"])
    control = registry.review(CURATOR, second["runId"], [second["clusters"][0]["representatives"][0]["semanticId"]], "complete review", expected_run_revision=control["runRevision"])
    registry.publish(CURATOR, second["runId"], expected_run_revision=control["runRevision"], expected_pointer_revision=1)

    current["clips"].append({"id": "clp_c2", "sampleId": "smp_C", "start": 4, "end": 8, "name": "clp_c2"})
    draft_record = record("smp_C", clip_id="clp_c2", start=4, end=8)
    draft_snapshot = build_cluster_snapshot([first, second_record, draft_record], current, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    draft = _packet(draft_snapshot, current, {row["semanticId"]: 2 for row in draft_snapshot["regions"]})
    save_draft_run(tmp_path / "drafts", draft)

    assert service.leaderboard(preset="fine")["runId"] == second["runId"]
    assert service.leaderboard(old["runId"])["runId"] == old["runId"]
    with pytest.raises(ExplorationNotFound) as missing:
        service.leaderboard("0" * 64)
    assert missing.value.status_code == 404
    with pytest.raises(ExplorationNotFound) as unpublished:
        service.leaderboard(draft["runId"])
    assert unpublished.value.status_code == 404

    class Outage:
        def published_manifest(self, *args, **kwargs):
            raise RuntimeError("storage down")

    unavailable = ClusterExploration(Outage(), lambda: copy.deepcopy(envelope), lambda: copy.deepcopy(current),
                                     visibility=lambda *_: True, ratings=lambda: {}, enabled=True)
    with pytest.raises(ExplorationStorageUnavailable) as outage:
        unavailable.leaderboard(old["runId"])
    assert outage.value.status_code == 503 and outage.value.retryable is True


def test_real_10001_region_pipeline_caps_map_but_list_is_complete(tmp_path):
    source = _mutable_catalog(catalog())
    records = []
    for index in range(10_001):
        start = index / 1_000_000
        end = 4 + start
        clip_id = f"clp_many_{index}"
        source["clips"].append({"id": clip_id, "sampleId": "smp_A", "start": start, "end": end})
        records.append(record("smp_A", clip_id=clip_id, start=start, end=end))
    snapshot = build_cluster_snapshot(records, source, embedding_space=SPACE, processing_fingerprint=FINGERPRINT)
    assert snapshot["coverage"] == {"records": 10_001, "regions": 10_001, "excluded": 0}
    service, _registry, packet, _envelope, _current = _pipeline_service(tmp_path, records, source,
                                                                          {row["semanticId"]: 2 for row in snapshot["regions"]})
    mapped, listed = service.map(packet["runId"]), service.list_members(packet["runId"])
    assert mapped["displayedCount"] == 10_000 and mapped["totalVisibleCount"] == 10_001 and mapped["truncated"] is True
    assert len(listed["members"]) == listed["totalVisibleCount"] == 10_001
