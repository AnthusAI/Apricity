//! `apricity check`: the Harmony v2 objective (v1 and v2) for a `--stems` render, in Rust --
//! `apricity-harmony`'s chord recognition, `Q` and `objective_v2` (Kanbus `apricitus-d401a2`,
//! Task 5 of Harmony v2 Phase 1). Reads `stems.json` and every pitched, non-kit track's WAV,
//! runs the CQT/NNLS pipeline per stem, and reports the same per-span/window objective the Python
//! reference (`analysis/apricity_analyze/harmony2_ref.py`) computes.
//!
//! This is NOT a wrapper for `scripts/check-stems.py`: that script's `v1` objective comes from
//! Essentia's HPCP, a different, independent chroma estimate from this crate's CQT-folded chroma
//! (a documented deviation -- `spec-harmony-v2.md` sec 2.7). The two `v1` numbers are therefore
//! not expected to match, and this command does not attempt to reproduce `check-stems.py`'s
//! output; it stands alongside it.

use apricity_harmony::{
    beat_aggregate, cqt,
    cqt::HOP,
    fold_to_semitones,
    notes::{build_templates, nnls_activations},
    objective_v2_for_span, window_objective, PITCH_NAMES,
};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

const TARGET_SR: f64 = apricity_harmony::SR;

pub struct Options {
    pub stems_dir: PathBuf,
    pub json: bool,
    pub baseline: Option<PathBuf>,
    pub allow_mute: Vec<String>,
    pub log: Option<PathBuf>,
}

struct Track {
    name: String,
    pitched: bool,
    kit: Option<String>,
}

/// Reads a stereo (or mono) 32-bit-float WAV and returns a mono `f64` buffer at the file's own
/// sample rate. `render_stems` (`render.rs`) always writes float stems, so this doesn't handle
/// integer PCM.
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

/// Resamples `y` (at `src_sr`) to `TARGET_SR` with `apricity_dsp::resample::varispeed`.
fn resample(y: &[f64], src_sr: u32) -> Vec<f64> {
    if src_sr as f64 == TARGET_SR {
        return y.to_vec();
    }
    let y32: Vec<f32> = y.iter().map(|&v| v as f32).collect();
    let step = src_sr as f64 / TARGET_SR;
    let out_len = ((y.len() as f64) / step).ceil() as usize;
    apricity_dsp::resample::varispeed(&y32, 0.0, step, out_len).into_iter().map(|v| v as f64).collect()
}

fn pitch_name_pc(name: &str) -> Option<usize> {
    PITCH_NAMES.iter().position(|&n| n == name)
}

pub fn run(opts: &Options) -> Result<i32, String> {
    let manifest_path = opts.stems_dir.join("stems.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| format!("{}: {e}", manifest_path.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", manifest_path.display()))?;

    let tempo = manifest["tempo"].as_f64().ok_or("stems.json: missing tempo")?;
    let sample_rate = manifest["sample_rate"].as_f64().ok_or("stems.json: missing sample_rate")?;
    let offset_beats = manifest["offset_beats"].as_f64().unwrap_or(0.0);
    let length = manifest["length"].as_u64().unwrap_or(0);
    let spb_frames = sample_rate * 60.0 / tempo;
    let n_beats = ((length as f64 / spb_frames).ceil() as usize).max(1);

    let tracks: Vec<Track> = manifest["tracks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|t| Track {
            name: t["name"].as_str().unwrap_or_default().to_string(),
            pitched: t["pitched"].as_bool().unwrap_or(true),
            kit: t["kit"].as_str().map(|s| s.to_string()),
        })
        .collect();

    let templates = build_templates();

    // Per stem: `(n_beats, N_SEMITONES)` beat-aggregated activation.
    let mut stem_beat_activation: HashMap<String, Vec<Vec<f64>>> = HashMap::new();
    for t in &tracks {
        if t.kit.is_some() || !t.pitched {
            continue;
        }
        let wav_path = opts.stems_dir.join(format!("{}.wav", t.name));
        if !wav_path.exists() {
            continue;
        }
        let (mono, sr) = read_mono_wav(&wav_path)?;
        let mono = resample(&mono, sr);
        let (c, _n_fft) = cqt(&mono, 0.0);
        let folded = fold_to_semitones(&c);
        let activations = nnls_activations(&folded, &templates);
        let n_frames = activations.first().map_or(0, |r| r.len());
        let frame_times = apricity_harmony::frame_times(n_frames, HOP, TARGET_SR);
        let beats = beat_aggregate(&activations, &frame_times, tempo, 0.0, n_beats);
        stem_beat_activation.insert(t.name.clone(), beats);
    }

    let mut events_by_track: HashMap<String, Vec<(f64, f64, i64)>> = HashMap::new();
    if let Some(events) = manifest["events"].as_array() {
        for e in events {
            let track = e["track"].as_str().unwrap_or_default().to_string();
            let start = e["start_beat"].as_f64().unwrap_or(0.0);
            let end = e["end_beat"].as_f64().unwrap_or(0.0);
            let midi = e["midi"].as_i64().unwrap_or(0);
            events_by_track.entry(track).or_default().push((start, end, midi));
        }
    }
    let mut span_results = Vec::new();
    let mut span_mass = Vec::new();
    let mut prev_notes: Option<Vec<i32>> = None;

    for span in manifest["harmony"].as_array().cloned().unwrap_or_default() {
        let start_beat = span["start_beat"].as_f64().unwrap_or(0.0);
        let end_beat = span["end_beat"].as_f64().unwrap_or(0.0);
        let a = ((start_beat - offset_beats).round() as i64).max(0) as usize;
        let b = (((end_beat - offset_beats).round() as i64).max(0) as usize).min(n_beats);
        if b <= a {
            continue;
        }
        let chord_tones_ordered: Vec<usize> = span["chord_tones"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str()).filter_map(pitch_name_pc).collect();
        let chord_tones_pc: BTreeSet<usize> = chord_tones_ordered.iter().copied().collect();
        let written_root_pc = chord_tones_ordered.first().copied();
        let written_quality = written_root_pc.and_then(|r| apricity_harmony::written_quality_from_tones(r, &chord_tones_ordered));
        let written_bass_pc = span["bass"].as_str().and_then(pitch_name_pc);

        let stem_span_beats: HashMap<String, Vec<Vec<f64>>> = stem_beat_activation.iter().map(|(name, beats)| (name.clone(), beats[a..b].to_vec())).collect();
        let stem_activations: HashMap<String, Vec<f64>> = stem_span_beats
            .iter()
            .map(|(name, beats)| {
                let mut sum = vec![0.0f64; apricity_harmony::N_SEMITONES];
                for beat in beats {
                    for (i, &x) in beat.iter().enumerate() {
                        sum[i] += x;
                    }
                }
                (name.clone(), sum)
            })
            .collect();

        let bass_stem_name = events_by_track.keys().find(|name| stem_activations.contains_key(*name)).cloned();

        let result = objective_v2_for_span(
            &stem_activations,
            &stem_span_beats,
            &chord_tones_pc,
            written_root_pc,
            written_quality,
            written_bass_pc,
            bass_stem_name.as_deref(),
            prev_notes.as_deref(),
            None,
            None,
        );
        let mut notes_now: Vec<i32> = Vec::new();
        for a_vec in stem_activations.values() {
            notes_now.extend(apricity_harmony::notes_from_activation(a_vec, 0.15));
        }
        if !notes_now.is_empty() {
            prev_notes = Some(notes_now);
        }
        span_mass.push(result.mass);
        span_results.push((span["label"].as_str().unwrap_or_default().to_string(), result));
    }

    let window = window_objective(&span_results.iter().map(|(_, r)| r.clone()).collect::<Vec<_>>(), &span_mass);

    let mut guard_violations: Vec<String> = span_results.iter().flat_map(|(_, r)| r.guard_violations.clone()).collect();

    // A lightweight baseline mute guard: on first use, write each stem's peak dB; on later runs,
    // flag a track whose peak dropped more than 6 dB from the baseline (unless `--allow-mute`
    // names it). This is narrower than `check.py`'s baseline guards (no energy-section, density
    // or pitch-entropy comparison): `objective_v2`'s own guards (coverage, extension share) are
    // the primary anti-gaming defence here, and this is a cheap addition on top for a fully
    // silenced track.
    if let Some(baseline_path) = &opts.baseline {
        let mut peaks: HashMap<String, f64> = HashMap::new();
        for t in &tracks {
            if t.kit.is_some() || !t.pitched {
                continue;
            }
            let wav_path = opts.stems_dir.join(format!("{}.wav", t.name));
            if let Ok((mono, _sr)) = read_mono_wav(&wav_path) {
                let peak = mono.iter().cloned().fold(0.0f64, |a, b| a.max(b.abs()));
                let db = if peak > 0.0 { 20.0 * peak.log10() } else { -120.0 };
                peaks.insert(t.name.clone(), db);
            }
        }
        if baseline_path.exists() {
            let base_text = std::fs::read_to_string(baseline_path).unwrap_or_default();
            let base: serde_json::Value = serde_json::from_str(&base_text).unwrap_or(serde_json::json!({}));
            if let Some(base_peaks) = base.get("stem_peak_db").and_then(|v| v.as_object()) {
                for (name, base_db) in base_peaks {
                    if opts.allow_mute.iter().any(|m| m == name) {
                        continue;
                    }
                    let base_db = base_db.as_f64().unwrap_or(-120.0);
                    let cur_db = peaks.get(name).copied().unwrap_or(-120.0);
                    if base_db > -60.0 && cur_db < base_db - 6.0 {
                        guard_violations.push(format!("{name}: peak {cur_db:.1} dBFS is {:.1} dB under its baseline ({base_db:.1} dBFS) -- looks muted", base_db - cur_db));
                    }
                }
            }
        } else {
            if let Some(parent) = baseline_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let base = serde_json::json!({"stem_peak_db": peaks});
            let _ = std::fs::write(baseline_path, serde_json::to_string_pretty(&base).unwrap());
        }
    }

    let report = serde_json::json!({
        "stems_dir": opts.stems_dir.display().to_string(),
        "objective": window.objective_v1,
        "objective_v2": window.objective_v2,
        "consonance": window.consonance_v1,
        "guard_penalty": window.guard_penalty,
        "q_mean": window.q_mean,
        "guard_violations": guard_violations,
        "spans": span_results.iter().map(|(label, r)| serde_json::json!({
            "label": label,
            "heard": r.heard.as_ref().map(|h| serde_json::json!({
                "root": h.root, "quality": h.quality, "extensions": h.extensions,
                "bass": h.bass, "inversion": h.inversion, "confidence": h.confidence,
            })),
            "consonance_v1": r.consonance_v1,
            "Q": r.q.q,
            "objective_v2": r.objective_v2,
        })).collect::<Vec<_>>(),
    });

    if opts.json {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else {
        println!("{}", opts.stems_dir.display());
        println!("consonance {:.1}  ->  objective {:.1}  (v2 {:.2}, guards -{:.1})", window.consonance_v1, window.objective_v1, window.objective_v2, window.guard_penalty);
        if !guard_violations.is_empty() {
            println!("\nguard violations:");
            for v in &guard_violations {
                println!("  ! {v}");
            }
        }
        println!("\nspans:");
        for (label, r) in &span_results {
            let heard = r.heard.as_ref().map_or("(silent)".to_string(), |h| format!("{}{}{}/{} {}", h.root, h.quality, if h.extensions.is_empty() { String::new() } else { format!("+{}", h.extensions.join(",")) }, h.bass, h.inversion));
            println!("  {label:<16} heard {heard:<24} Q {:.3}  v2 {:.2}", r.q.q, r.objective_v2);
        }
    }

    if let Some(log_path) = &opts.log {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        let entry = serde_json::json!({
            "at": format!("{}", now.as_secs()),
            "stems_dir": opts.stems_dir.display().to_string(),
            "objective": window.objective_v1,
            "consonance": window.consonance_v1,
            "guard_violations": guard_violations,
            "objective_v2": window.objective_v2,
        });
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(f, "{}", serde_json::to_string(&entry).unwrap());
        }
    }

    Ok(0)
}
