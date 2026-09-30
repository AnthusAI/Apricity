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

/// Local semantic endpoint.  The corpus is read afresh for every request: publishers replace it atomically.
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
    let corpus: Corpus = match std::fs::read(&state.corpus)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(c) => c,
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "semantic_corpus_unavailable",
                "semantic corpus is missing or corrupt; retry after publication",
                true,
            );
        }
    };
    if corpus.schema_version != "apricity.semantic-corpus/1"
        || corpus.embedding_space != SPACE
        || corpus.processing_fingerprint.is_empty()
        || corpus
            .records
            .iter()
            .any(|r| !valid_record(r, &corpus.processing_fingerprint))
        || {
            let mut ids = std::collections::HashSet::new();
            corpus
                .records
                .iter()
                .any(|r| !ids.insert(&r.identity.semantic_id))
        }
    {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "semantic_corpus_unavailable",
            "semantic corpus failed validation; retry after publication",
            true,
        );
    }
    let mut candidates: Vec<(f64, Record)> = corpus
        .records
        .into_iter()
        .filter(|r| {
            request
                .kind
                .as_deref()
                .map_or(true, |k| r.identity.kind == k)
                && request
                    .sample_id
                    .as_deref()
                    .map_or(true, |s| r.identity.sample_id == s)
        })
        .map(|r| {
            (
                r.vector
                    .iter()
                    .zip(&request.query_vector)
                    .map(|(a, b)| a * b)
                    .sum(),
                r,
            )
        })
        .collect();
    candidates.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1.identity.semantic_id.cmp(&b.1.identity.semantic_id))
    });
    let candidate_count = candidates.len();
    let mut valid_hits = Vec::new();
    // Corpus publication is fresh per request, while a request may contain many windows for
    // one sample. Read and validate each sample manifest once for this request only.
    let mut analyses = std::collections::HashMap::new();
    let mut filtered = 0usize;
    for (score, record) in candidates {
        if let Some(hit) = hydrate(&state, &record, score, &mut analyses) {
            valid_hits.push(hit);
        } else {
            filtered += 1;
        }
    }
    let hits: Vec<Value> = valid_hits.into_iter().take(limit).collect();
    axum::Json(json!({"hits": hits, "embeddingSpace": SPACE, "candidateCount": candidate_count, "filteredCount": filtered})).into_response()
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
        let app = Router::new()
            .route(
                "/semantic/search",
                axum::routing::post(crate::semantic::search),
            )
            .with_state(SemanticState {
                corpus: root.join("semantic/corpus.json"),
                engine: shared_engine.clone(),
                files,
            });
        Fixture {
            _dir: dir,
            root,
            app,
            shared_engine,
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
