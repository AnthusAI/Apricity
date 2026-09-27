//! The parabolic sub-bin cents estimator. A direct port of `harmony2_ref.cents_offset`.

use crate::cqt::{cqt, BINS_PER_OCTAVE, BINS_PER_SEMITONE};

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Cents from equal temperament (A440): for each frame's strongest CQT peak, a parabolic sub-bin
/// fit over its 3 neighbouring bins, folded to the NEAREST semitone centre (bin `3k`, since
/// `fmin` is exactly C1 -- verified empirically against the reference, see its docstring), median
/// over frames (sec 2.2).
pub fn cents_offset(y: &[f64]) -> f64 {
    let (c, _n_fft) = cqt(y, 0.0);
    cents_offset_from_cqt(&c)
}

/// Same as [`cents_offset`], but from an already-computed raw CQT (`(N_BINS, n_frames)`), so a
/// caller that also needs the CQT itself (e.g. for NNLS) doesn't build the kernels twice.
pub fn cents_offset_from_cqt(c: &[Vec<f64>]) -> f64 {
    let n_frames = c.first().map_or(0, |row| row.len());
    let n_bins = c.len();
    let mut offs = Vec::new();
    for f in 0..n_frames {
        let mut k = 0usize;
        let mut best = f64::NEG_INFINITY;
        for (b, row) in c.iter().enumerate() {
            if row[f] > best {
                best = row[f];
                k = b;
            }
        }
        if k == 0 || k >= n_bins - 1 || c[k][f] <= 1e-9 {
            continue;
        }
        let a = (c[k - 1][f] + 1e-12).ln();
        let b = (c[k][f] + 1e-12).ln();
        let cc = (c[k + 1][f] + 1e-12).ln();
        let denom = a - 2.0 * b + cc;
        let d = if denom != 0.0 { 0.5 * (a - cc) / denom } else { 0.0 };
        let centre = BINS_PER_SEMITONE * ((k as f64 / BINS_PER_SEMITONE as f64).round() as usize);
        let cents = ((k as f64 - centre as f64) + d) * (1200.0 / BINS_PER_OCTAVE as f64);
        offs.push(cents);
    }
    median(offs)
}
