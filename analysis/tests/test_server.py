import json
import shutil

import pytest
from fastapi.testclient import TestClient

from apricity_analyze import server

client = TestClient(server.app)
CLIP = "samples/citizen-dj/loc-jukebox-popular/Army-bugle-calls_jukebox-118367_001_00-00-56.wav"


def test_lists_analyzed_samples_with_credits():
    r = client.get("/api/samples").json()
    paths = {c["path"]: c for c in r["samples"]}
    assert CLIP in paths
    c = paths[CLIP]
    assert c["credit"].startswith("Citizen DJ") and c["bpm"] and c["key"]


def test_isolation_headers_on_every_response():
    r = client.get("/api/scores")
    assert r.headers["cross-origin-opener-policy"] == "same-origin"
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"


def test_files_are_confined_to_the_project_folders():
    assert client.get("/files/examples/iv-of-ab-minor.yaml").status_code == 200
    assert client.get("/files/Cargo.toml").status_code == 403
    assert client.get("/files/samples/../Cargo.toml").status_code == 403
    assert client.get("/files/%2e%2e/%2e%2e/etc/passwd").status_code in (403, 404)


@pytest.fixture
def manifest_backup():
    mpath = server.ROOT / (CLIP + ".apricity.json")
    saved = mpath.read_text()
    yield mpath
    mpath.write_text(saved)


def test_annotations_are_validated_and_saved(manifest_backup):
    dur = json.loads(manifest_backup.read_text())["source"]["duration"]
    good = {"clips": [{"name": "call-1", "start": 0.5, "end": 2.0, "source": "user"}], "markers": [{"name": "transient", "seconds": 1.0}]}
    assert client.put(f"/api/annotations?path={CLIP}", json=good).json() == {"ok": True}
    assert json.loads(manifest_backup.read_text())["annotations"]["clips"][0]["name"] == "call-1"

    bad = {"clips": [{"name": "past end", "start": 1.0, "end": dur + 5}, {"name": "x", "start": 3, "end": 2}], "markers": [{"name": "m", "seconds": -1}]}
    r = client.put(f"/api/annotations?path={CLIP}", json=bad)
    assert r.status_code == 422
    errors = "\n".join(r.json()["errors"])
    assert "must be letters" in errors and "0 ≤ start < end" in errors and "outside the sample" in errors
    assert json.loads(manifest_backup.read_text())["annotations"]["clips"][0]["name"] == "call-1", "a bad save changes nothing"


def test_scores_can_only_be_written_as_yaml_in_score_folders():
    assert client.put("/api/score?path=Cargo.toml", content=b"x").status_code == 403
    assert client.put("/api/score?path=scores/x.txt", content=b"x").status_code == 400
    assert any(x["path"].endswith(".apr") for x in client.get("/api/scores").json()["scores"])
    r = client.put("/api/score?path=scores/_test.yaml", content=b"apricity: 0.1\n")
    try:
        assert r.status_code == 200
        assert client.get("/files/scores/_test.yaml").text == "apricity: 0.1\n"
    finally:
        (server.ROOT / "scores" / "_test.yaml").unlink(missing_ok=True)
        if not any((server.ROOT / "scores").iterdir()):
            shutil.rmtree(server.ROOT / "scores")
