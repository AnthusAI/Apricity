"""Render-fidelity contribution/composite (Kanbus apricitus-a9ad5b round 2, fixing the "null gate
is impossible by construction" finding): `null_render_terms` + `render_composite` land on exactly
`J=100`, computed via the same function every candidate goes through (not hard-coded); a synthetic
candidate that fills an empty spectral gap with no clash CAN clear the delta=2 margin; a clashing
candidate cannot.
"""

from __future__ import annotations

import numpy as np

from apricity_analyze import layer
from apricity_analyze.optimize import objective, render_terms

N_BEATS = 8
N_FRAMES = 64
N_BANDS = layer.MASKING_N_BANDS


def _stem(name, *, chroma, bands, energy_db=None, onset_env=None, tonalness=None, bass=False):
    return layer.StemFeatures(
        name=name, pitched=True, bass=bass,
        chroma=chroma, energy_db=energy_db if energy_db is not None else np.full(N_BEATS, -10.0),
        onset_env=onset_env if onset_env is not None else np.zeros(N_FRAMES),
        bands=bands, tonalness=tonalness if tonalness is not None else np.full(N_FRAMES, 0.3),
        mono=np.zeros(1), sr=44100,
    )


def _stack_stem():
    # loud only in the first 6 (of 24) bands -- the rest are its "empty" register.
    bands = np.zeros((N_FRAMES, N_BANDS))
    bands[:, :6] = 1000.0
    chroma = np.zeros((N_BEATS, 12))
    chroma[:, 0] = 1.0  # pure C
    return _stem("stack", chroma=chroma, bands=bands, energy_db=np.full(N_BEATS, -6.0))


MANIFEST = {"tempo": 120.0, "meter": 4, "key": "C major", "harmony": [], "offset_beats": 0}


def test_null_render_terms_is_exactly_j_100_via_the_same_function():
    stack = [_stack_stem()]
    terms = render_terms.null_render_terms(MANIFEST, stack)
    comp = render_terms.render_composite(terms)
    assert comp.J == 100.0
    assert comp.contribution == 0.0
    assert all(v == 0.0 for v in comp.penalties.values())


def test_a_synthetic_band_filling_candidate_clears_the_null_margin():
    stack = [_stack_stem()]
    # fills bands 15-23 (empty in the stack), carries no tonal content (no clash), and doesn't
    # rhythmically correlate with the stack -- a textbook "positive contribution, no penalty" part.
    bands = np.zeros((N_FRAMES, N_BANDS))
    bands[:, 15:] = 800.0
    candidate = _stem("fill", chroma=np.zeros((N_BEATS, 12)), bands=bands,
                       energy_db=np.full(N_BEATS, -8.0), tonalness=np.full(N_FRAMES, 0.1))

    terms = render_terms.compute_render_terms(MANIFEST, candidate, stack)
    assert terms.gates_passed
    assert terms.clash == 0.0
    assert terms.contribution > 0.3  # band_fill should dominate: nothing else occupies those bands

    comp = render_terms.render_composite(terms)
    null = render_terms.render_composite(render_terms.null_render_terms(MANIFEST, stack))
    assert (comp.J - null.J) >= objective.DELTA_MARGIN_DEFAULT


def test_a_clashing_candidate_does_not_clear_the_null_margin():
    stack = [_stack_stem()]
    # sits a semitone above the stack's pure C (the checker's harshest interval, INTERVAL_K[1]=1.0),
    # loud, and piles into the SAME bands the stack already occupies -- no room contributed.
    bands = np.zeros((N_FRAMES, N_BANDS))
    bands[:, :6] = 1000.0
    chroma = np.zeros((N_BEATS, 12))
    chroma[:, 1] = 1.0  # C#
    candidate = _stem("clash", chroma=chroma, bands=bands, energy_db=np.full(N_BEATS, -6.0))

    terms = render_terms.compute_render_terms(MANIFEST, candidate, stack)
    assert terms.clash > 0.0
    assert terms.contribution == 0.0  # every band it's loud in is already loud in the stack

    comp = render_terms.render_composite(terms)
    null = render_terms.render_composite(render_terms.null_render_terms(MANIFEST, stack))
    assert (comp.J - null.J) < objective.DELTA_MARGIN_DEFAULT


def _bars_of_frames(n_bars, bar_len_s=2.0):
    """Enough STFT frames (check.frame_times' grid) to cover `n_bars` bars at `bar_len_s` each."""
    import math

    from apricity_analyze.analyze import FRAME, HOP, SR

    return math.ceil((n_bars * bar_len_s * SR - FRAME / 2) / HOP) + 1


def test_motion_term_is_zero_when_the_candidate_is_as_static_as_the_stack():
    n_frames = _bars_of_frames(8)
    stack_bands = np.zeros((n_frames, N_BANDS))
    stack_bands[:, :6] = 500.0  # perfectly flat over time
    stack = [_stem("stack", chroma=np.zeros((N_BEATS, 12)), bands=stack_bands)]
    candidate = _stem("still", chroma=np.zeros((N_BEATS, 12)), bands=np.full((n_frames, N_BANDS), 10.0))
    manifest = {"tempo": 120.0, "meter": 4}
    assert render_terms.motion_term(candidate, stack, manifest) == 0.0


def test_motion_term_rewards_adding_bar_to_bar_variation_to_a_static_stack():
    n_frames = _bars_of_frames(8)
    stack_bands = np.zeros((n_frames, N_BANDS))
    stack_bands[:, :6] = 500.0  # perfectly flat -- the stack alone has zero bar-to-bar variance
    stack = [_stem("stack", chroma=np.zeros((N_BEATS, 12)), bands=stack_bands)]

    from apricity_analyze import check as checker

    times = checker.frame_times(n_frames)
    bar_idx = np.floor(times / 2.0).astype(int)
    cand_bands = np.zeros((n_frames, N_BANDS))
    cand_bands[:, 10] = np.where(bar_idx % 2 == 0, 400.0, 0.0)  # alternates loud/silent every other bar
    candidate = _stem("pulse", chroma=np.zeros((N_BEATS, 12)), bands=cand_bands)
    manifest = {"tempo": 120.0, "meter": 4}
    assert render_terms.motion_term(candidate, stack, manifest) == 1.0


def test_harmonic_addition_rewards_supplying_a_thin_chord_tone():
    stack = [_stack_stem()]  # pure C, so the E and G of a C major chord are entirely absent
    manifest = {"tempo": 120.0, "meter": 4, "key": "C major", "offset_beats": 0,
                "harmony": [{"start_beat": 0, "end_beat": N_BEATS, "chord_tones": ["C", "E", "G"]}]}
    chroma = np.zeros((N_BEATS, 12))
    chroma[:, 4] = 1.0  # E -- a chord tone the stack doesn't cover at all
    candidate = _stem("third", chroma=chroma, bands=np.zeros((N_FRAMES, N_BANDS)), energy_db=np.full(N_BEATS, -8.0))
    share = render_terms.harmonic_addition(candidate, stack, manifest)
    assert share > 0.9  # nearly all of the candidate's tonal mass lands on the missing chord tone
