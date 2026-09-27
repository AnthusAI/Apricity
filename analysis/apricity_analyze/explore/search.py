"""The explorer's two-level search: successive halving over casts (the outer loop), each refined
by first-improvement coordinate descent over operator proposals built from the checker's own
findings (the inner loop). See the module docstring in `ops.py` for the operator whitelist, and
`evaluate.py` for how a score gets rendered/checked/cached.
"""

from __future__ import annotations

import dataclasses
import json
import pathlib
import subprocess

from .. import check as checker
from . import candidates as candidates_mod
from . import evaluate as evaluate_mod
from . import notch as notch_mod
from . import ops as ops_mod
from .notebook import Notebook

TRAIN_BARS = (9, 24)
HOLDOUT_BARS = (33, 40)
ACCEPT_MARGIN = 0.5
INNER_BUDGET = 8
NOTCH_GAIN, NOTCH_Q = -6, 8


def accept_candidate(*, ok: bool, train_objective: float, holdout_ok: bool, holdout_objective: float,
                      guard_violation_count: int, best_train: float, best_holdout: float, best_violation_count: int) -> bool:
    """The inner loop's accept rule, pulled out as a pure function so it's directly testable
    without rendering anything: improve the training-window objective by at least
    `ACCEPT_MARGIN`, don't drop the holdout objective, and don't increase the guard-violation
    count. (Violation *text* carries exact numbers that shift slightly render to render even when
    the underlying issue is unchanged, so counting violations is the practical stand-in here for
    "no new guard violation" -- an exact-set comparison would reject almost everything.)"""
    if not ok:
        return False
    if (train_objective - best_train) < ACCEPT_MARGIN:
        return False
    if not holdout_ok or holdout_objective < best_holdout - 1e-9:
        return False
    if guard_violation_count > best_violation_count:
        return False
    return True


def diverse_top_n(ranked: list, n: int, source_of) -> list:
    """The first `n` items from `ranked` (already best-first), skipping any whose `source_of(item)`
    has already been kept -- successive halving's "at most one survivor per source recording"."""
    kept, seen = [], set()
    for item in ranked:
        source = source_of(item)
        if source in seen:
            continue
        seen.add(source)
        kept.append(item)
        if len(kept) == n:
            break
    return kept


def compiles(text: str) -> tuple[bool, str]:
    tmp = evaluate_mod.ROOT / "renders" / "explore" / ".compile-check.apr"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(evaluate_mod.absolutize_samples(text))
    r = subprocess.run([str(evaluate_mod.BIN), "compile", str(tmp)], capture_output=True, text=True)
    return r.returncode == 0, r.stderr.strip()


def explain(text: str) -> str:
    """The pre-registered prediction for a candidate, before it's rendered: `apricity explain`'s
    own account of how the harmony solver placed every track (which chord fit, which
    transposition, whether it's on-chord). Truncated for storage; empty string on failure (never
    blocks the search)."""
    tmp = evaluate_mod.ROOT / "renders" / "explore" / ".explain-check.apr"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(evaluate_mod.absolutize_samples(text))
    r = subprocess.run([str(evaluate_mod.BIN), "explain", str(tmp)], capture_output=True, text=True)
    return r.stdout[:4000] if r.returncode == 0 else f"(explain failed: {r.stderr.strip()[:200]})"


def _track_field(text: str, track: str, option: str) -> str | None:
    import re
    m = re.search(rf"^track\s+{re.escape(track)}\b.*?\b{option}\s+(\S+)", text, re.M)
    return m.group(1) if m else None


def _note_semitone(note: str) -> tuple[str, int] | None:
    """"Ab1" -> ("Ab", 1) etc."""
    import re
    m = re.match(r"([A-Ga-g](?:#|b)?)(-?\d+)", note)
    return (m.group(1), int(m.group(2))) if m else None


NOTE_ORDER = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def _shift_note(note: str, semitones: int) -> str | None:
    parsed = _note_semitone(note)
    if not parsed:
        return None
    name, octave = parsed
    if name not in NOTE_ORDER:
        return None
    idx = NOTE_ORDER.index(name) + semitones
    return f"{NOTE_ORDER[idx % 12]}{octave + idx // 12}"


# A category can keep re-proposing "slightly different" variants forever (a bass fix relative to
# whatever the *current* root is, after each accepted nudge) without ever exactly repeating, so
# the `tried`-by-exact-op dedup alone can't stop it from eating the whole budget on one category
# when that category isn't actually where the problem is (see `test_bass_category_is_capped...`).
CATEGORY_CAPS = {"bass": 1, "notch": 3}


def propose(text: str, role: str, report, manifest: dict, stems: list, tried: set[str]) -> list[tuple[str, dict]]:
    """`[(category, op), ...]` in priority order: bass ops (when the checker's own bass reference
    leads leave-one-out), notches (from the ported notch-finder, ranked by how many chords they're
    wrong under and then by energy), the next transposition, a highpass, then release. Each
    category is capped (`CATEGORY_CAPS`) by the caller across the whole inner-loop run, not just
    within one call, so an unproductive category can't starve the rest of the budget."""
    props: list[tuple[str, dict]] = []

    def add(category: str, op: dict) -> None:
        key = json.dumps(op, sort_keys=True)
        if key not in tried:
            props.append((category, op))

    bass = checker.choose_bass(stems)
    loo_leader = report.leave_one_out[0][0] if report.leave_one_out else None

    # 1. Bass ops: only when the checker's own bass reference is the leading clash contributor.
    if bass is not None and loo_leader == bass.name and bass.pitch:
        note = bass.pitch.split()[0]  # "Ab1 (pinned)" -> "Ab1"
        if _note_semitone(note):
            for semis in (-1, 1, -2, 2):
                shifted = _shift_note(note, semis)
                if shifted:
                    add("bass", {"op": "clip.root", "clip": bass.name, "note": shifted})
        octave = _track_field(text, bass.name, "octave")
        if octave is not None:
            n = int(octave)
            add("bass", {"op": "track.octave", "track": bass.name, "n": n + 1})
            add("bass", {"op": "track.octave", "track": bass.name, "n": n - 1})

    # 2. Notches: the role's own stem (and the current leave-one-out leader, if different and
    # pitched), ranked by how many chords they're wrong under, then by energy share.
    notch_targets = [role]
    if loo_leader and loo_leader != role and loo_leader not in notch_targets:
        notch_targets.append(loo_leader)
    stems_dir = pathlib.Path(manifest["_stems_dir"]) if "_stems_dir" in manifest else None
    if stems_dir is not None:
        try:
            found = notch_mod.find_notches(stems_dir, [n for n in notch_targets if (stems_dir / f"{n}.wav").exists()])
        except Exception:  # noqa: BLE001 -- notch-finding is best-effort, never fatal to the search
            found = {}
        for track, notes in found.items():
            for entry in notes[:3]:
                add("notch", {"op": "track.eq_notch", "track": track, "hz": int(round(float(entry["hz"]))), "gain": NOTCH_GAIN, "q": NOTCH_Q})

    # 3. Next-best transposition: back to auto if it's fixed; otherwise the two nearest fixed
    # alternatives (an octave either way covers the common "flip-flop" case).
    current_transpose = _track_field(text, role, "transpose")
    if current_transpose and current_transpose not in ("auto",):
        add("transpose", {"op": "track.transpose", "track": role, "value": "auto"})
    if current_transpose and current_transpose.lstrip("+-").isdigit():
        n = int(current_transpose)
        add("transpose", {"op": "track.transpose", "track": role, "value": n + 12})
        add("transpose", {"op": "track.transpose", "track": role, "value": n - 12})

    # 4. Subtractive processing: a highpass, if the role doesn't already have one.
    if "filter hp" not in (_role_line(text, role) or ""):
        add("hp", {"op": "track.hp", "track": role, "hz": 150, "slope": "24dB", "on": True})

    # 5. Release, as a last resort.
    release = _track_field(text, role, "release")
    if release:
        ms = float(release.rstrip("ms"))
        add("release", {"op": "track.release", "track": role, "ms": round(ms * 1.5, 1)})
        add("release", {"op": "track.release", "track": role, "ms": round(ms * 0.5, 1)})
    else:
        add("release", {"op": "track.release", "track": role, "ms": 200})

    return props


def _role_line(text: str, role: str) -> str | None:
    import re
    m = re.search(rf"^track\s+{re.escape(role)}\b.*$", text, re.M)
    return m.group(0) if m else None


def inner_loop(base_text: str, *, role: str, evaluator: evaluate_mod.Evaluator, notebook: Notebook,
                train_bars=TRAIN_BARS, holdout_bars=HOLDOUT_BARS, budget=INNER_BUDGET, stage="inner") -> tuple[str, list[dict], float]:
    """First-improvement coordinate descent: accept a proposal only if the training-window
    objective improves by >= ACCEPT_MARGIN, the holdout objective doesn't drop, and the number of
    guard violations doesn't increase (a practical stand-in for "no new violation": violation text
    carries exact numbers that shift from render to render, so exact-string identity is too
    brittle -- see the module's tests). Stops after a full sweep proposes nothing new, or the
    budget of renders runs out."""
    current_text, current_ops = base_text, []
    tried: set[str] = set()
    trials = 0
    category_attempts: dict[str, int] = {}

    tr = evaluator.evaluate(current_text, bars=train_bars, allow_mute=None)
    ho = evaluator.evaluate(current_text, bars=holdout_bars, allow_mute=None)
    if not tr.ok:
        return current_text, current_ops, 0.0
    best_train, best_holdout, best_violation_count = tr.objective, (ho.objective if ho.ok else 0.0), len(tr.guard_violations)

    base_sha = evaluate_mod.score_sha(base_text)
    while trials < budget:
        try:
            manifest_d, stems = checker.load_stems(pathlib.Path(tr.stems_dir))
        except Exception:  # noqa: BLE001
            break
        manifest_d["_stems_dir"] = tr.stems_dir
        report = checker.evaluate(manifest_d, stems)
        # Enforce each category's cap *within* this sweep's list too, not just across sweeps: a
        # single `propose()` call can return several ops in a capped category at once (e.g. 4
        # bass-root shifts plus 2 octave shifts), and consuming a whole sweep's worth of them
        # before the running count is rechecked would blow straight through the cap.
        running = dict(category_attempts)
        proposals = []
        for cat, p in propose(current_text, role, report, manifest_d, stems, tried):
            if json.dumps(p, sort_keys=True) in tried or running.get(cat, 0) >= CATEGORY_CAPS.get(cat, 999):
                continue
            running[cat] = running.get(cat, 0) + 1
            proposals.append((cat, p))
        if not proposals:
            break
        made_progress = False
        for cat, p in proposals:
            if trials >= budget:
                break
            trials += 1
            category_attempts[cat] = category_attempts.get(cat, 0) + 1
            tried.add(json.dumps(p, sort_keys=True))
            try:
                candidate_text = ops_mod.apply(current_text, p)
            except ops_mod.OpError as e:
                notebook.log({"stage": stage, "ops": [p], "accepted": False, "reason": f"op error: {e}"})
                continue
            ok, err = compiles(candidate_text)
            if not ok:
                notebook.log({"stage": stage, "ops": [p], "accepted": False, "reason": f"doesn't compile: {err[:200]}"})
                continue
            predicted = explain(candidate_text)
            c_tr = evaluator.evaluate(candidate_text, bars=train_bars, allow_mute=None)
            c_ho = evaluator.evaluate(candidate_text, bars=holdout_bars, allow_mute=None)
            exp_id = notebook.new_experiment_id(stage)
            notebook.save_experiment(exp_id, base_sha=base_sha, ops_list=current_ops + [p], predicted=predicted,
                                      score_text=candidate_text, check_json=c_tr.report)
            accept = accept_candidate(
                ok=c_tr.ok, train_objective=c_tr.objective, holdout_ok=c_ho.ok, holdout_objective=c_ho.objective,
                guard_violation_count=len(c_tr.guard_violations),
                best_train=best_train, best_holdout=best_holdout, best_violation_count=best_violation_count,
            )
            notebook.log({
                "exp_id": exp_id, "stage": stage, "ops": [p], "description": ops_mod.describe(p),
                "train_objective": c_tr.objective if c_tr.ok else None,
                "holdout_objective": c_ho.objective if c_ho.ok else None,
                "guard_violations": c_tr.guard_violations, "accepted": accept, "error": c_tr.error,
            })
            if accept:
                # Disk (apricitus-ae80d4): the old current's render is never read again once a
                # better one replaces it (`tr` is about to be reassigned) -- delete it now rather
                # than at the end of the whole outer loop. The *new* current (`c_tr`/`c_ho`)
                # stays cached: the top of the next sweep reads `tr.stems_dir`.
                evaluate_mod.delete_cache(evaluator, current_text, train_bars)
                evaluate_mod.delete_cache(evaluator, current_text, holdout_bars)
                current_text, current_ops = candidate_text, current_ops + [p]
                best_train, best_holdout, best_violation_count = c_tr.objective, c_ho.objective, len(c_tr.guard_violations)
                tr = c_tr
                made_progress = True
                break  # first-improvement: re-propose from the new current best
            else:
                # A rejected trial's render is pure waste: nothing reads it again (the notebook
                # already has its numbers via `save_experiment(check_json=c_tr.report)`).
                evaluate_mod.delete_cache(evaluator, candidate_text, train_bars)
                evaluate_mod.delete_cache(evaluator, candidate_text, holdout_bars)
        if not made_progress:
            break
    # The final current's render (read on every sweep above) isn't needed by the caller: stage 3
    # re-renders the winning text in full anyway.
    evaluate_mod.delete_cache(evaluator, current_text, train_bars)
    evaluate_mod.delete_cache(evaluator, current_text, holdout_bars)
    return current_text, current_ops, best_train


def outer_loop(base_text: str, *, role: str, cast_list: list[candidates_mod.Candidate], run_dir: pathlib.Path,
                workers: int = 4, train_bars=TRAIN_BARS, holdout_bars=HOLDOUT_BARS, inner_budget=INNER_BUDGET,
                archive: pathlib.Path | None = None) -> dict:
    """Successive halving: 12 casts x 1 eval -> top 4 (one per source) x `inner_budget` inner
    evals -> full renders of the top 3 plus the incumbent."""
    notebook = Notebook(run_dir, meta={"role": role, "workers": workers, "train_bars": train_bars,
                                        "holdout_bars": holdout_bars, "inner_budget": inner_budget,
                                        "candidates": [dataclasses.asdict(c) for c in cast_list]}, archive=archive)
    evaluator = evaluate_mod.Evaluator(run_dir)

    # The incumbent goes first and alone: it writes the run's one shared baseline.json before any
    # parallel candidate work starts (see `Evaluator`'s docstring).
    incumbent_train = evaluator.evaluate(base_text, bars=train_bars)
    notebook.log({"stage": "incumbent", "objective": incumbent_train.objective, "ok": incumbent_train.ok, "error": incumbent_train.error})

    # Stage 1: one training-window eval per cast, in parallel.
    staged = []
    for c in cast_list:
        try:
            t = ops_mod.apply(base_text, {"op": "cast.swap", "role": role, "sample": c.sample, "clip": c.clip})
        except ops_mod.OpError as e:
            notebook.log({"stage": "stage1", "cast": f"{c.sample} {c.clip}", "ok": False, "error": str(e)})
            continue
        ok, err = compiles(t)
        if not ok:
            notebook.log({"stage": "stage1", "cast": f"{c.sample} {c.clip}", "ok": False, "error": err[:200]})
            continue
        staged.append((c, t))
    results = evaluate_mod.evaluate_many(run_dir, [t for _, t in staged], bars=train_bars, workers=workers)
    for (c, _t), r in zip(staged, results):
        notebook.log({"stage": "stage1", "cast": f"{c.sample} {c.clip}", "objective": r.objective, "ok": r.ok, "error": r.error})

    ranked = sorted(zip(staged, results), key=lambda x: -(x[1].objective if x[1].ok else -1e9))

    # Top 4, diversity: at most one survivor per source recording.
    top4 = diverse_top_n([(c, t) for (c, t), r in ranked if r.ok], 4, source_of=lambda item: item[0].source)

    # Disk (apricitus-ae80d4): stage 1 renders every cast's training-window audio, but only the
    # top 4 ever get read again (by stage 2's inner_loop, which re-evaluates and gets a cache
    # hit). Delete the losing casts' renders right away instead of leaving them in .cache for the
    # rest of the run -- an 8-candidate run kept every one of them and hit 3.8 GB.
    top4_texts = {t for _, t in top4}
    for (c, t), r in zip(staged, results):
        if r.ok and t not in top4_texts:
            evaluate_mod.delete_cache(evaluator, t, train_bars)

    # Stage 2: inner loop (up to `inner_budget` evals) per surviving cast.
    stage2 = []
    for c, t in top4:
        best_text, best_ops, best_obj = inner_loop(t, role=role, evaluator=evaluator, notebook=notebook,
                                                     train_bars=train_bars, holdout_bars=holdout_bars,
                                                     budget=inner_budget, stage=f"stage2-{_safe(c.source)}")
        stage2.append((c, best_text, best_ops, best_obj))
        notebook.log({"stage": "stage2-result", "cast": f"{c.sample} {c.clip}", "objective": best_obj, "ops": best_ops})

    stage2.sort(key=lambda x: -x[3])
    top3 = stage2[:3]

    # Stage 3: full renders (no --bars) of the top 3 plus the incumbent -- and a control re-eval
    # of the incumbent (a determinism check: same text, should give the identical objective).
    full_texts = [base_text, base_text] + [t for _, t, _, _ in top3]
    full_results = evaluate_mod.evaluate_many(run_dir, full_texts, bars=None, workers=min(workers, len(full_texts)))
    incumbent_full, incumbent_full_control, *cast_fulls = full_results
    notebook.log({"stage": "determinism-control", "objective_1": incumbent_full.objective, "objective_2": incumbent_full_control.objective,
                  "identical": incumbent_full.objective == incumbent_full_control.objective})

    rows = [{"label": "(incumbent)", "objective": incumbent_full.objective if incumbent_full.ok else -1,
             "consonance": incumbent_full.consonance if incumbent_full.ok else 0.0, "attribution": "", "text": base_text, "result": incumbent_full}]
    for (c, t, opslist, _), r in zip(top3, cast_fulls):
        rows.append({"label": f"{c.sample} {c.clip} + {len(opslist)} fix(es)", "objective": r.objective if r.ok else -1,
                     "consonance": r.consonance if r.ok else 0.0, "attribution": c.attribution, "text": t, "result": r})
    rows.sort(key=lambda r: -r["objective"])
    notebook.write_leaderboard(rows)

    best = rows[0]
    wav_path = pathlib.Path(best["result"].stems_dir).parent / (pathlib.Path(best["result"].stems_dir).stem + ".wav") if best["result"].stems_dir else None
    notebook.finalize_best(best["text"], wav_path)

    # Disk (apricitus-ae80d4): stage 3's full renders (the biggest ones -- a whole song's worth of
    # stems each) are only needed to pick `best` and write the leaderboard/best.wav/best.apr,
    # all done above. The Evaluator's own `baseline.json` (the incumbent's shared reference
    # objective) lives outside `.cache/` and is untouched by this; every candidate's `.cache`
    # entry -- including the incumbent's and `best`'s own -- is deleted now that nothing in this
    # run still needs to read from it.
    for row in rows:
        if row["result"].ok:
            evaluate_mod.delete_cache(evaluator, row["text"], None)

    return {"rows": rows, "run_dir": run_dir, "best": best}


def _safe(s: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in s)[:24]
