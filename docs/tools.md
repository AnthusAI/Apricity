# Tools

Commands are run from the repository root. Python tools use the analysis environment
(`analysis/.venv`); the `apricity` command is built with Cargo.

## Getting set up

```sh
git submodule update --init                       # Rubber Band source
scripts/fetch-tools.sh                            # wasi-sdk, for the WebAssembly build
scripts/fetch-samples.py                          # the public-domain sample library
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

Writes `<file>.apricity.json` next to each sample: beats, warp markers, key and key over time,
tuning, chroma, loudness per beat, a transcription. Then it runs [automatic markup](concepts.md#automatic-markup):
sections, loops and one-shots saved as clips, and transients as markers. Files whose manifest already matches the audio
are skipped.

| Flag | |
|---|---|
| `--force` | Re-analyze even if up to date. The clips and markers saved with it are kept. |
| `--no-notes` | Skip the transcription (much faster). |
| `--no-markup` | Skip automatic markup. |

**Markup on its own** — re-run automatic markup over samples already analyzed (it replaces only its own
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

While it plays, type mix commands and press Return. They take the name of a track, group or return, or a track number:

| Command | Does |
|---|---|
| `mute NAME` · `unmute NAME` | Silence a track, group or return, or bring it back. |
| `solo NAME` · `unsolo NAME` | Hear only the soloed tracks (a soloed track keeps its reverb). |
| `volume NAME -6` | Move a fader, in dB. |
| `reset` | Clear every mute, solo and fader move. |
| `tracks` | List the tracks, groups and returns with their state. |

Live changes survive saving the score. They aren't written into it: to keep a level, change the
score's `volume`.

**`apricity explain`** prints, for each clip, the part of the sample chosen, the beat ratio, the key it sounds in,
stretch, detune and level; for each chord, every track's transposition, where its root landed,
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

- **Library** — every analyzed sample. Drag on the waveform to select (snaps to beats; hold ⌥ for free),
  make and name clips, and save them with the sample; double-click to audition from a point. Drop audio
  files on the sidebar to add and analyze them.
- **Score** — edit `.apr` or YAML; it compiles as you type, underlines mistakes, shows the chord strip
  and how everything was solved. Play with the button or Space; edits land at the next bar; ⌘S saves.
- **Flow** (under the score, toggled by the **Flow** button): where every sound comes from. Top to
  bottom:
  - the **samples** the score uses, showing only the stretches it plays (a ⫽ marks time left out);
  - the **pads** cut from them: each kit's slices or pads, and each clip played whole;
  - the **composition**, one lane per track.

  Each sample has its own color, and its pads and notes carry that color. Hover any note, pad or
  row to trace it: the sample it came from opens up, and curves run from the sample to the pad to
  every place it plays. Click to pin it (Esc to let go). While the score plays, whatever is
  sounding is traced as it plays. Click the ruler or chords to jump to a bar. Drag the panel's top
  edge to resize it.
- **Docs** — these pages.

The server only listens on 127.0.0.1 and only writes the clips and markers saved with samples, scores (in `examples/` and
`scores/`) and uploads (in `samples/uploads/`).

## Tests

```sh
cargo test --workspace                     # theory, compiler, language, engine (incl. real-time safety)
cargo test -p apricity-dsp --target wasm32-wasip1   # the DSP tests again, as WebAssembly
node web/test/wasm.test.mjs                # compile → render → mix in WebAssembly
(cd analysis && PYTHONPATH=. .venv/bin/python -m pytest tests)   # analysis, manifests, server
```
