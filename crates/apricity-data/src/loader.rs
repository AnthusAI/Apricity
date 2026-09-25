//! Loader: compile samples from the library, integrating with apricity-score.

use crate::library::Library;
use apricity_score::Clip;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use virtuus_amplify::Identity;

/// Everything the loader knows about one sample, fetched once at setup.
struct Entry {
    sample: Value,
    clips: Vec<Value>,
    markers: Vec<Value>,
}

/// A loader for `apricity_score::compile_with` / `compile_text`.
pub type ClipLoader = Box<dyn FnMut(&Path) -> Result<Clip, String>>;

/// Build the loader closure for `apricity_score::compile_with` / `compile_text`: it resolves the
/// sample path a score names (relative to `samples_root`, the repo root that holds `samples/`) by
/// catalog path or alias, then rebuilds the sample's manifest exactly as the old
/// `<audio>.apricity.json`: the analysis attachment plus `annotations` from the library's clips
/// and markers. The audio is the library's own copy under `files/`.
pub fn make(library: &mut Library, samples_root: &Path) -> Result<ClipLoader, String> {
    let library_path = library.path().to_path_buf();
    let identity = Identity::User {
        sub: library.metadata().identity.sub.clone(),
        username: "loader".into(),
        groups: library.metadata().identity.groups.clone(),
    };
    let root = absolute_normalized(samples_root)?;

    let samples = fetch_all(library, &identity, "Sample", "list", json!({}))?;
    let mut entries: Vec<Entry> = Vec::with_capacity(samples.len());
    let mut by_path: HashMap<String, usize> = HashMap::new();
    for sample in samples {
        let id = sample["id"].as_str().ok_or("sample without id")?.to_string();
        let clips = fetch_all(
            library,
            &identity,
            "Clip",
            "clipsBySample",
            json!({"key": {"sampleId": id}}),
        )?;
        let markers = fetch_all(
            library,
            &identity,
            "Marker",
            "markersBySample",
            json!({"key": {"sampleId": id}}),
        )?;
        let index = entries.len();
        let aliases: Vec<String> = sample["aliases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().map(String::from))
            .collect();
        for key in sample["path"]
            .as_str()
            .map(String::from)
            .into_iter()
            .chain(aliases)
        {
            by_path.insert(key, index);
        }
        entries.push(Entry {
            sample,
            clips,
            markers,
        });
    }

    Ok(Box::new(move |path: &Path| {
        let abs = absolute_normalized(path)?;
        let rel = abs
            .strip_prefix(&root)
            .map_err(|_| {
                format!(
                    "Sample path {} is not under {}",
                    abs.display(),
                    root.display()
                )
            })?
            .to_string_lossy()
            .replace('\\', "/");
        let index = by_path
            .get(&rel)
            .or_else(|| rel.strip_prefix("samples/").and_then(|p| by_path.get(p)))
            .ok_or_else(|| format!("Sample not found in library: {rel}"))?;
        let entry = &entries[*index];

        let analysis_key = entry.sample["analysis"]["key"]
            .as_str()
            .ok_or_else(|| format!("{rel}: sample has no analysis attachment"))?;
        let text = std::fs::read_to_string(library_path.join("files").join(analysis_key))
            .map_err(|e| format!("{rel}: reading analysis: {e}"))?;
        let mut manifest: Value =
            serde_json::from_str(&text).map_err(|e| format!("{rel}: analysis is not JSON: {e}"))?;
        manifest["annotations"] = json!({ "clips": clip_annotations(&entry.clips), "markers": marker_annotations(&entry.markers) });

        let audio_key = entry.sample["audio"]["key"]
            .as_str()
            .ok_or_else(|| format!("{rel}: sample has no audio"))?;
        let audio = library_path.join("files").join(audio_key);
        if !audio.exists() {
            return Err(format!(
                "Audio file not found in library: {}",
                audio.display()
            ));
        }
        Clip::from_json(&audio, &manifest.to_string())
    }))
}

/// The manifest's `annotations.clips`, in time order.
fn clip_annotations(clips: &[Value]) -> Vec<Value> {
    let mut sorted: Vec<&Value> = clips.iter().collect();
    sorted.sort_by(|a, b| {
        a["start"]
            .as_f64()
            .partial_cmp(&b["start"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    sorted
        .into_iter()
        .map(|s| {
            let mut out = json!({"name": s["name"], "start": s["start"], "end": s["end"], "source": s["source"]});
            for (from, to) in [("tags", "tags"), ("candidateId", "candidate"), ("retired", "retired")] {
                if let Some(v) = s.get(from) {
                    out[to] = v.clone();
                }
            }
            // AWSJSON evidence is stored as a JSON string.
            if let Some(ev) = s["evidence"].as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()) {
                out["evidence"] = ev;
            }
            out
        })
        .collect()
}

/// The manifest's `annotations.markers`, in time order.
fn marker_annotations(markers: &[Value]) -> Vec<Value> {
    let mut sorted: Vec<&Value> = markers.iter().collect();
    sorted.sort_by(|a, b| {
        a["seconds"]
            .as_f64()
            .partial_cmp(&b["seconds"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    sorted
        .into_iter()
        .map(|m| {
            let mut out = json!({"name": m["name"], "seconds": m["seconds"]});
            for key in ["source", "note"] {
                if let Some(v) = m.get(key) {
                    out[key] = v.clone();
                }
            }
            out
        })
        .collect()
}

/// Every item of an engine query or list, following `nextToken`.
fn fetch_all(
    library: &mut Library,
    identity: &Identity,
    model: &str,
    op: &str,
    base: Value,
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut token = Value::Null;
    loop {
        let mut args = base.clone();
        args["limit"] = json!(1000);
        if !token.is_null() {
            args["nextToken"] = token.clone();
        }
        let (data, errors) = library
            .engine_mut()
            .call(model, op, &args, identity)
            .map_err(|e| format!("{model} {op}: {e}"))?;
        if let Some(errs) = errors.filter(|e| !e.is_empty()) {
            return Err(format!("{model} {op}: {errs:?}"));
        }
        items.extend(
            data.get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        token = data.get("nextToken").cloned().unwrap_or(Value::Null);
        if token.is_null() {
            return Ok(items);
        }
    }
}

/// Make a path absolute and resolve `.` and `..` lexically (the audio need not exist).
fn absolute_normalized(path: &Path) -> Result<PathBuf, String> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Ok(out)
}
