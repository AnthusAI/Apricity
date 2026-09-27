"""MAP-Elites archive determinism and the objective's null-control gating (Kanbus apricitus-a9ad5b
acceptance tests 1 and 3): inserting the same entries in a different order produces the same
top-N, capacity per cell is respected, and the null control's composite is the fixed `J=100`
anchor every finalist's `delta = J - J_null >= 2` margin is measured against."""

from __future__ import annotations

import dataclasses

from apricity_analyze.optimize import archive, objective
from apricity_analyze.optimize.genome import Genome


def _g(role="loop", source="s1", clip="loop-1", **kw):
    return Genome(role=role, source=source, clip=clip, entry=(1, 8), **kw)


def test_capacity_keeps_best_n_per_cell():
    arch = archive.Archive(capacity=2)
    gs = [_g(volume=v) for v in (-12.0, -9.0, -6.0, -3.0, 0.0)]
    for i, g in enumerate(gs):
        arch.insert(g, float(i), None, None)  # increasing J: the last two are the best
    cell = gs[0].cell()
    bucket = arch.cells[cell]
    assert len(bucket) == 2
    assert [e.J for e in bucket] == [4.0, 3.0]


def test_insertion_order_does_not_change_top_n():
    gs = [_g(source=f"s{i}", volume=float(-i)) for i in range(10)]
    js = {g.key(): float(i) for i, g in enumerate(gs)}

    def build(order):
        arch = archive.Archive(capacity=2)
        for g in order:
            arch.insert(g, js[g.key()], None, None)
        return [e.genome.key() for e in arch.top_n(5)]

    forward = build(gs)
    backward = build(list(reversed(gs)))
    shuffled = build([gs[i] for i in (3, 0, 7, 1, 9, 2, 8, 4, 6, 5)])
    assert forward == backward == shuffled


def test_top_n_respects_max_per_source():
    arch = archive.Archive(capacity=4)
    for role in ("loop", "bass"):  # different cells so capacity doesn't clip them
        for i in range(3):
            arch.insert(_g(role=role, source="dup", volume=float(-i)), 10.0 - i, None, None)
    top = arch.top_n(10, max_per_source=1)
    sources = [e.genome.source for e in top]
    assert sources.count("dup") == 1


def test_null_composite_is_the_fixed_j100_anchor():
    null = objective.null_composite()
    assert null.J == 100.0
    assert null.contribution == 0.0
    assert all(v == 0.0 for v in null.penalties.values())


def test_finalist_margin_gate():
    null = objective.null_composite()

    class T:
        clash = 0.0
        chord = 0.0
        density = 0.0
        taste = 0.0
        contribution = 0.05  # 100*0.20*0.05 = +1.0, under the delta=2 margin
        ok = True

    weak = objective.composite(T())
    assert (weak.J - null.J) < objective.DELTA_MARGIN_DEFAULT

    class T2(T):
        contribution = 0.15  # 100*0.20*0.15 = +3.0, clears delta=2

    strong = objective.composite(T2())
    assert (strong.J - null.J) >= objective.DELTA_MARGIN_DEFAULT


def test_composite_gates_a_failed_surrogate_to_zero():
    class Failed:
        ok = False

    comp = objective.composite(Failed())
    assert comp.J == 0.0
    assert comp.ok is False
