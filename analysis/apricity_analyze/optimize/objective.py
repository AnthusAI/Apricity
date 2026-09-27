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

# Spec section 4's defaults (masking/rhythm use the surrogate's fitfeat-sidecar terms, shared
# with layer.py's L1 terms -- see surrogate.py).
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

# --------------------------------------------------------------------------- whole-mix gate
#
# L1 gating and ranking work on the whole-mix objective: `check.py`'s own objective (the same
# function `scripts/check-stems.py` calls), computed once for the incumbent alone and once for
# stack+candidate together, over the same bars window (`audition_form.choose_window` / the
# candidate's own entry bars when they're already window-length) -- `obj(candidate)` and
# `obj(incumbent)` are both rendered over that same window (`audition_form.together_objective` /
# `scene_baseline_objective`), so the two sides are always compared on identical material instead
# of a full-song render standing in for a slice of it.
#
# `Δmix = obj(stack+candidate) - obj(incumbent)` is not required to be positive: a small negative
# Δ (a near-tie) still counts as a welcome addition, since adding a part can cost a little mix
# quality while still being worth having. `WHOLE_MIX_MARGIN` is the tie-tolerance below which a
# candidate is rejected as a net loss rather than a near-tie. It is calibrated against recorded
# listening verdicts, not guessed or derived analytically -- see the verdict log
# (`renders/log.jsonl`) and Kanbus apricitus-a9ad5b / apricitus-dbed5c for how it was set and
# re-validated.
WHOLE_MIX_MARGIN = -2.0
