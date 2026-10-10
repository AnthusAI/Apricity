"""Bridges an `apricity steer` suggestion (`schema/steer.schema.json`'s `suggestions[]`, e.g.
`{"op": "track.eq_notch", "track": "bright", "hz": 246.9, "gain": -9, "q": 12, "bars": [33, 35],
"why": "..."}`) to `apricity_analyze.explore.ops.apply`'s `{"op": name, **args}` shape.

The two don't line up exactly: `why` (and sometimes `bars`, when the op doesn't take a bar range)
must be dropped, and `track.eq_notch`'s `gain`/`q` are continuous in the steering report but
`ops.py` only writes the DSL's quantized notch strengths (`NOTCH_GAINS`, `NOTCH_QS`) -- so this
rounds to the nearest allowed value rather than raising `OpError` on every suggestion.
"""

from __future__ import annotations

import inspect

from apricity_analyze.explore import ops as ops_mod


class UnsupportedOp(ValueError):
    pass


def _nearest(value: float, allowed: tuple) -> int:
    return min(allowed, key=lambda a: abs(a - value))


def op_from_suggestion(suggestion: dict) -> dict:
    """A steer suggestion -> an `ops.apply`-ready op dict. Raises `UnsupportedOp` for a
    suggestion op the optimizer ops don't implement yet (e.g. `clip.retune`)."""
    name = suggestion.get("op")
    if name not in ops_mod.APPLY:
        raise UnsupportedOp(f"{name!r} has no optimizer op yet (supported: {sorted(ops_mod.APPLY)})")
    fn = ops_mod.APPLY[name]
    accepted = set(inspect.signature(fn).parameters) - {"text"}
    args = {k: v for k, v in suggestion.items() if k in accepted}

    if name == "track.eq_notch":
        args["gain"] = _nearest(args["gain"], ops_mod.NOTCH_GAINS)
        args["q"] = _nearest(args["q"], ops_mod.NOTCH_QS)
    if "bars" in args and args["bars"] is not None:
        args["bars"] = [int(round(b)) for b in args["bars"]]

    return {"op": name, **args}


def describe_op(op: dict) -> str:
    return ops_mod.describe(op)


def apply_op(text: str, op: dict) -> str:
    return ops_mod.apply(text, op)
