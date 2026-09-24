# Concepts

Apricity has two halves. **Analysis** listens to each recording once and writes down what it hears.
**Scores** say what you want; the compiler uses the analysis to work out how to get it, and the
engine plays the result.

```
 recording.mp3 ──analyze──▶ recording.mp3.apricity.json   (beats, key, tuning, chroma, notes…)
                                   │
 score.apr ──────────compile───────┴──▶ timeline             (every event: what, when,
                                           │                    how warped, how transposed)
                                           ▼
                                     render + mix ──▶ sound  (live, or a WAV file)
```

## Clips and analysis

A **clip** is one audio file: a whole march, a 30-second archive excerpt, or a **stem** (just the
drums, bass or horns of a recording, separated by the Demucs model).

Before a clip can be used it is **analyzed** once. The analysis is saved next to the audio as a
**manifest** (`<file>.apricity.json`) and records:

- **Beats and downbeats** — where the pulse falls, found by the Beat This! neural beat tracker.
  From them come the **tempo** (BPM), **steadiness** (how even the beats are), and the **meter**
  (beats per bar).
- **Warp markers** — each beat, pinned to a beat number. Beat 0 is the first downbeat; pickup beats
  before it are negative. These let Apricity stretch the clip so its beats land on the score's beats.
- **Key**, with runner-up keys, and **key over time** (marches modulate — to the trio, for example).
- **Tuning** — where the recording's A sits relative to 440 Hz. Old 78s are often well off.
- **Chroma** — how much of each of the 12 pitch classes sounds, for the whole clip and for every
  beat. Measured on the pitched part only (drums are filtered out first).
- **Loudness per beat** — so silent stretches can be avoided.
- **Notes** — a transcription by Basic Pitch (not used by the compiler yet).
- **Annotations** — your **slices** (named regions) and **markers** (named points). Re-analysis never
  touches these.

Stems share their parent recording's beat grid, so the drums, bass and horns of one recording stay
locked together.

## Automatic markup

After analysis, Apricity marks up each clip the way a producer would on a first listen, so there
are ready-made regions to use by name. Everything it marks is saved as a **slice** or **marker** in
the manifest, tagged as machine-made:

| Name | What it is |
|---|---|
| `sec-A1`, `sec-B1`, … | **Sections**: the clip's structural parts. Repeats share a letter (`sec-A1`, `sec-A2`). |
| `trio`, `intro` | Sections recognized by role: the march trio (in the subdominant), the opening. |
| `loop-1`, `loop-2`, … | **Loops**: 4-, 8- or 16-beat spans that repeat cleanly, with a steady beat, one harmony and a good level. Best first. |
| `hit-1`, `hit-2`, … | **Hits**: single accents (a band stab, a drum hit), a beat long, plus a `hit` marker at each. |

Use them like any slice: `clip riff = … slice loop-1`, or chop a clip at its hits (`by hits`, below).
Re-running markup replaces only the machine's own marks; your slices and markers are never touched,
and a machine slice never takes a name you've used. Drum stems get loops and hits but no sections.

## Clip beats and score beats

Two kinds of beats matter, and it helps to keep them apart:

- **Clip beats** are numbered by the clip's own analysis (`beats 32..48` means "from this clip's
  beat 32 to its beat 48").
- **Score beats** are the score's grid: `tempo 100` is 100 score beats per minute, and `meter 4` groups
  them into bars.

Usually one clip beat becomes one score beat. But beat trackers often lock onto double or half time,
so each clip has a **beat ratio**: how many clip beats make one score beat. By default Apricity picks
½, 1 or 2 — whichever needs the least stretching. You can set it (`ratio 2`).

## Regions

A clip in a score is really a **region** of a clip: the part that gets played. You choose it one of
four ways:

| Way | Text language | Meaning |
|---|---|---|
| Clip beats | `beats 32..48` | from clip beat 32 up to 48 |
| Seconds | `seconds 12.5..20` | a span of the recording, converted to beats |
| Slice | `slice trio` | a slice you named in the web app (it's saved in the manifest) |
| Pick | `pick 2bars` | let the compiler choose the best stretch of that length (see below) |

With none of these, the region is the whole clip (whole beats from the first downbeat on).

**Pick** scans the clip bar line by bar line and scores every window of that length. It prefers a
window that:

1. fits the score's chords — at its best transposition for each chord, or, if a track `follow`s the
   clip, moved exactly onto each chord's root,
2. has steady beats (so it warps cleanly),
3. holds one harmony instead of moving through chords (so it transposes cleanly), and
4. is actually playing — judged against the clip's *playing* level, so a stem that's silent most of
   the time still finds the stretch where it plays.

`apricity explain` (and the web app's "How it was solved") shows which window each clip got.

## Kits: chops and pads

A **kit** is a set of short sounds meant to be triggered, like a sampler's pads. There are two kinds.

A **chopped kit** cuts one clip's region into numbered **chops**, the classic way to flip a break:

```apr
kit b = chop brk by beats 0.5      # eighth-note chops: b.1, b.2, b.3 …
kit p = chop brk by bars 1         # one chop per bar
kit e = chop brk into 8            # 8 equal pieces, whatever their length
kit h = chop band by hits          # a chop at each marked hit, lasting until the next (at most a bar)
```

Chops cover the clip's region (its `slice`, `beats` or `pick`). A kit holds at most 256 chops.

A **drum kit** gathers named **pads** from anywhere — a kick from one recording, a snare from
another — listed on indented lines:

```apr
kit drums
  kick  = tdrums  slice hit-1
  snare = pdrums  slice hit-2
  rim   = b.3                     # a pad can be a chop from a chopped kit
```

Each pad is level-matched on its own, so pads from different recordings sit together.

Kits and clips share one set of names. A track can play a whole kit (with a step pattern, below),
one chop (`b.3`) or one pad (`drums.kick`); a single chop or pad behaves exactly like a clip.

## Scores

A **score** describes a piece:

- **Tempo** and **meter** — the grid everything is warped to.
- **Key** — the home key. Roman numerals in the progression are read in it, and the harmony solver
  treats notes outside its scale as clashes. Modes are allowed (`F mixolydian` suits blues: its flat
  seventh is in-key).
- **Clips** — named regions of recordings.
- **Kits** — chopped clips and drum kits, for triggering short sounds.
- **Progression** — the chords, in order, each lasting some number of bars. Its total length is the
  length of the piece.
- **Tracks** — which clip plays, when, and how it's transposed.
- **The mix** — each track's effects, pan and sends, the buses they feed, and the master.

A score is written either in the **Apricity language** (`.apr`) or as **YAML** (`.yaml`). They are
two spellings of the same structure.

## Tracks and patterns

A **track** plays a clip, a kit, one chop or one pad. Each time it sounds is a **trigger**. Its
**pattern** says when:

- **loop** (default) — the sound repeats back to back for the whole piece.
- **every** a length (`every 1bar`, `every 2beats`) — the sound restarts at that interval; each trigger
  plays at most that long.
- **at** positions (`at 15 19 23`, or `at 3:2` for bar 3 beat 2) — one trigger at each, playing the whole
  sound (cut off at the end of the track).
- **steps** — a step sequence, like a drum machine's pads (below).

A track can be limited to some **bars** (`bars 13-24`, 1-based and inclusive) and has a **gain** in dB.

When a trigger crosses a chord change it is split in two, so each half can be transposed for its own
chord. Each piece of a trigger is an **event**.

### Step patterns

A step pattern is a row of steps, sixteenth notes by default:

```apr
track b      steps "1 _ 2 _ 3 _ 3 4 | 5 _ 6 _ 7 8 7 _"      # chops of a chopped kit
track drums  steps "kick . . . snare . . kick"             # pads of a drum kit
track clap   steps "x . . . x . . . x . . . x . x ."       # a single sound: x
```

One symbol per step: a **number** plays that chop, a **name** plays that pad, **`x`** plays the
track's own sound (when it's a single clip, chop or pad), **`.`** is silence, **`_`** holds the
previous sound one step longer, and **`[a b]`** splits one step evenly (brackets nest). `|` is only
for reading. Each trigger lasts its written length — the step plus any holds — but never longer than the
sound itself. The pattern repeats to fill the track's bars. `grid 8` makes the steps eighth notes,
`grid 4` beats.

### Flips

A **flip** is anything that turns a sample into something new; the art of sampling is in the flip.
Besides transposition, a track can be flipped with:

| Flip | What it does |
|---|---|
| `swing 58` | Delays every other step, for the loose feel of a hardware sampler. 50 is straight; 56–62 is the classic range; 66 is a triplet feel; up to 75. Notes inside a split step `[ ]` aren't swung. |
| `half`, `double`, `speed 0.75` | Plays the sound at half, double or any speed against the beat (0.125–8), keeping its pitch: `half` turns a loop into a half-time groove. |
| `reverse` | Each trigger plays backwards. |
| `filter lp 800`, `filter hp 250` | A 12 dB/octave low-pass (darker, muffled) or high-pass (thinner, no bass) filter, 20–20000 Hz. |
| `gate 50%` | Cuts each trigger short to that fraction of its length: tight, choppy. |
| `stutter 4` | Replays the start of each trigger that many times within it (1–64): the classic stutter edit. |

`gate` and `stutter` work on whatever the pattern produces. Flips apply to every trigger of the track.

## Transposition and the harmony solver

Every track is transposed for every chord. How is set by the track's **transpose** mode:

- **auto** (default) — the **harmony solver** chooses.
- **follow** — the clip moves with the chord root: the smallest move that puts the clip's **root** on
  the chord's root. This is how blues riffs and bass lines work: the same figure, played on I, IV and
  V. The clip's root is the tonic detected in its region, unless you pin it with `root C`.
- **a number** (`transpose 0`, `transpose -3`) — always that many semitones. Use `0` for drums.

The **solver** tries every shift from −6 to +6 semitones for every auto track, together, and scores
each combination:

- **Fit** — how much of the clip's sound lands on the chord's notes (full credit), on other notes of
  the key (a little credit), or outside the key (a penalty).
- **Role** — an optional hint for where the clip's root should land: `root`, `third`, `fifth`,
  `seventh`, or `chord` (any chord tone). Roles are hints: if honoring one makes the clip clash, the
  solver may not (and `explain` shows why).
- **Coverage** — whether the tracks, together, supply every note of the chord.
- **Costs** — a small cost per semitone moved, and for jumping far from the shift used on the
  previous chord.

Up to five auto tracks are solved exhaustively; more use a fast step-by-step search.

A transposition moves every note of a clip together, so it can't change a clip's *quality*: a major
passage stays major. When a clip keeps a lot of its sound outside the key, the compiler warns and
names the bars. The fix is usually a different region, or a smaller role for that clip.

## Tuning and levels

Before transposing, every clip is **retuned** to A = 440 Hz using its measured tuning, so recordings
from different eras don't beat against each other.

Every track is also **level-matched**: its region is brought to a common loudness (−20 dBFS RMS)
before its own `gain`. So `gain -2` means "two dB under the others", not "compensate for how loud
this recording happened to be". (The match is limited to −24…+30 dB.) The finished mix goes through
the master's limiter and is then brought to a loudness target (−16 LUFS unless the score says
otherwise); see [mixing](#mixing).

## Mixing

The mix is part of the score, written like everything else, so it's as easy to read, diff and hand
to an agent as the notes.

```
triggers ──▶ track: effects in order ──▶ fader (gain) + pan ──┬──▶ master (or a group bus)
                                                              └──▶ sends ──▶ bus: effects ──▶ master
master: effects ──▶ limiter ──▶ loudness target ──▶ speakers
```

- **Track.** A track's triggers are mixed into one lane. Its **effects** (EQ, compression, even
  reverb or delay) run over the whole lane in the order written. Then come its **fader** (`gain`)
  and **pan**.
- **Send.** A copy of the track, after its fader and pan, goes to a **bus** at some level. This is
  how several tracks share one reverb: each sends a little to `bus room`.
- **Bus.** A bus sums what reaches it and runs its own effects. There are two kinds by use:
  - a **return** holds a shared reverb or echo and is all effect;
  - a **group** gathers whole tracks (`out beat`) so they're compressed together, like drums glued
    into one sampled loop.
  Buses can feed other buses, but not in a circle.
- **Master.** The last chain for everything. It always ends in a **limiter**, then turns the whole
  mix up or down to meet a **loudness target** in LUFS. So a sparse score and a dense one come out
  equally loud, the way streaming services even things out.

Two things are special because Apricity plays loops:

- **Seamless tails.** Effects are run twice around the loop and the second pass is kept. A reverb
  or echo at the end of the loop rings on into its start, and a compressor at bar 1 already knows
  what came before it.
- **Live mixing.** In `apricity play` you can mute, solo and fade tracks and buses while it plays
  (see [tools](tools.md#the-apricity-command)). Tracks going straight to the master change within
  an audio block. A track that feeds a bus re-mixes the buses and lands a fraction of a second later.
  Soloing a track keeps its reverb.

## Warping

Warping is Apricity's version of Ableton's warp: the clip's own beats are pinned to score beats and the
audio in between is stretched with the Rubber Band library — changing duration without changing
pitch, and pitch (transposition, retuning) without changing duration, in one pass.

Each clip has a **warp mode**:

| Mode | For | How |
|---|---|---|
| `complex` (default) | most material | Rubber Band's highest-quality engine |
| `beats` | drums and percussive loops | keeps attacks crisp |
| `texture` | pads, sustained sound | smooth, long analysis windows |

Stretching more than 2× either way is flagged: it's usually a sign the beat ratio is wrong.

## From score to sound

Compiling produces a **timeline**: every event with its start (in score beats), the stretch of source
audio it plays, its warp map, its transposition, tuning correction and gain.

Playing it is **render ahead, mix live**:

1. The **renderer** warps and transposes each distinct event once and keeps it in a cache — loops that
   repeat the same bar are rendered once, and after an edit only changed events are re-rendered.
2. The results are laid out into an **arrangement** (a loop of the whole piece): one lane per track
   with its effects applied, plus the buses. The master chain runs live, so a fader move still goes
   through the master's compressor and limiter.
3. The **mixer** plays the arrangement on the audio thread. When a new arrangement arrives (because you
   edited the score), it **swaps in at the next bar line** with a 5 ms crossfade, keeping your place.
   If the edit has mistakes, the last good version keeps playing.

The same engine runs in the `apricity` command and in the browser (as WebAssembly, with the rendering
spread across several workers).

## Where it's going

These are designed and on their way; their briefs are in the repository's `design/`
folder.

- **More mixer** *(planned)* — sidechain ducking (the kick pumping the bass), drive, sampler "lo-fi"
  character, a noise gate, stereo width, and later automation such as filter sweeps. See
  `design/mixer.md`.
- **The curation loop** *(planned)* — analyzers and AI agents propose **candidates** (slices worth
  using, each with its evidence and who proposed it); a person gives each a quick **verdict** (keep,
  skip, later), optionally stars and tags, and files the keepers into **crates**. Verdicts teach the
  ranking. See `design/framework.md`.
