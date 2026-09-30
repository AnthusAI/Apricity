# Semantic audio features

Status: specifications accepted for bounded implementation; no compatibility, performance, cloud-recall, or listening gate has yet been measured. Initiative: apricitus-9cbb4b. Supervisor task: apricitus-cc5a3d.

## Intent, ownership, and delivery

As a visitor, I want to find and explore playable audio by meaning and sound without losing existing text search. As a curator, I want reproducible ground-generated groupings and explicit publication so drafts and stale audio never leak.

The supervisor owns specifications, decisions, review, fixture judgments, and integration. Terra implements the Kanbus packets below. Subagents never commit, push, close issues, deploy, release, or edit the board files directly. Product commits use each reviewed task ID as Conventional Commit scope on develop. Board changes land separately on develop via kbs commit and origin develop. Production release/deployment remains Semantic Release on main.

All M0–M5 specifications and Kanbus stories exist before any production implementation dispatch. Executable acceptance files are features/semantic-audio/m0.feature through m5.feature. Bindings must assert observable results, not unconditional successful steps. Each implementation packet writes its RED test first and supplies RED/GREEN evidence. A feature cannot be called complete while its specification or required model-backed gate is failing or not evaluated.

Dependencies: M0 → M1 → M2; M3 depends M0 and M1; M4 depends M0; M5 depends M1 and M4. Contract and isolated test scaffolding may be prepared in parallel once their prerequisite contracts are accepted; dependent integration and rollout do not bypass gates.

Excluded: cloud text inference, browser audio inference, another embedding model, WebGPU in initial delivery, lexical-search redesign, deep vector pagination, automatic draft publication, manual AWS deployment, upstream Virtuus changes, and copyrighted/large fixture audio in git.

## Common embedding and identity contract

All timestamps at API/card/playback boundaries are seconds, half-open [start,end). Canonical identity encodes rounded integer microseconds (round-half-up), forbids negative/nonfinite times and requires end > start. Canonical parent IDs come from current library Sample/Recording/Clip records, not guessed filesystem paths.

Initial embeddingSpace is clap-htsat-unfused-512-v1. It identifies the model checkpoint, projection, tokenizer and their revisions, not a display title. A different projection/checkpoint/tokenizer revision requires a new space; versions never mix.
Ground checkpoint: laion/clap-htsat-unfused revision 8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a.
Browser export: Xenova/clap-htsat-unfused revision c28f2883575e590e04d3146ff0713c2448d691ba.
Browser runtime: @huggingface/transformers 3.8.1, ClapTextModelWithProjection, q8, wasm, text-only weights. Asset manifest pins tokenizer/config/weights and runtime; no moving main requests. Fetch/cross-origin isolation behavior must be verified in Apricity's actual server headers.

A vector is exactly 512 finite numbers, normalized to L2 norm 1 with tolerance 1e-4. Zero or near-zero (norm <= 1e-9), nonfinite and wrong-dimensional vectors are rejected. Producers normalize; retrieval validates rather than accepting arbitrary scales. Scores are raw dot products, not confidence probabilities.

SemanticIdentity fields:
- semanticId: sha256 of canonical compact ordered JSON tuple [sampleId,recordingId,kind,clipId-or-null,startUs,endUs,audioSha256,embeddingSpace,processingFingerprint], lowercase hex.
- kind: saved_clip | window. clipId required for saved_clip and absent for window.
- sampleId, recordingId: nonempty canonical strings.
- start, end: finite source seconds; optional startBeat/endBeat are display provenance, not substitutes for source times.
- audioSha256: current Sample.audio.sha256, 64 lowercase hex characters.
- embeddingSpace and processingFingerprint: nonempty versioned strings.

SemanticRecord adds vector, display {samplePath,sampleTitle,clipName?,clipKind?,tags}, playback {fileKey,start,end}, revision and metadataUpdatedAt. The canonical visibility/revision policy at retrieval, not cached display metadata, decides access. Revision covers audio/boundaries/version/fingerprint; rename changes only display metadata. Saved clips and window identities are never conflated; deduplication for clustering explicitly retains aliases.

Processing manifest v1: mono float32, nonfinite waveform rejected, deterministic soxr HQ resampling to 48000 Hz, centered contiguous 10-second crop after resampling when longer than 480000 frames (floor((N-480000)/2)); model's pinned repeatpad behavior for shorter input. Do not let CLAP randomly truncate longer inputs. Ground runtime/library versions and preprocessing manifest determine processingFingerprint. Text tokenization is pinned, padded, and truncates at the checkpoint configuration's maximum sequence length identically in Python/browser. Record effective length in evaluation artifacts.

Sidecar contract v2 extends existing arrays with semantic/processing/model versions, per-clip canonical identity or stable source reference, names, boundaries and fingerprints, and window-grid fingerprints. Audio hash alone is insufficient freshness. Legacy sidecars are stale. Rename-only reconciliation updates clip names/display without invoking inference. Changed boundary/audio/preprocessing/model invalidates affected vectors; changing BPM/meter/beat grid invalidates affected windows. Retirement/deletion removes the corresponding retrieval record, even if an old sidecar still exists. Writes use atomic replacement and leave a report for every invalid region rather than silently indexing zero vectors.

## Deterministic fixtures and evaluation

Shared small fixtures live outside project/ under fixtures/semantic-audio. Use 512D e0, e1, (e0+e1)/sqrt(2), -e0; samples A and B share recording R1, C uses R2, D uses R3. A clips a1 [0,4), a2 [4,8), window [0,8); C clip c1 [1,5). Include rename a2, boundary edit a1 [0,3), retired clip, hidden D, wrong space E, missing/zero/NaN vectors, duplicated source regions and explicit outliers. Synthetic audio is generated at test time. A JSON schema validates interchange; Python/TS/Rust fixtures must agree.

Evaluation prompts are fixed, versioned strings covering drums, rain, bass, vocals, ambience and metallic sounds. Python reference projected text vectors come from the pinned checkpoint; audio references have full region/preprocessing provenance. Relevance judgments include reviewer, time, prompt, semanticId and ordinal relevance; unreviewed judgments never imply approval.

Required real-model gates: repeated audio analysis equivalence; browser/Python cosine >=0.98 for EVERY prompt; mean Python/browser top-20 set retention >=0.90 (at least 20 audio candidates; tied ordering stable); proposed warm p95 <=2000ms desktop and <=5000ms designated mobile. Include device/browser/runtime, cache state, sample count, raw timings and nearest-rank p95. A missing device, unavailable model, or skipped test produces not_evaluated and nonzero gated command exit. Supervisor judges listening relevance; map appearance is not a quality metric. Quantization failing parity is a blocker, not permission to change model or inference location.

## M1 publication and retrieval contracts

Ground command: lab semantic publish --catalog <canonical-export.json> --samples <root> --output <local-corpus.json> [--dry-run] [--checkpoint <path>]; optional cloud table/region adapter uses the same records. Canonical export has Sample/Clip/Recording lists or equivalent adapter with exact IDs. Missing or ambiguous mapping is an exclusion with reason and coverage, not a synthetic identity. Explicit scoped reconciliation deletes obsolete rows only for samples within the run's declared scope. Unrelated records survive interruption and retirement. Checkpoints advance only after successful idempotent batches; resumption repeats safe upserts. Report eligible/indexed/excluded/retired counts per kind, excluded reasons, embeddingSpace, newest update and lag. Local snapshots are atomic. Cloud recovery uses key lookups/partition Query, not catalog Scan.

Dedicated DynamoDB table is PAY_PER_REQUEST with embeddingSpace partition key and semanticId sort key; native vector index has 512 dimensions DOT_PRODUCT and a minimal INCLUDE metadata projection. Equality inline filters may constrain kind/sampleId. Verify current AWS SDK/CDK support against official API rather than inventing property names; use low-level CloudFormation overrides only with tested schema. Index eventual consistency is expected. IAM grants the server SearchVectors on the vector index ARN and only required canonical BatchGet/Get/query permissions. Public identities get no direct vector table access. Ground publisher rights are separate, least-privileged; do not introduce a third Sample stream consumer.

One typed web function:
searchAudio({embeddingSpace,queryVector,kind?,sampleId?,limit?}, {signal?}) -> {hits,embeddingSpace,candidateCount,filteredCount}.

kind is saved_clip | window. limit defaults 24, integer range 1..100. Requests with invalid vectors/types/version/ranges receive structured HTTP 400; unsupported configured space 409; transient unavailable index 503 with retryable true. No nextToken/deep pagination is exposed. API POST /semantic/search is configured by custom.apricity.semanticUrl, local same-origin base /semantic. Cloud endpoint may be API Gateway+Lambda; browser does not query DynamoDB directly. Return only currently authorized cards.

Hit = {score,identity,parent:{sampleId,recordingId,samplePath,sampleTitle},timeRange:{start,end},card:{clipId?,clipName?,clipKind?,tags},playback:{fileKey,start,end}}. Vector is not projected into search results. Sort descending score, then semanticId ascending for ties. Local exact dot search uses published local records, but independently checks current canonical models before responding. Cloud uses SearchVectors once for at most100 candidates then canonical current checks; post-filtering may leave fewer results and does not trigger scans. Resolve current parents, audio hash, clip membership/range/retirement/visibility, space/fingerprint/revision. Missing canonical source denies hit. Hydrate display and playback from current canonical records. Hidden/deleted samples, changed boundaries/audio and retired clips cannot be exposed by stale index rows. Window boundaries must still belong to the current analysis/grid revision. Follow existing catalog license/visibility policy; status fields alone are not an invented new visibility model.

Cloud adapter tests spy on AWS command type and prove no Scan. Separate sandbox evaluation reports ANN recall@20 vs local exact baseline; lacking sandbox is explicitly not_evaluated, not ordinary-test success.

## M2 related audio contracts

POST /semantic/related {embeddingSpace,sampleId,clipId?,limit?} returns {state: ready|awaiting_analysis,hits}. No browser text encoder. Source vectors are server-side stored records validated against canonical current source. A missing or stale source vector gives awaiting_analysis; never use whole-sample embedding as a fake clip embedding.

Clip uses its own vector. Sample chooses up to4 valid passage vectors, starting with smallestsemanticId; repeatedly maximize minimum (1-dot) distance to selected vectors, tie smallestsemanticId. Retrieve candidates for each, merge by semanticId with maximum similarity. Related samples group by sampleId and retain maximum-score passage. Exclude all source-sample regions. Rank scores descending with identity ties. Diversify recordings: first strongest remaining match per recording in global score order, then remaining candidates in score order until limit (default6,max24). Stored vector queries bypass text-only model loading.

Related by sound appears on clip/sample detail pages with existing card style, six initial playable suggestions, matched time ranges and parent links. Raw scores stay internal. Load state is distinct from zero results; missing source means Awaiting analysis; request failure shows retry. Navigation invalidates pending responses. Playback auditions precisely the savedclip or window's source range.

## M3 browser/hybrid contracts

Web Worker protocol messages carry requestId. encode {requestId,text}; cancel {requestId}; progress {requestId,loaded,total?,phase}; result {requestId,embeddingSpace,vector}; error {requestId,code,message,retryable}. Cancellation need not stop a WASM kernel but must suppress stale results. Model imports/loading happen only for a nonempty audio search, not page boot or related lists. Use approved text-only q8 WASM model, not full CLAP or audio tower. Approximate first-use weights127MB; show loading/download progress and meaningful retry. Cache model files persistently when available; memory fallback with storage warning keeps encoding usable. Query LRU128 keyed by pinned manifest + trimmed text. Do not case-fold prompts differently from Python evaluation.

Existing lexical search remains immediate and its ordering unchanged. Automatic semantic search starts600ms after last edit; Enter submits immediately. Separate clearly labelled Sound matches groups never interleave lexical ranking. Each controller generation invalidates timers/inference/results on newer query, clearing, navigation, or view disposal; abort HTTP requests where possible.

Global search exposes sound clips and sample passages; Samples groups hits by parent sample retaining best passage; Clips requests saved_clip only. Existing filters apply identically to both sources, including kind, stars, mine, source, sample path and length where applicable. Candidate cap100 precedes client grouping/filtering; fewer matches are legitimate. Non-audio sections don't load the encoder unnecessarily. Download/cache/inference/retrieval failures preserve lexical results and show semantic retry. Storage failure alone can fall back to memory, but cannot claim persistent caching worked.

Real browser tests verify worker/assets under Apricity COEP headers, first-use progress, repeat cache, offline and blocked storage, Enter, typing races and navigation. WebGPU is excluded pending its own parity/performance packet.

## M4 immutable clustering contracts

Ground command: lab semantic cluster --corpus <file> --preset broad|useful|fine --output <directory> [validated overrides]. Snapshot includes only current valid records from one space. Dedup key recordingId+audioSha256+startUs+endUs+space+fingerprint; pick smallest semanticId and retain all semantic aliases/member parents. Sorted canonical identities plus vector float32 bytes determine corpus digest. No mixed model spaces.

Presets:
- broad (Broad sounds): neighbors50,min_cluster_size40,min_samples10.
- useful (Useful crates): neighbors30,min_cluster_size15,min_samples5.
- fine (Fine texture): neighbors15,min_cluster_size5,min_samples3.

UMAP input cosine, output10D,min_dist0,random_state42,single-thread pinned libraries. HDBSCAN Euclidean,eom; membership probability is not audio confidence. Independent display UMAP2D,min_dist0.1. Effective neighbors clamp2..N-1 and spectral n_components <=N-2; cluster minimum sizes/samples clamp to availableN. Record requested/effective parameters. N<5 bypasses algorithms: explicit outliers and deterministic display positions, no fabricated clusters.

Run manifest {schemaVersion,runId,corpusDigest,embeddingSpace,processingFingerprints,algorithmVersions,preset,requestedParams,effectiveParams,seed,createdAt,state:draft,clusters,members,outliers,qualityReview}. runId hashes corpus+configuration+algorithmversions; repeated run reuses immutable artifacts instead of replacing content (createdAt outside content digest). IDs are run-specific cluster labels, never promised stable across presets. members contain semanticId/aliases, clusterId-or-null, membership, x,y. Every region appears once; outliers explicit.

Clusters store normalized mean centroid (if near-zero use deterministic representative and record method), recording-diverse representatives, distinctSampleCount and savedClipCount, suggestedLabel with vocabularyVersion/method/concept scores and metadata provenance. Versioned CLAP text-concept vectors must match embeddingSpace; metadata-only label fallback must declare its method. Curator label overrides preserve suggestion provenance and their own revision/audit. Listening qualityReview is pending until supervisor reviewed representative passages. Draft output never advances published pointer.

## M5 exploration and job contracts

Public routes /sounds?run=<runId>&preset=useful&order=samples|clips and /sounds/<clusterId>?run=<runId>&preset=<preset>&members=similarity|rating round-trip bookmarkably. Without run choose latest published for preset useful. Public service reads published run only, filters membership against current canonical visibility/revisions BEFORE returning coordinates, cards or counts. Unknown/unpublished run appears unavailable/notfound, not draft preview. Default leaderboard counts distinct visible samples; alternative clipcount counts visible saved clips; tie clusterId. Representative passages first, remaining members ordered cosine-to-centroid or existing ratings, stable semanticId ties. No duplicate representatives in remainder.

Map permits cluster/member selection and playable drill-down with parent and related links. A keyboard-accessible list is always available and fully functional without map. Virtualize/sample rendering beyond10000 points with explicit displayed/total count; never expose private coordinates or call visual separation listening quality.

GET /semantic/clusters and /semantic/clusters/<runId> are public published reads. /semantic/cluster-jobs and /semantic/drafts are curator-only controls/read routes, authorized using actual Cognito curator group in cloud and configured local identity in localmode, not a browser-suppliedrole. Ground processing uses authenticated service credentials. Never put drafts in a publicly readable generic Job model. Dedicated control table/service or curator-authorized schema models are permitted within this packet only; contract generation/parity tests required if schema source changes.

Job request {requestId,embeddingSpace,preset,params:{neighbors,minClusterSize,minSamples},corpusRevision?}. Validate integers neighbors2..200,minClusterSize2..500,minSamples1..100 before queue; effective corpusclamps remain in runmanifest. States queued → running → draft or failed; draft → published only explicit approvedpublication. Worker claims via conditional atomic lease10minutes, renews beforeexpiry; expired lease can be reclaimed with new token; updates require matchingtoken. Offline stays queued. Retries keep previous failure history and enqueue a new attempt; idempotent requestId prevents duplicatejobs. Errors carry retryability. Completed run remains draft; current published pointer unaffected.

Preview/override/publication require curator. Label override trimmed length1..120 and optimistic runrevision match. Publication requires completed current revision + approved listeningreview, conditional atomic pointer update; failure/race leaves prior pointer intact. Prior immutable published runs stay addressable. Failed jobs retryable throughUI. Curator params/status/draftpreview form stays separate from publicleaderboard.

Independent rollout flags retrieval, related, browserSearch and clusters start disabled pending supervisor gate approval; enabling browserSearch selects automatic hybrid behavior (not a user semantic toggle). Lexical search works with all flagsoff. Surface coverage/exclusion/indexlag, querylatency/candidatecounts/servicecost metrics, browserdownload/cache/inferencefailures and cluster jobstates. Do not log raw queries/vectors/audio or user secrets.

## Verification and dispatch inventory

Ordinary checks:
- PYTHONPATH=analysis analysis/.venv/bin/python -m pytest analysis/tests/test_semantic*.py (plus affected regressions).
- cd web && npm run test:flow && npm run build && npm run contract:check.
- cargo test -p apricity-cli -p apricity-data for local adapter changes; cargo test --workspace --exclude apricity-web before integration when native files changed.
- cd web && npx cucumber-js --config test/semantic-audio/cucumber.mjs; task-specific tags/scenarios remain explicitly tracked until every implemented story is green.

Model-backed and cloud/browser/listening evaluations are separate named commands documented by their owning task, producing machine-readable measured/pass/fail/not_evaluated reports and nonzeroexit for required unmet gates. Never turn unavailable dependencies into successful gated verification.

Each handoff contains file/diff inventory, prerequisites actually accepted, RED and GREENcommands with counts/results, observable statebehavior, fixturecoverage, measurementartifacts, unresolvedissues and preciseblockers. Supervisor reruns commands, reviews source/security/integration, listens where needed, lands one reviewed task per commit, then closes that Kanbus task. Full epic/initiative remain open until all their gates hold.


### M0: apricitus-4fe60f, story apricitus-e46692

- apricitus-cc5a3d: Specify all six epics and supervision contracts
  - Purpose: finish initiative-wide contracts/Gherkin/task packets before dispatch. Allowed: design/semantic-audio.md, features/semantic-audio/*.feature; Kanbus through CLI. Excludes all product behavior. Verify: parse every feature with @cucumber/gherkin and audit task coverage/dependencies.
- apricitus-78d17d: Define semantic region identities and vector contracts
  - Purpose: stable saved-clip/window identities and cross-runtime fixtures. Prerequisites: all-six spec. Allowed: new analysis semantic contract module, shared schema/semantic-audio.schema.json and small fixtures, contract unit tests. Identity hash includes sampleId,recordingId,clipId or window kind,start/end microseconds,audioSha256,embeddingSpace,processingFingerprint; display metadata excluded. Validate512 finite unitnorm tolerance1e-4; zero rejected. Verify: analysis semantic-contract tests and web contract tests.
- apricitus-dbcb9b: Make sidecar freshness and preprocessing reproducible
  - Purpose: recompute changed audio/boundaries, metadata-only rename, reject invalid vectors with reports. Prerequisite: identity contract. Allowed: analysis/apricity_analyze/clap.py, scripts/fit-features.py, related analysis tests. Record pinned model and preprocessing revision; deterministic mono48k soxrHQ, centered10s crop, existing CLAP padding; explicit truncation for text. Legacy sidecars stale. Changed window grid invalidates windows. Verify: model-free freshness/preprocess tests plus separate model repeatability evaluation.
- apricitus-5bb1f3: Build pinned browser CLAP feasibility harness
  - Purpose: prove approved browser text tower compatibility, not UI rollout. Prerequisite: identities/pins. Allowed: web/src/semantic/encoder*, web/test/semantic-encoder*, web/package*.json, web/scripts/semantic-eval*; no existing search UI. Transformers.js3.8.1 q8 WASM ClapTextModelWithProjection; Xenova revision c28f2883575e590e04d3146ff0713c2448d691ba and Python checkpoint revision8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a. Handle progress/cache/retry and cancellation protocol. Verify: build; deterministic worker tests; explicit browser parity command.
- apricitus-497ce7: Create and evaluate the shared relevance corpus
  - Purpose: fixed prompts/reference vectors/audio fixtures/judgments/evaluation output. Prerequisite: deterministic ground and browser harness. Allowed: analysis semantic evaluation exporter, web/scripts evaluator, fixtures/semantic-audio/evaluation*, analysis/test eval. Fixed prompts drums/rain/bass/vocal/ambient/metal sounds; synthaudio fixture provenance; judgment records unreviewed until supervisor listening. Gates cosine>=.98 each, mean top20 overlap>=.90, warm p95 desktop2s/mobile5s. Missing device/reference/judgments must report not evaluated, nonzero gate command.

### M1: apricitus-64c1e9, story apricitus-d95740

- apricitus-146c8a: Implement versioned semantic records
  - Purpose: typed records with saved/window distinctions and canonical materialization. Prereq M0contract. Allowed: new ground records module and TS semantic contracts/fixtures/tests; no schema source changes unless approved packet update. Exact data in design spec. Metadata from current Sample/Clip/Recording; local path is not canonical cloud ID. Missing mappings report excluded rather than invent IDs. Verify record contract roundtrip and fixtures.
- apricitus-142c19: Publish and backfill semantic records idempotently
  - Purpose: ground publish/upsert/delete metadata/coverage and resume. Prereq records. Allowed: new ground publisher/CLI commands and tests. Local atomic snapshot semantic/corpus.json; cloud table puts with explicit embeddingSpace+semanticId keys, reconcile scope per sample only with Query no Scan. Checkpoint saved after successful batches; retry idempotent keys; retire deleted/changed/hidden. Verify dryrun/repeat/interrupted/retirement tests, CLI --help. No publish to production.
- apricitus-c938b9: Provision native DynamoDB vector retrieval infrastructure
  - Purpose: dedicated PAY_PER_REQUEST512 DOT_PRODUCT vector index and narrow endpoint IAM. Prereq records contract. Allowed: web/amplify semantic resource/backend and package dependency changes, generated outputs configuration. Never deploy. Partition embeddingSpace and equality inline kind/sample constraints. Server SearchVectors on index ARN; guests never direct table vector permissions; publisher separate least privilege. Verify synth/resource tests and contract:check.
- apricitus-9383f0: Implement typed cloud search and exact local adapter
  - Purpose: one searchAudio endpoint at POST /semantic/search in both modes, configured URL in custom.apricity.semanticUrl. Prereq infra/recordcontract. Allowed: semantic lambda modules, web/src/data/semantic.ts, Rust local semantic route/module tests; native local engine must check canonical models, no sibling repo changes. Request normalized512 vector embeddingSpace optionalkind/sampleId limit24max100. Exact dot local tie semanticId asc; cloud SearchVectors capped100 no scan; reject unsupported versions/invalid input. Verify local Rust and TS handler tests; sandbox recall separate optional command nonzero if unavailable.
- apricitus-a97580: Guard current visibility and revisions in retrieval
  - Purpose: no stale/retired/hidden content leak. Prereq adapters. Allowed: current canonical resolver in local/cloud handlers and tests. Recheck Sample audioSHA/status/visibility policy and Clip existence/sampleId/retired/current range at read time; match processing/version. Canonical card metadata replaces indexed metadata. Missing parent/recording denies hit. Preserve result scores/order after filtering, allow fewer. Verify deletion/hidden/changed boundary/hash tests both adapters.

### M2: apricitus-375434, story apricitus-cd79d7

- apricitus-140e88: Retrieve related clips from stored vectors
  - Purpose: selectedclip-to-clip search no text encoder. Prereq M1accepted. Allowed: semantic related module tests. Source embedding missing returns awaiting-analysis, stale source unavailable. Exclude source sample before final take; match clip/window playback. Verify e0 deterministic scores and no model imports.
- apricitus-fbb3dc: Choose sample representatives and rank diverse related hits
  - Purpose: samples use up to4 deterministic farthest-point vectors; merged clips maxscore, sample bestpassage. Prereq cliprelated. Allowed same related domain module/tests. Seed smallestsemanticId; choose max minimum1-dot distance tiessemanticId; recordingfirst diversification; score tiessemanticId; six initial; excludes source sample. Verify one recording multiple samples and distinct passages.
- apricitus-f2e17d: Add Related by sound to clip and sample pages
  - Purpose: existing-style playable six cards and parentlinks. Prereq relatedmodule. Allowed web/src/ui/library.ts,new semantic cards/styles/tests. Loading/empty/awaiting-analysis/retry states no scorespercent; navigation cancels/ignores old responses. Playback precisely start/end seconds in Sampleaudio. Verify UI/component and build; supervisor browser auditions.

### M3: apricitus-def9c1, story apricitus-2dc2d0

- apricitus-89a75e: Implement lazy text encoder worker and model cache
  - Purpose: promote parity-approved harness to browserworker client. Prereq M0browsergate and M1. Allowed encoder/clientworker/cache modules/tests; packagepin. Never WebGPU/cloudencoder. Protocol requestId/encode/cancel/progress/result/error. Dynamic import only nonemptysearch; IndexedDB/CacheStorage preferred; memoryfallback displays cache unavailable; bounded128 queryvector LRU includes model+normalizedtext. Verify lazy/progress/retry/storagefailure/out-of-order tests.
- apricitus-9c0405: Normalize browser queries and integrate semantic search requests
  - Purpose: encoder→searchAudio lifecycle independentlexical. Prereqworker. Allowed hybrid controller/data modules/tests. Query generation monotonically increments;600ms debounce;Enter bypass;AbortController retrieval; inference late response ignored;clear/nav invalidate. Verify virtualtimer state race tests; no result before finite unitvector.
- apricitus-c709ec: Layer automatic hybrid results into global and section search
  - Purpose: preserve lexical ranks while adding clearlylabelled sound groups. Prereqcontroller. Allowed web/src/ui/search.ts,section.ts,main.ts sharedsemanticcards/styles/tests. Global sound clips+regions; Samples groups sample maxpassage; Clips savedonly; existingkind/rating/mine/source/sample/length filters applied both. Candidatecap100; groupingdedup stable; Enter immediate even if lexicalcallback. Verify unchanged lexical regressions plus hybridtests/build.
- apricitus-e711eb: Verify first-use downloads and failure recovery
  - Purpose: measurable firstdownload127MB progress, caching, cold/warmtime, stale navigation and retry. PrereqhybridUI. Allowed end-to-end browser tests and evaluation docs only. Desktop actualbrowser and designated mobile needed; no invented devicebenchmarks; explicit skippedgate failure. Test offline/downloadblocked/cacheblocked/inferencebad/retrievalfailure all lexicalusable. Verify gatedbrowser command and build.

### M4: apricitus-796bfa, story apricitus-9cb5b2

- apricitus-67a5f9: Build deduplicated current semantic corpus snapshots
  - Purpose: currentvalidrecords only, immutable provenance. PrereqM0contract. Allowed new ground cluster corpus module/tests. Dedup recordingId+audioSha+start/endmicroseconds+space+fingerprint selectinglowestsemanticId, retain aliasmembers. Corpus digest sorted canonicalidentities+vectorbytes; no mixedspace. Verify snapshot stable order, retiredvisibility, duplicates.
- apricitus-67f31c: Implement reproducible presets, reduction, and clustering
  - Purpose: offline UMAP10D/HDBSCAN and independent2D. Prereqsnapshot. Allowed ground cluster algorithms,analysis/pyproject optional clustering deps/tests. Presets exact accepted; cosine UMAP min_dist0 seed42 singlethread10D; HDBSCAN euclidean eom; displaymin_dist.1 2D. N<5 outliers; clamp neighbors2..N-1, spectral n_components<=N-2; mincluster/minsamples <=N; reporteffectiveparams. Verify pinnedalgorithm realrun twice + deterministic adaptertests, no skippedqualitygate.
- apricitus-e15388: Generate representatives, centroids, and traceable labels
  - Purpose: normalizedcentroid/diversifiedpassages/membership/outliers. Prereqclusteralgorithm. Allowed cluster summaries/versionedconceptvocabulary/tests. CLAP textconceptvector version matched; fallbackmetadata explicitlylabelmethod metadata not implicit newmodel; proposedlabels trace conceptscores vocabularyversion; curatoroverride separate revision. Verify zero mean fallbackrepresentativevector and recordingdiversity.
- apricitus-9b0c93: Publish immutable cluster run manifests and ground commands
  - Purpose: corpus/model/preset/params provenance, draftimmutable artifacts and explicitpublish. Prereqsummaries. Allowed groundcluster CLI/manifest/IO/tests. Runidsha256 digest corpus+config+algorithmversions; repeat does not overwrite; draft run creation never changes publishedpointer. Listeningreport unreviewed status required; verify CLI empty/small/missingdeps failures and artifact roundtrips.

### M5: apricitus-7acf23, story apricitus-0012ec

- apricitus-ee3d76: Add published cluster leaderboard and detail routes
  - Purpose: bookmarkable /sounds?run=&preset=&order=samples|clips and /sounds/<clusterId>?run=&preset=&members=similarity|rating. PrereqM1 M4accepted. Allowed web/src/route.ts/main.ts,newclusters view/data/tests plus HTMLnavigation. Publicpublished only; recomputevisiblecounts; currentvisiblemembercards firstrepresentatives then ordering stable. Missingrun/cluster explicitnotfound; defaultlatestpublished presetuseful. Verify route roundtrip/data authorization/order tests.
- apricitus-4e7ecf: Build interactive sound map with accessible drill-down
  - Purpose:2D points selection and playablepassages, keyboardlist. Prereqclusterroutes. Allowed map component/styles/tests only. Never replace list; labels for clusters/outliers; select highlightsanddetails; no claim distanceequalsquality. Largecorpus rendercap virtualized10000points with explicit summary; no private members in coordinates. Verify keyboard/navigation/playback/integrationbrowser.
- apricitus-4a57cf: Implement curator cluster job contracts and ground processing
  - Purpose: secure queue lease offline queued failure retry preview. PrereqM1 M4. Allowed newclusterjob service/localcloud endpoint/groundworker/tests and infra schema if supervisorapproval. Parametersneighbors2..200,mincluster2..500,minsamples1..100 with corpusclamps; curators only mutationanddraftreads. States queued/running/failed/draft/published; owner lease10minutes renew, reclaimexpiry;jobid stable request retry/revisions. Groundneverpublicbrowser clustering. Verify concurrentclaim/auth/offline/retry tests.
- apricitus-5b4402: Add curator preview, override, and explicit publication controls
  - Purpose: draftpreview labelsparameterforms/status/publishatomic. Prereqjobsandviews. Allowed curatorUI/endpoints/tests. Labeloverride trim1..120 chars, runrevision optimisticcompare; publishcuratoronly aftercomplete and qualityapproval; previousrunaddressable and currentpointerunchanged onfailure. Publiconlypublished; independent flags retrieval/related/search/clusters all defaultoff untilgatesreviewed;metrics coverage/indexlag/querylatencycost/workerfailures. Verify publishfailure/race/roles and browser/build.

## Uniform task packet requirements

## Assignment rules
Terra implements only this packet after prerequisite handoff acceptance. Read AGENTS.md and CONTRIBUTING_AGENT.md. Never inspect project/ or issue JSON. Never commit, push, close tasks, deploy, switch embedding models, add cloud inference, or expand upstream Virtuus. Supervisor owns integration. Preserve unrelated edits.
Write observable executable Gherkin specifications and deterministic fixture tests FIRST; run them and record the expected failure before production changes. No skipped model evaluation counts as a passed gate.
Each packet inherits design/semantic-audio.md contracts and features/semantic-audio/*.feature once the supervisor lands the all-six specification task.
## Shared fixture
512D basis vectors: e0, e1, (e0+e1)/sqrt(2), -e0; samples A/B share recording R1, sample C recording R2, sample D recording R3. A has saved clips a1[0,4),a2[4,8) and window w1[0,8); C has c1[1,5). Include boundary edit a1[0,3), renamed a2, retired a1, hidden D, wrong-space E, missing/zero/NaN vectors, identical source region aliases, outliers. Synthetic WAVs are generated in tests; no large data in git.
## States and handoff
Loading means progress without false empty results; empty means explicit no matches/coverage, not failure. Stale data is rejected using current audio hash, boundary, model/preprocessing and canonical visibility. Failures are structured, retryable when transient, and never silently fall back to another model.
Report task ID, file/diff inventory, RED command/output, GREEN command/output/counts, integration observations, unresolved issues, and gate measurements. Report BLOCKED with exact evidence if pinned assets unavailable, parity/performance/quality gate fails, permissions/API unsupported, required hardware/cloud sandbox absent, or a contract needs changing. Do not invent measured evidence. Supervisor reruns checks before landing.
