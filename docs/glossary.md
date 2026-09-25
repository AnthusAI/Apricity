# Glossary

Words that mean something specific in Apricity. Musical terms are explained as Apricity uses them.

Apricity uses a DAW's words wherever it can; see [Coming from Live](concepts.md#coming-from-live). Terms marked *(in progress)* belong to the curation loop, which is partly built.

### Analysis

The one-time listening pass over a [sample](#sample) that produces its [manifest](#manifest). See [Concepts: Samples and analysis](concepts.md#samples-and-analysis).

### Arrangement

A fully rendered loop of the whole piece: each track's [events](#event) placed in time and run through its [effects](#effect), plus the [group](#group-track) and [return tracks](#return-track). The [mixer](#mixer) plays arrangements and swaps in new ones.

### Audition

Playing part of a clip as-is in the Library, to hear it before using it.

### Bar

A group of [beats](#beat), set by the [time signature](#time-signature). Bars are counted from 1 in scores
(`bars 5-12`, `at 3`).

### Beat

One pulse of the music. The score's beats are [score beats](#score-beat); a clip's own
are [sample beats](#sample-beat).

### Beat grid

A clip's detected beats and downbeats, from which its [warp markers](#warp-marker)
are made. [Stems](#stem) use their parent recording's grid.

### Beat ratio

How many [sample beats](#sample-beat) make one [score beat](#score-beat). Fixes beat
trackers that locked onto double or half time. Chosen automatically (½, 1 or 2) unless set with
`ratio` / `beat_ratio`.

### BPM

Beats per minute: a score's `tempo`, or a clip's detected tempo.

### Break

A drums-forward span of a recording: the classic raw material of hip-hop. On a drums [stem](#stem), automatic markup's best [loops](#loop) are breaks.

### Camelot code

A DJ notation for keys (C major = 8B, A minor = 8A); neighbors on the wheel mix
well. Shown in the Library.

### Candidate

*(in progress)* A clip proposed by an analyzer or an AI agent, with its evidence (why it might be good) and who proposed it, waiting for a person's [verdict](#verdict).

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

A named region of a [sample](#sample), with its warp settings, as in Live. Clips are **saved with the sample** (yours from the Library, or [automatic markup](#markup)'s: `sec-A1`, `loop-1`, `shot-3`) or **defined in a score**: `clip brk = drums.wav loop-1` uses the sample's saved clip `loop-1`; `beats`, `seconds` or `pick` choose another part. See [Concepts: Clips](concepts.md#clips).

### Collection

*(in progress)* A named set of kept clips, in Live's sense of a browser collection; it can be a saved search.

### Compile

Turning a score into a [timeline](#timeline): checking everything, choosing each clip's part, solving harmony, laying out events.

### Compressor

An [effect](#effect) that turns loud moments down, evening out a sound or giving it punch: `comp 4:1 -18dB`. The ratio says how hard; the threshold, where it starts.

### Coverage

How completely the tracks, together, supply every note of a chord (0–100%). Shown on
the chord strip and in `explain`.

### Crossfade

The 5 ms blend when a new [arrangement](#arrangement) replaces the old one at a bar
line, so there's no click.

### Delay

An echo [effect](#effect), usually on a [return track](#return-track): `delay 1/8. feedback 35% pingpong`. Times in note values follow the tempo.

### Demucs

The model that separates recordings into [stems](#stem).

### Detune

Correcting a clip to A = 440 Hz using its measured [tuning](#tuning), in cents. Apricity does it for every clip.

### Downbeat

The first beat of a bar.

### Drum kit

A [kit](#kit) of named [pads](#pad) gathered from anywhere (a kick from one recording, a snare from another), like Live's Drum Rack. Played with [steps](#steps).

### Effect

One step of sound shaping, written as an indented line under a track, a [group](#group-track) or [return track](#return-track), or the [master](#master) and applied in the order written: `eq`, `comp`, `limit`, `reverb`, `delay`. Not to be confused with a [flip](#flip), which changes each trigger.

### EQ

An [effect](#effect) that turns frequency ranges up or down: cuts (`lowcut 120`), shelves (`low -3@250`) and peaks (`peak -4@800 q1.4`).

### Event

One piece of one [note](#note) of a track: a stretch of the sample, where it goes in the piece, and how it's warped, transposed, detuned and leveled. Notes are split into events where the chord changes.

### Explain

`apricity explain`, or "How it was solved" in the web app: the compiler's account of every
choice.

### Fader

A track's level control, its [volume](#volume) in dB, as are a group's and a return's. It comes after the track's [effects](#effect) and before its [pan](#pan) and [sends](#send). In `apricity play` it can be moved live (`volume horns -6`).

### Feed

*(in progress)* The queue of [candidates](#candidate) waiting for a person's [verdict](#verdict).

### Flip

Any transformation that turns a sample into something new: transposed, sliced and re-sequenced, reversed, filtered, half-timed, swung. The art of sampling is in the flip.

### Follow

The [transpose](#transpose) mode that moves a clip with the chord root, the way a riff or
bass line is played on I, IV and V.

### Gate

A [flip](#flip) that cuts each note short to a fraction of its length (`gate 50%`).

### Grid

The step size of a [step pattern](#steps), as a note value: 16 is sixteenth notes (the default), 8 eighths, 4 beats.

### Group track

Tracks summed and processed together, as in Live: `group beat` defines one (its effects on indented lines), and `group beat` on a track line puts the track in it. Groups can sit inside groups.

### Harmony solver

The part of the compiler that chooses transpositions for `auto` tracks so that
together they sound each chord. See [Concepts](concepts.md#transposition-and-the-harmony-solver).

### Humanize

Small differences in timing and velocity from note to note, as a player makes (`humanize 12ms 20%`). The same score always plays the same take; `seed` picks another. See [groove](language.md#groove).

### Key

The score's home key: a tonic and a [mode](#mode). Roman numerals are read in it; notes
outside its scale [clash](#clash).

### Key over time

A clip's key measured section by section (marches usually move to a new key for
the [trio](#trio)).

### Kit

A set of [pads](#pad) to play from a step pattern, like Live's Drum Rack: a **sliced kit** (one clip cut into numbered [slices](#slice), one per pad) or a [drum kit](#drum-kit) (named pads). Kits share names with clips.

### Level match

Bringing every track's clip to a common loudness before its [volume](#volume).

### Limiter

An [effect](#effect) that keeps the sound from ever going over a ceiling: `limit -1dB`. The [master](#master) always ends in one.

### Loop

Two senses: a span of a sample that repeats cleanly end to start ([automatic markup](#markup) saves them as clips `loop-1`, `loop-2`, …, best first), and the default [pattern](#pattern) that repeats a track's sound back to back.

### Loudness

How loud a mix sounds over time, measured in LUFS. The [master](#master) turns the whole mix up or down to meet a target (`loudness -14LUFS`; default −16), so every score comes out equally loud. Compare [level match](#level-match), which evens out tracks before mixing.

### Manifest

The `<file>.apricity.json` next to each sample: everything [analysis](#analysis) found, plus the clips and markers saved with it.

### Marker

A named point in a clip, saved in its manifest.

### Markup

Automatic markup: after analysis, Apricity saves each sample's [sections](#section), [loops](#loop) and [one-shots](#one-shot) as clips, and its [transients](#transient) as markers, tagged as machine-made. It never touches your own. See [Concepts](concepts.md#automatic-markup).

### Master

The last [effect](#effect) chain, for the whole mix, ending in a [limiter](#limiter) and a [loudness](#loudness) target. Written `master` with indented lines.

### Mixer

1. **The engine's real-time part**: plays the current [arrangement](#arrangement), runs the [master](#master) chain, applies live mutes, solos and fader moves, and swaps in new arrangements at bar lines. It never allocates memory on the audio thread.
2. **The mix in a score**: [effects](#effect), [volume](#volume), [pan](#pan), [sends](#send), [group](#group-track) and [return tracks](#return-track), and the master. See [Concepts: Mixing](concepts.md#mixing).

### Mode

The scale a key uses: major, minor, dorian, mixolydian and so on.

### Note

One time a track sounds, as a MIDI note plays a pad in Live: every repeat of a `loop`, every restart of `every`, each position of `at`, each sounding step of `steps`. [Flips](#flip) like `reverse` and `gate` act on every note, and a note that crosses a chord change is split into [events](#event). (What Basic Pitch hears in a sample is its [transcription](#transcription).)

### One-shot

A single accent saved as a clip, meant to be played on its own: a band stab, a drum hit. [Automatic markup](#markup) saves them as `shot-1`, `shot-2`, …, each with a [transient](#transient) marker.

### Pad

A [kit](#kit)'s slot. In a sliced kit pads are numbered and each holds a [slice](#slice) (`b.3`); in a [drum kit](#drum-kit) they're named and hold a clip or another kit's slice (`drums.kick`). A track can play one pad, and a step pattern calls them by number or name.

### Pan

Where a track sits between the left and right speakers: `pan -20`, from −100 (left) to 100 (right).

### Pattern

When a track plays: `loop`, `every <length>` or `at <positions>`.

### Pick

Letting the compiler choose which part of a sample a clip plays: the window of a given length that fits the chords, has steady beats, holds one harmony and is actually playing.

### Pitch class

A note regardless of octave: all Cs are one pitch class. There are 12.

### Progression

The score's chords, in order, each with a length in bars.

### Rating

*(in progress)* Optional 1–5 stars on material that was kept, alongside tags and a name.

### Recording

A performance as it arrived, with its provenance and rights. Every [sample](#sample) comes from a recording (as the whole of it, an excerpt, or a [stem](#stem)).

### Render

Warping and transposing events into audio. Apricity renders ahead, caches the results and
mixes them live.

### Return track

A shared effect, such as one reverb for everything, as in Live: `return room` defines one (its effects on indented lines), and tracks reach it with a [send](#send). It plays into the [master](#master).

### Reverb

An [effect](#effect) that puts sound in a space: `reverb plate 1.8s`, in a room, hall or plate. Usually on a [return track](#return-track) that tracks [send](#send) to. Its tail wraps around the loop seamlessly.

### Reverse

A [flip](#flip) that plays each note backwards.

### Role

A hint for where a clip's root should land in each chord: `root`, `third`, `fifth`,
`seventh`, `chord` or `any`.

### Roman numeral

A chord named by its place in the key (`I`, `IV`, `V7`, `iv`). Uppercase is major,
lowercase minor. See [Chords and keys](chords.md#roman-numerals).

### Root

The note a chord is built on; also, for a clip, the note it's built on (detected, or set with `root`).

### Sample

An audio file in the library, analyzed once, as in Live: a whole recording, an excerpt, or a [stem](#stem). Scores play parts of samples through [clips](#clip).

### Sample beat

A beat number in a sample's own analysis. 0 is its first downbeat; pickups are negative. `beats 32..48` counts in sample beats.

### Score

A description of a piece: tempo, key, clips, kits, progression, tracks and the mix, written in the [Apricity language](language.md) or [YAML](yaml.md). Live would call it a Set.

### Score beat

A beat of the score's grid (`tempo` of them per minute).

### Section

A structural part of a sample (a march's strain, trio or breakstrain). [Automatic markup](#markup) saves them as clips `sec-A1`, `sec-B1`, … (repeats share a letter), plus `trio` and `intro`.

### Send

A copy of a track, after its volume and pan, sent to a [return track](#return-track) at some level: `send room 25%`.

### Slice

One of the pieces a [kit](#kit) cuts a clip into, as in Live's Simpler Slice mode and Slice to New MIDI Track: `kit b = slice brk by beats 0.5` (or `by bars`, `into 8`, `by transients`, `by phrases`). Slices are numbered from 1 and each sits on a [pad](#pad) (`b.1`, `b.2`, …).

### Solver

See [harmony solver](#harmony-solver).

### Speed

A [flip](#flip) that plays a sound faster or slower against the beat without changing its pitch: `half` (0.5), `double` (2) or `speed <x>` (0.125–8).

### Steadiness

How even a clip's beats are (100% is metronomic). Uneven beats warp poorly.

### Stem

One instrument group separated from a recording by Demucs: drums, bass, other or vocals. Each stem is a [sample](#sample).

### Steps

A step pattern: a row of steps, one symbol each (a pad number or name, `x` for the track's own sound, `.` for silence, `_` to hold), like a drum machine's sequencer. See [the language](language.md#step-patterns).

### Stretch

How much a clip's tempo is changed to fit the score (1.0× is none). Above 2× either way
is flagged.

### Stutter

A [flip](#flip) that replays the start of each note several times within it (`stutter 4`).

### Swap

Replacing the playing [arrangement](#arrangement) with a newly rendered one, at the next
bar line.

### Swing

Delaying every other step for a loose, human feel (`swing 58`). 50 is straight, 56–62 the classic sampler range, 66 a triplet feel. `swing 58 1/8` swings the eighths under sixteenth steps; a `swing` line on its own sets it for every step track. See [groove](language.md#groove).

### Time signature

Beats per bar, written like `time 4/4` (only x/4 for now).

### Timeline

The compiled score: every [event](#event), the tempo map and the harmony choices.

### Track

Plays a clip, a whole kit, or one pad in a score, with its [pattern](#pattern), [transpose](#transpose) mode, [role](#role), bars and [volume](#volume).

### Transcription

The notes Basic Pitch hears in a sample, saved in its manifest (not used by the compiler yet).

### Transient

An onset worth cutting at, as in Live's transient markers. [Automatic markup](#markup) marks them, and `slice … by transients` cuts a clip at each.

### Transpose

Moving a clip up or down in pitch. A track's mode is `auto` (the solver chooses per
chord), `follow` (with the chord root) or a fixed number of semitones.

### Trio

In a march, the contrasting section, usually in a new key a fourth higher.

### Tuning

Where a recording's A sits relative to 440 Hz, in hertz and cents.

### Velocity

How hard a note is played, 1–127 as in Live (`snare@40`, `kick!` for 127, `velocity 90` for a track). 100 plays a pad at its matched level; the others change it by 40·log₁₀(velocity / 100) dB. See [groove](language.md#groove).

### Verdict

*(in progress)* A person's quick decision on a [candidate](#candidate): keep, skip or later. Verdicts teach the ranking of future candidates.

### Volume

A track's [fader](#fader), in dB relative to the other tracks (after [level matching](#level-match)): `volume -3`. Group and return tracks have one too.

### Warp

Stretching a clip so its beats land on the score's beats, without changing its pitch.

### Warp marker

A pin from a moment in the recording to a clip beat number. Warping moves every
marker onto its score beat.

### Warp mode

How a clip is stretched, as in Live: `complex` (general), `beats` (drums), `texture` (pads), or `repitch` (not stretched: played at a speed that moves its pitch, like a record).
