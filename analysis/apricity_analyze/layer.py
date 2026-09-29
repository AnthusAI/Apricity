"""Layer-by-layer optimizer: score one candidate stem against a fixed "stack" (the layers the
user has already approved), so the explorer's primary move becomes "fix the stack, find the best
next layer" rather than re-casting one role in isolation.

This module implements **tonight's slice** of the full design (see the Fable design report,
`spec-layer.md`): the composite is `clash*0.6 + masking*0.2 + onset*0.2` and the only hard gates
are "not silent" and "not a double" of something already in the stack. The full design's other
soft terms (rhythm-fill, density/energy, artefacts, beat alignment, taste) and gates (role,
tuning, stretch) are stubbed here -- present in the `Terms`/`Gates` shape so the composite can
grow into them, but not computed or weighted tonight. Every stub says so in its own docstring.

Reuses `apricity_analyze.check`'s kernel (`pair_clash`, `chord_clash`, the interval weights) and
its `Stem`/`load_stems` machinery -- a "stack" or "candidate" stems directory is exactly a
`--stems` render, the same shape `check.py` already reads.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import pathlib

import numpy as np

from . import check

# --------------------------------------------------------------------------- weights (tonight)

# Tonight's slice: only these three terms are weighted; the rest of `Terms` are computed as 0.0
# (or left as documented stubs) and carry no weight until the fuller design lands.
WEIGHTS_TONIGHT = {"clash": 0.6, "masking": 0.2, "rhythm": 0.2, "density": 0.0, "artefacts": 0.0, "alignment": 0.0, "taste": 0.0}

SILENT_DB_BELOW_LOUDEST = 18.0
SILENT_LUFS_FLOOR = -40.0
SILENT_MIN_BEAT_SHARE = 0.4
DOUBLE_ONSET_R = 0.9
DOUBLE_CHROMA_COSINE = 0.97

# The Bark-ish filterbank used for the masking term: log-spaced band edges, 20 Hz-16 kHz.
MASKING_N_BANDS = 24
MASKING_LO_HZ, MASKING_HI_HZ = 20.0, 16000.0


# --------------------------------------------------------------------------- gates / terms shape

@dataclasses.dataclass
class Gates:
    not_silent: bool
    not_double: bool
    # Stubs: not evaluated tonight (see module docstring). `None` means "not checked".
    role: bool | None = None
    tuning: bool | None = None
    stretch: bool | None = None

    @property
    def passed(self) -> bool:
        checked = [v for v in (self.not_silent, self.not_double, self.role, self.tuning, self.stretch) if v is not None]
        return all(checked)


@dataclasses.dataclass
class Terms:
    clash: float
    masking: float
    rhythm: float
    density: float = 0.0     # stub tonight
    artefacts: float = 0.0   # stub tonight
    alignment: float = 0.0   # stub tonight
    taste: float = 0.5       # stub tonight: "0.5 when unrated", per spec -- never rated tonight


@dataclasses.dataclass
class LayerReport:
    score: float
    gates: Gates
    terms: Terms
    weights: dict
    findings: list
    pairs: list        # one entry per stack stem: {"stem", "onset_r", "chroma_cosine", "masking"}
    candidate_features: dict

    def to_json(self) -> dict:
        d = dataclasses.asdict(self)
        return d


# --------------------------------------------------------------------------- features

@dataclasses.dataclass
class StemFeatures:
    name: str
    pitched: bool
    bass: bool
    chroma: np.ndarray      # (n_beats, 12), loudness*tonalness-weighted (as check.Stem)
    energy_db: np.ndarray   # (n_beats,)
    onset_env: np.ndarray   # onset strength envelope, one value per hop frame
    bands: np.ndarray       # (n_frames, MASKING_N_BANDS) energy, one row per hop frame
    tonalness: np.ndarray   # (n_frames,) -- same frame grid as `bands`
    mono: np.ndarray
    sr: int


def _band_edges() -> np.ndarray:
    return np.geomspace(MASKING_LO_HZ, MASKING_HI_HZ, MASKING_N_BANDS + 1)


def band_energy(mono: np.ndarray, sr: int) -> np.ndarray:
    """`(n_frames, MASKING_N_BANDS)`: energy in each log-spaced band, one column per band, using
    the same frame/hop as `check.py`'s chroma (so the masking term aligns beat-for-beat with it)."""
    import librosa

    S = np.abs(librosa.stft(np.ascontiguousarray(mono, dtype=np.float32), n_fft=check.FRAME, hop_length=check.HOP, center=True)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=check.FRAME)
    edges = _band_edges()
    out = np.zeros((S.shape[1], MASKING_N_BANDS))
    for i in range(MASKING_N_BANDS):
        sel = (freqs >= edges[i]) & (freqs < edges[i + 1])
        if sel.any():
            out[:, i] = S[sel, :].sum(axis=0)
    return out


def onset_envelope(mono: np.ndarray, sr: int) -> np.ndarray:
    import librosa

    return librosa.onset.onset_strength(y=np.ascontiguousarray(mono, dtype=np.float32), sr=sr, hop_length=check.HOP)


def extract_features(name: str, mono: np.ndarray, sr: int, tempo: float, n_beats: int, *, pitched: bool) -> StemFeatures:
    chroma = check.chroma_frames(mono)
    times = check.frame_times(len(chroma))
    rms = check.frame_rms(mono)[: len(chroma)]
    tonalness = check.frame_tonalness(mono)[: len(chroma)]
    weight = rms * tonalness
    spb = 60.0 / tempo
    beat_chroma = np.zeros((n_beats, 12))
    beat_energy = np.full(n_beats, -120.0)
    for b in range(n_beats):
        sel = (times >= b * spb) & (times < (b + 1) * spb)
        if sel.any():
            beat_chroma[b] = (chroma[sel] * weight[sel, None]).sum(axis=0)
            e = float(np.sqrt(np.mean(rms[sel] ** 2)))
            beat_energy[b] = 20 * np.log10(e + 1e-9)
    return StemFeatures(name=name, pitched=pitched, bass=check.is_bass(mono), chroma=beat_chroma, energy_db=beat_energy,
                         onset_env=onset_envelope(mono, sr), bands=band_energy(mono, sr), tonalness=tonalness, mono=mono, sr=sr)


def load_stack(stems_dir: pathlib.Path, cache_path: pathlib.Path | None = None) -> tuple[dict, list[StemFeatures]]:
    """Load a stack's `--stems` render and compute every stem's `StemFeatures`, optionally cached
    to `cache_path` (an `.npz`, keyed by nothing more than "does this file exist" -- the caller
    decides when the stack has changed enough to recompute, per the spec: "computed once per
    run")."""
    import soundfile as sf

    manifest = json.loads((stems_dir / "stems.json").read_text())
    if cache_path is not None and cache_path.exists():
        return manifest, _load_cached_stack(cache_path)

    tempo = manifest["tempo"]
    length = manifest["length"]
    n_beats = max(1, int(np.ceil(length / (manifest["sample_rate"] * 60.0 / tempo))))
    feats = []
    for t in manifest["tracks"]:
        data, sr = sf.read(str(stems_dir / f"{t['name']}.wav"), dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        feats.append(extract_features(t["name"], mono, sr, tempo, n_beats, pitched=t.get("pitched", True)))
    if cache_path is not None:
        _save_cached_stack(cache_path, feats)
    return manifest, feats


def window_features(feat: StemFeatures, tempo: float, start_beat: int, end_beat: int) -> StemFeatures:
    """`feat` cut to beats `[start_beat, end_beat)` of its render: per-beat arrays by beat, frame
    arrays by the same hop grid `band_energy` uses, `mono` by sample (a cached stack's placeholder
    `mono` is left as is). Judging a part that plays in only some bars over the whole song makes
    every gate and term see mostly silence, so callers cut the candidate and the stack to the bars
    the part actually plays in."""
    start_beat = max(0, int(start_beat))
    end_beat = max(start_beat + 1, min(int(end_beat), len(feat.energy_db)))
    frames_per_beat = feat.sr * 60.0 / tempo / check.HOP
    f0, f1 = int(round(start_beat * frames_per_beat)), int(round(end_beat * frames_per_beat))
    samples_per_beat = feat.sr * 60.0 / tempo
    s0, s1 = int(round(start_beat * samples_per_beat)), int(round(end_beat * samples_per_beat))
    mono = feat.mono[s0:s1] if len(feat.mono) > 1 else feat.mono
    return dataclasses.replace(
        feat, chroma=feat.chroma[start_beat:end_beat], energy_db=feat.energy_db[start_beat:end_beat],
        onset_env=feat.onset_env[f0:f1], bands=feat.bands[f0:f1], tonalness=feat.tonalness[f0:f1], mono=mono,
    )


def _save_cached_stack(path: pathlib.Path, feats: list[StemFeatures]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = {}
    for f in feats:
        blob[f"{f.name}__chroma"] = f.chroma
        blob[f"{f.name}__energy_db"] = f.energy_db
        blob[f"{f.name}__onset_env"] = f.onset_env
        blob[f"{f.name}__bands"] = f.bands
        blob[f"{f.name}__tonalness"] = f.tonalness
        blob[f"{f.name}__pitched"] = np.array([f.pitched])
        blob[f"{f.name}__bass"] = np.array([f.bass])
        blob[f"{f.name}__sr"] = np.array([f.sr])
    blob["__names"] = np.array([f.name for f in feats])
    np.savez_compressed(path, **blob)


def _load_cached_stack(path: pathlib.Path) -> list[StemFeatures]:
    z = np.load(path, allow_pickle=False)
    names = [str(n) for n in z["__names"]]
    out = []
    for name in names:
        out.append(StemFeatures(
            name=name, pitched=bool(z[f"{name}__pitched"][0]), bass=bool(z[f"{name}__bass"][0]),
            chroma=z[f"{name}__chroma"], energy_db=z[f"{name}__energy_db"], onset_env=z[f"{name}__onset_env"],
            bands=z[f"{name}__bands"], tonalness=z[f"{name}__tonalness"], mono=np.zeros(1), sr=int(z[f"{name}__sr"][0]),
        ))
    return out


def sidecar_cache_path(manifest_sha: str, cache_dir: pathlib.Path) -> pathlib.Path:
    """Per-clip sidecar feature cache, keyed by the clip manifest's own sha256 (so re-screening
    the same clip, unchanged, never recomputes its features)."""
    return cache_dir / f"{manifest_sha}.npz"


# --------------------------------------------------------------------------- gates

def gate_not_silent(candidate: StemFeatures, stack: list[StemFeatures]) -> bool:
    """Pass (not silent) when: within `SILENT_DB_BELOW_LOUDEST` dB of the loudest stack stem,
    above `SILENT_LUFS_FLOOR`, and sounding (finite energy) on at least `SILENT_MIN_BEAT_SHARE` of
    its beats."""
    finite = candidate.energy_db[np.isfinite(candidate.energy_db)]
    if len(finite) == 0:
        return False
    peak = float(np.max(finite))
    if peak < SILENT_LUFS_FLOOR:
        return False
    loudest_stack = max((float(np.max(s.energy_db[np.isfinite(s.energy_db)])) for s in stack if np.any(np.isfinite(s.energy_db))), default=peak)
    if peak < loudest_stack - SILENT_DB_BELOW_LOUDEST:
        return False
    sounding = np.isfinite(candidate.energy_db) & (candidate.energy_db > SILENT_LUFS_FLOOR)
    share = float(np.mean(sounding)) if len(candidate.energy_db) else 0.0
    return share >= SILENT_MIN_BEAT_SHARE


def _correlate(a: np.ndarray, b: np.ndarray) -> float:
    n = min(len(a), len(b))
    if n < 2:
        return 0.0
    a, b = a[:n], b[:n]
    if np.std(a) < 1e-9 or np.std(b) < 1e-9:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def _chroma_cosine(a: np.ndarray, b: np.ndarray) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    a, b = a[:n].sum(axis=0), b[:n].sum(axis=0)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def gate_not_double(candidate: StemFeatures, stack: list[StemFeatures]) -> tuple[bool, list[dict]]:
    """Pass (not a double) only when, against *every* stack stem, the onset-envelope correlation
    is below `DOUBLE_ONSET_R` OR the chroma cosine is below `DOUBLE_CHROMA_COSINE` (a double must
    fail *both* thresholds -- move the same way rhythmically *and* sit on the same pitch content).
    Returns `(passed, pairs)`, `pairs` carrying each stack stem's onset r and chroma cosine for
    the report."""
    pairs = []
    passed = True
    for s in stack:
        r = _correlate(candidate.onset_env, s.onset_env)
        cos = _chroma_cosine(candidate.chroma, s.chroma)
        pairs.append({"stem": s.name, "onset_r": round(r, 4), "chroma_cosine": round(cos, 4)})
        if r >= DOUBLE_ONSET_R and cos >= DOUBLE_CHROMA_COSINE:
            passed = False
    return passed, pairs


# --------------------------------------------------------------------------- terms

def term_clash(candidate: StemFeatures, stack: list[StemFeatures], manifest: dict) -> float:
    """The check.py kernel's pairwise clash between the candidate and each stack stem, plus the
    candidate's own chord clash against the score's harmony, averaged over beats and clipped to
    [0, 1] (a penalty, not the 0-100 objective)."""
    scale = check.key_scale(manifest.get("key", ""))
    n_beats = candidate.chroma.shape[0]
    beat_root: dict[int, int] = {}
    for span in manifest.get("harmony", []):
        chord_tones = [check.PITCH_NAMES.index(t) for t in span.get("chord_tones", []) if t in check.PITCH_NAMES]
        if not chord_tones:
            continue
        for b in check.span_beats(manifest, span, n_beats):
            beat_root[b] = chord_tones[0]

    totals = []
    for b in range(n_beats):
        cc = candidate.chroma[b]
        mass = cc.sum()
        acc = 0.0
        for s in stack:
            if b >= s.chroma.shape[0]:
                continue
            sc = s.chroma[b]
            mass_pair = mass + sc.sum()
            if mass_pair <= 1e-9:
                continue
            acc += check.pair_clash(cc, sc, bass_pair=(candidate.bass or s.bass)) / (mass_pair ** 2)
        root = beat_root.get(b)
        if root is not None and mass > 0:
            chord_tones = [check.PITCH_NAMES.index(t) for t in next((sp["chord_tones"] for sp in manifest.get("harmony", [])
                                                                       if b in check.span_beats(manifest, sp, n_beats)), []) if t in check.PITCH_NAMES]
            if chord_tones:
                acc += check.chord_clash(cc, chord_tones, root, scale) * 0.5
        totals.append(acc)
    if not totals:
        return 0.0
    return float(min(1.0, np.mean(totals)))


def term_masking(candidate: StemFeatures, stack: list[StemFeatures]) -> float:
    """Cosine similarity of band energy (a Bark/ERB-like filterbank) between the candidate and
    each stack stem, per frame, weighted by tonalness, averaged -- higher similarity means more
    masking (this is a penalty, so higher is worse)."""
    if not stack:
        return 0.0
    sims = []
    for s in stack:
        # `bands` and `tonalness` come from separate STFT calls (`band_energy`,
        # `check.frame_tonalness`) that can differ by a frame at the very edge of an odd-length
        # clip, so clamp `n` to the shortest of all four arrays actually being indexed.
        n = min(candidate.bands.shape[0], s.bands.shape[0], len(candidate.tonalness), len(s.tonalness))
        if n == 0:
            continue
        w = (candidate.tonalness[:n] + s.tonalness[:n]) / 2.0
        for i in range(n):
            ca, sa = candidate.bands[i], s.bands[i]
            na, nb = np.linalg.norm(ca), np.linalg.norm(sa)
            if na < 1e-12 or nb < 1e-12:
                continue
            cos = float(np.dot(ca, sa) / (na * nb))
            sims.append(cos * w[i])
    if not sims:
        return 0.0
    return float(np.clip(np.mean(sims), 0.0, 1.0))


def term_rhythm_onset(candidate: StemFeatures, stack: list[StemFeatures]) -> float:
    """Tonight's simplified rhythm term: the mean onset-envelope correlation between the
    candidate and the stack (the full design's reward for filling quiet slots is a stub -- see
    the module docstring)."""
    if not stack:
        return 0.0
    rs = [max(0.0, _correlate(candidate.onset_env, s.onset_env)) for s in stack]
    return float(np.clip(np.mean(rs), 0.0, 1.0))


# --------------------------------------------------------------------------- top-level

def check_layer(manifest: dict, candidate: StemFeatures, stack: list[StemFeatures], *, weights: dict | None = None,
                taste: float | None = None) -> LayerReport:
    """`taste`: the listener's verdicts on this candidate's clip, as the taste penalty (0 loved, 1 disliked;
    `explore.verdicts.taste`); unrated (0.5) when not given. It counts only as far as `weights["taste"]` says."""
    weights = weights or WEIGHTS_TONIGHT
    not_silent = gate_not_silent(candidate, stack)
    not_double, pairs = gate_not_double(candidate, stack)
    gates = Gates(not_silent=not_silent, not_double=not_double)

    clash = term_clash(candidate, stack, manifest)
    masking = term_masking(candidate, stack)
    rhythm = term_rhythm_onset(candidate, stack)
    terms = Terms(clash=clash, masking=masking, rhythm=rhythm, **({"taste": taste} if taste is not None else {}))

    findings = []
    if not not_silent:
        findings.append(f"{candidate.name}: too quiet against the stack (gate)")
    if not not_double:
        doubled_with = [p["stem"] for p in pairs if p["onset_r"] >= DOUBLE_ONSET_R and p["chroma_cosine"] >= DOUBLE_CHROMA_COSINE]
        findings.append(f"{candidate.name}: doubles {', '.join(doubled_with)} (gate)")

    if gates.passed:
        w_sum = sum(weights.get(k, 0.0) for k in ("clash", "masking", "rhythm", "density", "artefacts", "alignment", "taste"))
        p_sum = (weights.get("clash", 0.0) * terms.clash + weights.get("masking", 0.0) * terms.masking
                 + weights.get("rhythm", 0.0) * terms.rhythm + weights.get("density", 0.0) * terms.density
                 + weights.get("artefacts", 0.0) * terms.artefacts + weights.get("alignment", 0.0) * terms.alignment
                 + weights.get("taste", 0.0) * terms.taste)
        score = 100.0 * (1.0 - (p_sum / w_sum if w_sum > 0 else 0.0))
    else:
        score = 0.0

    return LayerReport(score=round(score, 2), gates=gates, terms=terms, weights=dict(weights), findings=findings,
                        pairs=pairs, candidate_features={"name": candidate.name, "bass": candidate.bass, "pitched": candidate.pitched})
