"""Shells out to the Rust `apricity` binary's authenticated cloud subcommands (`apricity lab ...`,
`apricity cycle ...`) for the lab CLI's `--target cloud`. Those commands carry the signed-in person's
Cognito session (`apricity login`; crates/apricity-cli/src/cloud.rs) and call AppSync directly, so
`owner` is set server-side by the identity claims in their ID token -- this module (and the lab CLI
above it) never touches AWS credentials, boto3, or an owner config of its own.
"""

from __future__ import annotations

import json
import pathlib
import subprocess


class CloudCliError(RuntimeError):
    """`apricity <command>` failed; the message is what it printed to stderr (or its exit status)."""


def run_json(binary: pathlib.Path, args: list[str]) -> dict:
    """Run `apricity <args> --json` and parse its stdout. Raises `CloudCliError` with the binary's own
    stderr on a non-zero exit (typically "Run `apricity login`" when there's no session)."""
    proc = subprocess.run([str(binary), *args, "--json"], capture_output=True, text=True)
    if proc.returncode != 0:
        raise CloudCliError(proc.stderr.strip() or f"apricity {' '.join(args)} failed (exit {proc.returncode})")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise CloudCliError(f"apricity {' '.join(args)}: invalid JSON output: {e}\n{proc.stdout[:500]}") from e
