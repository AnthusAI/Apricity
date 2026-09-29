# Working in a lab

A **lab** is a sit-down with one scene. The user and you pick a score to work on and say what you're after
("find a lead for the drop"). Then you try things, publish blind listening cycles into the lab, and the user
rates them in the web app while you keep working. The lab groups those cycles, so the user sees one place
with everything waiting for them and the history of what they picked, and you can read the verdicts back.

Use a lab whenever a session means more than one round of listening. For a single quick "how does this
sound?", sending an `.m4a` with SendUserFile is still fine.

## The pieces

- **Lab**: title, brief, the scene (a Score id), open or closed, and its owner (the user).
- **Listening cycle**: one blind comparison, meaning the incumbent plus 1–4 candidates, shuffled under letters
  A, B, C…, each with its 16-bar audition (see recipes.md). A cycle belongs to a lab through its `labId`.
- **Verdict**: the user's stars and notes on each letter, plus their pick. Only the user who judged can read
  their verdict back.
- **Where the user goes**:
  - `/labs` lists their labs, with how many cycles wait for them;
  - `/labs/<id>` shows the scene, the cycles (open ones marked "waiting for you") and their past picks;
  - `/listen` is where they play and rate; `/listen?waiting` shows only what they haven't rated yet.

## Cloud or local

The same commands take `--target local` (the default) or `--target cloud`.

- **Cloud** is the deployed app (apricity.anth.us), which the user can open from their phone. Use it when the
  user wants to rate there, which is the usual case.
  - It needs a signed-in session: the user runs `apricity login` themselves (it opens a Google sign-in in
    their browser; never do it for them), and `apricity whoami` shows who is signed in.
  - The session sets the owner on every record server-side, so there's no owner flag, and you never touch
    AWS credentials.
  - If a cloud command says to run `apricity login`, ask the user to run it and carry on with local work
    meanwhile.
- **Local** writes straight into a library folder, which the user sees through `apricity serve`. It's good for
  testing the flow, or when there's no network.

`scripts/lab` finds the `apricity` binary itself: this checkout's `target/release/apricity`, else the main
checkout's. If it says the binary is missing or too old, build it as it tells you. `lab` shells out to that
binary for the cloud commands.

## The session

1. **Start (or resume) the lab.** First check what already exists:

   ```bash
   scripts/lab list --target cloud
   ```

   If the scene already has an open lab, keep using it. Otherwise start one on the scene's Score id:

   ```bash
   scripts/lab start <scene score id> --title "<Song>: <what we're after>" --brief "<one or two sentences>" --target cloud
   ```

   It prints the lab id; keep it for the session. Write the brief as the question the user is trying to
   answer ("Try leads that sit over the drop without crowding the bright loop"), not as a to-do list: it's
   what they read on `/labs` when they come back tomorrow.

   In the cloud, the scene must be a cloud Score id. A score's id is `scr_<folder, / as _>_<file stem>_<format>`,
   so `examples/ave-house.apr` is `scr_examples_ave-house_apr`. For a score the user made in the web app, the
   same rule applies to the path its page's URL shows (`<folder>/<title>.<format>`); ask them for the link.
2. **Work the scene as usual.** Shortlist, swap, add, measure, try (search.md). Keep candidates as `.apr` files,
   and build them over the same bars, so they're comparable.
3. **Publish a cycle into the lab** when you have 1–4 candidates worth the user's ears:

   ```bash
   scripts/lab cycle --target cloud publish --lab <lab id> \
     --score <incumbent>.apr --incumbent-score-id <its Score id> \
     --candidates A.apr B.apr C.apr --window 33-40 \
     --title "<Song>: <this round's question>" --question "<the one thing to listen for>"
   ```

   - `--candidates … --window A-B` builds each candidate's 16-bar audition, and the incumbent's, for you.
     `--candidate X.apr X.m4a` (repeatable, with `--incumbent-audio`) publishes audio you rendered already.
   - Note that `--target` goes before `publish`: it's an option of `cycle`.
   - The incumbent is always in the cycle, blind like the rest. The user can't tell which letter is "the
     current version", so their pick is honest. If the incumbent's Score id doesn't exist in the cloud yet,
     `publish` uploads a hidden copy of the `.apr` under that id.
   - Ask one specific question per cycle ("Which lead carries the drop?"), not "which is best?".

   Then tell the user in one line that a cycle is waiting on `/labs` or `/listen`, and what to listen for.
4. **Keep working while they listen.** A verdict calibrates the next round; it doesn't gate it. Don't sit
   waiting: explore the next idea, or prepare the next cycle.
5. **Read the verdict back** when the user says they've rated, or at the start of the next round:

   ```bash
   scripts/lab cycle --target cloud pull <cycle id> [--close]
   ```

   It unblinds the letters and prints one JSON line per finding: each option's stars and notes, and the
   pick.
   - A local `pull` also appends those lines to `renders/log.jsonl` (the calibration record
     `lab backtest` reads). A cloud `pull` doesn't yet, because the cloud is the record. Append its lines to
     `renders/log.jsonl` yourself when you want the verdict in a backtest.
   - `--close` takes the cycle off the user's waiting list once you've read it.
   - Read the user's notes, not just the stars. They catch what no number does: "Did we select the same
     sample to layer on top of itself?" was a note, and it found a bug.
6. **Act on it.** Adopt the winner into the scene (or a fork of it), and say which letter it was and what it
   changes. Compare the pick with what `objective_v2` predicted; when they disagree, that's worth one line
   to the user and a Kanbus note, since it's how the measures get better.
7. **Close the lab** when the scene is done, or the user moves on.

## Other commands

- `scripts/lab cycle --target cloud list`: the open cycles.
- `scripts/lab attach <cycle id> --lab <lab id> --target cloud`: put a cycle published without `--lab` into a
  lab.
- `apricity lab get <lab id>`: one lab's record, as JSON with `--json`.
- For the local library, drop `--target cloud` and add `--library <folder>` if it isn't the default. `cycle`
  also takes `--owner` locally, to name who the library's records belong to.

## Etiquette

- Publishing to the cloud writes to the live site as the user. Do it when the user has asked for listening in
  the web app, or has agreed to it this session. Otherwise ask once.
- Keep cycles small (2–4 options) and the auditions to the standard 16 bars. The user rates on a phone,
  between other things.
- Never put a candidate in a cycle you haven't auditioned yourself: a silent or broken render wastes one of
  the user's listens. Read its mix report first.
