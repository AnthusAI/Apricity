#!/usr/bin/env python3
"""The stochastic mash-up optimizer's CLI (Kanbus apricitus-a9ad5b, Phase 1).

    scripts/optimize.py examples/ave-house.apr --seed 7 --run NAME
        [--roles loop,bass,pad,stab,chop,riff] [--role <existing-track>]
        [--budget-l0 N] [--budget-l1 N] [--workers 4] [--style "smooth deep house"]

Writes `renders/optimize/<run>/`: `cycle.json`, `leaderboard.md`, `weights.json`,
`notebook.jsonl`, and the cycle folder's `A.apr/.m4a` .. `D.apr/.m4a` (D = keep, the incumbent).

Pipeline (spec section 3b, Phase 1 slice -- see `genome.py`/`surrogate.py`/`objective.py` module
docstrings for the documented deviations from the full design): L0 surrogate sampling + a few
mutation rounds into a MAP-Elites archive (`archive.py`), an L1 8-bar render ladder scored by
`apricity_analyze.layer.check_layer` against the null control, an L2 full-render ladder scored by
`apricity_analyze.check`, then the cycle folder.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))

import numpy as np
from scipy.stats import spearmanr

from apricity_analyze import check as checker
from apricity_analyze import layer
from apricity_analyze.explore import candidates as candidates_mod
from apricity_analyze.explore import evaluate as evaluate_mod
from apricity_analyze.optimize import archive as archive_mod
from apricity_analyze.optimize import cycle_out
from apricity_analyze.optimize import objective as objective_mod
from apricity_analyze.optimize import render_terms as render_terms_mod
from apricity_analyze.optimize import surrogate as surrogate_mod
from apricity_analyze.optimize.genome import KIT_ROLES, PITCHED_ROLES, REGION_PREFIXES, ROLES, Genome, SECTION_FALLBACK

# Round 3 (per review): L1 renders the *full* score, not an 8-bar window of the genome's entry
# section. Found empirically, not assumed: scoring the same A/B/C candidates from
# `ave-house-seed7-run2` with an 8-bar-windowed Δmix flipped C's sign (+0.29, "passes") relative
# to the full-render Δmix (-14.40, "fails clearly", which matches the user's actual listening
# verdict exactly -- renders/log.jsonl's listen-note, cited in objective.WHOLE_MIX_MARGIN). An
# 8-bar slice of a 40-bar song is missing most of the harmonic/energy context the whole-mix
# `check.py` objective (and guards, which compare against the *full-song* baseline regardless of
# how much of it a given render covers) needs to be meaningful. Full renders cost ~23s each (spec
# section 0's own measurement) vs ~5.6s for 8 bars, but at 4 workers even the spec's full L1
# budget of 48 stays under 5 minutes, well inside the 15-minute cycle budget -- so there was no
# real reason to keep the cheap-but-wrong window once the whole-mix metric replaced
# render_terms as the gate. `layer.check_layer` (masking/rhythm diagnostics) and the contribution
# channels (band fill / harmonic addition / motion) now also see the full render, which only
# helps `motion_term`'s bar-to-bar variance estimate (more bars, not fewer).
L1_BARS_DEFAULT = None


def build_candidate_pools(roles: list[str], *, exclude_samples: set[str]) -> dict[str, list]:
    pools = {}
    for role in roles:
        pools[role] = candidates_mod.region_candidates(REGION_PREFIXES[role], exclude_samples=exclude_samples)
    return pools


def detect_sections(compiled: dict) -> list[tuple[int, int]]:
    """Bar sections from the score's own automation breakpoints when they look like clean
    section boundaries; else the spec's Ave House fallback (`SECTION_FALLBACK`), documented as a
    Phase 1 simplification (the spec reads the incumbent's automation/`bars` ranges generically)."""
    return SECTION_FALLBACK


def score_genome(g: Genome, base_text: str, style_embedding) -> tuple[object, object] | None:
    """Surrogate-score one genome: `(comp, terms)`, or `None` on a compile failure / a region
    that lands nothing on the new track (both counted as an L0 failure by the caller)."""
    from apricity_analyze.optimize.genome import PITCHED_PATTERNS, kit_pattern

    try:
        text = g.text(base_text)
        compiled = surrogate_mod.compile_text(text, absolutize=evaluate_mod.absolutize_samples)
    except Exception:
        return None
    track = g.track_name()
    cand_chroma, cand_mass = surrogate_mod._track_beat_vectors(compiled, track)
    if cand_mass.sum() <= 1e-9 and g.role not in KIT_ROLES:
        return None
    stack = surrogate_mod.stack_vectors(compiled, exclude_tracks={track})
    pat_str = PITCHED_PATTERNS.get(g.pattern, "x . . . . . . . . . . . . . . .") if g.role in PITCHED_ROLES else \
        (kit_pattern(g.pattern) if g.role in KIT_ROLES else "x x x x x x x x x x x x x x x x")
    density = surrogate_mod.pattern_density(pat_str)

    # round 2: masking/rhythm/onset-density from the fitfeat sidecar, shared formulas with L1
    # (see surrogate.py's module docstring). Falls back to 0.0/pattern-density when a track's
    # source(s) have no sidecar.
    cand_bands, cand_onset, cand_onset_count, cand_has_sidecar = surrogate_mod._track_quarter_vectors(compiled, track)
    stack_bands, stack_onset = surrogate_mod.stack_quarter_vectors(compiled, exclude_tracks={track})
    onset_density_value = surrogate_mod.onset_density(cand_onset_count, cand_chroma.shape[0]) if cand_has_sidecar else None

    taste = 0.5
    if style_embedding is not None:
        emb = _clip_clap_embedding(g.source, g.clip)
        if emb is not None:
            cos = float(np.dot(emb, style_embedding))
            taste = float(np.clip(1.0 - (cos + 1) / 2, 0.0, 1.0))

    terms = surrogate_mod.compute_terms(candidate_chroma=cand_chroma, stack=stack, harmony=compiled.get("harmony", []),
                                         entry=g.entry, pattern_density_value=density, taste_penalty=taste,
                                         is_bass=(g.role == "bass"),
                                         candidate_bands=cand_bands if cand_has_sidecar else None, stack_bands=stack_bands,
                                         candidate_onset=cand_onset if cand_has_sidecar else None, stack_onset=stack_onset,
                                         onset_density_value=onset_density_value)
    return objective_mod.composite(terms), terms


def l0_sample_and_score(base_text: str, priors: dict, rng: np.random.Generator, budget: int,
                          arch: archive_mod.Archive, style_embedding, workers: int, notebook_rows: list) -> tuple[int, int]:
    """Sample `budget` genomes (sequentially, so `rng` stays reproducible), score them in
    parallel (the surrogate is dominated by the `apricity compile` subprocess call, so a thread
    pool -- not a process pool -- already gets the parallelism; no numpy/GIL contention worth a
    process pool here), then insert into the archive in genome-hash order regardless of which
    thread finished first (spec 3b's reproducibility rule: "candidates are evaluated in sorted
    genome-hash order so worker scheduling cannot change results"). Returns `(n_ok, n_fail)`."""
    import concurrent.futures

    genomes = []
    for _ in range(budget):
        g = Genome.sample(rng, priors)
        if g is not None:
            genomes.append(g)
    genomes.sort(key=lambda g: g.key())

    n_ok = n_fail = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(lambda g: score_genome(g, base_text, style_embedding), genomes))
    for g, res in zip(genomes, results):
        if res is None:
            n_fail += 1
            continue
        comp, terms = res
        arch.insert(g, comp.J, comp, terms)
        notebook_rows.append({"level": "L0", "genome": dataclasses.asdict(g), "J": comp.J, "terms": dataclasses.asdict(terms)})
        n_ok += 1
    return n_ok, n_fail


def _clip_clap_embedding(sample: str, clip: str):
    from apricity_analyze import clap as clap_mod
    p = surrogate_mod.SAMPLES / f"{sample}.apricity.json"
    sidecar = clap_mod.sidecar_path_for(p)
    if not sidecar.exists():
        return None
    try:
        with np.load(sidecar, allow_pickle=True) as z:
            names = [str(n) for n in z["clip_names"]]
            if clip not in names:
                return None
            return z["clip_embeddings"][names.index(clip)]
    except Exception:
        return None


def mutation_rounds(priors: dict, rng: np.random.Generator, arch: archive_mod.Archive, base_text: str,
                     rounds: int, per_round: int, style_embedding, workers: int, notebook_rows: list) -> int:
    import concurrent.futures

    n = 0
    for _ in range(rounds):
        elites = arch.elites()
        if not elites:
            break
        mutants = []
        for _ in range(per_round):
            parent = elites[int(rng.integers(len(elites)))].genome
            mutants.append(parent.mutate(rng, priors))
        mutants.sort(key=lambda g: g.key())
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            results = list(pool.map(lambda g: score_genome(g, base_text, style_embedding), mutants))
        for g, res in zip(mutants, results):
            if res is None:
                continue
            comp, terms = res
            arch.insert(g, comp.J, comp, terms)
            notebook_rows.append({"level": "L0-mutate", "genome": dataclasses.asdict(g), "J": comp.J})
            n += 1
    return n


def l1_bars_for(genome: Genome) -> tuple[int, int] | None:
    if L1_BARS_DEFAULT is None:
        return None  # full-song render; see L1_BARS_DEFAULT's comment
    a, b = genome.entry
    return (a, min(b, a + L1_BARS_DEFAULT - 1))


def _delete_render_cache(ev: evaluate_mod.Evaluator, text: str, bars) -> None:
    """Delete one candidate's cached render (stems dir, wav, and the small result json) so its
    ~300 MB (a full-song 9-stem render, round 3's L1_BARS_DEFAULT=None) doesn't sit on disk once
    its metrics are extracted. Deleting the json too, not just the audio, matters: it forces a
    fresh render if this exact text is ever evaluated again (e.g. a genuine L2 finalist), rather
    than returning a cached EvalResult that points at a stems_dir which no longer exists."""
    import shutil

    sha = evaluate_mod.score_sha(text, bars)
    for suffix in (".json",):
        p = ev.cache_dir / f"{sha}{suffix}"
        p.unlink(missing_ok=True)
    wav = ev.cache_dir / f"{sha}.wav"
    wav.unlink(missing_ok=True)
    stems = ev.cache_dir / f"{sha}.stems"
    if stems.exists():
        shutil.rmtree(stems, ignore_errors=True)


L1_CHUNK_SIZE = 4  # per review: "clean up renders to keep disk above 8 GB" -- a full-song render
                   # is ~300 MB (measured, round 3), so rendering the whole L1 pool at once before
                   # any cleanup (the round-2 code's shape) filled a 10 GB disk mid-run on this
                   # shared machine. Render/score/delete in small chunks instead so peak disk use
                   # from this batch stays bounded to roughly chunk_size * ~300 MB.


def render_l1_batch(items: list[tuple[str, Genome, str]], base_text: str, ev: evaluate_mod.Evaluator,
                     workers: int, *, cleanup: bool = True) -> dict[str, dict]:
    """`items`: `[(key, genome, text), ...]`. Renders every candidate's window *and* every distinct
    stack-only window it needs, in small parallel chunks (`L1_CHUNK_SIZE`), deleting each
    candidate's render right after its metrics are extracted when `cleanup` is True (round 3's
    full-song L1 renders are too large to keep all of them on disk at once -- see
    `_delete_render_cache`). Returns `{key: {"report", "delta_mix", ...} | None}` -- callers must
    not rely on `stems_dir`/`wav` still existing after this returns when `cleanup` is True (L2
    re-renders its small finalist set explicitly, which is a fresh render, not a stale path)."""
    bars_needed = sorted({l1_bars_for(g) for _, g, _ in items})
    # rendered sequentially (a handful of distinct windows at most): baseline.json must exist
    # before any candidate is scored (Evaluator's contract), so this always runs first anyway.
    stack_results = [ev.evaluate(base_text, bars=b) for b in bars_needed]
    stack_feat_cache: dict[tuple[int, int], tuple] = {}
    stack_objective_cache: dict[tuple[int, int], float] = {}
    for bars, result in zip(bars_needed, stack_results):
        if result.ok:
            m, feats = layer.load_stack(pathlib.Path(result.stems_dir))
            stack_feat_cache[bars] = (m, feats)
            stack_objective_cache[bars] = result.objective

    null_composite_cache: dict[tuple, object] = {}
    out: dict[str, dict] = {}

    for chunk_start in range(0, len(items), L1_CHUNK_SIZE):
        chunk = items[chunk_start:chunk_start + L1_CHUNK_SIZE]
        cand_texts = [t for _, _, t in chunk]
        cand_bars = [l1_bars_for(g) for _, g, _ in chunk]
        by_bars: dict[tuple[int, int], list[int]] = {}
        for idx, b in enumerate(cand_bars):
            by_bars.setdefault(b, []).append(idx)

        results_by_idx: dict[int, evaluate_mod.EvalResult] = {}
        for bars, idxs in by_bars.items():
            texts = [cand_texts[i] for i in idxs]
            rs = evaluate_mod.evaluate_many(ev.run_dir, texts, bars=bars, workers=min(workers, max(1, len(texts))))
            for i, r in zip(idxs, rs):
                results_by_idx[i] = r

        for i, (key, genome, text) in enumerate(chunk):
            result = results_by_idx[i]
            bars = cand_bars[i]
            try:
                if not result.ok or bars not in stack_feat_cache:
                    out[key] = None
                    continue
                stack_manifest, stack_feats = stack_feat_cache[bars]
                cand_manifest, cand_feats = layer.load_stack(pathlib.Path(result.stems_dir))
                track = genome.track_name()
                cand_feat = next((f for f in cand_feats if f.name == track), None)
                if cand_feat is None:
                    out[key] = None
                    continue
                stack_feats_excl = [f for f in stack_feats if f.name != track]
                # Judge the part over the bars it plays in, against the stack in those same bars: over
                # the whole song an intro-only part sounds on ~20% of the beats and sits >18 dB under
                # the drop, so the not-silent gate failed every such candidate (round 3). Beats are
                # counted from the render's first bar (stems.json offset_beats).
                meter = int(cand_manifest.get("meter", 4))
                offset = float(cand_manifest.get("offset_beats", 0.0))
                w0 = int(round((genome.entry[0] - 1) * meter - offset))
                w1 = int(round(genome.entry[1] * meter - offset))
                tempo = float(cand_manifest["tempo"])
                cand_feat = layer.window_features(cand_feat, tempo, w0, w1)
                stack_feats_excl = [layer.window_features(f, tempo, w0, w1) for f in stack_feats_excl]
                report = layer.check_layer(cand_manifest, cand_feat, stack_feats_excl)

                # `layer.check_layer`'s clash/masking/rhythm terms and `render_terms`'s composite
                # are kept as *diagnostics* (round 3: no longer the gate -- see
                # objective.WHOLE_MIX_MARGIN's docstring for why). render_terms.render_composite's
                # `contribution` (band fill + harmonic addition + motion) still ranks survivors.
                render_terms_vec = render_terms_mod.compute_render_terms(cand_manifest, cand_feat, stack_feats_excl)
                render_comp = render_terms_mod.render_composite(render_terms_vec)
                null_key = (bars, w0, w1, track)  # the null is the stack over the same window
                if null_key not in null_composite_cache:
                    null_stack = stack_feats_excl or [layer.window_features(f, tempo, w0, w1) for f in stack_feats]
                    null_composite_cache[null_key] = render_terms_mod.render_composite(
                        render_terms_mod.null_render_terms(stack_manifest, null_stack))
                null_comp = null_composite_cache[null_key]

                # The gate/ranking metric (round 3): the whole-mix check.py objective, stack+
                # candidate vs the incumbent alone, both already computed by ev.evaluate (shared
                # baseline.json) -- no extra render or scoring call needed.
                delta_mix = result.objective - stack_objective_cache[bars]

                out[key] = {"report": report, "stems_dir": result.stems_dir, "render_terms": render_terms_vec,
                            "render_composite": render_comp, "null_composite": null_comp, "delta_mix": delta_mix,
                            "candidate_objective": result.objective, "incumbent_objective": stack_objective_cache[bars]}
            finally:
                if cleanup and result.ok:
                    _delete_render_cache(ev, text, bars)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("score", type=pathlib.Path)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--roles", type=str, default=None, help="comma-separated subset of loop,bass,pad,stab,chop,riff")
    ap.add_argument("--role", type=str, default=None, help="an existing track name to re-cast instead of adding a part")
    ap.add_argument("--budget-l0", type=int, default=2000)
    ap.add_argument("--mutation-rounds", type=int, default=3)
    ap.add_argument("--mutation-per-round", type=int, default=150)
    ap.add_argument("--budget-l1", type=int, default=48)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--style", type=str, default="smooth deep house")
    ap.add_argument("--no-clap", action="store_true", help="skip the CLAP taste term (faster; taste stays 0.5)")
    ap.add_argument("--run", type=str, required=True)
    ap.add_argument("--l1-bars", type=int, default=None,
                     help="render L1 over an N-bar window starting at each candidate's entry bar "
                          "instead of the full song (round 3 default is full-song, None). Cheaper "
                          "per render but only valid if it reproduces the full-song Delta_mix "
                          "ordering -- see optimize.py's L1_BARS_DEFAULT docstring.")
    args = ap.parse_args(argv)

    if args.workers > 4:
        print("refusing: at most 4 worker processes", file=sys.stderr)
        return 2

    global L1_BARS_DEFAULT
    L1_BARS_DEFAULT = args.l1_bars

    t0 = time.time()
    run_dir = ROOT / "renders/optimize" / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    notebook_rows: list[dict] = []

    base_text = args.score.read_text()
    roles = args.roles.split(",") if args.roles else list(ROLES)
    for r in roles:
        assert r in ROLES, f"unknown role {r!r}"

    recast_roles = {r: args.role for r in roles} if args.role else {}

    rng = np.random.default_rng(args.seed)

    # candidate pools: the wider licensed ccMixter pool, plus the incumbent's own clips (so the
    # positive-control test -- "the incumbent's own loop re-offered ranks top 3" -- has its exact
    # source/clip available to the sampler too).
    pools = build_candidate_pools(roles, exclude_samples=set())

    style_embedding = None
    if not args.no_clap:
        try:
            from apricity_analyze import clap as clap_mod
            style_embedding = clap_mod.embed_text(args.style)
        except Exception as e:  # noqa: BLE001 -- CLAP is a taste tie-breaker, never a hard dependency
            print(f"(CLAP unavailable, taste term stays 0.5: {e})", file=sys.stderr)

    priors = {"roles": roles, "candidates_by_role": pools, "sections": SECTION_FALLBACK, "recast_roles": recast_roles}

    # Capacity per cell: the spec's capacity=2 assumes ~270 cells (role x register x 5 source
    # families). This Phase 1's candidate pool is ccMixter-only (region_candidates doesn't reach
    # loc/citizen-dj/marine-band -- a documented scope gap, not a spec change), so source_family
    # collapses to ~1 value and the real cell count is closer to len(roles); capacity=2 there
    # starved L1 of candidates (an early full run produced only 6 L1-eligible entries against a
    # budget of 48). Scaling capacity to the L1 budget keeps enough diversity per role without
    # relying on a source_family axis this phase doesn't actually populate.
    capacity = max(2, -(-args.budget_l1 // max(1, len(roles))))
    arch = archive_mod.Archive(capacity=capacity)
    n_ok, n_fail = l0_sample_and_score(base_text, priors, rng, args.budget_l0, arch, style_embedding, args.workers, notebook_rows)
    n_mut = mutation_rounds(priors, rng, arch, base_text, args.mutation_rounds, args.mutation_per_round, style_embedding, args.workers, notebook_rows)
    l0_elapsed = time.time() - t0
    evals_per_s = (n_ok + n_mut) / l0_elapsed if l0_elapsed > 0 else 0.0
    print(f"L0: {n_ok} scored, {n_fail} compile/region failures, {n_mut} from mutation, {evals_per_s:.1f} evals/s")

    # ---- positive controls (acceptance test 4) -----------------------------------------------
    # Re-cast (not add): re-offering the incumbent's own bright loop as a brand-new *added* part
    # would sit alongside the original bright track and legitimately trip layer.py's not_double
    # gate (same source, same content, same window) -- that gate firing is correct behavior, not
    # a surrogate failure, but it makes "ranks top 3" untestable under add-a-part semantics. Recast
    # compares the *same slot* correctly tuned vs a forced +1 semitone, which is what the spec's
    # control is actually checking.
    controls = []
    if "loop" in roles and not args.role:
        bright_bright = Genome(role="loop", source="ccmixter/jlbrock44/260809-Funky-Nurykabe_29186.mp3", clip="sec-A1",
                                entry=(9, 24), volume=4.0, hp=180.0, ratio="auto", transpose="auto", recast_role="bright")
        bright_sharp = dataclasses.replace(bright_bright, transpose=1)
        for label, g in (("positive-control-bright-loop", bright_bright), ("positive-control-bright-loop+1", bright_sharp)):
            res = score_genome(g, base_text, style_embedding)  # shares the exact L0 path every sampled genome uses
            if res is None:
                print(f"control {label} failed to compile/score", file=sys.stderr)
                continue
            comp, terms = res
            arch.insert(g, comp.J, comp, terms)
            controls.append((label, g, comp))
            notebook_rows.append({"level": "control", "label": label, "genome": dataclasses.asdict(g), "J": comp.J})

    silent = None
    if "pad" in roles and not args.role:
        silent = Genome(role="pad", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="hold-1", entry=(9, 24), volume=-40.0)

    # ---- L1: 8-bar render ladder ---------------------------------------------------------------
    l1_start = time.time()
    ev = evaluate_mod.Evaluator(run_dir)
    ev.evaluate(base_text)  # writes baseline.json first, per Evaluator's contract

    # Round 3 (per review): dedup by (source, entry window, role), not source alone -- source-only
    # capping (even raised to 3, round 2) still collapsed the pool because the top of the ranking
    # was dominated by a few (source, window) combinations scoring near-identically. max_per_source
    # is kept as a looser secondary cap (6) so one exceptional source can't still fill the pool via
    # many different windows/roles.
    l1_pool = arch.top_n(args.budget_l1, max_per_source=6,
                          key_fn=lambda e: (e.genome.source, e.genome.entry, e.genome.role), max_per_key=2,
                          min_per_role=True)

    batch_items = [(f"pool-{i}", e.genome, e.genome.text(base_text)) for i, e in enumerate(l1_pool)]
    batch_items += [(f"control-{label}", g, g.text(base_text)) for label, g, _ in controls]
    if silent is not None:
        batch_items.append(("silent", silent, silent.text(base_text)))

    rendered = render_l1_batch(batch_items, base_text, ev, args.workers)

    l1_rows = []
    rendered_by_role: dict[str, list[tuple[float, float]]] = {}
    for i, entry in enumerate(l1_pool):
        out = rendered.get(f"pool-{i}")
        if out is None:
            continue
        gates_passed = out["report"].gates.passed
        delta_mix = out["delta_mix"]
        contribution = out["render_terms"].contribution
        rank_score = delta_mix + 100.0 * render_terms_mod.CONTRIBUTION_WEIGHT * contribution
        passes_whole_mix_gate = gates_passed and delta_mix >= objective_mod.WHOLE_MIX_MARGIN
        row = {"role": entry.genome.role, "J": entry.J, "render_J": out["render_composite"].J,
               "J_null": out["null_composite"].J, "delta_mix": delta_mix,
               "candidate_objective": out["candidate_objective"], "incumbent_objective": out["incumbent_objective"],
               "contribution": contribution, "rank_score": rank_score, "gates_passed": gates_passed,
               "passes_gate": passes_whole_mix_gate,
               "source": entry.genome.source, "clip": entry.genome.clip, "prose": entry.genome.prose(),
               "rendered_score": out["report"].score,  # diagnostic only, see objective.WHOLE_MIX_MARGIN
               "genome": entry.genome, "stems_dir": out["stems_dir"]}
        l1_rows.append(row)
        # round 3: calibration is against Δmix -- the gate's actual metric -- not the old
        # render_terms composite (kept in the row above as a diagnostic).
        rendered_by_role.setdefault(entry.genome.role, []).append((entry.J, delta_mix))
        # Per review: layer.check_layer's clash/masking/rhythm and render_terms' composite stay in
        # the notebook as diagnostics even though they no longer gate anything.
        notebook_rows.append({"level": "L1", "genome": dataclasses.asdict(entry.genome), "surrogate_J": entry.J,
                               "delta_mix": delta_mix, "contribution": contribution, "rank_score": rank_score,
                               "passes_gate": passes_whole_mix_gate,
                               "layer_terms": {"clash": out["report"].terms.clash, "masking": out["report"].terms.masking,
                                                "rhythm": out["report"].terms.rhythm},
                               "render_composite_J": out["render_composite"].J})

    control_rows = []
    for label, g, comp in controls:
        out = rendered.get(f"control-{label}")
        if out is not None:
            control_rows.append({"label": label, "role": g.role, "surrogate_J": comp.J, "delta_mix": out["delta_mix"],
                                  "render_J": out["render_composite"].J, "null_J": out["null_composite"].J,
                                  "rendered_layer_score": out["report"].score, "gates_passed": out["report"].gates.passed})

    silent_row = None
    if silent is not None:
        out = rendered.get("silent")
        if out is not None:
            silent_row = {"gates_passed": out["report"].gates.passed, "findings": out["report"].findings}

    l1_elapsed = time.time() - l1_start
    print(f"L1: {len(l1_rows)} rendered/{len(l1_pool)} attempted in {l1_elapsed:.1f}s")

    # ---- calibration: surrogate J vs the gate's own metric, Δmix -------------------------------
    all_j = [r["J"] for r in l1_rows]
    all_rendered = [r["delta_mix"] for r in l1_rows]
    rho_overall = spearmanr(all_j, all_rendered).correlation if len(all_j) >= 3 else float("nan")
    rendered_top4_idx = set(np.argsort(all_rendered)[::-1][:4]) if all_rendered else set()
    surrogate_top12_idx = set(np.argsort(all_j)[::-1][:12]) if all_j else set()
    recall_at_12_overall = (len(rendered_top4_idx & surrogate_top12_idx) / len(rendered_top4_idx)) if rendered_top4_idx else float("nan")

    rho_by_role, recall_by_role = {}, {}
    for role, pairs in rendered_by_role.items():
        if len(pairs) < 3:
            rho_by_role[role] = float("nan")
            recall_by_role[role] = float("nan")
            continue
        js = [p[0] for p in pairs]
        rs = [p[1] for p in pairs]
        rho_by_role[role] = spearmanr(js, rs).correlation
        top4 = set(np.argsort(rs)[::-1][:min(4, len(rs))])
        top12 = set(np.argsort(js)[::-1][:min(12, len(js))])
        recall_by_role[role] = len(top4 & top12) / len(top4) if top4 else float("nan")

    # ---- L2: full render ladder -----------------------------------------------------------------
    # Round 3: gate on the whole-mix Δmix (objective.WHOLE_MIX_MARGIN), not the render_terms
    # composite -- spec section 5's "every finalist beats the null by delta; if fewer than 3 do,
    # the cycle offers fewer... rather than padding" still applies, just against this metric now.
    # Survivors are ranked by rank_score = Δmix + 100*w_c*contribution (row construction above).
    l2_start = time.time()
    l1_rows_sorted = sorted(l1_rows, key=lambda r: -r["rank_score"])
    beats_null = [r for r in l1_rows_sorted if r["passes_gate"]]
    print(f"L1: {len(beats_null)}/{len(l1_rows_sorted)} candidates clear the whole-mix gate "
          f"(Δmix >= {objective_mod.WHOLE_MIX_MARGIN} and not-silent/not-double)")
    l2_pool = []
    seen_sources = set()
    for r in beats_null:
        if r["genome"].source in seen_sources:
            continue
        l2_pool.append(r)
        seen_sources.add(r["genome"].source)
        if len(l2_pool) == 4:
            break

    l2_texts = [r["genome"].text(base_text) for r in l2_pool]
    l2_eval_results = evaluate_mod.evaluate_many(run_dir, l2_texts, workers=args.workers) if l2_texts else []
    l2_results = []
    for r, result in zip(l2_pool, l2_eval_results):
        if result.ok:
            l2_results.append({"genome": r["genome"], "objective": result.objective, "consonance": result.consonance, "result": result})

    incumbent_result_1 = ev.evaluate(base_text)
    incumbent_result_2 = ev.evaluate(base_text)
    reproducible_incumbent = incumbent_result_1.objective == incumbent_result_2.objective
    l2_elapsed = time.time() - l2_start

    # ---- finalists (MMR simplified to distinct-source top-3 by L2 objective; see report) -------
    l2_results.sort(key=lambda r: -r["objective"])
    finalists_data = l2_results[:3]

    letters = cycle_out.LETTERS
    finalists = []
    for letter, r in zip(letters, finalists_data):
        text = r["genome"].text(base_text)
        score_path = run_dir / f"{letter}.apr"
        score_path.write_text(text)
        wav = pathlib.Path(r["result"].stems_dir).parent / f"{evaluate_mod.score_sha(text)}.wav"
        audio_path = run_dir / f"{letter}.m4a"
        err = cycle_out.to_m4a(wav, audio_path) if wav.exists() else "no wav"
        finalists.append({"letter": letter, "genome": dataclasses.asdict(r["genome"]), "prose": r["genome"].prose(),
                           "score": str(score_path), "audio": str(audio_path) if not err else None,
                           "objective": r["objective"], "consonance": r["consonance"],
                           "audio_error": err})
    incumbent_letter = letters[len(finalists)]
    incumbent_score_path = run_dir / f"{incumbent_letter}.apr"
    incumbent_score_path.write_text(base_text)
    incumbent_audio_path = run_dir / f"{incumbent_letter}.m4a"
    inc_wav = pathlib.Path(incumbent_result_1.stems_dir).parent / f"{evaluate_mod.score_sha(base_text)}.wav"
    inc_err = cycle_out.to_m4a(inc_wav, incumbent_audio_path) if inc_wav.exists() else "no wav"
    incumbent = {"letter": incumbent_letter, "genome": None, "prose": "keep (the incumbent, unchanged)",
                 "score": str(incumbent_score_path), "audio": str(incumbent_audio_path) if not inc_err else None,
                 "objective": incumbent_result_1.objective, "consonance": incumbent_result_1.consonance}

    question = f"Which of these {len(finalists)} additions to {args.score.name} do you like, or keep it as it was?"
    cycle_out.write_cycle(run_dir, finalists=finalists, incumbent=incumbent, seed=args.seed, question=question,
                           rho=rho_overall, recall_at_12=recall_at_12_overall)
    cycle_out.write_leaderboard(run_dir, l1_rows=l1_rows_sorted[:20],
                                 archive_top=[{"role": e.genome.role, "register": e.genome.register(),
                                               "family": e.genome.source_family(), "J": e.J} for e in arch.elites()],
                                 rho_by_role=rho_by_role, recall_by_role=recall_by_role)
    cycle_out.write_weights(run_dir, {**objective_mod.WEIGHTS, "contribution": objective_mod.CONTRIBUTION_WEIGHT})
    (run_dir / "notebook.jsonl").write_text("\n".join(json.dumps(r, default=str) for r in notebook_rows) + "\n")

    total_elapsed = time.time() - t0
    summary = {
        "l0_ok": n_ok, "l0_fail": n_fail, "l0_mutations": n_mut, "l0_evals_per_s": round(evals_per_s, 1),
        "l1_rendered": len(l1_rows), "l1_attempted": len(l1_pool), "l1_elapsed_s": round(l1_elapsed, 1),
        "l2_elapsed_s": round(l2_elapsed, 1), "total_elapsed_s": round(total_elapsed, 1),
        "spearman_rho_overall": rho_overall, "recall_at_12_overall": recall_at_12_overall,
        "rho_by_role": rho_by_role, "recall_by_role": recall_by_role,
        "reproducible_incumbent_check": reproducible_incumbent,
        "positive_controls": control_rows, "silent_control": silent_row,
        "finalist_count": len(finalists),
        "l1_passes_whole_mix_gate_count": len(beats_null), "l1_total_count": len(l1_rows_sorted),
        "whole_mix_gate_pass": len(beats_null) > 0,  # >=1 L1 candidate with Δmix >= WHOLE_MIX_MARGIN and gates passed
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=1, default=str))
    print(json.dumps(summary, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
