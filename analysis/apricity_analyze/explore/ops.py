"""Typed JSON operators applied to a base score's *text*, deterministically. Each op is a small
JSON-able dict `{"op": "<name>", **args}`; `apply(text, op)` returns new text. Ops never mute or
delete anything -- there is no such op in this module, by design (`search.py`'s coordinate descent
can only make a track sound different, not make it silent, which would trivially "improve" a
clash score by removing material).

Callers (`evaluate.py`) are responsible for validating an op's result by compiling it; an op here
only edits text. Applying the same op twice is idempotent (it replaces its own clause rather than
appending a second one), so a search can safely re-propose an op it already tried.
"""

from __future__ import annotations

import re

# The whole v0 operator set. No "mute" or "delete" op exists, by design (see module docstring);
# tests assert this set doesn't grow one by accident.
OP_NAMES = frozenset({
    "cast.swap",
    "track.eq_notch",
    "track.hp",
    "track.transpose",
    "track.transpose_span",
    "track.bars",
    "clip.root",
    "track.octave",
    "track.release",
    "track.volume",
    "track.add_part",
    "track.harmonic",
})

# The chord-following EQ's presets (spec-harmony-v2.md sec 4.7, Kanbus apricitus-db34ad). The
# optimizer may try any of them, the creative ones as well as the invisible cleanup.
HARMONIC_PRESETS = {
    "cleanup": "harmonic cut 6dB tolerance 20c harmonics 6 range 100..3k glide 60ms",
    "autotune": "harmonic cut 14dB tolerance 40c harmonics 0 range 60..6k glide 15ms",
    "resonant": "harmonic boost 10dB tolerance 12c range 80..2k glide 120ms mix 60%",
    "comb": "harmonic both 18dB boost 14dB tolerance 8c harmonics 2 range 60..8k glide 250ms",
}

MAX_PEAKS_PER_EQ_LINE = 4
MAX_NOTCHES_PER_TRACK = 8
NOTCH_GAINS = (-4, -6, -8, -10)
NOTCH_QS = (8, 12)


class OpError(ValueError):
    """An op that can't be applied as asked (missing track/clip, a cap exceeded, a bad value).
    Callers (the search) should treat this as "this proposal doesn't apply here" and move on."""


def _lines(text: str) -> list[str]:
    return text.splitlines()


def _join(lines: list[str]) -> str:
    return "\n".join(lines) + "\n"


def _track_decl_index(lines: list[str], track: str) -> int:
    """Line index of `track <track> ...` (word-boundary match; also matches `track <track>.<pad>`
    only when `track` itself is asked for verbatim -- a kit pad sub-track like `drums.kick` is
    addressed by its own full name, e.g. `track drums.kick ...`)."""
    pat = re.compile(rf"^track\s+{re.escape(track)}(\s|$)")
    for i, line in enumerate(lines):
        if pat.match(line):
            return i
    raise OpError(f"no `track {track}` line in the score")


def _track_block_end(lines: list[str], start: int) -> int:
    """End index (exclusive) of the track's block: its declaration line plus every indented
    (effect/automation) line right after it."""
    end = start + 1
    while end < len(lines) and lines[end] and lines[end][0] in " \t":
        end += 1
    return end


def _clip_decl_index(lines: list[str], clip: str) -> int:
    pat = re.compile(rf"^clip\s+{re.escape(clip)}\s*=")
    for i, line in enumerate(lines):
        if pat.match(line):
            return i
    raise OpError(f"no `clip {clip} = ...` line in the score")


def _split_comment(line: str) -> tuple[str, str]:
    """`(code, comment)`: the parser's rule (crates/apricity-score/src/dsl.rs `words`), a comment
    starts at the first `#` outside double quotes. `comment` keeps its `#` ("" when there is none)."""
    in_quote = False
    for i, c in enumerate(line):
        if c == '"':
            in_quote = not in_quote
        elif c == "#" and not in_quote:
            return line[:i].rstrip(), line[i:]
    return line.rstrip(), ""


def _edit_code(line: str, edit) -> str:
    """Apply `edit` to the code part of `line` only, then put its trailing comment back, so an op
    never writes an option into a comment or matches words inside one."""
    code, comment = _split_comment(line)
    code = edit(code).rstrip()
    return f"{code}  {comment}" if comment else code


def _set_inline_option(line: str, option: str, value: str | None) -> str:
    """Remove any existing `<option> <token>` from a track/clip declaration line, then append
    `<option> <value>` when `value` isn't None (removal only, when it is). A trailing comment stays
    at the end of the line, untouched."""
    def edit(code: str) -> str:
        code = re.sub(rf"\s+{re.escape(option)}\s+\S+", "", code)
        return f"{code.rstrip()}  {option} {value}" if value is not None else code
    return _edit_code(line, edit)


def _hz(hz: float) -> str:
    hz = float(hz)
    return f"{hz/1000:g}k" if hz >= 1000 and (hz % 100) == 0 else f"{hz:g}"


# --------------------------------------------------------------------------- cast.swap

def cast_swap(text: str, *, role: str, sample: str, clip: str) -> str:
    """Point `role`'s clip at a different `sample`/`clip` (saved region), let the harmony solver
    re-fit it (`transpose auto`, by dropping any fixed transpose), and drop any `# only:<role>`
    lines (fixes specific to the clip being replaced, e.g. its own notches)."""
    new_text, n = re.subn(rf"^(clip\s+{re.escape(role)}\s*=\s*)\S+\s+\S+.*$", rf"\g<1>{sample}  {clip}", text, flags=re.M)
    if n == 0:
        raise OpError(f"no `clip {role} = ...` line in the score")
    track = re.compile(rf"^track\s+{re.escape(role)}(\s|$)")
    drop_transpose = lambda code: re.sub(r"\s+transpose\s+\S+", "", code)
    new_text = "\n".join(_edit_code(l, drop_transpose) if track.match(l) else l
                          for l in new_text.splitlines() if f"# only:{role}" not in l)
    return new_text if new_text.endswith("\n") else new_text + "\n"


# --------------------------------------------------------------------------- track.eq_notch

def track_eq_notch(text: str, *, track: str, hz: float, gain: int, q: int) -> str:
    """Add a notch (a narrow EQ cut) to `track`'s eq line(s): at most 4 peaks on any one `eq`
    line, at most 8 notch bands total on the track (a second `eq` line is added once the first is
    full -- the DSL numbers repeated effects `eq`, `eq2`, ... for automation targets, but each is
    written the same way, as another `eq ...` line)."""
    if gain not in NOTCH_GAINS:
        raise OpError(f"track.eq_notch gain must be one of {NOTCH_GAINS}, not {gain}")
    if q not in NOTCH_QS:
        raise OpError(f"track.eq_notch q must be one of {NOTCH_QS}, not {q}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    end = _track_block_end(lines, start)
    eq_idx = [i for i in range(start + 1, end) if lines[i].strip().split(" ", 1)[0] == "eq"]
    total_peaks = sum(_split_comment(lines[i])[0].count("peak") for i in eq_idx)
    if total_peaks >= MAX_NOTCHES_PER_TRACK:
        raise OpError(f"{track}: already at the {MAX_NOTCHES_PER_TRACK}-notch cap")
    token = f"peak {gain}@{_hz(hz)} q{q}"
    for i in eq_idx:
        if _split_comment(lines[i])[0].count("peak") < MAX_PEAKS_PER_EQ_LINE:
            lines[i] = _edit_code(lines[i], lambda code: f"{code}  {token}")
            return _join(lines)
    lines.insert(start + 1, f"  eq  {token}")
    return _join(lines)


# --------------------------------------------------------------------------- track.harmonic

def track_harmonic(text: str, *, track: str, preset: str = "cleanup", on: bool = True) -> str:
    """Toggle a `harmonic` chain-effect line on `track`'s block: one of `HARMONIC_PRESETS`
    (`cleanup` invisible touch-up, `autotune` the "autotune-ish" setting, `resonant` a tuned
    resonance, `comb` the chord-comb pad). Replaces any `harmonic` line already on the track, so
    re-proposing this op (a different preset, or `on=False`) is idempotent."""
    if preset not in HARMONIC_PRESETS:
        raise OpError(f"track.harmonic preset must be one of {sorted(HARMONIC_PRESETS)}, not {preset!r}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    end = _track_block_end(lines, start)
    harmonic_idx = [i for i in range(start + 1, end) if _split_comment(lines[i])[0].strip().split(" ", 1)[0] == "harmonic"]
    for i in sorted(harmonic_idx, reverse=True):
        del lines[i]
    if on:
        lines.insert(start + 1, f"  {HARMONIC_PRESETS[preset]}")
    return _join(lines)


# --------------------------------------------------------------------------- track.hp

def track_hp(text: str, *, track: str, hz: float, slope: str = "24dB", on: bool = True) -> str:
    """Toggle a highpass on `track`'s own declaration line (the inline `filter hp <hz> <slope>`
    option), replacing any filter already there. `slope` is `"12dB"` or `"24dB"`."""
    if slope not in ("12dB", "24dB"):
        raise OpError(f"track.hp slope must be 12dB or 24dB, not {slope}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    def edit(code: str) -> str:
        code = re.sub(r"\s+filter\s+(lp|hp)\s+\S+(\s+res\s+\S+)?(\s+(12|24)dB)?", "", code)
        return f"{code.rstrip()}  filter hp {_hz(hz)} {slope}" if on else code
    lines[start] = _edit_code(lines[start], edit)
    return _join(lines)


# --------------------------------------------------------------------------- track.transpose

def track_transpose(text: str, *, track: str, value: str | int) -> str:
    """Set `track`'s transpose: `"auto"` (the harmony solver fits it) or a fixed integer number
    of semitones."""
    if isinstance(value, str) and value not in ("auto", "follow"):
        raise OpError(f"track.transpose value must be auto, follow or an integer, not {value!r}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    lines[start] = _set_inline_option(lines[start], "transpose", str(value))
    return _join(lines)


# --------------------------------------------------------------------------- track.transpose_span

def _parse_bars_range(code: str) -> tuple[int, int] | None:
    """The `bars a-b` (or bare `bars a`) an already-comment-stripped declaration line carries, or
    `None` when it has no `bars` option at all (the whole piece)."""
    m = re.search(r"\bbars\s+(\d+)(?:-(\d+))?\b", code)
    if not m:
        return None
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else a
    return (a, b)


def _track_decl_indices(lines: list[str], track: str) -> list[int]:
    """Every `track <track> ...` declaration line's index, in file order (a role can have more
    than one, e.g. after `track_transpose_span` has already split it once)."""
    pat = re.compile(rf"^track\s+{re.escape(track)}(\s|$)")
    return [i for i, line in enumerate(lines) if pat.match(line)]


def track_transpose_span(text: str, *, track: str, bars: list[int] | tuple[int, int], value: str | int, total_bars: int | None = None) -> str:
    """Give `track` a fixed transpose for ONE bar range only (both ends inclusive, matching the
    DSL's own `bars a-b`), leaving the rest of its play range untouched (`spec-harmony-v2.md` sec
    3.4/3.2: the steering report's per-span transposition-map suggestion).

    The language has no per-span transpose statement -- `transpose` is one value for the whole
    `track` line (`docs/language.md`'s Statements/track-option). This op expresses "transpose only
    bars a-b" the way the language already supports the same clip on two different NAMED tracks
    (`as <name>`) with two different `bars` ranges and `transpose` values: it narrows the
    declaration that currently COVERS `bars` to exclude `[a, b]` and adds one or two more
    `track <track> ... as <alias>` blocks -- cloned from it (every option, and every indented
    effect/automation line) except `bars`/`transpose`/`as` -- covering the bars before/after the
    span, each keeping that block's own transpose. The span itself becomes its own block with
    `transpose value`.

    Idempotent: a track can end up with several `track <track> ...` declarations (one per split);
    this op finds the ONE whose own `bars` range contains the requested span (not just the first
    line matching `track <track>`), so re-applying to a span that's already its own block updates
    that block's `transpose` in place instead of re-splitting the first block it finds -- which,
    after an earlier split, would usually be the "before" block, not the span itself.

    When the covering block has an explicit `bars c-d` range, the split is computed against it.
    Otherwise (no `bars` at all, "the whole piece", and only possible when `track` has exactly one
    declaration so far) `total_bars` is REQUIRED: the language gives no "everywhere except a-b"
    form for an unbounded range, so there's no way to compute the "after the span" range without
    knowing where the piece ends. That's a real gap in the DSL, not something this op works around
    -- the smallest fix would be a `bars <a>-<b> except <c>-<d>` grammar, or (closer to how
    `transpose` itself reads) a per-span `transpose <n> bars <a>-<b>` sub-line under `track`;
    neither exists today, so a caller with no `total_bars` and no explicit `bars` gets `OpError`
    rather than a silently wrong split."""
    if len(bars) != 2:
        raise OpError(f"track.transpose_span bars must be [start, end], not {bars!r}")
    span_a, span_b = int(bars[0]), int(bars[1])
    if span_b < span_a:
        raise OpError(f"track.transpose_span bars must have end >= start, not {bars}")

    lines = _lines(text)
    decl_indices = _track_decl_indices(lines, track)
    if not decl_indices:
        raise OpError(f"no `track {track}` line in the score")

    # Each existing declaration's own bars range: explicit `bars a-b` on that line, or -- only
    # when it's the sole declaration for this track -- the whole piece via `total_bars`.
    blocks: list[tuple[int, int, int, int]] = []  # (decl_idx, block_end_idx, a, b)
    for idx in decl_indices:
        block_end = _track_block_end(lines, idx)
        code, _ = _split_comment(lines[idx])
        rng = _parse_bars_range(code)
        if rng is None:
            if len(decl_indices) > 1:
                raise OpError(f"{track}: the block at line {idx + 1} has no `bars` range (unexpected once {track} has been split)")
            if total_bars is None:
                raise OpError(f"{track} has no explicit `bars` range; pass total_bars to split its (whole-piece) range around bars {span_a}-{span_b}")
            rng = (1, int(total_bars))
        blocks.append((idx, block_end, rng[0], rng[1]))

    covering = next(((idx, block_end, a, b) for idx, block_end, a, b in blocks if a <= span_a and span_b <= b), None)
    if covering is None:
        ranges = ", ".join(f"{a}-{b}" for _, _, a, b in blocks)
        raise OpError(f"bars {span_a}-{span_b} isn't inside any of {track}'s own ranges ({ranges})")
    start, end, orig_a, orig_b = covering

    orig_line = lines[start]
    code, _comment = _split_comment(orig_line)

    def make_line(a: int, b: int, transpose_value, name: str | None) -> str:
        bars_txt = f"{a}" if a == b else f"{a}-{b}"
        ln = _set_inline_option(orig_line, "bars", bars_txt)
        ln = _set_inline_option(ln, "transpose", None if transpose_value is None else str(transpose_value))
        ln = _set_inline_option(ln, "as", name)
        return ln

    body = lines[start + 1:end]  # indented effect/automation lines, cloned into every split block

    if orig_a == span_a and orig_b == span_b:
        # Idempotent re-apply: this block already IS the span -- update its transpose in place,
        # keep its own `as` name and bars untouched, and leave every other block alone.
        existing_as = re.search(r"\bas\s+(\S+)", code)
        name = existing_as.group(1) if existing_as else None
        new_lines = list(lines[:start])
        new_lines.append(make_line(orig_a, orig_b, value, name))
        new_lines.extend(body)
        new_lines.extend(lines[end:])
        return _join(new_lines)

    m = re.search(r"\btranspose\s+(\S+)", code)
    kept_transpose = m.group(1) if m else None

    segments: list[tuple[int, int, str | int | None]] = []
    if orig_a < span_a:
        segments.append((orig_a, span_a - 1, kept_transpose))
    segments.append((span_a, span_b, value))
    if span_b < orig_b:
        segments.append((span_b + 1, orig_b, kept_transpose))

    new_lines = list(lines[:start])
    for i, (a, b, tval) in enumerate(segments):
        alias = f"{track}_{a}_{b}"
        new_lines.append(make_line(a, b, tval, alias))
        new_lines.extend(body)
        if i != len(segments) - 1:
            new_lines.append("")
    new_lines.extend(lines[end:])
    return _join(new_lines)


# --------------------------------------------------------------------------- track.bars

def track_bars(text: str, *, track: str, bars: list[int] | tuple[int, int]) -> str:
    """Rewrite `track`'s own `bars a-b` play range (sec 3.4's "region shift" -- start or stop the
    loop on different bars), replacing whatever range it already has (or adding one, if it had
    none)."""
    if len(bars) != 2:
        raise OpError(f"track.bars bars must be [start, end], not {bars!r}")
    a, b = int(bars[0]), int(bars[1])
    if b < a:
        raise OpError(f"track.bars end must be >= start, not {bars}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    lines[start] = _set_inline_option(lines[start], "bars", f"{a}" if a == b else f"{a}-{b}")
    return _join(lines)


# --------------------------------------------------------------------------- clip.root

def clip_root(text: str, *, clip: str, note: str) -> str:
    """Pin `clip`'s root note (e.g. `"Ab1"`), overriding whatever pitch the compiler would
    otherwise hear/guess."""
    if not re.fullmatch(r"[A-Ga-g](#|b)?-?\d+", note):
        raise OpError(f"clip.root note must look like Bb2 or A1, not {note!r}")
    lines = _lines(text)
    idx = _clip_decl_index(lines, clip)
    lines[idx] = _set_inline_option(lines[idx], "root", note)
    return _join(lines)


# --------------------------------------------------------------------------- track.octave

def track_octave(text: str, *, track: str, n: int) -> str:
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    lines[start] = _set_inline_option(lines[start], "octave", str(int(n)))
    return _join(lines)


# --------------------------------------------------------------------------- track.release

def track_release(text: str, *, track: str, ms: float) -> str:
    if ms <= 0:
        raise OpError(f"track.release ms must be positive, not {ms}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    lines[start] = _set_inline_option(lines[start], "release", f"{ms:g}ms")
    return _join(lines)


# --------------------------------------------------------------------------- track.volume

def track_volume(text: str, *, track: str, delta: int) -> str:
    """Nudge `track`'s volume by `delta` dB (one of ±2, ±4) relative to whatever it's currently
    set to (0 dB when it isn't set at all)."""
    if delta not in (-4, -2, 2, 4):
        raise OpError(f"track.volume delta must be one of -4, -2, 2, 4, not {delta}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    m = re.search(r"\bvolume\s+([+-]?\d+(?:\.\d+)?)", _split_comment(lines[start])[0])
    current = float(m.group(1)) if m else 0.0
    lines[start] = _set_inline_option(lines[start], "volume", f"{current + delta:g}")
    return _join(lines)


# --------------------------------------------------------------------------- track.add_part

def _find_insert_after_clips(lines: list[str]) -> int:
    """Line index right after the last `clip <name> = ...` declaration (before `kit`/`chords`)."""
    last = -1
    for i, line in enumerate(lines):
        if re.match(r"^clip\s+\S+\s*=", line):
            last = i
    return last + 1 if last >= 0 else 0


def _find_insert_after_kits(lines: list[str]) -> int:
    """Line index right after the last `kit ...` block (declaration + its indented pad lines)."""
    last_end = None
    i = 0
    while i < len(lines):
        if re.match(r"^kit\s+\S+", lines[i]):
            end = _track_block_end(lines, i)
            last_end = end
            i = end
        else:
            i += 1
    return last_end if last_end is not None else _find_insert_after_clips(lines)


def _find_insert_before_return(lines: list[str]) -> int:
    """Line index of the first `return`/`master` line (new track blocks go right before it), or
    the end of the file when neither exists."""
    for i, line in enumerate(lines):
        if re.match(r"^(return|master)\b", line):
            return i
    return len(lines)


def _remove_clip_decl(lines: list[str], name: str) -> list[str]:
    try:
        idx = _clip_decl_index(lines, name)
    except OpError:
        return lines
    return lines[:idx] + lines[idx + 1:]


def _remove_kit_block(lines: list[str], name: str) -> list[str]:
    pat = re.compile(rf"^kit\s+{re.escape(name)}(\s|$)")
    for i, line in enumerate(lines):
        if pat.match(line):
            end = _track_block_end(lines, i)
            return lines[:i] + lines[end:]
    return lines


def _remove_track_blocks(lines: list[str], name: str) -> list[str]:
    """Remove every `track <name> ...` declaration + its indented lines (a role can have more than
    one `track` line, e.g. a build variant -- a recast drops them all)."""
    pat = re.compile(rf"^track\s+{re.escape(name)}(\.[\w-]+)?(\s|$)")
    out = list(lines)
    changed = True
    while changed:
        changed = False
        for i, line in enumerate(out):
            if pat.match(line):
                end = _track_block_end(out, i)
                out = out[:i] + out[end:]
                changed = True
                break
    return out


def track_add_part(text: str, *, track: str, clip_line: str, track_lines: list[str],
                    kit_lines: list[str] | None = None, recast: bool = False) -> str:
    """Append (or, when `recast`, first remove then append) one new part: a `clip <track> = ...`
    line, an optional `kit <track> ...` block (for a sliced-kit role), and a `track <track> ...`
    block (`track_lines[0]` is the declaration; the rest are its indented continuation lines).
    This is the optimizer's one structural op (Kanbus apricitus-a9ad5b): it never edits another
    part, so re-proposing the same genome twice is idempotent up to `recast`'s remove-then-add."""
    lines = _lines(text)
    if recast:
        lines = _remove_track_blocks(lines, track)
        lines = _remove_kit_block(lines, track)
        lines = _remove_clip_decl(lines, track)

    insert_clip_at = _find_insert_after_clips(lines)
    lines = lines[:insert_clip_at] + [clip_line] + lines[insert_clip_at:]

    if kit_lines:
        insert_kit_at = _find_insert_after_kits(lines)
        lines = lines[:insert_kit_at] + list(kit_lines) + lines[insert_kit_at:]

    insert_track_at = _find_insert_before_return(lines)
    lines = lines[:insert_track_at] + list(track_lines) + [""] + lines[insert_track_at:]
    return _join(lines)


APPLY = {
    "cast.swap": cast_swap,
    "track.eq_notch": track_eq_notch,
    "track.hp": track_hp,
    "track.transpose": track_transpose,
    "track.transpose_span": track_transpose_span,
    "track.bars": track_bars,
    "clip.root": clip_root,
    "track.octave": track_octave,
    "track.release": track_release,
    "track.volume": track_volume,
    "track.add_part": track_add_part,
    "track.harmonic": track_harmonic,
}


def apply(text: str, op: dict) -> str:
    """Apply one op (a `{"op": name, **args}` dict) to `text`. Raises `OpError` (or `KeyError` for
    an unknown op name) rather than returning invalid text; callers still must compile the result
    to confirm it's a *valid* score, which this module doesn't check."""
    name = op["op"]
    if name not in APPLY:
        raise OpError(f"unknown op {name!r}")
    args = {k: v for k, v in op.items() if k != "op"}
    return APPLY[name](text, **args)


def apply_all(text: str, ops: list[dict]) -> str:
    for op in ops:
        text = apply(text, op)
    return text


def describe(op: dict) -> str:
    """One line for the notebook / pre-registration: what this op does, in prose."""
    name = op["op"]
    a = {k: v for k, v in op.items() if k != "op"}
    if name == "cast.swap":
        return f"swap {a['role']} to {a['sample']} {a['clip']}, transpose auto"
    if name == "track.eq_notch":
        return f"notch {a['track']} at {a['hz']:g} Hz, {a['gain']:+d} dB, q{a['q']}"
    if name == "track.hp":
        return f"{'highpass' if a.get('on', True) else 'remove highpass on'} {a['track']} at {a.get('hz', 0):g} Hz {a.get('slope', '24dB')}"
    if name == "track.transpose":
        return f"transpose {a['track']} to {a['value']}"
    if name == "track.transpose_span":
        return f"transpose {a['track']} to {a['value']} for bars {a['bars'][0]}-{a['bars'][1]} only"
    if name == "track.bars":
        return f"set {a['track']}'s bars to {a['bars'][0]}-{a['bars'][1]}"
    if name == "clip.root":
        return f"pin {a['clip']}'s root to {a['note']}"
    if name == "track.octave":
        return f"set {a['track']}'s octave to {a['n']}"
    if name == "track.release":
        return f"set {a['track']}'s release to {a['ms']:g}ms"
    if name == "track.volume":
        return f"nudge {a['track']}'s volume by {a['delta']:+d}dB"
    if name == "track.add_part":
        verb = "recast" if a.get("recast") else "add"
        return f"{verb} part {a['track']}: {a['clip_line'].strip()}"
    if name == "track.harmonic":
        preset = a.get("preset", "cleanup")
        return f"{'add' if a.get('on', True) else 'remove'} the harmonic EQ ({preset}) on {a['track']}"
    return f"{name}({a})"
