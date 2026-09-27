"""Ops edit only a line's code, never its trailing comment (apricitus-ab3291): cycle2-bright's
`clip.root` wrote `root G1` inside the comment, so the fix was silently a no-op. Pure text tests, so
they run without a release binary."""

from __future__ import annotations

import re

from apricity_analyze.explore import ops

SCORE = """tempo 120
clip bright = ccmixter/jlbrock44/260809-Funky-Nurykabe_29186.mp3  sec-A1
clip low    = ccmixter/AlexBeroza/Ave_34409.mp3  hold-4  root Ab1  # a clean low note: the root is really A-flat

track bright  bars 9-40  volume 4  transpose 2  group music  # the groove; volume matters, transpose it with care
  eq  peak -4@800 q8  # tame the boxiness
track low  voicing root  octave 2  bars 9-40  volume -8  # bass: octave 2 sits under the loop
"""


def line(text: str, start: str) -> str:
    return next(l for l in text.splitlines() if l.startswith(start))


def code_and_comment(l: str) -> tuple[str, str]:
    code, _, comment = l.partition("#")
    return code, comment


def test_split_comment_follows_the_parser_rule():
    assert ops._split_comment('track a  steps "x # x"  # note') == ('track a  steps "x # x"', "# note")
    assert ops._split_comment("track a  volume 2") == ("track a  volume 2", "")


def test_clip_root_replaces_the_pin_before_the_comment():
    out = ops.clip_root(SCORE, clip="low", note="G1")
    code, comment = code_and_comment(line(out, "clip low"))
    assert re.search(r"\broot G1\b", code) and "Ab1" not in code
    assert comment == " a clean low note: the root is really A-flat"


def test_every_option_op_writes_code_and_keeps_comments_intact():
    cases = [
        (ops.track_transpose, dict(track="bright", value=-3), "track bright", r"\btranspose -3\b"),
        (ops.track_volume, dict(track="bright", delta=-2), "track bright", r"\bvolume 2\b"),
        (ops.track_octave, dict(track="low", n=3), "track low", r"\boctave 3\b"),
        (ops.track_release, dict(track="low", ms=400), "track low", r"\brelease 400ms\b"),
        (ops.track_hp, dict(track="low", hz=60), "track low", r"\bfilter hp 60 24dB\b"),
    ]
    for op, args, start, want in cases:
        before = code_and_comment(line(SCORE, start))[1]
        code, comment = code_and_comment(line(op(SCORE, **args), start))
        assert re.search(want, code), (op.__name__, code)
        assert comment == before, (op.__name__, comment)


def test_words_inside_a_comment_are_never_matched():
    # The bright comment mentions "volume" and "transpose": only the code's own options change.
    out = ops.track_volume(SCORE, track="bright", delta=2)
    assert code_and_comment(line(out, "track bright"))[1].endswith("transpose it with care")
    swapped = ops.cast_swap(SCORE, role="bright", sample="x.mp3", clip="loop-1")
    code, comment = code_and_comment(line(swapped, "track bright"))
    assert "transpose" not in code and "transpose it with care" in comment


def test_eq_notch_appends_before_an_eq_comment():
    out = ops.track_eq_notch(SCORE, track="bright", hz=233, gain=-8, q=12)
    code, comment = code_and_comment(line(out, "  eq"))
    assert "peak -8@233 q12" in code and comment == " tame the boxiness"
