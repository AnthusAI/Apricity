//! Parity between `HarmonicBank` and the Python reference (`analysis/apricity_analyze/
//! harmonic_ref.py`, Kanbus `apricitus-ddc14b`), on the 4-chord fixture both sides build the
//! same way (`analysis/tests/fixtures/harmonic/generate.py`). Acceptance (spec-harmony-v2.md
//! sec 4.3, task 9): peak within −80 dBFS (1e-4 linear) and RMS within 1e-6 of the Python
//! reference's rendered output, at all three presets. Reads `expected.json`, written by
//! `pytest analysis/tests/test_harmonic_ref.py` — run that first if this file is missing.

use apricity_dsp::fx::{HarmonicBank, HarmonicChord, HarmonicMode, HarmonicParams};
use serde_json::Value;
use std::path::PathBuf;

const SR: f64 = 48_000.0;
const BPM: f64 = 120.0;
const BEATS_PER_CHORD: f64 = 2.0;

// (label, tones pitch-classes, bass pitch-class)
const SPANS: [(&str, &[u8], u8); 4] = [("Am7", &[9, 0, 4, 7], 9), ("Fmaj7", &[5, 9, 0, 4], 5), ("Dm7", &[2, 5, 9, 0], 2), ("G", &[7, 11, 2], 7)];
const WRONG_PC: u8 = 1;

fn hz(pc: u8, octave: i32) -> f64 {
    let midi = 12 * (octave + 1) + pc as i32;
    440.0 * 2f64.powf((midi as f64 - 69.0) / 12.0)
}

fn span_samples() -> usize {
    let span_s = BEATS_PER_CHORD * 60.0 / BPM;
    (span_s * SR) as usize
}

fn dry_stem() -> Vec<f64> {
    let n = span_samples();
    let wrong_hz = hz(WRONG_PC, 5);
    let mut out = vec![0.0f64; SPANS.len() * n];
    for (i, (_label, tones, _bass)) in SPANS.iter().enumerate() {
        let root_hz = hz(tones[0], 3);
        let third_hz = hz(tones[1], 4);
        for k in 0..n {
            let t = k as f64 / SR;
            let y = 0.5 * (2.0 * std::f64::consts::PI * root_hz * t).sin() + 0.3 * (2.0 * std::f64::consts::PI * third_hz * t).sin() + 0.2 * (2.0 * std::f64::consts::PI * wrong_hz * t).sin();
            // Mirrors the Python fixture's single float32 round trip (`.astype(np.float32).astype(np.float64)`).
            out[i * n + k] = ((0.3 * y) as f32) as f64;
        }
    }
    out
}

fn chord_at(sample_index: usize) -> HarmonicChord {
    let n = span_samples();
    let span_i = (sample_index / n).min(SPANS.len() - 1);
    let (_label, tones, bass_pc) = SPANS[span_i];
    let bass_hz = hz(bass_pc, 2);
    let mut tones_pc = [false; 12];
    for &t in tones {
        tones_pc[t as usize] = true;
    }
    let mut fundamentals_hz = vec![bass_hz];
    for &t in tones {
        if t != bass_pc {
            fundamentals_hz.push(hz(t, 3));
        }
    }
    HarmonicChord { tones_pc, bass_hz, fundamentals_hz }
}

fn preset(name: &str) -> (HarmonicParams, f64) {
    match name {
        "cleanup" => (HarmonicParams { mode: HarmonicMode::Cut, depth_db: 6.0, boost_db: 0.0, tolerance_cents: 20.0, harmonics: 6, range_lo_hz: 100.0, range_hi_hz: 3000.0, tune_hz: 440.0, mix: 1.0 }, 0.060),
        "autotune-ish" => (HarmonicParams { mode: HarmonicMode::Cut, depth_db: 14.0, boost_db: 0.0, tolerance_cents: 40.0, harmonics: 0, range_lo_hz: 60.0, range_hi_hz: 6000.0, tune_hz: 440.0, mix: 1.0 }, 0.015),
        "both-8c" => (HarmonicParams { mode: HarmonicMode::Both, depth_db: 18.0, boost_db: 14.0, tolerance_cents: 8.0, harmonics: 2, range_lo_hz: 60.0, range_hi_hz: 8000.0, tune_hz: 440.0, mix: 1.0 }, 0.250),
        other => panic!("unknown preset {other}"),
    }
}

fn render(preset_name: &str) -> (f64, f64) {
    let (p, glide_s) = preset(preset_name);
    let mut bank = HarmonicBank::new(SR, &p);
    let dry = dry_stem();
    let block = 32usize;
    let block_dur_s = block as f64 / SR;
    let mut out = vec![0.0f64; dry.len()];
    let mut start = 0;
    while start < dry.len() {
        let end = (start + block).min(dry.len());
        let chord = chord_at(start);
        bank.update(Some(&chord), &p, glide_s, block_dur_s);
        for i in start..end {
            out[i] = bank.tick(0, dry[i]);
        }
        start = end;
    }
    let peak = out.iter().fold(0.0f64, |m, &x| m.max(x.abs()));
    let rms = (out.iter().map(|x| x * x).sum::<f64>() / out.len() as f64).sqrt();
    (peak, rms)
}

#[test]
fn matches_the_python_reference_at_all_three_presets() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../analysis/tests/fixtures/harmonic/expected.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("skipping: {} not found; run `pytest analysis/tests/test_harmonic_ref.py` first to generate it", path.display());
            return;
        }
    };
    let expected: Value = serde_json::from_str(&text).expect("valid JSON");

    for preset_name in ["cleanup", "autotune-ish", "both-8c"] {
        let (peak, rms) = render(preset_name);
        let want_peak = expected[preset_name]["render"]["peak"].as_f64().expect("peak");
        let want_rms = expected[preset_name]["render"]["rms"].as_f64().expect("rms");
        assert!((peak - want_peak).abs() < 1e-4, "{preset_name}: peak {peak} vs python {want_peak} (want < -80 dBFS / 1e-4 linear)");
        assert!((rms - want_rms).abs() < 1e-6, "{preset_name}: rms {rms} vs python {want_rms} (want < 1e-6)");
    }
}
