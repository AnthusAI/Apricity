//! Migration: import a repository's files (manifests, samples, candidates, scores) into a
//! library. Implements design/storage.md §5. Deterministic and idempotent: every record has a
//! derived id and is written only when it differs from what the library holds, so a second run
//! over unchanged input reports zero changes.

use crate::files::{FileRef, FsFiles};
use crate::ids;
use crate::position::generate_n_keys_between;
use crate::score_refs::{self, CatalogRef};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;
use virtuus_amplify::{Engine, Identity};

/// Slice kinds (`Kind` enum in the contract).
const KINDS: [&str; 7] = ["loop", "break", "hit", "phrase", "section", "chop", "other"];

/// Largest score text the contract allows.
const MAX_SCORE_BYTES: usize = 300 * 1024;

/// Errors that abort a migration. Unresolved score references do not: they are collected in
/// [`MigrationReport::unresolved`] so the whole run is still written and reported.
#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error in {path}: {source}")]
    Json {
        path: String,
        source: serde_json::Error,
    },

    #[error("Files error: {0}")]
    Files(#[from] crate::files::Error),

    #[error("Engine error on {model}: {message}")]
    Engine { model: String, message: String },

    #[error("{0}")]
    Data(String),
}

pub type Result<T> = std::result::Result<T, MigrationError>;

/// Counts of records changed by a run (created or updated), plus problems found.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MigrationReport {
    pub recordings: usize,
    pub clips: usize,
    pub slices: usize,
    pub markers: usize,
    pub candidates: usize,
    pub verdicts: usize,
    pub crates: usize,
    pub crate_items: usize,
    pub scores: usize,
    pub score_refs: usize,
    /// Audio, analysis and document files written (or re-linked) into `files/`.
    pub files: usize,
    /// Score references (and candidate/verdict/crate references) that resolve to nothing.
    pub unresolved: Vec<String>,
    /// Inputs skipped without being an error (audio not downloaded, duplicate names).
    pub skipped: Vec<String>,
}

impl MigrationReport {
    pub fn total_changes(&self) -> usize {
        self.recordings
            + self.clips
            + self.slices
            + self.markers
            + self.candidates
            + self.verdicts
            + self.crates
            + self.crate_items
            + self.scores
            + self.score_refs
            + self.files
    }

    pub fn display(&self) -> String {
        let mut out = format!(
            "Migration report (changes this run):\n  Recordings: {}\n  Clips: {}\n  Slices: {}\n  Markers: {}\n  Candidates: {}\n  Verdicts: {}\n  Crates: {}\n  CrateItems: {}\n  Scores: {}\n  ScoreRefs: {}\n  Files: {}",
            self.recordings,
            self.clips,
            self.slices,
            self.markers,
            self.candidates,
            self.verdicts,
            self.crates,
            self.crate_items,
            self.scores,
            self.score_refs,
            self.files
        );
        for s in &self.skipped {
            out.push_str(&format!("\n  skipped: {s}"));
        }
        for u in &self.unresolved {
            out.push_str(&format!("\n  UNRESOLVED: {u}"));
        }
        out
    }
}

/// Engine plus the local identity, with change-detecting writes.
struct Ctx<'a> {
    engine: &'a mut Engine,
    identity: Identity,
}

impl Ctx<'_> {
    fn call(&mut self, model: &str, op: &str, args: &Value) -> Result<Value> {
        let (data, errors) = self
            .engine
            .call(model, op, args, &self.identity)
            .map_err(|e| MigrationError::Engine {
                model: model.into(),
                message: e.to_string(),
            })?;
        match errors {
            Some(errs) if !errs.is_empty() => Err(MigrationError::Engine {
                model: model.into(),
                message: format!("{op} {args}: {errs:?}"),
            }),
            _ => Ok(data),
        }
    }

    /// Create or update `record` so the library holds it. Returns whether anything changed.
    fn upsert(&mut self, model: &str, record: Value) -> Result<bool> {
        let record = strip_nulls(record);
        let key = if model == "Verdict" {
            json!({"candidateId": record["candidateId"], "judge": record["judge"]})
        } else {
            json!({"id": record["id"]})
        };
        let existing = self.call(model, "get", &key)?;
        let fresh = existing.is_null();
        if !fresh
            && record
                .as_object()
                .is_some_and(|new| new.iter().all(|(k, v)| existing.get(k) == Some(v)))
        {
            return Ok(false);
        }
        // Virtuus's field validation treats every array field (tags, aliases, ...) as a plain
        // string, so records with arrays go straight to the table with the timestamps the engine
        // would have added.
        if record
            .as_object()
            .is_some_and(|m| m.values().any(Value::is_array))
        {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let mut full = record;
            full["createdAt"] = if fresh {
                json!(now)
            } else {
                existing["createdAt"].clone()
            };
            full["updatedAt"] = json!(now);
            full["__typename"] = json!(model);
            self.engine
                .table_mut(model)
                .ok_or_else(|| MigrationError::Engine {
                    model: model.into(),
                    message: "no such table".into(),
                })?
                .put(full);
        } else {
            self.call(model, if fresh { "create" } else { "update" }, &record)?;
        }
        Ok(true)
    }

    /// Every record of an index query, following `nextToken`.
    fn query_all(&mut self, model: &str, op: &str, key: Value) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut token = Value::Null;
        loop {
            let mut args = json!({ "key": key, "limit": 1000 });
            if !token.is_null() {
                args["nextToken"] = token.clone();
            }
            let page = self.call(model, op, &args)?;
            items.extend(
                page.get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            token = page.get("nextToken").cloned().unwrap_or(Value::Null);
            if token.is_null() {
                return Ok(items);
            }
        }
    }
}

fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, strip_nulls(v)))
                .collect(),
        ),
        other => other,
    }
}

fn read_json(path: &Path) -> Result<Value> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|source| MigrationError::Json {
        path: path.display().to_string(),
        source,
    })
}

fn file_ref_json(r: &FileRef) -> Value {
    json!({"key": r.key, "sha256": r.sha256, "size": r.size, "contentType": r.content_type})
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// One `*.apricity.json` found under `samples/`.
struct ClipPlan {
    /// Samples-relative path of the audio: the catalog path scores use.
    rel: String,
    manifest: Value,
    audio: PathBuf,
    id: String,
    parent_id: Option<String>,
}

/// Where a clip's recording lives: (recording id, collection).
fn recording_key(rel: &str) -> (String, String) {
    let parts: Vec<&str> = rel.split('/').collect();
    let stem_of = |file: &str| {
        file.rsplit_once('.')
            .map_or(file.to_string(), |(s, _)| s.to_string())
    };
    match parts.as_slice() {
        ["marine-band", "stems", piece, ..] => (format!("rec_{piece}"), "marine-band".into()),
        ["marine-band", "scores", file] | ["marine-band", file] => {
            (format!("rec_{}", stem_of(file)), "marine-band".into())
        }
        ["salamander-drumkit", ..] => ("rec_salamander-drumkit".into(), "salamander-drumkit".into()),
        ["citizen-dj", coll, file] => {
            let item = loc_item(file).unwrap_or_else(|| stem_of(file));
            (format!("rec_{coll}_{item}"), format!("citizen-dj/{coll}"))
        }
        _ => (
            format!(
                "rec_uploads_{}",
                stem_of(parts.last().copied().unwrap_or("unknown"))
            ),
            "uploads".into(),
        ),
    }
}

/// The Library of Congress item id in a Citizen DJ excerpt name:
/// `The-stars-and-stripes-forever-march_00694038_001_00-01-15.wav` gives `00694038`.
fn loc_item(file: &str) -> Option<String> {
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    let mut fields: Vec<&str> = stem.split('_').collect();
    // Drop the trailing `<NNN>_<hh-mm-ss>` excerpt suffix, keep what identifies the item.
    if fields.len() < 4 {
        return None;
    }
    fields.truncate(fields.len() - 2);
    fields.last().map(|s| s.to_string())
}

/// `HH:MM:SS` to seconds.
fn parse_hms(s: &str) -> Option<f64> {
    let parts: Vec<f64> = s
        .split(':')
        .map(|p| p.parse::<f64>().ok())
        .collect::<Option<_>>()?;
    Some(parts.iter().fold(0.0, |acc, p| acc * 60.0 + p))
}

/// Migrate `repo_root` into the library `engine` (`library_path` holds `files/`). Audio is
/// hard-linked with `use_link`, otherwise copied.
pub fn migrate(
    repo_root: impl AsRef<Path>,
    engine: &mut Engine,
    library_path: impl AsRef<Path>,
    use_link: bool,
) -> Result<MigrationReport> {
    migrate_with_sources(repo_root, engine, library_path, use_link, &[])
}

/// [`migrate`], with more `sources.json`-shaped entries (path, title, credit, rights,
/// source_page, url) than `samples/sources.json` holds: the predefined download sources.
pub fn migrate_with_sources(
    repo_root: impl AsRef<Path>,
    engine: &mut Engine,
    library_path: impl AsRef<Path>,
    use_link: bool,
    extra_sources: &[Value],
) -> Result<MigrationReport> {
    let repo = repo_root.as_ref();
    let mut report = MigrationReport::default();
    let mut ctx = Ctx {
        engine,
        identity: Identity::User {
            sub: "local".into(),
            username: "migrator".into(),
            groups: vec!["members".into(), "curators".into()],
        },
    };
    let mut files = FsFiles::new(library_path.as_ref().join("files"));
    let samples = repo.join("samples");

    let mut sources = load_sources(&samples)?;
    sources.extend(extra_sources.iter().cloned());
    let mut plans = discover_clips(&samples)?;
    assign_ids(&mut plans)?;

    migrate_recordings(
        &mut ctx,
        &mut files,
        &samples,
        &sources,
        &plans,
        &mut report,
    )?;
    let catalog = migrate_clips(
        &mut ctx,
        &mut files,
        &sources,
        &plans,
        use_link,
        &mut report,
    )?;
    let slices = migrate_annotations(&mut ctx, &plans, &catalog, &mut report)?;
    let candidates = migrate_candidates(&mut ctx, &repo.join("library"), &catalog, &mut report)?;
    migrate_crates(&mut ctx, &repo.join("library"), &candidates, &mut report)?;
    migrate_scores(&mut ctx, repo, &catalog, &slices, &mut report)?;
    Ok(report)
}

fn load_sources(samples: &Path) -> Result<Vec<Value>> {
    let path = samples.join("sources.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(read_json(&path)?
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn discover_clips(samples: &Path) -> Result<Vec<ClipPlan>> {
    let mut manifests = Vec::new();
    walk(samples, &mut |p| {
        if p.to_string_lossy().ends_with(".apricity.json") {
            manifests.push(p.to_path_buf());
        }
    })?;
    manifests.sort();
    let mut plans = Vec::new();
    for mpath in manifests {
        let manifest = read_json(&mpath)?;
        let source = manifest
            .get("source")
            .ok_or_else(|| MigrationError::Data(format!("{}: no source", mpath.display())))?;
        let file = str_of(source, "path")
            .ok_or_else(|| MigrationError::Data(format!("{}: no source.path", mpath.display())))?;
        let dir = mpath.parent().unwrap_or(samples);
        let rel_dir = dir
            .strip_prefix(samples)
            .map_err(|e| MigrationError::Data(e.to_string()))?;
        let rel = rel_dir.join(file).to_string_lossy().replace('\\', "/");
        plans.push(ClipPlan {
            rel,
            audio: dir.join(file),
            manifest,
            id: String::new(),
            parent_id: None,
        });
    }
    Ok(plans)
}

/// Sources get `clp_<sha256>`; a stem hashes how it was made (parent id, stem, model).
fn assign_ids(plans: &mut [ClipPlan]) -> Result<()> {
    for p in plans.iter_mut() {
        if p.manifest.get("derived_from").is_none() {
            let sha = str_of(&p.manifest["source"], "sha256")
                .ok_or_else(|| MigrationError::Data(format!("{}: no source.sha256", p.rel)))?;
            p.id = ids::clip_id(sha);
        }
    }
    let by_repo_path: HashMap<String, String> = plans
        .iter()
        .filter(|p| !p.id.is_empty())
        .map(|p| (format!("samples/{}", p.rel), p.id.clone()))
        .collect();
    // Stems of stems resolve on later passes.
    let mut resolved = by_repo_path;
    for _ in 0..plans.len().max(1) {
        let mut progress = false;
        for p in plans.iter_mut().filter(|p| p.id.is_empty()) {
            let d = &p.manifest["derived_from"];
            let (Some(src), Some(stem), Some(model)) =
                (str_of(d, "source"), str_of(d, "stem"), str_of(d, "model"))
            else {
                return Err(MigrationError::Data(format!(
                    "{}: derived_from needs source, stem and model",
                    p.rel
                )));
            };
            if let Some(parent) = resolved.get(src) {
                p.id = ids::stem_clip_id(parent, stem, model);
                p.parent_id = Some(parent.clone());
                resolved.insert(format!("samples/{}", p.rel), p.id.clone());
                progress = true;
            }
        }
        if !progress {
            break;
        }
    }
    if let Some(p) = plans.iter().find(|p| p.id.is_empty()) {
        return Err(MigrationError::Data(format!(
            "{}: derived_from.source {:?} is not a migrated clip",
            p.rel, p.manifest["derived_from"]["source"]
        )));
    }
    Ok(())
}

fn migrate_recordings(
    ctx: &mut Ctx,
    files: &mut FsFiles,
    samples: &Path,
    sources: &[Value],
    plans: &[ClipPlan],
    report: &mut MigrationReport,
) -> Result<()> {
    // recording id -> (collection, first audio entry, score documents)
    let mut groups: BTreeMap<String, (String, Option<&Value>, Vec<&Value>)> = BTreeMap::new();
    for s in sources {
        let path = str_of(s, "path")
            .ok_or_else(|| MigrationError::Data("sources.json entry without path".into()))?;
        let (id, coll) = recording_key(path);
        let g = groups.entry(id).or_insert((coll, None, Vec::new()));
        if str_of(s, "kind") == Some("score") {
            g.2.push(s);
        } else if g.1.is_none() {
            g.1 = Some(s);
        }
    }
    for p in plans {
        let (id, coll) = recording_key(&p.rel);
        groups.entry(id).or_insert((coll, None, Vec::new()));
    }
    for (id, (collection, entry, documents)) in groups {
        let mut rec = Map::new();
        rec.insert("id".into(), json!(id));
        rec.insert("collection".into(), json!(collection));
        let fallback_title = id.trim_start_matches("rec_").to_string();
        let meta = entry.or_else(|| documents.first().copied());
        rec.insert(
            "title".into(),
            json!(
                meta.and_then(|m| str_of(m, "title"))
                    .map_or(fallback_title, str::to_string)
            ),
        );
        if let Some(m) = meta {
            for (from, to) in [
                ("performer", "performer"),
                ("recorded", "recorded"),
                ("credit", "credit"),
                ("rights", "rights"),
                ("source_page", "sourcePage"),
                ("url", "url"),
            ] {
                if let Some(v) = str_of(m, from) {
                    rec.insert(to.into(), json!(v));
                }
            }
            if let Some(c) = m.get("composed").and_then(Value::as_i64) {
                rec.insert("composed".into(), json!(c));
            }
        }
        let mut docs = Vec::new();
        for d in documents {
            let path = str_of(d, "path").unwrap_or_default();
            let src = samples.join(path);
            let name = path.rsplit('/').next().unwrap_or(path);
            if !src.exists() {
                report
                    .skipped
                    .push(format!("document {path} is not downloaded"));
                continue;
            }
            let (r, changed) = files.import(
                &format!("documents/{id}/{name}"),
                &src,
                Some("application/pdf"),
                false,
            )?;
            report.files += changed as usize;
            docs.push(file_ref_json(&r));
        }
        if !docs.is_empty() {
            rec.insert("documents".into(), Value::Array(docs));
        }
        report.recordings += ctx.upsert("Recording", Value::Object(rec))? as usize;
    }
    Ok(())
}

/// Clip ids by catalog path and by alias, with what the later steps need.
struct Catalog {
    by_path: HashMap<String, String>,
    recording_of: HashMap<String, String>,
}

impl Catalog {
    fn clip_for(&self, path: &str) -> Option<&String> {
        self.by_path.get(path).or_else(|| {
            path.strip_prefix("samples/")
                .and_then(|p| self.by_path.get(p))
        })
    }
}

fn migrate_clips(
    ctx: &mut Ctx,
    files: &mut FsFiles,
    sources: &[Value],
    plans: &[ClipPlan],
    link: bool,
    report: &mut MigrationReport,
) -> Result<Catalog> {
    let entries: HashMap<&str, &Value> = sources
        .iter()
        .filter_map(|s| Some((str_of(s, "path")?, s)))
        .collect();
    let mut catalog = Catalog {
        by_path: HashMap::new(),
        recording_of: HashMap::new(),
    };
    for p in plans {
        if !p.audio.exists() {
            report.skipped.push(format!(
                "clip {} has no audio file (run scripts/fetch-samples.py)",
                p.rel
            ));
            continue;
        }
        let filename = p
            .audio
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio");
        let ctype = if filename.ends_with(".mp3") {
            "audio/mpeg"
        } else {
            "audio/wav"
        };
        let (audio, changed) = files.import(
            &format!("audio/{}/{filename}", p.id),
            &p.audio,
            Some(ctype),
            link,
        )?;
        report.files += changed as usize;

        // Analysis attachment: the manifest minus annotations, canonical (sorted-key) JSON.
        let mut analysis = p.manifest.clone();
        analysis.as_object_mut().map(|m| m.remove("annotations"));
        let analysis_bytes =
            serde_json::to_vec(&analysis).map_err(|source| MigrationError::Json {
                path: p.rel.clone(),
                source,
            })?;
        let analysis_ref = put_analysis(files, &p.id, &analysis_bytes, report)?;

        let (recording_id, collection) = recording_key(&p.rel);
        let entry = entries.get(p.rel.as_str());
        let role = if p.parent_id.is_some() {
            "stem"
        } else if entry.is_some_and(|e| e.get("excerpt_start").is_some()) {
            "excerpt"
        } else if collection == "uploads" {
            "upload"
        } else {
            "source"
        };
        let m = &p.manifest;
        let mut clip = json!({
            "id": p.id, "recordingId": recording_id, "path": p.rel, "aliases": [format!("samples/{}", p.rel)],
            "collection": collection, "title": filename, "role": role, "status": "ready",
            "audio": file_ref_json(&audio), "analysis": file_ref_json(&analysis_ref),
            "duration": m["source"]["duration"], "sampleRate": m["source"]["sample_rate"], "channels": m["source"]["channels"],
            "analysisVersion": m["apricity_manifest"], "analyzedAt": m["analysis"]["analyzed_at"],
            "bpm": m["rhythm"]["bpm"], "bpmStability": m["rhythm"]["bpm_stability"], "meter": m["rhythm"]["meter"],
            "tuningCents": m["tonal"]["tuning_cents"],
            "nameCounters": name_counters(m).to_string(),
        });
        if let Some(k) = m["tonal"]
            .get("key")
            .and_then(|k| Some(format!("{} {}", str_of(k, "tonic")?, str_of(k, "mode")?)))
        {
            clip["key"] = json!(k);
        }
        clip["camelot"] = m["tonal"]["key"]
            .get("camelot")
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(segs) = m["tonal"].get("segments").and_then(Value::as_array) {
            let keys: Vec<String> = segs
                .iter()
                .filter_map(|s| {
                    Some(format!(
                        "{} {}",
                        str_of(&s["key"], "tonic")?,
                        str_of(&s["key"], "mode")?
                    ))
                })
                .collect();
            clip["keysOverTime"] = json!(keys);
        }
        if let Some(n) = m.get("notes").and_then(Value::as_array) {
            clip["noteCount"] = json!(n.len());
        }
        if role == "stem" {
            clip["stem"] = m["derived_from"]["stem"].clone();
            clip["stemModel"] = m["derived_from"]["model"].clone();
            clip["parentClipId"] = json!(p.parent_id);
        }
        if let Some(t) = entry
            .and_then(|e| str_of(e, "excerpt_start"))
            .and_then(parse_hms)
        {
            clip["excerptStart"] = json!(t);
        }
        report.clips += ctx.upsert("Clip", clip)? as usize;
        catalog.by_path.insert(p.rel.clone(), p.id.clone());
        catalog.recording_of.insert(p.id.clone(), recording_id);
    }
    Ok(catalog)
}

/// Write `analysis/<clipId>/<sha256 of content>.json` unless it is already there.
fn put_analysis(
    files: &mut FsFiles,
    clip_id: &str,
    bytes: &[u8],
    report: &mut MigrationReport,
) -> Result<FileRef> {
    use sha2::{Digest, Sha256};
    let sha = format!("{:x}", Sha256::digest(bytes));
    let key = format!("analysis/{clip_id}/{sha}.json");
    let path = files.path_of(&key);
    let existing = fs::read(&path).ok();
    if existing.as_deref() != Some(bytes) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, bytes)?;
        report.files += 1;
    }
    Ok(FileRef {
        key,
        sha256: sha,
        size: bytes.len() as u64,
        content_type: Some("application/json".into()),
    })
}

/// `{"loop": 7}` from existing `loop-N` names: ML slice names are never reused.
fn name_counters(manifest: &Value) -> Value {
    let mut counters: BTreeMap<String, u64> = BTreeMap::new();
    for s in manifest["annotations"]["clips"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let Some((prefix, n)) = str_of(s, "name").and_then(|n| n.rsplit_once('-')) else {
            continue;
        };
        if let (true, Ok(n)) = (KINDS.contains(&prefix), n.parse::<u64>()) {
            let e = counters.entry(prefix.to_string()).or_insert(0);
            *e = (*e).max(n);
        }
    }
    json!(counters)
}

/// Slice ids by clip id then name, for resolving score references.
type SliceIndex = HashMap<String, HashMap<String, (String, f64, f64)>>;

fn migrate_annotations(
    ctx: &mut Ctx,
    plans: &[ClipPlan],
    catalog: &Catalog,
    report: &mut MigrationReport,
) -> Result<SliceIndex> {
    let mut index: SliceIndex = HashMap::new();
    for p in plans
        .iter()
        .filter(|p| catalog.by_path.contains_key(&p.rel))
    {
        let ann = &p.manifest["annotations"];
        for s in ann["clips"].as_array().into_iter().flatten() {
            let (Some(name), Some(start), Some(end)) =
                (str_of(s, "name"), s["start"].as_f64(), s["end"].as_f64())
            else {
                return Err(MigrationError::Data(format!(
                    "{}: slice needs name, start and end: {s}",
                    p.rel
                )));
            };
            let by_clip = index.entry(p.id.clone()).or_default();
            if by_clip.contains_key(name) {
                report
                    .skipped
                    .push(format!("{}: duplicate slice name {name}", p.rel));
                continue;
            }
            let tags = s.get("tags").cloned().unwrap_or(Value::Null);
            let kind = tags
                .as_array()
                .and_then(|t| t.first())
                .and_then(Value::as_str)
                .filter(|k| KINDS.contains(k));
            let source = str_of(s, "source")
                .filter(|s| ["user", "ml", "curated"].contains(s))
                .unwrap_or("ml");
            // A curated slice carries the candidate it was kept from; its id derives from the
            // candidate's new id (clip, span, kind), the same one `migrate_candidates` computes.
            let (id, candidate) = if str_of(s, "candidate").is_some() {
                let cid = ids::candidate_id(&p.id, start, end, kind.unwrap_or("other"));
                (ids::curated_slice_id(&cid), Some(cid))
            } else {
                (ids::migrated_slice_id(&p.id, name), None)
            };
            let slice = json!({
                "id": id, "clipId": p.id, "name": name, "start": start, "end": end, "source": source,
                "kind": kind, "tags": tags, "candidateId": candidate,
                "evidence": s.get("evidence").map(Value::to_string),
            });
            report.slices += ctx.upsert("Slice", slice)? as usize;
            by_clip.insert(name.to_string(), (id, start, end));
        }
        for m in ann["markers"].as_array().into_iter().flatten() {
            let (Some(name), Some(seconds)) = (str_of(m, "name"), m["seconds"].as_f64()) else {
                return Err(MigrationError::Data(format!(
                    "{}: marker needs name and seconds: {m}",
                    p.rel
                )));
            };
            let source = str_of(m, "source").filter(|s| ["user", "ml", "curated"].contains(s));
            let marker = json!({"id": ids::migrated_marker_id(&p.id, name, seconds), "clipId": p.id, "name": name, "seconds": seconds, "source": source, "note": str_of(m, "note")});
            report.markers += ctx.upsert("Marker", marker)? as usize;
        }
    }
    Ok(index)
}

/// Candidates keyed by legacy id, with the new id.
type CandidateIndex = HashMap<String, String>;

fn migrate_candidates(
    ctx: &mut Ctx,
    library_dir: &Path,
    catalog: &Catalog,
    report: &mut MigrationReport,
) -> Result<CandidateIndex> {
    let mut index = CandidateIndex::new();
    let path = library_dir.join("candidates.json");
    if !path.exists() {
        return Ok(index);
    }
    let store = read_json(&path)?;
    let mut records: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for c in store["candidates"].as_array().into_iter().flatten() {
        let legacy =
            str_of(c, "id").ok_or_else(|| MigrationError::Data("candidate without id".into()))?;
        let clip_path = str_of(c, "clip").unwrap_or_default();
        let Some(clip_id) = catalog.clip_for(clip_path) else {
            report.unresolved.push(format!(
                "candidate {legacy}: clip {clip_path} is not migrated"
            ));
            continue;
        };
        let (Some(start), Some(end)) = (c["start"].as_f64(), c["end"].as_f64()) else {
            return Err(MigrationError::Data(format!(
                "candidate {legacy}: start and end are required"
            )));
        };
        let kind = str_of(c, "kind")
            .filter(|k| KINDS.contains(k))
            .unwrap_or("other");
        let id = ids::candidate_id(clip_id, start, end, kind);
        index.insert(legacy.to_string(), id.clone());
        let proposers = c["proposers"].as_array().cloned().unwrap_or_default();
        let entry = records.entry(id.clone()).or_default();
        if entry.is_empty() {
            let rec = json!({
                "id": id, "legacyId": legacy, "clipId": clip_id, "recordingId": catalog.recording_of[clip_id],
                "start": start, "end": end, "kind": kind, "name": str_of(c, "name"), "context": c.get("context"),
            });
            *entry = rec.as_object().cloned().unwrap_or_default();
            entry.insert("proposers".into(), Value::Array(Vec::new()));
        } else {
            report.skipped.push(format!(
                "candidate {legacy} has the same clip, span and kind as {}; proposers merged",
                entry["legacyId"]
            ));
        }
        if let Some(Value::Array(all)) = entry.get_mut("proposers") {
            all.extend(proposers);
        }
    }
    for (_, mut rec) in records {
        let base = rec["proposers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["score"].as_f64())
            .fold(0.0, f64::max);
        rec.insert("baseScore".into(), json!(base));
        report.candidates += ctx.upsert("Candidate", Value::Object(rec))? as usize;
    }

    let verdicts_path = library_dir.join("verdicts.json");
    if verdicts_path.exists() {
        let store = read_json(&verdicts_path)?;
        let by_legacy: BTreeMap<&String, &Value> = store["verdicts"]
            .as_object()
            .into_iter()
            .flatten()
            .collect();
        for (legacy, v) in by_legacy {
            let Some(cid) = index.get(legacy) else {
                report
                    .unresolved
                    .push(format!("verdict for {legacy}: candidate is not migrated"));
                continue;
            };
            let verdict = json!({
                "candidateId": cid, "judge": "local", "verdict": v["verdict"], "stars": v.get("stars"), "tags": v.get("tags"),
                "name": v.get("name"), "judgedAt": v["at"], "by": v.get("by"),
            });
            report.verdicts += ctx.upsert("Verdict", verdict)? as usize;
        }
    }
    Ok(index)
}

fn migrate_crates(
    ctx: &mut Ctx,
    library_dir: &Path,
    candidates: &CandidateIndex,
    report: &mut MigrationReport,
) -> Result<()> {
    let path = library_dir.join("crates.json");
    if !path.exists() {
        return Ok(());
    }
    let store = read_json(&path)?;
    let crates: BTreeMap<&String, &Value> =
        store["crates"].as_object().into_iter().flatten().collect();
    for (name, c) in crates {
        let crate_id = format!("crt_{name}");
        report.crates += ctx.upsert("Crate", json!({"id": crate_id, "name": name, "note": str_of(c, "note").filter(|n| !n.is_empty())}))? as usize;
        let items: Vec<&str> = c["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let positions =
            generate_n_keys_between(None, None, items.len()).map_err(MigrationError::Data)?;
        for (legacy, position) in items.iter().zip(positions) {
            let Some(cid) = candidates.get(*legacy) else {
                report
                    .unresolved
                    .push(format!("crate {name}: candidate {legacy} is not migrated"));
                continue;
            };
            // A kept candidate's curated slice is the item's slice.
            let kept = ctx.call(
                "Verdict",
                "get",
                &json!({"candidateId": cid, "judge": "local"}),
            )?;
            let candidate = ctx.call("Candidate", "get", &json!({"id": cid}))?;
            let slice =
                (str_of(&kept, "verdict") == Some("keep")).then(|| ids::curated_slice_id(cid));
            let item = json!({
                "id": format!("citm_{crate_id}_{cid}"), "crateId": crate_id, "position": position, "candidateId": cid,
                "sliceId": slice, "clipId": candidate.get("clipId"),
            });
            report.crate_items += ctx.upsert("CrateItem", item)? as usize;
        }
    }
    Ok(())
}

fn migrate_scores(
    ctx: &mut Ctx,
    repo: &Path,
    catalog: &Catalog,
    slices: &SliceIndex,
    report: &mut MigrationReport,
) -> Result<()> {
    let mut paths = Vec::new();
    for dir in ["examples", "scores"] {
        walk(&repo.join(dir), &mut |p| {
            if matches!(p.extension().and_then(|e| e.to_str()), Some("apr" | "yaml")) {
                paths.push(p.to_path_buf());
            }
        })?;
    }
    paths.sort();
    for path in paths {
        let text = fs::read_to_string(&path)?;
        if text.len() > MAX_SCORE_BYTES {
            return Err(MigrationError::Data(format!(
                "{}: score is over 300 KB",
                path.display()
            )));
        }
        let rel = path
            .strip_prefix(repo)
            .map_err(|e| MigrationError::Data(e.to_string()))?;
        let folder = rel
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let file = rel
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let (stem, ext) = file.rsplit_once('.').unwrap_or((&file, ""));
        let score_id = format!("scr_{}_{stem}_{ext}", folder.replace('/', "_"));
        let refs = score_refs::catalog_refs(&text, &folder, &file);
        let mut score = json!({
            "id": score_id, "title": stem, "folder": folder, "format": ext, "text": text,
            "legacyPath": rel.to_string_lossy(),
        });
        if let Err(errors) = &refs {
            score["lastErrors"] = json!(errors);
            for e in errors {
                report
                    .unresolved
                    .push(if e.starts_with(&*rel.to_string_lossy()) {
                        e.clone()
                    } else {
                        format!("{}: {e}", rel.display())
                    });
            }
        }
        report.scores += ctx.upsert("Score", score)? as usize;

        let mut wanted = Vec::new();
        for r in refs.unwrap_or_default() {
            match resolve_ref(&score_id, &r, catalog, slices) {
                Ok(record) => {
                    wanted.push(record["id"].as_str().unwrap_or_default().to_string());
                    report.score_refs += ctx.upsert("ScoreRef", record)? as usize;
                }
                Err(why) => {
                    report
                        .unresolved
                        .push(format!("{}: {} ({why})", rel.display(), r.source))
                }
            }
        }
        // References the score no longer makes.
        for old in ctx.query_all("ScoreRef", "refsByScore", json!({"scoreId": score_id}))? {
            let id = str_of(&old, "id").unwrap_or_default();
            if !wanted.iter().any(|w| w == id) {
                ctx.call("ScoreRef", "delete", &json!({"id": id}))?;
                report.score_refs += 1;
            }
        }
    }
    Ok(())
}

fn resolve_ref(
    score_id: &str,
    r: &CatalogRef,
    catalog: &Catalog,
    slices: &SliceIndex,
) -> std::result::Result<Value, String> {
    let clip_id = match (&r.clip_id, &r.catalog_path) {
        (Some(id), _) if catalog.by_path.values().any(|c| c == id) => id.clone(),
        (Some(id), _) => return Err(format!("no clip {id}")),
        (None, Some(path)) => catalog
            .clip_for(path)
            .cloned()
            .ok_or_else(|| format!("no clip at {path}"))?,
        (None, None) => return Err("not a catalog path".into()),
    };
    let by_clip = slices.get(&clip_id);
    let slice = match (&r.slice_id, &r.slice_name) {
        (Some(id), _) => by_clip
            .and_then(|m| m.values().find(|(sid, ..)| sid == id))
            .cloned()
            .ok_or_else(|| format!("no slice {id}"))?
            .into(),
        (None, Some(name)) => by_clip
            .and_then(|m| m.get(name))
            .cloned()
            .ok_or_else(|| format!("no slice {name} on {clip_id}"))?
            .into(),
        (None, None) => None,
    };
    let slice: Option<(String, f64, f64)> = slice;
    Ok(json!({
        "id": format!("sref_{score_id}_{}", r.id_suffix), "scoreId": score_id, "clipAlias": r.alias, "clipId": clip_id,
        "clipPath": r.catalog_path, "sliceName": r.slice_name,
        "sliceId": slice.as_ref().map(|s| &s.0), "start": slice.as_ref().map(|s| s.1), "end": slice.as_ref().map(|s| s.2),
    }))
}

/// Visit every file under `dir` (no-op when it does not exist).
fn walk(dir: &Path, visit: &mut dyn FnMut(&Path)) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            walk(&path, visit)?;
        } else {
            visit(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod recording_key_tests {
    use super::recording_key;

    #[test]
    fn every_salamander_sample_belongs_to_one_recording() {
        for rel in ["salamander-drumkit/OH/kick_OH_F_1.wav", "salamander-drumkit/ALL.sfz"] {
            assert_eq!(
                recording_key(rel),
                ("rec_salamander-drumkit".to_string(), "salamander-drumkit".to_string())
            );
        }
    }
}
