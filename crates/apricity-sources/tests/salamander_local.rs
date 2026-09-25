//! End-to-end check of the real catalog entry against a local copy of the archive (no network).
//! Set APRICITY_SALAMANDER_TARBALL to the verified salamanderDrumkit.tar.bz2; otherwise this is skipped.

use apricity_sources::*;
use std::io::Write;

struct Local(std::path::PathBuf);
impl Fetcher for Local {
    fn get(&self, url: &str, out: &mut dyn Write) -> Result<(), FetchError> {
        assert!(url.contains("SalamanderDrumkit"), "unexpected url {url}");
        std::io::copy(&mut std::fs::File::open(&self.0)?, out)?;
        Ok(())
    }
}

#[test]
fn real_catalog_entry_extracts_from_the_local_archive() {
    let Ok(tarball) = std::env::var("APRICITY_SALAMANDER_TARBALL") else {
        eprintln!("APRICITY_SALAMANDER_TARBALL not set; skipping");
        return;
    };
    let src = list_sources().into_iter().find(|s| s.id == "salamander-drumkit").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let fetcher = Local(tarball.into());
    let r = fetch(&src, dir.path(), &fetcher, &mut |_| {});
    assert!(r.ok() && r.downloaded() == 545, "downloaded {} failed {}", r.downloaded(), r.failed());
    assert!(status(&src, dir.path()).iter().all(|(_, s)| *s == FileState::Present));
    assert!(dir.path().join("salamander-drumkit/OH/kick_OH_FF_1.wav").exists());
    assert!(!dir.path().join("salamander-drumkit/.archive.part").exists());
    let again = fetch(&src, dir.path(), &Local("/nonexistent".into()), &mut |_| {});
    assert_eq!(again.skipped(), 545);
    assert_eq!(remove(&src, dir.path()).unwrap(), 545);
    assert!(!dir.path().join("salamander-drumkit").exists());
}
