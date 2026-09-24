# The Apricitus language

`.apr` files are Apricitus's compact way to write a score. Everything here has a YAML equivalent
([YAML scores](yaml.md)); both compile to the same thing, and `apricitus fmt` converts between them.
For what the words mean musically, see [Concepts](concepts.md).

- [A complete example](#a-complete-example)
- [How a file is read](#how-a-file-is-read)
- [Statements](#statements) — `tempo` `meter` `key` `samples` `bars` `apricitus` `clip` `kit` `chords` `track` `bus` `master`
- [Clip options](#clip-options)
- [Kits](#kits)
- [Chord lines](#chord-lines)
- [Track options](#track-options)
- [Step patterns](#step-patterns)
- [Mixing](#mixing) — effects, pan, sends, buses, the master
- [Mistakes and messages](#mistakes-and-messages)
- [Grammar](#grammar)

## A complete example

```apr
# March Blues — a 12-bar blues in F from a Sousa march split into stems.
tempo 100                 # beats per minute
key F mixolydian          # home key; roman numerals are read in it
samples ../samples        # clip paths are relative to this folder

clip groove = marine-band/stems/WashingtonPost/drums.wav   pick 2bars  warp beats
clip tuba   = marine-band/stems/WashingtonPost/bass.wav    pick 1bar
clip horns  = marine-band/stems/WashingtonPost/other.wav   pick 1bar
clip bugle  = citizen-dj/loc-jukebox-popular/Army-bugle-calls_jukebox-118367_001_00-00-56.wav  pick 1bar

# chorus 1: quick change in bar 2, turnaround in bar 12
chords I7 IV7 I7 .  | IV7 . I7 .  | V7 IV7 I7 V7
# chorus 2
chords I7 IV7 I7 .  | IV7 . I7 .  | V7 IV7 I7 .

track groove  transpose 0  gain -3        # drums don't follow the chords
track tuba    follow                      # bass moved to each chord's root
track horns   follow  bars 13-24  gain -2 # riff, in parallel on every chord
track bugle   at 15 19 23  gain -5        # call and response
```

## How a file is read

- **One statement per line.** A line starts with a statement word (`tempo`, `clip`, `track`, …); the
  rest of the line is its arguments and options, separated by spaces or tabs.
- **Comments** start with `#` and run to the end of the line.
- **Blank lines** are ignored. Order doesn't matter, except that `chords` lines add up in order and
  `track` lines are numbered in order.
- **Indented lines** belong to the statement above them: the pads of a drum kit (`kit drums` then
  `  kick = …`), and the effects of a track, a bus or the master (`track horns` then `  eq lowcut 120`).
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
| `meter <n>` | | Beats per bar (1–16). | `4` |
| `samples <folder>` | | Folder that clip paths are relative to, itself relative to the score file. | the score's folder |
| `bars <n>` | | Length in bars, for a piece **without** chords. With chords, the chords set the length (and a `bars` that disagrees is an error). | |
| `apricitus <version>` | | Format version. Only `0.1` exists. | `0.1` |
| `clip <name> = <path> [options]` | | Defines a clip. See [clip options](#clip-options). | |
| `kit <name> = chop <clip> …` / `kit <name>` + pads | | Defines a kit. See [kits](#kits). | |
| `chords <chords…>` | one of `chords`/`bars` | Adds chords to the progression. See [chord lines](#chord-lines). | |
| `track <sound> [options]` | | Plays a clip, a kit, a chop or a pad. See [track options](#track-options). | |
| `bus <name> [gain <dB>] [out <bus>]` + indented lines | | A shared effect return or a group. See [buses](#buses-and-sends). | |
| `master` + indented lines | | The master chain. See [the master](#the-master). | |

**Clip and kit names** are letters, digits, `-` and `_`, and share one namespace: a kit can't have
the same name as a clip. **Bus names** follow the same rules, can't be `master`, and can't be the
name of a track.

## Clip options

```apr
clip riff = marine-band/stems/Thunderer/other.wav  beats 32..36  root C  warp complex
```

Give at most one of `beats`, `seconds`, `slice` or `pick`. With none, the clip's region is the whole
clip.

| Option | Example | Meaning |
|---|---|---|
| `beats <a>..<b>` | `beats 32..48` | Region from clip beat *a* to *b* (the clip's own beat numbers; 0 is its first downbeat). Must lie inside the clip. |
| `seconds <a>..<b>` | `seconds 12.5..20` | Region by time in the recording. Must lie inside the clip. |
| `slice <name>` | `slice trio` | A slice saved in the clip's manifest (make them in the web app's Library). |
| `pick <duration>` | `pick 2bars` | Let the compiler choose the best region of that length (in score time). See [Concepts: Regions](concepts.md#regions). |
| `root <note>` | `root C` | What the region is built on. Used by `follow` and `role`. Default: the key detected in the region. |
| `ratio <n>` | `ratio 2` | Clip beats per score beat. Default: ½, 1 or 2, whichever stretches least. |
| `warp <mode>` | `warp beats` | `complex` (default), `beats` (drums: crisp attacks) or `texture` (pads). |

## Kits

A kit holds short sounds for triggering. See [Concepts: Kits](concepts.md#kits-chops-and-pads).

**A chopped kit** cuts one clip into numbered chops:

```apr
kit b = chop brk by beats 0.5     # a chop every half beat (any positive number)
kit p = chop brk by bars 1        # a chop every bar
kit e = chop brk into 8           # 8 equal chops
kit h = chop band by hits         # a chop at each marker named `hit`
```

| Form | Chops |
|---|---|
| `by beats <n>` | every *n* score beats across the clip's region |
| `by bars <n>` | every *n* bars |
| `into <n>` | *n* equal pieces (a whole number) |
| `by hits` | one per `hit` marker in the region ([automatic markup](concepts.md#automatic-markup) makes them, or add your own), each lasting until the next hit and at most a bar |

The chops cover the clip's region, so chop a slice of a loop with `clip brk = … slice loop-1` first.
Chops are numbered from 1 in time order; at most 256.

**A drum kit** is `kit <name>` alone on a line, followed by indented pad lines:

```apr
kit drums
  kick  = tdrums  slice hit-1
  snare = pdrums  beats 4..5
  rim   = b.3
```

Each pad line is `<pad> = <clip> [slice <name> | beats <a>..<b> | seconds <a>..<b>]`, or
`<pad> = <kit>.<n>` to use a chop of a chopped kit. Pad names are words (`kick`, `snare-2`), not
numbers. Each pad is level-matched on its own.

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
track horns  as riff  follow  bars 13-24  gain -2
track b      steps "1 _ 2 _ 3 _ 3 4"  swing 58  transpose 0
track h.3    every 1bar  reverse  filter lp 800
```

`track` is followed by what to play:

| Write | Plays | Patterns |
|---|---|---|
| `track horns` | a clip | any |
| `track b` | a whole kit | `steps` only |
| `track b.3` | one chop of a chopped kit | any |
| `track drums.kick` | one pad of a drum kit | any |

A single chop or pad behaves exactly like a clip (`follow`, `role`, `at`, `every` all work).

Then any options:

| Option | Example | Meaning | Default |
|---|---|---|---|
| `as <name>` | `as riff` | Name the track. Needed when the same sound plays on two tracks: names must be unique, because the mixer tells tracks apart by name. | what it plays |
| `follow` | `follow` | Move with the chord root (like a blues riff). Same as `transpose follow`. | |
| `transpose <t>` | `transpose 0`, `transpose -3`, `transpose +5`, `transpose auto` | `auto`: the harmony solver chooses per chord. `follow`: move with the root. A number: always that many semitones. | `auto` |
| `role <r>` | `role third` | Hint for where the clip's root should land: `root`, `third`, `fifth`, `seventh`, `chord` (any chord tone) or `any`. With `follow`, only `root` or `any` make sense. | `any` |
| `loop` | `loop` | Repeat the sound back to back. | ✓ |
| `every <duration>` | `every 1bar` | Restart the sound at that interval; each trigger plays at most that long. | |
| `at <positions…>` | `at 3 7 11`, `at 3:1 3:3` | One trigger at each position: a bar number, or `bar:beat` (both start at 1). Each trigger plays the whole sound. | |
| `steps "<pattern>"` | `steps "1 . 3 ."` | A step sequence. See [step patterns](#step-patterns). | |
| `grid <n>` | `grid 8`, `grid 1/8` | Step size for `steps` as a note value, 1–64: 16 = sixteenths, 8 = eighths, 4 = beats. | `16` |
| `swing <percent>` | `swing 58`, `swing 58%` | Delay every other step: 50 = straight, 56–62 classic, 66 ≈ triplets; 50–75. | `50` |
| `half` / `double` / `speed <x>` | `half`, `speed 0.75` | Play at half, double or any speed against the beat (0.125–8), keeping pitch. | `1` |
| `reverse` | `reverse` | Each trigger plays backwards. | |
| `filter lp <Hz>` / `filter hp <Hz>` | `filter lp 800`, `filter hp 250` | 12 dB/octave low-pass or high-pass filter, 20–20000 Hz. (`lowpass`, `highpass` also work.) | |
| `gate <fraction>` | `gate 50%`, `gate 0.5` | Cut each trigger to that fraction of its length (a number above 1 is read as a percentage). | |
| `stutter <n>` | `stutter 4` | Replay the start of each trigger *n* times within it, 1–64. | |
| `bars <a>-<b>` | `bars 13-24`, `bars 5` | Only play in these bars (1-based, inclusive). | the whole piece |
| `gain <dB>` | `gain -3` | Level relative to the other tracks (every track is level-matched first). | `0` |
| `out <bus>` | `out beat` | Play through a bus (a group) instead of straight into the master. See [buses](#buses-and-sends). | `master` |

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
| a number | that chop (the track plays a chopped kit) |
| a name | that pad (the track plays a drum kit) |
| `x` | the track's own sound (the track plays a clip, one chop or one pad) |
| `.` or `~` | silence for one step |
| `_` | hold the previous sound one more step |
| `[a b …]` | split one step evenly among them; brackets nest |
| `\|` | nothing — just for reading |

Each step is a sixteenth note unless `grid` says otherwise. A trigger lasts its written length (its step
plus any `_` holds) but never longer than the chop or pad itself. The pattern starts at the track's
first bar and repeats to fill its bars. With `swing`, every second step is delayed; notes inside a
split step are not.

## Mixing

The mix is written in the score, as **indented lines** under the thing they shape: a track, a bus or
the master. Effects run **in the order written**.

```apr
track horns  follow
  eq    lowcut 120  low -3@250  high +2dB@6k  peak -4@800 q1.4
  comp  4:1  -18dB  attack 10ms  release 120ms
  pan   30
  send  plate 30%  echo 20%

track drums  steps "kick . snare ."  out beat

bus beat                             # a group: everything with `out beat` is summed and glued
  comp  4:1  -14dB  attack 20ms

bus plate                            # a return: tracks send to it
  eq      lowcut 250
  reverb  plate  1.8s  predelay 20ms  damp 35%

bus echo  gain -4
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

| Line | Under a track | Under a bus | Under `master` |
|---|---|---|---|
| `eq`, `comp`, `limit` | ✓ | ✓ | ✓ |
| `reverb`, `delay` | ✓ (25% wet) | ✓ (all wet) | ✗ put them on a bus |
| `pan` | ✓ | | |
| `send` | ✓ | | |
| `loudness` | | | ✓ |

A track's `gain` is its **fader**; its effects run before it, and `pan` and the sends after it.

### Effects

| Effect | Write | Parameters |
|---|---|---|
| `eq` | `eq lowcut 120 low -3@250 high +2@6k peak -4@800 q1.4 highcut 9k` | `lowcut` / `highcut` Hz (20–20000); `low` / `high` shelves as gain@Hz (±24 dB); `peak` gain@Hz with an optional `q` (0.1–18, default 1), repeatable; up to 8 bands |
| `comp` | `comp 4:1 -18dB attack 10ms release 120ms knee 6dB makeup 3dB` | ratio (1–50) and threshold (−60–0 dB) first, both required; `attack` 0.1–500 ms, `release` 5–3000 ms, `knee` 0–24 dB, `makeup` −12–24 dB |
| `limit` | `limit -1dB release 50ms` | ceiling (−24–0 dB), optional `release` (1–2000 ms); the output never goes over the ceiling |
| `reverb` | `reverb plate 1.8s predelay 20ms damp 35% mix 30%` | `room`, `hall` (default) or `plate`; a decay in seconds (0.1–20; default room 0.8 s, hall 2.4 s, plate 1.6 s); `predelay` 0–500 ms; `damp` and `mix` 0–100% |
| `delay` | `delay 1/8. feedback 35% hp 400 lp 4k pingpong mix 30%` | the time first: a [note value](#units) or `350ms`; `feedback` 0–95%; `hp` / `lp` Hz on the echoes; `pingpong` bounces them left and right; `mix` 0–100% |
| `pan` | `pan -20` | −100 (left) to 100 (right); tracks only |
| `send` | `send plate 30% echo -12dB` | one or more bus + level pairs; tracks only |
| `loudness` | `loudness -14LUFS` | the master's target, −40 to −5 LUFS; master only |

`mix` is the wet share. Under a bus it defaults to 100%, since a return is all effect; under a track
it defaults to 25%. Delays in note values follow the tempo.

### Buses and sends

`bus <name>` starts a bus; its effects go on indented lines below. On the `bus` line itself:

- `gain <dB>` — the bus's fader (−60 to +12).
- `out <bus>` — feed another bus instead of the master. Buses can feed buses, but not in a loop.

A track reaches a bus in one of two ways:

- **`send <bus> <level>`** under the track: a copy of the track, after its fader and pan, goes to the
  bus as well. Levels are a percentage (`25%`) or in dB (`-12dB`). This is how tracks share a reverb
  or an echo.
- **`out <bus>`** on the track line: the whole track goes through the bus instead of to the master.
  This makes a **group**, like drums summed and compressed together.

A track can't send to the bus it already goes out to, and every bus must have something playing
into it.

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

Apricitus reports **every** mistake it can find at once, each with a line and column, and the web editor
underlines them. Some examples:

```
line 3 column 1: unknown statement `trakc` (did you mean `track`?)
line 5 column 9: unknown track option `gian` (did you mean `gain`?)
line 6 column 8: `[` is never closed
line 7 column 8: `.` holds the previous chord, but there isn't one yet
line 12 column 1: track.clip: no clip named "hron" (did you mean "horn"?)
line 9 column 1: clip horn.beats: [0, 99] is outside the clip's beats [0, 32]
line 14 column 1: track.pattern: `b` is a kit; play it with steps "1 . 2 . 3 . 4 ." (or one chop: b.1)
line 15 column 1: track.pattern.steps: uses chop 9, but kit `b` has 4 chops
line 16 column 1: track.pattern.steps: kit `drums` has no pad `snair` (did you mean "snare"?)
line 17 column 1: track.pattern.steps: `1` picks a chop, but `horn` is a single sound; use x (e.g. "x . x ."), or chop it into a kit
line 18 column 1: track.pattern.steps: `x` plays the track's own sound, but this track is the whole kit `drums`; name the pad to play
line 20 column 1: kit `empty` has no pads; list them on indented lines below it, e.g.  kick = drums slice hit-1
line 22 column 14: `-18`: write the threshold in dB, e.g. -18dB
line 23 column 14: `12x` isn't a frequency (e.g. 120, 120Hz, 6k)
line 24 column 10: unknown reverb part `cathedral`: reverb [room|hall|plate] [decay like 2.4s] [predelay 20ms] [damp 50%] [mix 30%] (expected one of: room, hall, plate, predelay, damp, mix)
line 25 column 1: track.sends.rooom: there's no bus `rooom` (did you mean "room"?)
line 25 column 1: track.sends.echo: the track already goes out to `echo`; sending to it too would double it
line 27 column 1: track: tracks 1 and 2 are both named `horn`; name one with `as` (the mixer tells tracks apart by name)
line 30 column 1: bus room: nothing plays into this bus; send a track to it (send room 20%) or route one with out room
line 36 column 3: `reverb` doesn't go on the master; put it on a bus (bus room / reverb hall) and send tracks to it (send room 20%)
line 37 column 3: `pan` doesn't belong here (expected one of: eq, comp, limit, loudness)
line 38 column 12: `-14`: write loudness in LUFS, e.g. -14LUFS
buses: `echo`, `loop2` feed each other in a loop; one of them must go out to master
```

Beyond mistakes, the compiler gives **warnings** that don't stop anything, such as a clip whose
material keeps clashing with the key, uneven beats, or stretching by more than 2×. They appear in
`apricitus explain` and in the web app.

## Grammar

For reference, the syntax in EBNF. `WORD` is any run of non-space characters; `NUMBER` a decimal;
`EOL` the end of a line; comments (`# …`) are removed first.

```ebnf
file        = { line } ;
line        = [ statement ] EOL ;
statement   = "tempo" NUMBER
            | "meter" NUMBER
            | "key" key-text
            | "samples" WORD
            | "bars" NUMBER
            | "apricitus" NUMBER
            | "clip" NAME "=" WORD { clip-option }
            | "kit" NAME "=" "chop" NAME chop
            | "kit" NAME EOL { INDENT pad EOL }
            | "chords" chord-seq
            | "track" SOUND { track-option } EOL { INDENT track-line EOL }
            | "bus" NAME [ "gain" NUMBER ] [ "out" NAME ] EOL { INDENT effect EOL }
            | "master" EOL { INDENT ( effect | "loudness" LUFS ) EOL } ;

chop        = "by" ( "beats" NUMBER | "bars" NUMBER | "hits" ) | "into" INTEGER ;
pad         = NAME "=" ( NAME [ "slice" NAME | "beats" RANGE | "seconds" RANGE ] | NAME "." INTEGER ) ;
SOUND       = NAME | NAME "." INTEGER | NAME "." NAME ;   (* clip or kit · chop · pad *)
clip-option = "beats" RANGE | "seconds" RANGE | "slice" NAME | "pick" DURATION
            | "root" NOTE | "ratio" NUMBER | "warp" ( "beats" | "complex" | "texture" ) ;
track-option = "as" NAME | "follow" | "transpose" ( "auto" | "follow" | INTEGER )
            | "role" ( "any" | "chord" | "root" | "third" | "fifth" | "seventh" )
            | "loop" | "every" DURATION | "at" POSITION { POSITION } | "steps" QUOTED
            | "grid" INTEGER | "swing" PERCENT | "half" | "double" | "speed" NUMBER
            | "reverse" | "filter" ( "lp" | "hp" ) NUMBER | "gate" PERCENT | "stutter" INTEGER
            | "bars" BARS | "gain" NUMBER | "out" NAME ;

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
