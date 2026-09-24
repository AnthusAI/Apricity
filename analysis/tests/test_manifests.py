"""Checks over the analyzed sample library (run `apricity-analyze samples` first)."""

import copy
import json
import pathlib

import pytest

from apricity_analyze.analyze import validate

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
MANIFESTS = sorted(SAMPLES.rglob("*.apricity.json"))
GROUND_TRUTH = json.loads((pathlib.Path(__file__).parent / "sousa_keys.json").read_text())["marches"]

needs_manifests = pytest.mark.skipif(not MANIFESTS, reason="no manifests; run apricity-analyze samples")


@needs_manifests
@pytest.mark.parametrize("path", MANIFESTS, ids=lambda p: p.name[:40])
def test_manifest_is_valid(path):
    m = json.loads(path.read_text())
    validate(m)
    r = m["rhythm"]
    assert r["beats"] == sorted(r["beats"])
    seconds = [w["seconds"] for w in r["warp_markers"]]
    beats = [w["beat"] for w in r["warp_markers"]]
    assert seconds == sorted(seconds) and beats == sorted(beats), "warp markers must increase in both"
    assert all(0 <= t <= m["source"]["duration"] + 0.05 for t in r["beats"])


@needs_manifests
@pytest.mark.parametrize("audio,keys", sorted(GROUND_TRUTH.items()))
def test_sousa_key_is_main_or_trio(audio, keys):
    path = SAMPLES / (audio + ".apricity.json")
    if not path.exists():
        pytest.skip("not analyzed")
    t = json.loads(path.read_text())["tonal"]
    assert t["key"]["mode"] == "major"
    assert t["key"]["tonic"] in keys
    # Over time we should see both the main strain and the trio key.
    seen = {s["key"]["tonic"] for s in t["segments"]}
    assert set(keys) <= seen, f"segments show {sorted(seen)}, expected both of {keys}"


@needs_manifests
def test_marine_band_tempo_is_march_cadence():
    for audio in GROUND_TRUTH:
        path = SAMPLES / (audio + ".apricity.json")
        if path.exists():
            bpm = json.loads(path.read_text())["rhythm"]["bpm"]
            # 120 steps/minute, allowing the double/half-time ambiguity beat trackers have.
            assert min(abs(bpm - 120), abs(bpm / 2 - 120), abs(bpm * 2 - 120)) < 12, f"{audio}: {bpm}"


@needs_manifests
def test_slices_outside_the_clip_are_rejected():
    m = json.loads(MANIFESTS[0].read_text())
    dur = m["source"]["duration"]
    ok = copy.deepcopy(m)
    ok["annotations"] = {"slices": [{"name": "whole", "start": 0, "end": dur}]}
    validate(ok)
    for bad in ([dur - 1, dur + 5], [3, 2], [dur + 1, dur + 2]):
        m2 = copy.deepcopy(m)
        m2["annotations"] = {"slices": [{"name": "bad", "start": bad[0], "end": bad[1]}]}
        with pytest.raises(ValueError, match="outside the clip"):
            validate(m2)
