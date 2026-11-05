# DAW set export step vocabulary

Runner: `cargo test -p apricity-cli --test daw_set`. Each scenario creates deterministic 16-bit PCM WAV audio and matching analysis manifests in a fresh temporary directory. It invokes the public `apricity export --daw-set` CLI; it never launches Live. The XML assertions inspect the gzip-compressed set and its project files. Live acceptance remains a separate manual check.

The four-bar fixture mirrors the synthetic format proof: 99.5 BPM, 4/4, A minor, four changes and one beats-warped track with transpose 5, source tuning +23 cents, and volume -6 dB. Its compiled events span beats 0–4, 4–8, 8–12 and 12–16. Expected clip gain is -8 dB after level matching.

The collision fixture creates two different files with the same basename. Existing-destination steps write sentinel bytes before invoking the CLI. A failed forced export must preserve those bytes. All diagnostics are checked for the relevant subject, not a particular wording. The unsupported fixture adds `reverse` to the track and requires a contextual error until that event is supported.

The explicit output is `out/Set.als`; the project directory is its parent. `--no-collect` must reference the original file, while normal export creates `Samples/Imported`, a type-3 project-relative reference, an absolute fallback, correct original file size, and an `Ableton Project Info` directory. Determinism is checked by repeating export with `--force` at the same path, so absolute fallback paths do not vary.

Each generated score is independently compiled through the existing CLI before export, so a failing fixture cannot masquerade as a missing export. The 3/4 fixture repeats its first chord and expects locators only at changes (beats 0, 6 and 9). The default destination and folder scenarios search their respective directories for exactly one `.als` file, without prescribing its name. Master tempo and meter checks include the automation sentinel values as well as the manual values.
