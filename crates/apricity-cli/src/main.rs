//! `apricity`: compile, explain and render Apricity scores.

mod migrate;
mod play;
mod render;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "apricity", version, about = "Declarative, harmony-aware sample music")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Validate a score and print its compiled timeline as JSON.
    Compile {
        score: PathBuf,
        /// Write to a file instead of stdout.
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Show how each clip was warped and transposed for each chord, and why.
    Explain { score: PathBuf },
    /// Play a score live; saving the file swaps changes in at the next bar.
    Play {
        score: PathBuf,
        /// Run the engine against a silent clock instead of the sound card.
        #[arg(long)]
        no_audio: bool,
        /// Stop after this many seconds.
        #[arg(long)]
        seconds: Option<f64>,
        /// Output level in dB, e.g. -6.
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        volume: f32,
    },
    /// Convert a score between YAML and the Apricity text language (.apr).
    Fmt {
        score: PathBuf,
        /// Output format; defaults to the other one.
        #[arg(long, value_parser = ["apr", "yaml"])]
        to: Option<String>,
        /// Write here instead of stdout.
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Render a score to a 48 kHz stereo WAV.
    Render {
        score: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
        /// Only these bars, 1-based inclusive, e.g. "1-4".
        #[arg(long)]
        bars: Option<String>,
        /// Take clips from this library instead of the sample files; clip paths in the score
        /// are resolved relative to the current directory, as with files.
        #[arg(long)]
        library: Option<PathBuf>,
    },
    /// Import a repository's samples, manifests, candidates and scores into a library.
    Migrate {
        /// Repository root (holds samples/, library/, examples/).
        #[arg(long)]
        from: PathBuf,
        /// Library folder; created if missing, updated in place otherwise.
        #[arg(long)]
        to: PathBuf,
        /// Hard-link audio into the library instead of copying it.
        #[arg(long)]
        link: bool,
    },
}

/// Compile a score with its clips taken from a library.
fn compile_from_library(score: &std::path::Path, library: &std::path::Path) -> Result<apricity_score::Timeline, Vec<String>> {
    let text = std::fs::read_to_string(score).map_err(|e| vec![format!("{}: {e}", score.display())])?;
    let mut lib = apricity_data::Library::open(library, None).map_err(|e| vec![format!("{}: {e}", library.display())])?;
    let mut loader = apricity_data::loader::make(&mut lib, std::path::Path::new(".")).map_err(|e| vec![e])?;
    apricity_score::compile_text(&text, score, &mut loader)
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Cmd::Play { score, no_audio, seconds, volume } = cli.cmd {
        return match play::run(play::Options { score, no_audio, seconds, volume_db: volume }) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }
    if let Cmd::Migrate { from, to, link } = &cli.cmd {
        return match migrate::run(migrate::Options { from: from.clone(), to: to.clone(), link: *link }) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }
    if let Cmd::Fmt { score, to, out } = &cli.cmd {
        let text = match std::fs::read_to_string(score) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("{}: {e}", score.display());
                return ExitCode::FAILURE;
            }
        };
        let parsed = match apricity_score::parse_score(&text, score) {
            Ok((s, _)) => s,
            Err(errors) => {
                errors.iter().for_each(|e| eprintln!("  ✗ {e}"));
                return ExitCode::FAILURE;
            }
        };
        let is_apr = score.extension().is_some_and(|e| e == "apr");
        let to_apr = to.as_deref().map_or(!is_apr, |t| t == "apr");
        let body = if to_apr { apricity_score::dsl::format(&parsed) } else { serde_yaml::to_string(&parsed).unwrap() };
        match out {
            Some(p) => {
                if let Err(e) = std::fs::write(p, body) {
                    eprintln!("{}: {e}", p.display());
                    return ExitCode::FAILURE;
                }
                eprintln!("wrote {}", p.display());
            }
            None => print!("{body}"),
        }
        return ExitCode::SUCCESS;
    }
    let score = match &cli.cmd {
        Cmd::Play { .. } | Cmd::Fmt { .. } | Cmd::Migrate { .. } => unreachable!(),
        Cmd::Compile { score, .. } | Cmd::Explain { score } | Cmd::Render { score, .. } => score,
    };
    let compiled = match &cli.cmd {
        Cmd::Render { library: Some(library), .. } => compile_from_library(score, library),
        _ => apricity_score::compile_file(score),
    };
    let tl = match compiled {
        Ok(tl) => tl,
        Err(errors) => {
            eprintln!("{} has {} problem{}:", score.display(), errors.len(), if errors.len() == 1 { "" } else { "s" });
            for e in errors {
                eprintln!("  ✗ {e}");
            }
            return ExitCode::FAILURE;
        }
    };
    match cli.cmd {
        Cmd::Play { .. } | Cmd::Fmt { .. } | Cmd::Migrate { .. } => unreachable!(),
        Cmd::Compile { out, .. } => {
            let json = serde_json::to_string_pretty(&tl).unwrap();
            match out {
                Some(p) => std::fs::write(&p, json).map(|_| eprintln!("wrote {}", p.display())).unwrap_or_else(|e| eprintln!("{e}")),
                None => println!("{json}"),
            }
        }
        Cmd::Explain { .. } => print!("{}", tl.explain()),
        Cmd::Render { out, bars, .. } => {
            let range = match bars.as_deref().map(|b| apricity_score::score::parse_bars(b, tl.meter)) {
                None => None,
                Some(Ok(r)) => Some(r),
                Some(Err(e)) => {
                    eprintln!("  ✗ --{e}");
                    return ExitCode::FAILURE;
                }
            };
            for w in &tl.warnings {
                eprintln!("  ! {w}");
            }
            let t0 = std::time::Instant::now();
            match render::render(&tl, range) {
                Ok(r) => {
                    if let Err(e) = render::write_wav(&out, &r.mix) {
                        eprintln!("  ✗ {e}");
                        return ExitCode::FAILURE;
                    }
                    let secs = r.mix[0].len() as f64 / render::OUT_SR as f64;
                    eprintln!("wrote {} ({secs:.1} s) — {} unique events rendered in {:.1} s", out.display(), r.unique_events, t0.elapsed().as_secs_f64());
                    eprintln!("  mix: {:.1} LUFS, peak {:.1} dBFS ({} stem{}, master make-up {:+.1} dB)",
                        r.lufs, r.peak_db, r.stems, if r.stems == 1 { "" } else { "s" }, r.makeup_db);
                    for line in &r.report {
                        eprintln!("    {line}");
                    }
                }
                Err(e) => {
                    eprintln!("  ✗ {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
    }
    ExitCode::SUCCESS
}
