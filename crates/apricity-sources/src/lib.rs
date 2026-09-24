//! Download, verify and remove predefined sources of public-domain audio.
//!
//! The catalog is embedded (`catalog/sources.json`). Nothing here assumes a UI or a server: callers
//! pass a samples directory, a [`Fetcher`] and a progress callback.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(feature = "http")]
pub mod http;

/// How a file is obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FetchKind {
    #[default]
    Http,
    /// Must be downloaded by hand (listed, never fetched).
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct File {
    /// Path relative to the samples root.
    pub path: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default)]
    pub fetch: FetchKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt_start: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub title: String,
    pub credit: String,
    pub rights: String,
    pub source_page: String,
    pub files: Vec<File>,
}

/// The embedded catalog.
pub fn list_sources() -> Vec<Source> {
    serde_json::from_str(include_str!("../catalog/sources.json")).expect("embedded catalog is valid JSON")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Missing,
    Present,
    Corrupt,
}

#[derive(Debug)]
pub struct FetchError(pub String);

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for FetchError {}
impl From<io::Error> for FetchError {
    fn from(e: io::Error) -> Self {
        FetchError(e.to_string())
    }
}

/// Streams the body at `url` into `out`.
pub trait Fetcher {
    fn get(&self, url: &str, out: &mut dyn Write) -> Result<(), FetchError>;
    /// Called between retries (`attempt` is the one that just failed, from 1). Default: no wait.
    fn backoff(&self, _attempt: u32) {}
}

#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    Started { path: String },
    Bytes { path: String, bytes: u64 },
    Finished { path: String, sha256: String },
    Skipped { path: String },
    Manual { path: String },
    Failed { path: String, error: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Downloaded,
    Skipped,
    Manual,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileReport {
    pub path: String,
    pub outcome: Outcome,
    /// Computed digest of the file on disk (downloaded files).
    pub sha256: Option<String>,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Report {
    pub files: Vec<FileReport>,
}

impl Report {
    pub fn downloaded(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Downloaded))
    }
    pub fn skipped(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Skipped))
    }
    pub fn manual(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Manual))
    }
    pub fn failed(&self) -> usize {
        self.count(|o| matches!(o, Outcome::Failed(_)))
    }
    pub fn ok(&self) -> bool {
        self.failed() == 0
    }
    fn count(&self, f: impl Fn(&Outcome) -> bool) -> usize {
        self.files.iter().filter(|r| f(&r.outcome)).count()
    }
}

const ATTEMPTS: u32 = 3;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut h = Sha256::new();
    io::copy(&mut fs::File::open(path)?, &mut h)?;
    Ok(hex(&h.finalize()))
}

fn part_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn state_of(f: &File, root: &Path) -> FileState {
    let p = root.join(&f.path);
    let Ok(meta) = fs::metadata(&p) else { return FileState::Missing };
    if !meta.is_file() {
        return FileState::Missing;
    }
    if f.size.is_some_and(|s| s != meta.len()) {
        return FileState::Corrupt;
    }
    match &f.sha256 {
        Some(want) => match sha256_file(&p) {
            Ok(got) if got.eq_ignore_ascii_case(want) => FileState::Present,
            _ => FileState::Corrupt,
        },
        None => FileState::Present,
    }
}

/// Per-file state. `.part` files are never counted.
pub fn status(source: &Source, root: &Path) -> Vec<(String, FileState)> {
    source.files.iter().map(|f| (f.path.clone(), state_of(f, root))).collect()
}

/// Writes to the sink and reports running byte counts.
struct Tap<'a> {
    inner: &'a mut fs::File,
    hasher: Sha256,
    total: u64,
    path: &'a str,
    on: &'a mut dyn FnMut(Progress),
}

impl Write for Tap<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.total += n as u64;
        (self.on)(Progress::Bytes { path: self.path.to_string(), bytes: self.total });
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn download(
    f: &File,
    root: &Path,
    fetcher: &dyn Fetcher,
    on: &mut dyn FnMut(Progress),
) -> Result<(String, u64), String> {
    let dest = root.join(&f.path);
    let part = part_path(&dest);
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut last = String::new();
    for attempt in 1..=ATTEMPTS {
        let mut file = fs::File::create(&part).map_err(|e| e.to_string())?; // truncates any stale .part
        let mut tap = Tap { inner: &mut file, hasher: Sha256::new(), total: 0, path: &f.path, on };
        match fetcher.get(&f.url, &mut tap) {
            Ok(()) => {
                let (digest, total) = (hex(&tap.hasher.finalize_reset()), tap.total);
                drop(file);
                if let Some(want) = &f.sha256 {
                    if !digest.eq_ignore_ascii_case(want) {
                        let _ = fs::remove_file(&part);
                        return Err(format!("sha256 mismatch: expected {want}, got {digest}"));
                    }
                }
                if let Some(size) = f.size {
                    if size != total {
                        let _ = fs::remove_file(&part);
                        return Err(format!("size mismatch: expected {size}, got {total}"));
                    }
                }
                fs::rename(&part, &dest).map_err(|e| e.to_string())?;
                return Ok((digest, total));
            }
            Err(e) => {
                last = e.to_string();
                drop(file);
                let _ = fs::remove_file(&part);
                if attempt < ATTEMPTS {
                    fetcher.backoff(attempt);
                }
            }
        }
    }
    Err(format!("{last} (after {ATTEMPTS} attempts)"))
}

/// Fetches every missing or corrupt http file; skips valid and manual ones. Failures are recorded
/// in the report and the run continues.
pub fn fetch(source: &Source, root: &Path, fetcher: &dyn Fetcher, on: &mut dyn FnMut(Progress)) -> Report {
    let mut report = Report::default();
    for f in &source.files {
        let path = f.path.clone();
        let mut rec = |outcome, sha256, bytes| report.files.push(FileReport { path: path.clone(), outcome, sha256, bytes });
        if f.fetch == FetchKind::Manual {
            on(Progress::Manual { path: path.clone() });
            rec(Outcome::Manual, None, 0);
            continue;
        }
        if state_of(f, root) == FileState::Present {
            on(Progress::Skipped { path: path.clone() });
            rec(Outcome::Skipped, None, 0);
            continue;
        }
        on(Progress::Started { path: path.clone() });
        match download(f, root, fetcher, on) {
            Ok((sha, bytes)) => {
                on(Progress::Finished { path: path.clone(), sha256: sha.clone() });
                rec(Outcome::Downloaded, Some(sha), bytes);
            }
            Err(error) => {
                on(Progress::Failed { path: path.clone(), error: error.clone() });
                rec(Outcome::Failed(error), None, 0);
            }
        }
    }
    report
}

/// Deletes only this source's files (and stray `.part` files), then prunes emptied directories
/// below `root`. Returns how many files were removed.
pub fn remove(source: &Source, root: &Path) -> io::Result<usize> {
    let mut n = 0;
    for f in &source.files {
        let p = root.join(&f.path);
        for target in [p.clone(), part_path(&p)] {
            match fs::remove_file(&target) {
                Ok(()) => n += 1,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        let mut dir = p.parent();
        while let Some(d) = dir {
            if d == root || !d.starts_with(root) || fs::remove_dir(d).is_err() {
                break; // non-empty, missing or the root itself
            }
            dir = d.parent();
        }
    }
    Ok(n)
}
