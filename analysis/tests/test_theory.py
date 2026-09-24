import numpy as np
import pytest

from apricitus_analyze.theory import PITCH_NAMES, PROFILES, camelot, rank_keys


@pytest.mark.parametrize("tonic,mode,code", [
    ("C", "major", "8B"), ("G", "major", "9B"), ("F", "major", "7B"), ("Eb", "major", "5B"),
    ("Ab", "major", "4B"), ("B", "major", "1B"), ("Gb", "major", "2B"),
    ("A", "minor", "8A"), ("E", "minor", "9A"), ("D", "minor", "7A"), ("Ab", "minor", "1A"), ("C", "minor", "5A"),
])
def test_camelot(tonic, mode, code):
    assert camelot(PITCH_NAMES.index(tonic), mode) == code


@pytest.mark.parametrize("profile", sorted(PROFILES))
@pytest.mark.parametrize("tonic", range(12))
@pytest.mark.parametrize("mode", ["major", "minor"])
def test_profile_recovers_its_own_key(profile, tonic, mode):
    pcp = np.roll(PROFILES[profile][mode], tonic)
    best = rank_keys(pcp, profile)[0]
    assert (best["tonic"], best["mode"]) == (PITCH_NAMES[tonic], mode)


def test_triad_prefers_its_major_key():
    pcp = np.zeros(12)
    pcp[[8, 0, 3]] = 1.0  # Ab C Eb
    assert rank_keys(pcp)[0]["tonic"] == "Ab"


def test_silence_has_no_key():
    assert rank_keys(np.zeros(12)) == []
