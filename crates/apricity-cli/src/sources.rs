//! `apricity sources`: list, check, download and remove predefined sources.

use apricity_sources::{FetchKind, FileState, Fetcher, Outcome, Progress, Source};
use clap::Subcommand;
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

#[derive(Subcommand)]
pub enum Action {
    /// List the available sources.
    List,
    /// Show which files are missing, present or corrupt.
    Status { id: Option<String> },
    /// Download a source (or all of them) into the samples directory.
    Fetch {
        id: Option<String>,
        #[arg(long)]
        all: bool,
    },
    /// Delete one source's files.
    Remove { id: String },
}

pub fn main(action: &Action, samples: &Path) -> ExitCode {
    let mut out = std::io::stdout();
    match run(action, samples, &apricity_sources::http::HttpFetcher::new(), &mut out) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("apricity: {e}");
            ExitCode::FAILURE
        }
    }
}

fn pick(id: &str) -> Result<Source, String> {
    let all = apricity_sources::list_sources();
    let known: Vec<String> = all.iter().map(|s| s.id.clone()).collect();
    all.into_iter().find(|s| s.id == id).ok_or_else(|| format!("unknown source '{id}' (known: {})", known.join(", ")))
}

fn select(id: &Option<String>, all: bool) -> Result<Vec<Source>, String> {
    match (id, all) {
        (Some(id), false) => Ok(vec![pick(id)?]),
        (None, true) => Ok(apricity_sources::list_sources()),
        (None, false) => Err("give a source id or --all".into()),
        (Some(_), true) => Err("give a source id or --all, not both".into()),
    }
}

/// Returns Ok(false) when the command ran but some file failed.
pub fn run(action: &Action, samples: &Path, fetcher: &dyn Fetcher, out: &mut dyn Write) -> Result<bool, String> {
    let e = |e: std::io::Error| e.to_string();
    match action {
        Action::List => {
            for s in apricity_sources::list_sources() {
                let manual = s.files.iter().filter(|f| f.fetch == FetchKind::Manual).count();
                let mut note = if manual > 0 { format!(", {manual} manual") } else { String::new() };
                if let Some(a) = &s.archive {
                    note.push_str(&format!(", one {} archive ({} MiB)", a.format, a.size >> 20));
                }
                writeln!(out, "{}  {} files{}  {}", s.id, s.files.len(), note, s.title).map_err(e)?;
            }
            Ok(true)
        }
        Action::Status { id } => {
            let sources = match id {
                Some(id) => vec![pick(id)?],
                None => apricity_sources::list_sources(),
            };
            for s in sources {
                writeln!(out, "{}", s.id).map_err(e)?;
                for (path, st) in apricity_sources::status(&s, samples) {
                    let word = match st {
                        FileState::Missing => "missing",
                        FileState::Present => "present",
                        FileState::Corrupt => "corrupt",
                    };
                    writeln!(out, "  {word:8} {path}").map_err(e)?;
                }
            }
            Ok(true)
        }
        Action::Fetch { id, all } => {
            let mut ok = true;
            for s in select(id, *all)? {
                writeln!(out, "{}: {} files", s.id, s.files.len()).map_err(e)?;
                let mut last_pct = std::collections::HashMap::<String, u64>::new();
                let report = apricity_sources::fetch(&s, samples, fetcher, &mut |p| {
                    let _ = match p {
                        Progress::Started { path } => writeln!(out, "  fetching {path}"),
                        // Print roughly once per MiB so long downloads show life.
                        Progress::Bytes { path, bytes } => {
                            let mb = bytes >> 20;
                            if mb > 0 && last_pct.insert(path.clone(), mb) != Some(mb) {
                                writeln!(out, "    {path}: {mb} MiB")
                            } else {
                                Ok(())
                            }
                        }
                        Progress::Finished { path, sha256 } => writeln!(out, "  done     {path} sha256={sha256}"),
                        Progress::Skipped { path } => writeln!(out, "  skipped  {path} (already present)"),
                        Progress::Manual { path } => writeln!(out, "  manual   {path} (download by hand; see {})", s.source_page),
                        Progress::Extracting { path } => writeln!(out, "  extracting {path}"),
                        Progress::Failed { path, error } => writeln!(out, "  FAILED   {path}: {error}"),
                    };
                });
                writeln!(
                    out,
                    "{}: {} downloaded, {} skipped, {} manual, {} failed",
                    s.id,
                    report.downloaded(),
                    report.skipped(),
                    report.manual(),
                    report.failed()
                )
                .map_err(e)?;
                if report.files.iter().any(|f| matches!(f.outcome, Outcome::Failed(_))) {
                    ok = false;
                }
            }
            Ok(ok)
        }
        Action::Remove { id } => {
            let s = pick(id)?;
            let n = apricity_sources::remove(&s, samples).map_err(e)?;
            writeln!(out, "{}: removed {n} files", s.id).map_err(e)?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apricity_sources::FetchError;

    struct Never;
    impl Fetcher for Never {
        fn get(&self, _: &str, _: &mut dyn Write) -> Result<(), FetchError> {
            panic!("tests never touch the network")
        }
    }

    fn go(a: Action, dir: &Path) -> (Result<bool, String>, String) {
        let mut buf = vec![];
        let r = run(&a, dir, &Never, &mut buf);
        (r, String::from_utf8(buf).unwrap())
    }

    #[test]
    fn list_shows_every_source() {
        let d = tempfile::tempdir().unwrap();
        let (r, out) = go(Action::List, d.path());
        assert_eq!(r, Ok(true));
        for id in ["loc-edison", "loc-jukebox-classical", "loc-jukebox-popular", "loc-tony-schwartz", "marine-band", "salamander-drumkit"] {
            assert!(out.contains(id), "{out}");
        }
    }

    #[test]
    fn status_of_empty_dir_is_all_missing_and_remove_only_touches_the_source() {
        let d = tempfile::tempdir().unwrap();
        let (r, out) = go(Action::Status { id: Some("loc-tony-schwartz".into()) }, d.path());
        assert_eq!(r, Ok(true));
        assert_eq!(out.matches("missing").count(), 6, "{out}");

        let s = pick("loc-tony-schwartz").unwrap();
        let mine = d.path().join(&s.files[0].path);
        std::fs::create_dir_all(mine.parent().unwrap()).unwrap();
        std::fs::write(&mine, b"x").unwrap();
        let keep = d.path().join("other.wav");
        std::fs::write(&keep, b"y").unwrap();
        let (_, out) = go(Action::Status { id: Some("loc-tony-schwartz".into()) }, d.path());
        assert!(out.contains("corrupt"), "{out}"); // a 1-byte stand-in fails the pinned size/sha256
        let (r, out) = go(Action::Remove { id: "loc-tony-schwartz".into() }, d.path());
        assert_eq!(r, Ok(true));
        assert!(out.contains("removed 1 files"), "{out}");
        assert!(!mine.exists() && keep.exists());
    }

    #[test]
    fn unknown_id_and_missing_target_are_errors() {
        let d = tempfile::tempdir().unwrap();
        assert!(go(Action::Remove { id: "nope".into() }, d.path()).0.unwrap_err().contains("unknown source"));
        assert!(go(Action::Fetch { id: None, all: false }, d.path()).0.is_err());
    }

    #[test]
    fn fetching_only_manual_files_never_hits_the_network() {
        let d = tempfile::tempdir().unwrap();
        let (r, out) = go(Action::Fetch { id: Some("marine-band".into()), all: false }, d.path());
        assert_eq!(r, Ok(true));
        assert!(out.contains("15 manual"), "{out}");
    }
}
