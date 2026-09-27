"""Tests for `apricity_analyze.explore.evaluate`: the cache (a hit doesn't re-render) and the sha
key (bars matter)."""

from __future__ import annotations

import pathlib

from apricity_analyze.explore import evaluate as evaluate_mod


def test_score_sha_is_stable_and_bars_change_it():
    a = evaluate_mod.score_sha("tempo 100\n")
    b = evaluate_mod.score_sha("tempo 100\n")
    c = evaluate_mod.score_sha("tempo 100\n", bars=(9, 24))
    d = evaluate_mod.score_sha("tempo 100\n", bars=(9, 24))
    e = evaluate_mod.score_sha("tempo 100\n", bars=(33, 40))
    assert a == b
    assert c == d
    assert a != c != e


def test_absolutize_samples_rewrites_the_samples_line():
    text = "tempo 100\nkey C\nsamples ../samples\nclip a = x.wav\n"
    out = evaluate_mod.absolutize_samples(text)
    assert "samples ../samples" not in out
    assert str(evaluate_mod.ROOT / "samples") in out
    assert "clip a = x.wav" in out  # everything else untouched


def test_cache_hit_does_not_re_render(tmp_path, monkeypatch):
    calls = []

    def fake_render_and_check(self, text, key, bars, allow_mute):
        calls.append(key)
        return evaluate_mod.EvalResult(ok=True, objective=42.0, consonance=50.0)

    monkeypatch.setattr(evaluate_mod.Evaluator, "_render_and_check", fake_render_and_check)
    ev = evaluate_mod.Evaluator(tmp_path)

    r1 = ev.evaluate("tempo 100\n")
    r2 = ev.evaluate("tempo 100\n")
    assert len(calls) == 1, "the second call should hit the cache, not render again"
    assert r1.objective == r2.objective == 42.0
    assert r1.cache_hit is False
    assert r2.cache_hit is True

    r3 = ev.evaluate("tempo 120\n")
    assert len(calls) == 2, "different text is a different cache key"


def test_delete_cache_removes_apr_wav_stems_and_json_but_not_baseline(tmp_path, monkeypatch):
    """Kanbus apricitus-ae80d4: a losing candidate's render must not linger in `.cache/` once its
    metrics have been read. `baseline.json` (the run's one shared reference point) lives outside
    `.cache/` and must survive."""

    def fake_render_and_check(self, text, key, bars, allow_mute):
        stems = self.cache_dir / f"{key}.stems"
        stems.mkdir(parents=True)
        (stems / "stems.json").write_text("{}")
        return evaluate_mod.EvalResult(ok=True, objective=1.0, stems_dir=str(stems))

    monkeypatch.setattr(evaluate_mod.Evaluator, "_render_and_check", fake_render_and_check)
    ev = evaluate_mod.Evaluator(tmp_path)
    ev.baseline_path.write_text("{}")  # written by check.check normally; stand in for it here

    key = evaluate_mod.score_sha("tempo 100\n")
    ev.evaluate("tempo 100\n")
    assert (ev.cache_dir / f"{key}.json").exists()
    assert (ev.cache_dir / f"{key}.stems").exists()

    evaluate_mod.delete_cache(ev, "tempo 100\n")
    assert not (ev.cache_dir / f"{key}.json").exists()
    assert not (ev.cache_dir / f"{key}.apr").exists()
    assert not (ev.cache_dir / f"{key}.wav").exists()
    assert not (ev.cache_dir / f"{key}.stems").exists()
    assert ev.baseline_path.exists(), "the shared baseline must not be touched by cache cleanup"

    # Deleting is idempotent, and forces a real re-render rather than a stale cache hit.
    calls_before = 1
    ev.evaluate("tempo 100\n")
    assert (ev.cache_dir / f"{key}.stems").exists(), "re-evaluating after delete_cache should render again"


def test_cache_survives_a_new_evaluator_instance(tmp_path, monkeypatch):
    """The cache is on disk (`renders/explore/<run>/.cache/`), not just in memory: a fresh
    `Evaluator` pointed at the same run directory should still see a previous run's cache."""
    calls = []

    def fake_render_and_check(self, text, key, bars, allow_mute):
        calls.append(key)
        return evaluate_mod.EvalResult(ok=True, objective=1.0)

    monkeypatch.setattr(evaluate_mod.Evaluator, "_render_and_check", fake_render_and_check)
    evaluate_mod.Evaluator(tmp_path).evaluate("tempo 100\n")
    evaluate_mod.Evaluator(tmp_path).evaluate("tempo 100\n")
    assert len(calls) == 1
