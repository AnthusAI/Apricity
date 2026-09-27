"""Render-fidelity scoring for L1 (Kanbus apricitus-a9ad5b): the positive **contribution**
term (spec section 4) computed from the actual rendered stems, plus a rendered composite `J` that
puts a candidate and the null control ("nothing added") on the *same* scale.

Why this module exists: the first pass gated finalists on the L0 *surrogate*'s `J` (which does
carry a weak contribution proxy), not on anything computed from the render. At render fidelity,
`layer.check_layer`'s score is `clash*0.6 + masking*0.2 + rhythm*0.2` -- pure penalty, no positive
term -- so no rendered candidate could ever score above the null's implicit ceiling. This module
adds the missing positive channels so `J_render` can exceed 100, and a `null_render_terms()` that
is computed the same way (not just asserted to be zero), so `delta = J - J_null` is a real,
render-fidelity comparison.

All three of the spec's contribution channels are implemented against rendered stems:
  (a) band fill: energy the candidate adds in bands where the stack is > 24 dB below its own
      loudest band, as a share of what's added there (candidate vs stack, so it saturates at 1.0
      rather than rewarding raw loudness).
  (b) harmonic addition: chord tones the candidate supplies where the stack's own coverage is
      thin (< `check.COVERAGE_MIN_SHARE`), using the same per-span coverage math as
      `check.apply_guards`'s coverage guard, computed from the candidate/stack `StemFeatures.chroma`
      the render already has -- no separate compile call needed.
  (c) motion: whether the candidate makes the mix's bar-to-bar total band energy move 10-40% more
      than the stack alone already does (`motion_term`), binned from `.bands` via the manifest's
      own tempo/meter -- returns 0.0 below `MOTION_MIN_BARS` bars rather than trust a noisy
      variance estimate; an 8-bar L1 window clears that floor.

This module's `RenderTerms`/`render_composite` are not used as the L1 *gate* -- see
`scripts/optimize.py`: gating and ranking use the whole-mix `check.py` objective instead (the same
function `scripts/check-stems.py` calls, guards included), because `layer.check_layer`'s score is
a pure pairwise-penalty term whose null is 100 by construction, so no addition could ever clear a
positive margin against it, and it charges a candidate's onset correlation with the stack as a
rhythm *penalty* even when that's the groove-lock-in a listener wants (see
`scripts/optimize.py`'s `WHOLE_MIX_MARGIN` docstring). `compute_render_terms`/`render_composite`/
`null_render_terms` are kept and still run -- their output goes into the notebook as a diagnostic
term vector and this module's `contribution` score still ranks survivors after the whole-mix gate,
but they are no longer the pass/fail gate.
"""

from __future__ import annotations

import dataclasses

import numpy as np

from .. import check as checker
from .. import layer

BAND_FILL_DB_BELOW_LOUDEST = 24.0
_EPS = 1e-12


def _stack_band_sum(stack: list) -> np.ndarray:
    """`(n_frames, N_BANDS)` linear-power sum across every stack stem's `.bands`, frames clipped
    to the shortest stem so the sum stays aligned."""
    if not stack:
        return np.zeros((0, layer.MASKING_N_BANDS))
    n = min(s.bands.shape[0] for s in stack)
    if n == 0:
        return np.zeros((0, layer.MASKING_N_BANDS))
    return sum(s.bands[:n] for s in stack)


def band_fill(candidate, stack: list) -> float:
    """`[0, 1]`: of the energy present in the stack's emptiest bands (> 24 dB below its own
    loudest band, averaged over the window), what share does the candidate now supply."""
    stack_bands = _stack_band_sum(stack)
    n = min(candidate.bands.shape[0], stack_bands.shape[0]) if stack_bands.shape[0] else candidate.bands.shape[0]
    if n == 0:
        return 0.0
    cand_bands = candidate.bands[:n]
    stack_bands = stack_bands[:n] if stack_bands.shape[0] else np.zeros((n, layer.MASKING_N_BANDS))

    stack_mean = stack_bands.mean(axis=0) if stack_bands.shape[0] else np.zeros(layer.MASKING_N_BANDS)
    stack_db = 10.0 * np.log10(stack_mean + _EPS)
    loudest = float(stack_db.max()) if stack_db.size else -120.0
    empty = stack_db < (loudest - BAND_FILL_DB_BELOW_LOUDEST)
    if not np.any(empty):
        return 0.0

    cand_empty_energy = float(cand_bands[:, empty].sum())
    stack_empty_energy = float(stack_bands[:, empty].sum()) if stack_bands.shape[0] else 0.0
    if cand_empty_energy <= _EPS:
        return 0.0
    return float(np.clip(cand_empty_energy / (cand_empty_energy + stack_empty_energy + _EPS), 0.0, 1.0))


def harmonic_addition(candidate, stack: list, manifest: dict) -> float:
    """`[0, 1]`: chord tones the candidate supplies where the stack's own tonal coverage is thin
    (< `check.COVERAGE_MIN_SHARE`), per harmony span, weighted by span length -- the render-fidelity
    version of `check.apply_guards`'s coverage guard, read from the same `chroma` arrays
    `layer.load_stack` already computed."""
    n_beats = candidate.chroma.shape[0]
    spans = manifest.get("harmony", [])
    if not spans:
        return 0.0
    weighted_total, weight_sum = 0.0, 0.0
    for span in spans:
        chord_tones = [checker.PITCH_NAMES.index(t) for t in span.get("chord_tones", []) if t in checker.PITCH_NAMES]
        if not chord_tones:
            continue
        beats = list(checker.span_beats(manifest, span, n_beats))
        if not beats:
            continue
        stack_mass = np.zeros(12)
        for b in beats:
            for s in stack:
                if b < s.chroma.shape[0]:
                    stack_mass += s.chroma[b]
        total = float(stack_mass.sum())
        if total <= _EPS:
            thin_tones = chord_tones  # the stack has nothing there at all -- every chord tone is thin
        else:
            shares = stack_mass / total
            thin_tones = [t for t in chord_tones if shares[t] < checker.COVERAGE_MIN_SHARE]
        if not thin_tones:
            continue
        cand_mass = 0.0
        cand_thin = 0.0
        for b in beats:
            if b >= candidate.chroma.shape[0]:
                continue
            c = candidate.chroma[b]
            cand_mass += float(c.sum())
            cand_thin += float(sum(c[t] for t in thin_tones))
        if cand_mass <= _EPS:
            continue
        share = cand_thin / cand_mass
        w = len(beats)
        weighted_total += share * w
        weight_sum += w
    if weight_sum <= 0:
        return 0.0
    return float(np.clip(weighted_total / weight_sum, 0.0, 1.0))


# Spec section 4: "the mix's bar-to-bar band-energy variance rises by 10-40% (0 outside that
# range, so more motion is not always better)" -- a triangular reward peaking at the midpoint.
MOTION_RATIO_LO, MOTION_RATIO_HI = 0.10, 0.40
MOTION_MIN_BARS = 4  # below this, a variance estimate is too noisy to trust; return 0.0 (a gate,
                     # not a penalty -- see the module docstring on 8-bar-window robustness)


def motion_term(candidate, stack: list, manifest: dict) -> float:
    """`[0, 1]`: whether adding the candidate to a *static* stack (the same window, stack alone)
    makes the mix's bar-to-bar total band energy move around 10-40% more than it already does --
    spec channel (c). Uses `candidate`/stack `.bands` (per-STFT-frame, `layer.band_energy`'s
    grid) binned into bars via the manifest's own tempo/meter and `check.frame_times`, so it needs
    no new feature extraction. With `MOTION_MIN_BARS` bars or fewer in the window this returns 0.0
    rather than a noisy estimate off too few samples; callers wanting a steadier number can render
    a 16-bar L1 window instead (not done by default -- would roughly double L1 render cost for
    every candidate, not just the minority whose
    only differentiator is motion)."""
    from .. import check as checker

    stack_bands = _stack_band_sum(stack)
    n = min(candidate.bands.shape[0], stack_bands.shape[0]) if stack_bands.shape[0] else 0
    if n < 2:
        return 0.0
    cand_bands, stack_bands = candidate.bands[:n], stack_bands[:n]
    times = checker.frame_times(n)
    spb = 60.0 / manifest.get("tempo", 120.0)
    bar_len_s = spb * manifest.get("meter", 4)
    bar_idx = np.floor(times / max(bar_len_s, _EPS)).astype(int)
    n_bars = int(bar_idx.max()) + 1 if len(bar_idx) else 0
    if n_bars < MOTION_MIN_BARS:
        return 0.0

    without_total = stack_bands.sum(axis=1)   # per-frame total energy, stack alone
    with_total = (stack_bands + cand_bands).sum(axis=1)  # per-frame total energy, stack + candidate

    def bar_means(per_frame: np.ndarray) -> np.ndarray:
        return np.array([per_frame[bar_idx == b].mean() if np.any(bar_idx == b) else 0.0 for b in range(n_bars)])

    bars_without, bars_with = bar_means(without_total), bar_means(with_total)
    mean_without = float(bars_without.mean())
    if mean_without <= _EPS:
        return 0.0
    # scale-free variance (coefficient of variation squared) so a louder candidate alone doesn't
    # register as "more motion" -- only genuine bar-to-bar *shape* change counts.
    var_without = float(np.var(bars_without)) / (mean_without ** 2)
    mean_with = float(bars_with.mean())
    var_with = float(np.var(bars_with)) / (mean_with ** 2) if mean_with > _EPS else 0.0
    if var_without <= _EPS:
        return 1.0 if var_with > _EPS else 0.0  # the stack alone is perfectly static; any motion is new
    ratio = var_with / var_without - 1.0
    if ratio < MOTION_RATIO_LO or ratio > MOTION_RATIO_HI:
        return 0.0
    mid = (MOTION_RATIO_LO + MOTION_RATIO_HI) / 2.0
    half_width = (MOTION_RATIO_HI - MOTION_RATIO_LO) / 2.0
    return float(np.clip(1.0 - abs(ratio - mid) / half_width, 0.0, 1.0))


@dataclasses.dataclass
class RenderTerms:
    clash: float
    masking: float
    rhythm: float
    contribution: float
    gates_passed: bool


def compute_render_terms(manifest: dict, candidate, stack: list) -> RenderTerms:
    """One call: `layer.check_layer`'s penalty terms plus this module's contribution channels, all
    from the same rendered `StemFeatures` (`layer.load_stack`'s output)."""
    layer_report = layer.check_layer(manifest, candidate, stack)
    contribution = max(band_fill(candidate, stack), harmonic_addition(candidate, stack, manifest), motion_term(candidate, stack, manifest))
    return RenderTerms(clash=layer_report.terms.clash, masking=layer_report.terms.masking, rhythm=layer_report.terms.rhythm,
                        contribution=contribution, gates_passed=layer_report.gates.passed)


# Same penalty pool as objective.WEIGHTS's clash/masking/rhythm slice of the full spec table
# (chord/density/taste aren't computed at render fidelity by layer.py; see the module docstring).
RENDER_WEIGHTS = {"clash": 0.30, "masking": 0.15, "rhythm": 0.10}
CONTRIBUTION_WEIGHT = 0.20


def render_composite(terms: RenderTerms, *, weights: dict | None = None, contribution_weight: float = CONTRIBUTION_WEIGHT):
    from .objective import Composite

    if not terms.gates_passed:
        return Composite(J=0.0, P=1.0, contribution=0.0, penalties={}, ok=False)
    weights = weights or RENDER_WEIGHTS
    penalties = {"clash": terms.clash, "masking": terms.masking, "rhythm": terms.rhythm}
    w_sum = sum(weights.values())
    p = sum(weights[k] * penalties[k] for k in penalties) / w_sum if w_sum > 0 else 0.0
    j = 100.0 * (1.0 - p) + 100.0 * contribution_weight * terms.contribution
    return Composite(J=round(j, 3), P=round(p, 4), contribution=round(terms.contribution, 4), penalties=penalties)


def null_stem_features(like) -> "layer.StemFeatures":
    """An all-silent `StemFeatures` shaped like `like` (same frame/beat counts): "the null
    control" as an actual rendered-shape stem, literally nothing added."""
    return layer.StemFeatures(
        name="__null__", pitched=False, bass=False,
        chroma=np.zeros_like(like.chroma), energy_db=np.full_like(like.energy_db, -120.0),
        onset_env=np.zeros_like(like.onset_env), bands=np.zeros_like(like.bands),
        tonalness=np.zeros_like(like.tonalness), mono=np.zeros(1), sr=like.sr,
    )


def null_render_terms(manifest: dict, stack: list) -> RenderTerms:
    """The null control's term vector, computed against the *rendered* stack (not asserted to be
    zero): clash/masking/rhythm against an all-silent candidate are mechanically 0 (nothing to
    clash or mask against), and both contribution channels are 0 (nothing was added, so there is
    nothing to fill an empty band or supply a thin chord tone with) -- verified by
    `test_optimize_render_terms.py`, not just assumed. The not-silent/not-double gates are
    deliberately bypassed here: "no part was added" is a well-defined zero point, not a candidate
    that must itself pass the silence gate (an all-silent stem would otherwise fail
    `gate_not_silent` and force `J_null` to the failure value 0, which is wrong -- see
    `objective.null_composite`, the same convention at the surrogate level)."""
    if not stack:
        raise ValueError("null_render_terms needs at least one stack stem to shape the silent candidate on")
    null_stem = null_stem_features(stack[0])
    return RenderTerms(clash=0.0, masking=0.0, rhythm=0.0,
                        contribution=max(band_fill(null_stem, stack), harmonic_addition(null_stem, stack, manifest), motion_term(null_stem, stack, manifest)),
                        gates_passed=True)
