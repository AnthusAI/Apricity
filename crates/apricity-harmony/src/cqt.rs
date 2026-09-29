//! Brown & Puckette (1992) sparse-kernel CQT. A direct port of `harmony2_ref.cqt` /
//! `build_cqt_kernels` (Python). f64 throughout; `rustfft`'s `Complex<f64>` FFT (the only new
//! dependency this crate adds -- pure Rust, builds for wasm32 and iOS).

use rustfft::num_complex::Complex64;
use rustfft::FftPlanner;
use std::sync::Arc;

pub const SR: f64 = 22050.0;
pub const HOP: usize = 512;
pub const BINS_PER_OCTAVE: usize = 36;
pub const BINS_PER_SEMITONE: usize = 3;
pub const N_OCTAVES: usize = 7; // C1..B7
pub const N_SEMITONES: usize = 12 * N_OCTAVES; // 84
pub const N_BINS: usize = N_SEMITONES * BINS_PER_SEMITONE; // 252
pub const MIDI_C1: i32 = 24;

/// C1 in Hz, A440 reference: `440 * 2^((24-69)/12)`.
pub fn fmin() -> f64 {
    440.0 * 2f64.powf((MIDI_C1 as f64 - 69.0) / 12.0)
}

fn bin_freq(k: usize, tuning_cents: f64) -> f64 {
    fmin() * 2f64.powf(k as f64 / BINS_PER_OCTAVE as f64) * 2f64.powf(tuning_cents / 1200.0)
}

/// One bin's sparse kernel: the FFT-domain indices with non-negligible weight, and their
/// (conjugated) complex weights.
pub struct Kernel {
    pub indices: Vec<usize>,
    pub weights: Vec<Complex64>,
}

pub struct CqtKernels {
    pub kernels: Vec<Kernel>, // N_BINS of them
    pub n_fft: usize,
}

/// A symmetric Hann window of length `n` (matches `numpy.hanning(n)`).
fn hann(n: usize) -> Vec<f64> {
    if n == 1 {
        return vec![1.0];
    }
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (n as f64 - 1.0)).cos()).collect()
}

/// Builds one sparse FFT-domain kernel per bin (sec 2.1/2.7). `tuning_cents` shifts every bin's
/// centre frequency (0.0 for the untransposed analysis).
pub fn build_cqt_kernels(tuning_cents: f64) -> CqtKernels {
    let q = 1.0 / (2f64.powf(1.0 / BINS_PER_OCTAVE as f64) - 1.0);
    let lengths: Vec<usize> = (0..N_BINS).map(|k| ((q * SR / bin_freq(k, tuning_cents)).round() as usize).max(4)).collect();
    let max_len = *lengths.iter().max().unwrap();
    let mut n_fft = 1usize;
    while n_fft < max_len {
        n_fft *= 2;
    }

    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);

    let mut kernels = Vec::with_capacity(N_BINS);
    for k in 0..N_BINS {
        let n = lengths[k];
        let f = bin_freq(k, tuning_cents);
        let win = hann(n);
        let mut padded = vec![Complex64::new(0.0, 0.0); n_fft];
        let start = (n_fft - n) / 2;
        for t in 0..n {
            let phase = -2.0 * std::f64::consts::PI * f * t as f64 / SR;
            let w = win[t] / n as f64;
            padded[start + t] = Complex64::new(w * phase.cos(), w * phase.sin());
        }
        fft.process(&mut padded);
        let max_mag = padded.iter().map(|c| c.norm()).fold(0.0f64, f64::max);
        let thresh = max_mag * 0.0054;
        let mut indices = Vec::new();
        let mut weights = Vec::new();
        for (i, c) in padded.iter().enumerate() {
            if c.norm() > thresh {
                indices.push(i);
                weights.push(c.conj());
            }
        }
        kernels.push(Kernel { indices, weights });
    }
    CqtKernels { kernels, n_fft }
}

/// `(N_BINS, n_frames)` magnitude CQT of mono `y`, centered frames on the hop grid, row-major
/// per bin (`result[bin][frame]`), matching the reference's `cqt()`.
pub fn cqt(y: &[f64], tuning_cents: f64) -> (Vec<Vec<f64>>, usize) {
    cqt_with_kernels(y, &build_cqt_kernels(tuning_cents))
}

/// Same as [`cqt`], but reusing pre-built kernels (avoids rebuilding them per call).
pub fn cqt_with_kernels(y: &[f64], k: &CqtKernels) -> (Vec<Vec<f64>>, usize) {
    let n_fft = k.n_fft;
    let pad = n_fft / 2;
    let mut yp = vec![0.0f64; pad + y.len() + pad];
    yp[pad..pad + y.len()].copy_from_slice(y);
    let n_frames = (1 + (yp.len().saturating_sub(n_fft)) / HOP).max(1);

    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(n_fft);

    let mut out = vec![vec![0.0f64; n_frames]; N_BINS];
    let mut seg = vec![Complex64::new(0.0, 0.0); n_fft];
    for fidx in 0..n_frames {
        let start = fidx * HOP;
        for i in 0..n_fft {
            let v = yp.get(start + i).copied().unwrap_or(0.0);
            seg[i] = Complex64::new(v, 0.0);
        }
        fft.process(&mut seg);
        for (bin, kernel) in k.kernels.iter().enumerate() {
            let mut acc = Complex64::new(0.0, 0.0);
            for (idx, w) in kernel.indices.iter().zip(&kernel.weights) {
                acc += seg[*idx] * w;
            }
            out[bin][fidx] = acc.norm();
        }
    }
    (out, n_fft)
}

pub type Kernels = Arc<CqtKernels>;
