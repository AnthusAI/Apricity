# Storage: one data model, three backends (design, 2026-09-24)

Kanbus initiative **Storage**. Every storage task cites a section of this file (§0–§7).

Apricitus collects structured data it must query (clips and analysis, slices, markers, curation
candidates, per-person verdicts, crates, scores, provenance). One data model, defined in
`web/amplify/data/resource.ts`, is served by three backends:

| | Backend | Who uses it | Protocol |
|---|---|---|---|
| **A** | AWS Amplify Gen2: AppSync + DynamoDB + S3 + Cognito (Google sign-in) | the hosted web app | GraphQL |
| **B** | Embedded Rust engine on a local library folder | the Swift app (UniFFI), Python analysis (PyO3), the CLI | Amplify-*shaped* operations; no GraphQL |
| **C** | `apricitus serve`: Rust GraphQL server with AppSync's schema, over the same engine and folder as B | the web app, running locally without AWS | GraphQL (same schema as A) |

Decisions (user, 2026-09-24): general engine work goes **upstream into Virtuus**
(`~/Projects/Virtuus`); `resource.ts` is the **source of truth**; local and cloud are **separate
modes** (export/import, no sync); the local web mode is the **Rust** server. Precedent: Plexus
(`dashboard/scripts/generate-control-plane-contract.ts`, `services/private-graphql-proxy`).

## §0 Principles

1. **One schema, three backends.** The web app uses the real `aws-amplify` `generateClient()` in
   both A and C; only the endpoint and `amplify_outputs.json` differ, so there's no stand-in data client.
2. **Generic engine work lives upstream in Virtuus** (it can later replace Plexus's Python proxy).
   Ripple keeps only `apricitus-data`: models, domain operations, the compile loader, migration.
3. **Records hold what's queried; attachments hold arrays and audio.** A clip's analysis arrays
   (notes, beats, beat_chroma, warp_markers, loudness) are one content-addressed JSON file.
   Annotations become records (a slice or marker per record), which ends the whole-manifest save race.
4. **Pure logic is written once in Rust** (feed ranking, ids, span validation, markup merge, score
   reference extraction), exposed to the web via wasm, to Python via PyO3, to Swift via UniFFI.
   Multi-step domain operations (`keepCandidate`) are short idempotent sequences of model
   operations, implemented in Rust and TypeScript and kept in step by shared Gherkin specs. No
   Lambdas in phase 1.
5. **Scores stay `.apr` text.** Clip paths become catalog aliases; ML slice ids and names become
   stable; a `ScoreRef` table answers "which scores use this clip or slice" and detects drift.

## §1 Data model (`web/amplify/data/resource.ts`)

```ts
const catalog = (allow) => [allow.group('members').to(['read']), allow.group('curators')];
const personal = (allow) => [allow.owner(), allow.group('members').to(['read'])];

const schema = a.schema({
  FileRef: a.customType({ key: a.string().required(), sha256: a.string().required(),
                          size: a.integer(), contentType: a.string() }),
  Proposer: a.customType({ by: a.string().required(), score: a.float().required(),
                           why: a.string().required(), evidence: a.json(), at: a.datetime().required() }),
  CandidateContext: a.customType({ seconds: a.float(), bpm: a.float(), beats: a.float(), key: a.string(), stem: a.string() }),
  SliceSource: a.enum(['user', 'ml', 'curated']),
  Kind: a.enum(['loop', 'break', 'hit', 'phrase', 'section', 'chop', 'other']),
  VerdictValue: a.enum(['keep', 'skip', 'later']),

  Recording: a.model({            // provenance / credits (from samples/sources.json)
    id: a.id().required(),        // rec_<slug>
    title: a.string().required(), collection: a.string().required(),   // "marine-band", "citizen-dj/loc-edison", "uploads"
    performer: a.string(), composed: a.integer(), recorded: a.string(),
    credit: a.string(), rights: a.string(), sourcePage: a.url(), url: a.url(),
    documents: a.ref('FileRef').array(),            // sheet-music PDFs (sources.json kind:"score")
    clips: a.hasMany('Clip', 'recordingId'),
  }).secondaryIndexes(i => [i('collection').sortKeys(['title']).queryField('recordingsByCollection')])
    .authorization(catalog),

  Clip: a.model({
    id: a.id().required(),        // clp_<sha256(audio)[:20]>; stems: sha256(parentId|stem|model)
    recordingId: a.id().required(), recording: a.belongsTo('Recording', 'recordingId'),
    path: a.string().required(),  // catalog alias used by scores: "marine-band/stems/Thunderer/drums.wav"
    aliases: a.string().array(),  // the two legacy path forms
    collection: a.string().required(), title: a.string().required(),
    role: a.enum(['source', 'stem', 'excerpt', 'upload']), stem: a.string(), stemModel: a.string(),
    parentClipId: a.id(), excerptStart: a.float(),
    audio: a.ref('FileRef').required(),
    analysis: a.ref('FileRef'),   // analysis/<clipId>/<sha256>.json = today's manifest minus annotations
    analysisVersion: a.integer(), analyzedAt: a.datetime(),
    status: a.enum(['pending', 'analyzing', 'ready', 'failed']),
    duration: a.float(), sampleRate: a.integer(), channels: a.integer(),
    bpm: a.float(), bpmStability: a.float(), meter: a.integer(), key: a.string(), camelot: a.string(),
    keysOverTime: a.string().array(), tuningCents: a.float(), noteCount: a.integer(),
    tags: a.string().array(),
    nameCounters: a.json(),       // {"loop":7,"hit":12}: ML slice names are never reused
    slices: a.hasMany('Slice', 'clipId'), markers: a.hasMany('Marker', 'clipId'),
    candidates: a.hasMany('Candidate', 'clipId'),
  }).secondaryIndexes(i => [
    i('recordingId').sortKeys(['path']).queryField('clipsByRecording'),
    i('collection').sortKeys(['path']).queryField('clipsByCollection'),
    i('path').queryField('clipsByPath'),              // resolves score references
    i('parentClipId').queryField('clipsByParent'),
  ]).authorization(catalog),

  Slice: a.model({
    id: a.id().required(),        // slc_<uuidv7>; curated: slc_<candidate hash>, so keeping twice is idempotent
    clipId: a.id().required(), clip: a.belongsTo('Clip', 'clipId'),
    name: a.string().required(), start: a.float().required(), end: a.float().required(),
    source: a.ref('SliceSource').required(), kind: a.ref('Kind'),
    tags: a.string().array(), evidence: a.json(),
    rank: a.integer(),            // ML rank (what the name used to encode)
    candidateId: a.id(), retired: a.boolean(), owner: a.string(),
  }).secondaryIndexes(i => [
    i('clipId').sortKeys(['start']).queryField('slicesByClip'),
    i('clipId').sortKeys(['name']).queryField('slicesByClipAndName'),
    i('candidateId').queryField('slicesByCandidate'),
  ]).authorization(allow => [...personal(allow), allow.group('curators')]),

  Marker: a.model({ id: a.id().required(), clipId: a.id().required(), clip: a.belongsTo('Clip', 'clipId'),
    name: a.string().required(), seconds: a.float().required(), source: a.ref('SliceSource'), note: a.string(), owner: a.string() })
    .secondaryIndexes(i => [i('clipId').sortKeys(['seconds']).queryField('markersByClip')])
    .authorization(allow => [...personal(allow), allow.group('curators')]),

  Candidate: a.model({
    id: a.id().required(),        // cand_<sha1(clipId|start|end|kind)[:16]>
    clipId: a.id().required(), clip: a.belongsTo('Clip', 'clipId'), recordingId: a.id().required(),
    start: a.float().required(), end: a.float().required(), kind: a.ref('Kind').required(), name: a.string(),
    context: a.ref('CandidateContext'), proposers: a.ref('Proposer').array().required(),
    baseScore: a.float().required(),      // max(proposers.score), copied here so it can be indexed
    legacyId: a.string(),                 // old c-xxxxxxxxxx
    verdicts: a.hasMany('Verdict', 'candidateId'),
  }).secondaryIndexes(i => [
    i('kind').sortKeys(['baseScore']).queryField('candidatesByKind'),
    i('recordingId').sortKeys(['baseScore']).queryField('candidatesByRecording'),
    i('clipId').sortKeys(['start']).queryField('candidatesByClip'),
  ]).authorization(catalog),

  Verdict: a.model({              // one per (candidate, person); per person in the cloud, judge = "local" locally
    candidateId: a.id().required(), judge: a.string().required(),
    candidate: a.belongsTo('Candidate', 'candidateId'),
    verdict: a.ref('VerdictValue').required(), stars: a.integer(), tags: a.string().array(), name: a.string(),
    judgedAt: a.datetime().required(), by: a.string(),                 // "person" | "agent:x"
  }).identifier(['candidateId', 'judge'])
    .secondaryIndexes(i => [i('judge').sortKeys(['judgedAt']).queryField('verdictsByJudge')])
    .authorization(allow => [allow.ownerDefinedIn('judge').identityClaim('sub'), allow.group('admins').to(['read'])]),

  Crate: a.model({ id: a.id().required(), name: a.string().required(), note: a.string(), owner: a.string(),
    items: a.hasMany('CrateItem', 'crateId') })
    .secondaryIndexes(i => [i('owner').sortKeys(['name']).queryField('cratesByOwner')]).authorization(personal),
  CrateItem: a.model({ id: a.id().required(), crateId: a.id().required(), crate: a.belongsTo('Crate', 'crateId'),
    position: a.string().required(),      // fractional rank string: reorder without rewriting
    candidateId: a.id(), sliceId: a.id(), clipId: a.id(), note: a.string(), owner: a.string() })
    .secondaryIndexes(i => [i('crateId').sortKeys(['position']).queryField('crateItemsByCrate'),
                            i('candidateId').queryField('crateItemsByCandidate')]).authorization(personal),

  Score: a.model({ id: a.id().required(), title: a.string().required(), folder: a.string().required(),
    format: a.enum(['apr', 'yaml']), text: a.string().required(),     // at most 300 KB, checked
    lastErrors: a.string().array(), legacyPath: a.string(), owner: a.string(),
    refs: a.hasMany('ScoreRef', 'scoreId') })
    .secondaryIndexes(i => [i('folder').sortKeys(['title']).queryField('scoresByFolder')]).authorization(personal),
  ScoreRef: a.model({             // derived when a score is saved
    id: a.id().required(),        // sref_<scoreId>_<alias>[_n]
    scoreId: a.id().required(), score: a.belongsTo('Score', 'scoreId'),
    clipAlias: a.string().required(), clipId: a.id(), clipPath: a.string(),
    sliceName: a.string(), sliceId: a.id(), start: a.float(), end: a.float(), owner: a.string() })
    .secondaryIndexes(i => [i('scoreId').queryField('refsByScore'),
      i('clipId').sortKeys(['scoreId']).queryField('refsByClip'), i('sliceId').queryField('refsBySlice')])
    .authorization(personal),

  Job: a.model({ id: a.id().required(), kind: a.string().required(), clipId: a.id(),
    state: a.enum(['queued', 'running', 'done', 'failed']), error: a.string() })   // local analysis jobs
    .secondaryIndexes(i => [i('state').queryField('jobsByState')]).authorization(catalog),
});
```

### §1.1 Authorization

Google sign-in lets any Google account sign up, so `allow.authenticated()` would be close to
public. Reads go to the **`members`** group, catalog writes to **`curators`**, plus **`admins`**.
Copy Papyrus's `amplify/auth/resource.ts` (`/Users/home/Projects/Papyrus/amplify/auth/resource.ts`):
`secret('GOOGLE_CLIENT_ID')`/`secret('GOOGLE_CLIENT_SECRET')`, callback URLs including
`http://localhost:5173/`, a domain prefix. A `preSignUp` trigger checks an email allow-list; a
`postConfirmation` trigger adds the user to `members`. Storage (`defineStorage`, name
`apricitusFiles`): `audio/*`, `analysis/*`, `documents/*` readable by `members`, writable by
`curators`; `uploads/{entity_id}/*` belongs to its owner.

### §1.2 Stable ids

- **Clips:** a source's id hashes its audio bytes (survives every path convention). A stem's id
  hashes how it was made (`parentId|stem|model`), because demucs output can change between runs.
- **Candidates:** hash the clip id instead of a path; the old id is kept in `legacyId`.
- **Slices:** uuidv7; a curated slice's id derives from its candidate's id.

### §1.3 Fixing ML slice renames (`apricitus-data::markup::merge`, pure; Python calls it via PyO3)

1. Each new ML slice is matched to an existing active ML slice of the same kind whose span
   overlaps by ≥ 0.8 IoU. A match keeps its **id and name**; only span, rank and evidence change.
2. An unmatched slice is named `{kind}-{n}` with `n` from `Clip.nameCounters`, incremented. Names
   are never reused; rank moves to the `rank` field.
3. An ML slice no longer proposed but used by a score (`refsBySlice`) becomes `retired: true`
   (hidden in the UI, still resolvable). If no score uses it, it's deleted.
4. `ScoreRef` stores `sliceId` and the span at save time; the compiler warns when a slice now
   points to a different span than when the score was saved.

### §1.4 Verdicts in the cloud and locally

In the cloud each person has their own verdicts (`judge` = Cognito `sub`) and a personal feed. A
curated **Slice** is shared catalog material, created by the first keep; stars and tags live on
each person's `Verdict`. A skip removes the Slice only if nobody else keeps it. Locally
`judge = "local"`, so the same code paths work.

### §1.5 Ranking

The ranked feed is computed, not indexed: `candidatesByKind` / `candidatesByRecording` return
candidates by `baseScore` DESC; the client fetches `verdictsByJudge(me)` and calls `rank()` (a
Rust port of `analysis/apricitus_analyze/curation.py` `rank`, via wasm on the web). Cheap at 602
candidates; needs a server-side feed near 50k (§7).

## §2 Contract, operations and code generation

### §2.1 Generation pipeline (`web/scripts/generate-contract.ts`)

Adapts Plexus's generator but runs Amplify first; the static parser is only a fallback.

1. Import `amplify/data/resource.ts` with tsx, call `schema.transform().schema` for the directive
   SDL, run `@aws-amplify/graphql-generator` `generateModels({ target: 'introspection' })` to get
   **model_introspection** (the structure the Amplify client uses at runtime, including index
   `queryField` names and associations).
2. Post-process into `contract/apricitus.contract.json`: Plexus's shape (models, fields,
   primaryKey, indexes with `queryField`, `partitionField`, `sortFields`, `sortArgument`,
   relationships, authRules, customOperations, storage) plus `identifier` (composite keys), owner
   fields and `identityClaim`, implicit hasMany indexes, enum values, customType field types,
   `storage.paths`. Its JSON Schema is `contract/contract.schema.json`.
3. Write `contract/model-introspection.json` (goes into the local `amplify_outputs.json`).
4. Write `contract/appsync.graphql`: offline SDL now; once a sandbox exists, a **snapshot of the
   deployed sandbox's real SDL** (`npx ampx generate graphql-client-code --format introspection` or
   `aws appsync get-introspection-schema --format SDL`). The local server loads this file, so its
   schema matches AppSync by construction.
5. `--check` mode (CI). The contract version is the sha256 of the three resource files.

Consumers: Rust `include_str!` of the contract in `apricitus-data` plus `cargo xtask gen-models`
(serde structs in `crates/apricitus-data/src/models.rs`); TypeScript `import type { Schema }`;
Swift `swift/ApricitusData/Sources/Models.swift`.

### §2.2 Operation semantics (identical in all three backends)

Specified to match **Amplify/AppSync behaviour**, not GraphQL syntax.

| Operation | Shape (Amplify Gen2 `client.models.X`) | Result |
|---|---|---|
| get | `get(identifier, { selectionSet? })` | `{ data: T \| null, errors? }` (missing → `null`, not an error) |
| list | `list({ filter?, limit?, nextToken?, selectionSet?, [pk + sortDirection for composite ids] })` | `{ data: T[], nextToken: string \| null, errors? }` |
| index | `X.<queryField>({ partition, <sortArg>?: keyCondition }, { filter?, sortDirection?, limit?, nextToken?, selectionSet? })` | as list |
| create | `create(input)`; `id` optional (else uuid v4); `createdAt`/`updatedAt`/owner filled in | `{ data, errors? }`; existing key → `errorType: "DynamoDB:ConditionalCheckFailedException"` |
| update | `update({ ...identifier, ...partial })`; only given fields change; `null` removes a field | missing record → ConditionalCheckFailed |
| delete | `delete(identifier)` | returns the deleted item; missing → ConditionalCheckFailed |
| custom | `client.queries.X` / `client.mutations.X` (none in phase 1) | `{ data, errors? }` |

- **Filters:** `eq ne lt le gt ge between beginsWith contains notContains attributeExists size`,
  combined with `and`/`or`/`not`, DynamoDB rules: `contains` on a list checks membership; `ne`
  matches a missing field; comparisons against a missing field are false.
- **Key conditions:** `eq lt le gt ge between beginsWith`; composite sort keys take a key object.
- **`limit` applies before the filter** (DynamoDB). Default 100. A page can be short or empty
  while `nextToken` isn't null: callers loop until `nextToken` is null.
- **Order:** `list` is sorted by primary key locally but unordered in the cloud; tests compare list
  results as sets, index queries as sequences.
- **nextToken:** opaque base64url of `{v, model, index, partitionHash, lastKey: {pk, sort}, argsHash}`;
  key-based (continue after the last key), so it survives concurrent inserts; a mismatched token →
  `errorType: "ValidationException"`.
- **Relationships:** hasMany returns `ModelXConnection` (filter, sortDirection, limit, nextToken)
  through the index Amplify creates on the foreign key (the engine creates the same implicit
  index); belongsTo returns an object. In the Rust API, `selectionSet: ["id", "slices.*"]` maps to
  Virtuus `include`.
- **Errors:** `[{ message, errorType, path?, locations?, errorInfo? }]`, types `Unauthorized`,
  `DynamoDB:ConditionalCheckFailedException`, `ValidationException`, `NotFound` (Rust, files only),
  `Internal`. Data errors never throw.
- **Consistency:** DynamoDB indexes are eventually consistent, the local engine strongly
  consistent. App code must not read its own write back through an index.

## §3 Local engine

### §3.1 Virtuus upstream (release 0.6.0+, Cargo workspace in `~/Projects/Virtuus/rust/`)

**`virtuus` (core)**
- **Storage trait** replacing the hard-wired `std::fs` in `table.rs`:
  ```rust
  pub trait Storage: Send + Sync {
      fn list(&self, dir: &str) -> Result<Vec<Entry>>;          // name, size, mtime/etag
      fn read(&self, path: &str) -> Result<Option<Vec<u8>>>;
      fn write_atomic(&self, path: &str, bytes: &[u8]) -> Result<()>;
      fn delete(&self, path: &str) -> Result<bool>;
      fn stat(&self, path: &str) -> Result<Option<Meta>>;
      fn lock(&self, name: &str) -> Result<Box<dyn LockGuard>>; // flock via fs4
      fn local_path(&self, path: &str) -> Option<PathBuf>;       // zero-copy for audio
  }
  ```
  `FsStorage`, `MemoryStorage` (tests, wasm); `OpfsStorage` later.
- **`pub enum Error`**: `NotFound`, `ConditionalCheckFailed`, `Validation`, `UnknownTable`,
  `UnknownIndex`, `InvalidToken`, `Io`, `Parse{path}`, `Locked`. Every public function returns
  `Result`; the panicking versions are deprecated for one release.
- **O(n²) load fix:** `lookup_existing_record_from_load` scans `record_keys` per file
  (`table.rs` ~880); add a reverse `HashMap<key, filename>`.
- **Ordered indexes:** GSI buckets become `BTreeMap<(OrderedValue, pk), ()>` (seek-after-key
  O(log n)); base tables get a `BTreeMap` over the primary key.
- **Key-based pagination** replaces offset tokens (`database.rs` ~309).
- **Multi-process change log:** each write takes the library lock (`.virtuus/lock`), refreshes
  from the log, checks its condition, writes atomically, appends to `.virtuus/changes.jsonl`
  (`{seq, table, key, op, at}`). Readers stat the log before each operation and apply only new
  entries; no log → fall back to mtime `refresh()`. Compacted after N entries; gitignored; safe to delete.
- **`subscribe()`** fed by the log (GraphQL subscriptions, UniFFI callbacks).
- `rayon` optional (not on wasm); `clap` out of the library build.
- Persisted index snapshots deferred until a benchmark needs them; Apricitus tables use
  `StorageMode::Memory` (records are small).

**`virtuus-amplify`**: `Contract::from_json`; `Engine::open(storage, contract, opts)` creates
tables, indexes (incl. implicit hasMany) and composite identifiers (more than two fields → the sort
field is the rest joined with `#`, as Amplify does); type validation from the contract; timestamps,
uuids, `__typename`; `Identity { sub, username, groups }` fills owner fields, rules enforced when
`enforce_auth` is on (always in tests); filter evaluator, key conditions, create/update/delete
rules, selection sets, relationship resolution; `OpResult { data, errors, next_token }`; a generic
`call(&OpRequest{model, op, args, options}, &Identity) -> OpResult` used by GraphQL resolvers,
UniFFI and PyO3; a local-only `transact(|tx| …)` holding the library lock.

**`virtuus-blobs`**: `put(key, bytes | src_path, content_type) -> FileRef{key, sha256, size}`,
`get`, `head`, `delete`, `list(prefix)`, `local_path`, rooted at `files/`.

**`virtuus-appsync`** (GraphQL server library): an axum router over **async-graphql
`dynamic::Schema`**, built at startup by parsing `contract/appsync.graphql`
(`async_graphql_parser::parse_schema`). AWS scalars (`AWSDateTime`, `AWSJSON`, `AWSURL`,
`AWSEmail`, `AWSTimestamp`, …) as custom scalars; `@aws_*` directives declared and ignored. Root
fields bound by name through the contract (`get*`, `list*`, index `queryField`s,
`create*`/`update*`/`delete*`, `on{Create,Update,Delete}*`); relationship fields through the
contract's relationships. AppSync error envelopes. **Realtime:** the AppSync WebSocket protocol at
`/graphql/realtime` (`connection_init`, `connection_ack` with `connectionTimeoutMs`, `ka`, `start`
with the payload `{query, variables}` as a string and auth in `extensions.authorization`,
`start_ack`, `data`, `error`, `stop`, `complete`), subscription `filter`/`owner` arguments applied
to engine change events. API-key auth: `x-api-key` → a configured Identity.

Specs in Virtuus `features/` (Gherkin is the source of truth there) under `storage/`, `errors/`,
`pagination/`, `amplify/`, `concurrency/multiprocess.feature`. New crates are Rust-only: tag their
specs `@rust-only` (parity policy for Virtuus core changes: both languages).

### §3.2 Ripple crates

- **`crates/apricitus-data`** (depends on `virtuus-amplify`, `apricitus-score`):
  `Library::open(dir, identity)`, `Library::create(dir)`; typed facades generated from the contract
  (`lib.models().clip().get(id)`, `.slices_by_clip(clip_id, opts)`); `ids` (`clip_id`,
  `stem_clip_id`, `candidate_id`, `curated_slice_id`); `domain`: `propose(Vec<Proposal>)`
  (validate, merge by id and proposer), `judge(JudgeInput)` (verdict → crate items → curated
  slice; idempotent), `rank(&[Candidate], &[Verdict]) -> Vec<Ranked>`, `markup::merge`,
  `save_score(id, text)` (parse, write `ScoreRef`s via `apricitus_score::references()`),
  `crate_to_apr`; `loader::make(&Library) -> impl FnMut(&Path) -> Result<Clip, String>` — look up
  the alias with `clipsByPath` (fallback `aliases`), load the analysis attachment, active and
  retired slices and markers, rebuild the old manifest JSON with `annotations`, call
  `Clip::from_json(audio_local_path, json)`. The existing `compile_with` seam and
  `Renderer::new(sr, loader)` don't change. Also `migrate` and `transfer` (§5).
- **`apricitus-score`** gains `pub fn references(score, base_dir) -> Vec<Ref{alias, source, slice:
  Option<String>, kit_pad: Option<String>}>` (extends `source_paths` to slices referenced from kits)
  and an optional id form: `clip x = @clp_… slice @slc_…`.
- **`crates/apricitus-ffi`** (UniFFI, Swift):
  ```rust
  #[derive(uniffi::Object)] pub struct ApricitusLibrary { .. }
  #[uniffi::export] impl ApricitusLibrary {
    #[uniffi::constructor] fn open(path: String, identity_sub: Option<String>) -> Result<Arc<Self>, DataError>;
    fn call(&self, model: String, op: String, args_json: String, options_json: Option<String>) -> String; // {data, errors, nextToken}
    fn keep_candidate(&self, input_json: String) -> String;   fn feed(&self, args_json: String) -> String;
    fn file_put(&self, key: String, src_path: String, content_type: String) -> Result<FileRef, DataError>;
    fn file_path(&self, key: String) -> Option<String>;
    fn subscribe(&self, model: Option<String>, listener: Box<dyn ChangeListener>) -> Arc<Subscription>;
    fn contract_json(&self) -> String;
  }
  ```
  Generated Swift wrappers mirror the JS client (`try await client.models.clip.get(id:)`,
  `client.models.slice.slicesByClip(clipId:, options:)`) returning `Result<T>` with `data`,
  `errors`, `nextToken`. `scripts/build-xcframework.sh`: build `aarch64-apple-darwin`,
  `aarch64-apple-ios`, `aarch64-apple-ios-sim` → `uniffi-bindgen generate --library` →
  `xcodebuild -create-xcframework` → SwiftPM `binaryTarget` in `swift/ApricitusData/Package.swift`.
- **Python:** one PyO3 module `apricitus_data` (maturin, `apricitus-data` with a `python` feature):
  `Library(path).models.Candidate.create(...)`, `.propose()`, `.judge()`, `.feed()`,
  `.apply_markup()`, `.files.put()`, `.call()`. `analyze.write`, `markup.run`, `stems`,
  `curation.Store` call it; the terminal feed UX stays. Works without the server; the server sees
  its changes through the change log.
- **wasm:** `apricitus-web` gains `rw_rank`, `rw_ids`, `rw_markup_merge` (pure). A full engine on
  `MemoryStorage` compiles once `rayon` is optional; an offline OPFS browser library is a deferred
  fourth mode.

### §3.3 Library folder layout

```
MyLibrary.apricitus/
  apricitus-library.json      # {format:1, contractVersion, libraryId, identity:{sub:"local", groups:[...]}, apiKey}
  tables/<Model>/<key>.json   # one JSON file per record; composite key: <pk>__<sort>.json (Virtuus convention)
  files/                      # exactly the S3 keys
    audio/<clipId>/<original-filename>
    analysis/<clipId>/<sha256>.json
    documents/<recordingId>/<file>.pdf
  .virtuus/                   # derived, deletable: lock, changes.jsonl, index snapshots (gitignored)
```

## §4 `apricitus serve` and the web app

**`apricitus serve --library <dir> [--port 5181]`** (a subcommand of `apricitus-cli`, axum, bound
to 127.0.0.1):
- `POST /graphql` + `GET /graphql/realtime` (WebSocket): `virtuus-appsync` on `apricitus-data`'s engine.
- `/amplify_outputs.json` generated per library: `data: { url: "http://127.0.0.1:5181/graphql",
  aws_region: "local", api_key, default_authorization_type: "API_KEY", authorization_types: [],
  model_introspection }`, `custom: { apricitus: { mode: "local", identity } }`, no `auth` or
  `storage` sections.
- `GET/PUT/HEAD/DELETE /files/*key` with **Range** support (30 MB WAVs seek).
- `POST /jobs/analyze`: creates a `Job` record, runs `python -m apricitus_analyze.job --library …
  --clip …`; status via normal GraphQL queries/subscriptions.
- Static `web/dist` + wasm with the COOP/COEP headers `server.py` sets today, embedded in the
  binary (as Kanbus's `kbsc` does).
- `server.py` retired once parity is reached.

**Mode switching: runtime bootstrap (Kanbus style), not build-time aliases.** `main.ts` fetches
`/amplify_outputs.json` and calls `Amplify.configure(outputs)`; `custom.apricitus.mode` picks the
auth and storage facades. One build works in both modes. The data client is the real
`generateClient<Schema>()` either way.

- **Storage facade** `web/src/data/files.ts` with the signatures of `aws-amplify/storage`
  (`uploadData`, `getUrl`, `downloadData`, `remove`): dynamic import of `aws-amplify/storage` in
  the cloud, `/files/` locally. (Emulating S3 locally would need SigV4, a custom endpoint and
  multipart uploads for nothing.) App code imports only from `data/files`.
- **Auth facade** `web/src/data/auth.ts` (`getCurrentUser`, `signInWithRedirect({provider:
  'Google'})`, `signOut`, `fetchAuthSession`): locally returns the library's identity; the API key
  maps it to `sub:"local"` with every group, so owner rules resolve to the local user.
- **Web domain operations** `web/src/data/domain.ts`: `keepCandidate`, `saveSlice`, `saveScore`,
  `applyVerdict` (idempotent sequences over the client; `rank`/`ids` from wasm). The whole-object
  `api.saveAnnotations` becomes per-slice `Slice.create`/`update`/`delete`. Before compiling a
  score, fetch clips (`clipsByPath`), analysis (`getUrl`) and slices, then `rw_compile`.
- **Subscriptions:** if the Amplify client refuses plain `ws://` for a non-AppSync host, `serve`
  uses TLS with an mkcert certificate. Until realtime ships, the app avoids `observeQuery` and `onCreate`.

## §5 Migration and score references

`apricitus migrate --from <repo root> --to <library>` (in `apricitus-data`; deterministic and
idempotent, a second run changes nothing):

1. **Recordings** from `samples/sources.json`: one per Marine Band piece, one per Library of
   Congress item id for Citizen DJ (e.g. `00694038`, with its excerpt clips). `kind:"score"` PDFs
   become `Recording.documents` under `files/documents/`.
2. **Clips** from every `*.apricitus.json`: id from `source.sha256`; stems use `derived_from` for
   `parentClipId` and the stem-style id; `path` = samples-relative; `aliases` = the repo-relative
   and `derived_from.source` forms. Audio is copied with APFS `clonefile` or hard-linked (`--link`),
   so the 430 MB isn't duplicated. Analysis = the manifest minus `annotations`, canonical JSON at
   `files/analysis/<id>/<sha>.json`; summary fields go on the Clip record.
3. **Slices and markers** from `annotations`: ids `slc_<sha(clipId|name)>` (idempotent re-runs);
   `nameCounters` seeded from existing `loop-N`/`hit-N` names.
4. **Candidates** get new ids (`legacyId` kept), `proposers` copied, `baseScore` computed.
   **Verdicts** get `judge:"local"`; stars and tags move off the slices. **Crates** → Crate +
   CrateItem (positions `a0`, `a1`, …). Curated slices get the candidate-derived id.
5. **Scores:** `examples/*.apr|yaml` and `scores/*` → Score records (`folder`, `legacyPath`,
   `text`); `save_score` builds `ScoreRef`s. `samples ../samples` resolves to the catalog, so paths
   are looked up as aliases. Anything unresolved is reported and makes the run exit non-zero.
6. **Check:** every example renders sample-for-sample the same from the files and from the library.

The `.apr` text doesn't change: `clip brk = marine-band/stems/Thunderer/drums.wav slice loop-1`
resolves by alias, and `loop-1` is now fixed to the slice it named at migration time.

**Transfer between modes** (`apricitus-data::transfer`): copies all models and files between two
backends. Local↔local through the engine; either direction with the cloud through GraphQL (the same
generated statements) plus S3 via `web/scripts/transfer.ts` and the real Amplify client.
`--as <sub>` rewrites `owner`/`judge` from "local" to the target user. A round trip local → cloud →
local must give identical tables and file hashes.

## §6 Phases and verification

| # | Milestone | Checked by |
|---|---|---|
| P0 | `web/amplify/{data,auth,storage}`, the generator, `contract/*` (sandbox later, user-gated) | Typecheck; generator `--check`; deterministic output. |
| P1 | Virtuus core: Storage, `Result`, O(n²) fix, ordered indexes, key tokens, lock + change log, blobs | Existing suite in both languages; new `storage/`, `pagination/`, `concurrency/multiprocess`; a 50k load scales linearly. |
| P2 | `virtuus-amplify` | Conformance corpus v1 in-process; every §2.2 row has a scenario. |
| P3 | `apricitus-data`, `references()`, `migrate` | Idempotent migration; identical renders; Rust `rank` = Python `rank`; markup merge keeps ids/names and retires used slices. |
| P4a | `virtuus-appsync`, `apricitus serve`, web on `generateClient`, `server.py` data endpoints retired | Introspection = SDL; corpus through the real Amplify client against `serve`; Playwright end-to-end. |
| P4b | Realtime | Subscription scenarios against `serve` (and the sandbox later). |
| P5 | Python through PyO3 | `analysis/tests` ported and green; concurrent writers lose nothing. |
| P6 | Cloud: sandbox, Google sign-in, transfer | Round trip identical; corpus green on the sandbox, incl. unauthorized cases. |
| P7 | `apricitus-ffi`, XCFramework, Swift wrappers | `swift test` corpus smoke subset; a sample app opens a library. |

**Conformance corpus:** Gherkin in `features/data/` (crud, filters, key conditions, pagination,
relationships, owner, subscriptions, `domain/keep`, `markup_merge`, `score_refs`). Three runners
share one step vocabulary (`features/data/STEPS.md`): TypeScript (cucumber-js + real
`aws-amplify`, `TARGET=local|sandbox`), Rust (cucumber-rs on `Engine::call`; stands in for Swift,
plus a `swift test` smoke subset), Python (behave on PyO3, domain operations). Comparisons ignore
generated ids, timestamps and tokens; lists compare as sets, index queries as sequences; pages are
collected until `nextToken` is null. A raw GraphQL test sends the Amplify-generated statements to
both endpoints and diffs normalized responses.

## §7 Risks and open questions

1. **Matching Amplify exactly:** `limit` before filter; how `a.json()` values come back (string or
   parsed); `identityClaim('sub')` with `ownerDefinedIn`; whether enum fields can be index partition
   keys (if not, make `kind` an `a.string()` checked in domain code); composite identifiers with
   more than two fields. Settle each against the sandbox and freeze as scenarios.
2. **Realtime without TLS** may be refused by the Amplify client; fallback mkcert. Spike early.
3. **Getting the SDL offline:** `schema.transform()` / `@aws-amplify/graphql-generator` are
   semi-internal; the sandbox snapshot is the authority, Plexus's static parser the fallback.
4. **Multi-step operations aren't atomic in the cloud** (keep = Verdict → CrateItem → Slice);
   derived ids make them safe to repeat. If partial failures appear, move them into an AppSync JS
   pipeline resolver or a Lambda. Slice-name uniqueness per clip is enforced in domain code only.
5. **Domain logic in two languages** (TypeScript and Rust); shared specs limit the risk.
6. **Size limits:** cloud feed ranking near 50k candidates; cap `proposers` per proposer; Score
   `text` ≤ 300 KB; DynamoDB items ≤ 400 KB.
7. **No analysis in the cloud:** essentia/beat_this don't fit Lambda. For now: ingest locally, then
   transfer; Batch/Fargate later. Open.
8. **Synced folders** (iCloud, Dropbox) break file locking and the change log; iOS needs
   `NSFileCoordinator`. Libraries are local-disk only for now.
9. **Upstream coordination:** Virtuus API changes (`Result`, token format) affect Plexus; semver
   minor with a deprecation window; consider moving Plexus's proxy onto `virtuus-appsync`.
10. **Multi-tenancy:** one catalog per deployment, no `libraryId` partition (adding one later needs
    a migration).
11. **Stem ids** come from how the stem was made; re-separating with another model makes a new clip.
