//! Files: trait and implementations for managing file storage in a library.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// A file reference with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRef {
    pub key: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: Option<String>,
}

/// Errors from file operations.
#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("File not found: {0}")]
    NotFound(String),

    #[error("Hash error: {0}")]
    Hash(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Files trait for managing file storage.
pub trait Files: Send + Sync {
    /// Store a file from a source path.
    fn put(&mut self, key: &str, src_path: &Path, content_type: Option<&str>) -> Result<FileRef>;

    /// Retrieve a file to a destination path.
    fn get(&self, key: &str, dst_path: &Path) -> Result<()>;

    /// Check if a file exists and return its metadata.
    fn head(&self, key: &str) -> Result<Option<FileRef>>;

    /// Delete a file.
    fn delete(&self, key: &str) -> Result<()>;

    /// Get the local path to a file (if available).
    fn path(&self, key: &str) -> Option<PathBuf>;
}

/// File storage backed by a local filesystem.
pub struct FsFiles {
    root: PathBuf,
}

impl FsFiles {
    /// Create a new filesystem-backed file store rooted at the given directory.
    pub fn new(root: impl AsRef<Path>) -> Self {
        FsFiles {
            root: root.as_ref().to_path_buf(),
        }
    }

    /// Get the full path for a key.
    fn full_path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }

    /// Where `key` lives on disk.
    pub fn path_of(&self, key: &str) -> PathBuf {
        self.full_path(key)
    }

    /// Import a file under `key` by hard link (`link`) or copy (APFS clone where the filesystem
    /// supports it), streaming the bytes through SHA-256. Returns the `FileRef` and whether the
    /// store changed: an existing destination that is already the same file (same inode when
    /// linking, same bytes when copying) is left alone.
    pub fn import(&mut self, key: &str, src_path: &Path, content_type: Option<&str>, link: bool) -> Result<(FileRef, bool)> {
        let dst = self.full_path(key);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let (sha256, size) = sha256_file(src_path)?;
        let mut changed = true;
        if dst.exists() {
            changed = if link {
                !same_inode(src_path, &dst)?
            } else {
                sha256_file(&dst)? != (sha256.clone(), size)
            };
            if changed {
                std::fs::remove_file(&dst)?;
            }
        }
        if changed {
            if link {
                std::fs::hard_link(src_path, &dst)?;
            } else {
                std::fs::copy(src_path, &dst)?;
            }
        }
        Ok((FileRef { key: key.to_string(), sha256, size, content_type: content_type.map(String::from) }, changed))
    }
}

/// SHA-256 (lowercase hex) and length of a file, read in chunks.
fn sha256_file(path: &Path) -> Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn same_inode(a: &Path, b: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let (ma, mb) = (std::fs::metadata(a)?, std::fs::metadata(b)?);
    Ok(ma.dev() == mb.dev() && ma.ino() == mb.ino())
}

impl Files for FsFiles {
    fn put(&mut self, key: &str, src_path: &Path, content_type: Option<&str>) -> Result<FileRef> {
        let dst = self.full_path(key);

        // Create parent directories
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Read source file
        let bytes = std::fs::read(src_path)?;
        let size = bytes.len() as u64;

        // Compute SHA256 hash
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = format!("{:x}", hasher.finalize());

        // Write to destination
        std::fs::write(&dst, &bytes)?;

        Ok(FileRef {
            key: key.to_string(),
            sha256: hash,
            size,
            content_type: content_type.map(String::from),
        })
    }

    fn get(&self, key: &str, dst_path: &Path) -> Result<()> {
        let src = self.full_path(key);

        if !src.exists() {
            return Err(Error::NotFound(key.to_string()));
        }

        std::fs::copy(&src, dst_path)?;
        Ok(())
    }

    fn head(&self, key: &str) -> Result<Option<FileRef>> {
        let path = self.full_path(key);

        if !path.exists() {
            return Ok(None);
        }

        let bytes = std::fs::read(&path)?;
        let size = bytes.len() as u64;

        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = format!("{:x}", hasher.finalize());

        Ok(Some(FileRef {
            key: key.to_string(),
            sha256: hash,
            size,
            content_type: None,
        }))
    }

    fn delete(&self, key: &str) -> Result<()> {
        let path = self.full_path(key);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    fn path(&self, key: &str) -> Option<PathBuf> {
        let path = self.full_path(key);
        if path.exists() { Some(path) } else { None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fs_files_put_and_get() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut files = FsFiles::new(temp_dir.path());

        // Create a test file
        let src = temp_dir.path().join("source.txt");
        std::fs::write(&src, b"test content").unwrap();

        // Put the file
        let ref_obj = files
            .put("test/file.txt", &src, Some("text/plain"))
            .unwrap();
        assert_eq!(ref_obj.key, "test/file.txt");
        assert_eq!(ref_obj.size, 12);
        assert_eq!(ref_obj.content_type, Some("text/plain".to_string()));

        // Get the file
        let dst = temp_dir.path().join("destination.txt");
        files.get("test/file.txt", &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "test content");
    }

    #[test]
    fn test_fs_files_head() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut files = FsFiles::new(temp_dir.path());

        let src = temp_dir.path().join("source.txt");
        std::fs::write(&src, b"test").unwrap();

        files.put("test/file.txt", &src, None).unwrap();

        let head = files.head("test/file.txt").unwrap();
        assert!(head.is_some());

        let nonexistent = files.head("nonexistent.txt").unwrap();
        assert!(nonexistent.is_none());
    }
}
