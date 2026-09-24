# Apricity

A mashup machine: a declarative, harmony-aware engine for making music out of samples. Analyze clips (beats, warp
maps, key, notes), then describe a piece as a score, and Apricity warps every clip to one tempo and
transposes each so that together they sound the chords you ask for.

Status: **Phase 5 in progress**: the Apricity text language, automatic markup (sections, loops, hits), and sampler-style kits, chops, step patterns and flips are in. So are the first two stages of the mixer: effects, pan, sends, buses, reverb, delay and a loudness-targeted master ([design/mixer.md](design/mixer.md)); sidechain, drive and lo-fi come next. Planned: the curation loop ([design/framework.md](design/framework.md)), then the Swift app.

## Documentation

Start with **[docs/](docs/README.md)** (also in the web app's **Docs** tab):
[Concepts](docs/concepts.md) · [The Apricity language](docs/language.md) · [YAML scores](docs/yaml.md) ·
[Chords and keys](docs/chords.md) · [Tools](docs/tools.md) · [Glossary](docs/glossary.md).

## Layout

| Path | What |
|---|---|
| `analysis/` | `apricity-analyze`: beats and downbeats (Beat This!), warp markers, tuning, key and key-over-time, chroma (Essentia), notes (Basic Pitch) → `<clip>.apricity.json` |
| `schema/` | JSON Schemas; `clip-manifest.schema.json` is the contract between analysis and engine |
| `crates/apricity-theory` | Pitch classes, keys and modes, roman numerals (`iv` ≠ `IV`), chord symbols, Camelot, key finding, the harmony solver |
| `crates/apricity-score` | Score format (strict; every mistake reported with its location), clip regions by beats/seconds/slice/`pick`, compile → timeline |
| `crates/apricity-engine` | Render ahead, mix live: the `Renderer` pre-warps events into an `Arrangement` (cached, so edits re-render only what changed); the real-time `Mixer` loops it and swaps new arrangements in at the bar line with a crossfade. Never allocates on the audio thread. Builds for wasm. |
| `crates/apricity-cli` | `apricity compile`, `explain`, `render`, `play` |
| `examples/` | Scores. `iv-of-ab-minor.yaml` is the first milestone |
| `crates/apricity-dsp` | Rubber Band (vendored, single-file build) behind a safe Rust API: offline stretch, pitch shift, warp markers via key-frame maps |
| `crates/apricity-web` | C-ABI WebAssembly surface for the browser: compiler (page), renderer (workers), mixer (AudioWorklet) |
| `web/` | The web app (Vite + TypeScript, CodeMirror) |
| `analysis/apricity_analyze/server.py` | Local API server: clips, files, saving annotations and scores, upload + analysis |
| `vendor/rubberband` | Rubber Band Library v4.0.0 (git submodule, GPL) |

## Building

Use the rustup toolchain (`~/.cargo/bin`). An older Homebrew `cargo` in `/usr/local/bin` may shadow it.

```sh
git submodule update --init
cargo test -p apricity-dsp                              # native
scripts/fetch-tools.sh                                # wasi-sdk into .tools/
cargo test -p apricity-dsp --target wasm32-wasip1       # same tests as wasm, run by Node's WASI
cargo build -p apricity-web --release --target wasm32-wasip1
node spikes/web-audio/serve.mjs                       # http://localhost:5180
```

Analysis (Python 3.12):

```sh
python3 -m venv analysis/.venv
analysis/.venv/bin/pip install --pre -e analysis[dev]    # may stall on basic-pitch's pins; if so:
analysis/.venv/bin/pip install --no-deps basic-pitch==0.4.0
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.cli samples
PYTHONPATH=analysis analysis/.venv/bin/python -m pytest analysis/tests
```

iOS: `cargo build -p apricity-dsp --target aarch64-apple-ios[-sim]` builds as-is.

## The Apricity language

Scores can be written as `.apr` text instead of YAML; both compile to the same score (a test keeps
every paired example identical). `apricity fmt score.yaml` converts either way.

```
tempo 100
key F mixolydian
samples ../samples

clip tuba  = marine-band/stems/WashingtonPost/bass.wav   pick 1bar
clip horns = marine-band/stems/WashingtonPost/other.wav  pick 1bar

chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 V7     # one chord per bar

track tuba   follow
track horns  follow  bars 5-12  gain -2
```

Chords are written like a chord chart: one per bar, `.` holds, `I7*2` lasts two bars, `[ii V]` splits a bar,
`(I IV)*2` repeats, `|` is just for reading. Statements: `tempo meter key samples bars clip chords track`.
Clip options: `beats a..b  seconds a..b  slice name  pick 2bars  root C  ratio 2  warp beats|complex|texture`.
Track options: `as name  follow  transpose n|auto  role root|third|…  every 1bar  at 3 7:2  bars 5-12  gain -3`.
Mistakes are reported with line and column (and "did you mean"); the web editor underlines them.

## Automatic markup

`PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.markup samples` (also run automatically after
analysis, stem separation and uploads) finds, in each clip:

- **sections** — boundaries from a self-similarity novelty curve, snapped to bar lines, lettered by
  beat-aligned repetition (repeated strains share a letter); a section in the subdominant is named `trio`;
- **loops** (`loop-1`…) — the 1-, 2- and 4-bar windows that repeat best, with a steady beat and static harmony;
- **hits** (`hit-1`…) — strong accents, as markers and one-beat slices.

All of it is saved with `source: ml`; re-running replaces only ML markup, never your own slices, and editing
an ML slice makes it yours. Use them like any slice: `clip riff = …/other.wav slice loop-1`.
See `examples/markup-demo.apr`.

## Score features worth knowing

- **Stems**: `PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.stems samples/marine-band/X.mp3`
  splits a recording with Demucs into `stems/X/{drums,bass,other}.wav`, each analyzed and sharing the
  parent's beat grid. Layer *parts* (a bass line from here, horns from there) instead of whole bands.
- **`transpose: follow`** moves a clip with the chord root — the way blues riffs and bass patterns are played
  in parallel on I, IV and V. `root: C` pins what a region is built on when detection is ambiguous.
- **`pick: 1bar`** finds the passage that fits the chords, has a steady beat, holds one harmony (so it
  transposes cleanly) and is actually playing (stems are often silent for stretches).
- **Level matching**: every track is brought to a common loudness first; `gain:` is then a mix decision.
- `examples/march-blues.yaml` shows all of it: a 12-bar blues from a 6/8 march's stems.

## The web app

```sh
cargo build -p apricity-web --release --target wasm32-wasip1       # the engine, as wasm
PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.server   # API on 127.0.0.1:5181
npm --prefix web install && npm --prefix web run dev                     # app on http://localhost:5173
```

Or build once (`npm --prefix web run build`) and open http://localhost:5181, served by the Python server alone.

- **Library**: every analyzed clip with tempo, steadiness, key over time and tuning. Drag on the waveform to
  select (snaps to beats; ⌥ for free), make slices, name them, save them into the clip's manifest.
  "Copy for score" gives you the `clips:` line. Drop audio files on the sidebar to add and analyze them.
- **Score**: edit YAML; it compiles as you type (problems marked in the editor), shows the chord strip and how
  every clip was transposed. Press play (or Space): edits land at the next bar. ⌘S saves.

How the browser runs it: the page compiles (wasm); a pool of render workers warps events with Rubber Band
(wasm), each keeping its own cache; their partial mixes go straight to the AudioWorklet, which sums them
and swaps the new loop in at the bar line using the same Rust mixer as `apricity play`.

Tests: `node web/test/wasm.test.mjs` (compile → render → mix in wasm), `pytest analysis/tests` (includes the server).

## Making music

```sh
cargo build --release -p apricity-cli
./target/release/apricity explain examples/iv-of-ab-minor.yaml     # what got picked, transposed, and why
./target/release/apricity play    examples/iv-of-ab-minor.yaml                   # live: edit + save, hear it at the next bar
./target/release/apricity render  examples/iv-of-ab-minor.yaml -o renders/iv.wav
analysis/.venv/bin/python scripts/check-render.py examples/iv-of-ab-minor.yaml renders/iv.wav
```

## Samples

Test material is real, public-domain march music, listed with credits and rights in
[`samples/sources.json`](samples/sources.json). The audio itself is gitignored; fetch it with:

```sh
scripts/fetch-samples.py
```

- **Library of Congress, [Citizen DJ](https://citizen-dj.labs.loc.gov/):** 27 excerpts from Edison
  and National Jukebox recordings (1890s–1920s) plus a Tony Schwartz street recording of a St. Patrick's parade.
- **"The President's Own" U.S. Marine Band, *The Complete Marches of John Philip Sousa*:** 8 modern
  full-length recordings, mirrored on Wikimedia Commons. Full scores (useful ground truth for key/tempo)
  are linked per march; the Marine Band site only serves them to browsers.

## License

GPL-2.0-or-later (Apricity links Rubber Band, which is GPL).
