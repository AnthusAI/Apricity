"""Tests for the pure decision functions in `apricity_analyze.explore.search`: the inner loop's
accept rule, and successive halving's diversity bookkeeping. Both are pulled out of the (heavy,
subprocess-driving) loops specifically so they're unit-testable without rendering anything.
"""

from __future__ import annotations

from apricity_analyze.explore import search


def _base(**over):
    d = dict(ok=True, train_objective=10.0, holdout_ok=True, holdout_objective=5.0, guard_violation_count=0,
              best_train=5.0, best_holdout=5.0, best_violation_count=0)
    d.update(over)
    return d


def test_accepts_when_training_improves_enough_holdout_holds_and_no_new_guard():
    assert search.accept_candidate(**_base(train_objective=5.0 + search.ACCEPT_MARGIN)) is True


def test_rejects_when_render_or_check_failed():
    assert search.accept_candidate(**_base(ok=False)) is False


def test_rejects_below_the_accept_margin():
    assert search.accept_candidate(**_base(train_objective=5.0 + search.ACCEPT_MARGIN - 0.01)) is False


def test_accepts_exactly_at_the_accept_margin():
    assert search.accept_candidate(**_base(train_objective=5.0 + search.ACCEPT_MARGIN)) is True


def test_rejects_when_holdout_drops():
    assert search.accept_candidate(**_base(holdout_objective=4.9)) is False


def test_accepts_when_holdout_is_unchanged():
    assert search.accept_candidate(**_base(holdout_objective=5.0)) is True


def test_rejects_when_holdout_check_failed():
    assert search.accept_candidate(**_base(holdout_ok=False)) is False


def test_rejects_a_new_guard_violation():
    assert search.accept_candidate(**_base(guard_violation_count=1)) is False


def test_accepts_when_guard_violation_count_does_not_increase():
    assert search.accept_candidate(**_base(guard_violation_count=0, best_violation_count=0)) is True
    assert search.accept_candidate(**_base(train_objective=10.0, guard_violation_count=2, best_violation_count=2)) is True


# --------------------------------------------------------------------------- diverse_top_n

def test_diverse_top_n_keeps_at_most_one_per_source():
    items = [("a1", "srcA"), ("a2", "srcA"), ("b1", "srcB"), ("c1", "srcC"), ("b2", "srcB")]
    kept = search.diverse_top_n(items, 3, source_of=lambda it: it[1])
    assert [it[0] for it in kept] == ["a1", "b1", "c1"], "first (best-ranked) item per source wins, in rank order"


def test_diverse_top_n_stops_at_n_even_with_more_sources_available():
    items = [(f"i{i}", f"src{i}") for i in range(10)]
    kept = search.diverse_top_n(items, 4, source_of=lambda it: it[1])
    assert len(kept) == 4


def test_diverse_top_n_returns_fewer_than_n_if_not_enough_distinct_sources():
    items = [("a", "srcA"), ("b", "srcA"), ("c", "srcA")]
    kept = search.diverse_top_n(items, 4, source_of=lambda it: it[1])
    assert len(kept) == 1


# --------------------------------------------------------------------------- category caps

def test_bass_category_is_capped_so_it_cannot_starve_the_rest_of_the_budget():
    """A real failure mode this guards against: as long as the checker's leave-one-out leader
    stays the bass stem, `propose()` keeps emitting *new* bass variants (relative to whatever the
    current root/octave is after each accepted nudge), so exact-op dedup alone never stops it --
    it could eat the whole inner-loop budget without ever trying the actual fix (e.g. an injected
    bad transpose on an unrelated track). `CATEGORY_CAPS["bass"]` bounds it regardless."""
    assert search.CATEGORY_CAPS["bass"] < search.INNER_BUDGET, "the cap must leave room for other categories"
    assert "notch" in search.CATEGORY_CAPS
