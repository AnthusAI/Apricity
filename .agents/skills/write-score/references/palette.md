# The palette: what's in the library and how to find good sounds

`scripts/palette.py` lists every analyzed sample. With a filter it shows only matching paths; with `-v` it lists each saved clip with its length and the pitch a pitched track would hear.

```
python3 .agents/skills/write-score/scripts/palette.py marine-band/stems      # the march stems
python3 .agents/skills/write-score/scripts/palette.py Thunderer/other -v     # every clip of one stem
```

## Sources by role

| Role | Where | Notes |
|---|---|---|
| Kick, snare, rim, hats, toms, cymbals | `salamander-drumkit/OH/*_OH_F_1.wav` | Acoustic kit, overhead mic, one hit per file. Only the files with a manifest work (`palette.py salamander`); the soft `_P` layers aren't analyzed, so use `_F` with a lower `velocity`. Use `warp repitch`. `speed 0.8` on the kick gives a deeper, boomier electronic kick. `snareStick` is a rimshot. |
| Drum loops and breaks | `marine-band/stems/*/drums.wav` `loop-N` | March snare and bass drum. Slice with `kit b = slice brk by beats 0.5`. |
| Brass stabs | `marine-band/stems/*/other.wav` `shot-N` | Band hits, half a second. `-v` shows each shot's pitch. Punchy; tame them with EQ. |
| Brass pads and melodies | `marine-band/stems/*/other.wav` held notes (`hold-N` where marked up) | Held horn notes of about 1–1.6 s. Voiced as seventh chords with reverb, they make warm pads. Known good: Thunderer `other.wav` `seconds 85.38..86.95 root F4` and `seconds 46.64..48.14 root A4`. |
| Bass | `marine-band/stems/*/bass.wav` | Tubas play short notes, and the pitch analysis is weak that low. Known good steady note: Liberty Bell `bass.wav` `seconds 54.40..55.10 root C2` (the stem is quiet: needs about `volume 14`). The `shot-2` F2 low horn in Thunderer `other.wav` also works as a punchy bass. |
| Whole-band textures | `marine-band/*.mp3` sections (`sec-A1`, `trio`), `citizen-dj/...` loops | Mixed recordings. Good for sampling-style loops, hard to mix under new drums. |
| Voices | `loc/lomax-1939/*` (1939 field recordings: work songs), `voice/announcer.wav` | Slice by phrases (`kit w = slice voice by phrases`). Field recordings under slow chords are the classic older-Moby move. |
| Ragtime | `loc/national-jukebox/*` | Piano and band ragtime, 1910s. |

## Finding held notes by hand

If a stem has no `hold-N` clips, look for long notes in its manifest. Check that they're **actually loud**: the note transcription sometimes invents notes in silence (the "held low F" at the end of Washington Post is −100 dB). Run this with the main checkout's analysis venv:

```python
import json, soundfile as sf, numpy as np
p = "samples/marine-band/stems/Thunderer/other.wav"
m = json.load(open(p + ".apricity.json")); x, sr = sf.read(p); x = x.mean(1)
for n in sorted(m["notes"], key=lambda n: n["start"] - n["end"])[:15]:     # longest first
    seg = x[int(n["start"] * sr):int(n["end"] * sr)]
    print(f'{n["start"]:.2f}s midi {n["midi"]} {n["end"] - n["start"]:.2f}s  {20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-12):.0f} dB')
```

Anything above about −35 dB RMS is usable. Use the region from just before the note to its end: `seconds <start-0.03>..<end> root <pitch>`.

## Traps

- **The marine-band drum stems aren't pitch-neutral.** The stem separation left horn bleed in them, so the harmony checker hears pitches there. Keep them low in the mix, high-pass them, or use the Salamander kit when the harmony matters.

- **No manifest, no sample.** The compiler refuses unanalyzed audio: "has no analysis yet".
- **Audio lives outside git.** In a worktree, `audition.sh` links the main checkout's audio in. Plain `apricity explain` and `compile` need it, and only `render` takes `--library`.
- **`half` / `speed` don't stretch pitched tracks.** A pitched note plays at the clip's own length. Use `release` to let it ring on past the clip into the recording.
- **A `voicing` track needs a `chords` line.** Without one it plays nothing and gives no error (bug apricitus-d4e381). Use `notes` or add chords.
- **Keys and tempos in the palette are the analysis's best guess.** Chord fitting and pitched tracks handle transposition; you don't need to match keys.
