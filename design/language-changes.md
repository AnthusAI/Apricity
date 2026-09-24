# Language changes: chopping, looping and drum kits (2026-09-23)

A roadmap for documenting what's new in the Apricitus language. Each item names where the truth
lives; the tests show every rule in action. Both notations (`.apr` text and YAML) support everything.

## Where to look

| What | File |
|---|---|
| Score model (YAML field names, defaults) | `crates/apricitus-score/src/score.rs` — `KitSpec`, `PadSpec`, `Chop`, `FilterSpec`, `TrackSpec`, `Pattern::Steps`, `parse_steps` |
| Text language (`.apr`) syntax and error messages | `crates/apricitus-score/src/dsl.rs` — `parse`, `format`, tests at the bottom |
| What it all *means* (timing, chops, levels, errors) | `crates/apricitus-score/src/compile.rs` — kits section, "tracks → hits", events |
| Worked examples of every rule | `crates/apricitus-score/tests/compile.rs` — tests named `chop_kits_*`, `swing_*`, `chop_refs_*`, `kits_chopped_at_hits`, `drum_kits_*`, `kit_mistakes_are_explained` |
| Filters and reverse (sound) | `crates/apricitus-engine/src/render.rs` — `biquad`, end of `render_event` |
| Concepts and vocabulary (chop, kit, pad, flip, …) | `design/framework.md` |

## 1. Kits (new statement)

Two kinds, sharing one namespace with clips:

**Chopped kit**: one clip cut into numbered chops (`k.1`, `k.2`, …).
```
kit k = chop br by beats 1      # every beat      (also: by bars 2)
kit k = chop br into 8          # 8 equal pieces
kit k = chop br by hits         # at the clip's hit markers (automatic markup or yours)
```
YAML: `kits: { k: { clip: br, chop: { beats: 1 } } }` · `{ bars: 2 }` · `{ into: 8 }` · `chop: hits`.
Chops cover the clip's region (its `beats` / `slice` / `pick`). Hit chops last until the next hit,
at most a bar. At most 256 chops.

**Drum kit**: named pads gathered from anywhere, as an indented block:
```
kit drums
  kick  = thunderer-drums  slice hit-2
  snare = post-drums       beats 4..5
  rim   = k.3                            # a pad can be another kit's chop
```
YAML: `kits: { drums: { pads: { kick: { clip: thunderer-drums, slice: hit-2 }, rim: { clip: k.3 } } } }`.
Pad options: `slice`, `beats a..b`, `seconds a..b`. Each pad is level-matched on its own, so a kick
from one recording and a snare from another sit together.

## 2. What a track can play

`track <name>` now accepts: a clip · a whole kit · one chop (`k.3`) · one pad (`drums.kick`).
A single chop or pad behaves like a clip (`loop`, `every`, `at`, `follow`, `role`… all work).
A whole kit must be played with `steps`.

## 3. `steps`: step sequencing (new pattern)

```
track k             steps "1 . 3 . [5 5] . 7 _"
track drums         steps "kick . snare ."
track drums.kick    steps "x . . . x . . . x . . . x . x ."
```
- one symbol per step; the grid defaults to sixteenth notes (`grid 16`); `grid 8`, `grid 4` = eighths, beats
- a number = that chop (chopped kits) · a name = that pad (drum kits) · `x` = the track's own sound
  (when the track is a single clip, chop or pad)
- `.` or `~` = silence · `_` = hold the previous sound one more step · `[a b]` = split one step
  evenly (nests) · `|` = just for reading
- a hit lasts its written length (step plus holds), never longer than the chop or pad itself
- the pattern repeats to fill the track's bars
- YAML: `pattern: { steps: "1 . 3 ." }`, plus `grid: 8`

## 4. Track transforms (new track options)

| `.apr` | YAML | Meaning |
|---|---|---|
| `swing 56` (or `56%`) | `swing: 56` | delays every other step; 50 = straight, 56–62 classic sampler feel; 50–75 |
| `reverse` | `reverse: true` | each hit plays backwards |
| `filter lp 800` / `filter hp 200` | `filter: {lowpass: 800}` / `{highpass: 200}` | 12 dB/octave filter, 20–20000 Hz |
| `gate 50%` (or `0.5`) | `gate: 0.5` | shortens each hit to that fraction |
| `stutter 4` | `stutter: 4` | retriggers the start of each hit 4 times within it (1–64) |
| `half` / `double` / `speed 0.75` | `speed: 0.5` | half-time / double-time / any speed 0.125–8 |
| `grid 8` | `grid: 8` | step size for `steps` |

## 5. Text-language details

- Quoted strings: `steps "…"` (a `#` inside quotes is not a comment).
- `apricitus fmt` converts all of the above between `.apr` and YAML both ways; round-trips are tested.
- New keywords: `kit chop by into hits steps grid swing reverse filter lp hp gate stutter half double speed`
  (the editor's syntax highlighting will want these).

## 6. Errors people will see (all with line/column in `.apr`)

- `kit \`drums\` has no pad \`snair\`` (with "did you mean")
- `uses chop 9, but kit \`k\` has 4 chops`
- `\`k\` is a kit; play it with steps "1 . 2 . 3 . 4 ." (or one chop: k.1)`
- `\`x\` plays the track's own sound, but this track is the whole kit \`drums\`; name the pad to play`
- `\`1\` picks a chop, but \`horn\` is a single sound; use x (e.g. "x . x ."), or chop it into a kit`
- `kit \`empty\` has no pads; list them on indented lines below it`
- `a kit is either \`clip\` + \`chop\` (a chopped clip) or \`pads\` (a drum kit), not both or neither`
- range errors for swing, gate, speed, stutter, grid, filter frequency

## 7. Mixing: track effects, pan and the master (Stage 1 of `design/mixer.md`)

Effects are **indented lines under a track**, applied in the order written; the `master` block is
the final chain for the whole mix. Units are required (a bare number where a unit belongs is an error).

```
track horns  follow  steps "1 . . 3 . . 2 ."
  eq    lowcut 120  low -3@250  high +2dB@6k  peak -4@800 q1.4  highcut 9k
  comp  4:1  -18dB  attack 10ms  release 120ms  knee 6dB  makeup 3dB
  pan   -20                    # −100 (left) … 100 (right)

master
  eq       lowcut 30
  comp     2:1  -12dB  attack 30ms  release 200ms
  limit    -1dB                # optional release 50ms
  loudness -14LUFS             # default −16
```

| Effect | Parameters | Notes |
|---|---|---|
| `eq` | `lowcut Hz`, `highcut Hz`, `low dB@Hz` (shelf), `high dB@Hz` (shelf), `peak dB@Hz qN` (repeatable) | up to 8 bands; `k` for kHz (`6k`, `1.5k`) |
| `comp` | `RATIO:1` and `THRESHOLDdB` (both required), `attack`, `release` (`ms` or `s`), `knee dB`, `makeup dB` | feed-forward, stereo-linked, soft knee |
| `limit` | ceiling `dB`, `release` | look-ahead; the output never exceeds the ceiling |
| `pan` | −100…100 | track only |
| `loudness` | `LUFS` target | master only; −40…−5 |

YAML: `effects: [ {eq: {lowcut: 120, low: [-3, 250], high: [2, 6000], peaks: [[-4, 800, 1.4]]}},
{comp: {ratio: 4, threshold: -18, attack_ms: 10, release_ms: 120}} ]`, `pan: -20` on a track;
`master: { effects: [ {limit: {ceiling: -1}} ], loudness: -14 }` at the top level.

What it does (for the concepts page):
- Each track becomes its own **stem**; its effects run on the whole stem, and the loop is processed
  twice around so a compressor at the loop's start behaves as it does mid-loop.
- `gain` is the track's **fader**; `pan` uses a balance law (centre = unchanged level).
- The **master** always ends in a limiter (−1 dB if you don't write one) and is turned up or down
  to hit the loudness target. This replaces the old "loudest sample at −1 dB" normalization, so
  quiet and busy scores now come out equally loud.
- **Live mixing** in `apricitus play`: type `mute horns`, `unmute horns`, `solo 2`, `unsolo 2`,
  `gain bass -6`, `reset`, `tracks` (a name or a number). Heard within one audio block; it
  survives re-renders when you save the score. Not in the browser yet.
- `apricitus render` now reports the mix's loudness, peak and the master's make-up gain.

Errors: `` `-18`: write the threshold in dB, e.g. -18dB``, `` `12x` isn't a frequency (e.g. 120, 120Hz, 6k)``,
`` `pan` doesn't belong here`` (in `master`), `` `loudness` doesn't belong here`` (under a track),
`` `-14`: write loudness in LUFS, e.g. -14LUFS``, and range checks on every parameter. Keywords for syntax highlighting: `master eq lowcut highcut low high
peak comp attack release knee makeup limit pan loudness` and the units `dB Hz k ms s LUFS`.

Example: `examples/chop-shop-mixed.apr` (the same beat as `chop-shop.apr`, mixed; render both to compare).
Engine truth: `crates/apricitus-engine/src/master.rs`; syntax: `dsl.rs` (`effect_line`, test
`mix_blocks`); validation: `compile.rs` (`check_effects`).

## 8. Buses, sends, reverb and delay (Stage 2 of `design/mixer.md`)

```
track horns  follow
  send  plate 30%  echo 20%          # post-fader sends; a level is a % or dB (-12dB)
track brk    steps "1 _ 2 _"  out beat   # a group: the track plays through bus `beat`

bus beat                             # a group bus: glue the drums together
  comp  4:1  -14dB  attack 20ms

bus plate  out beat                  # `bus NAME [gain dB] [out BUS]`; out defaults to master
  eq      lowcut 250
  reverb  plate  1.8s  predelay 20ms  damp 35%

bus echo  gain -4
  delay  1/8.  feedback 35%  hp 400  lp 4k  pingpong
```

| Effect | Parameters | Notes |
|---|---|---|
| `reverb` | `room`/`hall`/`plate` (default hall), decay `2.4s`, `predelay 20ms`, `damp 50%`, `mix 30%` | defaults per type: room 0.8 s, hall 2.4 s, plate 1.6 s |
| `delay` | time first: `1/8`, `1/8.` (dotted), `1/4t` (triplet), `3beats`, or `350ms`; `feedback 35%`, `hp 300`, `lp 5k`, `pingpong`, `mix 30%` | a quarter note is one beat; tempo changes re-time it |

- `mix` is the wet share. On a bus it defaults to 100% (a return is all wet); as a track insert it
  defaults to 25%. Reverb and delay work as track inserts too, but the usual way is a bus + sends.
- Sends are post-fader and post-pan. `out` sends the whole track into a bus instead of the master.
- Buses can go out to other buses; loops are an error. Reverb/delay aren't allowed in `master`.
- **Loops are seamless**: reverb and echo tails from the end of the loop ring into its start.
- **Live mixing** (`apricitus play`): buses can be muted, soloed and faded like tracks (`mute plate`).
  Changing a track that feeds a bus re-mixes the buses and lands in a fraction of a second; tracks
  and buses going straight to the master change instantly. Soloing a track keeps its reverb.
- YAML: on a track, `out: beat`, `sends: {plate: 0.3, echo: 0.2}`; at the top level,
  `buses: { plate: { effects: [ {reverb: {type: plate, decay_s: 1.8, predelay_ms: 20, damp: 0.35}} ], gain: -4, out: beat } }`;
  `{delay: {beats: 0.75, feedback: 0.35, highpass: 400, lowpass: 4000, pingpong: true, mix: 0.3}}` (or `ms: 350`).
- Errors: ``there's no bus `rooom` (did you mean "room"?)``, `nothing plays into this bus`,
  ``buses: `echo`, `loop2` feed each other in a loop; one of them must go out to master``, ``the track already goes out to `echo` ``,
  ``a track is also named `horn` ``, ``tracks 1 and 3 are both named `horn`; name one with `as` ``
  (new: track names must be unique, since the mixer addresses them by name),
  `reverb doesn't go on the master …; put it on a bus`, ``unknown reverb part `cathedral` ``, range checks.
- New keywords for highlighting: `bus out send reverb room hall plate predelay damp mix delay
  feedback hp lp pingpong`; note values `1/8 1/8. 1/4t`, units `beats`.
- Truth: `dsl.rs` (test `buses_sends_and_space_effects`), `compile.rs` (`route`, tests
  `routing_*`), `engine/src/mix.rs`, `dsp/src/space.rs`.

## 9. Voice layer: unwarped clips, varispeed, cues in seconds, phrases

```
clip voice = voice/announcer.wav  warp off              # plays as recorded
clip quick = voice/announcer.wav  warp off  speed 1.5x  # like a record at 1.5×: faster and higher
kit  words = chop voice by phrases                      # words.1, words.2, … one per spoken phrase

track voice    at 1:3                  # bar 1, beat 3
track quick    at 12.5s                # or seconds from the start
track words.4  at 13  stutter 4
track words    steps "4 . 5 . | 6 _ _ _"  grid 4
```

- **`warp off`** (clip option; YAML `warp: off`): the clip isn't fitted to the beat grid. It keeps its
  own timing and pitch, is never transposed by the harmony, and gets no tuning correction. It still
  sits on the grid wherever you cue it. Use it for speech, sound effects, field recordings, free-time
  music, or anything whose beats analysis couldn't find (such clips now say: "no beat grid was
  detected …; add `warp off` to play it as recorded").
- **`speed 1.5`** (or `1.5x`, `2x`, `0.75`; 0.25–4; only with `warp off`) is varispeed: faster also
  means higher, like a turntable. On a warped clip `speed` is an error pointing to the track's
  `half` / `double` / `speed`, which change how a warped clip sits on the grid.
- **Cues** (`at`) take bars (`5`), bar:beat with fractions (`3:2.5`), or seconds (`12.5s`), mixed freely.
- **Phrases**: automatic markup (`apricitus-analyze`) finds the pauses in speech and marks
  `phrase-1`, `phrase-2`, … slices. `chop CLIP by phrases` (YAML `chop: phrases`) makes a kit of
  them, played with `steps`, `at`, or one phrase (`words.3`). Works on free-time music too.
- **The piece grows to hold a long voice**: when an unwarped clip cued with `at` runs past the
  chords, the piece lengthens to whole bars and the chord progression repeats underneath (with a
  warning). Setting `bars` yourself turns this off.
- Level matching works for unwarped clips too (analysis now writes a beat-free loudness curve).
- `explain` lists unwarped tracks as "seconds a–b, unwarped, plays as recorded at N× (not in the
  harmony)" and leaves them out of the chord tables.
- Errors: `speed is for unwarped clips (warp off) …`, `` `pick` needs the clip's own beats, but it
  plays unwarped …``, ``transpose: `line` plays unwarped (as recorded), so it isn't transposed; to
  change its pitch use the clip's speed …``, ``has no phrases marked in its region; run automatic
  markup …``, `"-3s": seconds count from the start …`, speed range.
- New keywords: `off` (after `warp`), `speed` (clip option), `phrases` (after `chop … by`), and the
  `s` suffix on `at` positions.
- Truth: `compile.rs` (tests `unwarped_speech_*`, `varispeed_seconds_cues_and_phrases`,
  `voice_layer_mistakes_are_explained`), `manifest.rs` `unwarp`, `dsl.rs` test `voice_layer_syntax`,
  `engine/src/render.rs` (the `WarpModeSpec::Off` branch), `analysis/apricitus_analyze/markup.py` `phrases`.

## 10. Character effects and ducking (Stage 3 of `design/mixer.md`)

```
track brk  steps "1 _ 2 _"  out music
  lofi       12bit  26k  wow 15%          # bits, sample-and-hold rate, tape wobble (any of them)
track horns  follow  out music
  drive      8dB  tone 7k                 # saturation; level is kept, tone = low-pass after
track voice  at 1:3
  noisegate  -50dB  hold 30ms  release 100ms  range -60dB   # also attack
  width      80%                          # 0% mono … 100% as is … 200% twice as wide

bus music                                  # duck the music under the voice
  comp  4:1  -34dB  attack 5ms  release 300ms  sidechain voice

master
  width  110%                             # the master allows eq, comp, limit, width
```

| Effect | Parameters | Notes |
|---|---|---|
| `drive` | amount `dB` (0–36), `tone Hz` | 2× oversampled soft clipping with a little asymmetry (even harmonics); output level matched to input |
| `lofi` | `12bit` (2–16), rate `26k` (1k–48k), `wow 20%` | at least one; wow is a slow pitch wobble synced to the loop |
| `noisegate` | threshold `dB` (required), `attack`, `hold`, `release` (ms/s), `range dB` | defaults 1 ms, 30 ms, 100 ms, −80 dB |
| `width` | `%` 0–200 | mid/side; allowed on the master too |
| `comp … sidechain NAME` | a **track** name | the comp listens to that track instead of its input |

- YAML: `{drive: {db: 8, tone: 7000}}`, `{lofi: {bits: 12, rate: 26000, wow: 0.15}}`,
  `{noisegate: {threshold: -50, attack_ms: 1, hold_ms: 30, release_ms: 100, range: -60}}`,
  `{width: 1.4}` (a number: 1 = unchanged), `{comp: {ratio: 4, threshold: -34, sidechain: voice}}`.
- Ducking in practice: route the music to a bus with `out music` and put the sidechain comp on the
  bus. A track can also be ducked directly (`track bass` + `comp … sidechain drums.kick`).
- The key is the named track's own sound (after its effects, before its fader); live mute of the
  key doesn't un-duck until the next render.
- `apricitus explain` now ends with a **Mix** section: each track and bus, where it goes, pan and
  sends, and its chain written as in the score. `apricitus render` prints each stem's loudness and
  peak and how many dB each compressor took off.
- New warning: ``drums.kick: its region is nearly silent (level matching needs +30 dB); check the
  region or slice, it may have missed the sound``.
- Errors: ``sidechain `bee`: there's no track by that name (did you mean "b"?)``, ``(a bus can't
  key a sidechain; key it from one of its tracks)``, `a comp can't be keyed by its own track`,
  `` `a` is ducked by a track that is (in turn) ducked by it``, `the master can't duck (it plays
  live); route the music to a bus …`, `lofi doesn't go on the master`, `lofi needs something to do`,
  ranges.
- New keywords: `drive tone lofi bit wow noisegate hold range width sidechain`.
- Truth: `dsl.rs` test `character_effects_and_sidechain`, `compile.rs` test
  `sidechain_mistakes_are_explained`, `engine/src/mix.rs` test `a_bus_ducks_under_a_voice`,
  `dsp/src/color.rs`.

## Coming next (not built yet)

Automation (filter sweeps and fades over bars), convolution reverb, the curation feed.
