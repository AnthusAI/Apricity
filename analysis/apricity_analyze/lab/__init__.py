"""`lab`: one agent-friendly front door for the Apricity music tools (Kanbus apricitus-daebf8).

See `analysis/apricity_analyze/lab/context.py` for the shared setup (binary discovery, sample
linking, temp render management) and `analysis/apricity_analyze/lab/commands/` for each
subcommand. The `scripts/lab` executable is the CLI entry point; `cli.py` here is its dispatcher,
kept importable so tests can call it directly.
"""
