"""Tests for `apricity_analyze.cloud_pull`: cloud records land in the library's folders in the library's own
shape, unchanged files aren't rewritten, gone cloud records are removed, and local records are never touched."""

from __future__ import annotations

import json

from apricity_analyze import cloud_pull as cp

OWNER = "c438::google_1"


def _rating(target, stars, who="google_1"):
    return {"__typename": "Rating", "id": f"clip#{target}#{who}", "targetType": "clip", "targetId": target, "stars": stars,
            "ratedAt": "2026-09-27T00:00:00Z", "owner": OWNER}


def test_dynamodb_values_become_plain_json():
    raw = {"id": {"S": "x"}, "stars": {"N": "4"}, "score": {"N": "0.5"}, "deleted": {"BOOL": False}, "parentId": {"NULL": True},
           "tags": {"L": [{"S": "a"}]}, "audio": {"M": {"size": {"N": "12"}}}}
    assert cp.item(raw) == {"id": "x", "stars": 4, "score": 0.5, "deleted": False, "parentId": None, "tags": ["a"], "audio": {"size": 12}}


def test_pull_mirrors_the_cloud_and_leaves_local_records_alone(tmp_path):
    lib = tmp_path / "lib"
    (lib / "Rating").mkdir(parents=True)
    local = {"__typename": "Rating", "id": "clip#c1#local", "targetType": "clip", "targetId": "c1", "stars": 3, "ratedAt": "t"}
    (lib / "Rating" / "clip#c1#local.json").write_text(json.dumps(local))
    (lib / "Rating" / "clip#gone#google_1.json").write_text(cp.text(_rating("gone", 2)))
    cloud = {"Rating": [_rating("c1", 5), _rating("c2", 4)], "Comment": [], "Handle": [{"id": "ann", "owner": OWNER}]}
    scan = lambda table: cloud[table.removesuffix("-sfx")]

    plans = cp.pull(lib, scan=scan, suffix="-sfx")
    assert sorted(plans["Rating"].write) == ["clip#c1#google_1.json", "clip#c2#google_1.json"]
    assert plans["Rating"].remove == ["clip#gone#google_1.json"]
    assert json.loads((lib / "Rating" / "clip#c1#local.json").read_text()) == local
    assert json.loads((lib / "Rating" / "clip#c2#google_1.json").read_text())["stars"] == 4
    assert not (lib / "Rating" / "clip#gone#google_1.json").exists()
    assert json.loads((lib / "Handle" / "ann.json").read_text())["owner"] == OWNER

    again = cp.pull(lib, scan=scan, suffix="-sfx")
    assert (again["Rating"].write, again["Rating"].remove, again["Rating"].same) == ({}, [], 2)


def test_a_dry_run_changes_nothing(tmp_path):
    plans = cp.pull(tmp_path, scan=lambda t: [_rating("c1", 5)] if t.startswith("Rating") else [], suffix="", dry_run=True)
    assert list(plans["Rating"].write) == ["clip#c1#google_1.json"]
    assert not (tmp_path / "Rating").exists()
