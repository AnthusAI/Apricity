# Finding and auditioning parts: the search tools

Use these when you're choosing a clip for a role (a main loop, a pad, a bass) or trying layers over a scene
the user already likes. They measure; the user's ear decides. Read "What the numbers can't hear" before
trusting any score.

## 1. Shortlist by sound: CLAP

`scripts/clap-neighbors.py --ref "<sample> <clip>" [--prompt "<style>"] [--top 12] [--out cands.txt]`
ranks the library by how close each clip sounds to a clip already in the scene, optionally blended with a
text prompt for the style ("smooth lounge electronic jazz"). It keeps the best clip per recording.

This is the step that found the best result so far. The user called Ave House's funky guitar loop "too
jarring and rock/metal" next to Ave's lounge melody. Shortlisting by similarity to Ave's own loop, then
swapping, produced the Emerge version (`examples/ave-emerge.apr`): "much better", good enough to send to
their business partner. Emerge is by the same artist as Ave, natively in the song's key and tempo.

## 2. Swap or add, and rank

- **Swap a part** (keep the arrangement, change the clip): `swap-audition.py`, or
  `scripts/explore.py <score> --role <track> --candidates cands.txt [--audition]`. The explorer renders each
  swap in place, hill-climbs small fixes (EQ notches, transposition, high-pass, octave, release), and with
  `--audition` writes a 32-second audition per finalist.
- **Add a part** (layer something new over a scene): `scripts/optimize.py <score> --seed N [--roles
  pad,stab,...] [--style "<prompt>"] --run NAME`. It searches clips, regions, roles, entries, levels and
  filters, judges each on an 8-bar window against the scene alone, and writes a cycle folder of audition
  `.m4a` files (finalists plus the scene). Its `--role <track>` re-cast mode is broken (Kanbus
  apricitus-32f53c): use the explorer for swaps.
- **Hear one layer**: `scripts/audition-form.py CANDIDATE.apr --layer TRACK --window A-B [--check] -o
  out.m4a` builds the standard 16-bar audition (see recipes.md): the scene 4 bars, the part solo 4, both 8.

## 3. Let the user rate

Send the audition `.m4a` files (SendUserFile, one-line caption with timestamps), or publish a blind cycle:
`scripts/cycle.py publish --score S --incumbent-score-id ID --incumbent-audio A --candidate X.apr X.m4a
… --target local` for the local library (`apricity serve`, the `/listen` page), `--target cloud --owner
'<sub>::<username>'` for the deployed app. `scripts/cycle.py pull <cycle id>` logs the verdicts to
`renders/log.jsonl`. Keep working while they listen: their verdict calibrates the next round, it doesn't
gate it.

## Scoring harmony: `apricity check`

`apricity render SCORE --bars A-B -o w.wav --stems DIR` then `apricity check DIR --json` scores a window.
Besides the clash measure (v1), it recognises the chord the parts actually make (root, quality,
inversion, extensions) and adds a chord-quality term: `objective_v2`. On the two logged verdict sets it
picked the user's preferred version both times; the v1 measure did once (`scripts/harmony-backtest.py`
re-runs that comparison as verdicts accumulate). Use `objective_v2` to rank harmony, and keep checking
by ear: two sets is thin evidence, and it still can't hear genre, timbre or groove.

## What the numbers can't hear

- **The v1 harmony checker (`scripts/check-stems.py`, `audition.sh --check`) measures clash, not
  style or quality.** It folds every stem into 12 pitch classes per beat and penalises clashing
  intervals and off-chord notes. It can't hear genre, timbre, groove or whether two parts sound like
  one record, and it never rewards a good chord. It ranked the four lounge swaps within 4 points and
  put Emerge third; the user's ear put Emerge far ahead (objective_v2 puts it first).
- **What set Emerge apart, measurably:** similarity to the scene (CLAP 0.82 vs 0.57-0.73), a real loop
  playing long unbroken phrases (16 events over 32 bars vs 33-38 re-triggered phrase fragments), and no
  stretching (1.00 vs up to 1.34). Prefer loops in the scene's key and tempo, by related artists or
  productions, that need little stretching. These are hypotheses from one pick (Kanbus apricitus-bca35d),
  but a good default.
- **Short-window scores are rough.** The optimizer's 8-bar Δwindow ordered one verdict set C > A > B where
  the user heard A > B > C. Treat pass/fail on auditions as a filter, not a ranking.
- A semitone-low component under the bass (a maj7 below F in the Emerge Fmaj7 bars) was colour to the
  user, not mud.

## Disk

Renders with `--stems` are ~300 MB per full song. The explorer and optimizer delete theirs as they go; your
own `audition.sh --check` runs don't. After each round delete `*.stems`, `.cache` and `*.wav` under
`renders/` and keep `log.jsonl`, the `.apr`, `.m4a` and leaderboards. The machine's disk is tight, and a
full disk breaks every tool at once.
