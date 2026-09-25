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

/// Cheap metadata for a stored file: no content is read to produce it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMeta {
    pub key: String,
    pub size: u64,
    /// An opaque token that changes when the content does: the modification time for a folder,
    /// the ETag for S3. `None` when the store has nothing cheaper than the content itself.
    pub version: Option<String>,
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

    #[error("Invalid file key: {0:?}")]
    InvalidKey(String),

    #[error("Remote store error: {0}")]
    Remote(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Whether `key` is a well-formed library-relative path: `/`-separated, no empty, `.` or `..`
/// segments, no leading slash, no backslash or NUL. Every store refuses anything else, so a key
/// can never leave the store's root.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains(['\\', '\0'])
        && key
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

pub(crate) fn check_key(key: &str) -> Result<()> {
    if valid_key(key) {
        Ok(())
    } else {
        Err(Error::InvalidKey(key.to_string()))
    }
}

/// The media type for a key, from its extension.
pub fn content_type_for(name: &str) -> &'static str {
    match name.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("json") => "application/json",
        Some("pdf") => "application/pdf",
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Files trait for managing file storage.
///
/// Reads by range, `stat` and `list` work on stores with no local path (S3), so a server can
/// stream any store without assuming a folder.
pub trait Files: Send + Sync {
    /// Store a file from a source path. The returned `FileRef` carries the content's SHA-256.
    fn put(&mut self, key: &str, src_path: &Path, content_type: Option<&str>) -> Result<FileRef>;

    /// Retrieve a file to a destination path.
    fn get(&self, key: &str, dst_path: &Path) -> Result<()>;

    /// Up to `len` bytes starting at byte `start`; fewer when the file ends first, none when
    /// `start` is at or past the end. `NotFound` when the key does not exist.
    fn read_range(&self, key: &str, start: u64, len: u64) -> Result<Vec<u8>>;

    /// Size and change token of a file, without reading or hashing it; `None` when absent.
    fn stat(&self, key: &str) -> Result<Option<FileMeta>>;

    /// Every file whose key starts with `prefix`, sorted by key (no hashing).
    fn list(&self, prefix: &str) -> Result<Vec<FileMeta>>;

    /// Check if a file exists and return its metadata including its SHA-256.
    fn head(&self, key: &str) -> Result<Option<FileRef>>;

    /// Delete a file (deleting a missing file is not an error).
    fn delete(&self, key: &str) -> Result<()>;

    /// Get the local path to a file (if the store is a folder).
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
        check_key(key)?;
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

    fn meta_of(&self, key: &str, md: &std::fs::Metadata) -> FileMeta {
        let version = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string());
        FileMeta { key: key.to_string(), size: md.len(), version }
    }

    fn walk(&self, dir: &Path, rel: &str, out: &mut Vec<FileMeta>) -> Result<()> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let key = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let md = match std::fs::metadata(entry.path()) {
                Ok(md) => md,
                // A dangling symlink or a file removed mid-walk is simply not a file.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            if md.is_dir() {
                self.walk(&entry.path(), &key, out)?;
            } else if md.is_file() {
                out.push(self.meta_of(&key, &md));
            }
        }
        Ok(())
    }
}

/// SHA-256 (lowercase hex) and length of a file, read in chunks.
pub fn sha256_file(path: &Path) -> Result<(String, u64)> {
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

/// Copy `src` to `dst` in chunks, returning the SHA-256 and size of what was written.
fn copy_hashing(src: &Path, dst: &Path) -> Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let mut input = std::fs::File::open(src)?;
    let mut output = std::fs::File::create(dst)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        output.write_all(&buf[..n])?;
        size += n as u64;
    }
    output.flush()?;
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn same_inode(a: &Path, b: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let (ma, mb) = (std::fs::metadata(a)?, std::fs::metadata(b)?);
    Ok(ma.dev() == mb.dev() && ma.ino() == mb.ino())
}

impl Files for FsFiles {
    fn put(&mut self, key: &str, src_path: &Path, content_type: Option<&str>) -> Result<FileRef> {
        check_key(key)?;
        let dst = self.full_path(key);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Write beside the destination under a dot name, then rename, so a reader never sees a
        // half-written file. Streams: nothing is held in memory.
        let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let part = dst.with_file_name(format!(".{name}.part-{}", std::process::id()));
        let (sha256, size) = match copy_hashing(src_path, &part) {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
        };
        if let Err(e) = std::fs::rename(&part, &dst) {
            let _ = std::fs::remove_file(&part);
            return Err(e.into());
        }
        Ok(FileRef { key: key.to_string(), sha256, size, content_type: content_type.map(String::from) })
    }

    fn get(&self, key: &str, dst_path: &Path) -> Result<()> {
        check_key(key)?;
        let src = self.full_path(key);
        if !src.is_file() {
            return Err(Error::NotFound(key.to_string()));
        }
        std::fs::copy(&src, dst_path)?;
        Ok(())
    }

    fn read_range(&self, key: &str, start: u64, len: u64) -> Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        check_key(key)?;
        let path = self.full_path(key);
        if !path.is_file() {
            return Err(Error::NotFound(key.to_string()));
        }
        let mut f = std::fs::File::open(&path)?;
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.take(len).read_to_end(&mut buf)?;
        Ok(buf)
    }

    fn stat(&self, key: &str) -> Result<Option<FileMeta>> {
        check_key(key)?;
        match std::fs::metadata(self.full_path(key)) {
            Ok(md) if md.is_file() => Ok(Some(self.meta_of(key, &md))),
            Ok(_) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<FileMeta>> {
        let mut out = Vec::new();
        self.walk(&self.root, "", &mut out)?;
        out.retain(|m| m.key.starts_with(prefix));
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    fn head(&self, key: &str) -> Result<Option<FileRef>> {
        check_key(key)?;
        let path = self.full_path(key);
        if !path.is_file() {
            return Ok(None);
        }
        let (sha256, size) = sha256_file(&path)?;
        Ok(Some(FileRef { key: key.to_string(), sha256, size, content_type: None }))
    }

    fn delete(&self, key: &str) -> Result<()> {
        check_key(key)?;
        let path = self.full_path(key);
        if path.is_file() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    fn path(&self, key: &str) -> Option<PathBuf> {
        if !valid_key(key) {
            return None;
        }
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

    fn store_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, FsFiles) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        for (k, v) in files {
            let p = root.join(k);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, v).unwrap();
        }
        let store = FsFiles::new(&root);
        (dir, store)
    }

    #[test]
    fn read_range_returns_the_span_and_clamps() {
        let (_d, s) = store_with(&[("audio/c1/a.wav", b"0123456789abcdefghij")]);
        assert_eq!(s.read_range("audio/c1/a.wav", 2, 4).unwrap(), b"2345");
        assert_eq!(s.read_range("audio/c1/a.wav", 15, 10).unwrap(), b"fghij");
        assert!(s.read_range("audio/c1/a.wav", 20, 5).unwrap().is_empty());
        assert!(s.read_range("audio/c1/a.wav", 99, 5).unwrap().is_empty());
        assert!(s.read_range("audio/c1/a.wav", 3, 0).unwrap().is_empty());
        assert!(matches!(s.read_range("nope", 0, 1), Err(Error::NotFound(k)) if k == "nope"));
    }

    #[test]
    fn stat_reports_size_without_hashing_and_none_for_missing_or_dirs() {
        let (_d, s) = store_with(&[("audio/c1/a.wav", b"0123456789")]);
        let m = s.stat("audio/c1/a.wav").unwrap().unwrap();
        assert_eq!((m.key.as_str(), m.size), ("audio/c1/a.wav", 10));
        assert!(m.version.is_some());
        assert!(s.stat("audio/none").unwrap().is_none());
        assert!(s.stat("audio").unwrap().is_none());
    }

    #[test]
    fn list_is_by_prefix_sorted() {
        let (_d, s) = store_with(&[("audio/b/c", b"22"), ("audio/a", b"1"), ("tables/Clip/x.json", b"{}")]);
        let keys: Vec<_> = s.list("audio/").unwrap().into_iter().map(|m| (m.key, m.size)).collect();
        assert_eq!(keys, vec![("audio/a".to_string(), 1), ("audio/b/c".to_string(), 2)]);
        assert_eq!(s.list("").unwrap().len(), 3);
        assert!(s.list("zzz").unwrap().is_empty());
    }

    #[test]
    fn keys_that_escape_are_refused_everywhere() {
        let (d, mut s) = store_with(&[]);
        std::fs::write(d.path().join("secret"), "s").unwrap();
        let src = d.path().join("secret");
        for k in ["../secret", "a/../../secret", "/abs", "a//b", "a\\b", "", "a/./b"] {
            assert!(matches!(s.put(k, &src, None), Err(Error::InvalidKey(_))), "{k}");
            assert!(matches!(s.stat(k), Err(Error::InvalidKey(_))), "{k}");
            assert!(matches!(s.read_range(k, 0, 1), Err(Error::InvalidKey(_))), "{k}");
            assert!(matches!(s.delete(k), Err(Error::InvalidKey(_))), "{k}");
            assert!(s.path(k).is_none());
        }
        assert_eq!(std::fs::read(d.path().join("secret")).unwrap(), b"s");
    }

    #[test]
    fn put_streams_leaves_no_partial_file_and_overwrites() {
        let (d, mut s) = store_with(&[]);
        let src = d.path().join("src.bin");
        std::fs::write(&src, b"first").unwrap();
        let r = s.put("x/y.bin", &src, None).unwrap();
        assert_eq!(r.size, 5);
        assert_eq!(r.sha256, sha256_file(&src).unwrap().0);
        std::fs::write(&src, b"second!").unwrap();
        s.put("x/y.bin", &src, None).unwrap();
        assert_eq!(std::fs::read(s.path_of("x/y.bin")).unwrap(), b"second!");
        let names: Vec<_> = std::fs::read_dir(s.path_of("x")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn delete_removes_and_tolerates_missing() {
        let (_d, s) = store_with(&[("a", b"1")]);
        s.delete("a").unwrap();
        assert!(s.stat("a").unwrap().is_none());
        s.delete("a").unwrap();
    }
}
