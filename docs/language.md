# The Apricity language

`.apr` files are Apricity's compact way to write a score. Everything here has a YAML equivalent
([YAML scores](yaml.md)); both compile to the same thing, and `apricity fmt` converts between them.
For what the words mean musically, see [Concepts](concepts.md). The words are a DAW's
wherever a DAW has one: a sample, a clip, a slice, a pad, a group track, a return track.

- [A complete example](#a-complete-example)
- [How a file is read](#how-a-file-is-read)
- [Statements](#statements) — `tempo` `time` `key` `samples` `bars` `apricity` `clip` `kit` `chords` `track` `group` `return` `master`
- [Clip options](#clip-options)
- [Kits](#kits)
- [Chord lines](#chord-lines)
- [Track options](#track-options)
- [Step patterns](#step-patterns)
- [Mixing](#mixing) — effects, pan, sends, group and return tracks, the master
- [Mistakes and messages](#mistakes-and-messages)
- [Grammar](#grammar)

## A complete example

```apr
# March Blues — a 12-bar blues in F from a Sousa march split into stems.
tempo 100                 # beats per minute
key F mixolydian          # home key; roman numerals are read in it
samples ../samples        # sample paths are relative to this folder

clip groove = marine-band/stems/WashingtonPost/drums.wav   pick 2bars  warp beats
clip tuba   = marine-band/stems/WashingtonPost/bass.wav    pick 1bar
clip horns  = marine-band/stems/WashingtonPost/other.wav   pick 1bar
clip bugle  = citizen-dj/loc-jukebox-popular/Army-bugle-calls_jukebox-118367_001_00-00-56.wav  pick 1bar

# chorus 1: quick change in bar 2, turnaround in bar 12
chords I7 IV7 I7 .  | IV7 . I7 .  | V7 IV7 I7 V7
# chorus 2
chords I7 IV7 I7 .  | IV7 . I7 .  | V7 IV7 I7 .

track groove  transpose 0  volume -3        # drums don't follow the chords
track tuba    follow                        # bass moved to each chord's root
track horns   follow  bars 13-24  volume -2 # riff, in parallel on every chord
track bugle   at 15 19 23  volume -5        # call and response
```

## How a file is read

- **One statement per line.** A line starts with a statement word (`tempo`, `clip`, `track`, …); the
  rest of the line is its arguments and options, separated by spaces or tabs.
- **Comments** start with `#` and run to the end of the line.
- **Blank lines** are ignored. Order doesn't matter, except that `chords` lines add up in order and
  `track` lines are numbered in order.
- **Indented lines** belong to the statement above them: the pads of a drum kit (`kit drums` then
  `  kick = …`), and the effects of a track, a group or return track, or the master (`track horns`
  then `  eq lowcut 120`).
- **Quoted text** (`steps "1 . 3 ."`) is one argument, spaces and all; a `#` inside quotes is not a
  comment.
- **Paths and names are single words** — no spaces. (A path with spaces needs the YAML format.)
- **Numbers** are plain decimals: `100`, `-2`, `0.5`.
- **Durations** are a number and a unit: `1bar`, `2bars`, `0.5bar`, `3beats`, `1beat`.
- **Mix values carry their units**: `-18dB`, `10ms`, `1.8s`, `25%`, `-14LUFS`, `4:1`. Frequencies
  may be bare Hz: `120`, `120Hz`, `6k`. See [units](#units).
- Everything is **case-sensitive**: `Tempo` is not a statement, and in chords `IV` and `iv` are
  different chords.

## Statements

| Statement | Required | Meaning | Default |
|---|---|---|---|
| `tempo <bpm>` | yes | Score tempo in beats per minute (20–400). | |
| `key <key>` | yes | Home key, e.g. `Abm`, `F mixolydian`, `C# dorian`. The rest of the line (before any `#`) is the key. See [keys](chords.md#keys). | |
| `time <n>/4` | | Time signature: *n* beats to a bar (1–16), each a quarter note, e.g. `time 3/4`. Only x/4 for now. | `4/4` |
| `samples <folder>` | | Folder that sample paths are relative to, itself relative to the score file. | the score's folder |
| `bars <n>` | | Length in bars, for a piece **without** chords. With chords, the chords set the length (and a `bars` that disagrees is an error). | |
| `swing <percent> [1/<n>]` | | Swing for every step track that doesn't set its own. See [groove](#groove). | `50` (straight) |
| `humanize [<ms>ms] [<percent>%]` | | Small differences in timing and velocity from note to note, for every track that doesn't set its own. See [groove](#groove). | none |
| `seed <n>` | | Which take of the humanize variation. | `1` |
| `apricity <version>` | | Format version. Only `0.1` exists. | `0.1` |
| `clip <name> = <sample> [saved clip] [options]` | | Defines a clip. See [clip options](#clip-options). | |
| `kit <name> = slice <clip> …` / `kit <name>` + pads | | Defines a kit. See [kits](#kits). | |
| `chords <chords…>` | one of `chords`/`bars` | Adds chords to the progression. See [chord lines](#chord-lines). | |
| `track <sound> [options]` | | Plays a clip, a kit, or one pad of a kit. See [track options](#track-options). | |
| `group <name> [volume <dB>] [group <name>]` + indented lines | | A group track: tracks summed and processed together. See [group and return tracks](#group-and-return-tracks). | |
| `return <name> [volume <dB>]` + indented lines | | A return track: shared effects that tracks send to. See [group and return tracks](#group-and-return-tracks). | |
| `master` + indented lines | | The master chain. See [the master](#the-master). | |

**Clip and kit names** are letters, digits, `-` and `_`, and share one namespace: a kit can't have
the same name as a clip. **Group and return track names** follow the same rules and share a
namespace of their own; they can't be `master`, and can't be the name of a track.

## Clip options

```apr
clip riff = marine-band/stems/Thunderer/other.wav  beats 32..36  root C  warp complex
clip brk  = marine-band/stems/Thunderer/drums.wav  loop-1  warp beats
```

A clip is a named region of a **sample** (the audio file after `=`), with its warp settings. Choose
the region with at most one of: a saved clip, `beats`, `seconds` or `pick`. With none, the clip is
the whole sample.

**A saved clip** is named right after the path: `clip brk = … loop-1`. It's a clip saved with the
sample (in its manifest): automatic markup's `loop-1`, `sec-A1`, `shot-3` or `trio` (see
[automatic markup](concepts.md#automatic-markup)), or one you saved in the web app's Library. The
first word after the path names a saved clip unless it's one of the options below.

| Option | Example | Meaning |
|---|---|---|
| a saved clip's name | `loop-1` | A clip saved with the sample. Right after the path, before any other option. |
| `beats <a>..<b>` | `beats 32..48` | Region from sample beat *a* to *b* (the sample's own beat numbers; 0 is its first downbeat). Must lie inside the sample. |
| `seconds <a>..<b>` | `seconds 12.5..20` | Region by time in the recording. Must lie inside the sample. |
| `pick <duration>` | `pick 2bars` | Let the compiler choose the best region of that length (in score time). See [Concepts: Clips](concepts.md#clips). |
| `root <note>` | `root C` | What the region is built on. Used by `follow` and `role`. Default: the key detected in the region. |
| `ratio <n>` | `ratio 2` | Sample beats per score beat. Default: ½, 1 or 2, whichever stretches least. |
| `warp <mode>` | `warp beats` | `complex` (default), `beats` (drums: crisp attacks), `texture` (pads) or `repitch` (Live's Re-Pitch: not stretched to the grid; the clip plays like a record at its `speed`, so its pitch moves with it, and it isn't transposed for the chords). |
| `speed <x>` | `speed 1.5`, `speed 1.5x` | For `warp repitch` only: play 1.5× as fast (and a fifth higher), 0.25–4. A re-pitched clip needs its region from a saved clip, `beats` or `seconds`, not `pick`. |

## Kits

A kit is a set of **pads**, short sounds to play with `steps`, like Live's Drum Rack. See
[Concepts: Kits](concepts.md#kits-slices-and-pads).

**A sliced kit** cuts one clip into numbered **slices**, each on its own pad (`b.1`, `b.2`, …), the
way Live's Slice to New MIDI Track does:

```apr
kit b = slice brk by beats 0.5     # a slice every half beat (any positive number)
kit p = slice brk by bars 1        # a slice every bar
kit e = slice brk into 8           # 8 equal slices
kit h = slice band by transients   # a slice at each transient
kit w = slice voice by phrases     # a slice per spoken phrase
```

| Form | Slices |
|---|---|
| `by beats <n>` | every *n* score beats across the clip's region |
| `by bars <n>` | every *n* bars |
| `into <n>` | *n* equal slices (a whole number) |
| `by transients` | one per `transient` marker in the region ([automatic markup](concepts.md#automatic-markup) makes them, or add your own), each lasting until the next transient and at most a bar |
| `by phrases` | one per saved `phrase-N` clip in the region (automatic markup finds the pauses in speech), in order |

The slices cover the clip's region, so slice one loop of a longer sample by naming its saved clip
first: `clip brk = … loop-1`. Slices are numbered from 1 in time order, and slice *n* sits on pad
*n*; at most 256.

**A drum kit** is `kit <name>` alone on a line, followed by indented pad lines:

```apr
kit drums
  kick  = tdrums  beats 62..62.5
  snare = pdrums  beats 70..70.5
  crash = band    shot-3
  rim   = b.3
```

Each pad line is `<pad> = <clip> [<saved clip> | beats <a>..<b> | seconds <a>..<b>]`, or
`<pad> = <kit>.<n>` to put a sliced kit's slice on the pad. A saved clip goes right after the clip
name, as on a `clip` line (`crash = band shot-3`: the sample's one-shot `shot-3`). Pad names are
words (`kick`, `snare-2`), not numbers. Each pad is level-matched on its own.

## Chord lines

```apr
chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 V7
```

A chord line reads like a chord chart: **one chord per bar**, left to right. Every `chords` line
continues where the previous one stopped.

| Write | Means | Example | Bars |
|---|---|---|---|
| a chord | that chord for one bar | `I7` | I7 (1) |
| `.` or `%` | hold the previous chord one more bar | `I7 . .` | I7 (3) |
| `chord*n` | that chord for *n* bars (any positive number) | `I7*2 V7*0.5 IV7*0.5` | I7 (2), V7 (½), IV7 (½) |
| `[a b …]` | split **one bar** evenly between them | `[ii V] I` | ii (½), V (½), I (1) |
| `[a b*2]` | split one bar by weight | `[I IV V*2]` | I (¼), IV (¼), V (½) |
| `[…]*n` | the split lasts *n* bars | `[I IV]*2` | I (1), IV (1) |
| `(a b …)*n` | repeat a group *n* times (a whole number) | `(I IV)*2 V` | I, IV, I, IV, V |
| `\|` | nothing — just for reading | `I IV \| V I` | |

Brackets can nest: `[I [IV V]]` gives I for half a bar, then IV and V for a quarter each.

The same chord twice in a row joins into one longer chord (`I7 I7` is `I7*2`).

**Chords** can be roman numerals read in the score's key (`I7`, `iv`, `bVI`, `V/V`, `viiø7`) or chord
symbols (`Dbm`, `Eb7`, `Bbmaj7`). The full list is in [Chords and keys](chords.md).

## Track options

```apr
track horns  as riff  follow  bars 13-24  volume -2
track b      steps "1 _ 2 _ 3 _ 3 4"  swing 58  transpose 0
track h.3    every 1bar  reverse  filter lp 800
```

`track` is followed by what to play:

| Write | Plays | Patterns |
|---|---|---|
| `track horns` | a clip | any |
| `track b` | a whole kit | `steps` only |
| `track b.3` | one pad of a sliced kit (the one holding slice 3) | any |
| `track drums.kick` | one pad of a drum kit | any |

A single pad behaves exactly like a clip (`follow`, `role`, `at`, `every` all work).

Then any options. Each time a track sounds is a **note**: each repeat of a loop, each step, each
`at` position.

| Option | Example | Meaning | Default |
|---|---|---|---|
| `as <name>` | `as riff` | Name the track. Needed when the same sound plays on two tracks: names must be unique, because the mixer tells tracks apart by name. | what it plays |
| `follow` | `follow` | Move with the chord root (like a blues riff). Same as `transpose follow`. | |
| `transpose <t>` | `transpose 0`, `transpose -3`, `transpose +5`, `transpose auto` | `auto`: the harmony solver chooses per chord. `follow`: move with the root. A number: always that many semitones. | `auto` |
| `role <r>` | `role third` | Hint for where the clip's root should land: `root`, `third`, `fifth`, `seventh`, `chord` (any chord tone) or `any`. With `follow`, only `root` or `any` make sense. | `any` |
| `loop` | `loop` | Repeat the sound back to back. | ✓ |
| `every <duration>` | `every 1bar` | Restart the sound at that interval; each note plays at most that long. | |
| `at <positions…>` | `at 3 7 11`, `at 3:1 3:3` | One note at each position: a bar number, or `bar:beat` (both start at 1). Each note plays the whole sound. | |
| `steps "<pattern>"` | `steps "1 . 3 ."` | A step sequence. See [step patterns](#step-patterns). | |
| `grid <n>` | `grid 8`, `grid 1/8` | Step size for `steps` as a note value, 1–64: 16 = sixteenths, 8 = eighths, 4 = beats. | `16` |
| `swing <percent> [1/<n>]` | `swing 58`, `swing 58%`, `swing 60 1/8` | Delay every other step: 50 = straight, 56–62 classic, 66 ≈ triplets; 50–75. `1/8` swings eighths even when the steps are sixteenths. See [groove](#groove). | the score's, else `50` |
| `velocity <1–127>` | `velocity 90` | Velocity of every note that doesn't give its own; 100 = the pad's matched level. | `100` |
| `humanize [<ms>ms] [<percent>%]` | `humanize 12ms 20%` | Move each note by up to ±12 ms and vary its velocity by up to ±20%. See [groove](#groove). | the score's, else none |
| `seed <n>` | `seed 3` | Which take of the humanize variation. | the score's, else `1` |
| `half` / `double` / `speed <x>` | `half`, `speed 0.75` | Play at half, double or any speed against the beat (0.125–8), keeping pitch. | `1` |
| `reverse` | `reverse` | Each note plays backwards. | |
| `filter lp <Hz>` / `filter hp <Hz>` | `filter lp 800`, `filter hp 250` | 12 dB/octave low-pass or high-pass filter, 20–20000 Hz. (`lowpass`, `highpass` also work.) | |
| `gate <fraction>` | `gate 50%`, `gate 0.5` | Cut each note to that fraction of its length (a number above 1 is read as a percentage). | |
| `stutter <n>` | `stutter 4` | Replay the start of each note *n* times within it, 1–64. | |
| `bars <a>-<b>` | `bars 13-24`, `bars 5` | Only play in these bars (1-based, inclusive). | the whole piece |
| `volume <dB>` | `volume -3` | The track's fader: its level relative to the other tracks (every track is level-matched first). | `0` |
| `group <name>` | `group beat` | Play into a group track instead of straight into the master. See [group and return tracks](#group-and-return-tracks). | the master |

`loop`, `every`, `at` and `steps` are alternatives; the last one on the line wins. `half`, `double`
and `speed` likewise.

## Step patterns

```apr
track b      steps "1 _ 2 _ 3 _ 3 4 | 5 _ 6 _ 7 8 7 _"
track drums  steps "kick . . . snare . . kick | . kick . . snare . . ."
track clap   steps "x . . . x . [x x] ."
```

| Symbol | Means |
|---|---|
| a number | that pad of a sliced kit, playing its slice (the track plays a sliced kit) |
| a name | that pad (the track plays a drum kit) |
| `x` | the track's own sound (the track plays a clip or one pad) |
| `.` or `~` | silence for one step |
| `_` | hold the previous sound one more step |
| `[a b …]` | split one step evenly among them; brackets nest |
| `…@<1–127>` | a note's velocity: `snare@40` (a ghost note), `kick@110`; 100 = as written |
| `…!` | an accent: velocity 127 (`snare!`) |
| `\|` | nothing — just for reading |

Each step is a sixteenth note unless `grid` says otherwise. A note lasts its written length (its step
plus any `_` holds) but never longer than the slice or pad itself. The pattern starts at the track's
first bar and repeats to fill its bars. With `swing`, every second step is delayed; notes inside a
split step are not.

## Groove

Three things make a pattern feel played rather than programmed, as in Live's groove pool:

```apr
swing 58 1/8                 # every step track swings its eighths
humanize 8ms 12%             # every note a little early or late, a little softer or louder

track drums  steps "kick . snare@40 . snare! . . snare@40 | …"   # ghost notes and an accent
track hat    steps "x x x x"  velocity 80  humanize 4ms 25%      # this track's own feel
```

- **Swing** delays the notes on the offbeats of its base, counted from the bar line: with `1/8`, the
  "and" of each beat; by default, every second step. 58 means the offbeat sits at 58% of the pair.
  Notes between the base's slots (sixteenths under `swing … 1/8`) stay where they are. A track's
  `swing` overrides the score's; `swing 50` is straight.
- **Velocity** is how hard a note is played, 1–127 as in Live. 100 plays a pad at its matched level
  (every pad is level-matched on its own); other velocities change that level by
  40·log₁₀(velocity / 100) dB: 127 is about +4 dB, 70 about −6 dB, 40 about −16 dB. Give it per note
  (`snare@40`, `kick!`) or for a whole track (`velocity 90`).
- **Humanize** moves every note by up to the timing (in milliseconds) and varies its velocity by up
  to the percentage, each note differently. It is not random on every play: the same score always
  plays the same take, so saving while it loops doesn't change the feel, and renders are
  repeatable. `seed 2` (or any other number) is another take.

## Mixing

The mix is written in the score, as **indented lines** under the thing they shape: a track, a group
or return track, or the master. Effects run **in the order written**.

```apr
track horns  follow
  eq    lowcut 120  low -3@250  high +2dB@6k  peak -4@800 q1.4
  comp  4:1  -18dB  attack 10ms  release 120ms
  pan   30
  send  plate 30%  echo 20%

track drums  steps "kick . snare ."  group beat

group beat                           # a group track: every track with `group beat` is summed and glued
  comp  4:1  -14dB  attack 20ms

return plate                         # a return track: tracks send to it
  eq      lowcut 250
  reverb  plate  1.8s  predelay 20ms  damp 35%

return echo  volume -4
  delay  1/8.  feedback 35%  hp 400  lp 4k  pingpong

master
  eq       lowcut 30
  comp     2:1  -12dB  attack 30ms  release 200ms
  limit    -1dB
  loudness -14LUFS
```

`examples/chop-shop-mixed.apr` is a whole mix; render it next to `chop-shop.apr` to hear the
difference.

### Where each line goes

| Line | Under a track | Under a group or return track | Under `master` |
|---|---|---|---|
| `eq`, `comp`, `limit` | ✓ | ✓ | ✓ |
| `reverb`, `delay` | ✓ (25% wet) | ✓ (group 25% wet; return all wet) | ✗ put them on a return track |
| `pan` | ✓ | | |
| `send` | ✓ | | |
| `loudness` | | | ✓ |

A track's `volume` is its **fader**; its effects run before it, and `pan` and the sends after it.

### Effects

| Effect | Write | Parameters |
|---|---|---|
| `eq` | `eq lowcut 120 low -3@250 high +2@6k peak -4@800 q1.4 highcut 9k` | `lowcut` / `highcut` Hz (20–20000); `low` / `high` shelves as gain@Hz (±24 dB); `peak` gain@Hz with an optional `q` (0.1–18, default 1), repeatable; up to 8 bands |
| `comp` | `comp 4:1 -18dB attack 10ms release 120ms knee 6dB makeup 3dB` | ratio (1–50) and threshold (−60–0 dB) first, both required; `attack` 0.1–500 ms, `release` 5–3000 ms, `knee` 0–24 dB, `makeup` −12–24 dB |
| `limit` | `limit -1dB release 50ms` | ceiling (−24–0 dB), optional `release` (1–2000 ms); the output never goes over the ceiling |
| `reverb` | `reverb plate 1.8s predelay 20ms damp 35% mix 30%` | `room`, `hall` (default) or `plate`; a decay in seconds (0.1–20; default room 0.8 s, hall 2.4 s, plate 1.6 s); `predelay` 0–500 ms; `damp` and `mix` 0–100% |
| `delay` | `delay 1/8. feedback 35% hp 400 lp 4k pingpong mix 30%` | the time first: a [note value](#units) or `350ms`; `feedback` 0–95%; `hp` / `lp` Hz on the echoes; `pingpong` bounces them left and right; `mix` 0–100% |
| `pan` | `pan -20` | −100 (left) to 100 (right); tracks only |
| `send` | `send plate 30% echo -12dB` | one or more return track + level pairs; tracks only |
| `loudness` | `loudness -14LUFS` | the master's target, −40 to −5 LUFS; master only |

`mix` is the wet share. Under a return track it defaults to 100%, since a return is all effect;
under a track or a group track, which carry the music itself, it defaults to 25%. Delays in note values follow the tempo.

### Group and return tracks

As in Live, there are two kinds of shared track, and each has its own statement. Their effects go
on indented lines below them.

**A group track** sums whole tracks so they're processed together, like drums compressed into one
sampled loop. `group <name>` starts one. On the `group` line itself:

- `volume <dB>` — the group's fader (−60 to +12).
- `group <name>` — sit inside another group instead of playing into the master. Groups can nest,
  but not in a circle.

A track joins a group with **`group <name>`** on its track line: the whole track, after its fader
and pan, goes through the group instead of to the master.

**A return track** holds a shared effect, like a reverb or an echo, and is all effect. `return
<name>` starts one, with `volume <dB>` (−60 to +12) on its line; it always plays into the master.
A track reaches a return only by a send:

- **`send <return> <level>`** under the track: a copy of the track, after its fader and pan, goes
  to the return as well. Levels are a percentage (`25%`) or in dB (`-12dB`). This is how tracks
  share a reverb or an echo.

Every group needs something playing in it, and every return something sending to it.

### The master

`master` is the last chain for the whole mix. It always ends in a limiter (−1 dB if you don't write
one), and then the whole mix is turned up or down to meet the `loudness` target (default −16 LUFS).
So a quiet score and a busy one come out about equally loud.

### Units

| Kind | Write | Notes |
|---|---|---|
| Level | `-18dB`, `+3dB` | Required for thresholds, ceilings, knee and makeup. A bare `-18` is an error, so there are no silent 1000× mistakes. |
| Gain at a frequency | `-3@250`, `+2dB@6k` | For EQ shelves and peaks; the gain is in dB either way. |
| Frequency | `120`, `120Hz`, `6k`, `6kHz` | The one place a bare number is fine: it means Hz. |
| Time | `10ms`, `0.2s`, `1.8s` | |
| Share | `25%` | Sends also take dB. |
| Ratio | `4:1` | |
| Loudness | `-14LUFS` | |
| Note value | `1/8`, `1/8.` (dotted), `1/4t` (triplet), `3beats` | For delay times. A quarter note is one beat. |

## Mistakes and messages

Apricity reports **every** mistake it can find at once, each with a line and column, and the web editor
underlines them. Some examples:

```
line 3 column 1: unknown statement `trakc` (did you mean `track`?)
line 4 column 13: unknown track option `volme` (did you mean `volume`?)
line 5 column 11: `[` is never closed
line 3 column 8: `.` holds the previous chord, but there isn't one yet
line 13 column 1: track.clip: no clip or kit named "hron" (did you mean "horn"?)
line 5 column 1: clip horn.beats: [0, 999] is outside the clip's beats [0, 396]
line 4 column 1: clip bugle.saved: no saved clip "shot-2" in this sample; it has ["loop-1", "shot-1"]
line 14 column 1: track.pattern: `b` is a kit; play it with steps "1 . 2 . 3 . 4 ." (or one pad: b.1)
line 15 column 1: track.pattern.steps: uses pad 9, but kit `b` has 4 pads
line 16 column 1: track.pattern.steps: kit `drums` has no pad `snair` (did you mean "snare"?)
line 17 column 1: track.pattern.steps: `1` picks a pad, but `horn` is a single sound; use x (e.g. "x . x ."), or slice it into a kit
line 18 column 1: track.pattern.steps: `x` plays the track's own sound, but this track is the whole kit `drums`; name the pad to play
line 8 column 1: kit `empty` has no pads; list them on indented lines below it, e.g.  kick = drums shot-1
line 11 column 14: `-18`: write the threshold in dB, e.g. -18dB
line 12 column 16: `12x` isn't a frequency (e.g. 120, 120Hz, 6k)
line 13 column 10: unknown reverb part `cathedral`: reverb [room|hall|plate] [decay like 2.4s] [predelay 20ms] [damp 50%] [mix 30%] (expected one of: room, hall, plate, predelay, damp, mix)
line 19 column 1: track.group: there's no group track `beet` (did you mean "beat"?)
line 19 column 1: track.sends.rooom: there's no return track `rooom` (did you mean "room"?)
line 19 column 1: track.sends.beat: there's no return track `beat`; `beat` is a group track: put the track in it with group beat
line 22 column 1: group beat: nothing plays in this group; put a track in it (track … group beat)
line 24 column 1: return room: nothing sends to this return track; send a track to it (send room 20%)
line 6 column 15: unknown return option `group` (volume); effects go on indented lines below
line 15 column 3: `reverb` doesn't go on the master (it plays live); put it on a return track and send tracks to it (or on a group track)
line 16 column 3: `pan` doesn't belong here (expected one of: eq, comp, limit, width, loudness)
line 17 column 12: `-14`: write loudness in LUFS, e.g. -14LUFS
line 13 column 6: only x/4 time signatures for now (3/4, 4/4, 7/4…), not `6/8`
groups: `a`, `c` sit inside each other in a loop; one of them must play into the master
```

Beyond mistakes, the compiler gives **warnings** that don't stop anything, such as a clip whose
material keeps clashing with the key, uneven beats, or stretching by more than 2×. They appear in
`apricity explain` and in the web app.

## Grammar

For reference, the syntax in EBNF. `WORD` is any run of non-space characters; `NUMBER` a decimal;
`EOL` the end of a line; comments (`# …`) are removed first.

```ebnf
file        = { line } ;
line        = [ statement ] EOL ;
statement   = "tempo" NUMBER
            | "time" INTEGER "/4"
            | "key" key-text
            | "samples" WORD
            | "bars" NUMBER
            | "swing" PERCENT [ "1/" INTEGER ]
            | "humanize" HUMANIZE
            | "seed" INTEGER
            | "apricity" NUMBER
            | "clip" NAME "=" WORD [ SAVED ] { clip-option }
            | "kit" NAME "=" "slice" NAME slice-by
            | "kit" NAME EOL { INDENT pad EOL }
            | "chords" chord-seq
            | "track" SOUND { track-option } EOL { INDENT track-line EOL }
            | "group" NAME [ "volume" NUMBER ] [ "group" NAME ] EOL { INDENT effect EOL }
            | "return" NAME [ "volume" NUMBER ] EOL { INDENT effect EOL }
            | "master" EOL { INDENT ( effect | "loudness" LUFS ) EOL } ;

HUMANIZE    = ( NUMBER "ms" [ PERCENT ] ) | ( PERCENT [ NUMBER "ms" ] ) ;
SAVED       = NAME ;                        (* a saved clip, e.g. loop-1; any word but an option *)
slice-by    = "by" ( "beats" NUMBER | "bars" NUMBER | "transients" | "phrases" ) | "into" INTEGER ;
pad         = NAME "=" ( NAME [ SAVED | "beats" RANGE | "seconds" RANGE ] | NAME "." INTEGER ) ;
SOUND       = NAME | NAME "." INTEGER | NAME "." NAME ;   (* clip or kit · sliced kit's pad · drum kit's pad *)
clip-option = "beats" RANGE | "seconds" RANGE | "pick" DURATION
            | "root" NOTE | "ratio" NUMBER | "warp" ( "beats" | "complex" | "texture" | "repitch" )
            | "speed" NUMBER [ "x" ] ;
track-option = "as" NAME | "follow" | "transpose" ( "auto" | "follow" | INTEGER )
            | "role" ( "any" | "chord" | "root" | "third" | "fifth" | "seventh" )
            | "loop" | "every" DURATION | "at" POSITION { POSITION } | "steps" QUOTED
            | "grid" INTEGER | "swing" PERCENT [ "1/" INTEGER ] | "half" | "double" | "speed" NUMBER
            | "velocity" INTEGER | "humanize" HUMANIZE | "seed" INTEGER
            | "reverse" | "filter" ( "lp" | "hp" ) NUMBER | "gate" PERCENT | "stutter" INTEGER
            | "bars" BARS | "volume" NUMBER | "group" NAME ;

track-line  = effect | "pan" NUMBER | "send" NAME LEVEL { NAME LEVEL } ;
effect      = "eq" { "lowcut" HZ | "highcut" HZ | "low" GAIN-AT | "high" GAIN-AT
                   | "peak" GAIN-AT [ "q" NUMBER ] }
            | "comp" RATIO DB { ( "attack" | "release" ) TIME | ( "knee" | "makeup" ) DB }
            | "limit" DB [ "release" TIME ]
            | "reverb" { "room" | "hall" | "plate" | SECONDS | "predelay" TIME
                       | ( "damp" | "mix" ) SHARE }
            | "delay" ( NOTE-VALUE | TIME ) { "feedback" SHARE | ( "hp" | "lp" ) HZ
                                          | "pingpong" | "mix" SHARE } ;

chord-seq   = { item | "|" } ;
item        = atom [ "*" NUMBER ] ;
atom        = CHORD | "." | "%" | "[" chord-seq "]" | "(" chord-seq ")" ;

RANGE       = NUMBER ".." NUMBER ;          (* 32..48 *)
DURATION    = NUMBER ( "bar" | "bars" | "beat" | "beats" ) ;
POSITION    = INTEGER [ ":" NUMBER ] ;      (* bar, or bar:beat *)
BARS        = INTEGER [ "-" INTEGER ] ;     (* 5 or 5-12 *)
NAME        = { letter | digit | "-" | "_" } ;
QUOTED      = '"' { any character but '"' } '"' ;       (* a step pattern *)
PERCENT     = NUMBER [ "%" ] ;
DB          = NUMBER "dB" ;                 (* -18dB, +3dB *)
HZ          = NUMBER [ "Hz" | "k" | "kHz" ] ;  (* 120, 6k *)
GAIN-AT     = NUMBER [ "dB" ] "@" HZ ;      (* -3@250 *)
TIME        = NUMBER ( "ms" | "s" ) ;
SECONDS     = NUMBER "s" ;
SHARE       = NUMBER "%" ;
LEVEL       = SHARE | DB ;
RATIO       = NUMBER ":1" ;
LUFS        = NUMBER "LUFS" ;
NOTE-VALUE  = "1/" INTEGER [ "." | "t" ] | NUMBER ( "beat" | "beats" ) ;
key-text    = the rest of the line, e.g. "Abm" or "F mixolydian"   (* see chords.md#keys *)
NOTE        = a note name, e.g. C, F#, Bb, E♭                      (* see chords.md#notes *)
CHORD       = a roman numeral or chord symbol, e.g. iv, V7/V, Dbm7  (* see chords.md *)
```

Inside a `chords` line, brackets and `|` may touch the chords around them: `[ii V]`, `(I IV)*2` and
`I|IV` all work.
