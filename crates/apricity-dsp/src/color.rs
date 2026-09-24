//! Character effects: saturation (`drive`), sampler grit (`lofi`), a noise gate, and stereo width.
//! `drive` and `lofi` work on whole loop buffers (offline); `Gate` and `width` are per-sample and
//! allocation-free (width also runs on the live master).

use crate::fx::{Biquad, BiquadKind};
use crate::resample::{down2, up2};

// ------------------------------------------------------------------ drive

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriveParams {
    /// Gain into the saturator; more = more harmonics and more squash.
    pub db: f64,
    /// Low-pass after the saturator (tames fizz), Hz.
    pub tone_hz: Option<f64>,
}

/// Soft saturation of a loop, in place: 2× oversampled (so the new harmonics don't alias), a
/// slightly asymmetric tanh curve (even harmonics, like tape or tubes), then level-matched back to
/// the input's loudness so `drive` changes the colour, not the volume.
pub fn drive(buf: &mut [Vec<f32>; 2], p: DriveParams, sr: f64) {
    let g = 10f64.powf(p.db / 20.0);
    const BIAS: f64 = 0.2;
    let power = |b: &[Vec<f32>; 2]| b.iter().flatten().map(|x| (*x as f64).powi(2)).sum::<f64>();
    let before = power(buf);
    for c in buf.iter_mut() {
        let mut up = up2(c);
        for y in up.iter_mut() {
            *y = (g * *y + BIAS).tanh() - BIAS.tanh();
        }
        // Remove the DC the bias adds.
        let dc = up.iter().sum::<f64>() / up.len().max(1) as f64;
        up.iter_mut().for_each(|y| *y -= dc);
        *c = down2(&up);
    }
    if let Some(hz) = p.tone_hz {
        let mut f = Biquad::new(BiquadKind::LowPass { hz, q: std::f64::consts::FRAC_1_SQRT_2 }, sr);
        for (ch, c) in buf.iter_mut().enumerate() {
            c.iter_mut().for_each(|x| *x = f.tick(ch, *x as f64) as f32);
        }
    }
    let after = power(buf);
    if after > 0.0 && before > 0.0 {
        let k = ((before / after).sqrt()).clamp(0.25, 4.0) as f32;
        buf.iter_mut().flatten().for_each(|x| *x *= k);
    }
}

// ------------------------------------------------------------------ lofi

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LofiParams {
    /// Bit depth (4–16): quantization grit.
    pub bits: f64,
    /// Sample-and-hold rate, Hz (e.g. 26040 for an SP-1200): aliasing grit.
    pub rate_hz: Option<f64>,
    /// Tape/vinyl pitch wobble, 0–1 (1 ≈ ±3 ms of slow wow).
    pub wow: f64,
}

/// Sampler character on a loop of `loop_len` frames (the buffer may hold several cycles of it):
/// wow first (a slow, loop-synced pitch wobble), then sample-and-hold, then bit reduction.
pub fn lofi(buf: &mut [Vec<f32>; 2], p: LofiParams, sr: f64, loop_len: usize) {
    if p.wow > 0.0 {
        // A whole number of wobbles per loop (about 0.5 Hz), so the loop point doesn't jump.
        let loop_s = loop_len.max(1) as f64 / sr;
        let cycles = (0.5 * loop_s).round().max(1.0);
        let f = cycles / loop_s;
        let depth = p.wow.clamp(0.0, 1.0) * 0.003 * sr;
        for c in buf.iter_mut() {
            let x = c.clone();
            let n = x.len() as isize;
            let at = |i: isize| x[i.rem_euclid(n) as usize] as f64;
            for (i, y) in c.iter_mut().enumerate() {
                let t = i as f64 - depth * (1.0 + (2.0 * std::f64::consts::PI * f * i as f64 / sr).sin());
                let (k, fr) = (t.floor() as isize, t - t.floor());
                // Cubic (Catmull-Rom) read between samples.
                let (a, b, c2, d) = (at(k - 1), at(k), at(k + 1), at(k + 2));
                *y = (b + 0.5 * fr * (c2 - a + fr * (2.0 * a - 5.0 * b + 4.0 * c2 - d + fr * (3.0 * (b - c2) + d - a)))) as f32;
            }
        }
    }
    if let Some(rate) = p.rate_hz.filter(|r| *r < sr) {
        let step = rate / sr;
        for c in buf.iter_mut() {
            let (mut acc, mut held) = (1.0, 0.0f32);
            for y in c.iter_mut() {
                acc += step;
                if acc >= 1.0 {
                    acc -= 1.0;
                    held = *y;
                }
                *y = held;
            }
        }
    }
    if p.bits < 24.0 {
        let q = 2f64.powf(p.bits.clamp(2.0, 24.0) - 1.0);
        buf.iter_mut().flatten().for_each(|y| *y = ((*y as f64 * q).round() / q) as f32);
    }
}

// ------------------------------------------------------------------ noise gate

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateParams {
    pub threshold_db: f64,
    pub attack_ms: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    /// How far a closed gate turns things down (dB, ≤ 0).
    pub range_db: f64,
}

impl Default for GateParams {
    fn default() -> Self {
        Self { threshold_db: -40.0, attack_ms: 1.0, hold_ms: 30.0, release_ms: 100.0, range_db: -80.0 }
    }
}

/// Silences what falls below the threshold (hiss between phrases, spill between hits).
pub struct Gate {
    thr: f64,
    /// dB per sample while opening / closing: attack and release are the times to swing fully.
    open_step: f64,
    close_step: f64,
    hold: usize,
    range_db: f64,
    env: f64,
    env_rel: f64,
    held: usize,
    gain_db: f64,
}

impl Gate {
    pub fn new(p: GateParams, sr: f64) -> Self {
        let range = p.range_db.min(-1.0);
        let per_sample = |ms: f64| -range / (ms.max(0.01) * 1e-3 * sr);
        Self {
            thr: 10f64.powf(p.threshold_db / 20.0),
            open_step: per_sample(p.attack_ms),
            close_step: per_sample(p.release_ms),
            hold: (p.hold_ms * 1e-3 * sr) as usize,
            range_db: range,
            env: 0.0,
            env_rel: (-1.0 / (0.010 * sr)).exp(),
            held: 0,
            gain_db: range,
        }
    }

    #[inline]
    pub fn tick(&mut self, l: f64, r: f64) -> (f64, f64) {
        let x = l.abs().max(r.abs());
        // Peak envelope: instant up, 10 ms down, so the gate follows the signal's shape.
        self.env = if x > self.env { x } else { self.env_rel * self.env + (1.0 - self.env_rel) * x };
        let open = if self.env >= self.thr {
            self.held = self.hold;
            true
        } else if self.held > 0 {
            self.held -= 1;
            true
        } else {
            false
        };
        self.gain_db = if open { (self.gain_db + self.open_step).min(0.0) } else { (self.gain_db - self.close_step).max(self.range_db) };
        let g = if self.gain_db <= self.range_db { 10f64.powf(self.range_db / 20.0) } else { 10f64.powf(self.gain_db / 20.0) };
        (l * g, r * g)
    }
}

// ------------------------------------------------------------------ width

/// Mid/side width: 0 = mono, 1 = unchanged, 2 = twice as wide.
#[inline]
pub fn width(l: f64, r: f64, w: f64) -> (f64, f64) {
    let (m, s) = (0.5 * (l + r), 0.5 * (l - r) * w);
    (m + s, m - s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    const SR: f64 = 48_000.0;

    fn tone(hz: f64, amp: f64, n: usize) -> [Vec<f32>; 2] {
        let v: Vec<f32> = (0..n).map(|i| (amp * (2.0 * PI * hz * i as f64 / SR).sin()) as f32).collect();
        [v.clone(), v]
    }

    /// Energy at `hz` (a single DFT bin).
    fn bin(x: &[f32], hz: f64) -> f64 {
        let (mut re, mut im) = (0.0, 0.0);
        for (i, v) in x.iter().enumerate() {
            let a = 2.0 * PI * hz * i as f64 / SR;
            re += *v as f64 * a.cos();
            im += *v as f64 * a.sin();
        }
        (re * re + im * im).sqrt() / x.len() as f64
    }

    #[test]
    fn drive_adds_harmonics_keeps_the_level_and_does_not_alias() {
        let mut b = tone(1000.0, 0.5, 48_000);
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
        let before = rms(&b[0]);
        drive(&mut b, DriveParams { db: 18.0, tone_hz: None }, SR);
        assert!((rms(&b[0]) / before - 1.0).abs() < 0.02, "level matched");
        let (f1, f2, f3) = (bin(&b[0], 1000.0), bin(&b[0], 2000.0), bin(&b[0], 3000.0));
        assert!(f3 > 0.05 * f1 && f2 > 0.01 * f1, "odd and even harmonics: {f1:.3} {f2:.4} {f3:.4}");
        // 7 kHz driven hard: its 5th harmonic (35 kHz) would alias to 13 kHz without oversampling.
        let mut h = tone(7000.0, 0.5, 48_000);
        drive(&mut h, DriveParams { db: 18.0, tone_hz: None }, SR);
        let alias = bin(&h[0], 13_000.0) / bin(&h[0], 7000.0);
        assert!(alias < 0.02, "aliased 13 kHz at {alias:.4} of the fundamental");
    }

    #[test]
    fn lofi_quantizes_and_holds_samples() {
        let mut b = tone(440.0, 0.8, 4800);
        lofi(&mut b, LofiParams { bits: 4.0, rate_hz: Some(12_000.0), wow: 0.0 }, SR, 4800);
        let levels: std::collections::BTreeSet<i64> = b[0].iter().map(|v| (*v as f64 * 1e6).round() as i64).collect();
        assert!(levels.len() <= 16, "4 bits → at most 16 levels, got {}", levels.len());
        let runs = b[0].windows(2).filter(|w| w[0] != w[1]).count();
        assert!(runs <= 4800 / 4 + 1, "12 kHz sample-and-hold at 48 kHz changes at most every 4 samples ({runs} changes)");
    }

    #[test]
    fn wow_wobbles_pitch_and_joins_the_loop() {
        let n = 96_000; // a 2 s loop
        let mut b = tone(1000.0, 0.5, n);
        lofi(&mut b, LofiParams { bits: 24.0, rate_hz: None, wow: 1.0 }, SR, n);
        // Zero-crossing rate over short windows varies (the pitch wobbles) …
        let rate = |s: &[f32]| s.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        let rates: Vec<usize> = b[0].chunks(4800).map(rate).collect();
        let (lo, hi) = (rates.iter().min().unwrap(), rates.iter().max().unwrap());
        assert!(hi - lo >= 2, "pitch should wobble: {rates:?}");
        // … and the end runs smoothly into the start.
        let jump = (b[0][n - 1] - b[0][0]).abs();
        assert!(jump < 0.2, "seam jump {jump}");
    }

    #[test]
    fn gate_closes_in_the_gaps_and_opens_for_the_sound() {
        let mut g = Gate::new(GateParams { threshold_db: -30.0, ..Default::default() }, SR);
        let loud: Vec<f64> = (0..4800).map(|i| 0.5 * (2.0 * PI * 300.0 * i as f64 / SR).sin()).collect();
        let hiss: Vec<f64> = (0..24_000).map(|i| 0.003 * (i as f64 * 1.7).sin()).collect();
        let out: Vec<f64> = loud.iter().chain(&hiss).chain(&loud).map(|&x| g.tick(x, x).0).collect();
        let peak = |s: &[f64]| s.iter().fold(0f64, |m, v| m.max(v.abs()));
        assert!(peak(&out[2000..4800]) > 0.45, "open on the sound");
        assert!(peak(&out[4800 + 12_000..4800 + 24_000]) < 1e-5, "shut on the hiss");
        assert!(peak(&out[28_800 + 2000..]) > 0.45, "opens again");
    }

    #[test]
    fn width_is_mono_at_zero_and_wider_above_one() {
        assert_eq!(width(1.0, 0.0, 0.0), (0.5, 0.5));
        assert_eq!(width(1.0, 0.0, 1.0), (1.0, 0.0));
        let (l, r) = width(1.0, 0.0, 2.0);
        assert!((l - 1.5).abs() < 1e-12 && (r + 0.5).abs() < 1e-12);
        assert_eq!(width(0.3, 0.3, 2.0), (0.3, 0.3), "mono stays mono");
    }
}
