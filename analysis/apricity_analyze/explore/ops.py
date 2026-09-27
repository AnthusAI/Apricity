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
    "clip.root",
    "track.octave",
    "track.release",
    "track.volume",
    "track.add_part",
})

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


def _set_inline_option(line: str, option: str, value: str | None) -> str:
    """Remove any existing `<option> <token>` from a track/clip declaration line, then append
    `<option> <value>` when `value` isn't None (removal only, when it is)."""
    line = re.sub(rf"\s+{re.escape(option)}\s+\S+", "", line)
    if value is not None:
        line = f"{line.rstrip()}  {option} {value}"
    return line


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
    new_text = re.sub(rf"^(track\s+{re.escape(role)}\b[^\n]*?)\s+transpose\s+\S+", r"\1", new_text, flags=re.M)
    new_text = "\n".join(l for l in new_text.splitlines() if f"# only:{role}" not in l)
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
    total_peaks = sum(lines[i].count("peak") for i in eq_idx)
    if total_peaks >= MAX_NOTCHES_PER_TRACK:
        raise OpError(f"{track}: already at the {MAX_NOTCHES_PER_TRACK}-notch cap")
    token = f"peak {gain}@{_hz(hz)} q{q}"
    for i in eq_idx:
        if lines[i].count("peak") < MAX_PEAKS_PER_EQ_LINE:
            lines[i] = f"{lines[i].rstrip()}  {token}"
            return _join(lines)
    lines.insert(start + 1, f"  eq  {token}")
    return _join(lines)


# --------------------------------------------------------------------------- track.hp

def track_hp(text: str, *, track: str, hz: float, slope: str = "24dB", on: bool = True) -> str:
    """Toggle a highpass on `track`'s own declaration line (the inline `filter hp <hz> <slope>`
    option, the same one Ave House already uses on `bright`/`h`), replacing any filter already
    there. `slope` is `"12dB"` or `"24dB"`."""
    if slope not in ("12dB", "24dB"):
        raise OpError(f"track.hp slope must be 12dB or 24dB, not {slope}")
    lines = _lines(text)
    start = _track_decl_index(lines, track)
    line = re.sub(r"\s+filter\s+(lp|hp)\s+\S+(\s+res\s+\S+)?(\s+(12|24)dB)?", "", lines[start])
    if on:
        line = f"{line.rstrip()}  filter hp {_hz(hz)} {slope}"
    lines[start] = line
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
    m = re.search(r"\bvolume\s+([+-]?\d+(?:\.\d+)?)", lines[start])
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
    "clip.root": clip_root,
    "track.octave": track_octave,
    "track.release": track_release,
    "track.volume": track_volume,
    "track.add_part": track_add_part,
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
    return f"{name}({a})"
