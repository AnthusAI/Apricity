//! `apricity sync` driven as a user would, with a folder as the remote.

use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use tempfile::TempDir;

const APRICITY: &str = env!("CARGO_BIN_EXE_apricity");

fn sync(action: &str, lib: &Path, remote: &Path, extra: &[&str]) -> Output {
    Command::new(APRICITY)
        .args(["sync", action, "--library"])
        .arg(lib)
        .arg("--remote-dir")
        .arg(remote)
        .args(extra)
        .output()
        .unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn make_library(dir: &Path) {
    let out = Command::new(APRICITY)
        .args(["migrate", "--from"])
        .arg(dir.join("empty-repo"))
        .arg("--to")
        .arg(dir.join("lib"))
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    fs::write(dir.join("lib/files/note.txt"), "hello").unwrap();
}

#[test]
fn push_status_pull_and_conflict_round_trip() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("empty-repo")).unwrap();
    make_library(tmp.path());
    let (lib, remote, lib2) = (
        tmp.path().join("lib"),
        tmp.path().join("remote"),
        tmp.path().join("lib2"),
    );

    let out = sync("status", &lib, &remote, &[]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("push"), "{}", text(&out.stdout));
    assert!(
        !remote.exists(),
        "status transfers nothing and creates nothing"
    );
    assert!(!lib.join(".apricity-sync.json").exists());

    let out = sync("push", &lib, &remote, &["--dry-run"]);
    assert!(out.status.success());
    assert!(!remote.exists());

    let out = sync("push", &lib, &remote, &[]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(fs::read(remote.join("files/note.txt")).unwrap(), b"hello");
    assert!(!remote.join("apricity-library.json").exists());
    assert!(!remote.join(".apricity-sync.json").exists());
    assert!(lib.join(".apricity-sync.json").exists());
    assert!(text(&sync("push", &lib, &remote, &[]).stdout).contains("0 pushed"));

    let out = sync("pull", &lib2, &remote, &[]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(fs::read(lib2.join("files/note.txt")).unwrap(), b"hello");
    assert!(
        lib2.join("apricity-library.json").exists(),
        "pull created a library"
    );

    fs::write(lib.join("files/note.txt"), "local").unwrap();
    fs::write(remote.join("files/note.txt"), "remote").unwrap();
    let out = sync("push", &lib, &remote, &[]);
    assert!(!out.status.success());
    assert!(text(&out.stdout).contains("CONFLICT"));
    assert_eq!(fs::read(lib.join("files/note.txt")).unwrap(), b"local");
    assert_eq!(fs::read(remote.join("files/note.txt")).unwrap(), b"remote");
    let out = sync("push", &lib, &remote, &["--prefer", "local"]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(fs::read(remote.join("files/note.txt")).unwrap(), b"local");
}

#[test]
fn a_folder_that_is_not_a_library_is_refused_and_flags_are_checked() {
    let tmp = TempDir::new().unwrap();
    let not_lib = tmp.path().join("x");
    fs::create_dir_all(&not_lib).unwrap();
    fs::write(not_lib.join("f"), "1").unwrap();
    let out = sync("push", &not_lib, &tmp.path().join("r"), &[]);
    assert!(!out.status.success());
    assert!(text(&out.stderr).contains("not an Apricity library"));
    let out = sync("pull", &not_lib, &tmp.path().join("r"), &[]);
    assert!(
        !out.status.success(),
        "a non-empty non-library folder is not silently turned into one"
    );
    let out = Command::new(APRICITY)
        .args(["sync", "push", "--library"])
        .arg(&not_lib)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(text(&out.stderr).contains("--bucket"));
    let out = Command::new(APRICITY)
        .args([
            "sync",
            "push",
            "--bucket",
            "b",
            "--remote-dir",
            "/tmp/x",
            "--library",
        ])
        .arg(&not_lib)
        .output()
        .unwrap();
    assert!(!out.status.success());
}
