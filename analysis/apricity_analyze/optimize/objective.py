"""Composite objective (spec section 4): `J = 100 * (1 - P) + 100 * w_c * contribution`, where
`P` is the weighted mean of the penalty terms (clash, chord, density, taste; masking/rhythm/
artefacts are render-only this phase, weight 0 at the surrogate level -- see `surrogate.py`'s
docstring) and `contribution` is the one positive term, in `[0, 1]`.

Deviation from the literal spec text (documented): the spec writes `J = 100*(1 - sum w_k p_k /
sum w_k) + w_c * contribution` with `w_c = 0.20` and `contribution` itself in `[0, 1]` -- read
literally that caps contribution's whole effect at +0.20 out of a ~100-point range, which cannot
satisfy the spec's own "no finalist beats the null by less than 2" acceptance test (the null's
contribution is exactly 0, so no candidate could ever clear a margin of 2). This module instead
scales the positive term onto the same 0-100 axis as the penalty term (`100 * w_c * contribution`),
which is the only reading under which the delta=2 margin and the "contribution weight 0.20 -> 0.25"
null-margin schedule (spec section 5) are on a consistent scale. Flagged in the optimizer's final
report as a spec ambiguity, not silently reinterpreted.
"""

from __future__ import annotations

import dataclasses

# Spec section 4's defaults (round 2: masking/rhythm added now that the surrogate reads the
# fitfeat sidecar and shares term definitions with layer.py's L1 terms -- see surrogate.py).
# clash + chord + masking + rhythm + density + taste = 0.90, the penalty pool; contribution is
# the separate positive term (w_c = 0.20).
WEIGHTS = {"clash": 0.30, "chord": 0.10, "masking": 0.15, "rhythm": 0.10, "density": 0.15, "taste": 0.10}
CONTRIBUTION_WEIGHT = 0.20

# Density penalty: linear from "no penalty" at DENSITY_OK to "full penalty" at DENSITY_BUSY,
# matching spec section 4's "penalty grows linearly from +25% to +60%" shape in spirit (Phase 1's
# density term is pattern-occupancy, not onset count -- see surrogate.py).
DENSITY_OK = 0.35
DENSITY_BUSY = 0.75


def density_penalty(density: float) -> float:
    if density <= DENSITY_OK:
        return 0.0
    if density >= DENSITY_BUSY:
        return 1.0
    return (density - DENSITY_OK) / (DENSITY_BUSY - DENSITY_OK)


@dataclasses.dataclass
class Composite:
    J: float
    P: float
    contribution: float
    penalties: dict
    ok: bool = True


def composite(terms, *, weights: dict | None = None, contribution_weight: float = CONTRIBUTION_WEIGHT) -> Composite:
    """`terms`: a `surrogate.SurrogateTerms` (or a render-stage equivalent with the same field
    names: `.clash`, `.chord`, `.density`, `.taste`, `.contribution`)."""
    if not getattr(terms, "ok", True):
        return Composite(J=0.0, P=1.0, contribution=0.0, penalties={}, ok=False)
    weights = weights or WEIGHTS
    penalties = {
        "clash": float(terms.clash),
        "chord": float(terms.chord),
        "masking": float(getattr(terms, "masking", 0.0)),
        "rhythm": float(getattr(terms, "rhythm", 0.0)),
        "density": density_penalty(float(terms.density)),
        "taste": float(terms.taste),
    }
    w_sum = sum(weights.get(k, 0.0) for k in penalties)
    p = sum(weights.get(k, 0.0) * v for k, v in penalties.items()) / w_sum if w_sum > 0 else 0.0
    contribution = float(terms.contribution)
    j = 100.0 * (1.0 - p) + 100.0 * contribution_weight * contribution
    return Composite(J=round(j, 3), P=round(p, 4), contribution=round(contribution, 4), penalties=penalties)


def null_composite() -> Composite:
    """The null control ("no new part"): every penalty is 0 (nothing was added to clash/mask
    against), contribution is 0 (nothing was added), so `J_null == 100.0` exactly, by
    construction -- this is what every finalist's `delta = J - J_null >= 2` is measured against."""
    return Composite(J=100.0, P=0.0, contribution=0.0, penalties={"clash": 0.0, "chord": 0.0, "density": 0.0, "taste": 0.0})


DELTA_MARGIN_DEFAULT = 2.0

# --------------------------------------------------------------------------- whole-mix gate (round 3; now measured on the window, round 4)
#
# Kanbus apricitus-a9ad5b round 3 (reviewer decision, 2026-09-27): L1 gating and ranking moved from
# `render_terms.render_composite` (a pairwise penalty score against `layer.check_layer`, whose null
# is 100 by construction -- no addition could ever clear a positive margin against it, and it
# charges a candidate's onset correlation with the stack as a rhythm *penalty* even when that
# correlation is exactly the "locks into the groove" a listener wants) to the whole-mix objective:
# `check.py`'s own objective (the same function `scripts/check-stems.py` calls), computed once for
# the incumbent alone and once for stack+candidate together, over the same bars window. Round 3
# rendered the *full* song for both sides to make that "same window" true cheaply (see
# `scripts/optimize.py`'s old `L1_BARS_DEFAULT` comment, now superseded).
#
# Round 4 (Kanbus apricitus-dbed5c, 2026-09-27): `Δmix` is now measured on an 8-bar audition
# window W (`audition_form.choose_window` / the candidate's own entry bars when they're already 8
# bars), not the full song -- `obj(candidate)` and `obj(incumbent)` are both rendered over that
# same W (`audition_form.together_objective` / `scene_baseline_objective`), which is the literal
# fix for the mismatch round 3 worked around by paying for a full-song render every time. The name
# `WHOLE_MIX_MARGIN` and this margin's value are kept unchanged -- re-validated, not re-fit (see
# apricitus-dbed5c's report): re-scoring `ave-house-seed7-run2`'s A/B/C with Δwindow over each
# candidate's own entry window reproduced the ordering below on the numbers that mattered.
#
# The margin is fit to one real listening data point, not guessed: the user's blind-unblind
# verdict on `renders/optimize/ave-house-seed7-run2` (kind `listen-note`, logged in
# `renders/log.jsonl` in the `example-scores-editing-deaa37` worktree, 2026-09-27T10:12:05), on the
# *full-song* Δmix that existed at the time:
#   incumbent objective 84.38; A 84.1 (Δ=-0.28, "welcome"); B 82.21 (Δ=-2.17, "welcome");
#   C 69.98 (Δ=-14.40, lowest-rated of the three, still "sound pretty good" but clearly the worst).
# The user's own words: "They all sound pretty good. I generally agree with the quantifications
# from the checker." -- i.e. a small negative Δ (a near-tie) is a welcome addition, and -14 is
# where quality visibly drops. WHOLE_MIX_MARGIN=-2.0 sits at B's full-song Δ (a tie-tolerance, not
# a requirement that an addition strictly improve the mix), so B lands right at the boundary
# ("borderline") rather than comfortably inside or outside it -- consistent with one data point,
# not fit to make B pass or fail either way. The window-based numbers move (a window is a smaller,
# noisier sample than the whole song) but the margin is left at the value calibrated against the
# user's actual verdict rather than re-tuned to force any particular window-Δ to land exactly on
# it -- see the report for the specific re-validation numbers.
WHOLE_MIX_MARGIN = -2.0
