# Sources step vocabulary (normative)

Runner: cucumber-rs, `crates/apricity-sources/tests/conformance.rs`. Tests never touch the network:
the runner uses a fake in-memory `Fetcher` and a fresh temp directory per scenario.

## State
- **root:** a fresh temporary samples directory.
- **source:** the fixture source `demo` (built by the Given steps below).
- **served:** URL -> bytes served by the fake fetcher. Every file's URL is `https://fake.test/<path>`.
- **downloads:** how many times the fake fetcher was called.
- **report / statuses / events / error:** results of the last When step.

## Given
| Step | Meaning |
|---|---|
| `Given a source "demo" with these files:` | Table with columns `path`, `content`, `fetch` (`http` or `manual`), `sha256` (`ok` = digest of content, `wrong` = a bad digest, empty = none). The fake fetcher serves `content` at each file's URL. |
| `Given the file {string} already contains {string}` | Write that content under root. |
| `Given a partial download {string} contains {string}` | Write `<path>.part` under root with that content. |
| `Given an unrelated file {string} exists` | Write `<path>` under root that belongs to no source. |
| `Given the source "demo" serves wrong bytes for {string}` | The fake fetcher serves different bytes than the catalog's sha256 expects. |
| `Given the server is unreachable for {string}` | The fake fetcher returns an error for that file's URL. |

## When
| Step | Meaning |
|---|---|
| `When I list the sources` | `list_sources()` (the embedded catalog). |
| `When I check the status` | `status(source, root)`. |
| `When I fetch the source` | `fetch(...)`, collecting progress events. Resets `downloads` first. |
| `When I remove the source` | `remove(source, root)`. |

## Then
| Step | Meaning |
|---|---|
| `Then the catalog has source {string} with {int} files` | Listed source with that id and file count. |
| `Then the catalog has {int} sources` | Number of listed sources. |
| `Then the status of {string} is {word}` | `missing`, `present` or `corrupt`. |
| `Then the file {string} exists with content {string}` | Final file exists with that content. |
| `Then the file {string} does not exist` | No final file. |
| `Then no partial files remain` | No `*.part` files under root. |
| `Then {int} files were downloaded` | `downloads` equals the number. |
| `Then the fetch succeeds` / `Then the fetch fails` | Outcome of the last fetch. |
| `Then the report lists {string} as {word}` | Report entry outcome: `downloaded`, `skipped`, `manual`, `failed`. |
| `Then the report records a sha256 for {string}` | Report holds the computed digest of the file. |
| `Then the progress events include {word} for {string}` | Events: `started`, `bytes`, `finished`, `skipped`, `manual`, `failed`. |
| `Then the first progress event for {string} is {word}` | Ordering check. |

## Archive sources (features/sources/archive.feature)
The fixture source `kit` has an archive at `https://fake.test/kit.tar.bz2` (built in memory by the runner,
`into` = `kit`). Table paths are samples-root relative (`kit/OH/kick.wav`); the tar entry is the path minus `kit/`.
The archive counts as one download.

| Step | Meaning |
|---|---|
| `Given an archive source "kit" with these files:` | Table `path`, `content`. Builds the tar.bz2, the archive sha256/size, and file entries (fetch=archive, sha256 of content). |
| `Given the archive "kit" is served with wrong bytes` | The fake serves other bytes than the catalog sha256. |
| `Given the archive "kit" also contains the entry {string}` | Adds a raw tar entry (e.g. `../evil.txt`), archive sha256 recomputed. |
| `Given the archive "kit" also contains a symlink {string}` | Adds a symlink entry. |
| `Given the archive "kit" lacks the entry {string}` | Omits a listed file from the tar. |
| `Then nothing exists under {string}` | The directory is absent or empty (no files, no `.archive.part`, no staging). |
| `Then no staging directory remains` | No `.extract` directory under root. |
| `Then the source {string} is an archive extracted into {string}` | Catalog source has `archive` with that `into`, format tar.bz2, size and sha256 set. |
| `Then the progress events include extracting for {string}` | The `extracting` event (path = archive label `<into>/.archive.part`). |

Archive progress: `started`, `bytes`, `finished` use the label `<into>/.archive.part`; then `extracting`; then
`finished` per extracted file. Extraction goes through `<into>/.extract/`, removed at the end.
