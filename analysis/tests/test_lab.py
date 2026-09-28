"""Tests for `lab` (Kanbus apricitus-daebf8): the dispatcher, the shared context (binary discovery,
sample linking), and the measure/try path on a small example score."""

from __future__ import annotations

import json
import pathlib
import stat

import pytest

from apricity_analyze.lab import cli, context
from apricity_analyze.lab.commands import try_ as try_cmd
from apricity_analyze.lab.rendercheck import Measurement

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "target" / "release" / "apricity"
EXAMPLE_SCORE = ROOT / "examples" / "markup-demo.apr"
HAS_AUDIO = (ROOT / "samples" / "marine-band" / "Thunderer.mp3").exists()
BIN_CURRENT = BIN.exists() and context._binary_supports(BIN)


# --------------------------------------------------------------------------- dispatcher help

SUBCOMMANDS = ["measure", "try", "audition", "neighbors", "swap", "add", "cycle", "backtest",
               "palette", "ratings", "features"]


def test_top_level_help_lists_every_subcommand(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    for name in SUBCOMMANDS:
        assert name in out


@pytest.mark.parametrize("name", SUBCOMMANDS)
def test_each_subcommand_has_help(name, capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main([name, "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "usage:" in out
    assert "--json" in out  # every subcommand takes --json


def test_unknown_subcommand_fails_cleanly():
    with pytest.raises(SystemExit) as exc:
        cli.main(["not-a-command"])
    assert exc.value.code != 0


# --------------------------------------------------------------------------- context: binary discovery

def _write_fake_binary(path: pathlib.Path, help_text: str) -> None:
    path.write_text(f"#!/bin/sh\ncat <<'EOF'\n{help_text}\nEOF\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def test_binary_supports_requires_check_and_steer(tmp_path):
    old = tmp_path / "apricity-old"
    _write_fake_binary(old, "Usage: apricity <COMMAND>\n\nCommands:\n  render   Render\n  help     Help\n")
    assert context._binary_supports(old) is False

    current = tmp_path / "apricity-current"
    _write_fake_binary(current, "Usage: apricity <COMMAND>\n\nCommands:\n  render   Render\n  check    Check\n  steer    Steer\n  help     Help\n")
    assert context._binary_supports(current) is True


def test_find_binary_raises_with_a_build_hint_when_none_found(tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    with pytest.raises(context.LabError) as exc:
        context.find_binary(repo_root, repo_root)
    assert "cargo build --release" in str(exc.value)


def test_find_binary_picks_a_binary_that_supports_check_and_steer(tmp_path):
    repo_root = tmp_path / "repo"
    (repo_root / "target" / "release").mkdir(parents=True)
    fake = repo_root / "target" / "release" / "apricity"
    _write_fake_binary(fake, "Usage: apricity <COMMAND>\n\nCommands:\n  check    Check\n  steer    Steer\n")
    found = context.find_binary(repo_root, repo_root)
    assert found == fake


# --------------------------------------------------------------------------- context: sample linking

def test_link_sample_audio_links_missing_files_only(tmp_path):
    main_checkout = tmp_path / "main"
    repo_root = tmp_path / "worktree"
    (main_checkout / "samples" / "band").mkdir(parents=True)
    (repo_root / "samples" / "band").mkdir(parents=True)

    (main_checkout / "samples" / "band" / "loop.wav").write_bytes(b"RIFF-fake-wav")
    (main_checkout / "samples" / "band" / "loop.mp3.apricity.json").write_text('{"already": "tracked"}')
    # Already present in the worktree: must not be touched/replaced.
    (repo_root / "samples" / "band" / "loop.mp3.apricity.json").write_text('{"tracked": "here"}')

    linked = context.link_sample_audio(repo_root, main_checkout)

    assert linked == 1
    dest = repo_root / "samples" / "band" / "loop.wav"
    assert dest.is_symlink()
    assert dest.resolve() == (main_checkout / "samples" / "band" / "loop.wav").resolve()
    # The tracked manifest already in the worktree was never replaced.
    assert (repo_root / "samples" / "band" / "loop.mp3.apricity.json").read_text() == '{"tracked": "here"}'


def test_link_sample_audio_is_a_noop_when_repo_root_is_the_main_checkout(tmp_path):
    assert context.link_sample_audio(tmp_path, tmp_path) == 0


def test_link_sample_audio_skips_already_linked_files(tmp_path):
    main_checkout = tmp_path / "main"
    repo_root = tmp_path / "worktree"
    (main_checkout / "samples").mkdir(parents=True)
    (repo_root / "samples").mkdir(parents=True)
    (main_checkout / "samples" / "a.wav").write_bytes(b"x")

    first = context.link_sample_audio(repo_root, main_checkout)
    second = context.link_sample_audio(repo_root, main_checkout)
    assert first == 1
    assert second == 0


# --------------------------------------------------------------------------- lab measure (real)

pytestmark_measure = pytest.mark.skipif(
    not BIN_CURRENT or not HAS_AUDIO or not EXAMPLE_SCORE.exists(),
    reason="needs a current apricity binary (check/steer) and linked sample audio",
)


@pytestmark_measure
def test_lab_measure_on_a_small_example_score(capsys):
    exit_code = cli.main(["measure", str(EXAMPLE_SCORE), "--json"])
    assert exit_code == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["score"] == str(EXAMPLE_SCORE.resolve())
    assert isinstance(payload["objective_v2"], float)
    assert isinstance(payload["spans"], list) and len(payload["spans"]) > 0
    assert "suggestions" in payload


# --------------------------------------------------------------------------- lab try (stubbed measure)

def _fake_measurement(score, bars, objective_v2, guard_violations=()):
    return Measurement(
        score=score, bars=bars, stems_dir=pathlib.Path("/nonexistent"),
        check={"objective": objective_v2, "objective_v2": objective_v2, "q_mean": 0.9,
               "guard_violations": list(guard_violations), "spans": []},
        steer={"spans": [], "suggestions": []},
    )


def test_lab_try_keeps_when_the_objective_rises_enough(tmp_path, monkeypatch):
    score = tmp_path / "tiny.apr"
    score.write_text("tempo 120\nkey C major\nsamples ../samples\n\ntrack bright volume 0\n")

    calls = {"n": 0}

    def fake_render_and_measure(ctx, score_path, work_dir, *, bars=None, baseline=None):
        calls["n"] += 1
        objective = 80.0 if calls["n"] == 1 else 85.0  # +5, a KEEP
        return _fake_measurement(score_path, bars, objective)

    monkeypatch.setattr(try_cmd, "render_and_measure", fake_render_and_measure)
    monkeypatch.setattr(try_cmd._common, "get_context", lambda args: context.LabContext(
        repo_root=tmp_path, main_checkout=tmp_path, binary=pathlib.Path("/bin/true")))

    exit_code = cli.main(["try", str(score), "--op", '{"op": "track.volume", "track": "bright", "delta": 2}', "--json"])
    assert exit_code == 0


def test_lab_try_rejects_when_the_objective_falls(tmp_path, monkeypatch, capsys):
    score = tmp_path / "tiny.apr"
    score.write_text("tempo 120\nkey C major\nsamples ../samples\n\ntrack bright volume 0\n")

    calls = {"n": 0}

    def fake_render_and_measure(ctx, score_path, work_dir, *, bars=None, baseline=None):
        calls["n"] += 1
        objective = 80.0 if calls["n"] == 1 else 79.0  # -1, a REJECT
        return _fake_measurement(score_path, bars, objective)

    monkeypatch.setattr(try_cmd, "render_and_measure", fake_render_and_measure)
    monkeypatch.setattr(try_cmd._common, "get_context", lambda args: context.LabContext(
        repo_root=tmp_path, main_checkout=tmp_path, binary=pathlib.Path("/bin/true")))

    exit_code = cli.main(["try", str(score), "--op", '{"op": "track.volume", "track": "bright", "delta": 2}', "--json"])
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["verdict"] == "REJECT"
    assert payload["applied"] is False
    assert score.read_text() == "tempo 120\nkey C major\nsamples ../samples\n\ntrack bright volume 0\n"  # untouched


def test_lab_try_apply_writes_the_keep_back_to_score(tmp_path, monkeypatch):
    score = tmp_path / "tiny.apr"
    score.write_text("tempo 120\nkey C major\nsamples ../samples\n\ntrack bright volume 0\n")

    calls = {"n": 0}

    def fake_render_and_measure(ctx, score_path, work_dir, *, bars=None, baseline=None):
        calls["n"] += 1
        objective = 80.0 if calls["n"] == 1 else 90.0  # +10, a KEEP
        return _fake_measurement(score_path, bars, objective)

    monkeypatch.setattr(try_cmd, "render_and_measure", fake_render_and_measure)
    monkeypatch.setattr(try_cmd._common, "get_context", lambda args: context.LabContext(
        repo_root=tmp_path, main_checkout=tmp_path, binary=pathlib.Path("/bin/true")))

    exit_code = cli.main(["try", str(score), "--op", '{"op": "track.volume", "track": "bright", "delta": 2}', "--apply", "--json"])
    assert exit_code == 0
    assert "volume 2" in score.read_text()
