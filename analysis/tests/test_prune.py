import json

import pytest

from apricity_analyze import prune

CUR = "sub-cur"  # a curator
VIS = "sub-visitor"


class Fake:
    """A backend that records what was deleted."""

    def __init__(self):
        self.rows, self.objects = [], []

    def delete_row(self, model, key):
        self.rows.append((model, key))

    def delete_object(self, key):
        self.objects.append(key)


def rating(target, stars, owner=CUR, kind="sample"):
    return {"id": f"{kind}#{target}#{owner}", "targetType": kind, "targetId": target, "stars": stars, "owner": f"{owner}::google_1"}


def sample(sid, path, rec="rec_a", parent=None):
    s = {"id": sid, "path": path, "recordingId": rec, "title": path.rsplit("/", 1)[-1],
         "audio": {"key": f"audio/{sid}/x.wav", "sha256": "ab" * 32}, "analysis": {"key": f"analysis/{sid}/a.json"}}
    if parent:
        s["parentSampleId"] = parent
    return s


def world(tmp_path, samples, ratings, **extra):
    repo, lib = tmp_path / "repo", tmp_path / "lib"
    for s in samples:
        a = repo / "samples" / s["path"]
        a.parent.mkdir(parents=True, exist_ok=True)
        a.write_bytes(b"audio")
        a.with_name(a.name + ".apricity.json").write_text(json.dumps({"source": {}, "annotations": {"clips": [{"name": "c1"}]}}))
    (repo / "samples").mkdir(parents=True, exist_ok=True)
    (repo / "samples/sources.json").write_text(json.dumps({"files": [{"path": s["path"]} for s in samples]}))
    (repo / "crates/apricity-sources/catalog").mkdir(parents=True, exist_ok=True)
    (repo / "crates/apricity-sources/catalog/sources.json").write_text(json.dumps(
        [{"id": s["id"], "files": [{"path": s["path"]}]} for s in samples]))
    (repo / "examples").mkdir()
    for s in samples:  # library copies
        for p in (lib / "Sample" / f"{s['id']}.json", lib / "files" / s["audio"]["key"]):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("x")
    db = {m: [] for m in prune.MODELS}
    db["Sample"], db["Rating"] = samples, ratings
    for k, v in extra.items():
        db[k] = v
    recs = sorted({s["recordingId"] for s in samples})
    db["Recording"] = [{"id": r} for r in recs]
    return db, repo, lib


def plan(db, repo, lib, trusted=(CUR,)):
    return prune.build_plan(db, set(trusted), repo, lib)


def test_a_curators_one_star_removes_a_sample_from_everywhere(tmp_path):
    s = sample("smp_1", "ccmixter/a/song_1.mp3")
    db, repo, lib = world(tmp_path, [s], [rating("smp_1", 1)],
                          Clip=[{"id": "clp_1", "sampleId": "smp_1", "name": "c1"}],
                          Comment=[{"id": "cm1", "targetId": "smp_1"}], Tally=[{"id": "t1", "targetId": "smp_1"}])
    p = plan(db, repo, lib)
    assert [(i.kind, i.blocked) for i in p] == [("sample", [])]
    b = Fake()
    prune.apply(p, b, repo)
    models = [m for m, _ in b.rows]
    assert {"Sample", "Clip", "Rating", "Tally", "Comment", "Recording"} <= set(models)
    assert models.index("Clip") < models.index("Sample") and models.index("Sample") < models.index("Rating")  # ratings last
    assert {"Sample/smp_1.json", "Clip/clp_1.json", "files/audio/smp_1/x.wav", "files/analysis/smp_1/a.json", "Recording/rec_a.json"} <= set(b.objects)
    assert not (repo / "samples/ccmixter/a/song_1.mp3").exists() and not (repo / "samples/ccmixter/a/song_1.mp3.apricity.json").exists()
    assert not (lib / "Sample/smp_1.json").exists() and not (lib / "files/audio/smp_1/x.wav").exists()
    assert json.loads((repo / "samples/sources.json").read_text())["files"] == []
    assert json.loads((repo / "crates/apricity-sources/catalog/sources.json").read_text()) == []
    assert prune.is_pruned(repo, path="ccmixter/a/song_1.mp3") and prune.is_pruned(repo, sha256="ab" * 32)


def test_a_dry_run_changes_nothing(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 1)])
    text = prune.describe(plan(db, repo, lib))
    assert "PRUNE" in text and "--apply" in text
    assert (repo / "samples/a/b_1.mp3").exists() and not prune.tombstone_path(repo).exists()


def test_only_curators_count_and_all_of_them_must_agree(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_v", "a/v_1.mp3"), sample("smp_m", "a/m_2.mp3", rec="rec_b")],
                          [rating("smp_v", 1, VIS), rating("smp_m", 1, CUR), rating("smp_m", 4, "sub-cur2")])
    assert plan(db, repo, lib, trusted=(CUR, "sub-cur2")) == []  # a visitor's star and a split vote remove nothing
    assert [i.id for i in plan(db, repo, lib, trusted=(CUR,))] == ["smp_m"]


def test_a_sample_a_score_still_uses_is_kept_and_says_why(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 1)],
                          ScoreRef=[{"id": "r1", "scoreId": "scr_hero", "sampleId": "smp_1"}])
    (item,) = plan(db, repo, lib)
    assert item.blocked == ["used by score scr_hero"] and item.rows == []
    b = Fake()
    prune.apply([item], b, repo)
    assert b.rows == [] and (repo / "samples/a/b_1.mp3").exists()


def test_a_sample_named_in_an_example_is_kept(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 1)])
    (repo / "examples/x.apr").write_text("clip k = a/b_1.mp3 pick 1bar")
    (item,) = plan(db, repo, lib)
    assert item.blocked == ["named in examples/x.apr"]


def test_a_clip_of_it_used_by_a_score_keeps_the_sample(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 1)],
                          Clip=[{"id": "clp_1", "sampleId": "smp_1", "name": "c1"}],
                          ScoreRef=[{"id": "r1", "scoreId": "scr_x", "clipId": "clp_1"}])
    (item,) = plan(db, repo, lib)
    assert item.blocked == ["a clip of it is used by score scr_x"]


def test_stems_go_with_their_parent_and_the_recording_with_its_last_sample(tmp_path):
    parent = sample("smp_p", "m/piece.mp3", rec="rec_m")
    stem = sample("smp_s", "m/stems/piece/bass.wav", rec="rec_m", parent="smp_p")
    db, repo, lib = world(tmp_path, [parent, stem], [rating("smp_p", 1)])
    (item,) = plan(db, repo, lib)
    assert {r["id"] for m, r in item.rows if m == "Sample"} == {"smp_p", "smp_s"}
    assert ("Recording", {"id": "rec_m"}) in item.rows
    prune.apply([item], Fake(), repo)
    assert not (repo / "samples/m/stems/piece/bass.wav").exists() and not (repo / "samples/m/piece.mp3").exists()


def test_a_recording_with_other_samples_stays(tmp_path):
    a, b = sample("smp_a", "x/a_1.mp3", rec="rec_z"), sample("smp_b", "x/b_1.mp3", rec="rec_z")
    db, repo, lib = world(tmp_path, [a, b], [rating("smp_a", 1)])
    (item,) = plan(db, repo, lib)
    assert not [1 for m, _ in item.rows if m == "Recording"]


def _pair(tmp_path, rate):
    orig = sample("smp_o", "loc/c/song_1.mp3", rec="rec_p")
    clean = sample("smp_c", "loc/c/song_1.clean.wav", rec="rec_p")
    db, repo, lib = world(tmp_path, [orig, clean], [rating(rate, 1)])
    (repo / "samples/loc/c/song_1.clean.wav.apricity.json").write_text(json.dumps({"source": {"denoise": {"original": "song_1.mp3"}}}))
    return db, repo, lib


def test_pruning_a_denoised_copy_keeps_its_original(tmp_path):
    db, repo, lib = _pair(tmp_path, "smp_c")
    (item,) = plan(db, repo, lib)
    prune.apply([item], Fake(), repo)
    assert not (repo / "samples/loc/c/song_1.clean.wav").exists() and (repo / "samples/loc/c/song_1.mp3").exists()
    assert not prune.tombstone_path(repo).exists() and len(json.loads((repo / "samples/sources.json").read_text())["files"]) == 2


def test_pruning_an_original_keeps_its_file_as_the_copys_source(tmp_path):
    db, repo, lib = _pair(tmp_path, "smp_o")
    (item,) = plan(db, repo, lib)
    assert any("source of song_1.clean.wav" in n for n in item.notes)
    prune.apply([item], Fake(), repo)
    assert (repo / "samples/loc/c/song_1.mp3").exists() and not (repo / "samples/loc/c/song_1.mp3.apricity.json").exists()
    assert not prune.tombstone_path(repo).exists()
    assert "loc/c/song_1.mp3" in {f["path"] for f in json.loads((repo / "samples/sources.json").read_text())["files"]}


def test_a_one_star_clip_removes_only_the_clip(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("clp_1", 1, kind="clip")],
                          Clip=[{"id": "clp_1", "sampleId": "smp_1", "name": "c1"}],
                          CrateItem=[{"id": "ci", "clipId": "clp_1"}])
    (item,) = plan(db, repo, lib)
    assert item.kind == "clip" and {m for m, _ in item.rows} == {"Clip", "Rating", "CrateItem"}
    prune.apply([item], Fake(), repo)
    assert (repo / "samples/a/b_1.mp3").exists()
    assert json.loads((repo / "samples/a/b_1.mp3.apricity.json").read_text())["annotations"]["clips"] == []


def test_leftover_ratings_of_a_removed_target_are_cleaned_up(tmp_path):
    db, repo, lib = world(tmp_path, [], [rating("smp_gone", 1)], Tally=[{"id": "t", "targetId": "smp_gone"}])
    (item,) = plan(db, repo, lib)
    assert item.kind == "rating" and {m for m, _ in item.rows} == {"Rating", "Tally"}


def test_other_ratings_are_ignored(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 2), rating("scr_x", 1, kind="score")])
    assert plan(db, repo, lib) == []


def test_curation_candidates_of_a_pruned_file_are_dropped_too(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3"), sample("smp_2", "a/c_2.mp3", rec="rec_b")], [rating("smp_1", 1)])
    (repo / "library").mkdir()
    (repo / "library/candidates.json").write_text(json.dumps({"candidates": [{"clip": "a/b_1.mp3"}, {"clip": "a/c_2.mp3"}, {"clip": "a/b_1.mp3"}]}))
    prune.apply(plan(db, repo, lib), Fake(), repo)
    assert json.loads((repo / "library/candidates.json").read_text())["candidates"] == [{"clip": "a/c_2.mp3"}]


def test_a_kept_sample_is_left_alone_by_id_or_path(tmp_path):
    a, b = sample("smp_a", "x/a_1.mp3", rec="rec_1"), sample("smp_b", "x/b_2.mp3", rec="rec_2")
    db, repo, lib = world(tmp_path, [a, b], [rating("smp_a", 1), rating("smp_b", 1)])
    assert [i.id for i in prune.build_plan(db, {CUR}, repo, lib, keep={"smp_a"})] == ["smp_b"]
    assert [i.id for i in prune.build_plan(db, {CUR}, repo, lib, keep={"x/b_2.mp3"})] == ["smp_a"]


def test_the_rows_are_backed_up_before_anything_is_deleted(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 1)])
    p = plan(db, repo, lib)
    out = prune.backup(p, tmp_path / "bk/x.json")
    saved = json.loads(out.read_text())
    assert {r["model"] for r in saved} >= {"Sample", "Rating"} and (repo / "samples/a/b_1.mp3").exists()


def test_local_ratings_of_a_pruned_target_go_from_the_library_folder(tmp_path):
    db, repo, lib = world(tmp_path, [sample("smp_1", "a/b_1.mp3")], [rating("smp_1", 1)],
                          Clip=[{"id": "clp_1", "sampleId": "smp_1", "name": "c1"}])
    (lib / "Rating").mkdir()
    mine, other = lib / "Rating/clip#clp_1#local.json", lib / "Rating/clip#clp_9#local.json"
    mine.write_text("x")
    other.write_text("x")
    prune.apply(plan(db, repo, lib), Fake(), repo)
    assert not mine.exists() and other.exists()
