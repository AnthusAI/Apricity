"""Sanity checks for the layer-by-layer optimizer's validator (`apricity_analyze.layer`),
tonight's slice: composite = clash*0.6 + masking*0.2 + rhythm(onset)*0.2, gates = not-silent,
not-a-double. All synthetic (hand-built `StemFeatures`), so these run fast without real audio.
"""

from __future__ import annotations

import numpy as np
import pytest

from apricity_analyze import layer


def one_hot(pitch_class: int, amp: float = 1.0) -> np.ndarray:
    v = np.zeros(12)
    v[pitch_class] = amp
    return v


def make_stem(name: str, *, n_beats: int = 8, chroma=None, energy_db=None, onset_env=None, bands=None,
              tonalness=None, bass: bool = False, pitched: bool = True) -> layer.StemFeatures:
    chroma = np.tile(one_hot(0, 0.4), (n_beats, 1)) if chroma is None else np.asarray(chroma)
    n_frames = 32
    return layer.StemFeatures(
        name=name, pitched=pitched, bass=bass, chroma=chroma,
        energy_db=np.full(n_beats, -10.0) if energy_db is None else np.asarray(energy_db),
        onset_env=np.zeros(n_frames) if onset_env is None else np.asarray(onset_env),
        bands=np.zeros((n_frames, layer.MASKING_N_BANDS)) if bands is None else np.asarray(bands),
        tonalness=np.full(n_frames, 0.8) if tonalness is None else np.asarray(tonalness),
        mono=np.zeros(1), sr=44100,
    )


def manifest(harmony=None, key="C major"):
    return {"key": key, "harmony": harmony or [{"start_beat": 0.0, "end_beat": 8.0, "label": "I", "chord_tones": ["C", "E", "G"]}],
            "offset_beats": 0.0, "meter": 4}


# --------------------------------------------------------------------------- gate: silent

def test_silent_candidate_trips_the_not_silent_gate():
    stack = [make_stem("drums", energy_db=np.full(8, -10.0))]
    silent = make_stem("bass", energy_db=np.full(8, -120.0))
    assert layer.gate_not_silent(silent, stack) is False
    report = layer.check_layer(manifest(), silent, stack)
    assert report.gates.passed is False
    assert report.score == 0.0
    assert any("quiet" in f for f in report.findings)


def test_a_loud_enough_candidate_passes_the_silent_gate():
    stack = [make_stem("drums", energy_db=np.full(8, -10.0))]
    loud = make_stem("bass", energy_db=np.full(8, -12.0))
    assert layer.gate_not_silent(loud, stack) is True


def _intro_only_song():
    # 40 beats: a quiet intro (beats 0-7, stack at -30 dB) then a loud drop (-10 dB); the part plays
    # only in the intro, at -34 dB (quiet, but only 4 dB under what's around it).
    stack_db = np.r_[np.full(8, -30.0), np.full(32, -10.0)]
    part_db = np.r_[np.full(8, -34.0), np.full(32, -120.0)]
    tempo = 120.0  # at 44.1 kHz and check.HOP, frames_per_beat is fractional: slicing must round, not crash
    n_frames = int(np.ceil(40 * 44100 * 60 / tempo / layer.check.HOP))
    kw = dict(n_beats=40, onset_env=np.zeros(n_frames), bands=np.zeros((n_frames, layer.MASKING_N_BANDS)),
              tonalness=np.full(n_frames, 0.8), chroma=np.tile(one_hot(0, 0.4), (40, 1)))
    return make_stem("drums", energy_db=stack_db, **kw), make_stem("riff", energy_db=part_db, **kw), tempo


def test_an_intro_only_part_is_judged_over_its_own_bars():
    stack, part, tempo = _intro_only_song()
    # Over the whole song it sounds on 20% of the beats and sits 24 dB under the drop: "silent".
    assert layer.gate_not_silent(part, [stack]) is False
    w = lambda f: layer.window_features(f, tempo, 0, 8)
    assert layer.gate_not_silent(w(part), [w(stack)]) is True
    assert len(w(part).energy_db) == 8 and w(part).bands.shape[0] == w(part).tonalness.shape[0] > 0


def test_windowing_does_not_rescue_a_part_that_is_silent_in_its_own_bars():
    stack, _, tempo = _intro_only_song()
    silent = make_stem("riff", n_beats=40, energy_db=np.full(40, -120.0), chroma=np.zeros((40, 12)))
    w = lambda f: layer.window_features(f, tempo, 0, 8)
    assert layer.gate_not_silent(w(silent), [w(stack)]) is False


# --------------------------------------------------------------------------- gate: doubling

def test_an_exact_copy_of_a_stack_stem_trips_the_doubling_gate():
    rng = np.random.default_rng(0)
    onset = rng.random(32)
    chroma = np.tile(one_hot(3, 0.5), (8, 1))
    original = make_stem("pad", chroma=chroma, onset_env=onset)
    copy = make_stem("pad-copy", chroma=chroma.copy(), onset_env=onset.copy())
    passed, pairs = layer.gate_not_double(copy, [original])
    assert passed is False
    assert pairs[0]["onset_r"] > layer.DOUBLE_ONSET_R
    assert pairs[0]["chroma_cosine"] > layer.DOUBLE_CHROMA_COSINE
    report = layer.check_layer(manifest(), copy, [original])
    assert report.gates.passed is False
    assert any("doubles" in f for f in report.findings)


def test_a_rhythmically_and_harmonically_different_candidate_passes_the_doubling_gate():
    rng = np.random.default_rng(1)
    original = make_stem("pad", chroma=np.tile(one_hot(3, 0.5), (8, 1)), onset_env=rng.random(32))
    different = make_stem("bass", chroma=np.tile(one_hot(9, 0.5), (8, 1)), onset_env=rng.random(32))
    passed, _ = layer.gate_not_double(different, [original])
    assert passed is True


# --------------------------------------------------------------------------- semitone vs fifth

def test_a_semitone_shifted_candidate_scores_below_a_fifth_shifted_one():
    """Reuses check.py's own interval kernel (K[1]=1.0 for a minor 2nd, K[7]=0.0 for a perfect
    5th), so this should hold exactly the way `test_check.py`'s equivalent kernel test does."""
    stack = [make_stem("root", chroma=np.tile(one_hot(0, 0.4), (8, 1)))]  # a held C
    semitone = make_stem("clash", chroma=np.tile(one_hot(1, 0.4), (8, 1)))  # Db: a semitone up
    fifth = make_stem("consonant", chroma=np.tile(one_hot(7, 0.4), (8, 1)))  # G: a fifth up

    m = manifest(harmony=[{"start_beat": 0.0, "end_beat": 8.0, "label": "I", "chord_tones": ["C"]}])
    semitone_report = layer.check_layer(m, semitone, stack)
    fifth_report = layer.check_layer(m, fifth, stack)
    assert semitone_report.terms.clash > fifth_report.terms.clash
    assert semitone_report.score < fifth_report.score


# --------------------------------------------------------------------------- white noise loses

def test_white_noise_loses_to_a_normal_candidate():
    """White noise spreads energy across every band, so it overlaps (masks) whatever bands the
    stack already occupies more than a candidate deliberately placed in the stack's *empty*
    register does -- the masking term should make it lose even though nothing else about it
    (rhythm, chroma) is being penalized here."""
    n_frames = 32
    stack_bands = np.zeros((n_frames, layer.MASKING_N_BANDS))
    stack_bands[:, 0:6] = 1.0  # the stack occupies the low/low-mid bands

    good_bands = np.zeros((n_frames, layer.MASKING_N_BANDS))
    good_bands[:, 18:24] = 1.0  # a candidate placed in the stack's empty high register

    noise_bands = np.ones((n_frames, layer.MASKING_N_BANDS))  # flat: present in every band

    stack = [make_stem("stack", bands=stack_bands, chroma=np.tile(one_hot(0, 0.3) + one_hot(4, 0.3) + one_hot(7, 0.3), (8, 1)))]
    same_chroma = np.tile(one_hot(0, 0.3) + one_hot(4, 0.3) + one_hot(7, 0.3), (8, 1))  # on-chord for both, isolates masking
    good = make_stem("good", bands=good_bands, chroma=same_chroma)
    noise = make_stem("noise", bands=noise_bands, chroma=same_chroma)

    m = manifest(harmony=[{"start_beat": 0.0, "end_beat": 8.0, "label": "I", "chord_tones": ["C", "E", "G"]}])
    good_report = layer.check_layer(m, good, stack)
    noise_report = layer.check_layer(m, noise, stack)
    assert noise_report.terms.masking > good_report.terms.masking
    assert noise_report.score < good_report.score


# --------------------------------------------------------------------------- weights / composite shape

def test_tonight_weights_sum_to_one_over_the_active_terms():
    active = {k: v for k, v in layer.WEIGHTS_TONIGHT.items() if v > 0}
    assert set(active) == {"clash", "masking", "rhythm"}
    assert abs(sum(active.values()) - 1.0) < 1e-9


def test_term_masking_tolerates_mismatched_frame_counts():
    """`bands` and `tonalness` come from separate STFT calls and can differ by a frame at a clip's
    edge (a real bug hit during the layer-slice run); this must not crash."""
    stack = [make_stem("stack", bands=np.ones((100, layer.MASKING_N_BANDS)), tonalness=np.full(99, 0.5))]
    candidate = make_stem("cand", bands=np.ones((101, layer.MASKING_N_BANDS)), tonalness=np.full(100, 0.5))
    result = layer.term_masking(candidate, stack)
    assert 0.0 <= result <= 1.0


def test_stack_cache_round_trips(tmp_path):
    cache = tmp_path / "stack.npz"
    stack = [make_stem("a"), make_stem("b", bass=True)]
    layer._save_cached_stack(cache, stack)
    loaded = layer._load_cached_stack(cache)
    assert [s.name for s in loaded] == ["a", "b"]
    assert loaded[1].bass is True
    assert np.allclose(loaded[0].chroma, stack[0].chroma)


# --------------------------------------------------------------------------- the listener's taste

def test_taste_comes_from_the_verdicts_and_counts_only_as_far_as_its_weight():
    """`taste` (explore.verdicts) replaces the unrated 0.5; with its weight at 0.0 the score doesn't move."""
    stack = [make_stem("drums", chroma=np.tile(one_hot(7, 0.4), (8, 1)))]
    cand = make_stem("pad")
    plain = layer.check_layer(manifest(), cand, stack)
    liked = layer.check_layer(manifest(), cand, stack, taste=0.1)
    assert plain.terms.taste == 0.5 and liked.terms.taste == 0.1
    assert liked.score == plain.score
    weights = {**layer.WEIGHTS_TONIGHT, "taste": 0.2}
    assert layer.check_layer(manifest(), cand, stack, taste=0.1, weights=weights).score > layer.check_layer(manifest(), cand, stack, taste=0.9, weights=weights).score
