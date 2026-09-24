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
}

impl std::fmt::Debug for W {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("W")
    }
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
        files,
    });
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
