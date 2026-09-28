"""Shared setup for every `lab` subcommand: find the repo root and the main checkout, find a
current `apricity` binary, link the score's sample audio in from the main checkout when this
checkout (a worktree) doesn't have it, and manage a temp render directory that always gets
cleaned up unless the caller asked to `--keep` it.

Nothing here talks to argparse; `lab/cli.py` and `lab/commands/*.py` own the CLI surface. This
module is safe to import from tests without a repo, as long as the functions that touch the
filesystem or run a subprocess are only called with paths that exist.
"""

from __future__ import annotations

import dataclasses
import pathlib
import shutil
import subprocess
import sys
import tempfile

AUDIO_SUFFIXES = (".wav", ".mp3", ".flac")

# `apricity --help` must list at least these subcommands for the binary to be current enough for
# `lab measure`/`lab try` (Harmony v2: chord recognition, Q, steering suggestions).
REQUIRED_SUBCOMMANDS = ("check", "steer")

BUILD_HINT = (
    "no apricity binary here has `check`/`steer` (Harmony v2). Build one:\n"
    "    export PATH=$HOME/.cargo/bin:$PATH CARGO_BUILD_JOBS=2\n"
    "    cargo build --release -p apricity-cli\n"
    "(never built here silently -- see AGENTS.md for the shared build-concurrency limit)"
)


class LabError(RuntimeError):
    """A `lab` setup problem an agent should read and act on (never a stack trace)."""


def _git(args: list[str], cwd: pathlib.Path) -> str:
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise LabError(f"git {' '.join(args)} failed in {cwd}: {proc.stderr.strip()}")
    return proc.stdout.strip()


def find_repo_root(start: pathlib.Path | None = None) -> pathlib.Path:
    """The current checkout's top level (may be a worktree)."""
    start = start or pathlib.Path.cwd()
    return pathlib.Path(_git(["rev-parse", "--show-toplevel"], start))


def find_main_checkout(repo_root: pathlib.Path) -> pathlib.Path:
    """The main checkout: the parent of the shared `.git` common dir. Equals `repo_root` when
    `repo_root` isn't a worktree."""
    common_dir = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo_root)
    return pathlib.Path(common_dir).resolve().parent


def _binary_supports(binary: pathlib.Path) -> bool:
    try:
        proc = subprocess.run([str(binary), "--help"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if proc.returncode != 0:
        return False
    return all(f"\n  {cmd} " in proc.stdout or proc.stdout.startswith(f"{cmd} ") for cmd in REQUIRED_SUBCOMMANDS)


def find_binary(repo_root: pathlib.Path, main_checkout: pathlib.Path) -> pathlib.Path:
    """This checkout's `target/release/apricity` if it supports `check`/`steer`, else the main
    checkout's. Raises `LabError` with exactly how to build one otherwise -- never builds it."""
    candidates = [repo_root / "target" / "release" / "apricity"]
    if main_checkout != repo_root:
        candidates.append(main_checkout / "target" / "release" / "apricity")
    for candidate in candidates:
        if candidate.exists() and _binary_supports(candidate):
            return candidate
    tried = ", ".join(str(c) for c in candidates)
    raise LabError(f"{BUILD_HINT}\n(looked at: {tried})")


def link_sample_audio(repo_root: pathlib.Path, main_checkout: pathlib.Path) -> int:
    """Symlink every sample audio file from the main checkout's `samples/` into this checkout's,
    file by file, only where missing. Never touches tracked manifests (`*.apricity.json`,
    `pruned.json`, `sources.json`, ...) -- only audio suffixes. Returns how many links were made."""
    if repo_root == main_checkout:
        return 0
    main_samples = main_checkout / "samples"
    if not main_samples.is_dir():
        return 0
    repo_samples = repo_root / "samples"
    linked = 0
    for src in main_samples.rglob("*"):
        if not src.is_file() or src.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        rel = src.relative_to(main_samples)
        dst = repo_samples / rel
        if dst.exists() or dst.is_symlink():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.symlink_to(src)
        linked += 1
    return linked


@dataclasses.dataclass
class LabContext:
    repo_root: pathlib.Path
    main_checkout: pathlib.Path
    binary: pathlib.Path | None

    def render_dir(self, keep: bool = False) -> "TempRenderDir":
        return TempRenderDir(self, keep=keep)


class TempRenderDir:
    """A managed scratch directory for one render: WAVs and `--stems` folders always get deleted
    on exit unless `keep=True`, in which case the directory itself is left in place (under
    `renders/lab/`, not the system temp dir) for the caller to point at."""

    def __init__(self, ctx: LabContext, *, keep: bool = False):
        self.ctx = ctx
        self.keep = keep
        if keep:
            base = ctx.repo_root / "renders" / "lab"
            base.mkdir(parents=True, exist_ok=True)
            self.path = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=str(base)))
        else:
            self.path = pathlib.Path(tempfile.mkdtemp(prefix="apricity-lab-"))

    def __enter__(self) -> pathlib.Path:
        return self.path

    def __exit__(self, exc_type, exc, tb) -> None:
        if not self.keep:
            shutil.rmtree(self.path, ignore_errors=True)


def build_context(start: pathlib.Path | None = None, *, require_binary: bool = True) -> LabContext:
    """`require_binary=False` skips the `apricity` binary lookup for subcommands that don't
    render (`lab cycle list`/`pull`, `lab ratings`, ...) so they don't fail in a checkout that
    has no current build."""
    repo_root = find_repo_root(start)
    main_checkout = find_main_checkout(repo_root)
    link_sample_audio(repo_root, main_checkout)
    binary = find_binary(repo_root, main_checkout) if require_binary else None
    return LabContext(repo_root=repo_root, main_checkout=main_checkout, binary=binary)


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)
