//! Exact local retrieval over an atomically published semantic corpus.

use apricity_data::{Files, files::valid_key};
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};
use virtuus_amplify::{Engine, Identity};

pub const SPACE: &str = "clap-htsat-unfused-512-v1";
const DIMENSIONS: usize = 512;

#[derive(Clone)]
pub struct SemanticState {
    pub corpus: PathBuf,
    pub engine: Arc<Mutex<Engine>>,
    pub files: Arc<RwLock<Box<dyn Files>>>,
    pub(crate) corpus_cache: Arc<Mutex<CorpusCache>>,
}

/// The disk file is the authority.  This cache only retains a fully parsed and validated
/// immutable snapshot after the opened file's identity has been checked.
#[derive(Default)]
pub(crate) struct CorpusCache {
    entry: Option<Arc<CachedCorpus>>,
    #[cfg(test)]
    loads: usize,
    #[cfg(test)]
    parse_attempts: usize,
}

struct CachedCorpus {
    key: CorpusKey,
    records: Vec<Record>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CorpusKey {
    len: u64,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mtime_seconds: i64,
    #[cfg(unix)]
    mtime_nanoseconds: i64,
    #[cfg(not(unix))]
    modified: std::time::SystemTime,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    query_vector: Vec<f64>,
    embedding_space: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    sample_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelatedRequest {
    embedding_space: String,
    sample_id: String,
    #[serde(default, deserialize_with = "deserialize_clip_id")]
    clip_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_limit")]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    schema_version: String,
    embedding_space: String,
    processing_fingerprint: String,
    records: Vec<Record>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    identity: IdentityRecord,
    vector: Vec<f64>,
    display: Display,
    playback: Playback,
    revision: String,
    metadata_updated_at: String,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityRecord {
    semantic_id: String,
    sample_id: String,
    recording_id: String,
    kind: String,
    #[serde(
        default,
        deserialize_with = "deserialize_clip_id",
        skip_serializing_if = "Option::is_none"
    )]
    /// `None` is an absent JSON field; `Some(None)` is an explicit JSON null and invalid.
    clip_id: Option<Option<String>>,
    start: f64,
    end: f64,
    audio_sha256: String,
    embedding_space: String,
    processing_fingerprint: String,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Display {
    sample_path: String,
    sample_title: String,
    #[serde(default)]
    clip_name: Option<String>,
    #[serde(default)]
    clip_kind: Option<String>,
    tags: Vec<String>,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Playback {
    file_key: String,
    start: f64,
    end: f64,
}

fn deserialize_clip_id<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Value::deserialize(deserializer)? {
        Value::Null => Ok(Some(None)),
        Value::String(value) => Ok(Some(Some(value))),
        _ => Err(serde::de::Error::custom(
            "clipId must be a string when present",
        )),
    }
}

/// An omitted limit uses the endpoint default; an explicit null is not a valid limit.
fn deserialize_limit<'de, D>(deserializer: D) -> Result<Option<usize>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    usize::deserialize(deserializer).map(Some)
}

fn error(status: StatusCode, code: &str, message: impl Into<String>, retryable: bool) -> Response {
    (
        status,
        axum::Json(
            json!({"error": {"code": code, "message": message.into(), "retryable": retryable}}),
        ),
    )
        .into_response()
}
fn sha(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn sha_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn valid_vector(v: &[f64]) -> bool {
    let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    v.len() == DIMENSIONS && v.iter().all(|x| x.is_finite()) && n > 1e-9 && (n - 1.0).abs() <= 1e-4
}
fn valid_bounds(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && a >= 0.0 && b > a
}
fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
fn microseconds(v: f64) -> Option<i64> {
    // Match Python's Decimal(str(seconds)) with ROUND_HALF_UP instead of allowing binary
    // multiplication to move a .5 microsecond below its required rounding boundary. Values
    // whose canonical microseconds cannot fit in i64 have no retrievable identity.
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    if v == 0.0 {
        return Some(0);
    }
    let text = v.to_string();
    let (mantissa, exponent) = text
        .split_once(['e', 'E'])
        .map(|(m, e)| Some((m, e.parse::<i32>().ok()?)))
        .unwrap_or(Some((text.as_str(), 0)))?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Some(0);
    }
    let value = digits.parse::<u64>().ok()?;
    let shift = exponent - fraction.len() as i32 + 6;
    let rounded = if shift >= 0 {
        let shift = u32::try_from(shift).ok()?;
        // Any nonzero integer scaled by 10^19 exceeds the i64 identity domain.
        if shift > 18 {
            return None;
        }
        value.checked_mul(10_u64.checked_pow(shift)?)?
    } else {
        let places = shift.unsigned_abs();
        // An f64's shortest decimal has at most 17 significant digits, so values at this
        // scale are strictly below half a microsecond and round to zero.
        if places > 18 {
            return Some(0);
        }
        let divisor = 10_u64.checked_pow(places)?;
        let quotient = value / divisor;
        let remainder = value % divisor;
        quotient.checked_add(u64::from(remainder >= divisor / 2))?
    };
    i64::try_from(rounded).ok()
}
fn same_bounds(a: f64, b: f64) -> bool {
    matches!((microseconds(a), microseconds(b)), (Some(a), Some(b)) if a == b)
}
fn aware_timestamp(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// Local semantic endpoint. The on-disk corpus remains authoritative on every request; an
/// unchanged opened file can reuse its already validated immutable vector snapshot.
pub async fn search(State(state): State<SemanticState>, body: Bytes) -> Response {
    let request: Request = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "semantic request must match the search contract",
                false,
            );
        }
    };
    if request.embedding_space != SPACE {
        return error(
            StatusCode::CONFLICT,
            "unsupported_embedding_space",
            "the local corpus does not support that embedding space",
            false,
        );
    }
    if !valid_vector(&request.query_vector)
        || request
            .kind
            .as_deref()
            .is_some_and(|k| k != "saved_clip" && k != "window")
        || request.sample_id.as_deref().is_some_and(str::is_empty)
        || request.limit.is_some_and(|n| n == 0 || n > 100)
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "queryVector must be a finite unit 512-vector and filters must be valid",
            false,
        );
    }
    let limit = request.limit.unwrap_or(24);
    let corpus_path = state.corpus.clone();
    let corpus_cache = state.corpus_cache.clone();
    let corpus = match tokio::task::spawn_blocking(move || load_corpus(&corpus_path, &corpus_cache))
        .await
    {
        Ok(Ok(corpus)) => corpus,
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "semantic_corpus_unavailable",
                "semantic corpus is missing, corrupt, or failed validation; retry after publication",
                true,
            );
        }
    };
    let score_corpus = corpus.clone();
    let query_vector = request.query_vector;
    let kind = request.kind;
    let sample_id = request.sample_id;
    let mut candidates = match tokio::task::spawn_blocking(move || {
        score_records(
            &score_corpus,
            &query_vector,
            kind.as_deref(),
            sample_id.as_deref(),
        )
    })
    .await
    {
        Ok(candidates) => candidates,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "semantic_corpus_unavailable",
                "semantic corpus could not be scored; retry after publication",
                true,
            );
        }
    };
    let candidate_count = candidates.len();
    let mut valid_hits = Vec::new();
    // Corpus publication is fresh per request, while a request may contain many windows for
    // one sample. Read and validate each sample manifest once for this request only.
    let mut analyses = std::collections::HashMap::new();
    let mut filtered = 0usize;
    for (score, index) in candidates.drain(..) {
        let hydration_state = state.clone();
        let hydration_corpus = corpus.clone();
        let (hit, returned_analyses) = match tokio::task::spawn_blocking(move || {
            let record = &hydration_corpus.records[index];
            let hit = hydrate(&hydration_state, record, score, &mut analyses);
            (hit, analyses)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "semantic_corpus_unavailable",
                    "semantic corpus could not be hydrated; retry after publication",
                    true,
                );
            }
        };
        analyses = returned_analyses;
        if let Some(hit) = hit {
            valid_hits.push(hit);
            if valid_hits.len() == limit {
                break;
            }
        } else {
            filtered += 1;
        }
    }
    let hits: Vec<Value> = valid_hits.into_iter().take(limit).collect();
    axum::Json(json!({"hits": hits, "embeddingSpace": SPACE, "candidateCount": candidate_count, "filteredCount": filtered})).into_response()
}

/// Related retrieval uses only the already published audio vectors.  It deliberately shares the
/// corpus loader and canonical hydration guard with search: neither an old cache entry nor an
/// indexed display field can make a stale region a source or a result.
pub async fn related(State(state): State<SemanticState>, body: Bytes) -> Response {
    let request: RelatedRequest = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "semantic request must match the related contract",
                false,
            );
        }
    };
    if request.embedding_space != SPACE {
        return error(
            StatusCode::CONFLICT,
            "unsupported_embedding_space",
            "the local corpus does not support that embedding space",
            false,
        );
    }
    if request.sample_id.is_empty()
        || request
            .clip_id
            .as_ref()
            .is_some_and(|value| value.as_deref().is_none_or(str::is_empty))
        || request.limit.is_some_and(|limit| limit == 0 || limit > 24)
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "sampleId, optional clipId, and limit must be valid",
            false,
        );
    }
    let limit = request.limit.unwrap_or(6);
    let corpus_path = state.corpus.clone();
    let corpus_cache = state.corpus_cache.clone();
    let corpus = match tokio::task::spawn_blocking(move || load_corpus(&corpus_path, &corpus_cache))
        .await
    {
        Ok(Ok(corpus)) => corpus,
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "semantic_corpus_unavailable",
                "semantic corpus is missing, corrupt, or failed validation; retry after publication",
                true,
            );
        }
    };
    match tokio::task::spawn_blocking(move || related_hits(&state, &corpus, &request, limit)).await
    {
        Ok(Ok(hits)) => axum::Json(json!({"state": "ready", "hits": hits})).into_response(),
        Ok(Err(RelatedUnavailable::Awaiting)) => {
            axum::Json(json!({"state": "awaiting_analysis", "hits": []})).into_response()
        }
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "semantic_corpus_unavailable",
            "semantic corpus could not be hydrated; retry after publication",
            true,
        ),
    }
}

enum RelatedUnavailable {
    Awaiting,
}

fn related_hits(
    state: &SemanticState,
    corpus: &CachedCorpus,
    request: &RelatedRequest,
    limit: usize,
) -> Result<Vec<Value>, RelatedUnavailable> {
    let mut analyses = std::collections::HashMap::new();
    let source_indices: Vec<usize> = match request.clip_id.as_ref() {
        Some(Some(clip_id)) => corpus
            .records
            .iter()
            .enumerate()
            .filter_map(|(index, record)| {
                (record.identity.sample_id == request.sample_id
                    && record.identity.kind == "saved_clip"
                    && record.identity.clip_id() == Some(clip_id.as_str()))
                .then_some(index)
            })
            .collect(),
        Some(None) => return Err(RelatedUnavailable::Awaiting),
        None => corpus
            .records
            .iter()
            .enumerate()
            .filter_map(|(index, record)| {
                (record.identity.sample_id == request.sample_id).then_some(index)
            })
            .collect(),
    };
    let mut sources = Vec::new();
    for index in source_indices {
        let record = &corpus.records[index];
        // A source is current only if it can be hydrated from its own saved clip/window.
        if hydrate(state, record, 0.0, &mut analyses).is_some() {
            sources.push(index);
        }
    }
    if sources.is_empty() {
        return Err(RelatedUnavailable::Awaiting);
    }
    let representatives = if request.clip_id.is_some() {
        sources
    } else {
        choose_representatives(corpus, sources)
    };
    let candidate_kind = request.clip_id.is_some().then_some("saved_clip");
    let mut merged: std::collections::HashMap<String, (f64, usize)> =
        std::collections::HashMap::new();
    for source in representatives {
        // Exact scores are computed for the full corpus, then the bounded nearest set is applied
        // before canonical filtering. This keeps each representative's retrieval bounded at 100.
        for (score, index) in
            score_records(corpus, &corpus.records[source].vector, candidate_kind, None)
                .into_iter()
                .take(100)
        {
            let semantic_id = corpus.records[index].identity.semantic_id.clone();
            let entry = merged.entry(semantic_id).or_insert((score, index));
            if score > entry.0
                || (score == entry.0
                    && corpus.records[index].identity.semantic_id
                        < corpus.records[entry.1].identity.semantic_id)
            {
                *entry = (score, index);
            }
        }
    }
    // Sample requests choose one best passage per parent sample. A clip request instead keeps
    // each saved clip distinct, even when several clips belong to the same parent sample.
    let mut grouped: std::collections::HashMap<String, (f64, usize, Value)> =
        std::collections::HashMap::new();
    for (_, (score, index)) in merged {
        let record = &corpus.records[index];
        if record.identity.sample_id == request.sample_id {
            continue;
        }
        let Some(hit) = hydrate(state, record, score, &mut analyses) else {
            continue;
        };
        let group = if request.clip_id.is_some() {
            record.identity.semantic_id.clone()
        } else {
            record.identity.sample_id.clone()
        };
        let replace = grouped.get(&group).is_none_or(|(best, best_index, _)| {
            score > *best
                || (score == *best
                    && record.identity.semantic_id
                        < corpus.records[*best_index].identity.semantic_id)
        });
        if replace {
            grouped.insert(group, (score, index, hit));
        }
    }
    let mut ranked: Vec<_> = grouped.into_values().collect();
    ranked.sort_by(|(a, ai, _), (b, bi, _)| {
        b.total_cmp(a).then_with(|| {
            corpus.records[*ai]
                .identity
                .semantic_id
                .cmp(&corpus.records[*bi].identity.semantic_id)
        })
    });
    let mut first_recordings = std::collections::HashSet::new();
    let mut first = Vec::new();
    let mut remainder = Vec::new();
    for item @ (_, index, _) in ranked {
        if first_recordings.insert(corpus.records[index].identity.recording_id.clone()) {
            first.push(item);
        } else {
            remainder.push(item);
        }
    }
    Ok(first
        .into_iter()
        .chain(remainder)
        .take(limit)
        .map(|(_, _, hit)| hit)
        .collect())
}

fn choose_representatives(corpus: &CachedCorpus, mut source: Vec<usize>) -> Vec<usize> {
    source.sort_by(|a, b| {
        corpus.records[*a]
            .identity
            .semantic_id
            .cmp(&corpus.records[*b].identity.semantic_id)
    });
    let mut selected = vec![source.remove(0)];
    while selected.len() < 4 && !source.is_empty() {
        let (position, _) = source
            .iter()
            .enumerate()
            .map(|(position, candidate)| {
                let min_distance = selected
                    .iter()
                    .map(|picked| {
                        1.0 - dot(
                            &corpus.records[*candidate].vector,
                            &corpus.records[*picked].vector,
                        )
                    })
                    .fold(f64::INFINITY, f64::min);
                (position, min_distance)
            })
            .max_by(|(left_index, left), (right_index, right)| {
                left.total_cmp(right).then_with(|| {
                    corpus.records[source[*right_index]]
                        .identity
                        .semantic_id
                        .cmp(&corpus.records[source[*left_index]].identity.semantic_id)
                })
            })
            .expect("source is not empty");
        selected.push(source.remove(position));
    }
    selected
}

fn dot(left: &[f64], right: &[f64]) -> f64 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

fn load_corpus(
    path: &std::path::Path,
    cache: &Arc<Mutex<CorpusCache>>,
) -> Result<Arc<CachedCorpus>, ()> {
    // Open before collecting metadata, so an atomic rename cannot make us associate a newly
    // statted pathname with the bytes of an older file. A request that opens a corrupt
    // replacement therefore fails closed even if a previous snapshot remains cached.
    let mut file = File::open(path).map_err(|_| ())?;
    let key = corpus_key(&file.metadata().map_err(|_| ())?);
    // Single-flight cold loads: otherwise concurrent first searches each retain a
    // full JSON buffer and parse the entire audio corpus independently.
    let mut cache = cache.lock().map_err(|_| ())?;
    if let Some(corpus) = cache
        .entry
        .as_ref()
        .filter(|cached| cached.key == key)
        .cloned()
    {
        return Ok(corpus);
    }
    #[cfg(test)]
    {
        cache.parse_attempts += 1;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| ())?;
    let parsed: Corpus = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let records = validate_corpus(parsed)?;
    let parsed = Arc::new(CachedCorpus { key, records });
    #[cfg(test)]
    {
        cache.loads += 1;
    }
    cache.entry = Some(parsed.clone());
    Ok(parsed)
}

fn corpus_key(metadata: &std::fs::Metadata) -> CorpusKey {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        CorpusKey {
            len: metadata.len(),
            device: metadata.dev(),
            inode: metadata.ino(),
            mtime_seconds: metadata.mtime(),
            mtime_nanoseconds: metadata.mtime_nsec(),
        }
    }
    #[cfg(not(unix))]
    {
        CorpusKey {
            len: metadata.len(),
            modified: metadata
                .modified()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        }
    }
}

fn validate_corpus(corpus: Corpus) -> Result<Vec<Record>, ()> {
    if corpus.schema_version != "apricity.semantic-corpus/1"
        || corpus.embedding_space != SPACE
        || corpus.processing_fingerprint.is_empty()
        || corpus
            .records
            .iter()
            .any(|record| !valid_record(record, &corpus.processing_fingerprint))
    {
        return Err(());
    }
    let mut ids = std::collections::HashSet::new();
    if corpus
        .records
        .iter()
        .any(|record| !ids.insert(&record.identity.semantic_id))
    {
        return Err(());
    }
    Ok(corpus.records)
}

fn score_records(
    corpus: &CachedCorpus,
    query_vector: &[f64],
    kind: Option<&str>,
    sample_id: Option<&str>,
) -> Vec<(f64, usize)> {
    let mut candidates: Vec<_> = corpus
        .records
        .iter()
        .enumerate()
        .filter(|(_, record)| {
            kind.map_or(true, |kind| record.identity.kind == kind)
                && sample_id.map_or(true, |sample_id| record.identity.sample_id == sample_id)
        })
        .map(|(index, record)| {
            (
                record
                    .vector
                    .iter()
                    .zip(query_vector)
                    .map(|(a, b)| a * b)
                    .sum::<f64>(),
                index,
            )
        })
        .collect();
    candidates.sort_by(|(left_score, left_index), (right_score, right_index)| {
        right_score.total_cmp(left_score).then_with(|| {
            corpus.records[*left_index]
                .identity
                .semantic_id
                .cmp(&corpus.records[*right_index].identity.semantic_id)
        })
    });
    candidates
}

fn valid_record(r: &Record, corpus_fp: &str) -> bool {
    let i = &r.identity;
    valid_vector(&r.vector)
        && i.embedding_space == SPACE
        && i.processing_fingerprint == corpus_fp
        && !i.semantic_id.is_empty()
        && !i.sample_id.is_empty()
        && !i.recording_id.is_empty()
        && is_sha256(&i.semantic_id)
        && is_sha256(&i.audio_sha256)
        && is_sha256(&r.revision)
        && ((i.kind == "window" && i.clip_id.is_none())
            || (i.kind == "saved_clip" && i.clip_id().is_some_and(|x| !x.is_empty())))
        && valid_bounds(i.start, i.end)
        && valid_bounds(r.playback.start, r.playback.end)
        && same_bounds(i.start, r.playback.start)
        && same_bounds(i.end, r.playback.end)
        && valid_key(&r.playback.file_key)
        && aware_timestamp(&r.metadata_updated_at)
}

fn get(engine: &mut Engine, model: &str, id: &str) -> Option<Value> {
    engine
        .call(model, "get", &json!({"id": id}), &Identity::ApiKey)
        .ok()?
        .0
        .as_object()
        .cloned()
        .map(Value::Object)
}
fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}
fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key)?.as_f64()
}

impl IdentityRecord {
    fn clip_id(&self) -> Option<&str> {
        self.clip_id.as_ref()?.as_deref()
    }
}

struct AnalysisGrid {
    revision_grid: String,
    downbeats: Vec<f64>,
}

fn hydrate(
    state: &SemanticState,
    record: &Record,
    score: f64,
    analyses: &mut std::collections::HashMap<String, Option<AnalysisGrid>>,
) -> Option<Value> {
    let i = &record.identity;
    // Verify the identity itself before looking at cached presentation fields.
    let canonical = json!([
        i.sample_id,
        i.recording_id,
        i.kind,
        i.clip_id(),
        microseconds(i.start)?,
        microseconds(i.end)?,
        i.audio_sha256,
        i.embedding_space,
        i.processing_fingerprint
    ]);
    if sha(&serde_json::to_string(&canonical).ok()?) != i.semantic_id {
        return None;
    }
    let (sample, recording, clip) = {
        let mut engine = state.engine.lock().ok()?;
        let sample = get(&mut engine, "Sample", &i.sample_id)?;
        let recording = get(&mut engine, "Recording", &i.recording_id)?;
        let clip = if i.kind == "saved_clip" {
            Some(get(&mut engine, "Clip", i.clip_id()?)?)
        } else {
            None
        };
        (sample, recording, clip)
    };
    if str_at(&sample, "recordingId")? != i.recording_id
        || recording.is_null()
        || str_at(sample.get("audio")?, "sha256")? != i.audio_sha256
    {
        return None;
    }
    let audio_key = str_at(sample.get("audio")?, "key")?;
    if !valid_key(audio_key) {
        return None;
    }
    if let Some(duration) = sample.get("duration").and_then(Value::as_f64) {
        if !duration.is_finite() || !valid_bounds(0.0, duration) || i.end > duration {
            return None;
        }
    }
    if let Some(clip) = &clip {
        if str_at(clip, "sampleId")? != i.sample_id
            || clip.get("retired").and_then(Value::as_bool) == Some(true)
            || !same_bounds(number(clip, "start")?, i.start)
            || !same_bounds(number(clip, "end")?, i.end)
        {
            return None;
        }
    }
    let grid = if i.kind == "window" {
        let analysis_key = str_at(sample.get("analysis")?, "key")?.to_owned();
        let analysis = analyses
            .entry(analysis_key)
            .or_insert_with(|| analysis_grid(state, &sample));
        let analysis = analysis.as_ref()?;
        if !is_current_window(analysis, i.start, i.end) {
            return None;
        }
        analysis.revision_grid.clone()
    } else {
        String::new()
    };
    if sha(&serde_json::to_string(&json!([i.semantic_id, grid])).ok()?) != record.revision {
        return None;
    }
    let tags = clip
        .as_ref()
        .and_then(|c| c.get("tags"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            sample
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        });
    let mut card = json!({"tags": tags});
    if let Some(c) = &clip {
        card["clipId"] = json!(str_at(c, "id")?);
        card["clipName"] = json!(str_at(c, "name")?);
        if let Some(kind) = str_at(c, "kind") {
            card["clipKind"] = json!(kind);
        }
    }
    Some(
        json!({"score": score, "identity": i, "parent": {"sampleId": i.sample_id, "recordingId": i.recording_id, "samplePath": str_at(&sample, "path")?, "sampleTitle": str_at(&sample, "title")?}, "timeRange": {"start": i.start, "end": i.end}, "card": card, "playback": {"fileKey": audio_key, "start": i.start, "end": i.end}}),
    )
}

fn analysis_grid(state: &SemanticState, sample: &Value) -> Option<AnalysisGrid> {
    let analysis = sample.get("analysis")?;
    let key = str_at(analysis, "key")?;
    let expected = str_at(analysis, "sha256")?;
    if !valid_key(key) {
        return None;
    }
    let bytes = {
        let files = state.files.read().ok()?;
        let size = files.stat(key).ok()??.size;
        let bytes = files.read_range(key, 0, size).ok()?;
        if sha_bytes(&bytes) != expected {
            return None;
        }
        bytes
    };
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    if str_at(v.get("source")?, "sha256")? != str_at(sample.get("audio")?, "sha256")? {
        return None;
    }
    let rhythm = v.get("rhythm").unwrap_or(&v);
    let grid = json!({"beats": rhythm.get("beats")?, "bpm": rhythm.get("bpm")?, "downbeats": rhythm.get("downbeats")?, "meter": rhythm.get("meter")?});
    let downbeats = rhythm
        .get("downbeats")?
        .as_array()?
        .iter()
        .map(Value::as_f64)
        .collect::<Option<Vec<_>>>()?;
    Some(AnalysisGrid {
        revision_grid: sha(&serde_json::to_string(&grid).ok()?),
        downbeats,
    })
}

/// Match Python `clap.bar_grid_windows`: every non-overlapping four-bar interval between
/// downbeats is a valid half-open retrieval window. Identity comparisons use round-half-up μs.
fn is_current_window(analysis: &AnalysisGrid, start: f64, end: f64) -> bool {
    if analysis.downbeats.len() < 5 {
        return false;
    }
    (0..analysis.downbeats.len() - 4).step_by(4).any(|index| {
        let a = analysis.downbeats[index];
        let b = analysis.downbeats[index + 4];
        same_bounds(a, start) && same_bounds(b, end)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use apricity_data::Library;
    use axum::{Router, body::to_bytes, http::Request};
    use tower::ServiceExt;

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn vector(axis: usize) -> Vec<f64> {
        let mut out = vec![0.0; DIMENSIONS];
        out[axis] = 1.0;
        out
    }

    fn identity(kind: &str, clip_id: Option<&str>, start: f64, end: f64, audio_sha: &str) -> Value {
        let canonical = json!([
            "smp_A",
            "rec_A",
            kind,
            clip_id,
            microseconds(start).expect("test identity has canonical bounds"),
            microseconds(end).expect("test identity has canonical bounds"),
            audio_sha,
            SPACE,
            "fp-v1"
        ]);
        let mut value = json!({"semanticId": sha(&serde_json::to_string(&canonical).unwrap()), "sampleId": "smp_A", "recordingId": "rec_A", "kind": kind, "clipId": clip_id, "start": start, "end": end, "audioSha256": audio_sha, "embeddingSpace": SPACE, "processingFingerprint": "fp-v1"});
        if kind == "window" {
            value.as_object_mut().unwrap().remove("clipId");
        }
        value
    }

    fn record(kind: &str, clip_id: Option<&str>, start: f64, end: f64, axis: usize) -> Value {
        let identity = identity(kind, clip_id, start, end, SHA_A);
        let grid = if kind == "window" {
            "grid-placeholder"
        } else {
            ""
        };
        json!({"identity": identity, "vector": vector(axis), "display": {"samplePath": "obsolete/path.wav", "sampleTitle": "", "clipName": "", "tags": []}, "playback": {"fileKey": "audio/obsolete.wav", "start": start, "end": end}, "revision": sha(&serde_json::to_string(&json!([identity["semanticId"], grid])).unwrap()), "metadataUpdatedAt": "2026-09-30T12:00:00Z"})
    }

    fn window_record(start: f64, end: f64, analysis: &Value) -> Value {
        let mut value = record("window", None, start, end, 0);
        let identity = value["identity"].clone();
        let rhythm = &analysis["rhythm"];
        let grid = sha(&serde_json::to_string(&json!({"beats": rhythm["beats"], "bpm": rhythm["bpm"], "downbeats": rhythm["downbeats"], "meter": rhythm["meter"]})).unwrap());
        value["revision"] = json!(sha(&serde_json::to_string(&json!([
            identity["semanticId"],
            grid
        ]))
        .unwrap()));
        value
    }

    fn corpus(records: Vec<Value>) -> Value {
        json!({"schemaVersion": "apricity.semantic-corpus/1", "embeddingSpace": SPACE, "processingFingerprint": "fp-v1", "records": records})
    }

    fn create(engine: &mut Engine, model: &str, input: Value) {
        engine
            .call(model, "create", &input, &Identity::ApiKey)
            .unwrap();
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        app: Router,
        shared_engine: Arc<Mutex<Engine>>,
        cache: Arc<Mutex<CorpusCache>>,
    }

    fn fixture(records: Vec<Value>, analysis: Value) -> Fixture {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("library");
        let mut library = Library::create(&root).unwrap();
        create(
            library.engine_mut(),
            "Recording",
            json!({"id":"rec_A","title":"Current recording","collection":"test"}),
        );
        create(
            library.engine_mut(),
            "Sample",
            json!({"id":"smp_A","recordingId":"rec_A","path":"current/path.wav","collection":"test","title":"Current sample","audio":{"key":"audio/current.wav","sha256":SHA_A,"size":1}}),
        );
        create(
            library.engine_mut(),
            "Clip",
            json!({"id":"clp_A","sampleId":"smp_A","name":"Current clip","start":0.0,"end":4.0,"source":"user"}),
        );
        std::fs::create_dir_all(root.join("files/analysis/smp_A")).unwrap();
        std::fs::write(
            root.join("files/analysis/smp_A/manifest.json"),
            serde_json::to_vec(&analysis).unwrap(),
        )
        .unwrap();
        let raw = std::fs::read(root.join("files/analysis/smp_A/manifest.json")).unwrap();
        let digest = format!("{:x}", Sha256::digest(&raw));
        library.engine_mut().call("Sample", "update", &json!({"id":"smp_A","analysis":{"key":"analysis/smp_A/manifest.json","sha256":digest,"size":raw.len()}}), &Identity::ApiKey).unwrap();
        std::fs::create_dir_all(root.join("semantic")).unwrap();
        std::fs::write(
            root.join("semantic/corpus.json"),
            serde_json::to_vec(&corpus(records)).unwrap(),
        )
        .unwrap();
        let shared_engine = Arc::new(Mutex::new(library.into_engine()));
        let files: Arc<RwLock<Box<dyn Files>>> = Arc::new(RwLock::new(Box::new(
            apricity_data::FsFiles::new(root.join("files")),
        )));
        let cache: Arc<Mutex<CorpusCache>> = Arc::default();
        let app = Router::new()
            .route(
                "/semantic/search",
                axum::routing::post(crate::semantic::search),
            )
            .route(
                "/semantic/related",
                axum::routing::post(crate::semantic::related),
            )
            .with_state(SemanticState {
                corpus: root.join("semantic/corpus.json"),
                engine: shared_engine.clone(),
                files,
                corpus_cache: cache.clone(),
            });
        Fixture {
            _dir: dir,
            root,
            app,
            shared_engine,
            cache,
        }
    }

    async fn search(fixture: &Fixture, body: Value) -> (StatusCode, Value) {
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::post("/semantic/search")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn related(fixture: &Fixture, body: Value) -> (StatusCode, Value) {
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::post("/semantic/related")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn related_record(sample: &str, recording: &str, clip: &str, start: f64, axis: usize) -> Value {
        let mut value = record("saved_clip", Some(clip), start, start + 4.0, axis);
        let canonical = json!([
            sample,
            recording,
            "saved_clip",
            clip,
            microseconds(start).unwrap(),
            microseconds(start + 4.0).unwrap(),
            SHA_A,
            SPACE,
            "fp-v1"
        ]);
        let identity = json!({"semanticId":sha(&serde_json::to_string(&canonical).unwrap()),"sampleId":sample,"recordingId":recording,"kind":"saved_clip","clipId":clip,"start":start,"end":start+4.0,"audioSha256":SHA_A,"embeddingSpace":SPACE,"processingFingerprint":"fp-v1"});
        value["identity"] = identity.clone();
        value["revision"] = json!(sha(&serde_json::to_string(&json!([
            identity["semanticId"],
            ""
        ]))
        .unwrap()));
        value
    }

    fn add_related_parent(
        fixture: &Fixture,
        sample: &str,
        recording: &str,
        clip: &str,
        start: f64,
    ) {
        let mut engine = fixture.shared_engine.lock().unwrap();
        create(
            &mut engine,
            "Recording",
            json!({"id":recording,"title":recording,"collection":"test"}),
        );
        create(
            &mut engine,
            "Sample",
            json!({"id":sample,"recordingId":recording,"path":format!("{sample}.wav"),"collection":"test","title":sample,"audio":{"key":format!("audio/{sample}.wav"),"sha256":SHA_A,"size":1}}),
        );
        create(
            &mut engine,
            "Clip",
            json!({"id":clip,"sampleId":sample,"name":clip,"start":start,"end":start+4.0,"source":"user"}),
        );
    }

    #[tokio::test]
    async fn related_route_is_a_strict_post_contract() {
        // RED: M2 is a distinct stored-vector endpoint, not a disguised text search.
        let fixture = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        let response = fixture
            .app
            .clone()
            .oneshot(
                Request::post("/semantic/related")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        json!({"embeddingSpace": SPACE, "sampleId": "smp_A"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn related_uses_current_stored_vectors_diversifies_and_preserves_typed_hits() {
        let records = vec![
            related_record("smp_A", "rec_A", "clp_A", 0.0, 0),
            related_record("smp_A", "rec_A", "clp_A2", 4.0, 1),
            related_record("smp_B", "rec_R1", "clp_B", 0.0, 0),
            related_record("smp_C", "rec_R1", "clp_C", 0.0, 0),
            related_record("smp_D", "rec_R2", "clp_D", 0.0, 0),
            related_record("smp_E", "rec_R3", "clp_E", 0.0, 1),
        ];
        let fixture = fixture(records, analysis());
        create(
            &mut fixture.shared_engine.lock().unwrap(),
            "Clip",
            json!({"id":"clp_A2","sampleId":"smp_A","name":"clp_A2","start":4.0,"end":8.0,"source":"user"}),
        );
        add_related_parent(&fixture, "smp_B", "rec_R1", "clp_B", 0.0);
        add_related_parent(&fixture, "smp_C", "rec_R1", "clp_C", 0.0);
        add_related_parent(&fixture, "smp_D", "rec_R2", "clp_D", 0.0);
        add_related_parent(&fixture, "smp_E", "rec_R3", "clp_E", 0.0);
        let (status, body) = related(
            &fixture,
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","limit":4}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "ready");
        let hits = body["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 4);
        assert!(
            hits.iter()
                .all(|hit| hit["score"].as_f64().is_some_and(f64::is_finite)
                    && hit.get("vector").is_none())
        );
        assert!(hits.iter().all(|hit| hit["parent"]["sampleId"] != "smp_A"));
        let recordings: Vec<_> = hits
            .iter()
            .map(|hit| hit["parent"]["recordingId"].as_str().unwrap())
            .collect();
        assert_ne!(
            recordings[0], recordings[1],
            "strongest distinct recordings lead"
        );
        assert!(
            recordings.contains(&"rec_R1")
                && recordings.contains(&"rec_R2")
                && recordings.contains(&"rec_R3")
        );
        let (status, clip_body) = related(
            &fixture,
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","clipId":"clp_A","limit":24}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{clip_body}");
        assert!(
            clip_body["hits"]
                .as_array()
                .unwrap()
                .iter()
                .all(|hit| hit["identity"]["kind"] == "saved_clip")
        );
        fixture
            .shared_engine
            .lock()
            .unwrap()
            .call("Clip", "delete", &json!({"id":"clp_A"}), &Identity::ApiKey)
            .unwrap();
        let (_, stale) = related(
            &fixture,
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","clipId":"clp_A"}),
        )
        .await;
        assert_eq!(stale, json!({"state":"awaiting_analysis","hits":[]}));
    }

    #[tokio::test]
    async fn related_rejects_invalid_requests_and_reports_corpus_failure() {
        let fixture = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        for body in [
            json!({"embeddingSpace":SPACE,"sampleId":""}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","clipId":null}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","clipId":7}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","limit":0}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","limit":null}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","limit":25}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","limit":1.5}),
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","unknown":true}),
        ] {
            assert_eq!(related(&fixture, body).await.0, StatusCode::BAD_REQUEST);
        }
        assert_eq!(
            related(
                &fixture,
                json!({"embeddingSpace":"other","sampleId":"smp_A"})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        std::fs::write(fixture.root.join("semantic/corpus.json"), b"{").unwrap();
        let (status, body) =
            related(&fixture, json!({"embeddingSpace":SPACE,"sampleId":"smp_A"})).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"]["retryable"], true);
    }

    #[tokio::test]
    async fn related_clip_keeps_distinct_clips_on_one_parent_but_samples_group_best_passage() {
        let records = vec![
            related_record("smp_A", "rec_A", "clp_A", 0.0, 0),
            related_record("smp_B", "rec_B", "clp_B", 0.0, 0),
            related_record("smp_B", "rec_B", "clp_B2", 4.0, 1),
        ];
        let fixture = fixture(records, analysis());
        add_related_parent(&fixture, "smp_B", "rec_B", "clp_B", 0.0);
        create(
            &mut fixture.shared_engine.lock().unwrap(),
            "Clip",
            json!({"id":"clp_B2","sampleId":"smp_B","name":"second clip","start":4.0,"end":8.0,"source":"user"}),
        );
        let (status, clips) = related(
            &fixture,
            json!({"embeddingSpace":SPACE,"sampleId":"smp_A","clipId":"clp_A"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            clips["hits"].as_array().unwrap().len(),
            2,
            "distinct saved clips must not be collapsed by sample"
        );
        let (_, samples) =
            related(&fixture, json!({"embeddingSpace":SPACE,"sampleId":"smp_A"})).await;
        assert_eq!(samples["hits"].as_array().unwrap().len(), 1);
        assert_eq!(samples["hits"][0]["card"]["clipId"], "clp_B");
    }

    #[test]
    fn related_representatives_are_farthest_first_with_stable_ties() {
        let mut negative = related_record("smp_A", "rec_A", "clp_A2", 8.0, 0);
        negative["vector"][0] = json!(-1.0);
        let records = vec![
            related_record("smp_A", "rec_A", "clp_A0", 0.0, 0),
            related_record("smp_A", "rec_A", "clp_A1", 4.0, 1),
            negative,
            related_record("smp_A", "rec_A", "clp_A3", 12.0, 3),
            related_record("smp_A", "rec_A", "clp_A4", 16.0, 0),
        ];
        let corpus = CachedCorpus {
            key: CorpusKey {
                len: 0,
                #[cfg(unix)]
                device: 0,
                #[cfg(unix)]
                inode: 0,
                #[cfg(unix)]
                mtime_seconds: 0,
                #[cfg(unix)]
                mtime_nanoseconds: 0,
                #[cfg(not(unix))]
                modified: std::time::SystemTime::UNIX_EPOCH,
            },
            records: validate_corpus(serde_json::from_value(corpus(records)).unwrap()).unwrap(),
        };
        let selected = choose_representatives(&corpus, (0..5).collect());
        assert_eq!(selected.len(), 4);
        let seed = (0..5)
            .min_by_key(|index| &corpus.records[*index].identity.semantic_id)
            .unwrap();
        assert_eq!(selected[0], seed, "smallest semanticId seeds selection");
        assert!(
            selected.contains(&2),
            "the negative passage maximizes 1-dot distance"
        );
        assert!(
            selected.contains(&1),
            "orthogonal tied passages use semanticId order"
        );
    }

    #[tokio::test]
    async fn route_rejects_stale_records_and_hydrates_current_canonical_cards() {
        // This is intentionally RED before the corrections: frozen display strings are allowed,
        // while every response must use current library metadata instead of the corpus copy.
        let analysis = json!({"source":{"sha256":SHA_A},"rhythm":{"bpm":120.0,"meter":4,"beats":[0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0,8.0,9.0,10.0,11.0,12.0,13.0,14.0,15.0,16.0],"downbeats":[0.0,4.0,8.0,12.0,16.0]}});
        let fixture = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis,
        );
        let (status, body) = search(
            &fixture,
            json!({"embeddingSpace":SPACE,"queryVector":vector(0)}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["hits"].as_array().unwrap().len(), 1, "{body}");
        assert_eq!(body["hits"][0]["parent"]["samplePath"], "current/path.wav");
        assert_eq!(body["hits"][0]["parent"]["sampleTitle"], "Current sample");
        assert_eq!(body["hits"][0]["card"]["clipName"], "Current clip");
        assert_eq!(body["hits"][0]["playback"]["fileKey"], "audio/current.wav");
    }

    fn analysis() -> Value {
        json!({"source":{"sha256":SHA_A},"rhythm":{"bpm":120.0,"meter":4,"beats":[0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0,8.0,9.0,10.0,11.0,12.0,13.0,14.0,15.0,16.0],"downbeats":[0.0,4.0,8.0,12.0,16.0]}})
    }

    #[tokio::test]
    async fn acceptance_request_ranking_and_filters_matrix() {
        let mut records = vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)];
        for (id, start) in [("clp_B", 4.0), ("clp_C", 8.0), ("clp_D", 12.0)] {
            let mut r = record("saved_clip", Some(id), start, start + 4.0, 0);
            let identity = identity("saved_clip", Some(id), start, start + 4.0, SHA_A);
            r["identity"] = identity.clone();
            r["revision"] = json!(sha(&serde_json::to_string(&json!([
                identity["semanticId"],
                ""
            ]))
            .unwrap()));
            records.push(r);
        }
        let f = fixture(records, analysis());
        for (id, start) in [("clp_B", 4.0), ("clp_C", 8.0), ("clp_D", 12.0)] {
            create(
                &mut f.shared_engine.lock().unwrap(),
                "Clip",
                json!({"id":id,"sampleId":"smp_A","name":id,"start":start,"end":start+4.0,"source":"user"}),
            );
        }
        let (status, body) = search(
            &f,
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"limit":100}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let ids: Vec<_> = body["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["identity"]["semanticId"].as_str().unwrap())
            .collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "exact dot ties sort semanticId ascending");
        assert_eq!(body["candidateCount"], 4);
        for invalid in [
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"limit":0}),
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"limit":101}),
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"limit":1.5}),
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"unknown":true}),
            json!({"embeddingSpace":SPACE,"queryVector":vec![0.0;512]}),
            json!({"embeddingSpace":SPACE,"queryVector":vec![1.0;511]}),
            json!({"embeddingSpace":SPACE,"queryVector":vec!["NaN";512]}),
        ] {
            assert_eq!(search(&f, invalid).await.0, StatusCode::BAD_REQUEST);
        }
        assert_eq!(
            search(
                &f,
                json!({"embeddingSpace":"wrong","queryVector":vector(0)})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            search(
                &f,
                json!({"embeddingSpace":SPACE,"queryVector":vector(0),"kind":"window"})
            )
            .await
            .1["candidateCount"],
            0
        );
        assert_eq!(
            search(
                &f,
                json!({"embeddingSpace":SPACE,"queryVector":vector(0),"sampleId":"missing"})
            )
            .await
            .1["candidateCount"],
            0
        );
    }

    #[tokio::test]
    async fn acceptance_corpus_and_timestamp_matrix() {
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        for bad in [
            "not-a-date",
            "2026-09-30T12:00:00+12:99",
            "2026-09-30T12:00:00Zx",
        ] {
            let mut c = corpus(vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)]);
            c["records"][0]["metadataUpdatedAt"] = json!(bad);
            std::fs::write(
                f.root.join("semantic/corpus.json"),
                serde_json::to_vec(&c).unwrap(),
            )
            .unwrap();
            assert_eq!(
                search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                    .await
                    .0,
                StatusCode::SERVICE_UNAVAILABLE,
                "{bad}"
            );
        }
        std::fs::remove_file(f.root.join("semantic/corpus.json")).unwrap();
        assert_eq!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        for bad in [b"{".as_slice()] {
            std::fs::write(f.root.join("semantic/corpus.json"), bad).unwrap();
            let (status, body) =
                search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)})).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(body["error"]["code"], "semantic_corpus_unavailable");
        }
        let r = record("saved_clip", Some("clp_A"), 0.0, 4.0, 0);
        std::fs::write(
            f.root.join("semantic/corpus.json"),
            serde_json::to_vec(&corpus(vec![r.clone(), r])).unwrap(),
        )
        .unwrap();
        assert_eq!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let mut wrong_fp = corpus(vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)]);
        wrong_fp["processingFingerprint"] = json!("wrong");
        std::fs::write(
            f.root.join("semantic/corpus.json"),
            serde_json::to_vec(&wrong_fp).unwrap(),
        )
        .unwrap();
        assert_eq!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn acceptance_freshness_and_true_window_matrix() {
        let mut window = record("window", None, 0.0, 16.0, 0);
        let i = window["identity"].clone();
        let grid = sha(&serde_json::to_string(&json!({"beats":analysis()["rhythm"]["beats"],"bpm":120.0,"downbeats":analysis()["rhythm"]["downbeats"],"meter":4})).unwrap());
        window["revision"] = json!(sha(
            &serde_json::to_string(&json!([i["semanticId"], grid])).unwrap()
        ));
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0), window],
            analysis(),
        );
        let (_, body) = search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)})).await;
        let hit = body["hits"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["identity"]["kind"] == "window")
            .unwrap();
        assert!(
            hit["identity"].get("clipId").is_none(),
            "frozen schema requires absent, not null"
        );
        {
            let e = &mut *f.shared_engine.lock().unwrap();
            e.call(
                "Clip",
                "update",
                &json!({"id":"clp_A","name":"Renamed","start":0.0,"end":4.0}),
                &Identity::ApiKey,
            )
            .unwrap();
        }
        let (_, body) = search(
            &f,
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"kind":"saved_clip"}),
        )
        .await;
        assert_eq!(body["hits"][0]["card"]["clipName"], "Renamed");
        f.shared_engine
            .lock()
            .unwrap()
            .call(
                "Clip",
                "update",
                &json!({"id":"clp_A","retired":true}),
                &Identity::ApiKey,
            )
            .unwrap();
        assert_eq!(
            search(
                &f,
                json!({"embeddingSpace":SPACE,"queryVector":vector(0),"kind":"saved_clip"})
            )
            .await
            .1["hits"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn acceptance_stale_canonical_models_and_manifests_are_excluded() {
        for update in [
            json!({"id":"clp_A","start":0.0,"end":3.0}),
            json!({"id":"smp_A","audio":{"key":"audio/current.wav","sha256":SHA_B,"size":1}}),
            json!({"id":"smp_A","duration":2.0}),
        ] {
            let f = fixture(
                vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
                analysis(),
            );
            let model = if update.get("start").is_some() {
                "Clip"
            } else {
                "Sample"
            };
            f.shared_engine
                .lock()
                .unwrap()
                .call(model, "update", &update, &Identity::ApiKey)
                .unwrap();
            let (_, body) =
                search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)})).await;
            assert!(body["hits"].as_array().unwrap().is_empty(), "{update}");
        }
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        f.shared_engine
            .lock()
            .unwrap()
            .call(
                "Sample",
                "delete",
                &json!({"id":"smp_A"}),
                &Identity::ApiKey,
            )
            .unwrap();
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut bad_manifest = analysis();
        bad_manifest["source"]["sha256"] = json!(SHA_B);
        let f = fixture(vec![record("window", None, 0.0, 16.0, 0)], bad_manifest);
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn canonical_identity_matches_python_unicode_fractional_fixture() {
        // Golden generated with SemanticIdentity in analysis/apricity_analyze/semantic_contract.py.
        let canonical = json!([
            "sämp🎵",
            "録音",
            "saved_clip",
            "clíp/雪",
            microseconds(0.0000005).unwrap(),
            microseconds(4.0000005).unwrap(),
            SHA_A,
            SPACE,
            "fp-β"
        ]);
        assert_eq!(
            serde_json::to_string(&canonical).unwrap(),
            "[\"sämp🎵\",\"録音\",\"saved_clip\",\"clíp/雪\",1,4000001,\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"clap-htsat-unfused-512-v1\",\"fp-β\"]"
        );
        assert_eq!(
            sha(&serde_json::to_string(&canonical).unwrap()),
            "5f55e9b2a87f472906a911412375413127ee204844eba0aada608ffc87a9b9d3"
        );
    }

    #[test]
    fn canonical_microseconds_match_python_decimal_round_half_up_without_panicking() {
        assert_eq!(microseconds(1e-300), Some(0));
        assert_eq!(microseconds(0.0000005), Some(1));
        assert_eq!(microseconds(4.0000005), Some(4_000_001));
        for value in [0.0, f64::MIN_POSITIVE, 1e-300, 1e-6, 1.0, 1e12, 1e308] {
            let _ = microseconds(value);
        }
        assert_eq!(microseconds(1e308), None);
    }

    #[tokio::test]
    async fn finite_unrepresentable_corpus_bounds_are_structured_unavailable() {
        for (start, end) in [(0.0, 1e308), (1e308, f64::MAX)] {
            let mut invalid = record("saved_clip", Some("clp_A"), 0.0, 4.0, 0);
            invalid["identity"]["start"] = json!(start);
            invalid["identity"]["end"] = json!(end);
            invalid["playback"]["start"] = json!(start);
            invalid["playback"]["end"] = json!(end);
            let f = fixture(vec![invalid], analysis());
            let (status, body) =
                search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)})).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
            assert_eq!(body["error"]["code"], "semantic_corpus_unavailable");
        }
    }

    #[tokio::test]
    async fn finite_unrepresentable_native_bounds_are_excluded() {
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        f.shared_engine
            .lock()
            .unwrap()
            .call(
                "Clip",
                "update",
                &json!({"id":"clp_A","start":1e308,"end":f64::MAX}),
                &Identity::ApiKey,
            )
            .unwrap();
        let (status, body) =
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["hits"].as_array().unwrap().is_empty(), "{body}");
    }

    #[tokio::test]
    async fn acceptance_ranking_default_and_maximum_limits_use_distinct_including_negative_scores()
    {
        let mut records = Vec::new();
        for index in 0..101 {
            let start = index as f64 * 4.0;
            let id = if index == 0 {
                "clp_A".to_owned()
            } else {
                format!("clp_{index:03}")
            };
            let mut value = record("saved_clip", Some(&id), start, start + 4.0, 0);
            let identity = identity("saved_clip", Some(&id), start, start + 4.0, SHA_A);
            value["identity"] = identity.clone();
            value["revision"] = json!(sha(&serde_json::to_string(&json!([
                identity["semanticId"],
                ""
            ]))
            .unwrap()));
            let score = 1.0 - index as f64 * 0.015;
            value["vector"] = json!([score, (1.0 - score * score).sqrt()]);
            let mut padded = value["vector"].as_array().unwrap().clone();
            padded.extend(std::iter::repeat(json!(0.0)).take(DIMENSIONS - 2));
            value["vector"] = Value::Array(padded);
            records.push(value);
        }
        let f = fixture(records, analysis());
        for index in 1..101 {
            let start = index as f64 * 4.0;
            let id = format!("clp_{index:03}");
            create(
                &mut f.shared_engine.lock().unwrap(),
                "Clip",
                json!({"id":id,"sampleId":"smp_A","name":id,"start":start,"end":start+4.0,"source":"user"}),
            );
        }
        let (_, defaulted) =
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)})).await;
        assert_eq!(defaulted["candidateCount"], 101);
        assert_eq!(defaulted["hits"].as_array().unwrap().len(), 24);
        assert_eq!(defaulted["hits"][0]["score"], 1.0);
        let (_, maximum) = search(
            &f,
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"limit":100}),
        )
        .await;
        let hits = maximum["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 100);
        assert!(
            hits.last().unwrap()["score"].as_f64().unwrap() < 0.0,
            "the bounded result set retains negative dot scores"
        );
        assert!(hits.windows(2).all(|pair| pair[0]["score"].as_f64().unwrap() > pair[1]["score"].as_f64().unwrap()));
    }

    #[tokio::test]
    async fn only_hydrates_candidates_until_the_requested_valid_limit() {
        let mut records = Vec::new();
        for index in 0..25 {
            let start = index as f64 * 4.0;
            let clip_id = if index == 0 {
                "clp_A".to_owned()
            } else {
                format!("clp_bounded_{index:02}")
            };
            let mut value = record("saved_clip", Some(&clip_id), start, start + 4.0, 0);
            let identity = identity("saved_clip", Some(&clip_id), start, start + 4.0, SHA_A);
            value["identity"] = identity.clone();
            value["revision"] = json!(sha(&serde_json::to_string(&json!([
                identity["semanticId"],
                ""
            ]))
            .unwrap()));
            let score = 1.0 - index as f64 * 0.02;
            let mut vector = vec![score, (1.0 - score * score).sqrt()];
            vector.extend(std::iter::repeat(0.0).take(DIMENSIONS - vector.len()));
            value["vector"] = json!(vector);
            records.push(value);
        }
        let f = fixture(records, analysis());
        for index in 1..24 {
            let start = index as f64 * 4.0;
            let clip_id = format!("clp_bounded_{index:02}");
            create(
                &mut f.shared_engine.lock().unwrap(),
                "Clip",
                json!({"id":clip_id,"sampleId":"smp_A","name":clip_id,"start":start,"end":start+4.0,"source":"user"}),
            );
        }

        let (status, body) = search(
            &f,
            json!({"embeddingSpace":SPACE,"queryVector":vector(0),"limit":24}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["candidateCount"], 25);
        assert_eq!(body["hits"].as_array().unwrap().len(), 24);
        assert_eq!(
            body["filteredCount"], 0,
            "the stale 25th candidate is never hydrated or counted after the limit is filled"
        );
    }

    #[test]
    fn fixed_vectors_match_the_exact_dot_product_baseline_ordering() {
        let cases = [
            ("clp_e0", 0.0, 4.0, 1.0, 0.0),
            ("clp_e1", 4.0, 8.0, 0.0, 1.0),
            (
                "clp_mix",
                8.0,
                12.0,
                std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
            ),
            ("clp_negative", 12.0, 16.0, -1.0, 0.0),
        ];
        let mut records = Vec::new();
        for (clip_id, start, end, x, y) in cases {
            let mut value = record("saved_clip", Some(clip_id), start, end, 0);
            let identity = identity("saved_clip", Some(clip_id), start, end, SHA_A);
            value["identity"] = identity.clone();
            value["revision"] = json!(sha(&serde_json::to_string(&json!([
                identity["semanticId"],
                ""
            ]))
            .unwrap()));
            let mut vector = vec![x, y];
            vector.extend(std::iter::repeat(0.0).take(DIMENSIONS - vector.len()));
            value["vector"] = json!(vector);
            records.push(value);
        }
        let parsed: Corpus = serde_json::from_value(corpus(records)).unwrap();
        let cached = CachedCorpus {
            key: corpus_key(&std::fs::metadata("Cargo.toml").unwrap()),
            records: validate_corpus(parsed).unwrap(),
        };
        let mut query = vec![0.6, 0.8];
        query.extend(std::iter::repeat(0.0).take(DIMENSIONS - query.len()));
        let ordered: Vec<_> = score_records(&cached, &query, Some("saved_clip"), Some("smp_A"))
            .into_iter()
            .map(|(_, index)| cached.records[index].identity.clip_id().unwrap().to_owned())
            .collect();
        assert_eq!(ordered, ["clp_mix", "clp_e1", "clp_e0", "clp_negative"]);
    }

    fn replace_atomically(path: &std::path::Path, bytes: &[u8]) {
        let replacement = path.with_extension("replacement");
        std::fs::write(&replacement, bytes).unwrap();
        std::fs::rename(replacement, path).unwrap();
    }

    #[tokio::test]
    async fn reuses_an_unchanged_validated_corpus_but_fails_closed_on_same_size_replacement() {
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        let body = json!({"embeddingSpace":SPACE,"queryVector":vector(0)});
        assert_eq!(search(&f, body.clone()).await.0, StatusCode::OK);
        assert_eq!(f.cache.lock().unwrap().loads, 1);
        assert_eq!(search(&f, body.clone()).await.0, StatusCode::OK);
        assert_eq!(
            f.cache.lock().unwrap().loads,
            1,
            "the immutable parsed vectors are reused while the opened file metadata is unchanged"
        );

        let corpus_path = f.root.join("semantic/corpus.json");
        let original = std::fs::read(&corpus_path).unwrap();
        let corrupt = vec![b'{'; original.len()];
        replace_atomically(&corpus_path, &corrupt);
        assert_eq!(corrupt.len(), original.len());
        assert_eq!(
            search(&f, body.clone()).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            f.cache.lock().unwrap().loads,
            1,
            "a corrupt replacement cannot become a cached corpus"
        );

        replace_atomically(&corpus_path, &original);
        assert_eq!(search(&f, body).await.0, StatusCode::OK);
        assert_eq!(
            f.cache.lock().unwrap().loads,
            2,
            "an atomic same-size replacement has a new opened-file identity and reloads"
        );
    }

    #[tokio::test]
    async fn cached_vectors_never_bypass_model_or_current_canonical_validation() {
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        let body = json!({"embeddingSpace":SPACE,"queryVector":vector(0)});
        assert_eq!(search(&f, body.clone()).await.0, StatusCode::OK);
        let corpus_path = f.root.join("semantic/corpus.json");
        let mut invalid_version = corpus(vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)]);
        invalid_version["embeddingSpace"] = json!("blap-htsat-unfused-512-v1");
        let invalid = serde_json::to_vec(&invalid_version).unwrap();
        assert_eq!(
            invalid.len(),
            std::fs::metadata(&corpus_path).unwrap().len() as usize
        );
        replace_atomically(&corpus_path, &invalid);
        assert_eq!(
            search(&f, body.clone()).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );

        let valid = serde_json::to_vec(&corpus(vec![record(
            "saved_clip",
            Some("clp_A"),
            0.0,
            4.0,
            0,
        )]))
        .unwrap();
        replace_atomically(&corpus_path, &valid);
        assert_eq!(search(&f, body.clone()).await.0, StatusCode::OK);
        f.shared_engine
            .lock()
            .unwrap()
            .call(
                "Clip",
                "update",
                &json!({"id":"clp_A","start":0.0,"end":3.0}),
                &Identity::ApiKey,
            )
            .unwrap();
        let (_, response) = search(&f, body).await;
        assert!(response["hits"].as_array().unwrap().is_empty());
        assert_eq!(
            f.cache.lock().unwrap().loads,
            2,
            "canonical entities are not retained in the corpus cache"
        );
    }

    #[tokio::test]
    async fn concurrent_requests_to_a_corrupt_replacement_are_bounded_and_never_serve_stale_hits() {
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        let body = json!({"embeddingSpace":SPACE,"queryVector":vector(0)});
        assert_eq!(search(&f, body.clone()).await.0, StatusCode::OK);
        let corpus_path = f.root.join("semantic/corpus.json");
        let len = std::fs::metadata(&corpus_path).unwrap().len() as usize;
        replace_atomically(&corpus_path, &vec![b'x'; len]);
        let (one, two, three, four) = tokio::join!(
            search(&f, body.clone()),
            search(&f, body.clone()),
            search(&f, body.clone()),
            search(&f, body),
        );
        for (status, response) in [one, two, three, four] {
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{response}");
            assert_eq!(response["error"]["code"], "semantic_corpus_unavailable");
        }
    }

    #[test]
    fn concurrent_cold_requests_parse_one_immutable_corpus() {
        let records = (0..1000)
            .map(|index| {
                record(
                    "saved_clip",
                    Some(&format!("clp_cold_{index}")),
                    0.0,
                    4.0,
                    0,
                )
            })
            .collect();
        let f = fixture(records, analysis());
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let barrier = barrier.clone();
                let cache = f.cache.clone();
                let path = f.root.join("semantic/corpus.json");
                std::thread::spawn(move || {
                    barrier.wait();
                    load_corpus(&path, &cache).unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(
            results
                .iter()
                .all(|corpus| Arc::ptr_eq(corpus, &results[0]))
        );
        assert_eq!(
            f.cache.lock().unwrap().parse_attempts,
            1,
            "parallel cold searches must not each parse the full library"
        );
    }

    #[tokio::test]
    async fn acceptance_removes_missing_parents_and_stale_window_manifests() {
        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        f.shared_engine
            .lock()
            .unwrap()
            .call(
                "Recording",
                "delete",
                &json!({"id":"rec_A"}),
                &Identity::ApiKey,
            )
            .unwrap();
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let f = fixture(
            vec![record("saved_clip", Some("clp_A"), 0.0, 4.0, 0)],
            analysis(),
        );
        f.shared_engine
            .lock()
            .unwrap()
            .call("Clip", "delete", &json!({"id":"clp_A"}), &Identity::ApiKey)
            .unwrap();
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let current = analysis();
        let f = fixture(vec![window_record(0.0, 16.0, &current)], current.clone());
        let edited = json!({"source":{"sha256":SHA_A},"rhythm":{"bpm":120.0,"meter":4,"beats":[0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0,8.0,9.0,10.0,11.0,12.0,13.0,14.0,15.0,16.0],"downbeats":[0.0,3.0,6.0,9.0,12.0,15.0,18.0]}});
        std::fs::write(
            f.root.join("files/analysis/smp_A/manifest.json"),
            serde_json::to_vec(&edited).unwrap(),
        )
        .unwrap();
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty(),
            "an edited grid invalidates the indexed window revision"
        );

        let f = fixture(vec![window_record(0.0, 16.0, &analysis())], analysis());
        std::fs::write(
            f.root.join("files/analysis/smp_A/manifest.json"),
            b"changed bytes",
        )
        .unwrap();
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty(),
            "the actual manifest hash must match Sample.analysis.sha256"
        );

        let no_window = json!({"source":{"sha256":SHA_A},"rhythm":{"bpm":120.0,"meter":4,"beats":[0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0],"downbeats":[0.0,4.0,8.0]}});
        let f = fixture(vec![record("window", None, 0.0, 16.0, 0)], no_window);
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty(),
            "absent current grid windows are not returned"
        );

        let stale_source = json!({"source":{"sha256":SHA_B},"rhythm":{"bpm":120.0,"meter":4,"beats":[0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0,8.0,9.0,10.0,11.0,12.0,13.0,14.0,15.0,16.0],"downbeats":[0.0,4.0,8.0,12.0,16.0]}});
        let f = fixture(vec![record("window", None, 0.0, 16.0, 0)], stale_source);
        assert!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .1["hits"]
                .as_array()
                .unwrap()
                .is_empty(),
            "a stale manifest source hash denies windows"
        );
    }

    #[tokio::test]
    async fn acceptance_rejects_explicit_null_window_clip_id_in_corpus() {
        let mut invalid = window_record(0.0, 16.0, &analysis());
        invalid["identity"]["clipId"] = Value::Null;
        let f = fixture(vec![invalid], analysis());
        assert_eq!(
            search(&f, json!({"embeddingSpace":SPACE,"queryVector":vector(0)}))
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
