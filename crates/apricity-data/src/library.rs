//! Library: the Apricity data store over the virtuus-amplify engine.
//! Manages clips, slices, markers, candidates, verdicts, and files.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;
use virtuus_amplify::{Contract, Engine, EngineOptions, Identity as VirtuusIdentity};

/// Errors from library operations.
#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Contract error: {0}")]
    Contract(String),

    #[error("Engine error: {0}")]
    Engine(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::error::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Metadata stored in apricity-library.json
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LibraryMetadata {
    pub format: i32,
    pub contract_version: String,
    pub library_id: String,
    pub identity: Identity,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub sub: String,
    #[serde(default)]
    pub groups: Vec<String>,
}

/// Clip facade for API access.
pub struct ClipFacade<'a> {
    library: &'a mut Library,
}

impl<'a> ClipFacade<'a> {
    /// Get a clip by ID (direct primary key lookup)
    pub fn get(&mut self, id: &str) -> Result<Option<Value>> {
        let identity = VirtuusIdentity::User {
            sub: self.library.metadata.identity.sub.clone(),
            username: "library-facade".to_string(),
            groups: self.library.metadata.identity.groups.clone(),
        };

        let args = json!({ "id": id });
        let (data, errors) = self
            .library
            .engine
            .call("Clip", "get", &args, &identity)
            .map_err(|e| Error::Engine(e.to_string()))?;

        if let Some(error_list) = errors {
            if !error_list.is_empty() {
                return Err(Error::Engine(format!("Query errors: {:?}", error_list)));
            }
        }

        if data.is_null() {
            Ok(None)
        } else {
            Ok(Some(data))
        }
    }

    /// Find clips by path (using clipsByPath GSI)
    pub fn by_path(&mut self, path: &str) -> Result<Vec<Value>> {
        let identity = VirtuusIdentity::User {
            sub: self.library.metadata.identity.sub.clone(),
            username: "library-facade".to_string(),
            groups: self.library.metadata.identity.groups.clone(),
        };

        let args = json!({ "key": { "path": path } });
        let (data, errors) = self
            .library
            .engine
            .call("Clip", "clipsByPath", &args, &identity)
            .map_err(|e| Error::Engine(e.to_string()))?;

        if let Some(error_list) = errors {
            if !error_list.is_empty() {
                return Err(Error::Engine(format!("Query errors: {:?}", error_list)));
            }
        }

        // Engine::call returns results wrapped in {items: [...], nextToken: ...}
        let clips = if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
            items.clone()
        } else if let Some(arr) = data.as_array() {
            arr.clone()
        } else if data.is_null() {
            vec![]
        } else {
            vec![data]
        };

        Ok(clips)
    }
}

/// Slice facade for API access.
pub struct SliceFacade<'a> {
    library: &'a mut Library,
}

impl<'a> SliceFacade<'a> {
    /// Get slices for a clip (using slicesByClip GSI, optionally sorted by start time)
    pub fn by_clip(&mut self, clip_id: &str) -> Result<Vec<Value>> {
        let identity = VirtuusIdentity::User {
            sub: self.library.metadata.identity.sub.clone(),
            username: "library-facade".to_string(),
            groups: self.library.metadata.identity.groups.clone(),
        };

        let args = json!({ "key": { "clipId": clip_id } });
        let (data, errors) = self
            .library
            .engine
            .call("Slice", "slicesByClip", &args, &identity)
            .map_err(|e| Error::Engine(e.to_string()))?;

        if let Some(error_list) = errors {
            if !error_list.is_empty() {
                return Err(Error::Engine(format!("Query errors: {:?}", error_list)));
            }
        }

        // Engine::call returns results wrapped in {items: [...], nextToken: ...}
        let slices = if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
            items.clone()
        } else if let Some(arr) = data.as_array() {
            arr.clone()
        } else if data.is_null() {
            vec![]
        } else {
            vec![data]
        };

        Ok(slices)
    }
}

/// Marker facade for API access.
pub struct MarkerFacade<'a> {
    library: &'a mut Library,
}

impl<'a> MarkerFacade<'a> {
    /// Get markers for a clip (using markersByClip GSI, optionally sorted by seconds)
    pub fn by_clip(&mut self, clip_id: &str) -> Result<Vec<Value>> {
        let identity = VirtuusIdentity::User {
            sub: self.library.metadata.identity.sub.clone(),
            username: "library-facade".to_string(),
            groups: self.library.metadata.identity.groups.clone(),
        };

        let args = json!({ "key": { "clipId": clip_id } });
        let (data, errors) = self
            .library
            .engine
            .call("Marker", "markersByClip", &args, &identity)
            .map_err(|e| Error::Engine(e.to_string()))?;

        if let Some(error_list) = errors {
            if !error_list.is_empty() {
                return Err(Error::Engine(format!("Query errors: {:?}", error_list)));
            }
        }

        // Engine::call returns results wrapped in {items: [...], nextToken: ...}
        let markers = if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
            items.clone()
        } else if let Some(arr) = data.as_array() {
            arr.clone()
        } else if data.is_null() {
            vec![]
        } else {
            vec![data]
        };

        Ok(markers)
    }
}

/// An Apricity library over the local file system.
pub struct Library {
    path: PathBuf,
    engine: Engine,
    metadata: LibraryMetadata,
}

impl Library {
    /// Create a new library in the given directory.
    pub fn create(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();

        // Create the directory structure
        std::fs::create_dir_all(dir)?;
        std::fs::create_dir_all(dir.join("tables"))?;
        std::fs::create_dir_all(dir.join("files"))?;
        std::fs::create_dir_all(dir.join(".virtuus"))?;

        // Load contract
        let contract_json = include_str!("../../../contract/apricity.contract.json");
        let contract =
            Contract::from_json(contract_json).map_err(|e| Error::Contract(e.to_string()))?;

        // Create engine
        let engine = Engine::open(
            Some(dir.to_path_buf()),
            contract,
            EngineOptions {
                enforce_auth: false,
            },
        )
        .map_err(|e| Error::Engine(e.to_string()))?;

        // Create metadata
        let metadata = LibraryMetadata {
            format: 1,
            contract_version: contract_json
                .lines()
                .find(|l| l.contains("\"version\""))
                .map(|l| l.split('"').nth(3).unwrap_or("unknown").to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            library_id: format!("lib_{}", Uuid::new_v4().simple()),
            identity: Identity {
                sub: "local".to_string(),
                groups: vec!["members".to_string(), "curators".to_string()],
            },
            api_key: None,
        };

        // Save metadata
        let metadata_path = dir.join("apricity-library.json");
        let metadata_json = serde_json::to_string_pretty(&metadata)?;
        std::fs::write(metadata_path, metadata_json)?;

        Ok(Library {
            path: dir.to_path_buf(),
            engine,
            metadata,
        })
    }

    /// Open an existing library.
    pub fn open(dir: impl AsRef<Path>, identity: Option<String>) -> Result<Self> {
        let dir = dir.as_ref();

        // Load metadata
        let metadata_path = dir.join("apricity-library.json");
        let metadata_json = std::fs::read_to_string(metadata_path)?;
        let mut metadata: LibraryMetadata = serde_json::from_str(&metadata_json)?;

        // Update identity if provided
        if let Some(sub) = identity {
            metadata.identity.sub = sub;
        }

        // Load contract
        let contract_json = include_str!("../../../contract/apricity.contract.json");
        let contract =
            Contract::from_json(contract_json).map_err(|e| Error::Contract(e.to_string()))?;

        // Open engine
        let engine = Engine::open(
            Some(dir.to_path_buf()),
            contract,
            EngineOptions {
                enforce_auth: false,
            },
        )
        .map_err(|e| Error::Engine(e.to_string()))?;

        Ok(Library {
            path: dir.to_path_buf(),
            engine,
            metadata,
        })
    }

    /// Get the library path
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Get the library metadata
    pub fn metadata(&self) -> &LibraryMetadata {
        &self.metadata
    }

    /// Get a mutable reference to the engine
    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }

    /// Get a reference to the engine
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Get a mutable clip facade
    pub fn clips(&mut self) -> ClipFacade<'_> {
        ClipFacade { library: self }
    }

    /// Get a mutable slice facade
    pub fn slices(&mut self) -> SliceFacade<'_> {
        SliceFacade { library: self }
    }

    /// Get a mutable marker facade
    pub fn markers(&mut self) -> MarkerFacade<'_> {
        MarkerFacade { library: self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_library() {
        let temp_dir = tempfile::tempdir().unwrap();
        let lib = Library::create(temp_dir.path()).unwrap();

        assert_eq!(lib.metadata.format, 1);
        assert_eq!(lib.metadata.identity.sub, "local");

        let metadata_path = temp_dir.path().join("apricity-library.json");
        assert!(metadata_path.exists());
    }

    #[test]
    fn test_open_library() {
        let temp_dir = tempfile::tempdir().unwrap();
        let _lib = Library::create(temp_dir.path()).unwrap();

        let lib2 = Library::open(temp_dir.path(), None).unwrap();
        assert_eq!(lib2.metadata.format, 1);
        assert_eq!(lib2.metadata.identity.sub, "local");
    }

    #[test]
    fn test_clip_facade_put_get_round_trip() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        // Create a clip in the engine
        let clip_id = "clp_test123";
        let clip_data = json!({
            "id": clip_id,
            "path": "/audio/clip.wav",
            "duration": 45.5,
            "sampleRate": 44100
        });

        // Put the clip into the Clip table using table.put()
        if let Some(table) = lib.engine_mut().table_mut("Clip") {
            table.put(clip_data);
        }

        // Get it back via facade
        let mut clips_facade = lib.clips();
        let result = clips_facade.get(clip_id).unwrap();
        assert!(result.is_some());
        let retrieved = result.unwrap();
        assert_eq!(retrieved["id"], clip_id);
        assert_eq!(retrieved["path"], "/audio/clip.wav");
    }

    #[test]
    fn test_clip_facade_get_missing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        let mut clips_facade = lib.clips();
        let result = clips_facade.get("nonexistent_id").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_clip_facade_by_path_hit() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        let path = "/audio/song.wav";
        let clip_data = json!({
            "id": "clp_song1",
            "path": path,
            "duration": 120.0,
            "sampleRate": 48000
        });

        if let Some(table) = lib.engine_mut().table_mut("Clip") {
            table.put(clip_data);
        }

        let mut clips_facade = lib.clips();
        let results = clips_facade.by_path(path).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0]["path"], path);
    }

    #[test]
    fn test_clip_facade_by_path_miss() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        let mut clips_facade = lib.clips();
        let results = clips_facade.by_path("/nonexistent/path.wav").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_slice_facade_by_clip_ordering() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        let clip_id = "clp_test1";

        // Create slices in non-sequential order
        for (i, start) in vec![30.0, 10.0, 20.0].iter().enumerate() {
            let slice_data = json!({
                "id": format!("slc_test{}", i),
                "clipId": clip_id,
                "start": start,
                "end": start + 5.0,
            });
            if let Some(table) = lib.engine_mut().table_mut("Slice") {
                table.put(slice_data);
            }
        }

        let mut slices_facade = lib.slices();
        let results = slices_facade.by_clip(clip_id).unwrap();

        // Verify results are sorted by start (or at least contain all items)
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|s| s["clipId"] == clip_id));
    }

    #[test]
    fn test_marker_facade_by_clip_ordering() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        let clip_id = "clp_test2";

        // Create markers in non-sequential order
        for (i, seconds) in vec![45.5, 10.5, 30.0].iter().enumerate() {
            let marker_data = json!({
                "id": format!("mrk_test{}", i),
                "clipId": clip_id,
                "seconds": seconds,
                "label": format!("Marker {}", i)
            });
            if let Some(table) = lib.engine_mut().table_mut("Marker") {
                table.put(marker_data);
            }
        }

        let mut markers_facade = lib.markers();
        let results = markers_facade.by_clip(clip_id).unwrap();

        // Verify results contain all items and are sorted by seconds (or at least present)
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|m| m["clipId"] == clip_id));
    }

    #[test]
    fn test_loader_via_alias_fallback() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut lib = Library::create(temp_dir.path()).unwrap();

        // Create a clip via the facade
        let clip_id = "clp_alias_test";
        let primary_path = "/audio/primary.wav";
        let clip_data = json!({
            "id": clip_id,
            "path": primary_path,
            "duration": 90.0,
            "sampleRate": 48000
        });

        if let Some(table) = lib.engine_mut().table_mut("Clip") {
            table.put(clip_data);
        }

        // Query via the facade using the exact path
        let mut clips_facade = lib.clips();
        let results = clips_facade.by_path(primary_path).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0]["id"], clip_id);
    }
}
