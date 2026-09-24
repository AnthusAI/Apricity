# Tools

Commands are run from the repository root. Python tools use the analysis environment
(`analysis/.venv`); the `apricity` command is built with Cargo.

## Getting set up

```sh
git submodule update --init                       # Rubber Band source
scripts/fetch-tools.sh                            # wasi-sdk, for the WebAssembly build
apricity sources fetch --all                      # the public-domain sample library (verified, resumable)
scripts/fetch-samples.py                          # legacy Python fetcher, superseded by the line above
cargo build --release -p apricity-cli               # ./target/release/apricity
cargo build -p apricity-web --release --target wasm32-wasip1    # the engine for the browser
python3 -m venv analysis/.venv && analysis/.venv/bin/pip install --pre -e analysis[dev]
npm --prefix web install
```

Use the rustup toolchain (`~/.cargo/bin`); an older Homebrew `cargo` may shadow it.

## Analysis

```sh
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.cli <files or folders>
```

Writes `<file>.apricity.json` next to each audio file: beats, warp markers, key and key over time,
tuning, chroma, loudness per beat, notes. Then it runs [automatic markup](concepts.md#automatic-markup):
sections, loops and hits, saved as slices and markers. Files whose manifest already matches the audio
are skipped.

| Flag | |
|---|---|
| `--force` | Re-analyze even if up to date. Your annotations (slices, markers) are kept. |
| `--no-notes` | Skip note transcription (much faster). |
| `--no-markup` | Skip automatic markup. |

**Markup on its own** — re-run automatic markup over clips already analyzed (it replaces only its own
earlier marks):

```sh
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.markup samples/marine-band
```

**Stems** — split recordings into drums, bass, other (and vocals, if any) with Demucs:

```sh
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.stems samples/marine-band/Thunderer.mp3
```

Stems are written to `<folder>/stems/<name>/<stem>.wav`, analyzed and marked up, and share the
parent's beat grid.
Silent stems are skipped. About 3–4 minutes per march on a laptop; `--threads N` (default 4) sets how
hard it works, and it runs at low priority.

**Loudness backfill** — adds per-beat loudness to manifests made before it existed:
`python -m apricity_analyze.loudness samples`.

## The `apricity` command

```sh
apricity compile  <score> [-o timeline.json]   # validate and print the compiled timeline as JSON
apricity explain  <score>                      # what each clip got and how it was transposed, and why
apricity render   <score> -o out.wav [--bars 1-8]      # 48 kHz stereo WAV; reports loudness and peak
apricity play     <score> [--volume -12] [--seconds 30] [--no-audio]
apricity fmt      <score> [--to apr|yaml] [-o out]  # convert between the two score formats
```

Scores can be `.apr`, `.yaml` or `.json`.

**`apricity play`** loops the score through your speakers and watches the file: save a change and it
lands at the next bar. A score with mistakes is reported and the last good version keeps playing.
`--no-audio` runs the engine on a silent clock (for testing).

While it plays, type mix commands and press Return. They take a track or bus name, or a track number:

| Command | Does |
|---|---|
| `mute NAME` · `unmute NAME` | Silence a track or bus, or bring it back. |
| `solo NAME` · `unsolo NAME` | Hear only the soloed tracks (a soloed track keeps its reverb). |
| `gain NAME -6` | Move a fader, in dB. |
| `reset` | Clear every mute, solo and fader move. |
| `tracks` | List the tracks and buses with their state. |

Live changes survive saving the score. They aren't written into it: to keep a level, change the
score's `gain`.

**`apricity explain`** prints, for each clip, the region chosen, the beat ratio, the key it sounds in,
stretch, retuning and level; for each chord, every track's transposition, where its root landed,
how much of it is on chord tones and outside the key, and the next-best options.

## Checking a render

```sh
analysis/.venv/bin/python scripts/check-render.py examples/march-blues.apr renders/march-blues.wav
```

Re-analyzes a render and compares it with its score: tempo heard, how far beats sit from the score's
grid, the mix's tuning, and for each chord the share of sound on its chord tones (three random notes
would get about 25%). Note that shuffle and 6/8 feels can confuse the tempo reading.

## The web app

```sh
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.server   # API, 127.0.0.1:5181
npm --prefix web run dev                                                 # app, http://localhost:5173
```

Or `npm --prefix web run build` once and use http://localhost:5181 alone.

- **Library** — every analyzed clip. Drag on the waveform to select (snaps to beats; hold ⌥ for free),
  make and name slices, save them into the manifest; double-click to audition from a point. Drop audio
  files on the sidebar to add and analyze them.
- **Score** — edit `.apr` or YAML; it compiles as you type, underlines mistakes, shows the chord strip
  and how everything was solved. Play with the button or Space; edits land at the next bar; ⌘S saves.
- **Flow** (under the score, toggled by the **Flow** button): where every sound comes from. Top to
  bottom:
  - the **recordings** the score samples, showing only the stretches it uses (a ⫽ marks time left out);
  - the **pieces** cut from them: each kit's chops or pads, and each clip played whole;
  - the **composition**, one lane per track.

  Each recording has its own color, and its pieces and hits carry that color. Hover any hit, piece
  or row to trace it: the recording it came from opens up, and curves run from the recording to the
  piece to every place it plays. Click to pin it (Esc to let go). While the score plays, whatever is
  sounding is traced as it plays. Click the ruler or chords to jump to a bar. Drag the panel's top
  edge to resize it.
- **Docs** — these pages.

The server only listens on 127.0.0.1 and only writes clip annotations, scores (in `examples/` and
`scores/`) and uploads (in `samples/uploads/`).

## Tests

```sh
cargo test --workspace                     # theory, compiler, language, engine (incl. real-time safety)
cargo test -p apricity-dsp --target wasm32-wasip1   # the DSP tests again, as WebAssembly
node web/test/wasm.test.mjs                # compile → render → mix in WebAssembly
(cd analysis && PYTHONPATH=. .venv/bin/python -m pytest tests)   # analysis, manifests, server
```
