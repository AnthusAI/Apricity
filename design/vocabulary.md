# Vocabulary: aligned with Ableton Live (design, 2026-09-24)

Status: **decided by the user 2026-09-24; built the same day** (language, compiler, manifests, analysis, web, docs). The storage contract (task 3) is the storage session's to do. Every user-facing word means one thing,
and the same thing it means in Live, so Live users can read Apricity at a glance. Internal names
follow in the same change wherever it's cheap. Where it isn't, they're renamed when the code is next
touched.

## The words

| Term | Live's word | Replaces | Meaning |
|---|---|---|---|
| **Sample** | Sample | the Library's "clip", a stem's "clip" | An audio file in the library (a recording, an excerpt, or a stem), analyzed once. |
| **Recording** | — | (unchanged) | A performance that one or more samples come from (a mix and its stems, or an imported drum library). Carries the credits and the license. |
| **Clip** | Clip | a sample's saved "slice"; the score's `clip` | A named region of a sample, with its warp settings. Clips are **saved with the sample** (`loop-1`, `sec-A1`, `shot-3`, your `riff`: reusable in any score, like Live's saved `.alc` clips) or **defined in a score**. |
| **Marker** | Marker / locator | (unchanged) | A named point in a sample. |
| **Transient** | Transient (marker) | "hit" (an accent in a recording), the `hit` marker | An onset worth cutting at. Automatic markup marks them. |
| **Kit** | Kit (Drum Rack presets) | kit; "drum pack" (never used) | A set of **pads**, played with `steps`. Like clips, kits are **saved in the library** (a **saved kit**) or **defined in a score**. An imported drum library (e.g. Salamander) is just samples plus a saved kit whose pads point at them; to make your own, copy a saved kit and swap pads. |
| **Slice** | Slice (Simpler's Slice mode; Slice to New MIDI Track) | "chop" | One of the pieces a kit cuts a clip into (by beats, bars, count, transients or phrases), each on a numbered pad. |
| **Pad** | Pad | pad, and a chop's number | A kit's slot. It holds a slice (`b.3`) or a clip (`drums.kick`). |
| **Track** | Track | track | Plays a clip, a whole kit (with `steps`), or one pad. |
| **Note** | Note | "trigger" (a track sounding once) | One time a track sounds: each repeat, step or `at` position. |
| **Steps** | Step sequencer | steps | A track's pattern of notes. |
| **Return track** | Return track | `bus` used for shared effects | Shared effects (reverb, echo) that tracks **send** to. |
| **Group track** | Group track | `bus` used for summing, `out` | Tracks summed and processed together. |
| **Send / Master** | Send / Main (Master) | (unchanged) | |
| **Volume** | Volume (track fader) | a track's or bus's `gain` | A track's (or group's or return's) fader, in dB. |
| **Warp modes** | Beats, Complex, Texture, **Re-Pitch** | `warp off` | `repitch` plays the clip at a speed instead of stretching it. |
| **Transpose / Detune** | Transpose / Detune | (unchanged); "retune" in prose | Semitones; cents (Apricity detunes every sample to A = 440 automatically). |
| **Time signature** | Time signature | `meter` | `time 4/4`. Only x/4 for now. |
| **Collection** *(planned)* | Collection | "crate" | A named set of kept clips. |

Kept on purpose:
- **Score**, not Live's "Set": "set" is too vague a word alone. A score is the written piece
  (`.apr` or YAML).
- **Swing**, **reverse**, **half/double**, **stems** and **tempo** already match Live.
- **Chords**, **key**, **follow**, **automatic markup** and **Flow** are Apricity's own.

Not used: **pack** (a downloaded kit is a saved kit, as in Live).

Gone: **chop**, **piece**, **region** (as a noun), **trigger**, **bus**, **hit**, **meter**,
`warp off`, and **gain** for faders.

## The language, before and after

```apr
# before
meter 4
clip brk    = marine-band/stems/Thunderer/drums.wav  slice loop-1  warp beats
kit b       = chop brk by beats 0.5
kit h       = chop horns by hits
kit drums
  kick  = tdrums  slice hit-1
bus beat
  comp  4:1  -14dB
bus plate  gain -4
  reverb plate 1.8s
track b     steps "1 _ 2 _"  out beat  gain -2
  send  plate 20%

# after
time 4/4
clip brk    = marine-band/stems/Thunderer/drums.wav  loop-1  warp beats   # the sample's saved clip
kit b       = slice brk by beats 0.5                                     # pads b.1 … b.8
kit h       = slice horns by transients
kit drums
  kick  = tdrums  shot-1
group beat
  comp  4:1  -14dB
return plate  volume -4
  reverb plate 1.8s
track b     steps "1 _ 2 _"  group beat  volume -2
  send  plate 20%
```

- **A sample's saved clip** is named right after the path: `clip brk = <sample> loop-1`. The
  first word after the path, if it isn't an option (`beats`, `seconds`, `pick`, `root`, `ratio`,
  `warp`), names a saved clip. A pad works the same way (`kick = tdrums shot-1`).
- **`slice`** replaces `chop` in kits: `slice <clip> by beats n | by bars n | into n | by
  transients | by phrases`.
- **Group tracks:**
  - `group <name>` with indented effects defines one; `volume` and `group` (nesting) go on its line.
  - A track joins one with `group <name>` on its track line (replacing `out`).
  - Groups can nest, but not in a circle.
- **Return tracks:**
  - `return <name>` with indented effects defines one; `volume` goes on its line.
  - Tracks reach returns only by `send` (sends from group tracks: later).
  - Returns go to the master.
- **No backward compatibility.** The old words are simply gone: they're unknown words like any
  other, with the usual "did you mean" suggestions. The examples and manifests were moved over once.

YAML follows the same words:
- `time: 4/4`
- `clips: { brk: { source: …, saved: loop-1 } }`
- `kits: { b: { clip: brk, slice: { beats: 0.5 } } }`, or `slice: transients`
- pads: `{ clip: tdrums, saved: shot-1 }`
- `groups:` and `returns:` at the top level
- on a track: `group: beat`, `volume: -2`

## Samples and their saved clips (analysis, manifests, API)

- **Manifests:**
  - `annotations.slices` becomes `annotations.clips` (same entries);
  - markers named `hit` become `transient`;
  - automatic `hit-N` clips become `shot-N` (one-shots);
  - `apricity_manifest` goes to 2.

  All 45 manifests were rewritten once, keeping every name the scores use; readers take version 2
  only.
- **Server API:**
  - `GET /api/clips` becomes `GET /api/samples` (entries are samples, each with a count of saved clips);
  - `PUT /api/annotations` stays, and writes `clips`.
- **Storage model** (`design/storage.md`): `Clip` → `Sample`, `Slice` → `Clip`,
  `slicesByClip` → `clipsBySample`, `Crate`/`CrateItem` → `Collection`/`CollectionItem`,
  `nameCounters` keys `hit` → `shot`, and `ScoreRef.sliceId` → `clipId`. **This is the storage
  session's in-flight work:** its owner decides when the contract changes. Doing it before the
  first cloud deploy avoids a data migration later.

## Saved kits *(planned)*

- A kit can be saved in the library, next to the samples it uses, and used from any score by name,
  just like a saved clip. A score can still define its own kits.
- Importing a drum library makes one sample per sound (credited to one recording, with its
  license) and one saved kit with a pad per drum (`kick`, `snare`, `hat.closed`, …).
- Each pad holds one sample for now; velocity layers and round-robin can come later as several
  samples on one pad, with no new words.

## The app and docs

- **Library:** a list of **samples**; each shows its **clips** (the slice lane becomes a clip lane), markers and transients.
- **Score and Flow:**
  - rows are samples, kits (pads holding slices or clips) and tracks;
  - the info line uses the new words ("slice 3 on pad b.3, from Thunderer/drums at 2:28.24");
  - the editor highlights the new keywords.
- **Landing hero:** the chapters are Listen · Clip · Slice · Warp · Kit · Play (the making of the `examples/hero.apr` groove), and the captions use the new words.
- **Docs:** concepts, language, YAML, glossary and tools are rewritten in the new words, with a short
  "Coming from Live" table in concepts.

## Plan (Kanbus epic; one task per area)

| # | Area | Owner | Depends on |
|---|---|---|---|
| 1 | Language + compiler: dsl.rs, score.rs, compile.rs, errors, tests; examples migrated | engine session | — |
| 2 | Analysis + manifests: markup names, `clips`/`transient`, manifest v2, migration script, `/api/samples` | engine session | — |
| 3 | Storage contract + apricity-data renames | storage session | 2 |
| 4 | Web: Library, Score, Flow, highlighting, hero data regenerated, landing captions | web/docs session | 1, 2 |
| 5 | Docs + glossary + design briefs | web/docs session | 1 |

Tasks 1 and 2 land together (the compiler reads manifests), followed by task 4 in the same sitting,
so `master` never has the app and the engine speaking different words.
