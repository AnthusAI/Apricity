//! Library sync: a library folder and a remote (S3 or a folder) kept identical, key for key
//! (design/storage.md, section on sync). The engine is pure over two `Files` stores.
//!
//! Keys are library-relative paths, so the bucket layout is the library layout. Each side is
//! summarised as a manifest (key -> size and SHA-256). The last-sync state records the manifest
//! both sides agreed on; a three-way comparison of local, remote and that base says which side
//! changed a key. A key changed on one side is transferred; a key changed on both sides
//! differently is a conflict and is never overwritten unless the caller names a winner.

use crate::files::{Error, FileRef, Files, Result, content_type_for, sha256_file, valid_key};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The last-sync state file, at the library root. It is machine-local and never synced.
pub const STATE_FILE: &str = ".apricity-sync.json";

/// The library metadata file: it holds this machine's API key and identity, so it never syncs.
const LIBRARY_FILE: &str = "apricity-library.json";

/// Whether a library-relative key takes part in sync.
///
/// Everything under a library syncs (tables, files, analysis, slices, clips, whatever Virtuus
/// writes) except machine-local scratch: any path with a dot-prefixed segment (`.virtuus/`
/// lock, change log and index snapshots, the sync state, upload and transfer scratch,
/// `.DS_Store`) and `apricity-library.json`.
pub fn is_syncable(key: &str) -> bool {
    valid_key(key) && key != LIBRARY_FILE && key.split('/').all(|seg| !seg.starts_with('.'))
}

/// Size and content hash of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub size: u64,
    pub sha256: String,
}

/// Key -> entry for every syncable file in a store.
pub type Manifest = BTreeMap<String, Entry>;

/// A hash remembered against the change token it was computed for, so unchanged files are not
/// hashed (or HEADed) again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cached {
    pub size: u64,
    pub version: String,
    pub sha256: String,
}

/// What is remembered about one remote.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteState {
    /// The manifest both sides agreed on at the last sync (the merge base).
    #[serde(default)]
    pub base: Manifest,
    #[serde(default)]
    pub remote_cache: BTreeMap<String, Cached>,
}

/// The last-sync state, stored in the library as `STATE_FILE`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub format: u32,
    #[serde(default)]
    pub local_cache: BTreeMap<String, Cached>,
    /// Keyed by remote id (`s3://bucket/prefix`, `dir:/path`): a library can sync to several.
    #[serde(default)]
    pub remotes: BTreeMap<String, RemoteState>,
}

impl Default for State {
    fn default() -> Self {
        State {
            format: 1,
            local_cache: BTreeMap::new(),
            remotes: BTreeMap::new(),
        }
    }
}

impl State {
    /// Load the state from `path`; a missing file is an empty state (never synced).
    pub fn load(path: &Path) -> Result<State> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| Error::Hash(format!("{}: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Write the state atomically (a temp file beside it, then a rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("json.part");
        let text = serde_json::to_string_pretty(self).map_err(|e| Error::Hash(e.to_string()))?;
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// Which changes a run may apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Local to remote only.
    Push,
    /// Remote to local only.
    Pull,
    /// Both ways (what `status` shows).
    Both,
}

/// Which side wins a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prefer {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub direction: Direction,
    /// Propagate deletions. Without it a deletion is only reported.
    pub delete: bool,
    pub prefer: Option<Prefer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    Push,
    Pull,
    DeleteRemote,
    DeleteLocal,
}

/// One change to make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub key: String,
    pub kind: StepKind,
    /// Bytes to transfer (0 for deletions).
    pub size: u64,
}

/// A key changed differently on both sides since the last sync (or added differently on both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub key: String,
    pub local: Option<Entry>,
    pub remote: Option<Entry>,
}

/// A change that was seen but not made, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub conflicts: Vec<Conflict>,
    pub skipped: Vec<Skipped>,
    /// Keys identical on both sides.
    pub in_sync: usize,
}

fn sha(e: &Option<&Entry>) -> Option<String> {
    e.map(|e| e.sha256.clone())
}

/// Compare local, remote and base manifests and decide what to do.
pub fn plan(local: &Manifest, remote: &Manifest, base: &Manifest, opts: &Options) -> Plan {
    let keys: BTreeSet<&String> = local
        .keys()
        .chain(remote.keys())
        .chain(base.keys())
        .collect();
    let mut plan = Plan::default();
    for key in keys {
        let (l, r, b) = (local.get(key), remote.get(key), base.get(key));
        if sha(&l) == sha(&r) {
            if l.is_some() {
                plan.in_sync += 1;
            }
            continue;
        }
        let local_changed = sha(&l) != sha(&b);
        let remote_changed = sha(&r) != sha(&b);
        let kind = if local_changed && remote_changed {
            match opts.prefer {
                None => {
                    plan.conflicts.push(Conflict {
                        key: key.clone(),
                        local: l.cloned(),
                        remote: r.cloned(),
                    });
                    continue;
                }
                Some(Prefer::Local) => {
                    if l.is_some() {
                        StepKind::Push
                    } else {
                        StepKind::DeleteRemote
                    }
                }
                Some(Prefer::Remote) => {
                    if r.is_some() {
                        StepKind::Pull
                    } else {
                        StepKind::DeleteLocal
                    }
                }
            }
        } else if local_changed {
            if l.is_some() {
                StepKind::Push
            } else {
                StepKind::DeleteRemote
            }
        } else if r.is_some() {
            StepKind::Pull
        } else {
            StepKind::DeleteLocal
        };
        let allowed = match kind {
            StepKind::Push | StepKind::DeleteRemote => opts.direction != Direction::Pull,
            StepKind::Pull | StepKind::DeleteLocal => opts.direction != Direction::Push,
        };
        let deletes = matches!(kind, StepKind::DeleteRemote | StepKind::DeleteLocal);
        if !allowed {
            let reason = match kind {
                StepKind::Push => "changed locally; run push",
                StepKind::DeleteRemote => "deleted locally; run push --delete",
                StepKind::Pull => "changed on the remote; run pull",
                StepKind::DeleteLocal => "deleted on the remote; run pull --delete",
            };
            plan.skipped.push(Skipped {
                key: key.clone(),
                reason: reason.into(),
            });
        } else if deletes && !opts.delete {
            let reason = match kind {
                StepKind::DeleteRemote => {
                    "deleted locally; pass --delete to delete the remote copy"
                }
                _ => "deleted on the remote; pass --delete to delete the local copy",
            };
            plan.skipped.push(Skipped {
                key: key.clone(),
                reason: reason.into(),
            });
        } else {
            let size = match kind {
                StepKind::Push => l.map_or(0, |e| e.size),
                StepKind::Pull => r.map_or(0, |e| e.size),
                _ => 0,
            };
            plan.steps.push(Step {
                key: key.clone(),
                kind,
                size,
            });
        }
    }
    plan
}

/// Summarise a store: every syncable key with its size and SHA-256. Hashes come from `cache`
/// when the key's size and change token are unchanged; otherwise from `head` (a folder hashes
/// the file, S3 reads the hash it was stored with). The cache is pruned to the keys listed.
pub fn manifest(store: &dyn Files, cache: &mut BTreeMap<String, Cached>) -> Result<Manifest> {
    let mut out = Manifest::new();
    let mut fresh = BTreeMap::new();
    for meta in store.list("")? {
        if !is_syncable(&meta.key) {
            continue;
        }
        if let (Some(version), Some(c)) = (&meta.version, cache.get(&meta.key))
            && c.size == meta.size
            && &c.version == version
        {
            out.insert(
                meta.key.clone(),
                Entry {
                    size: c.size,
                    sha256: c.sha256.clone(),
                },
            );
            fresh.insert(meta.key, c.clone());
            continue;
        }
        let Some(head) = store.head(&meta.key)? else {
            continue; // removed since it was listed
        };
        out.insert(
            meta.key.clone(),
            Entry {
                size: head.size,
                sha256: head.sha256.clone(),
            },
        );
        if let Some(version) = meta.version {
            fresh.insert(
                meta.key,
                Cached {
                    size: head.size,
                    version,
                    sha256: head.sha256,
                },
            );
        }
    }
    *cache = fresh;
    Ok(out)
}

/// What a run did.
#[derive(Debug, Default)]
pub struct Report {
    pub plan: Plan,
    pub dry_run: bool,
    pub pushed: usize,
    pub pulled: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub bytes: u64,
    /// Steps that failed, with the reason; the rest of the run still completes.
    pub failed: Vec<(String, String)>,
}

impl Report {
    /// Whether the run left work undone that needs a person (conflicts or failures).
    pub fn needs_attention(&self) -> bool {
        !self.plan.conflicts.is_empty() || !self.failed.is_empty()
    }

    /// Human-readable plan and outcome.
    pub fn display(&self) -> String {
        use std::fmt::Write;
        let mut s = String::new();
        for st in &self.plan.steps {
            let (verb, size) = match st.kind {
                StepKind::Push => ("push", format!("  ({} bytes)", st.size)),
                StepKind::Pull => ("pull", format!("  ({} bytes)", st.size)),
                StepKind::DeleteRemote => ("delete remote", String::new()),
                StepKind::DeleteLocal => ("delete local", String::new()),
            };
            let _ = writeln!(s, "  {verb:<14}{}{size}", st.key);
        }
        for c in &self.plan.conflicts {
            let side = |e: &Option<Entry>| {
                e.as_ref().map_or("deleted".to_string(), |e| {
                    e.sha256.chars().take(10).collect()
                })
            };
            let _ = writeln!(
                s,
                "  CONFLICT      {}  local {} / remote {}",
                c.key,
                side(&c.local),
                side(&c.remote)
            );
        }
        for k in &self.plan.skipped {
            let _ = writeln!(s, "  skipped       {}: {}", k.key, k.reason);
        }
        for (k, why) in &self.failed {
            let _ = writeln!(s, "  FAILED        {k}: {why}");
        }
        let _ = writeln!(
            s,
            "{}: {} to push, {} to pull, {} remote deletions, {} local deletions, {} in sync, {} conflicts, {} skipped",
            if self.dry_run { "plan" } else { "done" },
            self.count(StepKind::Push),
            self.count(StepKind::Pull),
            self.count(StepKind::DeleteRemote),
            self.count(StepKind::DeleteLocal),
            self.plan.in_sync,
            self.plan.conflicts.len(),
            self.plan.skipped.len(),
        );
        if !self.dry_run {
            let _ = writeln!(
                s,
                "transferred: {} pushed, {} pulled, {} remote deleted, {} local deleted, {} bytes",
                self.pushed, self.pulled, self.deleted_remote, self.deleted_local, self.bytes
            );
        }
        s
    }

    fn count(&self, kind: StepKind) -> usize {
        self.plan.steps.iter().filter(|s| s.kind == kind).count()
    }
}

/// Compare `local` and `remote`, then (unless `dry_run`) make the planned changes.
///
/// `state` supplies the merge base and hash caches for `remote_id` and is updated in memory; the
/// caller saves it (not on a dry run). `scratch` is a folder for in-flight downloads; it is
/// created here and its contents removed. A pull verifies the downloaded bytes' SHA-256 before
/// they replace anything. Failed steps are reported and leave their key's base unchanged.
pub fn run(
    local: &mut dyn Files,
    remote: &mut dyn Files,
    scratch: &Path,
    state: &mut State,
    remote_id: &str,
    opts: &Options,
    dry_run: bool,
) -> Result<Report> {
    let rs = state.remotes.entry(remote_id.to_string()).or_default();
    let local_m = manifest(local, &mut state.local_cache)?;
    let remote_m = manifest(remote, &mut rs.remote_cache)?;
    let plan = plan(&local_m, &remote_m, &rs.base, opts);
    let mut report = Report {
        plan,
        dry_run,
        ..Report::default()
    };
    if dry_run {
        return Ok(report);
    }

    // Keys already identical are the new base; keys gone from both sides leave it.
    for key in local_m
        .keys()
        .chain(remote_m.keys())
        .chain(rs.base.clone().keys())
    {
        match (local_m.get(key), remote_m.get(key)) {
            (Some(l), Some(r)) if l.sha256 == r.sha256 => {
                rs.base.insert(key.clone(), l.clone());
            }
            (None, None) => {
                rs.base.remove(key);
            }
            _ => {}
        }
    }

    std::fs::create_dir_all(scratch)?;
    let steps = report.plan.steps.clone();
    for step in &steps {
        let done = match step.kind {
            StepKind::Push => push_one(
                local,
                remote,
                &local_m[&step.key],
                &step.key,
                scratch,
                &mut rs.remote_cache,
            ),
            StepKind::Pull => pull_one(
                local,
                remote,
                &remote_m[&step.key],
                &step.key,
                scratch,
                &mut state.local_cache,
            ),
            StepKind::DeleteRemote => remote.delete(&step.key).map(|()| {
                rs.remote_cache.remove(&step.key);
            }),
            StepKind::DeleteLocal => local.delete(&step.key).map(|()| {
                state.local_cache.remove(&step.key);
            }),
        };
        match done {
            Ok(()) => match step.kind {
                StepKind::Push => {
                    report.pushed += 1;
                    report.bytes += step.size;
                    rs.base.insert(step.key.clone(), local_m[&step.key].clone());
                }
                StepKind::Pull => {
                    report.pulled += 1;
                    report.bytes += step.size;
                    rs.base
                        .insert(step.key.clone(), remote_m[&step.key].clone());
                }
                StepKind::DeleteRemote => {
                    report.deleted_remote += 1;
                    rs.base.remove(&step.key);
                }
                StepKind::DeleteLocal => {
                    report.deleted_local += 1;
                    rs.base.remove(&step.key);
                }
            },
            Err(e) => report.failed.push((step.key.clone(), e.to_string())),
        }
    }
    let _ = std::fs::remove_dir_all(scratch);
    Ok(report)
}

fn scratch_file(scratch: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    scratch.join(format!(
        "t{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ))
}

fn remember(
    store: &dyn Files,
    key: &str,
    entry: &Entry,
    cache: &mut BTreeMap<String, Cached>,
) -> Result<()> {
    match store.stat(key)?.and_then(|m| m.version) {
        Some(version) => {
            cache.insert(
                key.to_string(),
                Cached {
                    size: entry.size,
                    version,
                    sha256: entry.sha256.clone(),
                },
            );
        }
        None => {
            cache.remove(key);
        }
    }
    Ok(())
}

fn check_ref(r: &FileRef, expected: &Entry, key: &str) -> Result<()> {
    if r.sha256 != expected.sha256 || r.size != expected.size {
        return Err(Error::Hash(format!(
            "{key}: content changed or was corrupted in transfer"
        )));
    }
    Ok(())
}

fn push_one(
    local: &mut dyn Files,
    remote: &mut dyn Files,
    entry: &Entry,
    key: &str,
    scratch: &Path,
    remote_cache: &mut BTreeMap<String, Cached>,
) -> Result<()> {
    let ctype = content_type_for(key);
    let (src, tmp) = match local.path(key) {
        Some(p) => (p, None),
        None => {
            let t = scratch_file(scratch);
            local.get(key, &t)?;
            (t.clone(), Some(t))
        }
    };
    let put = remote.put(key, &src, Some(ctype));
    if let Some(t) = tmp {
        let _ = std::fs::remove_file(t);
    }
    check_ref(&put?, entry, key)?;
    remember(remote, key, entry, remote_cache)
}

fn pull_one(
    local: &mut dyn Files,
    remote: &mut dyn Files,
    entry: &Entry,
    key: &str,
    scratch: &Path,
    local_cache: &mut BTreeMap<String, Cached>,
) -> Result<()> {
    let tmp = scratch_file(scratch);
    let result = (|| -> Result<()> {
        remote.get(key, &tmp)?;
        let (sha256, size) = sha256_file(&tmp)?;
        if sha256 != entry.sha256 || size != entry.size {
            return Err(Error::Hash(format!(
                "{key}: downloaded content does not match the remote's recorded hash"
            )));
        }
        let put = local.put(key, &tmp, None)?;
        check_ref(&put, entry, key)?;
        remember(local, key, entry, local_cache)
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{FileMeta, FsFiles};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Rig {
        _dir: tempfile::TempDir,
        local_root: PathBuf,
        remote_root: PathBuf,
        state: State,
    }

    const REMOTE: &str = "dir:test";

    impl Rig {
        fn new() -> Rig {
            let dir = tempfile::tempdir().unwrap();
            let local_root = dir.path().join("local");
            let remote_root = dir.path().join("remote");
            std::fs::create_dir_all(&local_root).unwrap();
            std::fs::create_dir_all(&remote_root).unwrap();
            Rig {
                _dir: dir,
                local_root,
                remote_root,
                state: State::default(),
            }
        }
        fn write(root: &Path, key: &str, body: &[u8]) {
            let p = root.join(key);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        fn local(&self, key: &str, body: &[u8]) {
            Self::write(&self.local_root, key, body);
        }
        fn remote(&self, key: &str, body: &[u8]) {
            Self::write(&self.remote_root, key, body);
        }
        fn run(
            &mut self,
            direction: Direction,
            delete: bool,
            prefer: Option<Prefer>,
            dry: bool,
        ) -> Report {
            let mut l = FsFiles::new(&self.local_root);
            let mut r = FsFiles::new(&self.remote_root);
            run(
                &mut l,
                &mut r,
                &self.local_root.join(".sync-tmp"),
                &mut self.state,
                REMOTE,
                &Options {
                    direction,
                    delete,
                    prefer,
                },
                dry,
            )
            .unwrap()
        }
        fn push(&mut self) -> Report {
            self.run(Direction::Push, false, None, false)
        }
        fn pull(&mut self) -> Report {
            self.run(Direction::Pull, false, None, false)
        }
    }

    fn keys(r: &Report, kind: StepKind) -> Vec<String> {
        r.plan
            .steps
            .iter()
            .filter(|s| s.kind == kind)
            .map(|s| s.key.clone())
            .collect()
    }

    fn library(rig: &Rig) {
        rig.local("tables/Clip/c1.json", b"{\"id\":\"c1\"}");
        rig.local("tables/Slice/s1.json", b"{\"id\":\"s1\"}");
        rig.local("files/audio/c1/a.wav", &[7u8; 5000]);
        rig.local("files/analysis/c1/abc.json", b"{}");
    }

    #[test]
    fn syncable_rules() {
        for k in [
            "tables/Clip/a.json",
            "files/audio/c/a.wav",
            "files/analysis/x/y.json",
            "notes.txt",
        ] {
            assert!(is_syncable(k), "{k}");
        }
        for k in [
            ".virtuus/lock",
            ".virtuus/changes.jsonl",
            STATE_FILE,
            "apricity-library.json",
            ".DS_Store",
            "files/audio/.DS_Store",
            "files/.upload-1",
            "tables/Clip/.c1.json.part-9",
            ".sync-tmp/t1-0",
            "../x",
            "/abs",
            "a//b",
            "",
        ] {
            assert!(!is_syncable(k), "{k}");
        }
    }

    #[test]
    fn push_transfers_everything_once_then_only_differences() {
        let mut rig = Rig::new();
        library(&rig);
        let first = rig.push();
        assert_eq!(first.pushed, 4);
        assert_eq!(first.bytes, 11 + 11 + 5000 + 2);
        for k in [
            "tables/Clip/c1.json",
            "tables/Slice/s1.json",
            "files/audio/c1/a.wav",
            "files/analysis/c1/abc.json",
        ] {
            assert_eq!(
                std::fs::read(rig.remote_root.join(k)).unwrap(),
                std::fs::read(rig.local_root.join(k)).unwrap(),
                "{k}"
            );
        }
        let again = rig.push();
        assert_eq!((again.pushed, again.pulled, again.plan.in_sync), (0, 0, 4));
        assert!(again.plan.steps.is_empty() && !again.needs_attention());

        rig.local("tables/Clip/c1.json", b"{\"id\":\"c1\",\"title\":\"new\"}");
        rig.local("tables/Slice/s2.json", b"{\"id\":\"s2\"}");
        let third = rig.push();
        assert_eq!(third.pushed, 2);
        assert_eq!(
            keys(&third, StepKind::Push),
            vec!["tables/Clip/c1.json", "tables/Slice/s2.json"]
        );
        assert_eq!(
            std::fs::read(rig.remote_root.join("tables/Clip/c1.json")).unwrap(),
            b"{\"id\":\"c1\",\"title\":\"new\"}"
        );
    }

    #[test]
    fn machine_local_files_never_sync_either_way() {
        let mut rig = Rig::new();
        library(&rig);
        rig.local(".virtuus/lock", b"x");
        rig.local(".virtuus/changes.jsonl", b"{}");
        rig.local("apricity-library.json", b"{\"api_key\":\"secret\"}");
        rig.local("files/.upload-1-2", b"half");
        rig.local(".DS_Store", b"x");
        rig.remote(".virtuus/lock", b"remote lock");
        rig.remote("apricity-library.json", b"remote meta");
        let r = rig.push();
        assert_eq!(r.pushed, 4);
        assert!(!rig.remote_root.join("files/.upload-1-2").exists());
        assert!(!rig.remote_root.join(".DS_Store").exists());
        assert_eq!(
            std::fs::read(rig.remote_root.join("apricity-library.json")).unwrap(),
            b"remote meta"
        );
        let p = rig.pull();
        assert_eq!(p.pulled, 0);
        assert_eq!(
            std::fs::read(rig.local_root.join("apricity-library.json")).unwrap(),
            b"{\"api_key\":\"secret\"}"
        );
        assert!(
            !rig.local_root.join(".virtuus/lock").exists()
                || std::fs::read(rig.local_root.join(".virtuus/lock")).unwrap() == b"x"
        );
        assert!(
            rig.state.remotes[REMOTE]
                .base
                .keys()
                .all(|k| is_syncable(k))
        );
    }

    #[test]
    fn pull_fills_an_empty_folder_byte_for_byte_and_later_pulls_only_changes() {
        let mut src = Rig::new();
        library(&src);
        src.push();
        let mut dst = Rig::new();
        dst.remote_root = src.remote_root.clone();
        let p = dst.pull();
        assert_eq!(p.pulled, 4);
        for k in ["tables/Clip/c1.json", "files/audio/c1/a.wav"] {
            assert_eq!(
                std::fs::read(dst.local_root.join(k)).unwrap(),
                std::fs::read(src.local_root.join(k)).unwrap()
            );
        }
        assert!(!dst.local_root.join(".sync-tmp").exists());
        assert_eq!(dst.pull().pulled, 0);
        src.local("tables/Clip/c1.json", b"{\"id\":\"c1\",\"v\":2}");
        src.push();
        let p = dst.pull();
        assert_eq!(keys(&p, StepKind::Pull), vec!["tables/Clip/c1.json"]);
    }

    #[test]
    fn a_push_does_not_pull_and_a_pull_does_not_push() {
        let mut rig = Rig::new();
        rig.local("a", b"1");
        rig.remote("b", b"2");
        let r = rig.push();
        assert_eq!((r.pushed, r.pulled), (1, 0));
        assert_eq!(r.plan.skipped.len(), 1);
        assert!(!rig.local_root.join("b").exists());
        rig.local("c", b"3");
        let r = rig.pull();
        assert_eq!((r.pushed, r.pulled), (0, 1));
        assert!(!rig.remote_root.join("c").exists());
    }

    #[test]
    fn deletions_need_the_flag() {
        let mut rig = Rig::new();
        library(&rig);
        rig.push();
        std::fs::remove_file(rig.local_root.join("tables/Slice/s1.json")).unwrap();
        let r = rig.push();
        assert_eq!(r.deleted_remote, 0);
        assert_eq!(r.plan.skipped.len(), 1);
        assert!(r.plan.skipped[0].reason.contains("--delete"));
        assert!(rig.remote_root.join("tables/Slice/s1.json").exists());
        let r = rig.run(Direction::Push, true, None, false);
        assert_eq!(r.deleted_remote, 1);
        assert!(!rig.remote_root.join("tables/Slice/s1.json").exists());
        assert_eq!(rig.push().plan.skipped.len(), 0);

        // The other way: deleted on the remote.
        std::fs::remove_file(rig.remote_root.join("tables/Clip/c1.json")).unwrap();
        let r = rig.pull();
        assert_eq!(r.deleted_local, 0);
        assert!(rig.local_root.join("tables/Clip/c1.json").exists());
        let r = rig.run(Direction::Pull, true, None, false);
        assert_eq!(r.deleted_local, 1);
        assert!(!rig.local_root.join("tables/Clip/c1.json").exists());
    }

    #[test]
    fn both_sides_changed_is_a_conflict_and_nothing_is_overwritten() {
        let mut rig = Rig::new();
        library(&rig);
        rig.push();
        rig.local("tables/Clip/c1.json", b"local edit");
        rig.remote("tables/Clip/c1.json", b"remote edit");
        rig.local("tables/Slice/s1.json", b"only local");
        for run_pull in [false, true] {
            let r = if run_pull { rig.pull() } else { rig.push() };
            assert_eq!(r.plan.conflicts.len(), 1);
            assert_eq!(r.plan.conflicts[0].key, "tables/Clip/c1.json");
            assert!(r.needs_attention());
            assert!(r.display().contains("CONFLICT"));
            assert_eq!(
                std::fs::read(rig.local_root.join("tables/Clip/c1.json")).unwrap(),
                b"local edit"
            );
            assert_eq!(
                std::fs::read(rig.remote_root.join("tables/Clip/c1.json")).unwrap(),
                b"remote edit"
            );
        }
        // The non-conflicting change still went through on the push.
        assert_eq!(
            std::fs::read(rig.remote_root.join("tables/Slice/s1.json")).unwrap(),
            b"only local"
        );

        // prefer local pushes, prefer remote pulls
        let r = rig.run(Direction::Push, false, Some(Prefer::Local), false);
        assert_eq!(r.pushed, 1);
        assert_eq!(
            std::fs::read(rig.remote_root.join("tables/Clip/c1.json")).unwrap(),
            b"local edit"
        );
        assert!(!r.needs_attention());

        rig.local("tables/Clip/c1.json", b"local again");
        rig.remote("tables/Clip/c1.json", b"remote again");
        let r = rig.run(Direction::Pull, false, Some(Prefer::Remote), false);
        assert_eq!(r.pulled, 1);
        assert_eq!(
            std::fs::read(rig.local_root.join("tables/Clip/c1.json")).unwrap(),
            b"remote again"
        );
        assert_eq!(rig.push().plan.steps.len(), 0);
    }

    #[test]
    fn added_on_both_sides_differently_is_a_conflict_but_identical_is_not() {
        let mut rig = Rig::new();
        rig.local("x", b"one");
        rig.remote("x", b"two");
        rig.local("same", b"same");
        rig.remote("same", b"same");
        let r = rig.push();
        assert_eq!(r.plan.conflicts.len(), 1);
        assert_eq!(r.plan.in_sync, 1);
        assert_eq!(std::fs::read(rig.remote_root.join("x")).unwrap(), b"two");
        assert_eq!(
            rig.state.remotes[REMOTE].base.keys().collect::<Vec<_>>(),
            vec!["same"]
        );
    }

    #[test]
    fn modified_locally_but_deleted_remotely_is_a_conflict() {
        let mut rig = Rig::new();
        rig.local("x", b"one");
        rig.push();
        rig.local("x", b"edited");
        std::fs::remove_file(rig.remote_root.join("x")).unwrap();
        let r = rig.run(Direction::Both, true, None, false);
        assert_eq!(r.plan.conflicts.len(), 1);
        assert!(rig.local_root.join("x").exists());
        assert!(!rig.remote_root.join("x").exists());
    }

    #[test]
    fn dry_run_transfers_and_records_nothing() {
        let mut rig = Rig::new();
        library(&rig);
        let r = rig.run(Direction::Both, false, None, true);
        assert!(r.dry_run);
        assert_eq!(r.plan.steps.len(), 4);
        assert_eq!(r.pushed, 0);
        assert!(
            std::fs::read_dir(&rig.remote_root)
                .unwrap()
                .next()
                .is_none()
        );
        assert!(rig.state.remotes[REMOTE].base.is_empty());
        assert!(r.display().starts_with("  push"));
    }

    #[test]
    fn state_round_trips_and_is_not_synced() {
        let mut rig = Rig::new();
        library(&rig);
        rig.push();
        let path = rig.local_root.join(STATE_FILE);
        rig.state.save(&path).unwrap();
        assert_eq!(State::load(&path).unwrap(), rig.state);
        assert_eq!(
            State::load(&rig.local_root.join("none.json")).unwrap(),
            State::default()
        );
        let again = rig.push();
        assert_eq!(again.pushed, 0);
        assert!(!rig.remote_root.join(STATE_FILE).exists());
        std::fs::write(&path, "not json").unwrap();
        assert!(State::load(&path).is_err());
    }

    /// A store wrapper that counts `head` calls and can lie: extra listed keys, corrupt reads.
    struct Probe {
        inner: FsFiles,
        heads: Arc<AtomicUsize>,
        extra: Vec<FileMeta>,
        corrupt_get: bool,
    }

    impl Files for Probe {
        fn put(&mut self, k: &str, s: &Path, c: Option<&str>) -> Result<FileRef> {
            self.inner.put(k, s, c)
        }
        fn get(&self, k: &str, d: &Path) -> Result<()> {
            self.inner.get(k, d)?;
            if self.corrupt_get {
                let mut b = std::fs::read(d)?;
                if let Some(x) = b.first_mut() {
                    *x ^= 0xff;
                }
                std::fs::write(d, b)?;
            }
            Ok(())
        }
        fn read_range(&self, k: &str, s: u64, l: u64) -> Result<Vec<u8>> {
            self.inner.read_range(k, s, l)
        }
        fn stat(&self, k: &str) -> Result<Option<FileMeta>> {
            self.inner.stat(k)
        }
        fn list(&self, p: &str) -> Result<Vec<FileMeta>> {
            let mut v = self.inner.list(p)?;
            v.extend(self.extra.clone());
            Ok(v)
        }
        fn head(&self, k: &str) -> Result<Option<FileRef>> {
            self.heads.fetch_add(1, Ordering::SeqCst);
            self.inner.head(k)
        }
        fn delete(&self, k: &str) -> Result<()> {
            self.inner.delete(k)
        }
        fn path(&self, k: &str) -> Option<PathBuf> {
            self.inner.path(k)
        }
    }

    #[test]
    fn unchanged_files_are_not_hashed_again() {
        let mut rig = Rig::new();
        library(&rig);
        rig.push();
        let heads = Arc::new(AtomicUsize::new(0));
        let mut l = Probe {
            inner: FsFiles::new(&rig.local_root),
            heads: heads.clone(),
            extra: vec![],
            corrupt_get: false,
        };
        let mut r = Probe {
            inner: FsFiles::new(&rig.remote_root),
            heads: heads.clone(),
            extra: vec![],
            corrupt_get: false,
        };
        let opts = Options {
            direction: Direction::Push,
            delete: false,
            prefer: None,
        };
        let rep = run(
            &mut l,
            &mut r,
            &rig.local_root.join(".sync-tmp"),
            &mut rig.state,
            REMOTE,
            &opts,
            false,
        )
        .unwrap();
        assert_eq!(rep.pushed, 0);
        assert_eq!(heads.load(Ordering::SeqCst), 0, "cached hashes are reused");
        rig.local("tables/Clip/c1.json", b"changed");
        let rep = run(
            &mut l,
            &mut r,
            &rig.local_root.join(".sync-tmp"),
            &mut rig.state,
            REMOTE,
            &opts,
            false,
        )
        .unwrap();
        assert_eq!(rep.pushed, 1);
        assert_eq!(
            heads.load(Ordering::SeqCst),
            1,
            "only the changed file is hashed"
        );
    }

    #[test]
    fn a_corrupt_download_is_rejected_and_replaces_nothing() {
        let mut rig = Rig::new();
        rig.remote("a.bin", b"remote bytes");
        rig.local("keep.bin", b"kept");
        let heads = Arc::new(AtomicUsize::new(0));
        let mut l = FsFiles::new(&rig.local_root);
        let mut r = Probe {
            inner: FsFiles::new(&rig.remote_root),
            heads,
            extra: vec![],
            corrupt_get: true,
        };
        let opts = Options {
            direction: Direction::Pull,
            delete: false,
            prefer: None,
        };
        let rep = run(
            &mut l,
            &mut r,
            &rig.local_root.join(".sync-tmp"),
            &mut rig.state,
            REMOTE,
            &opts,
            false,
        )
        .unwrap();
        assert_eq!(rep.pulled, 0);
        assert_eq!(rep.failed.len(), 1);
        assert!(rep.failed[0].1.contains("does not match"));
        assert!(rep.needs_attention());
        assert!(!rig.local_root.join("a.bin").exists());
        assert!(rig.state.remotes[REMOTE].base.is_empty());
    }

    #[test]
    fn remote_keys_that_escape_or_are_scratch_are_ignored() {
        let mut rig = Rig::new();
        rig.remote("ok", b"1");
        let heads = Arc::new(AtomicUsize::new(0));
        let extra = ["../evil", "/abs", "a/../../b", ".virtuus/lock", "x//y"]
            .iter()
            .map(|k| FileMeta {
                key: k.to_string(),
                size: 1,
                version: Some("v".into()),
            })
            .collect();
        let mut l = FsFiles::new(&rig.local_root);
        let mut r = Probe {
            inner: FsFiles::new(&rig.remote_root),
            heads,
            extra,
            corrupt_get: false,
        };
        let opts = Options {
            direction: Direction::Pull,
            delete: false,
            prefer: None,
        };
        let rep = run(
            &mut l,
            &mut r,
            &rig.local_root.join(".sync-tmp"),
            &mut rig.state,
            REMOTE,
            &opts,
            false,
        )
        .unwrap();
        assert_eq!(rep.pulled, 1);
        assert!(rep.failed.is_empty());
        assert!(!rig.local_root.parent().unwrap().join("evil").exists());
    }

    #[test]
    fn plan_table() {
        let e = |s: &str| Entry {
            size: s.len() as u64,
            sha256: s.to_string(),
        };
        let m = |kv: &[(&str, &str)]| {
            kv.iter()
                .map(|(k, v)| (k.to_string(), e(v)))
                .collect::<Manifest>()
        };
        let opts = Options {
            direction: Direction::Both,
            delete: true,
            prefer: None,
        };
        let p = plan(
            &m(&[
                ("new_l", "a"),
                ("chg_l", "b2"),
                ("same", "s"),
                ("chg_r", "c"),
                ("both", "d1"),
            ]),
            &m(&[
                ("new_r", "z"),
                ("chg_l", "b"),
                ("same", "s"),
                ("chg_r", "c2"),
                ("both", "d2"),
                ("gone_l", "g"),
            ]),
            &m(&[
                ("chg_l", "b"),
                ("same", "s"),
                ("chg_r", "c"),
                ("both", "d"),
                ("gone_l", "g"),
                ("gone_r", "h"),
            ]),
            &opts,
        );
        let got: Vec<_> = p.steps.iter().map(|s| (s.key.as_str(), s.kind)).collect();
        assert_eq!(
            got,
            vec![
                ("chg_l", StepKind::Push),
                ("chg_r", StepKind::Pull),
                ("gone_l", StepKind::DeleteRemote),
                ("new_l", StepKind::Push),
                ("new_r", StepKind::Pull),
            ]
        );
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.in_sync, 1);
        assert!(p.skipped.is_empty());
    }
}
