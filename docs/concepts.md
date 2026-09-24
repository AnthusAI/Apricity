# Concepts

Apricity has two halves. **Analysis** listens to each sample once and writes down what it hears.
**Scores** say what you want; the compiler uses the analysis to work out how to get it, and the
engine plays the result.

```
 march.mp3 ──analyze──▶ march.mp3.apricity.json   (beats, key, tuning, chroma, notes, saved clips…)
                                   │
 score.apr ──────────compile───────┴──▶ timeline             (every note: what, when,
                                           │                    how warped, how transposed)
                                           ▼
                                     render + mix ──▶ sound  (live, or a WAV file)
```

## Coming from Live

Apricity uses Ableton Live's words wherever it can, and each word means one thing.

| Apricity | In Live | Means |
|---|---|---|
| **sample** | sample | An audio file in the library, analyzed once. |
| **clip** | clip | A named region of a sample, with its warp settings. Saved with the sample (like a saved `.alc` clip) or defined in a score. |
| **warp**, **warp modes** | warp: Beats, Complex, Texture, Re-Pitch | Stretching a clip onto the grid; `warp repitch` plays it at a speed instead. |
| **transient** | transient marker | An onset worth cutting at. |
| **slice** | a slice (Simpler's Slice mode, Slice to New MIDI Track) | One of the pieces a kit cuts a clip into, each on a numbered pad. |
| **kit**, **pad** | Drum Rack kit, pad | A set of pads played with a step pattern. |
| **track**, **note** | track, note | A track plays a clip, a kit or one pad; each time it sounds is a note. |
| **group track**, **return track**, **send**, **master** | the same | The mixer. |
| **volume**, **pan**, **transpose**, **detune** | the same | A track's fader, its place left to right, its pitch in semitones and in cents. |
| **score** | Live Set | The written piece, in the `.apr` language or YAML. |

## Samples and analysis

A **sample** is one audio file: a whole march, a 30-second archive excerpt, or a **stem** (just the
drums, bass or horns of a recording, separated by the Demucs model).

Before a sample can be used it is **analyzed** once. The analysis is saved next to the audio as a
**manifest** (`<file>.apricity.json`) and records:

- **Beats and downbeats** — where the pulse falls, found by the Beat This! neural beat tracker.
  From them come the **tempo** (BPM), **steadiness** (how even the beats are), and the **time
  signature** (beats per bar).
- **Warp markers** — each beat, pinned to a beat number. Beat 0 is the first downbeat; pickup beats
  before it are negative. These let Apricity stretch a clip so its beats land on the score's beats.
- **Key**, with runner-up keys, and **key over time** (marches modulate — to the trio, for example).
- **Tuning** — where the recording's A sits relative to 440 Hz. Old 78s are often well off.
- **Chroma** — how much of each of the 12 pitch classes sounds, for the whole sample and for every
  beat. Measured on the pitched part only (drums are filtered out first).
- **Loudness per beat** — so silent stretches can be avoided.
- **Notes** — a transcription by Basic Pitch (not used by the compiler yet).
- **Saved clips** (named regions) and **markers** (named points) — yours, and automatic markup's.
  Re-analysis never touches these.

Stems share their parent recording's beat grid, so the drums, bass and horns of one recording stay
locked together.

## Automatic markup

After analysis, Apricity marks up each sample the way a producer would on a first listen, so there
are ready-made clips to use by name. Everything it marks is saved in the manifest as a **clip** or
**marker**, tagged as machine-made:

| Name | What it is |
|---|---|
| `sec-A1`, `sec-B1`, … | **Sections**: the sample's structural parts. Repeats share a letter (`sec-A1`, `sec-A2`). |
| `trio`, `intro` | Sections recognized by role: the march trio (in the subdominant), the opening. |
| `loop-1`, `loop-2`, … | **Loops**: 4-, 8- or 16-beat spans that repeat cleanly, with a steady beat, one harmony and a good level. Best first. |
| `shot-1`, `shot-2`, … | **One-shots**: single accents (a band stab, a drum hit), a beat long, with a `transient` marker at each. |
| `phrase-1`, … | **Phrases**: what lies between pauses, made for speech. |

Use a saved clip by naming it right after the sample's path, `clip riff = … loop-1`, or slice a clip
at its transients (`by transients`, below). Re-running markup replaces only the machine's own marks;
your clips and markers are never touched, and a machine clip never takes a name you've used. Drum
stems get loops and one-shots but no sections.

## Sample beats and score beats

Two kinds of beats matter, and it helps to keep them apart:

- **Sample beats** are numbered by the sample's own analysis (`beats 32..48` means "from this
  sample's beat 32 to its beat 48").
- **Score beats** are the score's grid: `tempo 100` is 100 score beats per minute, and `time 4/4`
  groups them into bars of four.

Usually one sample beat becomes one score beat. But beat trackers often lock onto double or half
time, so each clip has a **beat ratio**: how many sample beats make one score beat. By default
Apricity picks ½, 1 or 2 — whichever needs the least stretching. You can set it (`ratio 2`).

## Clips

A **clip** in a score names the part of a sample that gets played, and how it's warped. You choose
the part one of four ways:

| Way | Text language | Meaning |
|---|---|---|
| A saved clip | `clip riff = horns.wav  trio` | a clip saved with the sample: yours from the Library, or automatic markup's |
| Sample beats | `beats 32..48` | from the sample's beat 32 up to 48 |
| Seconds | `seconds 12.5..20` | a span of the recording, converted to beats |
| Pick | `pick 2bars` | let the compiler choose the best stretch of that length (see below) |

With none of these, the clip is the whole sample (whole beats from the first downbeat on).

**Pick** scans the sample bar line by bar line and scores every window of that length. It prefers a
window that:

1. fits the score's chords — at its best transposition for each chord, or, if a track `follow`s the
   clip, moved exactly onto each chord's root,
2. has steady beats (so it warps cleanly),
3. holds one harmony instead of moving through chords (so it transposes cleanly), and
4. is actually playing — judged against the sample's *playing* level, so a stem that's silent most
   of the time still finds the stretch where it plays.

`apricity explain` (and the web app's "How it was solved") shows which window each clip got.

## Kits: slices and pads

A **kit** is a set of **pads**, short sounds to play from a step pattern, like Live's Drum Rack.
There are two kinds.

A **sliced kit** cuts one clip into numbered **slices**, one per pad, the way Live's Slice to New
MIDI Track does, and the classic way to flip a break:

```apr
kit b = slice brk by beats 0.5      # eighth-note slices on pads b.1, b.2, b.3 …
kit p = slice brk by bars 1         # one slice per bar
kit e = slice brk into 8            # 8 equal slices, whatever their length
kit h = slice band by transients    # a slice at each transient, lasting until the next (at most a bar)
```

Slices cover the whole clip. A kit holds at most 256 of them.

A **drum kit** gathers named **pads** from anywhere — a kick from one recording, a snare from
another — listed on indented lines:

```apr
kit drums
  kick  = tdrums  shot-1
  snare = pdrums  beats 70..70.5
  rim   = b.3                     # a pad can hold another kit's slice
```

Each pad is level-matched on its own, so pads from different recordings sit together.

Kits and clips share one set of names. A track can play a whole kit (with a step pattern, below),
or one pad (`b.3`, `drums.kick`); a single pad behaves exactly like a clip.

## Scores

A **score** describes a piece:

- **Tempo** and **time signature** — the grid everything is warped to.
- **Key** — the home key. Roman numerals in the progression are read in it, and the harmony solver
  treats notes outside its scale as clashes. Modes are allowed (`F mixolydian` suits blues: its flat
  seventh is in-key).
- **Clips** — named regions of samples.
- **Kits** — sliced clips and drum kits: pads to play from step patterns.
- **Progression** — the chords, in order, each lasting some number of bars. Its total length is the
  length of the piece.
- **Tracks** — which clip plays, when, and how it's transposed.
- **The mix** — each track's effects, volume, pan and sends; group and return tracks; and the master.

A score is written either in the **Apricity language** (`.apr`) or as **YAML** (`.yaml`). They are
two spellings of the same structure.

## Tracks and patterns

A **track** plays a clip, a kit, or one pad. Each time it sounds is a **note**. Its **pattern**
says when:

- **loop** (default) — the sound repeats back to back for the whole piece.
- **every** a length (`every 1bar`, `every 2beats`) — the sound restarts at that interval; each note
  plays at most that long.
- **at** positions (`at 15 19 23`, or `at 3:2` for bar 3 beat 2) — one note at each, playing the whole
  sound (cut off at the end of the track).
- **steps** — a step sequence, like a drum machine's pads (below).

A track can be limited to some **bars** (`bars 13-24`, 1-based and inclusive) and has a **volume** in dB.

When a note crosses a chord change it is split in two, so each half can be transposed for its own
chord. Each piece of a note is an **event**.

### Step patterns

A step pattern is a row of steps, sixteenth notes by default:

```apr
track b      steps "1 _ 2 _ 3 _ 3 4 | 5 _ 6 _ 7 8 7 _"      # numbered pads of a sliced kit
track drums  steps "kick . . . snare . . kick"             # pads of a drum kit
track clap   steps "x . . . x . . . x . . . x . x ."       # a single sound: x
```

One symbol per step: a **number** plays that pad of a sliced kit, a **name** plays that pad of a drum
kit, **`x`** plays the track's own sound (when it's a single clip or pad), **`.`** is silence, **`_`**
holds the previous sound one step longer, and **`[a b]`** splits one step evenly (brackets nest). `|`
is only for reading. Each note lasts its written length — the step plus any holds — but never longer than the
sound itself. The pattern repeats to fill the track's bars. `grid 8` makes the steps eighth notes,
`grid 4` beats.

### Flips

A **flip** is anything that turns a sample into something new; the art of sampling is in the flip.
Besides transposition, a track can be flipped with:

| Flip | What it does |
|---|---|
| `swing 58` | Delays every other step, for the loose feel of a hardware sampler. 50 is straight; 56–62 is the classic range; 66 is a triplet feel; up to 75. Notes inside a split step `[ ]` aren't swung. |
| `half`, `double`, `speed 0.75` | Plays the sound at half, double or any speed against the beat (0.125–8), keeping its pitch: `half` turns a loop into a half-time groove. |
| `reverse` | Each note plays backwards. |
| `filter lp 800`, `filter hp 250` | A 12 dB/octave low-pass (darker, muffled) or high-pass (thinner, no bass) filter, 20–20000 Hz. |
| `gate 50%` | Cuts each note short to that fraction of its length: tight, choppy. |
| `stutter 4` | Replays the start of each note that many times within it (1–64): the classic stutter edit. |

`gate` and `stutter` work on whatever the pattern produces. Flips apply to every note of the track.

## Transposition and the harmony solver

Every track is transposed for every chord. How is set by the track's **transpose** mode:

- **auto** (default) — the **harmony solver** chooses.
- **follow** — the clip moves with the chord root: the smallest move that puts the clip's **root** on
  the chord's root. This is how blues riffs and bass lines work: the same figure, played on I, IV and
  V. The clip's root is the tonic detected in it, unless you pin it with `root C`.
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
names the bars. The fix is usually a different clip, or a smaller role for it.

## Tuning and levels

Before transposing, every clip is **detuned** to A = 440 Hz using its measured tuning, so recordings
from different eras don't beat against each other.

Every track is also **level-matched**: its clip is brought to a common loudness (−20 dBFS RMS)
before its own `volume`. So `volume -2` means "two dB under the others", not "compensate for how loud
this recording happened to be". (The match is limited to −24…+30 dB.) The finished mix goes through
the master's limiter and is then brought to a loudness target (−16 LUFS unless the score says
otherwise); see [mixing](#mixing).

## Mixing

The mix is part of the score, written like everything else, so it's as easy to read, diff and hand
to an agent as the notes.

```
notes ──▶ track: effects in order ──▶ volume + pan ──┬──▶ its group track (or the master)
                                                     └──▶ sends ──▶ return track: effects ──▶ master
group track: effects ──▶ volume ──▶ its group (or the master)
master: effects ──▶ limiter ──▶ loudness target ──▶ speakers
```

- **Track.** A track's notes are mixed into one lane. Its **effects** (EQ, compression, drive, lo-fi,
  a noise gate, stereo width, even reverb or delay) run over the whole lane in the order written.
  Then come its **volume** (the fader) and **pan**. A compressor can be **sidechained** to another
  track, so the kick ducks the bass.
- **Group track.** Tracks put in a group (`group beat` on the track line) are summed and run through
  the group's own effects, like drums glued into one sampled loop. Groups can sit inside groups, but
  not in a circle.
- **Return track.** A shared effect, such as one reverb for everything. Tracks reach it with a
  **send**: a copy of the track, after its volume and pan, at some level (`send room 20%`). A return
  plays into the master.
- **Master.** The last chain for everything. It always ends in a **limiter**, then turns the whole
  mix up or down to meet a **loudness target** in LUFS. So a sparse score and a dense one come out
  equally loud, the way streaming services even things out.

Two things are special because Apricity plays loops:

- **Seamless tails.** Effects are run twice around the loop and the second pass is kept. A reverb
  or echo at the end of the loop rings on into its start, and a compressor at bar 1 already knows
  what came before it.
- **Live mixing.** In `apricity play` you can mute, solo and move the volume of tracks, groups and
  returns while it plays (see [tools](tools.md#the-apricity-command)). Tracks going straight to the
  master change within an audio block. A track in a group or with sends re-mixes those and lands a
  fraction of a second later. Soloing a track keeps its reverb.

## Warping

Warping works like Live's warp: the sample's own beats are pinned to score beats and the audio in
between is stretched with the Rubber Band library — changing duration without changing pitch, and
pitch (transposition, detuning) without changing duration, in one pass.

Each clip has a **warp mode**:

| Mode | For | How |
|---|---|---|
| `complex` (default) | most material | Rubber Band's highest-quality engine |
| `beats` | drums and percussive loops | keeps attacks crisp |
| `texture` | pads, sustained sound | smooth, long analysis windows |
| `repitch` | speech, turntable moves | not stretched: plays at its `speed`, which moves its pitch too, like a record |

Stretching more than 2× either way is flagged: it's usually a sign the beat ratio is wrong.

## From score to sound

Compiling produces a **timeline**: every event with its start (in score beats), the stretch of source
audio it plays, its warp map, its transposition, detune and level.

Playing it is **render ahead, mix live**:

1. The **renderer** warps and transposes each distinct event once and keeps it in a cache — loops that
   repeat the same bar are rendered once, and after an edit only changed events are re-rendered.
2. The results are laid out into an **arrangement** (a loop of the whole piece): one lane per track
   with its effects applied, plus the group and return tracks. The master chain runs live, so a fader move still goes
   through the master's compressor and limiter.
3. The **mixer** plays the arrangement on the audio thread. When a new arrangement arrives (because you
   edited the score), it **swaps in at the next bar line** with a 5 ms crossfade, keeping your place.
   If the edit has mistakes, the last good version keeps playing.

The same engine runs in the `apricity` command and in the browser (as WebAssembly, with the rendering
spread across several workers).

## Where it's going

These are designed and on their way; their briefs are in the repository's `design/` folder.

- **Automation** *(planned)* — changes over time, such as filter sweeps. See `design/mixer.md`.
- **The curation loop** *(in progress)* — analyzers and AI agents propose **candidates** (clips worth
  saving, each with its evidence and who proposed it); a person gives each a quick **verdict** (keep,
  skip, later), optionally stars and tags, and files the keepers into **collections**. Verdicts
  teach the ranking. See `design/framework.md` and `design/curation.md`.
