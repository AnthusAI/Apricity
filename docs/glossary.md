# Glossary

Words that mean something specific in Apricity. Musical terms are explained as Apricity uses them.

Terms marked *(planned)* belong to the curation loop, which is designed but not built yet.

### Analysis

The one-time listening pass over a clip that produces its [manifest](#manifest).
See [Concepts: Clips and analysis](concepts.md#clips-and-analysis).

### Arrangement

A fully rendered loop of the whole piece: each track's [event](#event)s placed in time and run through its [effects](#effect), plus the [buses](#bus). The [mixer](#mixer) plays arrangements and swaps in new ones.

### Audition

Playing part of a clip as-is in the Library, to hear it before using it.

### Bar

A group of [beats](#beat), set by the [meter](#meter). Bars are counted from 1 in scores
(`bars 5-12`, `at 3`).

### Beat

One pulse of the music. The score's beats are [score beats](#score-beat); a clip's own
are [clip beats](#clip-beat).

### Beat grid

A clip's detected beats and downbeats, from which its [warp markers](#warp-marker)
are made. [Stems](#stem) use their parent recording's grid.

### Beat ratio

How many [clip beats](#clip-beat) make one [score beat](#score-beat). Fixes beat
trackers that locked onto double or half time. Chosen automatically (½, 1 or 2) unless set with
`ratio` / `beat_ratio`.

### BPM

Beats per minute: a score's `tempo`, or a clip's detected tempo.

### Break

A drums-forward span of a recording: the classic raw material of hip-hop. On a drums [stem](#stem), automatic markup's best [loops](#loop) are breaks.

### Bus

A shared channel that tracks feed: either a **return** that holds a shared [reverb](#reverb) or [delay](#delay) (tracks [send](#send) to it), or a **group** that whole tracks play through (`out beat`) so they're processed together. Written `bus <name>` with its effects on indented lines. See [Language: Buses and sends](language.md#buses-and-sends).

### Camelot code

A DJ notation for keys (C major = 8B, A minor = 8A); neighbors on the wheel mix
well. Shown in the Library.

### Candidate

*(planned)* A slice proposed by an analyzer or an AI agent, with its evidence (why it might be good) and who proposed it, waiting for a person's [verdict](#verdict).

### Chop

A piece cut from a clip's region to be re-sequenced. Chops belong to a [chopped kit](#kit) and are numbered from 1 (`b.1`, `b.2`, …); a single chop can be played like any clip.

### Chord

A set of notes sounding together, named by a [roman numeral](#roman-numeral) or a
[chord symbol](#chord-symbol). See [Chords and keys](chords.md).

### Chord symbol

A chord written by its root note and type: `Dbm`, `Eb7`, `Bbmaj7`.

### Chord tone

A note that belongs to the current chord: its root, third, fifth (and seventh).

### Chroma

How strongly each of the 12 [pitch classes](#pitch-class) sounds, measured per beat and
over whole passages. It's what the [harmony solver](#harmony-solver) reads. Also called a pitch-class
profile.

### Clash

Sound that falls outside the score's key after transposition. More than a quarter of a
clip's sound clashing produces a warning.

### Clip

One audio file (a recording, an excerpt or a [stem](#stem)) with its manifest. In a score,
a named [region](#region) of one.

### Clip beat

A beat number in a clip's own analysis. 0 is the clip's first downbeat; pickups are
negative. `beats 32..48` counts in clip beats.

### Compile

Turning a score into a [timeline](#timeline): checking everything, choosing regions,
solving harmony, laying out events.

### Compressor

An [effect](#effect) that turns loud moments down, evening out a sound or giving it punch: `comp 4:1 -18dB`. The ratio says how hard; the threshold, where it starts.

### Coverage

How completely the tracks, together, supply every note of a chord (0–100%). Shown on
the chord strip and in `explain`.

### Crate

*(planned)* A curated collection of slices and clips, as in "digging in the crates"; it can be a saved search.

### Crossfade

The 5 ms blend when a new [arrangement](#arrangement) replaces the old one at a bar
line, so there's no click.

### Delay

An echo [effect](#effect), usually on a [bus](#bus): `delay 1/8. feedback 35% pingpong`. Times in note values follow the tempo.

### Demucs

The model that separates recordings into [stems](#stem).

### Downbeat

The first beat of a bar.

### Drum kit

A [kit](#kit) of named [pads](#pad) gathered from anywhere (a kick from one recording, a snare from another). Played with [steps](#steps).

### Effect

One step of sound shaping, written as an indented line under a track, bus or the [master](#master) and applied in the order written: `eq`, `comp`, `limit`, `reverb`, `delay`. Not to be confused with a [flip](#flip), which changes each trigger.

### EQ

An [effect](#effect) that turns frequency ranges up or down: cuts (`lowcut 120`), shelves (`low -3@250`) and peaks (`peak -4@800 q1.4`).

### Event

One piece of one [trigger](#trigger) of a track: a stretch of source audio, where it goes in the piece,
and how it's warped, transposed, retuned and leveled. Triggers are split into events where the chord
changes.

### Explain

`apricity explain`, or "How it was solved" in the web app: the compiler's account of every
choice.

### Fader

A track's or bus's level control: its [gain](#gain). It comes after the track's [effects](#effect) and before its [pan](#pan) and [sends](#send). In `apricity play` it can be moved live (`gain horns -6`).

### Feed

*(planned)* The queue of [candidates](#candidate) waiting for a person's [verdict](#verdict).

### Flip

Any transformation that turns a sample into something new: transposed, chopped and re-sequenced, reversed, filtered, half-timed, swung. The art of sampling is in the flip.

### Follow

The [transpose](#transpose) mode that moves a clip with the chord root, the way a riff or
bass line is played on I, IV and V.

### Gain

A track's level in dB relative to the other tracks (after [level matching](#level-match)): its [fader](#fader). Buses have a gain too.

### Gate

A [flip](#flip) that cuts each trigger short to a fraction of its length (`gate 50%`).

### Grid

The step size of a [step pattern](#steps), as a note value: 16 is sixteenth notes (the default), 8 eighths, 4 beats.

### Group

A [bus](#bus) that whole tracks play through instead of the [master](#master) (`out beat`), so they can be compressed together.

### Harmony solver

The part of the compiler that chooses transpositions for `auto` tracks so that
together they sound each chord. See [Concepts](concepts.md#transposition-and-the-harmony-solver).

### Hit

A single accent in a recording, meant to be triggered on its own: a band stab, a drum hit (also called a one-shot or stab). [Automatic markup](#markup) finds them (`hit-1` slices and `hit` markers), and `chop … by hits` cuts at them. Not to be confused with a [trigger](#trigger), one time a track sounds.

### Key

The score's home key: a tonic and a [mode](#mode). Roman numerals are read in it; notes
outside its scale [clash](#clash).

### Key over time

A clip's key measured section by section (marches usually move to a new key for
the [trio](#trio)).

### Kit

A set of short sounds meant to be triggered, like a sampler's pads: a **chopped kit** (one clip cut into numbered [chops](#chop)) or a [drum kit](#drum-kit) (named [pads](#pad)). Kits share names with clips.

### Level match

Bringing every track's region to a common loudness before its [gain](#gain).

### Limiter

An [effect](#effect) that keeps the sound from ever going over a ceiling: `limit -1dB`. The [master](#master) always ends in one.

### Loop

Two senses: a span of a recording that repeats cleanly end to start ([automatic markup](#markup) finds them as `loop-1`, `loop-2`, …, best first), and the default [pattern](#pattern) that repeats a track's sound back to back.

### Loudness

How loud a mix sounds over time, measured in LUFS. The [master](#master) turns the whole mix up or down to meet a target (`loudness -14LUFS`; default −16), so every score comes out equally loud. Compare [level match](#level-match), which evens out tracks before mixing.

### Manifest

The `<file>.apricity.json` next to each audio file: everything [analysis](#analysis)
found, plus your [annotations](#slice).

### Marker

A named point in a clip, saved in its manifest.

### Markup

Automatic markup: after analysis, Apricity marks each clip's [sections](#section), [loops](#loop) and [hits](#hit) as slices and markers, tagged as machine-made. It never touches your own annotations. See [Concepts](concepts.md#automatic-markup).

### Master

The last [effect](#effect) chain, for the whole mix, ending in a [limiter](#limiter) and a [loudness](#loudness) target. Written `master` with indented lines.

### Meter

Beats per bar (`meter 4`).

### Mixer

1. **The engine's real-time part**: plays the current [arrangement](#arrangement), runs the [master](#master) chain, applies live mutes, solos and fader moves, and swaps in new arrangements at bar lines. It never allocates memory on the audio thread.
2. **The mix in a score**: [effects](#effect), [pan](#pan), [sends](#send), [buses](#bus) and the master. See [Concepts: Mixing](concepts.md#mixing).

### Mode

The scale a key uses: major, minor, dorian, mixolydian and so on.

### Pad

One named sound in a [drum kit](#drum-kit) (`kick`, `snare`): a region of a clip, or a [chop](#chop). Played as `drums.kick`, or by name in a step pattern.

### Pan

Where a track sits between the left and right speakers: `pan -20`, from −100 (left) to 100 (right).

### Pattern

When a track plays: `loop`, `every <length>` or `at <positions>`.

### Pick

Letting the compiler choose a clip's [region](#region): the window of a given length that
fits the chords, has steady beats, holds one harmony and is actually playing.

### Pitch class

A note regardless of octave: all Cs are one pitch class. There are 12.

### Progression

The score's chords, in order, each with a length in bars.

### Rating

*(planned)* Optional 1–5 stars on material that was kept, alongside tags and a name.

### Region

The part of a clip a score plays, chosen by `beats`, `seconds`, `slice` or `pick`.

### Render

Warping and transposing events into audio. Apricity renders ahead, caches the results and
mixes them live.

### Retune

Correcting a clip to A = 440 Hz using its measured [tuning](#tuning).

### Reverb

An [effect](#effect) that puts sound in a space: `reverb plate 1.8s`, in a room, hall or plate. Usually on a [bus](#bus) that tracks [send](#send) to. Its tail wraps around the loop seamlessly.

### Reverse

A [flip](#flip) that plays each trigger backwards.

### Role

A hint for where a clip's root should land in each chord: `root`, `third`, `fifth`,
`seventh`, `chord` or `any`.

### Roman numeral

A chord named by its place in the key (`I`, `IV`, `V7`, `iv`). Uppercase is major,
lowercase minor. See [Chords and keys](chords.md#roman-numerals).

### Root

The note a chord is built on; also, for a clip region, the note it's built on (detected,
or set with `root`).

### Score

A description of a piece: tempo, key, clips, progression and tracks, written in the
[Apricity language](language.md) or [YAML](yaml.md).

### Score beat

A beat of the score's grid (`tempo` of them per minute).

### Section

A structural part of a recording (a march's strain, trio or breakstrain). [Automatic markup](#markup) names them `sec-A1`, `sec-B1`, … (repeats share a letter), plus `trio` and `intro`.

### Send

A copy of a track, after its fader and pan, sent to a [bus](#bus) at some level: `send room 25%`.

### Slice

A named region of a clip, made in the Library and saved in its manifest; used with
`slice <name>`.

### Solver

See [harmony solver](#harmony-solver).

### Source

A recording as it arrived, with its provenance and rights. Every [clip](#clip) comes from a source (directly, or as a [stem](#stem)).

### Speed

A [flip](#flip) that plays a sound faster or slower against the beat without changing its pitch: `half` (0.5), `double` (2) or `speed <x>` (0.125–8).

### Steadiness

How even a clip's beats are (100% is metronomic). Uneven beats warp poorly.

### Stem

One instrument group separated from a recording: drums, bass, other or vocals.

### Steps

A step pattern: a row of steps, one symbol each (a chop number, a pad name, `x` for the track's own sound, `.` for silence, `_` to hold), like a drum machine's sequencer. See [the language](language.md#step-patterns).

### Stretch

How much a clip's tempo is changed to fit the score (1.0× is none). Above 2× either way
is flagged.

### Stutter

A [flip](#flip) that replays the start of each trigger several times within it (`stutter 4`).

### Swap

Replacing the playing [arrangement](#arrangement) with a newly rendered one, at the next
bar line.

### Swing

Delaying every other step for a loose, human feel (`swing 58`). 50 is straight, 56–62 the classic sampler range, 66 a triplet feel.

### Timeline

The compiled score: every [event](#event), the tempo map and the harmony choices.

### Track

One clip playing in a score, with its [pattern](#pattern), [transpose](#transpose) mode,
[role](#role), bars and [gain](#gain).

### Transpose

Moving a clip up or down in pitch. A track's mode is `auto` (the solver chooses per
chord), `follow` (with the chord root) or a fixed number of semitones.

### Trigger

One time a track sounds: every repeat of a `loop`, every restart of `every`, each position of `at`, each sounding step of `steps`. [Flips](#flip) like `reverse` and `gate` act on every trigger, and a trigger that crosses a chord change is split into [events](#event). Not to be confused with a [hit](#hit), an accent in a recording.

### Trio

In a march, the contrasting section, usually in a new key a fourth higher.

### Tuning

Where a recording's A sits relative to 440 Hz, in hertz and cents.

### Verdict

*(planned)* A person's quick decision on a [candidate](#candidate): keep, skip or later. Verdicts teach the ranking of future candidates.

### Warp

Stretching a clip so its beats land on the score's beats, without changing its pitch.

### Warp marker

A pin from a moment in the recording to a clip beat number. Warping moves every
marker onto its score beat.

### Warp mode

How a clip is stretched: `complex` (general), `beats` (drums) or `texture` (pads).
