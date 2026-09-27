---
name: write-score
description: Write, fork, remix or improve Apricity scores (.apr files): songs, beats, grooves, demos, and example scores built from the sample library, iterating by rendering and listening with the user. Use this whenever someone wants to make music in Apricity, make a new example or demo score, fork or rework an existing score, make something "sound better/smoother/fuller", build up an arrangement (intro, build, drop, breakdown), or asks what sounds are available, even if they never say "score" or ".apr".
---

# Writing Apricity scores

An Apricity score is a text file (`.apr`) that arranges clips of real recordings: 1890s marches, field recordings, ragtime, an acoustic drum kit. The compiler fits them to a tempo, a key and a chord progression, and the renderer mixes them. Your job is to make music with the user, and this is a listening loop, not a coding task. You write, render and describe what changed; the user listens and reacts; you revise. Their ears are the test suite.

**`docs/language.md` is the authority for syntax.** Read it once per session before writing, especially Track options, Pitched tracks, Groove and Mixing, and check it again whenever you're unsure. The language grows (automation, envelopes, new clip kinds), and the docs are updated with it. This skill covers the craft, not the grammar.

## The loop

1. **Understand the brief.** Genre, mood, tempo range, length, and what the piece is for (a demo that introduces the product? a beat?). If the user names a reference artist or style, translate it into concrete choices: tempo, how often the chords change, density, which sounds are sustained and which are punchy, how much reverb.
2. **Start from what the user likes, within the genre.** Run `python3 .agents/skills/write-score/scripts/ratings.py`: it lists the clips and samples the user has rated, best first. Ratings are the best signal of their taste, but they rate clips they like, not clips that suit every style. **Filter by genre fit first, then prefer the highest-rated.** In a blind test, a deep-house piece built from the user's 4★ *brass-band* loops got 1★, while one built from a 4★ loop of electronic music got 4★. (The harmony checker preferred the brass one: it can't hear genre or timbre, so don't let its number override genre fit.)
3. **Survey the palette.** Run `python3 .agents/skills/write-score/scripts/palette.py [filter] [-v]`; it lists every analyzed sample with its key, tempo and saved clips. Only samples with a manifest can be used. Read `references/palette.md` for which sources suit which roles, and for the traps.
4. **Cast by measurement, not only by rating.** A high rating means the user likes a sound, not that it fits this piece. Shortlist by sound first: `scripts/clap-neighbors.py --ref "<a clip already in the scene>" [--prompt "<style>"]` ranks the library by how close each clip sounds to the scene. Prefer loops in the scene's key and tempo, from related recordings, that need little stretching. `references/search.md` covers the full search toolkit (the explorer, the optimizer, 16-bar auditions and listening cycles) and what their numbers can't hear. Before committing to a main loop, pad or bass, put 3–10 candidates in the same short sketch and let the harmony checker rank them: `scripts/swap-audition.py <score> <clip> "<sample> <saved clip>" …` renders each one in context and ranks it by the checker's objective. Keep the winner, and mention the user's favourite if it lost. In the first session the user's top-rated loop (*Ave*) turned out to be chromatically smeared, and a swap audition found a loop that scored +10 and sounded better to them.
5. **Sketch small.** Start with 4–8 bars and two or three parts. Get the groove and the core sound right before adding layers. It's much easier to hear what's wrong in a sketch.
6. **Audition.** Run `.agents/skills/write-score/scripts/audition.sh <score> [--bars a-b] [--out DIR] [--check]`. Use `--out` to keep your renders in your own folder. It compiles (errors come with line and column), shows each pitched track's pitch from `explain`, renders the WAV and prints the **mix report**: loudness and peak per track. Read the report before anyone listens:
   - `silent` or far below the others (−40 LUFS and down) means something is broken. Typical causes: a region of silence, notes gated to nothing, or a pad that doesn't exist.
   - A pitched track's pitch says `(guessed)` means pin it with `root <note><octave>`.
   - Low sounds read quiet in LUFS (the meter is K-weighted), so judge bass by its peak as well.
7. **Let the user listen, and lead with the audio.** `audition.sh` also writes a small `.m4a` next to the WAV. Send *that* with SendUserFile (the WAVs are 10–15 MB and often fail to reach a phone), with a one-line caption giving timestamps for the moments to listen for. Keep the words short: the user wants to hear music, not read about it. Describe the arrangement **by bars** in a short table, so they can hear each stage, and ask one or two specific questions ("does the kick sit with the bass?"), not "thoughts?".
8. **Revise one idea at a time, and let the checker vote first.** Change one or two things per round, so the listener can tell what the change did. Between listens, iterate on your own with `audition.sh --check`: fix the **top finding** (harmony first, then material, transposition, EQ notches and filters, and levels last; never mute to raise the score), and keep an edit only if the objective rises by at least 2 with no new guard violation. After 2–3 kept edits, or on a question of taste, let the user listen. Before a big rework, copy the last render to `renders/<name>-vN.wav` so they can compare.
9. **Keep notes.** When the language got in your way (a workaround, a missing feature, a confusing error), tell the user in a line. Those notes become features.

## Craft

- **The length of a note is its steps.** A step is a sixteenth unless `grid` says otherwise, and a note lasts its step plus any `_` holds, and never longer than the clip. `gate` cuts a fraction *of that*, so `gate 35%` on a single sixteenth leaves about 40 ms. Use holds (`x _ _ _`) for longer notes.
- **Let Apricity fit the clips to the key; that's what it's for.** Leave loops and phrases on `transpose auto` (the default). The harmony solver moves each clip per chord and retunes it to A440, which is what makes material from different recordings sound like one piece. Don't reach for `transpose 0` to keep a recording "natural". In the first session that shortcut left loops at 42% on chord tones with 20% off-key, and the user heard it as discordant.
- **Take the key from the source's loudest notes, then check the bass against them.** Find the pitch classes a loop leans on (the per-beat chroma or the transcribed notes in its manifest) and choose a key and progression they belong to. Never put the bass a semitone below a note the loops hold. In the first session, D minor put a B♭ bass under *Ave*'s ever-present A, the harshest interval there is, and the user heard it as discord. The same chords in A minor, *Ave*'s own key, removed the clash.
- **Choose the progression by fit, not by the tags.** Write a candidate progression, run `apricity explain`, and read each clip's `on-chord` and `off-key` per chord. Try a few progressions and keep the best. Seventh chords usually fit full-mix loops better than triads: deep house's i7–VImaj7–iv7–v7 beat a plain I–vi. Then confirm on the render with `audition.sh --check`: the mean chord-tone share should rise (random ≈ 25%).
- **Watch the tuning line in `--check`.** If the mix reads more than ~10¢ off A440, a clip's analysed tuning is probably wrong (bug apricitus-9d3385: many ccMixter manifests read −23¢ when they're in tune). The retune then detunes it, and it clashes with anything else.
- **Notch the notes that are wrong everywhere; leave the ones that are only sometimes wrong.** Find each loop's off-chord notes *with their octave* (per stem, per chord span). A note that's off-key under every chord, like *Ave*'s G♯3, A♯3, C♯4 and F♯4 in A minor, gets a narrow notch on that track: `eq peak -8@233 q12`, at most 4 peaks per `eq` line. A note that's a chord tone somewhere (B3 is in G) stays. Stop when the energy guard trips: in the first session, deeper cuts plus overtone notches lowered the objective. Re-measure after each round.
- **Loops can also be sequenced like a sampler**, one loop per chord on the pads of a kit (`steps "b d b d" grid 1`), when each loop clearly plays its own chord. Keep `transpose auto` there too, unless `explain` shows the fit is already high.
- **Envelopes take the edge off.** Without one, a note starts at full punch and is cut when its step ends. `attack 20ms–250ms` softens the front. `release 300ms–1.5s` lets the note ring on into the recording's own continuation instead of being chopped. The first thing to try when something sounds clippy or fatiguing is `attack 30ms release 400ms`.
- **One-shots (`shot-N`) are half-second hits:** punchy, fine for stabs (with a release), fatiguing for anything sustained. For pads, bass and melodies, use held notes. Use `hold-N` clips where the markup has them; otherwise find long, loud notes in the manifest (see `references/palette.md`) and use `seconds a..b root <note>`.
- **Pitched tracks** (`voicing`, `notes`) play one sound at exact pitches, outside the harmony solver. The chord progression still drives `voicing` and `follow`. Degree `1` of `notes` is the key's tonic, not the chord's root, so write melodies on each chord's tones yourself.
- **Patterns restart at a track's first bar.** A track that enters at bar 3 starts its pattern (and its melody) there, so write the melody starting from bar 3's chord.
- **Automation shapes a build without copying tracks.** Indented `automate` lines change a parameter over time: `automate eq.highcut 1=20k 5=6k` rolls the highs off over bars 1–4; `automate comp.mix step 1=0% 13=100%` brings compression in at the drop; `automate volume step 13=0dB 21=-60dB 23=0dB` gives a track a two-bar breath. Filter sweeps (`filter lp 20000` + `automate filter 9=400 13=20k`) are the classic riser. The docs list every target (Mixing → Automation). Point positions are bars, `bar:beat` for finer ones.
- **Arrangement.** A track plays over one `bars` range. For a gap, use a `volume` lane; for a changed part, a second copy with `as <name>`. Make builds obvious: new elements enter on 4- or 8-bar boundaries, and a bar or two of "breath" before a drop makes it land. A reversed held chord (`reverse`, `at <bar>:1`) is a smooth swell into a drop.
- **Old recordings are bright and harsh.** On brass and band material, reach first for `eq highcut 5k–6k` and a dip of 3–4 dB around 2.5 kHz. Then gentle compression (2:1–3:1, slow attack), then a shared reverb return rather than reverb on each track. Kits sound better slightly low-passed too.
- **Level-matching is automatic.** Every clip and pad is matched before the fader, so `volume` is relative balance. Master `loudness` sets the final level; about −14 LUFS is a good default.
- `references/recipes.md` has patterns that worked: grooves, basslines, pads, builds, mix chains, **the 40-bar house form** (intro, groove, lift, breakdown, drop) for finished tracks, and **the 16-bar audition form** for judging a candidate layer: the scene alone (4 bars), then the new part solo (4), then both with a quick build (8). When you're trying layers, render auditions, not full tracks: they're faster to review and lighter on disk.

## Genre defaults

Start here unless the brief says otherwise, and check anything you're unsure of against the brief:

| Style | Tempo | Feel | Notes |
|---|---|---|---|
| Deep house | 118–124 | straight 16ths, light swing 52–56 | four on the floor, sevenths, a chord every 2 bars, long reverb |
| House | 122–128 | straight | offbeat open hat, clap on 2 and 4 |
| Blues shuffle | 80–100 | **`swing 62–66 1/8`** (a shuffle is swung; a march's own drums are straight) | 12-bar I7–IV7–V7, quick change optional |
| Hip-hop / boom bap | 85–95 | `swing 56–60` | chopped breaks, sparse |
| Ragtime / march | 100–120 (2/4 feel) | straight | the source material's own home |

If a source's native tempo is far off (for example 100 BPM material in a house track), stretch it, and check the artefacts by ear. Don't bend the genre to fit the clip.

## Taste

**Match the sources to the genre before anything else.** No amount of processing made a brass band into deep house. In the first session the user called the result "not good music", while praising its smoothness and its build-up. If the library has nothing that fits the requested style, say so early and suggest what to curate (below), instead of forcing it.

For deep house or older-Moby styles, the useful material is: sustained chords (organ, piano, strings, choir), soulful vocal phrases (the Lomax field recordings are the classic Moby source), a round bass, and soft percussion. March brass suits ragtime, swing, marching-band hip-hop or chopped-breakbeat styles better.

**Start sparser than feels right.** Twice in the first session the user's first reaction was "too busy", even when the texture was praised. Loops cut from finished tracks already carry their own rhythm and fills. Over them, start with only a kick and one light percussion part plus a simple bass (long notes on the chord roots), and add layers only when the user asks for more. 16th hats, answering phrases and busy basslines come later, if at all.

Unless the user says otherwise, aim for smooth and musical over loud and busy. In the first session, the user rejected a harsh, busy "main-room EDM" draft in favour of deep house or older-Moby smoothness: long sounds, slow harmony (a chord every two bars), sparse drums, generous reverb. For an introductory demo, less is more.

## Where scores go

- Example and demo scores live in `examples/<name>.apr`. Every file there is round-trip tested (`cargo test -p apricity-score --test examples`), so it must parse and format cleanly.
- Start each file with a comment: a title, what it's built from, and the arrangement in a sentence or two. Comment the sections of the score as a musician would.
- Renders go in `renders/` (git ignores it). Never commit audio.
- To fork an existing score, copy it to a new name, keep its header comment and say what changed. The web app records forks by itself; on disk a fork is just a copy.
