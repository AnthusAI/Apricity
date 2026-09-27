"""The compile-informed surrogate (spec section 2): score a candidate genome against the
incumbent's stack *without rendering*, from `apricity compile`'s own timeline (per-event source
region, warp map, semitones, gain) plus the source manifests' `tonal.beat_chroma` /
`rhythm.beat_loudness` -- the same read-only proxy validated by `scratchpad/opt/proxy_probe.py`
(chroma cosine against rendered stems, checked across representative scores).

Masking and rhythm/density read the `fitfeat` sidecar (`<sample>.fitfeat.npz`,
`apricity_analyze.features`) -- per-quarter-beat log-band energy and onset strength/count -- and
share their formulas with `layer.py`'s L1 terms (`term_masking`, `term_rhythm_onset`), computed
the same way the chroma term already is: walk the compiled event's `warp` map and index the
source's own sidecar arrays. A sample with no sidecar falls back to `masking=0.0`/`rhythm=0.0` for
that track only (documented, not silently dropped -- see `_track_quarter_vectors`'s `has_sidecar`
flag; see Kanbus apricitus-798704 for how the sidecar-coverage gap was found and tracked). The
analytic gain step (L-BFGS-B over volume/hp) is still not implemented; volume/hp are small
discrete genes searched at L0 (see `genome.py`).
"""

from __future__ import annotations

import dataclasses
import functools
import json
import pathlib
import subprocess

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
BIN = ROOT / "target/release/apricity"
SAMPLES = ROOT / "samples"


class CompileError(RuntimeError):
    pass


@functools.lru_cache(maxsize=4096)
def _manifest_json(sample_rel: str) -> dict:
    return json.loads((SAMPLES / f"{sample_rel}.apricity.json").read_text())


def compile_text(text: str, *, absolutize) -> dict:
    """Run `apricity compile` on `text` (already-materialized score text) and return the parsed
    timeline JSON. `absolutize` is `explore.evaluate.absolutize_samples` (passed in, not imported,
    to keep this module's only hard dependency on the CLI binary)."""
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".apr", delete=False) as f:
        f.write(absolutize(text))
        path = f.name
    try:
        r = subprocess.run([str(BIN), "compile", path], capture_output=True, text=True, timeout=30)
    finally:
        pathlib.Path(path).unlink(missing_ok=True)
    if r.returncode != 0:
        raise CompileError(r.stderr.strip()[-1500:])
    return json.loads(r.stdout)


def _track_beat_vectors(compiled: dict, track: str) -> tuple[np.ndarray, np.ndarray]:
    """`(chroma, mass)`: `(n_beats, 12)` loudness-weighted chroma and `(n_beats,)` total tonal
    mass for one compiled track, built the way `proxy_probe.py` validated: for every event on
    `track`, walk its beats, map score-beat -> source-time via the event's own `warp` map, index
    the source manifest's `beat_chroma`/`beat_loudness` at that source beat, roll by the event's
    `semitones`, and weight by loudness and the event's `gain_db`."""
    n_beats = int(round(compiled["length_beats"]))
    chroma = np.zeros((n_beats, 12))
    sources = compiled["sources"]
    for ev in compiled["events"]:
        if ev["track"] != track:
            continue
        src = sources[ev["source"]]
        p = pathlib.Path(src["path"])
        try:
            rel = p.relative_to(SAMPLES)
        except ValueError:
            continue  # a source outside samples/ (shouldn't happen); skip rather than crash
        try:
            m = _manifest_json(str(rel))
        except (OSError, json.JSONDecodeError):
            continue
        beats = np.array(m.get("rhythm", {}).get("beats", []))
        bc = np.array(m.get("tonal", {}).get("beat_chroma", []))
        bl = np.array(m.get("rhythm", {}).get("beat_loudness", []))
        if len(beats) < 2 or len(bc) == 0:
            continue
        warp = np.array(ev["warp"])
        # A pitched (voicing/notes) track fires sub-beat note events -- e.g. a 16th note is
        # `dur_beats=0.25` -- which `int(round(...))` would round down to 0, skipping the event
        # entirely and silently zeroing out a candidate's chroma (cand_mass always 0.0), which
        # score_genome then rejects as "nothing landed on this track." `dur` is floored to at
        # least 1 beat (the one the event starts in); the sampled offset stays inside the event's
        # own true duration rather than always mid-beat, so a short note still reads the right
        # source instant.
        raw_dur = float(ev["dur_beats"])
        dur = max(1, int(round(raw_dur)))
        for k in range(dur):
            b = int(ev["start_beat"]) + k
            if b < 0 or b >= n_beats:
                continue
            t_offset = (k + 0.5) if raw_dur >= 1.0 else (raw_dur * 0.5)
            src_t = float(np.interp(t_offset, warp[:, 1], warp[:, 0]))
            i = int(np.searchsorted(beats, src_t) - 1)
            i = max(0, min(i, len(bc) - 1))
            w = 10 ** (float(bl[min(i, len(bl) - 1)]) / 20.0) if len(bl) else 1.0
            vec = np.roll(bc[i], int(ev.get("semitones", 0))) * w * 10 ** (float(ev.get("gain_db", 0.0)) / 20.0)
            chroma[b] += vec
    mass = chroma.sum(axis=1)
    return chroma, mass


@functools.lru_cache(maxsize=4096)
def _fitfeat_sidecar(sample_rel: str):
    """`(beat_bands_db, beat_onset_strength, beat_onset_count, beat_tonalness) | None`, read once
    per sample. `None` when the sample has no sidecar (see `features.sidecar_path_for`) -- callers
    treat that as "no masking/rhythm signal for this track," not an error."""
    from .. import features as features_mod

    manifest_path = SAMPLES / f"{sample_rel}.apricity.json"
    sidecar_path = features_mod.sidecar_path_for(manifest_path)
    if not sidecar_path.exists():
        return None
    try:
        with np.load(sidecar_path, allow_pickle=False) as z:
            return (z["beat_bands_db"].astype(np.float64), z["beat_onset_strength"].astype(np.float64),
                    z["beat_onset_count"].astype(np.float64), z["beat_tonalness"].astype(np.float64))
    except Exception:  # noqa: BLE001 -- a corrupt/partial sidecar is just "no signal," not a crash
        return None


def _track_quarter_vectors(compiled: dict, track: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, bool]:
    """`(bands, onset_strength, onset_count, has_sidecar)` on a quarter-beat grid over the whole
    compiled score, for one track -- the `fitfeat` analogue of `_track_beat_vectors`'s chroma walk:
    for every event on `track`, map each of its quarter-beats to source time via the event's own
    `warp` map, then index that source's `fitfeat` sidecar (already on a quarter-beat grid) at the
    nearest quarter-beat. `has_sidecar` is `True` only if at least one event's source had one --
    a track built entirely from un-sidecar'd sources contributes an honest all-zero masking/rhythm
    signal (documented in the module docstring), not a crash."""
    n_beats = int(round(compiled["length_beats"]))
    n_q = n_beats * 4
    bands = np.zeros((n_q, 24))
    onset_strength = np.zeros(n_q)
    onset_count = np.zeros(n_q)
    has_sidecar = False
    sources = compiled["sources"]
    for ev in compiled["events"]:
        if ev["track"] != track:
            continue
        src = sources[ev["source"]]
        p = pathlib.Path(src["path"])
        try:
            rel = p.relative_to(SAMPLES)
        except ValueError:
            continue
        sidecar = _fitfeat_sidecar(str(rel))
        if sidecar is None:
            continue
        has_sidecar = True
        src_bands_db, src_onset_strength, src_onset_count, _tonalness = sidecar
        try:
            m = _manifest_json(str(rel))
        except (OSError, json.JSONDecodeError):
            continue
        beats = np.array(m.get("rhythm", {}).get("beats", []))
        if len(beats) < 2:
            continue
        warp = np.array(ev["warp"])
        n_src_q = src_bands_db.shape[0]
        # Same sub-beat-event fix as `_track_beat_vectors` (see its comment), in quarter-beat
        # units: a 0.25-beat note is exactly 1 quarter-beat, not 0 -- `int(round(raw_dur))` on the
        # *beat* count truncated it to nothing before this fix.
        raw_dur = float(ev["dur_beats"])
        q_start = ev["start_beat"] * 4.0
        n_q_event = max(1, int(round(raw_dur * 4.0)))
        for qi in range(n_q_event):
            q = int(round(q_start)) + qi
            b, qk = divmod(q, 4)
            if b < 0 or b >= n_beats:
                continue
            t_offset = ((qi + 0.5) / 4.0) if raw_dur >= 1.0 else (raw_dur * 0.5)
            src_t = float(np.interp(t_offset, warp[:, 1], warp[:, 0]))
            i = int(np.searchsorted(beats, src_t) - 1)
            i = max(0, min(i, len(beats) - 2))
            src_q = int(round(i * 4 + ((src_t - beats[i]) / max(beats[i + 1] - beats[i], 1e-9)) * 4))
            src_q = max(0, min(src_q, n_src_q - 1))
            gain = 10 ** (float(ev.get("gain_db", 0.0)) / 20.0)
            bands[q] += (10 ** (src_bands_db[src_q] / 10.0)) * (gain ** 2)  # dB -> linear power
            onset_strength[q] += src_onset_strength[src_q] * gain
            onset_count[q] += src_onset_count[src_q]
    return bands, onset_strength, onset_count, has_sidecar


def _masking_term(cand_bands: np.ndarray, stack_bands: dict[str, np.ndarray]) -> float:
    """Cosine similarity of band energy between the candidate and each stack track, per
    quarter-beat, averaged -- the surrogate analogue of `layer.term_masking` (unweighted by
    tonalness here: the sidecar's per-beat tonalness isn't on the same quarter-beat grid as bands,
    and averaging the raw cosine is a reasonable Phase-1 stand-in, documented)."""
    if not stack_bands:
        return 0.0
    sims = []
    for sb in stack_bands.values():
        n = min(cand_bands.shape[0], sb.shape[0])
        for i in range(n):
            ca, sa = cand_bands[i], sb[i]
            na, nb = np.linalg.norm(ca), np.linalg.norm(sa)
            if na < 1e-9 or nb < 1e-9:
                continue
            sims.append(float(np.dot(ca, sa) / (na * nb)))
    return float(np.clip(np.mean(sims), 0.0, 1.0)) if sims else 0.0


def _rhythm_term(cand_onset: np.ndarray, stack_onset: dict[str, np.ndarray]) -> float:
    """Onset-envelope correlation, the surrogate analogue of `layer.term_rhythm_onset`."""
    if not stack_onset:
        return 0.0
    rs = []
    for so in stack_onset.values():
        n = min(len(cand_onset), len(so))
        if n < 2:
            continue
        a, b = cand_onset[:n], so[:n]
        if np.std(a) < 1e-9 or np.std(b) < 1e-9:
            continue
        rs.append(max(0.0, float(np.corrcoef(a, b)[0, 1])))
    return float(np.clip(np.mean(rs), 0.0, 1.0)) if rs else 0.0


def stack_vectors(compiled: dict, exclude_tracks: set[str]) -> dict[str, np.ndarray]:
    """Per-beat chroma for every pitched track in the compiled score except `exclude_tracks` (the
    candidate's own track name(s), so a recast doesn't compare the part against itself)."""
    track_names = {ev["track"] for ev in compiled["events"]} - exclude_tracks
    out = {}
    for t in track_names:
        chroma, mass = _track_beat_vectors(compiled, t)
        if mass.sum() > 1e-9:
            out[t] = chroma
    return out


def stack_quarter_vectors(compiled: dict, exclude_tracks: set[str]) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    """`(bands, onset_strength)` dicts, per non-excluded track, quarter-beat grid -- the
    `fitfeat`-sourced analogue of `stack_vectors`."""
    track_names = {ev["track"] for ev in compiled["events"]} - exclude_tracks
    bands, onsets = {}, {}
    for t in track_names:
        b, o, _count, has_sidecar = _track_quarter_vectors(compiled, t)
        if has_sidecar:
            bands[t] = b
            onsets[t] = o
    return bands, onsets


def onset_density(onset_count: np.ndarray, n_beats: int) -> float:
    """Mean onset count per beat (sum of the 4 quarter-beats' counts), clipped against a busy-part
    ceiling (16/bar => 4/beat is already "busy" per spec section 4's chop example) so it lands in
    a comparable range to `objective.density_penalty`'s expectations."""
    if n_beats <= 0:
        return 0.0
    per_beat = onset_count.reshape(-1, 4).sum(axis=1) if len(onset_count) >= 4 else onset_count
    return float(np.clip(np.mean(per_beat) / 4.0, 0.0, 1.0)) if len(per_beat) else 0.0


def harmony_spans(compiled: dict) -> list[dict]:
    return compiled.get("harmony", [])


def pattern_density(pattern: str) -> float:
    """Fraction of steps that sound (not `.`/`~`), 0..1 -- the Phase 1 stand-in for the spec's
    onset-count density term (no sidecar onsets at L0 this phase)."""
    toks = [t for t in pattern.replace("|", " ").split() if t not in ("|",)]
    if not toks:
        return 0.0
    sounding = sum(1 for t in toks if t not in (".", "~", "_"))
    return sounding / len(toks)


@dataclasses.dataclass
class SurrogateTerms:
    clash: float
    chord: float
    density: float
    taste: float
    contribution: float
    masking: float = 0.0
    rhythm: float = 0.0
    ok: bool = True
    error: str = ""


def compute_terms(*, candidate_chroma: np.ndarray, stack: dict[str, np.ndarray], harmony: list[dict],
                   entry: tuple[int, int], pattern_density_value: float, taste_penalty: float,
                   is_bass: bool, candidate_bands: np.ndarray | None = None, stack_bands: dict | None = None,
                   candidate_onset: np.ndarray | None = None, stack_onset: dict | None = None,
                   onset_density_value: float | None = None) -> SurrogateTerms:
    """The surrogate's term vector, sharing definitions with `objective.py`'s composite. `taste_penalty`
    is 0..1 (0 = loved), already blending star rating and the CLAP genre-fit term (see
    `scripts/optimize.py`'s `--style` prompt). `candidate_bands`/`stack_bands`/`candidate_onset`/
    `stack_onset` are optional: when given, `masking`/`rhythm` are computed from the `fitfeat`
    sidecar with the same formulas `layer.py` uses at render (see `_masking_term`/`_rhythm_term`);
    when omitted (no sidecar for this track), they stay 0.0. `onset_density_value`, when given,
    replaces the step-pattern-occupancy density proxy with the sidecar's real onset count
    (`onset_density`) -- also documented as a fallback, not a silent swap."""
    from .. import check as checker

    n_beats = candidate_chroma.shape[0]
    beat_root: dict[int, int] = {}
    beat_tones: dict[int, list[int]] = {}
    for span in harmony:
        fit = span.get("fit") or {}
        tones = fit.get("chord_tones") or span.get("chord_tones")
        if not tones:
            continue
        a, b = int(span["start_beat"]), int(span["end_beat"])
        for beat in range(max(0, a), min(n_beats, b)):
            beat_root[beat] = tones[0]
            beat_tones[beat] = tones

    clash_terms, on_chord_terms = [], []
    for b in range(n_beats):
        cc = candidate_chroma[b]
        mass = float(cc.sum())
        if mass <= 1e-9:
            continue
        acc = 0.0
        for stack_chroma in stack.values():
            sc = stack_chroma[b] if b < stack_chroma.shape[0] else np.zeros(12)
            pair_mass = mass + float(sc.sum())
            if pair_mass <= 1e-9:
                continue
            acc += checker.pair_clash(cc, sc, bass_pair=is_bass) / (pair_mass ** 2)
        tones = beat_tones.get(b)
        if tones:
            root = beat_root.get(b)
            acc += checker.chord_clash(cc, tones, root, None) * 0.5
            on_chord_terms.append(sum(cc[t] for t in tones) / mass)
        clash_terms.append(acc)

    clash = float(min(1.0, np.mean(clash_terms))) if clash_terms else 0.0
    chord = float(1.0 - np.mean(on_chord_terms)) if on_chord_terms else 0.5

    # contribution channel (b): harmonic addition where the stack's own chord-tone coverage is
    # thin, over the spans the candidate's entry window overlaps.
    coverages = []
    for span in harmony:
        a, b = int(span["start_beat"]), int(span["end_beat"])
        entry_a, entry_b = (entry[0] - 1) * 4, entry[1] * 4  # bars -> beats, 4/4 assumed
        if b <= entry_a or a >= entry_b:
            continue
        cov = (span.get("fit") or {}).get("coverage")
        if cov is not None:
            coverages.append(cov)
    room = float(np.mean([1.0 - c for c in coverages])) if coverages else 0.0
    # the candidate only gets credit for the room if it actually sounds and is roughly on-chord
    contribution = float(np.clip(room * (1.0 - chord) * 2.0, 0.0, 1.0)) if clash_terms else 0.0

    masking = _masking_term(candidate_bands, stack_bands or {}) if candidate_bands is not None else 0.0
    rhythm = _rhythm_term(candidate_onset, stack_onset or {}) if candidate_onset is not None else 0.0
    density = onset_density_value if onset_density_value is not None else pattern_density_value

    return SurrogateTerms(clash=clash, chord=chord, density=density, taste=taste_penalty,
                           contribution=contribution, masking=masking, rhythm=rhythm)
