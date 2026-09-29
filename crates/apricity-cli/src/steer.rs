//! `apricity steer`: the steering report (Kanbus `apricitus-c46688`, Phase 1 Task 6 of Harmony
//! v2, `spec-harmony-v2.md` sec 3). Reads `stems.json` and every pitched, non-kit track's WAV
//! (the same IO `check.rs` does), resamples to `apricity_harmony::SR`, and hands them to
//! `apricity_harmony::steer::report_json`, which runs the CQT/NNLS pipeline and assembles
//! `apricity.steer/1` JSON (`schema/steer.schema.json`). `apricity-web`'s `rw_steer_json` wasm
//! export calls the same shared function on browser-decoded audio, so the CLI and the web UI
//! can't drift apart on what a "steering report" is.

use apricity_harmony::steer::report_json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const TARGET_SR: f64 = apricity_harmony::SR;

pub struct Options {
    pub stems_dir: PathBuf,
    pub against: String, // "written" | "heard"
    pub score: Option<PathBuf>,
    pub out: Option<PathBuf>,
}

// `read_mono_wav`/`resample` are copies of `check.rs`'s (private to each module; the CLI has no
// shared `io` module yet -- a natural follow-up once a third command needs the same pair).
fn read_mono_wav(path: &Path) -> Result<(Vec<f64>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>().map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 / scale)).collect::<Result<_, _>>().map_err(|e| e.to_string())?
        }
    };
    if channels == 0 {
        return Ok((Vec::new(), spec.sample_rate));
    }
    let n = samples.len() / channels;
    let mono: Vec<f64> = (0..n).map(|i| (0..channels).map(|c| samples[i * channels + c] as f64).sum::<f64>() / channels as f64).collect();
    Ok((mono, spec.sample_rate))
}

fn resample(y: &[f64], src_sr: u32) -> Vec<f64> {
    if src_sr as f64 == TARGET_SR {
        return y.to_vec();
    }
    let y32: Vec<f32> = y.iter().map(|&v| v as f32).collect();
    let step = src_sr as f64 / TARGET_SR;
    let out_len = ((y.len() as f64) / step).ceil() as usize;
    apricity_dsp::resample::varispeed(&y32, 0.0, step, out_len).into_iter().map(|v| v as f64).collect()
}

/// `(track, start_beat) -> semitones` for every loop-track event in the compiled score, used to
/// look up the harmony solver's own chosen shift per span (`--score`, sec 3.2: "the map's best
/// differs from the solver's choice"). Empty when `--score` wasn't given; suggestions then
/// compare against a 0-semitone baseline instead (`steer_suggestions`'s own doc comment).
fn solver_shift_lookup(score: &Path) -> Result<BTreeMap<(String, i64), i32>, String> {
    let tl = apricity_score::compile_file(score).map_err(|errs| format!("{}: {}", score.display(), errs.join("; ")))?;
    Ok(tl.events.iter().filter(|e| e.midi.is_none()).map(|e| ((e.track.clone(), e.start_beat as i64), e.semitones)).collect())
}

pub fn run(opts: &Options) -> Result<i32, String> {
    if opts.against != "written" && opts.against != "heard" {
        return Err(format!("--against must be written or heard, not {}", opts.against));
    }
    let solver_shift = opts.score.as_deref().map(solver_shift_lookup).transpose()?.unwrap_or_default();

    let manifest_path = opts.stems_dir.join("stems.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", manifest_path.display()))?;

    let mut stem_samples: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for t in manifest["tracks"].as_array().cloned().unwrap_or_default() {
        let name = t["name"].as_str().unwrap_or_default().to_string();
        let pitched = t["pitched"].as_bool().unwrap_or(true);
        let kit = t["kit"].as_str().is_some();
        if kit || !pitched || name.is_empty() {
            continue;
        }
        let wav_path = opts.stems_dir.join(format!("{name}.wav"));
        if !wav_path.exists() {
            continue;
        }
        let (mono, sr) = read_mono_wav(&wav_path)?;
        stem_samples.insert(name, resample(&mono, sr));
    }

    let mut report = report_json(&manifest, &stem_samples, &opts.against, &solver_shift)?;
    if let Some(obj) = report.as_object_mut() {
        if let Some(render) = obj.get_mut("render").and_then(|v| v.as_object_mut()) {
            render.insert("stems_dir".to_string(), serde_json::Value::String(opts.stems_dir.display().to_string()));
        }
    }

    let text = serde_json::to_string_pretty(&report).unwrap();
    if let Some(out) = &opts.out {
        std::fs::write(out, &text).map_err(|e| format!("{}: {e}", out.display()))?;
    } else {
        println!("{text}");
    }
    Ok(0)
}
