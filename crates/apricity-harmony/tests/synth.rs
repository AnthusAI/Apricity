//! The four synthetic Harmony v2 fixtures (sec 5.3 of spec-harmony-v2.md), built IN MEMORY --
//! no audio is committed anywhere in this repo (the project rule: audio is never committed, in
//! any format; a checked-in fixture would silently vanish under `.gitignore`'s `*.wav` and fail
//! on a fresh clone / in CI). This is the Rust port of
//! `analysis/tests/fixtures/harmony2/generate.py`'s functions: same formula, frequencies,
//! partial weights, sample rate and length, and the same `f32` round-trip (matching what a
//! `subtype="FLOAT"` WAV would have held and `soundfile.read()` would give back), so the two
//! sides' fixtures are bit-identical (or within 1 ULP of `f32` rounding) and the checked-in
//! `expected.json` (computed from the Python side) is valid ground truth for both.
//!
//! No `#[test]` functions live here on purpose (this file's job is to be `#[path = "synth.rs"]
//! mod synth;`-included from `tests/parity.rs`); Cargo still builds it as its own (empty) test
//! binary because it matches `tests/*.rs`, which is harmless.

pub const SR: f64 = 22050.0;

/// One tone: `partials` harmonics at `amplitude 0.6^(h-1)`, `secs` seconds at `SR`, peak-
/// normalised to 1.0 (matching `generate.tone`'s own `/ np.max(np.abs(y))`).
pub fn tone(midi: f64, secs: f64, cents: f64, partials: usize) -> Vec<f64> {
    let f = 440.0 * 2f64.powf((midi - 69.0) / 12.0) * 2f64.powf(cents / 1200.0);
    let n = (secs * SR) as usize;
    let mut y = vec![0.0f64; n];
    for h in 1..=partials {
        let amp = 0.6f64.powi(h as i32 - 1);
        let w = 2.0 * std::f64::consts::PI * f * h as f64;
        for (i, yi) in y.iter_mut().enumerate() {
            *yi += amp * (w * (i as f64 / SR)).sin();
        }
    }
    let peak = y.iter().cloned().fold(0.0f64, |a, b| a.max(b.abs()));
    if peak > 0.0 {
        for yi in y.iter_mut() {
            *yi /= peak;
        }
    }
    y
}

/// Rounds `scale * y` through `f32` once (what writing a `subtype="FLOAT"` WAV and reading it
/// back would give), matching `generate._as_wav_would_hold_it`.
fn as_wav_would_hold_it(y: &[f64], scale: f64) -> Vec<f64> {
    y.iter().map(|&v| ((scale * v) as f32) as f64).collect()
}

/// (a) C/E: a first-inversion C major triad, bass E2, C3 G3 C4 above.
pub fn ce_inversion() -> Vec<f64> {
    let e2 = tone(40.0, 2.0, 0.0, 6);
    let c3 = tone(48.0, 2.0, 0.0, 6);
    let g3 = tone(55.0, 2.0, 0.0, 6);
    let c4 = tone(60.0, 2.0, 0.0, 6);
    let y: Vec<f64> = (0..e2.len()).map(|i| 1.2 * e2[i] + c3[i] + g3[i] + c4[i]).collect();
    as_wav_would_hold_it(&y, 0.3)
}

/// (b) A3 detuned +30 cents.
pub fn detuned_30c() -> Vec<f64> {
    as_wav_would_hold_it(&tone(57.0, 2.0, 30.0, 6), 0.3)
}

/// (c) A Cm7 arpeggio (C4 Eb4 G4 Bb4) that IS a written Am7 shifted -3 semitones.
pub fn shift_loop() -> Vec<f64> {
    let c4 = tone(60.0, 2.0, 0.0, 6);
    let eb4 = tone(63.0, 2.0, 0.0, 6);
    let g4 = tone(67.0, 2.0, 0.0, 6);
    let bb4 = tone(70.0, 2.0, 0.0, 6);
    let y: Vec<f64> = (0..c4.len()).map(|i| c4[i] + eb4[i] + g4[i] + bb4[i]).collect();
    as_wav_would_hold_it(&y, 0.3)
}

/// The A2 pinned bass paired with `shift_loop`.
pub fn shift_bass() -> Vec<f64> {
    as_wav_would_hold_it(&tone(45.0, 2.0, 0.0, 6), 0.3)
}
