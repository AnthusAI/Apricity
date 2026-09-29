"""Listening cycles (apricity_analyze.cycle): publish, list and pull against a temp local library and a
fake DynamoDB/S3 pair. Nothing here touches the real cloud."""

import json
import pathlib
import random

import pytest

from apricity_analyze import cycle

INCUMBENT = "scr_examples_ave-house_apr"


def _lib(tmp_path: pathlib.Path) -> pathlib.Path:
    lib = tmp_path / "lib"
    (lib / "Score").mkdir(parents=True)
    (lib / "apricity-library.json").write_text(json.dumps({"identity": {"sub": "me"}}))
    (lib / "Score" / f"{INCUMBENT}.json").write_text(json.dumps({"id": INCUMBENT, "title": "ave-house", "folder": "examples", "text": "x", "owner": "me"}))
    return lib


def _files(tmp_path: pathlib.Path, n: int):
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    inc = src / "keep.m4a"
    inc.write_bytes(b"incumbent audio")
    cands = []
    for i in range(n):
        apr = src / f"cand{i}.apr"
        apr.write_text(f"# candidate {i}\n")
        audio = src / f"cand{i}.m4a"
        audio.write_bytes(f"audio {i}".encode())
        cands.append(cycle.Candidate(apr, audio))
    return src / "ave-house.apr", inc, cands


def _publish(backend, tmp_path, n=3, seed=7):
    score, inc, cands = _files(tmp_path, n)
    log = tmp_path / "log.jsonl"
    c = cycle.publish(backend, score_path=score, incumbent_score_id=INCUMBENT, incumbent_audio=inc,
                      candidates=cands, question="Which loop?", log_path=log, rng=random.Random(seed))
    return c, log


def test_publish_local_makes_candidate_forks_audio_and_a_blind_key(tmp_path):
    lib = _lib(tmp_path)
    c, log = _publish(cycle.LocalBackend(lib), tmp_path)

    assert c["status"] == "open" and [o["letter"] for o in c["options"]] == list("ABCD")
    ids = [o["scoreId"] for o in c["options"]]
    assert INCUMBENT in ids
    for sid in ids:
        if sid == INCUMBENT:
            continue
        s = json.loads((lib / "Score" / f"{sid}.json").read_text())
        assert s["tags"] == ["candidate"] and s["forkOf"] == INCUMBENT and s["forkRoot"] == INCUMBENT
        assert s["folder"] == f"cycles/{c['id']}" and s["owner"] == "me"
    for o in c["options"]:
        f = lib / "files" / o["audio"]["key"]
        assert f.exists() and o["audio"]["key"] == f"cycles/{c['id']}/{o['letter']}.m4a"
        assert o["audio"]["size"] == len(f.read_bytes())
    stored = json.loads((lib / "ListeningCycle" / f"{c['id']}.json").read_text())
    assert stored["__typename"] == "ListeningCycle" and stored["createdAt"]

    key = cycle.read_cycle_key(log, c["id"])
    assert {v["scoreId"] for v in key.values()} == set(ids)
    assert cycle.list_open(cycle.LocalBackend(lib))[0]["id"] == c["id"]


def test_the_seed_fixes_the_letters(tmp_path):
    def letter_of_incumbent(seed, sub):
        c, _ = _publish(cycle.LocalBackend(_lib(tmp_path / sub)), tmp_path / sub, seed=seed)
        return next(o["letter"] for o in c["options"] if o["scoreId"] == INCUMBENT)
    (tmp_path / "a").mkdir(); (tmp_path / "b").mkdir()
    assert letter_of_incumbent(3, "a") == letter_of_incumbent(3, "b")


def test_publish_refuses_too_many_options_and_an_unknown_incumbent(tmp_path):
    lib = _lib(tmp_path)
    with pytest.raises(ValueError, match="at most 4"):
        _publish(cycle.LocalBackend(lib), tmp_path, n=4)
    score, inc, cands = _files(tmp_path, 1)
    with pytest.raises(ValueError, match="no such score"):
        cycle.publish(cycle.LocalBackend(lib), score_path=score, incumbent_score_id="scr_nope", incumbent_audio=inc,
                      candidates=cands, log_path=tmp_path / "l.jsonl")


def test_pull_maps_letters_skips_stale_ratings_and_closes(tmp_path):
    lib = _lib(tmp_path)
    c, log = _publish(cycle.LocalBackend(lib), tmp_path)
    by_letter = {o["letter"]: o["scoreId"] for o in c["options"]}
    (lib / "Rating").mkdir()
    ratings = [
        ("r1", by_letter["B"], 4, "2999-01-01T00:00:00.000Z"),
        ("r2", INCUMBENT, 5, "2000-01-01T00:00:00.000Z"),  # rated long before this cycle: not a vote in it
        ("r3", "scr_other", 3, "2999-01-01T00:00:00.000Z"),  # not in the cycle
    ]
    for rid, target, stars, at in ratings:
        (lib / "Rating" / f"{rid}.json").write_text(json.dumps({"id": rid, "targetType": "score", "targetId": target, "stars": stars, "ratedAt": at, "owner": "me"}))
    (lib / "CycleVerdict").mkdir()
    (lib / "CycleVerdict" / f"{c['id']}__me.json").write_text(json.dumps(
        {"cycleId": c["id"], "judge": "me", "best": "B", "notes": [{"letter": "B", "note": "warm"}], "savedAt": "2999-01-01T00:00:00.000Z"}))

    entries = cycle.pull(cycle.LocalBackend(lib), c["id"], log_path=log, close=True)
    assert [(e["type"], e.get("letter"), e.get("stars"), e.get("best")) for e in entries] == [("rating", "B", 4, None), ("verdict", None, None, "B")]
    assert json.loads((lib / "ListeningCycle" / f"{c['id']}.json").read_text())["status"] == "closed"
    assert cycle.list_open(cycle.LocalBackend(lib)) == []
    logged = [json.loads(l) for l in log.read_text().splitlines()]
    assert [l["kind"] for l in logged] == ["listening-cycle", "cycle-verdict", "cycle-verdict"]


class FakeDynamo:
    """Just enough of the low-level DynamoDB client for cycle.CloudBackend, over plain dicts."""

    def __init__(self, tables):
        self.tables = {t: {} for t in tables}

    def list_tables(self, **_):
        return {"TableNames": list(self.tables)}

    @staticmethod
    def _key(table, item):
        return (item["cycleId"]["S"], item["judge"]["S"]) if table.startswith("CycleVerdict-") else item["id"]["S"]

    def put_item(self, TableName, Item):
        self.tables[TableName][self._key(TableName, Item)] = Item

    def get_item(self, TableName, Key):
        item = self.tables[TableName].get(self._key(TableName, Key))
        return {"Item": item} if item else {}

    def scan(self, TableName, **_):
        return {"Items": list(self.tables[TableName].values())}

    def query(self, TableName, IndexName, ExpressionAttributeValues, **_):
        assert IndexName == "cycleVerdictsByCycleId"
        want = ExpressionAttributeValues[":c"]["S"]
        return {"Items": [i for i in self.tables[TableName].values() if i["cycleId"]["S"] == want]}

    def update_item(self, TableName, Key, ExpressionAttributeValues, **_):
        item = self.tables[TableName][self._key(TableName, Key)]
        item["status"] = ExpressionAttributeValues[":s"]
        item["closedAt"] = ExpressionAttributeValues[":c"]


class FakeS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, **_):
        self.objects[(Bucket, Key)] = Body


def test_cloud_round_trip_with_fakes(tmp_path):
    sfx = "abc-NONE"
    ddb = FakeDynamo([f"{m}-{sfx}" for m in ("Score", "ListeningCycle", "CycleVerdict", "Rating")])
    ddb.put_item(f"Score-{sfx}", cycle.item_to_ddb({"id": INCUMBENT, "title": "ave-house"}))
    s3 = FakeS3()
    cloud = cycle.CloudBackend(owner="sub1::ryan", ddb=ddb, s3=s3, bucket="bkt")

    c, log = _publish(cloud, tmp_path, n=2)
    assert len(s3.objects) == 3 and all(b == "bkt" and k.startswith(f"files/cycles/{c['id']}/") for b, k in s3.objects)
    forks = [cycle.item_from_ddb(i) for i in ddb.tables[f"Score-{sfx}"].values() if i["id"]["S"] != INCUMBENT]
    assert len(forks) == 2 and all(f["tags"] == ["candidate"] and f["owner"] == "sub1::ryan" for f in forks)
    assert [x["id"] for x in cloud.list_open_cycles()] == [c["id"]]

    ddb.put_item(f"CycleVerdict-{sfx}", cycle.item_to_ddb({"cycleId": c["id"], "judge": "sub1", "best": "same", "savedAt": "2999-01-01T00:00:00.000Z"}))
    entries = cycle.pull(cloud, c["id"], log_path=log, close=True)
    assert [e["best"] for e in entries] == ["same"]
    assert cycle.item_from_ddb(ddb.tables[f"ListeningCycle-{sfx}"][c["id"]])["status"] == "closed"


def test_cloud_publish_needs_an_owner(tmp_path):
    cloud = cycle.CloudBackend(owner=None, ddb=FakeDynamo([]), s3=FakeS3(), bucket="b")
    with pytest.raises(ValueError, match="owner"):
        _publish(cloud, tmp_path)
