# Effects and the mixer (design draft, 2026-09-23)

> **Vocabulary update (2026-09-24):** the words below predate the move to Ableton Live's vocabulary. `chop` is now `slice`, a manifest "slice" is now a saved **clip**, `bus` is now `group`/`return`, `gain` is now `volume`, `meter` is now `time`, and hits are now transients and one-shots. See `design/vocabulary.md` and `docs/`.

Status: decided 2026-09-23 (see Decisions); building in stages. **Stage 1 built** (2026-09-23):
per-track stems, `eq`/`comp`/`pan` inserts, master `eq`/`comp`/`limit`/`loudness` running live, and
live fader/mute/solo (engine + `apricity play`). Demo: `examples/chop-shop-mixed.apr`.

Stage 1 as built:
- `crates/apricity-dsp/src/fx.rs`: biquads/EQ, compressor, look-ahead limiter, balance pan law,
  BS.1770 loudness.
- `crates/apricity-engine/src/master.rs`: effect chains (fixed 8 slots, retuned in place, no
  allocation), `apply_inserts` (offline, two loop cycles so the loop start is settled),
  `loudness_gain` (measured with the limiter bypassed, refined once through the full chain; ±24 dB).
- `crates/apricity-engine/src/arrangement.rs`: an arrangement is now stems (one per track, after
  its inserts, before fader and pan) plus master settings; `bounce()` is the finished mix,
  `bounce_raw()` the stems summed without the master.
- `crates/apricity-engine/src/mixer.rs`: `Controller::set_track(name, TrackControl{gain, mute,
  solo})`; controls follow track names across re-renders; the master chain runs on the audio thread.
- Browser: render workers get whole tracks when a track has effects; the worklet sums raw parts,
  one worker measures the master make-up (`rw_master_gain`, too slow for the audio thread), and the
  worklet plays it through the live master (`rw_engine_load_mastered`). No live per-track faders in
  the browser yet (the worklet only has the summed mix); that needs per-track parts.
- The default loudness target is −16 LUFS, and the master always ends in a limiter (−1 dB if the
  score gives none), replacing the old peak normalization.

**Stage 2 built** (2026-09-24): buses (`bus NAME`, `gain`, `out`), groups (`out BUS` on a track),
post-fader sends (`send room 25%`), `reverb` (room/hall/plate), tempo-synced `delay` (note values,
ping-pong, filtered feedback), and seamless loop tails. Demo: `examples/chop-shop-mixed.apr`.
- `crates/apricity-dsp/src/space.rs`: FDN reverb (8 lines, Householder feedback, damping,
  predelay, input diffusion; RT60 within 2% of the setting, unity wet energy, decorrelated L/R)
  and the delay.
- `crates/apricity-engine/src/master.rs` `process_chain`: offline chains render as many loop
  cycles as the tails need (≥ 2, ≤ 90 s of audio) and keep the last, so a tail from the loop's end
  rings into its start exactly as in steady looping (tested against a 40-cycle reference).
- `crates/apricity-engine/src/mix.rs`: the mix graph. Tracks to the master stay live stems; buses
  to the master become live stems too (with `solo_safe`, since what reaches them already follows
  solo); grouped tracks, sends and bus→bus routes are baked. A live change to anything baked makes
  the control thread re-mix the buses (`Renderer::remix`, 130–230 ms for a 22 s loop) and swap it in.
- Solo: soloing a track keeps its sends' returns (without the other tracks); soloing a bus keeps
  what feeds it.
- Browser: every track feeding a bus renders in one worker (which renders the buses).
- Reverb and delay aren't allowed on the master (it runs live); the error says to use a bus.

**Voice layer built** (2026-09-24, asked for by the user): `warp off` clips, varispeed `speed`,
cues in seconds, speech phrases, and a piece that grows to hold a long voice. Demo:
`examples/voice-layer.apr` (the voice is `samples/voice/announcer.wav`, made with macOS `say`).
- An unwarped clip gets an even beat grid at tempo ÷ speed (`Clip::unwarp`), so every existing
  primitive (regions, slices, chops, steps, `at`, hit lengths) works unchanged, and "warping" it
  onto the score's grid is exactly varispeed. The renderer plays it by band-limited resampling
  (`apricity-dsp/src/resample.rs`), not Rubber Band; a render correlates 0.98 with the original.
- Unwarped tracks sit out of the harmony solver (never transposed, no retune), and their hits are
  single events (no seams at chord changes).
- Analysis: `rhythm.loudness` (RMS per half second, no beat grid needed) level-matches unwarped
  clips; markup finds `phrase-N` slices between pauses (≥ 0.25 s), for speech and free-time audio.

**Stage 3 built** (2026-09-24): `sidechain` on `comp` (ducking), `drive`, `lofi`, `noisegate`,
`width`, the `explain` Mix section, and a per-stem report from `apricity render`.
- `apricity-dsp/src/color.rs`: drive = 2× oversampled (half-band, loop-wrapping) asymmetric tanh,
  level-matched afterwards; lofi = loop-synced wow (whole wobbles per loop), sample-and-hold, bit
  reduction; noise gate with hold and a dB-linear attack/release; mid/side width.
- Sidechain keys are other *tracks* (their stem after their own effects, before fader). Tracks are
  processed in key order; ducking loops are errors. A bus can duck too (the usual way: route the
  music to a bus, key it from the voice). The master can't (it runs live); `width` can.
- Live controls don't change a key (muting the voice live doesn't un-duck the music until the
  next render). The browser keeps each ducked track and its key in one render worker.
- The report found a real bug on its first run: automatic markup placed hits in silent passages
  (relative onset strength in near-silence) and snapped them to the beat. Hits now must be within
  20 dB of the clip's playing level and start at their onset; the compiler warns when a region needs
  more than +24 dB of level matching.

Later: automation (filter sweeps over bars), convolution reverb with public-domain impulse
responses, chorus, tape stop / turntable effects, a sidechain filter (duck only on the kick's lows).

## Goals

- Every sound-shaping decision lives in the score, in the language, so a mix is as declarative,
  diffable, explainable and agent-writable as the notes.
- Sampling-culture defaults: the effects producers actually reach for (EQ, compression, sidechain
  ducking, filters, saturation, lo-fi sampler character, delay, reverb), not a DAW's everything.
- Keep the real-time path simple and safe, as now: heavy processing happens while rendering ahead.
- Mix-only edits (a fader, an EQ band) should land at the next bar in well under a second.

## Signal flow

```
events ──▶ track lane ──▶ inserts (in order) ──▶ fader + pan ──┬──▶ out: master (or a group bus)
(warped,     (sum of the                                       │
 pitched)     track's hits)                                    └──▶ sends ──▶ bus: inserts ──▶ master
                                                                             (reverb, delay)
master: inserts (EQ, glue compression, limiter) ──▶ loudness target ──▶ loop ──▶ speakers
```

- **Track**: its hits summed into one lane, then its insert chain in the order written, then fader
  (the existing `gain`) and pan.
- **Send**: a copy of the track (post-fader by default) to a **bus**.
- **Bus**: a shared effect return (a reverb everyone sends to) or a **group** (drums summed and
  compressed together: `out drums`). Buses can feed buses; cycles are an error.
- **Master**: the final chain, then a loudness target (e.g. −14 LUFS) instead of today's peak
  normalization.
- **Sidechain**: a compressor keyed from another track or bus (the kick ducking the bass or
  horns), the classic pumping sound of sample-based music.

## Language (`.apr`)

Effects are indented lines under the thing they belong to, one per line, applied in the order
written. This is the same block shape as drum kits: readable, easy to diff, easy for agents to edit.

```
track horns  follow  steps "1 . . 3 . . 2 ."
  eq       lowcut 120  low -3@250  high +2@6k
  comp     4:1  -18dB  attack 10ms  release 120ms
  drive    3dB
  pan      -20
  send     room 25%   echo 10%

track drums  steps "kick . snare ."  out beat
track brk    steps "1 _ 2 _ 3 _ 3 4" out beat

bus beat                                  # a group: drums and break glued together
  comp     3:1  -12dB  attack 30ms
  lofi     12bit  26k                     # sampler character (SP-1200-ish)

bus room
  reverb   hall  2.4s  predelay 20ms  damp 50%

bus echo
  delay    1/8.  feedback 35%  hp 300     # tempo-synced: dotted eighth

track bass   follow
  comp     6:1  -24dB  sidechain drums.kick   # duck the bass under the kick

master
  eq       lowcut 30
  comp     2:1  -8dB  attack 30ms  release 200ms
  limit    -1dB
  loudness -14LUFS
```

Units are always written: `dB`, `Hz` (or `k`: `6k`), `ms`/`s`, `%`, ratios `4:1`, and musical
durations for time-based effects (`1/8`, `1/8.` dotted, `1/4t` triplet, `2beats`, `1bar`). A bare
number where a unit is needed is an error, which avoids silent 1000× mistakes.

YAML mirrors it:
```yaml
tracks:
  - clip: horns
    effects: [ {eq: {lowcut: 120, low: [-3, 250], high: [2, 6000]}}, {comp: {ratio: 4, threshold: -18, attack_ms: 10}} ]
    pan: -20
    sends: {room: 0.25}
    out: master
buses:
  room: {effects: [ {reverb: {type: hall, decay_s: 2.4, predelay_ms: 20}} ]}
master: {effects: [ {limit: {ceiling: -1}} ], loudness: -14}
```

## The effect set (v1)

| Effect | Parameters | Notes |
|---|---|---|
| `eq` | `lowcut Hz`, `highcut Hz`, `low dB@Hz` (shelf), `high dB@Hz` (shelf), `peak dB@Hz q` (up to 4) | biquad cascade |
| `comp` | ratio, threshold, `attack`, `release`, `knee`, `makeup`, `sidechain <track or bus>` | feed-forward, RMS/peak detector |
| `gate` (noise) | threshold, `attack`, `release` | named `noisegate` to avoid clashing with the existing hit `gate` |
| `drive` | amount dB, `tone` | soft-clip saturation |
| `lofi` | bits, sample rate, `wow %` | sampler / vinyl character |
| `filter` | `lp`/`hp`/`bp` Hz, `q` | already exists per hit; becomes an effect too |
| `delay` | time (musical or ms), `feedback`, `hp`/`lp`, `pingpong` | tempo-synced |
| `reverb` | `room`/`hall`/`plate`, decay, `predelay`, `damp`, `size` | algorithmic (feedback delay network) |
| `pan`, `width` | −100…100, 0–200% | stereo placement |
| `limit` | ceiling dB, `release` | master safety |
| `loudness` | LUFS target | final gain staging |

Later: automation (`filter lp 300 -> 8000 over bars 1-8`, the DJ sweep), convolution reverb with
public-domain impulse responses, chorus, and tape stop or turntable effects.

## Engine

- The renderer already builds every event; next it builds **per-track stems** (lanes), runs insert
  chains, sends and buses, and mixes the master. All of this is offline, deterministic, and cached
  in layers:
  1. event renders (Rubber Band): the slow part, already cached;
  2. track stems: keyed by the track's events and insert chain;
  3. buses and master: keyed by their inputs and chains.
  A fader or EQ change re-runs only layers 2–3 (milliseconds to tens of milliseconds).
- **Seamless loops**: reverb and delay tails must wrap around. The loop is rendered for two
  cycles and the second cycle is kept, so the tail from the end rings into the start.
- **Live controls**: the arrangement keeps per-track post-effects stems, so the real-time mixer can
  apply fader, mute and solo live and without allocation (a UI or MIDI controller can drive them).
  Bus effects stay offline, so a live mute changes a track's dry sound instantly and its reverb
  send at the next re-render.
- DSP written in Rust in `apricity-dsp` (small, deterministic, compiles to WebAssembly), tested
  against known responses: EQ curves, compressor gain curves, reverb decay times.

## Explain and checks

- `explain` gains a **Mix** section: each track's chain, the level at each stage, peak and loudness,
  gain reduction per compressor, and bus routing.
- Validation: unknown effects and parameters get "did you mean"; ranges are checked; units are
  required; buses and sidechain sources must exist; routing cycles are errors; a warning if the
  master would clip before the limiter by more than a set amount.

## Decisions (2026-09-23)

1. **Live faders, mute and solo in v1.** Consequence: per-track stems in the arrangement, and the
   **master chain runs in real time** (EQ, compressor and limiter are cheap and allocation-free),
   so a live fader move still goes through the master compressor and limiter. Track inserts and
   bus effects render ahead.
2. **Algorithmic reverb now**, convolution (public-domain impulse responses) later.
3. **Lo-fi / sampler character is in v1.**
4. **Built in stages, each ending with a demo:**
   - Stage 1: per-track stems, `eq`, `comp`, `pan`; master `eq`/`comp`/`limit`/`loudness`
     (real time); live fader, mute and solo in the engine.
   - Stage 2: buses, sends, groups (`out`), `reverb`, `delay`, seamless loop tails.
   - Stage 3: `sidechain`, `drive`, `lofi`, `noisegate`, `width`; `explain` Mix section polish.

## Open questions (originally)

1. Live faders, mute and solo in v1, or everything offline first?
2. Algorithmic reverb only, or convolution with real spaces soon after?
3. Is the lo-fi/sampler character in scope for v1 (it's core to the culture)?
4. Pan law, loudness target defaults, and whether `gain` stays the fader's name.
