"""The curation feed on a synthetic library: proposing (analyzers and agents), verdicts written back
into manifests, taste ranking with reasons, crates exported as .apr, and audition audio."""

import json

import numpy as np
import pytest
import soundfile as sf

from apricity_analyze import curation as cu

SR = 22050


def _manifest(path, dur, beats, loud=None, stem=None, slices=()):
    m = {
        "apricity_manifest": 1,
        "source": {"path": path.name, "sha256": "0" * 64, "sample_rate": SR, "channels": 1, "duration": dur},
        "rhythm": {"bpm": 120.0, "beats": beats, "downbeats": beats[::4], "meter": 4,
                   "warp_markers": [{"seconds": t, "beat": i} for i, t in enumerate(beats)], "beat_loudness": loud or [-20.0] * (len(beats) - 1)},
        "tonal": {"key": {"tonic": "F", "mode": "major"}, "tuning_cents": 0.0, "pitch_class_profile": [0.1] * 12},
        "annotations": {"slices": list(slices)},
    }
    if stem:
        m["derived_from"] = {"stem": stem, "source": "x"}
    path.with_name(path.name + ".apricity.json").write_text(json.dumps(m))


@pytest.fixture
def lib(tmp_path):
    samples = tmp_path / "samples"
    (samples / "band" / "stems" / "March").mkdir(parents=True)
    beats = [i * 0.5 for i in range(33)]  # 16 s at 120 BPM
    dur = 16.5
    t = np.arange(int(dur * SR)) / SR
    sf.write(samples / "band" / "March.wav", (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), SR)
    _manifest(samples / "band" / "March.wav", dur, beats, slices=[
        {"name": "loop-1", "start": 2.0, "end": 6.0, "source": "ml", "tags": ["loop", "8beats", "F"], "evidence": {"repeat": 0.93, "steady": 0.99, "static": 0.95, "level_db": 0.0}},
        {"name": "hit-1", "start": 7.0, "end": 7.5, "source": "ml", "tags": ["hit"], "evidence": {"standout": 9.0}},
        {"name": "sec-A1", "start": 0.0, "end": 8.0, "source": "ml", "tags": ["section", "A"]},
        {"name": "mine", "start": 1.0, "end": 2.0, "source": "user"},
    ])
    # Stems on the same grid: drums loud everywhere; the others drop out for beats 16–24 (a break).
    drums = [-18.0] * 32
    others = [-18.0] * 16 + [-40.0] * 8 + [-18.0] * 8
    for stem, loud in [("drums", drums), ("bass", others), ("other", others)]:
        p = samples / "band" / "stems" / "March" / f"{stem}.wav"
        sf.write(p, np.zeros(int(dur * SR), np.float32), SR)
        _manifest(p, dur, beats, loud=loud, stem=stem)
    return cu.Store(tmp_path / "library", samples)


def test_analyzers_propose_with_evidence_and_breaks_from_stems(lib):
    made = cu.propose_all(lib, lib.samples / "band")
    kinds = sorted(c["kind"] for c in made)
    assert kinds == ["break", "hit", "loop", "section"], kinds
    loop = next(c for c in made if c["kind"] == "loop")
    assert "loop cleanly (the next 8 beats match 0.93)" in loop["proposers"][0]["why"] and "steady beat" in loop["proposers"][0]["why"]
    assert loop["context"]["beats"] == 8.0 and loop["recording"] == "March"
    brk = next(c for c in made if c["kind"] == "break")
    assert (brk["start"], brk["end"]) == (8.0, 12.0), brk  # beats 16–24 at 0.5 s
    assert brk["clip"] == "band/March.wav", "the break is proposed on the full recording"
    assert "drums stand 22 dB over everything else" in brk["proposers"][0]["why"]
    # Proposing again doesn't duplicate.
    cu.propose_all(lib, lib.samples / "band")
    assert len(lib.read("candidates")["candidates"]) == 4


def test_agents_propose_and_are_validated(lib):
    c = cu.propose(lib, "band/March.wav", 10.0, 12.0, "loop", "agent:digger", "two bars of just trombones", 0.8, {"confidence": 0.8})
    again = cu.propose(lib, "band/March.wav", 10.0, 12.0, "loop", "analyzer:markup/loops", "loops", 0.4)
    assert again["id"] == c["id"] and [p["by"] for p in again["proposers"]] == ["agent:digger", "analyzer:markup/loops"]
    for bad, msg in [
        (("band/March.wav", 10.0, 99.0, "loop", "agent:x", "why"), "outside the clip"),
        (("band/March.wav", 10.0, 12.0, "riff", "agent:x", "why"), "kind 'riff'"),
        (("band/March.wav", 10.0, 12.0, "loop", "digger", "why"), "agent:<name>"),
        (("band/March.wav", 10.0, 12.0, "loop", "agent:x", "  "), "say why"),
        (("band/Nope.wav", 1.0, 2.0, "loop", "agent:x", "why"), "no analysis"),
    ]:
        with pytest.raises(ValueError, match=msg):
            cu.propose(lib, *bad)


def test_keep_writes_a_curated_slice_and_skip_takes_it_back(lib):
    loop = next(c for c in cu.propose_all(lib, lib.samples / "band") if c["kind"] == "loop")
    v = cu.judge(lib, loop["id"], "keep", stars=4, tags=["brass"], name="march-loop", crates=["digs"])
    assert v["slice"] == "march-loop"
    m = lib.manifest("band/March.wav")
    s = next(s for s in m["annotations"]["slices"] if s["name"] == "march-loop")
    assert s["source"] == "curated" and s["stars"] == 4 and s["tags"] == ["loop", "brass"] and s["candidate"] == loop["id"]
    assert s["evidence"]["repeat"] == 0.93
    assert any(s["name"] == "mine" for s in m["annotations"]["slices"]), "a person's own slices are untouched"
    # A name clash gets a suffix instead of clobbering.
    hit = next(c for c in lib.read("candidates")["candidates"] if c["kind"] == "hit")
    assert cu.judge(lib, hit["id"], "keep", name="mine")["slice"] == "mine-2"
    cu.judge(lib, loop["id"], "skip")
    m = lib.manifest("band/March.wav")
    assert not any(s.get("candidate") == loop["id"] for s in m["annotations"]["slices"])
    assert loop["id"] not in lib.read("crates")["crates"]["digs"]["items"], "skipped material leaves its crates"
    with pytest.raises(ValueError, match="stars go on kept"):
        cu.judge(lib, loop["id"], "skip", stars=3)
    with pytest.raises(KeyError):
        cu.judge(lib, "c-nope", "keep")


def test_taste_ranks_by_what_you_kept_and_says_why(lib):
    for i in range(6):
        cu.propose(lib, "band/March.wav", 0.5 * i, 0.5 * i + 0.4, "hit", "analyzer:markup/hits", "hit", 0.5)
        cu.propose(lib, "band/March.wav", 8 + 0.5 * i, 8 + 0.5 * i + 2, "loop", "analyzer:markup/loops", "loop", 0.5)
    cands = lib.read("candidates")["candidates"]
    hits = [c for c in cands if c["kind"] == "hit"]
    loops = [c for c in cands if c["kind"] == "loop"]
    for c in hits[:4]:
        cu.judge(lib, c["id"], "keep")
    for c in loops[:4]:
        cu.judge(lib, c["id"], "skip")
    cu.judge(lib, hits[4]["id"], "later")
    f = cu.feed(lib)
    top = f[0]
    assert top["id"] == hits[5]["id"], "unjudged first; the kept kind ranks above the skipped kind"
    assert any("you kept 4 of 4 hits" in w for w in top["why_ranked"]), top["why_ranked"]
    loop_row = next(c for c in f if c["kind"] == "loop")
    assert any("you skipped 4 of 4 loops" in w for w in loop_row["why_ranked"])
    assert f[-1]["id"] == hits[4]["id"] and f[-1]["later"], "put-off items come back last"
    assert len(f) == 4, "1 hit and 2 loops unjudged, plus the one put off"


def test_crates_export_as_a_kit(lib):
    made = cu.propose_all(lib, lib.samples / "band")
    loop = next(c for c in made if c["kind"] == "loop")
    brk = next(c for c in made if c["kind"] == "break")
    cu.judge(lib, loop["id"], "keep", stars=5, name="horn-loop", crates=["digs"])
    cu.judge(lib, brk["id"], "keep", crates=["digs"])
    apr = cu.export_apr(lib, "digs")
    assert "clip march-mix = band/March.wav" in apr
    assert "kit digs" in apr and "  horn-loop = march-mix  slice horn-loop   # ★★★★★" in apr
    assert f"  {brk['name']} = march-mix  slice {brk['name']}" in apr
    with pytest.raises(KeyError, match="no crate"):
        cu.export_apr(lib, "nope")


def test_audition_repeats_loops_to_hear_the_join(lib):
    made = cu.propose_all(lib, lib.samples / "band")
    loop = next(c for c in made if c["kind"] == "loop")
    hit = next(c for c in made if c["kind"] == "hit")
    x, sr = cu.audition(lib, loop)
    assert sr == SR and len(x) == 2 * int(4.0 * SR)
    y, _ = cu.audition(lib, hit)
    assert len(y) == int(0.5 * SR)
