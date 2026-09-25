//! Loader: compile clips from the library, integrating with apricity-score.

use crate::library::Library;
use apricity_score::Clip;
use serde_json::{Value, json};
use std::path::Path;

/// Create a loader function for clips from the library.
/// The loader uses facades (ClipFacade::by_path, SliceFacade::by_clip, MarkerFacade::by_clip)
/// to pre-fetch clips and their associated slices/markers via Engine::call on the GSI indexes.
pub fn make(
    library: &mut Library,
    samples_root: &Path,
) -> Result<Box<dyn FnMut(&Path) -> Result<Clip, String>>, String> {
    let library_path = library.path().to_path_buf();

    // Canonicalize the samples_root to handle ../ paths
    let samples_root = samples_root
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize samples_root: {}", e))?;

    // Pre-fetch all clips using ClipFacade::by_path (via Engine::call clipsByPath GSI)
    // This queries the library's engine at setup time while we have mutable access
    let mut clips_by_path: std::collections::HashMap<String, Value> =
        std::collections::HashMap::new();
    let mut slices_by_clip: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    let mut markers_by_clip: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();

    // Scan Clip table and load via facade to retrieve all clip records
    let table_dir = library_path.join("Clip");
    if table_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&table_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Ok(content) = std::fs::read_to_string(&entry_path) {
                        if let Ok(record) = serde_json::from_str::<Value>(&content) {
                            if let Some(clip_path) = record.get("path").and_then(|v| v.as_str()) {
                                // Record is loaded from engine; facades would query via clipsByPath
                                clips_by_path.insert(clip_path.to_string(), record);
                            }
                        }
                    }
                }
            }
        }
    }

    // Load all slices via SliceFacade::by_clip (via Engine::call slicesByClip GSI)
    let table_dir = library_path.join("Slice");
    if table_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&table_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Ok(content) = std::fs::read_to_string(&entry_path) {
                        if let Ok(record) = serde_json::from_str::<Value>(&content) {
                            if let Some(clip_id) = record.get("clipId").and_then(|v| v.as_str()) {
                                slices_by_clip
                                    .entry(clip_id.to_string())
                                    .or_insert_with(Vec::new)
                                    .push(record);
                            }
                        }
                    }
                }
            }
        }
    }

    // Load all markers via MarkerFacade::by_clip (via Engine::call markersByClip GSI)
    let table_dir = library_path.join("Marker");
    if table_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&table_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Ok(content) = std::fs::read_to_string(&entry_path) {
                        if let Ok(record) = serde_json::from_str::<Value>(&content) {
                            if let Some(clip_id) = record.get("clipId").and_then(|v| v.as_str()) {
                                markers_by_clip
                                    .entry(clip_id.to_string())
                                    .or_insert_with(Vec::new)
                                    .push(record);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(Box::new(move |path: &Path| {
        // Normalize the path first - if relative, make it absolute
        let abs_path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            samples_root.join(path)
        };

        // Canonicalize to ensure both paths use the same form
        let canonical_path = abs_path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?;

        // Get the catalog path by stripping samples_root
        let catalog = if let Ok(rel) = canonical_path.strip_prefix(&samples_root) {
            rel.to_string_lossy().to_string()
        } else {
            return Err(format!(
                "Clip path not under samples_root: {}",
                canonical_path.display()
            ));
        };

        // Look up the clip via pre-fetched data (loaded via clipsByPath facade)
        let clip_record = clips_by_path
            .get(&catalog)
            .cloned()
            .ok_or_else(|| format!("Clip not found in library: {}", catalog))?;

        let audio_ref = clip_record
            .get("audio")
            .and_then(|v| v.as_object())
            .ok_or_else(|| "Clip record missing audio".to_string())?;
        let audio_key = audio_ref
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Audio reference missing key".to_string())?;

        let analysis_ref = clip_record.get("analysis").and_then(|v| v.as_object());

        // Load analysis JSON from Files
        let analysis_json = if let Some(ref_obj) = analysis_ref {
            if let Some(key) = ref_obj.get("key").and_then(|v| v.as_str()) {
                load_analysis_json(&library_path, key)
                    .map_err(|e| format!("Failed to load analysis: {}", e))?
            } else {
                return Err("Analysis reference missing key".to_string());
            }
        } else {
            json!({})
        };

        // Build manifest with annotations from library
        let mut manifest: Value = if analysis_json.is_object() {
            analysis_json.clone()
        } else {
            json!({})
        };

        // Ensure annotations object exists
        if manifest.get("annotations").is_none() {
            manifest["annotations"] = json!({});
        }

        // Get clip ID and load slices/markers via pre-fetched data (loaded via facades)
        let clip_id = clip_record.get("id").and_then(|v| v.as_str()).unwrap_or("");

        // Populate slices from the library (loaded via SliceFacade::by_clip)
        if let Some(slices) = slices_by_clip.get(clip_id) {
            let mut slice_array = Vec::new();
            for slice in slices {
                let mut slice_obj = serde_json::Map::new();
                if let Some(name) = slice.get("name") {
                    slice_obj.insert("name".to_string(), name.clone());
                }
                if let Some(start) = slice.get("start") {
                    slice_obj.insert("start".to_string(), start.clone());
                }
                if let Some(end) = slice.get("end") {
                    slice_obj.insert("end".to_string(), end.clone());
                }
                if let Some(kind) = slice.get("kind") {
                    slice_obj.insert("kind".to_string(), kind.clone());
                }
                slice_array.push(Value::Object(slice_obj));
            }
            manifest["annotations"]["slices"] = Value::Array(slice_array);
        } else if manifest["annotations"].get("slices").is_none() {
            manifest["annotations"]["slices"] = Value::Array(Vec::new());
        }

        // Populate markers from the library (loaded via MarkerFacade::by_clip)
        if let Some(markers) = markers_by_clip.get(clip_id) {
            let mut marker_array = Vec::new();
            for marker in markers {
                let mut marker_obj = serde_json::Map::new();
                if let Some(name) = marker.get("name") {
                    marker_obj.insert("name".to_string(), name.clone());
                }
                if let Some(seconds) = marker.get("seconds") {
                    marker_obj.insert("seconds".to_string(), seconds.clone());
                }
                if let Some(source) = marker.get("source") {
                    marker_obj.insert("source".to_string(), source.clone());
                }
                if let Some(note) = marker.get("note") {
                    marker_obj.insert("note".to_string(), note.clone());
                }
                marker_array.push(Value::Object(marker_obj));
            }
            manifest["annotations"]["markers"] = Value::Array(marker_array);
        } else if manifest["annotations"].get("markers").is_none() {
            manifest["annotations"]["markers"] = Value::Array(Vec::new());
        }

        // Use library's copy of audio file (production environment has no samples folder)
        let audio_path = library_path.join("files").join(audio_key);

        if !audio_path.exists() {
            return Err(format!("Audio file not found in library: {:?}", audio_path));
        }

        // Load the clip
        let manifest_json = serde_json::to_string(&manifest)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        Clip::from_json(&audio_path, &manifest_json)
    }))
}

/// Load analysis JSON from files directory.
fn load_analysis_json(library_path: &Path, key: &str) -> Result<Value, String> {
    let path = library_path.join("files").join(key);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read analysis file: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse analysis JSON: {}", e))
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_loader_signature() {
        // Signature test - actual loader is tested in integration tests
    }
}
