//! `apricity migrate` and `scripts/check-migration.sh`, driven as a user would.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tempfile::TempDir;

const APRICITY: &str = env!("CARGO_BIN_EXE_apricity");

fn migrate(from: &Path, to: &Path) -> Output {
    Command::new(APRICITY)
        .arg("migrate")
        .arg("--from")
        .arg(from)
        .arg("--to")
        .arg(to)
        .arg("--link")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A repo with no samples and one score that names a clip nobody has.
fn repo_with_unresolved_score() -> TempDir {
    let repo = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("examples")).unwrap();
    fs::write(repo.path().join("examples/lost.apr"), "tempo 120\nkey F major\nsamples ../samples\n\nchords I . . . | IV . . .\n\nclip a = marine-band/Missing.wav\n\ntrack a at 1 1\n").unwrap();
    repo
}

#[test]
fn unresolved_reference_exits_non_zero_and_is_listed() {
    let repo = repo_with_unresolved_score();
    let lib = TempDir::new().unwrap();
    let out = migrate(repo.path(), &lib.path().join("lib"));
    assert!(!out.status.success());
    let (stdout, stderr) = (text(&out.stdout), text(&out.stderr));
    assert!(
        stdout.contains("UNRESOLVED: examples/lost.apr: marine-band/Missing.wav"),
        "{stdout}"
    );
    assert!(stderr.contains("1 unresolved reference"), "{stderr}");
}

#[test]
fn second_run_reports_zero_changes_in_the_same_library() {
    let repo = TempDir::new().unwrap();
    fs::create_dir_all(repo.path().join("examples")).unwrap();
    fs::write(
        repo.path().join("examples/plain.apr"),
        "tempo 120\nkey F major\nchords I . . . | IV . . .\n",
    )
    .unwrap();
    let lib = TempDir::new().unwrap();
    let lib = lib.path().join("lib");

    let first = migrate(repo.path(), &lib);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert!(text(&first.stdout).contains("Scores: 1"));
    assert!(!text(&first.stdout).contains("0 changes"));

    let second = migrate(repo.path(), &lib);
    assert!(second.status.success(), "{}", text(&second.stderr));
    let stdout = text(&second.stdout);
    assert!(
        stdout.contains("Scores: 0") && stdout.trim_end().ends_with("0 changes"),
        "{stdout}"
    );
    // The library keeps its identity across runs.
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(lib.join("apricity-library.json")).unwrap())
            .unwrap();
    let again = migrate(repo.path(), &lib);
    assert!(again.status.success());
    let meta_after: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(lib.join("apricity-library.json")).unwrap())
            .unwrap();
    assert_eq!(meta["library_id"], meta_after["library_id"]);
}

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/check-migration.sh")
}

/// A stand-in `apricity` whose library render differs from its file render iff `differ`.
fn stub_apricity(dir: &Path, differ: bool) -> PathBuf {
    let path = dir.join("apricity");
    let body = format!(
        r#"#!/bin/bash
case "$1" in
  migrate) mkdir -p "$5"; echo "Migration report (stub)";;
  render)
    out=""; lib=0
    while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift;; --library) lib=1; shift;; esac; shift; done
    if [ "$lib" = 1 ] && [ "{differ}" = true ]; then echo library > "$out"; else echo files > "$out"; fi;;
esac
"#
    );
    fs::write(&path, body).unwrap();
    std::process::Command::new("chmod")
        .arg("+x")
        .arg(&path)
        .status()
        .unwrap();
    path
}

fn run_script(differ: bool) -> Output {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("examples")).unwrap();
    fs::write(dir.path().join("examples/a.apr"), "").unwrap();
    fs::write(dir.path().join("examples/a.yaml"), "").unwrap();
    let stub = stub_apricity(dir.path(), differ);
    Command::new("bash")
        .arg(script())
        .arg("--repo")
        .arg(dir.path())
        .env("APRICITY", stub)
        .output()
        .unwrap()
}

/// Regression: the script's `! cd repo && render` never ran the from-files render, so every
/// example looked different. It must pass when the WAVs match, fail when they differ, and treat
/// `a.apr` and `a.yaml` as separate examples.
#[test]
fn check_script_compares_the_wavs() {
    let same = run_script(false);
    let stdout = text(&same.stdout);
    assert!(same.status.success(), "{stdout}{}", text(&same.stderr));
    assert!(
        stdout.contains("identical  a.apr")
            && stdout.contains("identical  a.yaml")
            && stdout.contains("2 identical, 0 failed"),
        "{stdout}"
    );

    let differ = run_script(true);
    let stdout = text(&differ.stdout);
    assert!(!differ.status.success(), "{stdout}");
    assert!(
        stdout.contains("FAILED  a.apr: WAVs differ") && stdout.contains("0 identical, 2 failed"),
        "{stdout}"
    );
}
