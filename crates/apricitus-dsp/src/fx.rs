//! Mixing effects: biquad EQ, compressor, look-ahead limiter, pan, and loudness (BS.1770).
//!
//! Everything here is plain arithmetic on preallocated state: `process` never allocates, so the
//! same code runs offline (track inserts) and on the audio thread (the master chain).

use std::f64::consts::PI;

// ------------------------------------------------------------------ biquad

/// A second-order IIR section (RBJ Audio EQ Cookbook), with its own state for 2 channels.
#[derive(Debug, Clone, Copy, Default)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z: [[f64; 2]; 2],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BiquadKind {
    LowPass { hz: f64, q: f64 },
    HighPass { hz: f64, q: f64 },
    LowShelf { hz: f64, db: f64 },
    HighShelf { hz: f64, db: f64 },
    Peak { hz: f64, db: f64, q: f64 },
}

impl Biquad {
    pub fn new(kind: BiquadKind, sr: f64) -> Self {
        let mut b = Self::default();
        b.set(kind, sr);
        b
    }

    /// Change the response without resetting the filter's memory (safe for live parameter changes).
    pub fn set(&mut self, kind: BiquadKind, sr: f64) {
        let nyq = sr * 0.49;
        let (hz, db, q) = match kind {
            BiquadKind::LowPass { hz, q } | BiquadKind::HighPass { hz, q } => (hz, 0.0, q),
            BiquadKind::LowShelf { hz, db } | BiquadKind::HighShelf { hz, db } => (hz, db, std::f64::consts::FRAC_1_SQRT_2),
            BiquadKind::Peak { hz, db, q } => (hz, db, q),
        };
        let w = 2.0 * PI * hz.clamp(1.0, nyq) / sr;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * q.max(0.05));
        let a = 10f64.powf(db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            BiquadKind::LowPass { .. } => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
            BiquadKind::HighPass { .. } => ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
            BiquadKind::Peak { .. } => (1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a),
            BiquadKind::LowShelf { .. } => {
                let s = 2.0 * a.sqrt() * alpha;
                (a * ((a + 1.0) - (a - 1.0) * cos + s), 2.0 * a * ((a - 1.0) - (a + 1.0) * cos), a * ((a + 1.0) - (a - 1.0) * cos - s), (a + 1.0) + (a - 1.0) * cos + s, -2.0 * ((a - 1.0) + (a + 1.0) * cos), (a + 1.0) + (a - 1.0) * cos - s)
            }
            BiquadKind::HighShelf { .. } => {
                let s = 2.0 * a.sqrt() * alpha;
                (a * ((a + 1.0) + (a - 1.0) * cos + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cos), a * ((a + 1.0) + (a - 1.0) * cos - s), (a + 1.0) - (a - 1.0) * cos + s, 2.0 * ((a - 1.0) - (a + 1.0) * cos), (a + 1.0) - (a - 1.0) * cos - s)
            }
        };
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    #[inline]
    pub fn tick(&mut self, ch: usize, x: f64) -> f64 {
        // Transposed direct form II.
        let z = &mut self.z[ch];
        let y = self.b0 * x + z[0];
        z[0] = self.b1 * x - self.a1 * y + z[1];
        z[1] = self.b2 * x - self.a2 * y;
        y
    }

    /// A filter from normalized coefficients (a0 = 1).
    pub fn from_coeffs(b: [f64; 3], a: [f64; 2]) -> Self {
        Self { b0: b[0], b1: b[1], b2: b[2], a1: a[0], a2: a[1], z: [[0.0; 2]; 2] }
    }

    /// Magnitude response in dB at `hz` (for tests and `explain`).
    pub fn response_db(&self, hz: f64, sr: f64) -> f64 {
        let w = 2.0 * PI * hz / sr;
        let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (nr, ni) = (self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2));
        let (dr, di) = (1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2));
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }
}

// ------------------------------------------------------------------ EQ

/// Up to this many bands per EQ (no allocation when used on the audio thread).
pub const MAX_BANDS: usize = 8;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EqParams {
    pub bands: [Option<BiquadKind>; MAX_BANDS],
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Eq {
    params: EqParams,
    filters: [Biquad; MAX_BANDS],
    sr: f64,
}

impl Eq {
    pub fn new(params: EqParams, sr: f64) -> Self {
        let mut e = Self { sr, ..Self::default() };
        e.set(params);
        e
    }

    pub fn set(&mut self, params: EqParams) {
        self.params = params;
        for (f, b) in self.filters.iter_mut().zip(params.bands) {
            if let Some(kind) = b {
                f.set(kind, self.sr);
            }
        }
    }

    #[inline]
    pub fn tick(&mut self, ch: usize, mut x: f64) -> f64 {
        for (f, b) in self.filters.iter_mut().zip(self.params.bands) {
            if b.is_some() {
                x = f.tick(ch, x);
            }
        }
        x
    }

    pub fn response_db(&self, hz: f64) -> f64 {
        self.filters.iter().zip(self.params.bands).filter(|(_, b)| b.is_some()).map(|(f, _)| f.response_db(hz, self.sr)).sum()
    }
}

// ------------------------------------------------------------------ compressor

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompParams {
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub knee_db: f64,
    pub makeup_db: f64,
}

impl Default for CompParams {
    fn default() -> Self {
        Self { threshold_db: -18.0, ratio: 4.0, attack_ms: 10.0, release_ms: 120.0, knee_db: 6.0, makeup_db: 0.0 }
    }
}

impl CompParams {
    /// Static curve: output level (dB) for a steady input level (dB), before makeup.
    pub fn curve_db(&self, x: f64) -> f64 {
        let (t, r, k) = (self.threshold_db, self.ratio.max(1.0), self.knee_db.max(0.0));
        if 2.0 * (x - t) < -k {
            x
        } else if 2.0 * (x - t).abs() <= k && k > 0.0 {
            x + (1.0 / r - 1.0) * (x - t + k / 2.0).powi(2) / (2.0 * k)
        } else {
            t + (x - t) / r
        }
    }
}

/// Feed-forward compressor with a stereo-linked peak detector and log-domain smoothing.
#[derive(Debug, Clone, Copy)]
pub struct Compressor {
    p: CompParams,
    att: f64,
    rel: f64,
    /// Current gain reduction in dB (≤ 0).
    gr: f64,
    /// Deepest gain reduction seen since the last `take_max_reduction` (for metering/explain).
    max_gr: f64,
}

impl Compressor {
    pub fn new(p: CompParams, sr: f64) -> Self {
        let mut c = Self { p, att: 0.0, rel: 0.0, gr: 0.0, max_gr: 0.0 };
        c.set(p, sr);
        c
    }

    pub fn set(&mut self, p: CompParams, sr: f64) {
        self.p = p;
        self.att = (-1.0 / (p.attack_ms.max(0.01) * 1e-3 * sr)).exp();
        self.rel = (-1.0 / (p.release_ms.max(1.0) * 1e-3 * sr)).exp();
    }

    /// Process one stereo frame (detector keyed by `key`, usually the frame itself).
    #[inline]
    pub fn tick(&mut self, l: f64, r: f64, key: f64) -> (f64, f64) {
        let level = 20.0 * (key.abs() + 1e-12).log10();
        let target = self.p.curve_db(level) - level; // ≤ 0
        let coeff = if target < self.gr { self.att } else { self.rel };
        self.gr = coeff * self.gr + (1.0 - coeff) * target;
        self.max_gr = self.max_gr.min(self.gr);
        let g = 10f64.powf((self.gr + self.p.makeup_db) / 20.0);
        (l * g, r * g)
    }

    pub fn take_max_reduction(&mut self) -> f64 {
        std::mem::take(&mut self.max_gr)
    }
}

// ------------------------------------------------------------------ limiter

/// Longest look-ahead supported (samples), preallocated so the limiter never allocates.
pub const MAX_LOOKAHEAD: usize = 512;

/// Look-ahead peak limiter: output never exceeds `ceiling` (true for every sample, by design:
/// the gain applied to a delayed sample is the minimum required anywhere in its look-ahead window).
#[derive(Debug, Clone)]
pub struct Limiter {
    ceiling: f64,
    lookahead: usize,
    release: f64,
    buf: [[f64; MAX_LOOKAHEAD]; 2],
    need: [f64; MAX_LOOKAHEAD],
    pos: usize,
    gain: f64,
}

impl Limiter {
    pub fn new(ceiling_db: f64, release_ms: f64, sr: f64) -> Self {
        let mut l = Self { ceiling: 1.0, lookahead: 1, release: 0.0, buf: [[0.0; MAX_LOOKAHEAD]; 2], need: [1.0; MAX_LOOKAHEAD], pos: 0, gain: 1.0 };
        l.set(ceiling_db, release_ms, sr);
        l
    }

    pub fn set(&mut self, ceiling_db: f64, release_ms: f64, sr: f64) {
        self.ceiling = 10f64.powf(ceiling_db.min(0.0) / 20.0);
        self.lookahead = ((0.0015 * sr) as usize).clamp(1, MAX_LOOKAHEAD);
        self.release = (-1.0 / (release_ms.max(1.0) * 1e-3 * sr)).exp();
    }

    /// Delay in samples added by the look-ahead.
    pub fn latency(&self) -> usize {
        self.lookahead
    }

    #[inline]
    pub fn tick(&mut self, l: f64, r: f64) -> (f64, f64) {
        let n = self.lookahead;
        let peak = l.abs().max(r.abs());
        self.need[self.pos] = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
        self.buf[0][self.pos] = l;
        self.buf[1][self.pos] = r;
        // Minimum required gain across the window (small n: a plain scan, no allocation).
        let mut want = 1.0f64;
        for k in 0..n {
            want = want.min(self.need[(self.pos + MAX_LOOKAHEAD - k) % MAX_LOOKAHEAD]);
        }
        self.gain = if want < self.gain { want } else { self.release * self.gain + (1.0 - self.release) * want };
        let out = (self.pos + MAX_LOOKAHEAD - (n - 1)) % MAX_LOOKAHEAD;
        self.pos = (self.pos + 1) % MAX_LOOKAHEAD;
        // The sample leaving the delay line was inside every window since it arrived, so the running
        // gain already covers it; taking its own requirement too makes the guarantee explicit.
        let g = self.gain.min(self.need[out]);
        (self.buf[0][out] * g, self.buf[1][out] * g)
    }
}

// ------------------------------------------------------------------ pan

/// Balance for stereo material: centre is unity; turning toward one side lowers the other side
/// only (no boost, so panning can't clip). `pan` is −1 (left) … 1 (right).
#[inline]
pub fn balance(pan: f64) -> (f64, f64) {
    let p = pan.clamp(-1.0, 1.0);
    if p <= 0.0 { (1.0, 1.0 + p) } else { (1.0 - p, 1.0) }
}

// ------------------------------------------------------------------ loudness

/// BS.1770 K-weighting at any sample rate: the standard's high shelf (+4 dB above ~1.7 kHz) and
/// high-pass (~38 Hz), derived as in libebur128 (matches the published 48 kHz coefficients).
fn k_weighting(sr: f64) -> (Biquad, Biquad) {
    let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (PI * f0 / sr).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad::from_coeffs(
        [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
    );
    let (f0, q) = (38.13547087602444, 0.5003270373238773);
    let k = (PI * f0 / sr).tan();
    let a0 = 1.0 + k / q + k * k;
    let high = Biquad::from_coeffs([1.0, -2.0, 1.0], [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0]);
    (shelf, high)
}

/// Integrated loudness in LUFS (ITU-R BS.1770-4 with gating), for stereo planar audio.
pub fn loudness_lufs(l: &[f32], r: &[f32], sr: f64) -> f64 {
    let (mut pre, mut hp) = k_weighting(sr);
    let n = l.len().min(r.len());
    let block = (0.4 * sr) as usize;
    let hop = block / 4;
    if n < block {
        return f64::NEG_INFINITY;
    }
    let mut sq = vec![[0.0f64; 2]; n];
    for i in 0..n {
        for (c, x) in [l[i], r[i]].into_iter().enumerate() {
            let y = hp.tick(c, pre.tick(c, x as f64));
            sq[i][c] = y * y;
        }
    }
    // Mean square per 400 ms block (75% overlap), summed over channels (weights 1.0 for L/R).
    let mut blocks = Vec::new();
    let mut start = 0;
    while start + block <= n {
        let z: f64 = sq[start..start + block].iter().map(|s| s[0] + s[1]).sum::<f64>() / block as f64;
        blocks.push(z);
        start += hop;
    }
    let lufs = |z: f64| -0.691 + 10.0 * z.max(1e-20).log10();
    let abs_gated: Vec<f64> = blocks.into_iter().filter(|&z| lufs(z) > -70.0).collect();
    if abs_gated.is_empty() {
        return f64::NEG_INFINITY;
    }
    let rel = lufs(abs_gated.iter().sum::<f64>() / abs_gated.len() as f64) - 10.0;
    let gated: Vec<f64> = abs_gated.into_iter().filter(|&z| lufs(z) > rel).collect();
    lufs(gated.iter().sum::<f64>() / gated.len().max(1) as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f64 = 48_000.0;

    fn sine(hz: f64, amp: f64, secs: f64) -> Vec<f32> {
        (0..(secs * SR) as usize).map(|i| (amp * (2.0 * PI * hz * i as f64 / SR).sin()) as f32).collect()
    }

    #[test]
    fn eq_shapes() {
        let mut p = EqParams::default();
        p.bands[0] = Some(BiquadKind::HighPass { hz: 100.0, q: std::f64::consts::FRAC_1_SQRT_2 });
        p.bands[1] = Some(BiquadKind::LowShelf { hz: 250.0, db: -3.0 });
        p.bands[2] = Some(BiquadKind::HighShelf { hz: 6000.0, db: 2.0 });
        p.bands[3] = Some(BiquadKind::Peak { hz: 1000.0, db: -6.0, q: 1.0 });
        let eq = Eq::new(p, SR);
        assert!((eq.response_db(1000.0) - (-6.0)).abs() < 0.8, "peak: {}", eq.response_db(1000.0));
        assert!((eq.response_db(16000.0) - 2.0).abs() < 0.5, "high shelf: {}", eq.response_db(16000.0));
        assert!(eq.response_db(30.0) < -18.0, "low cut: {}", eq.response_db(30.0));
        assert!((eq.response_db(3000.0)).abs() < 1.5, "mids near flat: {}", eq.response_db(3000.0));
    }

    #[test]
    fn compressor_curve_and_behaviour() {
        let p = CompParams { threshold_db: -20.0, ratio: 4.0, knee_db: 0.0, ..Default::default() };
        assert_eq!(p.curve_db(-30.0), -30.0);
        assert_eq!(p.curve_db(-20.0), -20.0);
        assert_eq!(p.curve_db(0.0), -15.0); // 20 dB over → 5 dB over
        let soft = CompParams { knee_db: 6.0, ..p };
        assert!(soft.curve_db(-20.0) < -20.0 && soft.curve_db(-20.0) > -21.0);
        // A loud steady tone settles to about the static curve.
        let mut c = Compressor::new(p, SR);
        let x = sine(1000.0, 1.0, 1.0);
        let mut last = 0.0f64;
        for &v in &x {
            last = last.max(c.tick(v as f64, v as f64, v as f64).0.abs() * (1.0 - 1e-9));
        }
        let mut peak = 0.0f64;
        for &v in &x[x.len() / 2..] {
            peak = peak.max(c.tick(v as f64, v as f64, v as f64).0.abs());
        }
        let out_db = 20.0 * peak.log10();
        assert!((out_db - (-15.0)).abs() < 1.5, "compressed peak {out_db} dB");
        assert!(c.take_max_reduction() < -10.0);
    }

    #[test]
    fn limiter_never_exceeds_its_ceiling() {
        let mut lim = Limiter::new(-1.0, 50.0, SR);
        let ceiling = 10f64.powf(-1.0 / 20.0);
        let mut worst = 0.0f64;
        // Loud tone with sudden +12 dB spikes.
        for i in 0..(SR as usize) {
            let mut v = 0.9 * (2.0 * PI * 220.0 * i as f64 / SR).sin();
            if i % 4800 == 0 {
                v = 4.0;
            }
            let (l, r) = lim.tick(v, -v);
            worst = worst.max(l.abs()).max(r.abs());
        }
        assert!(worst <= ceiling + 1e-9, "peak {worst} over ceiling {ceiling}");
        assert!(worst > ceiling * 0.9, "limiter shouldn't over-attenuate: {worst}");
    }

    #[test]
    fn balance_never_boosts() {
        assert_eq!(balance(0.0), (1.0, 1.0));
        assert_eq!(balance(-1.0), (1.0, 0.0));
        assert_eq!(balance(0.5), (0.5, 1.0));
    }

    #[test]
    fn k_weighting_matches_the_published_48k_coefficients() {
        let (shelf, hp) = k_weighting(48000.0);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-6;
        assert!(close(shelf.b0, 1.53512485958697) && close(shelf.b1, -2.69169618940638) && close(shelf.b2, 1.19839281085285));
        assert!(close(shelf.a1, -1.69065929318241) && close(shelf.a2, 0.73248077421585));
        assert!(close(hp.a1, -1.99004745483398) && close(hp.a2, 0.99007225036621));
    }

    #[test]
    fn loudness_of_reference_tones() {
        // BS.1770: a 997 Hz sine at 0 dBFS in one channel reads −3.01 LUFS; in both channels ≈ 0.
        let tone = sine(997.0, 1.0, 3.0);
        let silence = vec![0.0f32; tone.len()];
        let one = loudness_lufs(&tone, &silence, SR);
        assert!((one - (-3.01)).abs() < 0.15, "one channel: {one}");
        let both = loudness_lufs(&tone, &tone, SR);
        assert!((both - 0.0).abs() < 0.15, "both channels: {both}");
        let quieter = loudness_lufs(&sine(997.0, 0.1, 3.0), &silence, SR);
        assert!((quieter - (-23.01)).abs() < 0.15, "−20 dB: {quieter}");
    }
}

