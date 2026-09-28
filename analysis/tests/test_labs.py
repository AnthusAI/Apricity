"""Labs (Kanbus apricitus-e59a0b): `lab start|list|attach` against a temp local library, and
against the cloud CLI shell-out (`apricity lab ...` / `apricity cycle attach`), with `run_json`
faked so nothing here spawns a real subprocess or touches the network."""

from __future__ import annotations

import json
import pathlib

import pytest

from apricity_analyze import cycle
from apricity_analyze.lab import cli, context
from apricity_analyze.lab.cloud_cli import CloudCliError
from apricity_analyze.lab.commands import cycle as cycle_cmd
from apricity_analyze.lab.commands import labs as labs_cmd

INCUMBENT = "scr_examples_ave-house_apr"


def _lib(tmp_path: pathlib.Path) -> pathlib.Path:
    lib = tmp_path / "lib"
    (lib / "Score").mkdir(parents=True)
    (lib / "apricity-library.json").write_text(json.dumps({"identity": {"sub": "me"}}))
    (lib / "Score" / f"{INCUMBENT}.json").write_text(json.dumps({"id": INCUMBENT, "title": "ave-house", "folder": "examples", "text": "x", "owner": "me"}))
    return lib


# --------------------------------------------------------------------------- LocalBackend: labs

def test_local_backend_creates_lists_and_gets_a_lab(tmp_path):
    lib = _lib(tmp_path)
    backend = cycle.LocalBackend(lib)
    lab = backend.create_lab(INCUMBENT, "ave-house: warmer low end", "chase a warmer low end")
    assert lab["id"].startswith("lab_") and lab["status"] == "open" and lab["owner"] == "me"
    assert backend.get_lab(lab["id"]) == lab
    assert backend.get_lab("lab_nope") is None
    assert [l["id"] for l in backend.list_labs()] == [lab["id"]]


def test_local_backend_list_labs_is_newest_first_and_scoped_to_the_owner(tmp_path):
    lib = _lib(tmp_path)
    mine = cycle.LocalBackend(lib, owner="me")
    someone_else = cycle.LocalBackend(lib, owner="someone-else")
    older = mine.create_lab(INCUMBENT, "older")
    older["createdAt"] = "2000-01-01T00:00:00.000Z"
    (lib / "Lab" / f"{older['id']}.json").write_text(json.dumps(older))
    someone_else.create_lab(INCUMBENT, "not mine")
    newer = mine.create_lab(INCUMBENT, "newer")
    assert [l["id"] for l in mine.list_labs()] == [newer["id"], older["id"]]


def test_local_backend_attach_lab_sets_lab_id_on_the_cycle(tmp_path):
    lib = _lib(tmp_path)
    backend = cycle.LocalBackend(lib)
    lab = backend.create_lab(INCUMBENT, "a lab")
    cyc = backend.put_listening_cycle({"id": "cyc_1", "title": "t", "incumbentScoreId": INCUMBENT, "options": [], "status": "open", "owner": "me"})
    assert cyc.get("labId") is None
    updated = backend.attach_lab("cyc_1", lab["id"])
    assert updated["labId"] == lab["id"]
    assert backend.get_cycle("cyc_1")["labId"] == lab["id"]
    with pytest.raises(ValueError, match="no such cycle"):
        backend.attach_lab("cyc_nope", lab["id"])


def test_cycle_publish_can_set_lab_id(tmp_path):
    lib = _lib(tmp_path)
    backend = cycle.LocalBackend(lib)
    lab = backend.create_lab(INCUMBENT, "a lab")
    src = tmp_path / "src"
    src.mkdir()
    inc_audio = src / "keep.m4a"
    inc_audio.write_bytes(b"incumbent audio")
    apr = src / "cand.apr"
    apr.write_text("# candidate\n")
    audio = src / "cand.m4a"
    audio.write_bytes(b"candidate audio")
    published = cycle.publish(
        backend, score_path=src / "ave-house.apr", incumbent_score_id=INCUMBENT, incumbent_audio=inc_audio,
        candidates=[cycle.Candidate(apr, audio)], lab_id=lab["id"], log_path=tmp_path / "log.jsonl",
    )
    assert published["labId"] == lab["id"]
    without_lab = cycle.publish(
        backend, score_path=src / "ave-house.apr", incumbent_score_id=INCUMBENT, incumbent_audio=inc_audio,
        candidates=[cycle.Candidate(apr, audio)], log_path=tmp_path / "log2.jsonl",
    )
    assert "labId" not in without_lab


# --------------------------------------------------------------------------- CLI: local target

def test_lab_start_list_attach_local_round_trip(tmp_path, capsys):
    lib = _lib(tmp_path)
    exit_code = cli.main(["start", INCUMBENT, "--title", "ave-house: warmer low end", "--brief", "chase warmth",
                           "--target", "local", "--library", str(lib), "--json"])
    assert exit_code == 0
    lab = json.loads(capsys.readouterr().out)
    assert lab["title"] == "ave-house: warmer low end" and lab["sceneScoreId"] == INCUMBENT

    exit_code = cli.main(["list", "--target", "local", "--library", str(lib), "--json"])
    assert exit_code == 0
    listed = json.loads(capsys.readouterr().out)
    assert [l["id"] for l in listed["labs"]] == [lab["id"]]

    backend = cycle.LocalBackend(lib)
    backend.put_listening_cycle({"id": "cyc_1", "title": "t", "incumbentScoreId": INCUMBENT, "options": [], "status": "open", "owner": "me"})
    exit_code = cli.main(["attach", "cyc_1", "--lab", lab["id"], "--target", "local", "--library", str(lib), "--json"])
    assert exit_code == 0
    attached = json.loads(capsys.readouterr().out)
    assert attached == {"cycleId": "cyc_1", "labId": lab["id"]}
    assert backend.get_cycle("cyc_1")["labId"] == lab["id"]


def test_lab_start_local_refuses_an_unknown_score(tmp_path, capsys):
    lib = _lib(tmp_path)
    with pytest.raises(SystemExit):
        cli.main(["start", "scr_nope", "--title", "t", "--target", "local", "--library", str(lib)])
    assert "no such score" in capsys.readouterr().err


def test_lab_attach_local_refuses_an_unknown_lab_or_cycle(tmp_path, capsys):
    lib = _lib(tmp_path)
    with pytest.raises(SystemExit):
        cli.main(["attach", "cyc_1", "--lab", "lab_nope", "--target", "local", "--library", str(lib)])
    assert "no such lab" in capsys.readouterr().err


# --------------------------------------------------------------------------- CLI: cloud target (run_json faked)

def _fake_ctx(tmp_path):
    return context.LabContext(repo_root=tmp_path, main_checkout=tmp_path, binary=pathlib.Path("/bin/true"))


def test_lab_start_cloud_shells_out_to_apricity_lab_start(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(labs_cmd._common, "get_context", lambda args, **kw: _fake_ctx(tmp_path))
    calls = []

    def fake_run_json(binary, args):
        calls.append(args)
        return {"id": "lab_abc123", "title": args[args.index("--title") + 1]}

    monkeypatch.setattr(labs_cmd, "run_json", fake_run_json)
    exit_code = cli.main(["start", "scr_cloud_scene", "--title", "cloud lab", "--target", "cloud", "--json"])
    assert exit_code == 0
    assert json.loads(capsys.readouterr().out)["id"] == "lab_abc123"
    assert calls == [["lab", "start", "scr_cloud_scene", "--title", "cloud lab"]]


def test_lab_list_cloud_shells_out_and_reports_the_cli_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(labs_cmd._common, "get_context", lambda args, **kw: _fake_ctx(tmp_path))

    def failing(binary, args):
        raise CloudCliError("No Apricity application session is available. Run `apricity login`.")

    monkeypatch.setattr(labs_cmd, "run_json", failing)
    with pytest.raises(SystemExit):
        cli.main(["list", "--target", "cloud"])
    assert "apricity login" in capsys.readouterr().err


def test_lab_attach_cloud_shells_out_to_apricity_cycle_attach(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(labs_cmd._common, "get_context", lambda args, **kw: _fake_ctx(tmp_path))
    calls = []

    def fake_run_json(binary, args):
        calls.append(args)
        return {"cycleId": "cyc_1", "labId": "lab_abc123"}

    monkeypatch.setattr(labs_cmd, "run_json", fake_run_json)
    exit_code = cli.main(["attach", "cyc_1", "--lab", "lab_abc123", "--target", "cloud", "--json"])
    assert exit_code == 0
    assert json.loads(capsys.readouterr().out) == {"cycleId": "cyc_1", "labId": "lab_abc123"}
    assert calls == [["cycle", "attach", "cyc_1", "--lab", "lab_abc123"]]


# --------------------------------------------------------------------------- CLI: `lab cycle ... --target cloud`

def test_cycle_publish_cloud_shells_out_with_candidate_pairs_and_lab(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cycle_cmd._common, "get_context", lambda args, **kw: _fake_ctx(tmp_path))
    apr = tmp_path / "cand.apr"
    apr.write_text("# candidate\n")
    audio = tmp_path / "cand.m4a"
    audio.write_bytes(b"audio")
    inc_audio = tmp_path / "inc.m4a"
    inc_audio.write_bytes(b"incumbent audio")
    calls = []

    def fake_run_json(binary, args):
        calls.append(args)
        return {"cycleId": "cyc_abc123", "options": [{"letter": "A"}, {"letter": "B"}]}

    monkeypatch.setattr(cycle_cmd, "run_json", fake_run_json)
    exit_code = cli.main([
        "cycle", "--target", "cloud", "--json", "publish",
        "--score", str(tmp_path / "incumbent.apr"), "--incumbent-score-id", "scr_cloud",
        "--incumbent-audio", str(inc_audio), "--candidate", str(apr), str(audio),
        "--lab", "lab_abc123", "--question", "which is better?",
    ])
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["cycleId"] == "cyc_abc123"
    [args] = calls
    assert args[:3] == ["cycle", "publish", "--score"]
    assert "--candidate" in args and str(apr) in args and str(audio) in args
    assert args[args.index("--lab") + 1] == "lab_abc123"


def test_cycle_list_and_pull_cloud_shell_out(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cycle_cmd._common, "get_context", lambda args, **kw: _fake_ctx(tmp_path))
    calls = []

    def fake_run_json(binary, args):
        calls.append(args)
        if args[1] == "list":
            return {"cycles": [{"id": "cyc_1", "title": "t", "options": [{"letter": "A"}], "createdAt": "2026-01-01"}]}
        return {"entries": [{"kind": "cycle-verdict", "type": "verdict", "best": "A"}], "closed": True}

    monkeypatch.setattr(cycle_cmd, "run_json", fake_run_json)
    assert cli.main(["cycle", "--target", "cloud", "--json", "list"]) == 0
    assert json.loads(capsys.readouterr().out)["cycles"][0]["id"] == "cyc_1"
    assert cli.main(["cycle", "--target", "cloud", "--json", "pull", "cyc_1", "--close"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["closed"] is True and payload["entries"][0]["best"] == "A"
    assert calls[0] == ["cycle", "list"]
    assert calls[1] == ["cycle", "pull", "cyc_1", "--close"]
