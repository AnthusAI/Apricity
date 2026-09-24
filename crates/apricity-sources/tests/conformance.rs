//! Cucumber runner for `features/sources/*.feature`. Uses an in-memory fetcher: no network.

use apricity_sources::*;
use cucumber::{World, gherkin::Step, given, then, when};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Default)]
struct Fake {
    served: HashMap<String, Vec<u8>>,
    broken: Vec<String>,
    calls: Cell<usize>,
    _log: RefCell<Vec<String>>,
}

impl Fetcher for Fake {
    fn get(&self, url: &str, out: &mut dyn Write) -> Result<(), FetchError> {
        self.calls.set(self.calls.get() + 1);
        if self.broken.iter().any(|u| u == url) {
            return Err(FetchError("connection refused".into()));
        }
        let body = self.served.get(url).ok_or_else(|| FetchError(format!("404 {url}")))?;
        // Write in two chunks so progress events can fire more than once.
        let mid = body.len() / 2;
        out.write_all(&body[..mid])?;
        out.write_all(&body[mid..])?;
        Ok(())
    }
}

#[derive(Default, World)]
struct W {
    dir: Option<tempfile::TempDir>,
    source: Option<Source>,
    fake: Fake,
    listed: Vec<Source>,
    statuses: Vec<(String, FileState)>,
    report: Option<Report>,
    events: Vec<Progress>,
    kit: Option<Kit>,
}

/// What the in-memory archive for the `kit` source contains.
#[derive(Default)]
struct Kit {
    files: Vec<(String, String)>, // (samples-root path, content)
    raw_entries: Vec<String>,
    symlinks: Vec<String>,
    lacks: Vec<String>,
    wrong_bytes: bool,
}

const KIT_URL: &str = "https://fake.test/kit.tar.bz2";

fn raw_entry(b: &mut tar::Builder<Vec<u8>>, name: &str, kind: tar::EntryType, link: Option<&str>, data: &[u8]) {
    let mut h = tar::Header::new_gnu();
    h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes()); // bypasses the ".." check
    h.set_entry_type(kind);
    h.set_size(data.len() as u64);
    h.set_mode(0o644);
    if let Some(l) = link {
        h.set_link_name(l).unwrap();
    }
    h.set_cksum();
    b.append(&h, data).unwrap();
}

fn build_tar_bz2(kit: &Kit) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    for (path, content) in &kit.files {
        let rel = path.strip_prefix("kit/").unwrap();
        if kit.lacks.iter().any(|l| l == rel) {
            continue;
        }
        raw_entry(&mut b, rel, tar::EntryType::Regular, None, content.as_bytes());
    }
    for e in &kit.raw_entries {
        raw_entry(&mut b, e, tar::EntryType::Regular, None, b"evil");
    }
    for l in &kit.symlinks {
        raw_entry(&mut b, l, tar::EntryType::Symlink, Some("/etc/passwd"), b"");
    }
    let tar_bytes = b.into_inner().unwrap();
    let mut enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    enc.write_all(&tar_bytes).unwrap();
    enc.finish().unwrap()
}

impl std::fmt::Debug for W {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("W")
    }
}

fn kit_source(kit: &Kit) -> (Source, Vec<u8>) {
    let served = build_tar_bz2(kit);
    let files = kit
        .files
        .iter()
        .map(|(p, c)| File {
            path: p.clone(),
            url: String::new(),
            size: Some(c.len() as u64),
            sha256: Some(digest(c.as_bytes())),
            fetch: FetchKind::Archive,
            title: None,
            excerpt_start: None,
        })
        .collect();
    let source = Source {
        id: "kit".into(),
        title: "Kit".into(),
        credit: "c".into(),
        rights: "r".into(),
        source_page: "https://fake.test".into(),
        archive: Some(Archive { url: KIT_URL.into(), size: served.len() as u64, sha256: digest(&served), format: "tar.bz2".into(), into: "kit".into() }),
        files,
    };
    (source, served)
}

/// Rebuilds the catalog source (whose sha256 always matches the pristine archive) and what the fake serves.
fn refresh_kit(w: &mut W) {
    let kit = w.kit.as_ref().unwrap();
    let pristine = Kit { files: kit.files.clone(), ..Kit::default() };
    let (source, good) = kit_source(&pristine);
    let served = if kit.wrong_bytes { b"garbage".to_vec() } else { build_tar_bz2(kit) };
    w.fake.served.insert(KIT_URL.into(), if kit.wrong_bytes || !(kit.raw_entries.is_empty() && kit.symlinks.is_empty() && kit.lacks.is_empty()) { served } else { good });
    let mut source = source;
    // The catalog pins the archive that is actually served (a tampered archive is still "the" archive).
    if !kit.wrong_bytes {
        let a = source.archive.as_mut().unwrap();
        let bytes = &w.fake.served[KIT_URL];
        a.size = bytes.len() as u64;
        a.sha256 = digest(bytes);
    }
    w.source = Some(source);
}

fn digest(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

impl W {
    fn root(&mut self) -> PathBuf {
        self.dir.get_or_insert_with(|| tempfile::tempdir().unwrap()).path().to_path_buf()
    }
    fn src(&self) -> &Source {
        self.source.as_ref().expect("source defined")
    }
    fn url(path: &str) -> String {
        format!("https://fake.test/{path}")
    }
}

fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn all_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() { all_files(&p, out) } else { out.push(p) }
    }
}

#[given(expr = "a source {string} with these files:")]
fn define(w: &mut W, id: String, step: &Step) {
    let table = step.table.as_ref().expect("table");
    let mut files = vec![];
    for row in table.rows.iter().skip(1) {
        let (path, content, fetch, sha) = (&row[0], &row[1], &row[2], &row[3]);
        w.fake.served.insert(W::url(path), content.clone().into_bytes());
        files.push(File {
            path: path.clone(),
            url: W::url(path),
            size: None,
            sha256: match sha.as_str() {
                "ok" => Some(digest(content.as_bytes())),
                "wrong" => Some(digest(b"something else")),
                _ => None,
            },
            fetch: if fetch == "manual" { FetchKind::Manual } else { FetchKind::Http },
            title: None,
            excerpt_start: None,
        });
    }
    w.source = Some(Source {
        id,
        title: "Demo".into(),
        credit: "c".into(),
        rights: "r".into(),
        source_page: "https://fake.test".into(),
        archive: None,
        files,
    });
}

#[given(expr = "an archive source {string} with these files:")]
fn define_kit(w: &mut W, _id: String, step: &Step) {
    let table = step.table.as_ref().expect("table");
    let files = table.rows.iter().skip(1).map(|r| (r[0].clone(), r[1].clone())).collect();
    w.kit = Some(Kit { files, ..Kit::default() });
    refresh_kit(w);
}

#[given(expr = "the archive {string} is served with wrong bytes")]
fn kit_wrong(w: &mut W, _id: String) {
    w.kit.as_mut().unwrap().wrong_bytes = true;
    refresh_kit(w);
}

#[given(expr = "the archive {string} also contains the entry {string}")]
fn kit_extra(w: &mut W, _id: String, entry: String) {
    w.kit.as_mut().unwrap().raw_entries.push(entry);
    refresh_kit(w);
}

#[given(expr = "the archive {string} also contains a symlink {string}")]
fn kit_symlink(w: &mut W, _id: String, entry: String) {
    w.kit.as_mut().unwrap().symlinks.push(entry);
    refresh_kit(w);
}

#[given(expr = "the archive {string} lacks the entry {string}")]
fn kit_lacks(w: &mut W, _id: String, entry: String) {
    w.kit.as_mut().unwrap().lacks.push(entry);
    refresh_kit(w);
}

#[given(expr = "the file {string} already contains {string}")]
fn have_file(w: &mut W, path: String, content: String) {
    let r = w.root();
    write(&r, &path, &content);
}

#[given(expr = "a partial download {string} contains {string}")]
fn have_part(w: &mut W, path: String, content: String) {
    let r = w.root();
    write(&r, &format!("{path}.part"), &content);
}

#[given(expr = "an unrelated file {string} exists")]
fn unrelated(w: &mut W, path: String) {
    let r = w.root();
    write(&r, &path, "unrelated");
}

#[given(expr = "the server is unreachable for {string}")]
fn unreachable(w: &mut W, path: String) {
    w.fake.broken.push(W::url(&path));
}

#[given(expr = "the source {string} serves wrong bytes for {string}")]
fn wrong_bytes(w: &mut W, _id: String, path: String) {
    w.fake.served.insert(W::url(&path), b"garbage".to_vec());
}

#[when("I list the sources")]
fn list(w: &mut W) {
    w.listed = list_sources();
}

#[when("I check the status")]
fn check(w: &mut W) {
    let r = w.root();
    w.statuses = status(w.src(), &r);
}

#[given("I fetch the source")]
#[when("I fetch the source")]
fn do_fetch(w: &mut W) {
    let r = w.root();
    w.fake.calls.set(0);
    let mut events = vec![];
    let report = fetch(w.src(), &r, &w.fake, &mut |p| events.push(p));
    w.events = events;
    w.report = Some(report);
}

#[when("I remove the source")]
fn do_remove(w: &mut W) {
    let r = w.root();
    remove(w.src(), &r).unwrap();
}

#[then(expr = "the catalog has source {string} with {int} files")]
fn catalog_has(w: &mut W, id: String, n: usize) {
    let s = w.listed.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("no source {id}"));
    assert_eq!(s.files.len(), n);
}

#[then(expr = "the catalog has {int} sources")]
fn catalog_count(w: &mut W, n: usize) {
    assert_eq!(w.listed.len(), n);
}

#[then(expr = "the status of {string} is {word}")]
fn status_is(w: &mut W, path: String, want: String) {
    let got = w.statuses.iter().find(|(p, _)| *p == path).expect("path in status").1;
    let want = match want.as_str() {
        "missing" => FileState::Missing,
        "present" => FileState::Present,
        "corrupt" => FileState::Corrupt,
        o => panic!("unknown state {o}"),
    };
    assert_eq!(got, want);
}

#[then(expr = "the file {string} exists with content {string}")]
fn exists_with(w: &mut W, path: String, content: String) {
    let r = w.root();
    assert_eq!(fs::read_to_string(r.join(path)).unwrap(), content);
}

#[then(expr = "the file {string} does not exist")]
fn not_exists(w: &mut W, path: String) {
    let r = w.root();
    assert!(!r.join(path).exists());
}

#[then(expr = "nothing exists under {string}")]
fn nothing_under(w: &mut W, dir: String) {
    let r = w.root();
    let mut v = vec![];
    if r.join(&dir).exists() {
        all_files(&r.join(&dir), &mut v);
    }
    assert!(v.is_empty(), "leftover: {v:?}");
    assert!(!r.join(&dir).join(".extract").exists());
}

#[then("no staging directory remains")]
fn no_staging(w: &mut W) {
    let r = w.root();
    assert!(!r.join("kit/.extract").exists());
}

#[then(expr = "the source {string} is an archive extracted into {string}")]
fn is_archive(w: &mut W, id: String, into: String) {
    let s = w.listed.iter().find(|s| s.id == id).expect("source");
    let a = s.archive.as_ref().expect("archive");
    assert_eq!((a.into.as_str(), a.format.as_str()), (into.as_str(), "tar.bz2"));
    assert!(a.size > 0 && a.sha256.len() == 64 && a.url.starts_with("https://"));
    assert!(s.files.iter().all(|f| f.fetch == FetchKind::Archive && f.sha256.is_some() && f.size.is_some()));
}

#[then("no partial files remain")]
fn no_part(w: &mut W) {
    let r = w.root();
    let mut v = vec![];
    all_files(&r, &mut v);
    let parts: Vec<_> = v.iter().filter(|p| p.extension().is_some_and(|e| e == "part")).collect();
    assert!(parts.is_empty(), "leftover: {parts:?}");
}

#[then(expr = "{int} files were downloaded")]
fn downloaded(w: &mut W, n: usize) {
    assert_eq!(w.fake.calls.get(), n);
}

#[then("the fetch succeeds")]
fn fetch_ok(w: &mut W) {
    assert!(w.report.as_ref().unwrap().ok());
}

#[then("the fetch fails")]
fn fetch_fails(w: &mut W) {
    assert!(!w.report.as_ref().unwrap().ok());
}

#[then(expr = "the report lists {string} as {word}")]
fn report_lists(w: &mut W, path: String, kind: String) {
    let r = w.report.as_ref().unwrap().files.iter().find(|f| f.path == path).expect("in report");
    let got = match r.outcome {
        Outcome::Downloaded => "downloaded",
        Outcome::Skipped => "skipped",
        Outcome::Manual => "manual",
        Outcome::Failed(_) => "failed",
    };
    assert_eq!(got, kind);
}

#[then(expr = "the report records a sha256 for {string}")]
fn report_sha(w: &mut W, path: String) {
    let root = w.root();
    let r = w.report.as_ref().unwrap().files.iter().find(|f| f.path == path).unwrap();
    let want = digest(&fs::read(root.join(&path)).unwrap());
    assert_eq!(r.sha256.as_deref(), Some(want.as_str()));
}

fn kind_of(p: &Progress) -> (&'static str, &str) {
    match p {
        Progress::Started { path } => ("started", path),
        Progress::Bytes { path, .. } => ("bytes", path),
        Progress::Finished { path, .. } => ("finished", path),
        Progress::Skipped { path } => ("skipped", path),
        Progress::Manual { path } => ("manual", path),
        Progress::Extracting { path } => ("extracting", path),
        Progress::Failed { path, .. } => ("failed", path),
    }
}

#[then(expr = "the progress events include {word} for {string}")]
fn events_include(w: &mut W, kind: String, path: String) {
    assert!(w.events.iter().any(|e| kind_of(e) == (kind.as_str(), path.as_str())), "{:?}", w.events);
}

#[then(expr = "the first progress event for {string} is {word}")]
fn first_event(w: &mut W, path: String, kind: String) {
    let first = w.events.iter().find(|e| kind_of(e).1 == path).expect("an event");
    assert_eq!(kind_of(first).0, kind);
}

fn main() {
    let features = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../features/sources");
    futures::executor::block_on(W::cucumber().fail_on_skipped().run_and_exit(features));
}
