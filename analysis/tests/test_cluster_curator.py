"""Private curator preview/control contract for M5.

Feature: Curator draft preview and publication
  Scenario: A curator previews and explicitly publishes a draft
    Given a current draft and a server-trusted curator
    When the curator previews, reviews, and wins both CAS revisions
    Then representative cards stay private until publication and the pointer advances

  Scenario: A public reader attempts control access
    Given a draft
    When a non-curator requests its control or preview
    Then access is denied without creating a publication control
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from apricity_analyze.cluster_corpus import build_cluster_snapshot
from apricity_analyze.cluster_curator import CuratorClusterService
from apricity_analyze.cluster_publication import (ClusterPublicationRegistry,
                                                   ConflictError, ForbiddenError)
from apricity_analyze.cluster_curator_http import CuratorActor, run_request
from apricity_analyze.cluster_runs import save_draft_run
from test_cluster_exploration import _packet
from test_cluster_corpus import FINGERPRINT, SPACE, catalog, record


CURATOR = SimpleNamespace(id="curator-1", is_curator=True)
GUEST = SimpleNamespace(id="guest", is_curator=False)


def _service(tmp_path):
    current_catalog = catalog()
    for sample in current_catalog["samples"]:
        sample.setdefault("title", sample["id"])
    for clip in current_catalog["clips"]:
        clip.setdefault("name", clip["id"])
    records = [record()]
    snapshot = build_cluster_snapshot(records, current_catalog, embedding_space=SPACE,
                                      processing_fingerprint=FINGERPRINT, visibility=lambda *_: True)
    packet = _packet(snapshot, current_catalog, {snapshot["regions"][0]["semanticId"]: 2})
    save_draft_run(tmp_path / "runs", packet)
    corpus = {"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE,
              "processingFingerprint": FINGERPRINT, "records": records}
    registry = ClusterPublicationRegistry(tmp_path / "control", tmp_path / "runs",
                                          current_corpus_digest=lambda: packet["corpusDigest"], enabled=True)
    return CuratorClusterService(registry, lambda: corpus, lambda: current_catalog, visibility=lambda *_: True), packet, registry


def test_gherkin_private_preview_requires_curator_and_never_makes_a_public_envelope(tmp_path):
    service, packet, registry = _service(tmp_path)
    with pytest.raises(ForbiddenError):
        service.preview(GUEST, packet["runId"])
    assert not (tmp_path / "control" / "cluster-publication.json").exists()

    preview = service.preview(CURATOR, packet["runId"])
    assert preview["state"] == "draft" and preview["runRevision"] == 1
    assert preview["clusters"][0]["clusterId"] == packet["clusters"][0]["clusterId"]
    assert "vector" not in repr(preview) and "reviewAudit" not in preview
    with pytest.raises(Exception):
        registry.published_manifest(packet["runId"])


def test_gherkin_override_invalidates_review_and_publish_is_explicit_cas(tmp_path):
    service, packet, registry = _service(tmp_path)
    preview = service.preview(CURATOR, packet["runId"])
    cluster = preview["clusters"][0]["clusterId"]
    changed = service.override(CURATOR, packet["runId"], cluster, "  Hand drums  ",
                               expected_run_revision=preview["runRevision"])
    assert changed["overrides"][cluster]["label"] == "Hand drums" and changed["review"] is None
    reviewed = service.review(CURATOR, packet["runId"], [packet["clusters"][0]["representatives"][0]["semanticId"]],
                              "I listened to every representative.", expected_run_revision=changed["runRevision"])
    with pytest.raises(ConflictError):
        service.publish(CURATOR, packet["runId"], expected_run_revision=changed["runRevision"],
                        expected_pointer_revision=preview["pointerRevision"])
    published = service.publish(CURATOR, packet["runId"], expected_run_revision=reviewed["runRevision"],
                                expected_pointer_revision=preview["pointerRevision"])
    assert published["state"] == "published"
    assert registry.published_manifest(packet["runId"])["runId"] == packet["runId"]


def test_private_transport_is_fail_closed_before_it_reads_draft_or_native_data(tmp_path):
    response = run_request({"op": "preview", "runId": "a" * 64}, library=tmp_path / "library",
                           controls_root=tmp_path / "control", runs_root=tmp_path / "runs",
                           actor=CuratorActor("curator-1"), enabled=False)
    assert response == {"statusCode": 403, "body": {"error": "forbidden"}}
    assert not (tmp_path / "control").exists()
