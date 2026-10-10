"""Feature: native public cluster HTTP protocol.

  Scenario: A reviewed published run is served from fresh native files
    Given native corpus, catalog and Rating rows and a published manifest
    When the adapter receives a strict leaderboard or rating-detail query
    Then it returns finite public data, excludes non-public samples, and never exposes rating owners

  Scenario: the rollout is disabled
    Given a disabled adapter
    When it receives a query
    Then it returns 503 without reading native data
"""
from __future__ import annotations

import json
import copy

import pytest

from apricity_analyze.cluster_http import ClusterHttp, run_query
from test_cluster_corpus import FINGERPRINT, SPACE, catalog as fixture_catalog, record
from test_cluster_exploration import _published_service


def _native_library(tmp_path, corpus, catalog):
    library = tmp_path / "library"
    (library / "semantic").mkdir(parents=True)
    (library / "semantic" / "corpus.json").write_text(json.dumps(corpus), encoding="utf8")
    values = {
        "Sample": list(catalog["samples"]), "Clip": list(catalog["clips"]),
        "Recording": list(catalog["recordings"].values()),
    }
    for table, rows in values.items():
        directory = library / table; directory.mkdir()
        for row in rows:
            row = copy.deepcopy(row)
            if table == "Sample": row["status"] = "ready"
            if table == "Recording": row.update(license="cc-by-4.0", author="Fixture Author")
            if table == "Clip": row.setdefault("name", row["id"])
            (directory / f"{row['id']}.json").write_text(json.dumps(row), encoding="utf8")
    return library


def test_disabled_protocol_does_not_read_native_data(tmp_path):
    missing = tmp_path / "missing"
    response = run_query({"view": "leaderboard"}, library=missing,
                         controls_root=tmp_path / "controls", runs_root=tmp_path / "runs", enabled=False)
    assert response == {"statusCode": 503, "body": {"error": "service unavailable"}}


@pytest.mark.parametrize("query", [
    {"view": "wat"}, {"view": "map", "limit": True},
    {"view": "leaderboard", "extra": 1},
])
def test_protocol_rejects_unknown_or_invalid_fields_before_reads(tmp_path, query):
    response = run_query(query, library=tmp_path / "missing", controls_root=tmp_path / "controls",
                         runs_root=tmp_path / "runs", enabled=True)
    assert response == {"statusCode": 400, "body": {"error": "bad request"}}


def test_protocol_strict_json_has_no_nan_or_traceback(tmp_path):
    response = run_query({"view": "leaderboard"}, library=tmp_path / "missing", controls_root=tmp_path / "controls",
                         runs_root=tmp_path / "runs", enabled=True)
    wire = json.dumps(response, allow_nan=False)
    assert response["statusCode"] == 404 and "Traceback" not in wire and str(tmp_path) not in wire


def test_rating_aggregate_uses_canonical_rows_and_never_returns_owner(tmp_path):
    library = tmp_path / "library"
    (library / "Rating").mkdir(parents=True)
    (library / "semantic").mkdir()
    (library / "semantic" / "corpus.json").write_text(json.dumps({
        "schemaVersion": "apricity.semantic-corpus/1", "records": [
            {"identity": {"semanticId": "a" * 64, "kind": "saved_clip", "clipId": "c1"}},
        ],
    }), encoding="utf8")
    def put(name, value):
        (library / "Rating" / name).write_text(json.dumps(value), encoding="utf8")
    put("clip#c1#alice.json", {"id": "clip#c1#alice", "targetType": "clip", "targetId": "c1", "stars": 5,
                                 "ratedAt": "2026-01-01T00:00:00Z", "owner": "alice"})
    put("clip#c1#bad.json", {"id": "clip#c1#bad", "targetType": "clip", "targetId": "c1", "stars": 9,
                               "ratedAt": "2026-01-01T00:00:00Z", "owner": "bad"})
    http = ClusterHttp(library, tmp_path / "controls", tmp_path / "runs", enabled=True)
    assert http._ratings() == {"a" * 64: 3.125}
    # The aggregate has no owner or individual vote surface.


def test_curator_representative_catalog_reads_only_current_representative_rows(tmp_path):
    """A corrupt unrelated row must not make a bounded draft audition hang."""
    current = fixture_catalog()
    corpus = {"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE,
              "processingFingerprint": FINGERPRINT, "records": [record()]}
    library = _native_library(tmp_path, corpus, current)
    (library / "Sample" / "smp_B.json").write_text("not-json", encoding="utf8")
    http = ClusterHttp(library, tmp_path / "controls", tmp_path / "runs", enabled=True)
    selected = http._catalog_for_records(corpus["records"])
    assert [row["id"] for row in selected["samples"]] == ["smp_A"]
    assert [row["id"] for row in selected["recordings"]] == ["rec_R1"]
    assert [row["id"] for row in selected["clips"]] == ["clp_a1"]


def test_genuine_reviewed_publication_uses_fresh_native_visibility_and_ratings(tmp_path):
    registry, packet, corpus, catalog = _published_service(tmp_path)
    library = _native_library(tmp_path, corpus, catalog)
    (library / "Rating").mkdir()
    (library / "Rating" / "clip#clp_a1#alice.json").write_text(json.dumps({
        "id": "clip#clp_a1#alice", "targetType": "clip", "targetId": "clp_a1", "stars": 5,
        "ratedAt": "2026-01-01T00:00:00Z", "owner": "alice",
    }), encoding="utf8")
    http = ClusterHttp(library, registry.root, registry.runs_root, enabled=True)
    board = http.query({"view": "leaderboard", "run": packet["runId"]})
    assert board["clusters"] and board["clusters"][0]["distinctSampleCount"] == 2
    cluster_id = board["clusters"][0]["clusterId"]
    detail = http.query({"view": "detail", "run": packet["runId"], "clusterId": cluster_id, "order": "rating"})
    assert "alice" not in json.dumps(detail) and all(member["score"] is None or member["score"] == 3.125 for member in detail["members"])
    # Same process re-reads native metadata: an undocumented/non-ready current parent disappears.
    sample = library / "Sample" / "smp_A.json"
    changed = json.loads(sample.read_text()); changed["status"] = "draft"; sample.write_text(json.dumps(changed))
    assert http.query({"view": "leaderboard", "run": packet["runId"]})["clusters"][0]["distinctSampleCount"] == 1
