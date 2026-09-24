# YAML scores

A score can also be written as YAML (`.yaml`) — handy when a program generates scores, or when you
want every field spelled out. YAML scores and [`.apr` scores](language.md) are two spellings of
the same structure: they compile identically, and `apricitus fmt` converts either way. JSON works too
(it's valid YAML) from the command line.

Unknown fields are errors — a typo like `gian: 3` is reported, never silently ignored.

## The same score both ways

```apr
tempo 100
key F mixolydian
samples ../samples

clip tuba  = marine-band/stems/WashingtonPost/bass.wav   pick 1bar
clip horns = marine-band/stems/WashingtonPost/other.wav  beats 32..36  root C

chords I7 IV7 I7 . | V7 IV7 I7 V7

track tuba   follow
track horns  as riff  follow  bars 5-8  gain -2
track horns  as stabs  at 3 7:3  gain -5
```

```yaml
apricitus: 0.1
tempo: 100
key: F mixolydian
samples: ../samples

clips:
  tuba:  { source: marine-band/stems/WashingtonPost/bass.wav, pick: 1bar }
  horns: { source: marine-band/stems/WashingtonPost/other.wav, beats: [32, 36], root: C }

progression:
  - { chord: I7,  bars: 1 }
  - { chord: IV7, bars: 1 }
  - { chord: I7,  bars: 2 }
  - { chord: V7,  bars: 1 }
  - { chord: IV7, bars: 1 }
  - { chord: I7,  bars: 1 }
  - { chord: V7,  bars: 1 }

tracks:
  - { clip: tuba, transpose: follow }
  - { clip: horns, name: riff, transpose: follow, bars: "5-8", gain: -2 }
  - { clip: horns, name: stabs, pattern: { at: [3, "7:3"] }, gain: -5 }
```

## Top level

| Field | Type | Required | Meaning | `.apr` |
|---|---|---|---|---|
| `apricitus` | number | **yes** | Format version; must be `0.1`. | `apricitus 0.1` (optional there) |
| `tempo` | number | **yes** | Beats per minute, 20–400. | `tempo` |
| `key` | text | **yes** | Home key, e.g. `Abm`, `F mixolydian`. See [keys](chords.md#keys). | `key` |
| `meter` | whole number | | Beats per bar, 1–16. Default `4`. | `meter` |
| `samples` | text | | Folder clip paths are relative to (relative to the score file). | `samples` |
| `clips` | map of name → [clip](#clips) | **yes** | The clips, by name. | `clip` lines |
| `kits` | map of name → [kit](#kits) | | Chopped kits and drum kits. Names are shared with clips. | `kit` lines |
| `progression` | list of [chords](#progression) | one of these two | The chords in order. Sets the piece's length. | `chords` lines |
| `bars` | whole number | | Length in bars for a piece without a progression. | `bars` |
| `tracks` | list of [tracks](#tracks) | **yes** | What plays. | `track` lines |
| `buses` | map of name → [bus](#mixing) | | Effect returns and groups. | `bus` blocks |
| `master` | [master](#mixing) | | The master chain and loudness target. | `master` block |

## Clips

```yaml
clips:
  horns: { source: marine-band/stems/Thunderer/other.wav, beats: [32, 36], root: C, warp: complex }
```

| Field | Type | Meaning | `.apr` |
|---|---|---|---|
| `source` | text (**required**) | Audio path, relative to `samples`. | the path after `=` |
| `beats` | `[from, to]` | Region in the clip's own beats. | `beats 32..36` |
| `seconds` | `[from, to]` | Region in seconds. | `seconds 12.5..20` |
| `slice` | text | A named slice from the clip's manifest. | `slice trio` |
| `pick` | duration text | Let the compiler choose a region this long (`2bars`). | `pick 2bars` |
| `root` | note | What the region is built on. | `root C` |
| `beat_ratio` | number | Clip beats per score beat. Default: ½, 1 or 2, whichever stretches least. | `ratio 2` |
| `warp` | `complex` · `beats` · `texture` | Warp mode. Default `complex`. | `warp beats` |

At most one of `beats`, `seconds`, `slice`, `pick`.

## Kits

A kit is either a chopped clip (`clip` + `chop`) or a drum kit (`pads`) — never both. Writing both, or neither, is an error: "a kit is either `clip` + `chop` (a chopped clip) or `pads` (a drum kit), not both or neither".

```yaml
kits:
  b:     { clip: brk, chop: { beats: 0.5 } }       # also { bars: 1 }, { into: 8 }, or "hits"
  h:     { clip: band, chop: hits }
  drums:
    pads:
      kick:  { clip: tdrums, slice: hit-1 }
      snare: { clip: pdrums, beats: [4, 5] }
      rim:   { clip: b.3 }                         # a chop of a chopped kit
```

| Field | Type | Meaning | `.apr` |
|---|---|---|---|
| `clip` | clip name | The clip to chop (its region: `beats`/`seconds`/`slice`/`pick`). | `chop brk` |
| `chop` | `{beats: n}` · `{bars: n}` · `{into: n}` · `hits` | How to cut it. | `by beats 0.5`, `by bars 1`, `into 8`, `by hits` |
| `pads` | map of pad name → pad | A drum kit's pads. | indented `kick = …` lines |

A pad is `{ clip: <clip>, slice | beats | seconds }` (at most one region option), or
`{ clip: <kit>.<n> }` for a chop of a chopped kit.

## Progression

Each entry is one chord and how long it lasts:

```yaml
progression:
  - { chord: ii, bars: 0.5 }
  - { chord: V7, bars: 0.5 }
  - { chord: I,  bars: 2 }
```

| Field | Type | Meaning |
|---|---|---|
| `chord` | text (**required**) | A roman numeral or chord symbol. See [Chords and keys](chords.md). |
| `bars` | number > 0 (**required**) | How long, in bars. Fractions are fine. |

The text language's `.`, `*n`, `[ ]` and `( )*n` are shorthands for exactly this list.

## Tracks

```yaml
tracks:
  - { clip: horns, name: riff, transpose: follow, bars: "13-24", gain: -2 }
  - { clip: b, pattern: { steps: "1 _ 2 _ 3 _ 3 4" }, swing: 58, transpose: 0 }
  - { clip: h.3, pattern: { every: 1bar }, reverse: true, filter: { lowpass: 800 } }
  - { clip: bugle, pattern: { at: [15, 19, 23] }, gain: -5 }
```

| Field | Type | Meaning | `.apr` |
|---|---|---|---|
| `clip` | text (**required**) | What to play: a clip, a kit, a chop (`b.3`) or a pad (`drums.kick`). A whole kit needs a `steps` pattern. | `track horns` |
| `name` | text | Track name (must be unique; defaults to what it plays). | `as riff` |
| `transpose` | `auto` · `follow` · whole number | How to transpose per chord. Default `auto`. | `follow`, `transpose -3` |
| `role` | `any` · `chord` · `root` · `third` · `fifth` · `seventh` | Where the clip's root should land. Default `any`. | `role third` |
| `pattern` | `loop` · `{ every: <duration> }` · `{ at: [positions] }` · `{ steps: "<pattern>" }` | When it plays. Default `loop`. | `loop`, `every 1bar`, `at 3 7:2`, `steps "1 . 3 ."` |
| `grid` | whole number, 1–64 | Step size for `steps` as a note value. Default `16`. | `grid 8` |
| `swing` | number, 50–75 | Delay every other step. Default `50` (straight). | `swing 58` |
| `speed` | number, 0.125–8 | Playback speed against the beat. | `half` (0.5), `double` (2), `speed 0.75` |
| `reverse` | `true` · `false` | Each trigger plays backwards. | `reverse` |
| `filter` | `{lowpass: Hz}` · `{highpass: Hz}` | 12 dB/octave filter, 20–20000 Hz. | `filter lp 800` |
| `gate` | number, above 0 and up to 1 | Cut each trigger to this fraction. | `gate 50%` |
| `stutter` | whole number, 1–64 | Replay each trigger's start this many times. | `stutter 4` |
| `bars` | `"a-b"` or a bar number | Only in these bars (1-based, inclusive). | `bars 13-24` |
| `gain` | number (dB) | Level relative to the other tracks: the track's fader. Default `0`. | `gain -2` |
| `effects` | list of [effects](#mixing) | The track's effects, in order. | indented `eq`, `comp`, … lines |
| `pan` | number, −100…100 | Stereo position, left to right. | indented `pan -20` |
| `sends` | map of bus → share (0–1) | Copies to buses, after the fader and pan. | indented `send room 25%` |
| `out` | bus name | Play through this bus instead of the master. | `out beat` |

Positions in `at` are bar numbers (`15`) or `"bar:beat"` text (`"7:3"`), both counted from 1. Step
patterns use the same symbols as in the text language ([step patterns](language.md#step-patterns)).

## Mixing

```yaml
tracks:
  - clip: horns
    transpose: follow
    effects:
      - eq: { lowcut: 120, low: [-3, 250], high: [2, 6000], peaks: [[-4, 800, 1.4]] }
      - comp: { ratio: 4, threshold: -18, attack_ms: 10, release_ms: 120 }
    pan: 30
    sends: { plate: 0.3, echo: 0.2 }
  - { clip: drums, pattern: { steps: "kick . snare ." }, out: beat }
buses:
  beat:  { effects: [ { comp: { ratio: 4, threshold: -14, attack_ms: 20 } } ] }
  plate: { effects: [ { eq: { lowcut: 250 } }, { reverb: { type: plate, decay_s: 1.8, predelay_ms: 20, damp: 0.35 } } ] }
  echo:  { gain: -4, effects: [ { delay: { beats: 0.75, feedback: 0.35, highpass: 400, lowpass: 4000, pingpong: true } } ] }
master:
  effects: [ { eq: { lowcut: 30 } }, { limit: { ceiling: -1 } } ]
  loudness: -14
```

Each effect is a map with one key, its kind. Numbers are plain: dB, Hz, milliseconds, seconds and
shares from 0 to 1 (so `35%` is `0.35`). For what each does and its ranges, see
[mixing](language.md#mixing).

| Effect | Fields |
|---|---|
| `eq` | `lowcut`, `highcut` (Hz); `low`, `high` (`[dB, Hz]` shelves); `peaks` (list of `[dB, Hz, q]`) |
| `comp` | `ratio` and `threshold` (dB), both required; `attack_ms`, `release_ms`, `knee`, `makeup` |
| `limit` | `ceiling` (dB), required; `release_ms` |
| `reverb` | `type` (`room` · `hall` · `plate`, default `hall`); `decay_s`, `predelay_ms`, `damp`, `mix` |
| `delay` | `beats` (a quarter note is 1, so a dotted eighth is 0.75) or `ms`; `feedback`, `highpass`, `lowpass`, `pingpong`, `mix` |

A **bus** has `effects`, `gain` (dB, default 0) and `out` (another bus; default the master). The
**master** has `effects` and `loudness` (LUFS, default −16). `reverb` and `delay` aren't allowed on
the master, and `pan` is a track field, not an effect.

## Converting

```sh
apricitus fmt examples/march-blues.yaml           # prints it as .apr
apricitus fmt examples/march-blues.apr            # prints it as YAML
apricitus fmt score.yaml --to apr -o score.apr    # write to a file
```

`apricitus fmt` keeps the meaning exactly but not your comments or layout: the YAML output lists every
chord separately, and the `.apr` output writes one line per four bars of chords. The
`examples/` folder keeps both spellings of each example side by side, and a test checks they agree.
