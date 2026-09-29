# Reference sets: the DAW set format (spike apricitus-f838a3)

Ground truth for `design/daw-set.md`. Every `.als` here was written by the DAW itself and is kept
byte for byte as published (gzipped XML; `gunzip -c <file> | less` to read). No audio is committed:
the sets point at audio on their authors' machines, and the owner's reference sets will point at the
synthetic WAVs that `scripts/daw-reference-audio.py` regenerates.

Findings that rest on these public files are **provisional** until the owner's reference sets (saved
with the licensed install, see "Owner steps" in the design note) are added beside them.

## Files

| File | DAW version (header) | What it shows | Source |
|---|---|---|---|
| `public-12.3.7-minimal.als` | 12.3.7, `MinorVersion="12.0_12300"` | The DAW's default set, edited and re-saved: 2 MIDI tracks, 2 audio tracks, returns A (Reverb) and B (Delay), 8 scenes, 5 locators, tempo and time-signature automation on the main track (tempo 120 → 90, time signatures 4/4, 3/4, 6/8, 4/4). No audio clips. The skeleton for the proof set. | [1] |
| `public-12.2.1-techno.als` | 12.2.1, `MinorVersion="12.0_12203"` | 12 warped arrangement audio clips (Beats mode, transpose −7 on two), a group track with 6 audio tracks, 2 returns (Reverb, Delay), 5 Compressors on other tracks, all keyed from the `Kick` track (`AudioIn/Track.19/PostFxOut`). Collected samples (`RelativePathType` 3, `Samples/Imported/…`). The clip template for the proof set. | [2] |
| `public-12.2-broom-bap.als` | 12.2, `MinorVersion="12.0_12203"` | 135 arrangement audio clips (Beats and Complex, warped and unwarped, transpose +7, clip gain below 0 dB), 2 group tracks, 4 returns with sends, EQ Eight (×12), Compressor, Glue Compressor, Limiter (on the main track), Saturator, Utility, automation envelopes on sends, volume and EQ Eight bands (ramps and jumps). | [2] |

Sources (cited by owner and GitHub repository id, because the repository names contain the vendor's
name; `https://api.github.com/repositories/<id>` resolves each one):

1. github.com/reasonno1, repository id 1226932927, commit `472b24b8a99e0132ba1a1f3ab6b5bd53e2a2dc32`,
   path `tests/fixtures/minimal.als`, git blob `aa2a07a55fdb6684707e1d1f3fb5da4bb30da8be`.
   MIT licence, "Copyright (c) 2026 reasonno1".
2. github.com/owenbush, repository id 1074927552, commit `2ff369a4a8d5f2bf468fc3882e1cb955633936e4`,
   folder `packages/core/test/fixtures/`, git blobs `b136cb8c009fc11b14b4b23001d117b49f4bfe05`
   (techno) and `7b0483b116afa172da879ecf0e2e0da2a8bef92f` (broom bap). MIT licence,
   "Copyright (c) 2025 Owen Bush".

Both licences: Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions: The above copyright notice and
this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Files under other licences (GPL-3.0, AGPL-3.0, none) were read in a scratchpad and are only cited in
the design note, never copied here.

## Still to come from the licensed install

`empty.als`, `clip.als`, `mix.als`, `devices.als`, `automation.als`, saved by the owner as described
in `design/daw-set.md` ("Owner steps"), pointing at:

```sh
analysis/.venv/bin/python scripts/daw-reference-audio.py      # → renders/daw-reference/ (git-ignored)
```

which writes `click-tone.wav` (4 bars of 4/4 at 120 BPM, 48 kHz, 16-bit stereo, 1 kHz clicks on
every beat over a 440 Hz tone at −18 dBFS; sha256 `90ea7beb…0e9aad`) and `clash/click-tone.wav`
(same name, 330 Hz, clicks on the off-beats; sha256 `e4b26a8a…8d9f7`).

## Checks

```sh
git ls-files crates/apricity-daw/tests/fixtures          # only .als and .md
for f in crates/apricity-daw/tests/fixtures/reference/set/*.als; do gunzip -t "$f"; done
```
