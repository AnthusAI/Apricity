"""The optimizer's genome (spec section 1): `(source, region, role, ...)` -> one `clip` line plus
one `track` block (Phase 1's `track.add_part` op, `explore/ops.py`), or a rewrite of an existing
role's part when `recast_role` is set (`--role <existing>` in `scripts/optimize.py`).

Deviations from the full spec (documented, not silent): Phase 1 here implements a reduced gene
set that still covers all six roles (loop, bass, pad, stab, chop, riff), but skips: bar-grid
regions (saved clips only), `warp repitch`, `reverse`, EQ notches and
sends as searched genes, and the L1 analytic gain step over continuous genes (volume/hp are
quantized to a small discrete grid and searched at L0 instead, per the spec's own allowance that
"the continuous genes are few... handled by the analytic gain step and a small ES... not by the
surrogate's enumeration" -- the ES step is not implemented this phase; see the optimizer's final
report for what that costs the acceptance numbers).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from typing import Any

import numpy as np

ROLES = ("loop", "bass", "pad", "stab", "chop", "riff")
PITCHED_ROLES = frozenset({"bass", "pad", "stab"})
KIT_ROLES = frozenset({"chop", "riff"})

# Which saved-clip name prefixes are valid source regions for each role (spec section 1's
# "region" gene, restricted to saved clips -- bar-grid regions are Phase 2). "phrase-" is included
# for the loop role because some source families only carry phrase-N clips, no loop-/sec- ones;
# omitting it would silently zero out those families as loop candidates.
REGION_PREFIXES: dict[str, tuple[str, ...]] = {
    "loop": ("loop-", "sec-", "phrase-"),
    "bass": ("hold-",),
    "pad": ("hold-",),
    "stab": ("shot-", "hold-"),
    "chop": ("shot-", "loop-"),
    "riff": ("loop-", "sec-", "shot-", "phrase-"),
}

VOICINGS = ("root", "power", "triad", "seventh")
RATIOS = ("auto", "half", "double")
TRANSPOSES: tuple[Any, ...] = ("auto", "follow", -2, -1, 0, 1, 2)
# Kept narrow (not the spec's full 1-5) and role-specific: a wide/wrong-register octave jump
# routinely trips the compiler's own "N semitones from the clip's own pitch" guard (>24
# semitones -- measured empirically: ~20% of sampled genomes failed this way before narrowing),
# which just wastes L0 budget on genomes that never compile. A bass part's hold is usually
# already low (E1/G1/A1 in this library); a stab wants a higher register.
OCTAVES = (2, 3, 4)
ROLE_OCTAVES: dict[str, tuple[int, ...]] = {"bass": (1, 2), "pad": (2, 3), "stab": (3, 4)}
VOLUMES = (-12.0, -9.0, -6.0, -3.0, 0.0)
HPS: tuple[float | None, ...] = (None, 120.0, 180.0, 300.0)
# The chord-following EQ (spec-harmony-v2.md sec 4.7, Kanbus apricitus-db34ad): `None` most of
# the time (it's an extra effect, not a default), else one of the three presets the user asked
# the optimizer be free to explore -- not only the invisible `cleanup` one.
HARMONICS: tuple[str | None, ...] = (None, None, None, "cleanup", "resonant", "comb")
ATTACKS = (5.0, 10.0, 30.0)
RELEASES = (100.0, 300.0, 800.0)

# A small step-pattern bank, 16 steps (one bar, 16ths); the DSL repeats it to fill the part's bars.
PITCHED_PATTERNS = {
    "whole": "x . . . . . . . . . . . . . . .",
    "onbeats": "x . . . x . . . x . . . x . . .",
    "offbeats": ". . x . . . x . . . x . . . x .",
    "halves": "x . . . . . . . x . . . . . . .",
}
KIT_PATTERNS = ("sparse", "busy")  # sparse: one slice hit/beat, cycling; busy: every 16th

# A safety default for `entry`/mutation-region sampling when a caller doesn't supply its own
# `priors["sections"]` -- generic (one phrase, from bar 1), not derived from any particular score.
# Callers with an actual score should derive real sections from it instead (see
# `scripts/optimize.py`'s `detect_sections`) and pass those in `priors["sections"]`.
SECTION_FALLBACK = [(1, 8)]


def kit_pattern(name: str, n_slices: int = 8) -> str:
    """`sparse`: one slice per beat (4 hits/bar) cycling 1..n; `busy`: every 16th step cycling."""
    steps = ["."] * 16
    idxs = range(0, 16, 4) if name == "sparse" else range(16)
    for k, i in enumerate(idxs):
        steps[i] = str((k % n_slices) + 1)
    return " ".join(steps)


@dataclasses.dataclass(frozen=True)
class Genome:
    role: str
    source: str          # sample rel path, e.g. "ccmixter/CSoul/we-lived....mp3"
    clip: str             # saved region name, e.g. "hold-4"
    entry: tuple[int, int] = (9, 24)
    volume: float = 0.0
    hp: float | None = None
    harmonic: str | None = None  # None, or a key into explore.ops.HARMONIC_PRESETS
    recast_role: str | None = None   # None = add a new part; else re-cast this existing role
    # loop-role genes
    ratio: str = "auto"                        # auto/half/double
    transpose: Any = "auto"                     # auto/follow/int
    # pitched-role genes (bass, pad, stab)
    voicing: str = "triad"
    octave: int = 3
    pattern: str = "onbeats"                    # key into PITCHED_PATTERNS, or "sparse"/"busy" for kit roles
    attack_ms: float = 5.0
    release_ms: float = 100.0

    # --------------------------------------------------------------------- identity / archive

    def key(self) -> str:
        d = dataclasses.asdict(self)
        return hashlib.sha256(json.dumps(d, sort_keys=True, default=str).encode()).hexdigest()[:16]

    def register(self) -> str:
        """Phase 1's register axis (bass/mid/high), a role-based stand-in for the spec's bass-
        share/centroid computation (Phase 2)."""
        if self.role == "bass":
            return "bass"
        if self.role in ("stab", "chop"):
            return "high"
        return "mid"

    def source_family(self) -> str:
        top = self.source.split("/", 1)[0]
        return "kit" if "drumkit" in top else top

    def cell(self) -> tuple[str, str, str]:
        return (self.role, self.register(), self.source_family())

    def track_name(self) -> str:
        return self.recast_role if self.recast_role else f"mx_{self.role}"

    # --------------------------------------------------------------------- sampling

    @classmethod
    def sample(cls, rng: np.random.Generator, priors: dict) -> "Genome | None":
        """`priors`: `{"roles": [...], "candidates_by_role": {role: [Candidate]}, "sections":
        [(a,b),...], "recast_roles": {role: track_name or None}}`. Returns `None` when the chosen
        role has no candidates (caller should retry another draw)."""
        roles = [r for r in priors["roles"] if priors["candidates_by_role"].get(r)]
        if not roles:
            return None
        role = roles[int(rng.integers(len(roles)))]
        cands = priors["candidates_by_role"][role]
        cand = cands[int(rng.integers(len(cands)))]
        sections = priors.get("sections") or SECTION_FALLBACK
        entry = tuple(sections[int(rng.integers(len(sections)))])
        volume = float(VOLUMES[int(rng.integers(len(VOLUMES)))])
        hp = HPS[int(rng.integers(len(HPS)))]
        harmonic = HARMONICS[int(rng.integers(len(HARMONICS)))]
        recast_role = priors.get("recast_roles", {}).get(role)

        if role in PITCHED_ROLES:
            voicing = VOICINGS[int(rng.integers(len(VOICINGS)))]
            role_octaves = ROLE_OCTAVES.get(role, OCTAVES)
            octave = int(role_octaves[int(rng.integers(len(role_octaves)))])
            pattern = list(PITCHED_PATTERNS)[int(rng.integers(len(PITCHED_PATTERNS)))]
            attack = float(ATTACKS[int(rng.integers(len(ATTACKS)))])
            release = float(RELEASES[int(rng.integers(len(RELEASES)))])
            return cls(role=role, source=cand.sample, clip=cand.clip, entry=entry, volume=volume, hp=hp,
                        harmonic=harmonic, recast_role=recast_role, voicing=voicing, octave=octave, pattern=pattern,
                        attack_ms=attack, release_ms=release)
        if role in KIT_ROLES:
            pattern = KIT_PATTERNS[int(rng.integers(len(KIT_PATTERNS)))]
            return cls(role=role, source=cand.sample, clip=cand.clip, entry=entry, volume=volume, hp=hp,
                        harmonic=harmonic, recast_role=recast_role, pattern=pattern)
        # loop
        ratio = RATIOS[int(rng.integers(len(RATIOS)))]
        transpose = TRANSPOSES[int(rng.integers(len(TRANSPOSES)))]
        return cls(role=role, source=cand.sample, clip=cand.clip, entry=entry, volume=volume, hp=hp,
                    harmonic=harmonic, recast_role=recast_role, ratio=ratio, transpose=transpose)

    def mutate(self, rng: np.random.Generator, priors: dict) -> "Genome":
        """Change exactly one gene (spec 3b's mutation operator): a neighbour region (same role,
        different candidate), +-1 volume/hp step, transpose +-1, role hint pattern, entry, or
        (loop role) ratio."""
        d = dataclasses.asdict(self)
        choices = ["entry", "volume", "hp", "harmonic"]
        if self.role in PITCHED_ROLES:
            choices += ["voicing", "octave", "pattern", "attack_ms", "release_ms", "region"]
        elif self.role in KIT_ROLES:
            choices += ["pattern", "region"]
        else:
            choices += ["ratio", "transpose", "region"]
        gene = choices[int(rng.integers(len(choices)))]
        sections = priors.get("sections") or SECTION_FALLBACK
        if gene == "entry":
            d["entry"] = tuple(sections[int(rng.integers(len(sections)))])
        elif gene == "volume":
            d["volume"] = float(VOLUMES[int(rng.integers(len(VOLUMES)))])
        elif gene == "hp":
            d["hp"] = HPS[int(rng.integers(len(HPS)))]
        elif gene == "harmonic":
            d["harmonic"] = HARMONICS[int(rng.integers(len(HARMONICS)))]
        elif gene == "voicing":
            d["voicing"] = VOICINGS[int(rng.integers(len(VOICINGS)))]
        elif gene == "octave":
            role_octaves = ROLE_OCTAVES.get(self.role, OCTAVES)
            d["octave"] = int(role_octaves[int(rng.integers(len(role_octaves)))])
        elif gene == "pattern":
            bank = list(PITCHED_PATTERNS) if self.role in PITCHED_ROLES else list(KIT_PATTERNS)
            d["pattern"] = bank[int(rng.integers(len(bank)))]
        elif gene == "attack_ms":
            d["attack_ms"] = float(ATTACKS[int(rng.integers(len(ATTACKS)))])
        elif gene == "release_ms":
            d["release_ms"] = float(RELEASES[int(rng.integers(len(RELEASES)))])
        elif gene == "ratio":
            d["ratio"] = RATIOS[int(rng.integers(len(RATIOS)))]
        elif gene == "transpose":
            d["transpose"] = TRANSPOSES[int(rng.integers(len(TRANSPOSES)))]
        elif gene == "region":
            cands = priors["candidates_by_role"].get(self.role, [])
            if cands:
                c = cands[int(rng.integers(len(cands)))]
                d["source"], d["clip"] = c.sample, c.clip
        return dataclasses.replace(self, **d)

    def crossover(self, other: "Genome", rng: np.random.Generator) -> "Genome | None":
        """Same-role crossover only (spec 3b): take the source/region from one parent, the rest
        from the other."""
        if self.role != other.role:
            return None
        a, b = (self, other) if rng.random() < 0.5 else (other, self)
        return dataclasses.replace(a, source=b.source, clip=b.clip)

    # --------------------------------------------------------------------- text generation

    def _hp_opt(self) -> str:
        return f"  filter hp {self.hp:g}" if self.hp is not None else ""

    def to_ops(self, *, group: str | None = None) -> list[dict]:
        """`group`: an existing group track's name to route the new part through (e.g. `"music"`),
        when the incumbent score already declares one -- omitted (no `group` clause) otherwise, so
        this doesn't assume every score has a particular group track, or any group track at all."""
        track = self.track_name()
        a, b = self.entry
        recast = self.recast_role is not None
        group_opt = f"  group {group}" if group else ""
        # `track.harmonic` runs after `track.add_part`, which is what actually creates the track
        # block it edits (apply_all applies ops in order); harmless to omit when unset.
        harmonic_ops = [{"op": "track.harmonic", "track": track, "preset": self.harmonic}] if self.harmonic else []
        if self.role in PITCHED_ROLES:
            clip_line = f"clip {track} = {self.source}  {self.clip}"
            pattern = PITCHED_PATTERNS.get(self.pattern, PITCHED_PATTERNS["onbeats"])
            decl = (f'track {track}  voicing {self.voicing}  octave {self.octave}  '
                    f'steps "{pattern}"  attack {self.attack_ms:g}ms  release {self.release_ms:g}ms  '
                    f'bars {a}-{b}  volume {self.volume:g}{self._hp_opt()}{group_opt}')
            return [{"op": "track.add_part", "track": track, "clip_line": clip_line,
                     "track_lines": [decl], "recast": recast}] + harmonic_ops
        if self.role in KIT_ROLES:
            src_clip = f"{track}_src"
            clip_line = f"clip {src_clip} = {self.source}  {self.clip}"
            kit_lines = [f"kit {track} = slice {src_clip} into 8"]
            pattern = kit_pattern(self.pattern)
            decl = f'track {track}  steps "{pattern}"  bars {a}-{b}  volume {self.volume:g}{self._hp_opt()}{group_opt}'
            return [{"op": "track.add_part", "track": track, "clip_line": clip_line,
                     "kit_lines": kit_lines, "track_lines": [decl], "recast": recast}] + harmonic_ops
        # loop
        clip_line = f"clip {track} = {self.source}  {self.clip}"
        ratio_opt = "" if self.ratio == "auto" else f"  {self.ratio}"
        decl = (f"track {track}  bars {a}-{b}  transpose {self.transpose}{ratio_opt}  "
                f"volume {self.volume:g}{self._hp_opt()}{group_opt}")
        return [{"op": "track.add_part", "track": track, "clip_line": clip_line,
                 "track_lines": [decl], "recast": recast}] + harmonic_ops

    def text(self, base_text: str) -> str:
        from ..explore import ops as ops_mod
        # Route the new part through the incumbent's own group track when it has one (the first
        # `group <name>` block the score declares) -- there's no fixed group name to assume, and
        # a score with no group track at all just gets a plain, ungrouped part.
        m = re.search(r"^group\s+(\S+)", base_text, re.M)
        group = m.group(1) if m else None
        return ops_mod.apply_all(base_text, self.to_ops(group=group))

    def prose(self) -> str:
        verb = f"recast {self.recast_role}" if self.recast_role else "add a new part"
        bits = [f"{verb} ({self.role}) from {self.source}#{self.clip}, bars {self.entry[0]}-{self.entry[1]}, "
                f"volume {self.volume:+.0f}dB" + (f", hp {self.hp:g}Hz" if self.hp else "") +
                (f", harmonic {self.harmonic}" if self.harmonic else "")]
        if self.role in PITCHED_ROLES:
            bits.append(f"voicing {self.voicing} octave {self.octave}, pattern {self.pattern}, "
                        f"attack {self.attack_ms:g}ms release {self.release_ms:g}ms")
        elif self.role in KIT_ROLES:
            bits.append(f"sliced 8-way, pattern {self.pattern}")
        else:
            bits.append(f"ratio {self.ratio}, transpose {self.transpose}")
        return "; ".join(bits)
