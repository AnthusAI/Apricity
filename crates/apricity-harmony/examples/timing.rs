//! Timing harness for spec-harmony-v2.md sec 2.7/6's target: an 8-bar, 6-stem window analysed
//! in <= 3s on this Mac. Not a test (it reads real render output from a path, not a fixture);
//! run with `cargo run -p apricity-harmony --example timing -- <stems dir>`.
//!
//! This crate's dev profile is overridden to `opt-level = 3` (workspace `Cargo.toml`) so this
//! runs at a realistic speed without a `--release` build (the CLI rules forbid a release build
//! here, since that binary is shared with other tools).

use apricity_harmony::notes::{build_templates, fold_to_semitones, median_activation, nnls_activations};
use apricity_harmony::{cents_offset_from_cqt, cqt};
use std::time::Instant;

fn load_mono_f64_resampled(path: &std::path::Path, target_sr: f64) -> Vec<f64> {
    let mut reader = hound::WavReader::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let spec = reader.spec();
    let samples: Vec<f64> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap() as f64).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f64;
            reader.samples::<i32>().map(|s| s.unwrap() as f64 / max).collect()
        }
    };
    let mono: Vec<f64> = if spec.channels > 1 {
        samples.chunks(spec.channels as usize).map(|c| c.iter().sum::<f64>() / c.len() as f64).collect()
    } else {
        samples
    };
    // Simple linear-interpolation resample (this harness times the CQT/NNLS, not resampling
    // quality; the crate's `apricity-dsp::resample` is the production path per the design).
    let src_sr = spec.sample_rate as f64;
    let ratio = target_sr / src_sr;
    let out_len = (mono.len() as f64 * ratio) as usize;
    (0..out_len)
        .map(|i| {
            let s = i as f64 / ratio;
            let i0 = s.floor() as usize;
            let frac = s - i0 as f64;
            let a = mono.get(i0).copied().unwrap_or(0.0);
            let b = mono.get(i0 + 1).copied().unwrap_or(a);
            a + frac * (b - a)
        })
        .collect()
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "/tmp/emerge-render8".to_string());
    let dir = std::path::PathBuf::from(dir);
    let stems_json = std::fs::read_to_string(dir.join("stems.json")).expect("stems.json");
    let meta: serde_json::Value = serde_json::from_str(&stems_json).unwrap();
    let tracks: Vec<String> = meta["tracks"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    // What the design (sec 2.3) actually sends through CQT/NNLS: pitched, non-kit tracks whose
    // `pitch` is unset (a `pitch` means a pinned/heard single-note track -- ground truth from
    // the timeline, not re-analysed). Everything else (kits, one-shots) is excluded.
    let analyzed: std::collections::HashSet<&str> = meta["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["pitched"].as_bool().unwrap_or(false) && t["kit"].is_null() && t["pitch"].is_null())
        .map(|t| t["name"].as_str().unwrap())
        .collect();

    println!("apricity-harmony timing: {} ({} stems, {} would actually be CQT-analysed: {:?})", dir.display(), tracks.len(), analyzed.len(), analyzed);
    let templates = build_templates();
    let mut analyzed_total = std::time::Duration::ZERO;
    let t_total = Instant::now();
    for name in &tracks {
        let wav = dir.join(format!("{name}.wav"));
        if !wav.exists() {
            println!("  {name}: no WAV (kit pad?), skipped");
            continue;
        }
        let t0 = Instant::now();
        let y = load_mono_f64_resampled(&wav, apricity_harmony::cqt::SR);
        let t_load = t0.elapsed();

        let t1 = Instant::now();
        let (c, _n_fft) = cqt(&y, 0.0);
        let t_cqt = t1.elapsed();

        let t2 = Instant::now();
        let cents = cents_offset_from_cqt(&c);
        let t_cents = t2.elapsed();

        let t3 = Instant::now();
        let folded = fold_to_semitones(&c);
        let activations = nnls_activations(&folded, &templates);
        let _ = median_activation(&activations);
        let t_nnls = t3.elapsed();

        let track_total = t_load + t_cqt + t_cents + t_nnls;
        if analyzed.contains(name.as_str()) {
            analyzed_total += track_total;
        }
        println!(
            "  {name:14} {:.2}s audio: load {:6.1}ms  cqt {:7.1}ms  cents {:5.1}ms  nnls {:7.1}ms  (cents={cents:+.1}){}",
            y.len() as f64 / apricity_harmony::cqt::SR,
            t_load.as_secs_f64() * 1000.0,
            t_cqt.as_secs_f64() * 1000.0,
            t_cents.as_secs_f64() * 1000.0,
            t_nnls.as_secs_f64() * 1000.0,
            if analyzed.contains(name.as_str()) { "  <- actually analysed" } else { "" }
        );
    }
    let total = t_total.elapsed();
    println!("TOTAL (every stem, worst case): {:.3}s for {} stems", total.as_secs_f64(), tracks.len());
    println!("TOTAL (design's actual filter -- pitched, non-kit, no pinned pitch): {:.3}s for {} stems", analyzed_total.as_secs_f64(), analyzed.len());
}
