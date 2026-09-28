# Recipes that worked

Each of these is from a render the user heard. Adapt them; don't paste them whole. The full context is in `examples/brass-floor.apr`.

## Deep house kit (soft, sparse)

```apr
clip kick = salamander-drumkit/OH/kick_OH_F_1.wav        warp repitch  speed 0.85   # deeper than recorded
clip rim  = salamander-drumkit/OH/snareStick_OH_F_1.wav  warp repitch
clip hat  = salamander-drumkit/OH/hihatClosed_OH_F_1.wav warp repitch
clip open = salamander-drumkit/OH/hihatOpen_OH_F_1.wav   warp repitch
kit drums
  kick = kick
  rim  = rim
  hat  = hat
  open = open

track drums.kick  steps "x . . . x . . . x . . . x . . ."  velocity 90
  eq    highcut 4k
track drums.rim   steps ". . . . x . . . . . . . x . . ."  velocity 70
  send  plate 20%
track drums.hat   steps "x x x x x x x x x x x x x x x x"  velocity 55  swing 56  humanize 6ms 20%  volume -6
track drums.open  steps ". . x . . . x . . . x . . . x ."  velocity 60  swing 56  volume -10
```

For a punchier house kit: a clap from the snare at `speed 1.2` on beats 2 and 4, and hats at `velocity 70`.

## Band loops sequenced like a sampler (the user's 4★ material)

Each Liberty Bell loop already plays a chord, so pick a progression that matches them and play each loop on its own chord, untransposed:

```apr
key D minor
clip band = marine-band/stems/LibertyBell/other.wav
kit loops
  b = band  loop-1      # B♭ with a D-minor colour
  d = band  loop-2      # the same colour, a different bar
  g = band  loop-4      # G minor
  c = band  loop-3      # C
chords (VImaj7*2 i7*2 iv7*2 VII*2)*4
track loops  steps "b d b d g g c c"  grid 1  transpose 0
  eq    lowcut 120  highcut 5k  peak -4@2500
```

A one-bar bass loop becomes a bassline that follows the chords: `track tuba voicing root octave 2 steps "x" grid 1`, with `clip tuba = …/LibertyBell/bass.wav loop-3`.

## Brass pads from a held note

```apr
clip pad = marine-band/stems/Thunderer/other.wav  seconds 85.38..86.95  root F4
chords (i7*2 VImaj7*2 iv7*2 VII*2)*4          # a chord every two bars: calm
track pad  voicing seventh  steps "x _ _ _ _ _ _ _ _ _ _ _ . . . . | . . . . . . x@70 _ _ _ _ _ _ _ . ."  volume -4
  eq    lowcut 150  highcut 5k  peak -4@2500
  comp  2:1  -24dB  attack 30ms  release 250ms  makeup 2dB
  send  plate 35%
```

## Offbeat house bass from one hit

```apr
clip tuba = marine-band/stems/Thunderer/other.wav  shot-2     # F2
track tuba  voicing root  octave 2  steps ". . x _ . . x _ . . x _ . x x _"
```

## A melody on chord tones

Degrees are in the key, so spell each chord's tones. In F minor, i7 = 1 3 5 7, VImaj7 = 6 1 3 5, iv7 = 4 6 1 3, VII = 7 2 4. Long notes with an echo feel calmer than busy lines:

```apr
track horn  notes "5 _ _ _ 3 _ _ _ | 1 _ _ _ . . . . | 5 _ _ _ 6 _ _ _ | 3 _ _ _ . . . ."  grid 8
  send  plate 30%  echo 25%
return echo  volume -8
  delay  1/4.  feedback 40%  hp 500  lp 3k  pingpong
```

## Builds and drops

- Enter one element per 4 bars, and let the processing arrive with them, as automation on one track:

```apr
track loops  as band  steps "b d b d g g c c"  grid 1  transpose 0
  eq    lowcut 20  highcut 20k  high 0@2500
  comp  2:1  -22dB  attack 30ms  release 250ms  makeup 2dB  mix 0%
  automate eq.lowcut   1=20  5=120
  automate eq.highcut  1=20k  5=6k  13=5k
  automate eq.high     1=0dB  5=-4dB
  automate comp.mix    step  1=0%  13=100%
track drums.kick  steps "x . . . x . . . x . . . x . . ."  bars 13-32
  automate volume  step  13=0dB  21=-60dB  23=0dB      # the breath before the second drop
```
- A breath before a drop: one or two bars with the beat out.
- A swell into the drop: `track pad as swell voicing seventh reverse at 12:1 22:1`, sent to the reverb.
- A roll into the drop: sixteenths with rising velocity, `steps "x@30 x@36 x@42 … x@120 x!"`, on one bar.

## The house form (a finished track)

The user called this structure "fantastic"; use it for finished house and deep-house tracks. It's 40 bars in five 8-bar phrases (`examples/ave-house.apr` is the reference):

| Bars | Section | What happens |
|---|---|---|
| 1–8 | Intro | One loop alone, low-passed open; the kick joins at bar 5. |
| 9–16 | Groove | The main loop, the bass on each chord's root and the clap come in together. |
| 17–24 | Groove, lifted | The open hat and a gentle compressor pump arrive (`automate comp.mix step 17=100%`). |
| 25–32 | Breakdown | The beat and the bass drop out. The music closes to a resonant low-pass (`filter lp 20000 24dB` on the group, `automate filter.cutoff` / `filter.res`) and swims in reverb. From 29: a clap roll and a reversed crash, with the filter singing higher. |
| 33–40 | Drop | Everything back at once, the filter snapped fully open, a crash on the one. |

Put all the music through one `group`, so the breakdown can filter it as one. New elements enter on 8-bar boundaries (4 at most), so the build is obvious.

## Auditioning a layer (the 16-bar form)

Don't render the full house form to judge one candidate layer: it takes about 80 s per candidate to review, and a lot of disk. The user asked for a standard audition instead (2026-09-27), 16 bars (32 s at 120 BPM):

| Bars | Hear |
|---|---|
| 1–4 | The existing scene alone (its full groove). |
| 5–8 | The new part solo, for the same length. |
| 9–16 | Both together, with a quick 2-bar build (the new part fades or filters in over bars 9–10), then 6 bars of the full combination. |

Score and compare candidates on bars 9–16, with the baseline computed over the same window. Keep the full 40-bar form for the version a candidate graduates into.

Implemented: `scripts/lab audition CANDIDATE.apr --layer TRACK [--window A-B]` (Kanbus apricitus-dbed5c; module: `analysis/apricity_analyze/audition_form.py`). Renders the window once, assembles scene/solo/together from its stems, loudness-normalizes to -14 LUFS, and deletes the render before returning -- only the `.m4a` and a small numbers `.json` are kept, and it always reports Δwindow (together vs. a scene-alone baseline over the same window, cached per score+window). `scripts/lab swap --audition` writes one per finalist.

## Mix chains

```apr
return plate
  eq      lowcut 250
  reverb  hall  3.2s  predelay 30ms  damp 55%      # long, dark: smooths everything it touches
master
  eq       lowcut 30  highcut 14k
  comp     2:1  -14dB  attack 30ms  release 250ms
  loudness -14LUFS
```
