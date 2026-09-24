# The curation feed (built 2026-09-24)

Machines listen and propose; people judge. This implements the curation loop in
`design/framework.md`: **candidates** (proposed slices, with evidence and proposer) → the
**feed** (best first, learning from you) → a **verdict** (keep / skip / later) with optional
**stars**, **tags**, a **name** and **crates** → kept material becomes a named slice any score can use.

Code: `analysis/apricity_analyze/curation.py`. Tests: `analysis/tests/test_curation.py`.

## Using it

```
# propose candidates from everything analyzed (re-running only adds or updates)
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.curation propose samples

# audition and judge in the terminal (plays each candidate; loops and breaks play twice)
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.curation feed [--kind break]
#   k keep · 1–5 keep with stars · s skip · l later · t tags · n name · c crate · r replay · q quit

… curation list [--kind loop] [--limit 20]       # the ranked feed, with reasons
… curation judge <id> keep --stars 4 --name horn-stab --tags brass --crate digs
… curation crates                                 # list crates
… curation crates digs                            # a crate as .apr: clip lines + a kit of pads
… curation add <clip> <start> <end> --kind loop --by agent:<name> --why "…" [--score 0.8] [--evidence k=v …]
```

A kept candidate is written into its clip's manifest as a slice (`"source": "curated"`, with
`stars`, `tags`, `evidence` and the `candidate` id), so a score can use it right away:
`clip brk = marine-band/Thunderer.mp3  slice break-1a2b`. Skipping it later removes that slice.
A person's own slices are never touched; a name clash gets a suffix (`mine-2`).

## Proposers

| Proposer | Kind | Evidence |
|---|---|---|
| `analyzer:markup/loops` | loop | `repeat` (next window's similarity), `steady` (beat regularity), `static` (harmony holds), `level_db` (vs playing level) |
| `analyzer:markup/hits` | hit | `standout` (× over the surroundings; must also be within 20 dB of the playing level) |
| `analyzer:markup/phrases` | phrase | `seconds`; scored high on beatless clips (speech), low on music (rests between lines) |
| `analyzer:markup/sections` | section | the section's tags (letter, repeat, trio, intro) |
| `analyzer:breaks` | break | `drum_lift_db` (drums over the loudest other stem), `drum_level_db` — needs the recording's stems, proposed on the full recording |
| `agent:<name>` | any | whatever the agent measured; `why` is required |

Every proposal is validated (the clip is analyzed, the span is inside it, kind and proposer are
well-formed, there's a reason). The same span of the same clip is one candidate: a second proposer
is added to it, so agreement between proposers is visible.

## Taste

Rank = the best proposer score × a lift per trait (kind, proposer, recording, stem): that trait's
keep rate (Beta(1,1)-smoothed; 1–2-star keeps count 0.4 / 0.7, skips 0, "later" nothing) over the
overall keep rate. The feed says why when a trait moved a candidate ("you kept 7 of 9 breaks",
"you skipped 5 of 6 from SemperFidelis"), and the terminal feed re-ranks after every verdict.
Unjudged candidates come first; ones put off for later come back after them.

Deliberately simple and explainable. Next steps when there are enough verdicts: logistic regression
on the evidence numbers (so "repeat ≥ 0.9" can be learned, not just "loops"), and per-person taste.

## The contract for a backend (not built: the user is designing one, 2026-09-24)

Storage is local JSON in `library/`, behind one small class (`Store`). A backend replaces the
`Store` and keeps these operations and rules; the analyzers, taste model, terminal feed and export
don't change.

**Data.**
- `Candidate {id, clip, start, end, kind, name, recording, context{seconds, bpm, beats, key, stem}, proposers[{by, score, why, evidence{name: number}, at}]}`
  — `id` is stable: `c-` + sha1(clip | start | end (10 ms) | kind)[:10].
- `Verdict {verdict: keep|skip|later, stars?: 1–5 (keep only), tags?: [str], name?: str, at, by}` — one per candidate, the latest wins.
- `Crate {name, items: [candidate id], note}` — ordered; skipping an item removes it from its crates.

**Operations.** `prepare`+`add` (validated proposals, merged by id, many in one write) ·
`propose` (one, for agents) · `judge` (verdict + crates; mirrors keep/skip into the clip's
manifest) · `feed(kind, recording, include_later, limit)` (ranked, with `rank`, `why_ranked`,
`later`) · `crate_items`, `export_apr` · `audition` (the span's audio; loops/breaks twice).

**Rules a backend must keep.** Writes are atomic and serialized (now: a lock file). Proposals are
validated before storing. Candidate ids are content-derived, so the same span proposed by anyone
merges. A keep writes exactly one curated slice per candidate into the clip's manifest (the score
compiler reads manifests, not the store), and skip/later removes it.

Not built yet, waiting on the backend: an HTTP API for the feed and the web feed view (the web
session's), several people's verdicts, and agents proposing over the network (today: the CLI).
