//! `apricity sync push|pull|status`: a library folder and a bucket (or a folder) kept identical.
//! The engine is `apricity_data::sync`; this is argument handling, the choice of remote, and
//! the last-sync state file in the library.

use apricity_data::files::Files;
use apricity_data::s3::S3Files;
use apricity_data::sync::{self, Direction, Options, Prefer, STATE_FILE, State};
use apricity_data::{FsFiles, Library};
use clap::{Args, Subcommand, ValueEnum};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Subcommand)]
pub enum Action {
    /// Upload what changed locally to the remote.
    Push(Common),
    /// Download what changed on the remote into the library (creating it if the folder is new).
    Pull(Common),
    /// Show what a sync would do, transferring nothing.
    Status(Common),
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Side {
    Local,
    Remote,
}

#[derive(Args)]
pub struct Common {
    /// Library folder.
    #[arg(long)]
    pub library: PathBuf,
    /// S3 bucket (an Amplify Storage bucket); the key layout is the library layout.
    #[arg(
        long,
        required_unless_present = "remote_dir",
        conflicts_with = "remote_dir"
    )]
    pub bucket: Option<String>,
    /// Key prefix inside the bucket.
    #[arg(long, requires = "bucket")]
    pub prefix: Option<String>,
    /// AWS region (default: the configured one). Credentials come from the standard AWS chain.
    #[arg(long, requires = "bucket")]
    pub region: Option<String>,
    /// Use a folder as the remote instead of a bucket.
    #[arg(long)]
    pub remote_dir: Option<PathBuf>,
    /// Print the plan and transfer nothing.
    #[arg(long)]
    pub dry_run: bool,
    /// Also delete files that were deleted on the other side (never done by default).
    #[arg(long)]
    pub delete: bool,
    /// Resolve conflicts (changed on both sides) in favour of one side.
    #[arg(long, value_enum)]
    pub prefer: Option<Side>,
}

fn open_remote(c: &Common, create: bool) -> Result<(Box<dyn Files>, String), String> {
    if let Some(dir) = &c.remote_dir {
        if create {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        // Absolute but not resolved, and valid before the folder exists (status of a new remote).
        let abs = std::path::absolute(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        return Ok((
            Box::new(FsFiles::new(&abs)),
            format!("dir:{}", abs.display()),
        ));
    }
    let bucket = c.bucket.as_deref().unwrap_or_default();
    let s3 = S3Files::connect(bucket, c.prefix.as_deref(), c.region.as_deref())
        .map_err(|e| e.to_string())?;
    let id = s3.id();
    Ok((Box::new(s3), id))
}

/// A pull may create the library; everything else needs one.
fn ensure_library(dir: &Path, may_create: bool) -> Result<(), String> {
    if dir.join("apricity-library.json").is_file() {
        return Ok(());
    }
    let empty = std::fs::read_dir(dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true);
    if may_create && empty {
        Library::create(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        println!("created library {}", dir.display());
        return Ok(());
    }
    Err(format!(
        "{} is not an Apricity library (no apricity-library.json)",
        dir.display()
    ))
}

pub fn run(action: Action) -> Result<ExitCode, String> {
    let (c, direction, status_only) = match &action {
        Action::Push(c) => (c, Direction::Push, false),
        Action::Pull(c) => (c, Direction::Pull, false),
        Action::Status(c) => (c, Direction::Both, true),
    };
    let dry = c.dry_run || status_only;
    ensure_library(&c.library, matches!(action, Action::Pull(_)) && !dry)?;
    let (mut remote, remote_id) = open_remote(c, matches!(action, Action::Push(_)) && !dry)?;
    let mut local = FsFiles::new(&c.library);
    let state_path = c.library.join(STATE_FILE);
    let mut state = State::load(&state_path).map_err(|e| e.to_string())?;
    let opts = Options {
        direction,
        delete: c.delete,
        prefer: c.prefer.map(|s| match s {
            Side::Local => Prefer::Local,
            Side::Remote => Prefer::Remote,
        }),
    };
    println!("library {} <-> {remote_id}", c.library.display());
    let report = sync::run(
        &mut local,
        remote.as_mut(),
        &c.library.join(".sync-tmp"),
        &mut state,
        &remote_id,
        &opts,
        dry,
    )
    .map_err(|e| e.to_string())?;
    if !dry {
        state.save(&state_path).map_err(|e| e.to_string())?;
    }
    print!("{}", report.display());
    if report.needs_attention() {
        eprintln!(
            "{} conflict(s), {} failure(s): nothing in conflict was overwritten (use --prefer local|remote to choose)",
            report.plan.conflicts.len(),
            report.failed.len()
        );
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}
