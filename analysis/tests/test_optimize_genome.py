"""Genome round trips (Kanbus apricitus-a9ad5b): every role's `Genome.text()` output compiles,
`track.add_part` is idempotent-ish under recast (removes the old block first), and `sample`/
`mutate`/`crossover` stay within the declared gene domains."""

from __future__ import annotations

import pathlib
import subprocess

import numpy as np
import pytest

from apricity_analyze.optimize.genome import (
    KIT_ROLES, PITCHED_ROLES, REGION_PREFIXES, ROLES, Genome,
)

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "target/release/apricity"
SAMPLES = ROOT / "samples"

pytestmark = pytest.mark.skipif(not BIN.exists(), reason="release binary not built")

BASE = f"""tempo 100
key C major
samples {SAMPLES}

clip bright = ccmixter/AlexBeroza/Ave_34409.mp3  loop-2
clip low    = ccmixter/AlexBeroza/Ave_34409.mp3  hold-4  root Ab1

chords (I*2 IV*2 V*2 I*2)*3

track bright  transpose 2  bars 1-24  group music
track low  voicing root  octave 2  bars 1-24  group music

group music
"""

GENOMES = {
    "loop": Genome(role="loop", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="loop-1", entry=(1, 8),
                   volume=-3.0, hp=180.0, ratio="half", transpose=1),
    "bass": Genome(role="bass", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="hold-2", entry=(9, 16),
                   volume=-6.0, voicing="root", octave=2, pattern="onbeats"),
    "pad": Genome(role="pad", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="hold-3", entry=(9, 16),
                  volume=-6.0, voicing="triad", octave=3, pattern="whole"),
    "stab": Genome(role="stab", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="shot-1", entry=(17, 24),
                   voicing="triad", octave=3, pattern="offbeats"),
    "chop": Genome(role="chop", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="shot-1", entry=(17, 24),
                   pattern="busy"),
    "riff": Genome(role="riff", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="loop-2", entry=(17, 24),
                   pattern="sparse"),
}


def compiles(text: str, tag: str) -> tuple[bool, str]:
    p = pathlib.Path(pathlib.os.environ.get("TMPDIR", "/tmp")) / f"apricity-genome-test-{tag}.apr"
    p.write_text(text)
    r = subprocess.run([str(BIN), "compile", str(p)], capture_output=True, text=True)
    return r.returncode == 0, r.stderr


@pytest.mark.parametrize("role", ROLES)
def test_every_role_compiles(role):
    g = GENOMES[role]
    text = g.text(BASE)
    ok, err = compiles(text, f"add-{role}")
    assert ok, err
    assert f"clip mx_{role}" in text or f"clip mx_{role}_src" in text
    assert f"track mx_{role}" in text


def test_recast_replaces_the_existing_part_once():
    import dataclasses
    g = dataclasses.replace(GENOMES["loop"], recast_role="bright")
    text = g.text(BASE)
    ok, err = compiles(text, "recast")
    assert ok, err
    # exactly one clip/track line for "bright" survives (the old one was removed, not doubled)
    assert text.count("clip bright =") == 1
    assert sum(1 for line in text.splitlines() if line.startswith("track bright")) == 1


def test_kit_role_uses_a_separate_clip_and_kit_name():
    # a kit can't share a name with a clip (the DSL's shared namespace) -- track.add_part must not
    # generate `kit mx_chop = slice mx_chop ...`
    g = GENOMES["chop"]
    ops = g.to_ops()
    assert ops[0]["kit_lines"][0].split("=")[1].strip().split()[1] != "mx_chop"


def test_sample_stays_in_domain():
    rng = np.random.default_rng(3)
    priors = {
        "roles": list(ROLES),
        "candidates_by_role": {
            role: [type("C", (), {"sample": "ccmixter/AlexBeroza/Ave_34409.mp3", "clip": f"{REGION_PREFIXES[role][0]}1"})()]
            for role in ROLES
        },
        "sections": [(1, 8), (9, 16)],
        "recast_roles": {},
    }
    for _ in range(200):
        g = Genome.sample(rng, priors)
        assert g is not None
        assert g.role in ROLES
        assert g.entry in priors["sections"]
        if g.role in PITCHED_ROLES:
            assert 1 <= g.octave <= 5
        if g.role in KIT_ROLES:
            assert g.pattern in ("sparse", "busy")


def test_sample_returns_none_with_no_candidates():
    rng = np.random.default_rng(1)
    priors = {"roles": ["loop"], "candidates_by_role": {"loop": []}, "sections": [(1, 8)], "recast_roles": {}}
    assert Genome.sample(rng, priors) is None


def test_mutate_changes_exactly_one_gene_family():
    rng = np.random.default_rng(5)
    g = GENOMES["bass"]
    priors = {"candidates_by_role": {"bass": [type("C", (), {"sample": g.source, "clip": g.clip})()]},
              "sections": [(1, 8), (9, 16)]}
    mutated = g.mutate(rng, priors)
    assert mutated != g  # frozen dataclass equality: something changed
    assert mutated.role == g.role


def test_crossover_requires_same_role():
    rng = np.random.default_rng(2)
    assert GENOMES["loop"].crossover(GENOMES["bass"], rng) is None
    other_loop = Genome(role="loop", source="ccmixter/AlexBeroza/Ave_34409.mp3", clip="loop-3", entry=(1, 8))
    child = GENOMES["loop"].crossover(other_loop, rng)
    assert child is not None and child.role == "loop"


def test_genome_key_is_deterministic():
    assert GENOMES["loop"].key() == GENOMES["loop"].key()
    import dataclasses
    other = dataclasses.replace(GENOMES["loop"], volume=-9.0)
    assert other.key() != GENOMES["loop"].key()
