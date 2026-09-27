"""Surrogate transforms on synthetic data (no rendering, no `apricity compile`): `compute_terms`'s
clash/chord/contribution math and `pattern_density`, isolated from the compiler."""

from __future__ import annotations

import numpy as np

from apricity_analyze.optimize import surrogate


def test_pattern_density_counts_sounding_steps():
    assert surrogate.pattern_density(". . . .") == 0.0
    assert surrogate.pattern_density("x x x x") == 1.0
    assert surrogate.pattern_density("x . . .") == 0.25
    # bar separators and holds don't count as extra steps / as sounding
    assert surrogate.pattern_density("x . | _ .") == 0.25


def test_compute_terms_no_stack_no_clash():
    n_beats = 8
    candidate = np.zeros((n_beats, 12))
    candidate[:, 0] = 1.0  # pure C, every beat
    terms = surrogate.compute_terms(candidate_chroma=candidate, stack={}, harmony=[], entry=(1, 8),
                                     pattern_density_value=0.5, taste_penalty=0.5, is_bass=False)
    assert terms.clash == 0.0  # nothing to clash against
    assert terms.contribution == 0.0  # no harmony spans -> no room to compute


def test_compute_terms_penalizes_a_semitone_clash():
    n_beats = 4
    candidate = np.zeros((n_beats, 12))
    candidate[:, 0] = 1.0  # C
    stack_clashing = np.zeros((n_beats, 12))
    stack_clashing[:, 1] = 1.0  # C# -- a minor 2nd against the candidate, every beat
    stack_consonant = np.zeros((n_beats, 12))
    stack_consonant[:, 7] = 1.0  # G -- a perfect 5th, no clash weight in check.INTERVAL_K

    t_clash = surrogate.compute_terms(candidate_chroma=candidate, stack={"x": stack_clashing}, harmony=[], entry=(1, 8),
                                       pattern_density_value=0.5, taste_penalty=0.5, is_bass=False)
    t_consonant = surrogate.compute_terms(candidate_chroma=candidate, stack={"x": stack_consonant}, harmony=[], entry=(1, 8),
                                           pattern_density_value=0.5, taste_penalty=0.5, is_bass=False)
    assert t_clash.clash > t_consonant.clash


def test_compute_terms_chord_fit_and_contribution_from_harmony():
    n_beats = 4
    candidate = np.zeros((n_beats, 12))
    candidate[:, 0] = 1.0  # C, the chord's root -- fully on-chord
    harmony = [{"start_beat": 0, "end_beat": 4, "fit": {"chord_tones": [0, 4, 7], "coverage": 0.2}}]
    terms = surrogate.compute_terms(candidate_chroma=candidate, stack={}, harmony=harmony, entry=(1, 1),
                                     pattern_density_value=0.5, taste_penalty=0.5, is_bass=False)
    assert terms.chord < 0.2  # on-chord candidate -> low chord-fit penalty
    assert terms.contribution > 0.0  # low stack coverage (0.2) + on-chord candidate -> real contribution


def test_compute_terms_off_chord_candidate_scores_worse():
    n_beats = 4
    on_chord = np.zeros((n_beats, 12))
    on_chord[:, 0] = 1.0
    off_chord = np.zeros((n_beats, 12))
    off_chord[:, 1] = 1.0  # a semitone above the root, not a chord tone
    harmony = [{"start_beat": 0, "end_beat": 4, "fit": {"chord_tones": [0, 4, 7], "coverage": 0.5}}]
    t_on = surrogate.compute_terms(candidate_chroma=on_chord, stack={}, harmony=harmony, entry=(1, 1),
                                    pattern_density_value=0.5, taste_penalty=0.5, is_bass=False)
    t_off = surrogate.compute_terms(candidate_chroma=off_chord, stack={}, harmony=harmony, entry=(1, 1),
                                     pattern_density_value=0.5, taste_penalty=0.5, is_bass=False)
    assert t_off.chord > t_on.chord
