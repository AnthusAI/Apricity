"""`scripts/optimize.py`'s score-derived helpers (Kanbus apricitus-2fafca): section detection and
positive-control derivation must come from whatever score is passed in, not be tied to one
example's structure or clip names. Checked against more than one example score, none of them
hard-coded into the helpers themselves.
"""

from __future__ import annotations

import importlib.util
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "target/release/apricity"
SAMPLES = ROOT / "samples"

pytestmark = pytest.mark.skipif(not BIN.exists(), reason="release binary not built")


def _load_optimize_cli():
    spec = importlib.util.spec_from_file_location("optimize_cli", ROOT / "scripts" / "optimize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


optimize_cli = _load_optimize_cli()

from apricity_analyze.optimize.genome import REGION_PREFIXES  # noqa: E402


def _score_text(name: str) -> str:
    """One of the repo's example scores, with `samples ../samples` pointed at the real library
    (the same rewrite `audition_form.absolutize_samples` does for a temp copy)."""
    text = (ROOT / "examples" / name).read_text()
    return text.replace("samples ../samples", f"samples {SAMPLES}")


# --------------------------------------------------------------------------- detect_sections

def test_detect_sections_covers_the_whole_score_on_two_different_examples():
    for name in ("ave-house.apr", "markup-demo.apr"):
        text = _score_text(name)
        sections = optimize_cli.detect_sections(text)
        assert sections[0][0] == 1
        # contiguous, no gaps or overlaps
        for (a, b), (c, d) in zip(sections, sections[1:]):
            assert c == b + 1
        # every section is a valid (non-empty) bar range
        assert all(a <= b for a, b in sections)


def test_detect_sections_is_not_the_same_fixed_shape_for_every_score():
    """The old fallback was one literal list of bar ranges shaped like a single song; sections for
    a differently-structured score must actually differ, not just be that same constant."""
    ave_house = optimize_cli.detect_sections(_score_text("ave-house.apr"))
    markup_demo = optimize_cli.detect_sections(_score_text("markup-demo.apr"))
    assert ave_house != markup_demo


def test_detect_sections_falls_back_to_phrase_bars_when_the_score_marks_no_boundaries():
    """`minor-line.apr` declares no `bars A-B` on any track (every part just follows the chords),
    so there's nothing for two tracks to agree on -- the fallback is fixed-length phrases from
    bar 1 to the score's own last bar."""
    text = _score_text("minor-line.apr")
    sections = optimize_cli.detect_sections(text)
    assert sections == [(a, min(a + optimize_cli.PHRASE_BARS - 1, sections[-1][1]))
                         for a in range(1, sections[-1][1] + 1, optimize_cli.PHRASE_BARS)]


# --------------------------------------------------------------------------- find_score_region

def test_find_score_region_derives_the_loop_control_from_ave_house():
    text = _score_text("ave-house.apr")
    found = optimize_cli.find_score_region(text, REGION_PREFIXES["loop"])
    assert found is not None
    track_name, source, region, entry = found
    assert track_name == "dark"
    assert source == "ccmixter/AlexBeroza/Ave_34409.mp3"
    assert region.startswith(("loop-", "sec-", "phrase-"))
    assert entry == (1, 32)  # `dark`'s own declared `bars 1-32`


def test_find_score_region_works_on_a_non_ave_house_score():
    """`markup-demo.apr` is a different score entirely (different tracks, different clips, no
    `bars` declared on its loop track) -- the same function must still find its own loop part."""
    text = _score_text("markup-demo.apr")
    found = optimize_cli.find_score_region(text, REGION_PREFIXES["loop"])
    assert found is not None
    track_name, source, region, entry = found
    assert track_name == "groove"
    assert source == "marine-band/stems/Thunderer/drums.wav"
    assert region.startswith(("loop-", "sec-", "phrase-"))
    # no `bars` on `track groove`, so the fallback is the score's own full length
    assert entry[0] == 1
    assert entry[1] > 0


def test_find_score_region_returns_none_when_the_score_has_no_matching_region():
    """`salamander-beat.apr` is drums-only (kit slices, not a `loop-`/`sec-`/`phrase-` region on
    its own track): the derivation must say so rather than inventing a clip."""
    text = _score_text("salamander-beat.apr")
    found = optimize_cli.find_score_region(text, REGION_PREFIXES["loop"])
    assert found is None
