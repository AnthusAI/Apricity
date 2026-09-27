"""Cycle-folder output (spec section 6): `renders/optimize/<run>/` with `cycle.json`, the A-D
`.apr`/`.m4a` finalists (D = keep, the incumbent unchanged), `leaderboard.md`, `weights.json` and
`notebook.jsonl` (reuses `explore.notebook.Notebook`'s append-only log shape).
"""

from __future__ import annotations

import json
import pathlib
import subprocess

LETTERS = "ABCD"


def to_m4a(wav_path: pathlib.Path, out_path: pathlib.Path) -> str | None:
    try:
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path), "-c:a", "aac", "-b:a", "256k", str(out_path)],
                            capture_output=True, text=True, timeout=120)
        return None if r.returncode == 0 else r.stderr[-1000:]
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return str(e)


def write_cycle(run_dir: pathlib.Path, *, finalists: list[dict], incumbent: dict, seed: int, question: str,
                 rho: float | None, recall_at_12: float | None) -> pathlib.Path:
    """`finalists`: `[{"letter","genome","score_path","audio_path","terms","J","J_null","attribution"},...]`
    (D/incumbent appended by the caller as the last, or passed via `incumbent`)."""
    options = list(finalists) + [incumbent]
    payload = {
        "options": options,
        "incumbent_letter": incumbent["letter"],
        "question": question,
        "seed": seed,
        "surrogate_vs_rendered": {"spearman_rho": rho, "recall_at_12": recall_at_12},
    }
    path = run_dir / "cycle.json"
    path.write_text(json.dumps(payload, indent=1, default=str))
    return path


def write_leaderboard(run_dir: pathlib.Path, *, l1_rows: list[dict], archive_top: list[dict],
                       rho_by_role: dict, recall_by_role: dict) -> None:
    # Ranked/gated by the whole-mix Δmix (objective.WHOLE_MIX_MARGIN), not the render_terms
    # composite -- render_J/J_null(render) kept as diagnostic columns.
    lines = ["# Optimizer leaderboard", "", "## L1 (8-bar render, whole-mix Δmix gate)", "",
             "| rank | role | surrogate J | Δmix | contribution | rank score | gate | render J (diag) | source#clip | genome |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(l1_rows, 1):
        gate = "PASS" if r.get("passes_gate") else "fail"
        lines.append(f"| {i} | {r.get('role','')} | {r['J']:.2f} | {r.get('delta_mix', float('nan')):+.2f} | "
                     f"{r.get('contribution', 0.0):.3f} | {r.get('rank_score', float('nan')):+.2f} | {gate} | "
                     f"{r.get('render_J', float('nan')):.2f} | {r.get('source','')}#{r.get('clip','')} | {r.get('prose','')} |")
    lines += ["", "## Archive top 20 (by cell)", "", "| role | register | family | J |", "|---|---|---|---|"]
    for e in archive_top[:20]:
        lines.append(f"| {e['role']} | {e['register']} | {e['family']} | {e['J']:.2f} |")
    lines += ["", "## Surrogate vs rendered (L1), per role", "", "| role | spearman rho | recall@12 |", "|---|---|---|"]
    for role in sorted(set(rho_by_role) | set(recall_by_role)):
        lines.append(f"| {role} | {rho_by_role.get(role, float('nan')):.3f} | {recall_by_role.get(role, float('nan')):.3f} |")
    (run_dir / "leaderboard.md").write_text("\n".join(lines) + "\n")


def write_weights(run_dir: pathlib.Path, weights: dict) -> None:
    (run_dir / "weights.json").write_text(json.dumps(weights, indent=1))
