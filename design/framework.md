# Apricity: the working model

Apricity is a sampling instrument for people and AI agents working together. Machines listen,
dig, and propose; people judge, curate, and decide; both write music in one declarative language.
This file is the shared mental model, written down so we can argue about it. Terms here are the ones
the code, the language, and the docs should use.

## Vocabulary

Words come from sampling culture (hip-hop producers, turntablists, crate diggers) where one exists.

### Material
- **Source** — a recording as it arrived, with provenance and rights (e.g. a Marine Band MP3).
- **Stem** — one part separated out of a source (drums, bass, other).
- **Clip** — anything playable with analysis: a source or a stem, with its beat grid, key, tuning,
  notes and annotations. Everything below is a region of a clip.

### Regions (all are *slices*: a named span of a clip)
- **Section** — a structural part (strain, trio, breakstrain).
- **Phrase** — a musical sentence, usually 4 or 8 bars.
- **Loop** — a span that repeats cleanly end to start.
- **Break** — a drums-forward span, the classic material of hip-hop.
- **Chop** — a piece cut from a slice to be re-sequenced; chops come in *kits*.
- **Hit / one-shot / stab** — a single accent meant to be triggered.

### Collections
- **Crate** — a curated collection of slices and clips ("digging in the crates"); can be a saved query.
- **Kit** — an ordered set of chops addressed by number, like a sampler's pads (`k.1 … k.16`).

### Curation
- **Candidate** — a slice proposed by an analyzer or an agent, with **evidence**: why it might be
  good ("clean 2-bar break, steady 97 BPM, loops with 0.93 similarity") and who proposed it.
- **Feed** — candidates awaiting a human.
- **Verdict** — keep / skip / later. Always given; cheap and fast.
- **Rating** — optional 1–5 stars on kept material, plus **tags** and a name.

### Making
- **Score** — a piece, written in the Apricity language (`.apr`) or YAML.
- **Track** — one line of a score: a clip, a chop, or a kit, with how it's placed and transformed.
- **Pattern** — when a track sounds: `loop`, `every`, `at`, or `steps` (a step sequence over a kit).
- **Flip** — any transformation of a sample into something new: re-pitched, re-sequenced, chopped,
  reversed, filtered, half-timed. The art of sampling is in the flip.

## The curation loop

```
analyzers & agents ──propose──▶ Candidates (with evidence and proposer)
                                   │
                                 Feed ──▶ person: audition, verdict, optional stars, tags, crate
                                   │
            verdicts & ratings ──▶ learned taste ──▶ ranking of the next candidates
                                   │
                         Crates & Kits ──▶ scores, written by people, agents, or both
```

Decisions so far (2026-09-23):
- Verdict (keep / skip / later) on everything, optional stars and tags on what's kept.
- Both deterministic analyzers and AI agents may propose; every candidate records who and why.
- Build order: chopping/looping language primitives first, then the candidate store and feed.
- The feed is built (2026-09-24): see `design/curation.md`. Kept candidates become curated slices in
  the clip's manifest, so scores use them with `slice NAME`; crates export as `.apr` kits. Storage
  is local JSON behind one class until the backend (being designed) replaces it.

## Language primitives for chopping and looping

```
kit   k      = chop br by beats 1        # also: by bars 2 · into 8 · by hits
track k      steps "1 . 3 . [5 5] . 7 ." swing 56 # sampler-style step sequence over the kit
track k.3    every 1bar  reverse  filter lp 800    # a single chop, used like any clip
track br     half                                  # half-time (double for double-time)
```

- `steps`: one symbol per step (16th notes by default; `grid 8` for eighths, `grid 4` for beats).
  A number triggers that chop; `.` is silence; `_` holds the previous chop; `[a b]` splits a step.
- `swing 50` is straight; 56–62 is the classic sampler range.
- Transforms: `reverse`, `filter lp|hp <Hz>`, `gate <percent>`, `stutter <n>`, `half`, `double`.
- Chops are ordinary slices, so `follow`, `role`, `at`, `every` all apply to them.

## Principles
- Declarative and validated: every mistake is reported with its location; nothing silently ignored.
- Explainable: `explain` shows every decision, so a person can check an agent's work.
- Human taste is the authority: machines rank and propose; people decide.
- Provenance travels with every flip: which source, which region, which rights.
