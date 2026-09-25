//! `apricity migrate`: import a repository's files into a library (design/storage.md §5).

use std::path::PathBuf;
use std::process::ExitCode;

pub struct Options {
    pub from: PathBuf,
    pub to: PathBuf,
    pub link: bool,
}

pub fn run(opts: Options) -> Result<ExitCode, String> {
    let mut lib = if opts.to.join("apricity-library.json").exists() {
        apricity_data::Library::open(&opts.to, None)
    } else {
        apricity_data::Library::create(&opts.to)
    }
    .map_err(|e| format!("{}: {e}", opts.to.display()))?;
    let library_path = lib.path().to_path_buf();
    let report = apricity_data::migrate(&opts.from, lib.engine_mut(), &library_path, opts.link)
        .map_err(|e| e.to_string())?;
    println!("{}", report.display());
    if !report.unresolved.is_empty() {
        eprintln!(
            "{} unresolved reference{}",
            report.unresolved.len(),
            if report.unresolved.len() == 1 {
                ""
            } else {
                "s"
            }
        );
        return Ok(ExitCode::FAILURE);
    }
    if report.total_changes() == 0 {
        println!("0 changes");
    }
    Ok(ExitCode::SUCCESS)
}
