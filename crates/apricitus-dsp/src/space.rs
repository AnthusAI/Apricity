//! Time-based effects: an algorithmic reverb (a feedback delay network) and a delay with filtered,
//! optionally ping-pong feedback. Both output only the *wet* signal; the caller mixes it with the
//! dry. They allocate their delay lines in `new` (they run offline, while rendering ahead).

use crate::fx::{Biquad, BiquadKind};

// ------------------------------------------------------------------ reverb

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReverbKind {
    Room,
    Hall,
    Plate,
}

impl ReverbKind {
    /// (decay seconds, predelay ms, damping 0–1) when the score doesn't say.
    pub fn defaults(self) -> (f64, f64, f64) {
        match self {
            ReverbKind::Room => (0.8, 5.0, 0.5),
            ReverbKind::Hall => (2.4, 20.0, 0.4),
            ReverbKind::Plate => (1.6, 10.0, 0.2),
        }
    }

    /// Scale of the delay-line lengths (the size of the space).
    fn size(self) -> f64 {
        match self {
            ReverbKind::Room => 0.45,
            ReverbKind::Hall => 1.0,
            ReverbKind::Plate => 0.6,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReverbParams {
    pub kind: ReverbKind,
    /// RT60: seconds for the tail to fall by 60 dB.
    pub decay_s: f64,
    pub predelay_ms: f64,
    /// High-frequency damping in the tail, 0 (bright) … 1 (dark).
    pub damp: f64,
}

impl ReverbParams {
    pub fn of(kind: ReverbKind) -> Self {
        let (decay_s, predelay_ms, damp) = kind.defaults();
        Self { kind, decay_s, predelay_ms, damp }
    }

    /// How long the tail rings (to −60 dB), in seconds.
    pub fn tail_s(&self) -> f64 {
        self.predelay_ms / 1000.0 + self.decay_s
    }
}

const LINES: usize = 8;
/// Delay-line lengths for a hall, in ms (mutually prime once in samples).
const LINE_MS: [f64; LINES] = [31.3, 37.9, 41.9, 47.3, 53.1, 61.7, 67.3, 73.9];
/// Input diffusers per channel (ms), slightly different left and right for width.
const DIFFUSE_MS: [[f64; 4]; 2] = [[4.77, 3.59, 12.73, 9.30], [4.93, 3.71, 12.31, 9.63]];

struct Line {
    buf: Vec<f64>,
    pos: usize,
}

impl Line {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], pos: 0 }
    }

    /// The sample written `len` ticks ago.
    #[inline]
    fn read(&self) -> f64 {
        self.buf[self.pos]
    }

    #[inline]
    fn write(&mut self, x: f64) {
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
    }
}

/// Schroeder allpass: smears transients into a dense wash before the tank.
struct Allpass {
    line: Line,
    g: f64,
}

impl Allpass {
    #[inline]
    fn tick(&mut self, x: f64) -> f64 {
        let d = self.line.read();
        let v = x + self.g * d;
        self.line.write(v);
        d - self.g * v
    }
}

fn primeish(n: usize) -> usize {
    let is_prime = |k: usize| k >= 2 && (2..).take_while(|d| d * d <= k).all(|d| k % d != 0);
    (n.max(2)..).find(|&k| is_prime(k)).unwrap()
}

pub struct Reverb {
    pre: [Line; 2],
    diffusers: [[Allpass; 4]; 2],
    lines: [Line; LINES],
    gains: [f64; LINES],
    lp: [f64; LINES],
    damp: f64,
    norm: f64,
}

impl Reverb {
    pub fn new(p: ReverbParams, sr: f64) -> Self {
        let samples = |ms: f64| ((ms / 1000.0) * sr).round() as usize;
        let lens: [usize; LINES] = std::array::from_fn(|i| primeish(samples(LINE_MS[i] * p.kind.size())));
        let decay = p.decay_s.max(0.05);
        // Each pass through line i loses 60 dB × (its length / RT60).
        let gains: [f64; LINES] = std::array::from_fn(|i| 10f64.powf(-3.0 * lens[i] as f64 / (decay * sr)));
        let mean_sq = gains.iter().map(|g| g * g).sum::<f64>() / LINES as f64;
        let g = if p.kind == ReverbKind::Plate { 0.75 } else { 0.7 };
        let pre_len = samples(p.predelay_ms).max(1);
        Self {
            pre: [Line::new(pre_len), Line::new(pre_len)],
            diffusers: std::array::from_fn(|c| std::array::from_fn(|k| Allpass { line: Line::new(primeish(samples(DIFFUSE_MS[c][k] * p.kind.size().max(0.6)))), g })),
            lines: std::array::from_fn(|i| Line::new(lens[i])),
            gains,
            lp: [0.0; LINES],
            damp: p.damp.clamp(0.0, 0.95),
            // Unit energy gain: the tank's energy piles up by 1 / (1 − g²).
            norm: (1.0 - mean_sq).sqrt() * 0.5,
        }
    }

    /// One stereo sample in, one wet stereo sample out.
    #[inline]
    pub fn tick(&mut self, l: f64, r: f64) -> (f64, f64) {
        let mut inp = [0.0; 2];
        for (c, x) in [l, r].into_iter().enumerate() {
            let d = self.pre[c].read();
            self.pre[c].write(x);
            inp[c] = self.diffusers[c].iter_mut().fold(d, |v, ap| ap.tick(v));
        }
        let mut s = [0.0; LINES];
        for i in 0..LINES {
            s[i] = self.lines[i].read();
            self.lp[i] = (1.0 - self.damp) * s[i] + self.damp * self.lp[i];
        }
        // Householder feedback: x − (2/N)·Σx, orthogonal, so the only loss is the gains above.
        let fed: [f64; LINES] = std::array::from_fn(|i| self.gains[i] * self.lp[i]);
        let h = fed.iter().sum::<f64>() * 2.0 / LINES as f64;
        for i in 0..LINES {
            self.lines[i].write(fed[i] - h + inp[i % 2]);
        }
        const A: [f64; LINES] = [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0];
        const B: [f64; LINES] = [1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0];
        let (mut wl, mut wr) = (0.0, 0.0);
        for i in 0..LINES {
            wl += A[i] * s[i];
            wr += B[i] * s[i];
        }
        (wl * self.norm, wr * self.norm)
    }
}

// ------------------------------------------------------------------ delay

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DelayParams {
    pub seconds: f64,
    /// 0 … 0.95: level of each repeat relative to the one before.
    pub feedback: f64,
    pub highpass: Option<f64>,
    pub lowpass: Option<f64>,
    /// Repeats alternate left and right.
    pub pingpong: bool,
}

impl DelayParams {
    /// How long the repeats last (to −60 dB), in seconds; capped at 30.
    pub fn tail_s(&self) -> f64 {
        let fb = self.feedback.clamp(0.0, 0.95);
        let repeats = if fb < 1e-3 { 1.0 } else { (1e-3f64).ln() / fb.ln() + 1.0 };
        (self.seconds * repeats).min(30.0)
    }
}

pub struct Delay {
    lines: [Line; 2],
    fb: f64,
    pingpong: bool,
    filters: [Option<Biquad>; 2],
}

impl Delay {
    pub fn new(p: DelayParams, sr: f64) -> Self {
        let len = ((p.seconds * sr).round() as usize).max(1);
        let q = std::f64::consts::FRAC_1_SQRT_2;
        Self {
            lines: [Line::new(len), Line::new(len)],
            fb: p.feedback.clamp(0.0, 0.95),
            pingpong: p.pingpong,
            filters: [p.highpass.map(|hz| Biquad::new(BiquadKind::HighPass { hz, q }, sr)), p.lowpass.map(|hz| Biquad::new(BiquadKind::LowPass { hz, q }, sr))],
        }
    }

    #[inline]
    fn tone(&mut self, ch: usize, mut x: f64) -> f64 {
        for f in self.filters.iter_mut().flatten() {
            x = f.tick(ch, x);
        }
        x
    }

    /// One stereo sample in, the repeats out (wet only).
    #[inline]
    pub fn tick(&mut self, l: f64, r: f64) -> (f64, f64) {
        let (dl, dr) = (self.lines[0].read(), self.lines[1].read());
        let (wl, wr) = if self.pingpong {
            // Mono in on the left; each repeat crosses to the other side.
            (0.5 * (l + r) + self.fb * dr, self.fb * dl)
        } else {
            (l + self.fb * dl, r + self.fb * dr)
        };
        let (wl, wr) = (self.tone(0, wl), self.tone(1, wr));
        self.lines[0].write(wl);
        self.lines[1].write(wr);
        (dl, dr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    /// RT60 from an impulse response by Schroeder backward integration (fit −5 … −25 dB, ×3).
    fn rt60(ir: &[f64]) -> f64 {
        let mut e: Vec<f64> = ir.iter().map(|x| x * x).collect();
        for i in (0..e.len() - 1).rev() {
            e[i] += e[i + 1];
        }
        let db = |i: usize| 10.0 * (e[i] / e[0]).log10();
        let t5 = (0..e.len()).find(|&i| db(i) < -5.0).unwrap();
        let t25 = (0..e.len()).find(|&i| db(i) < -25.0).unwrap();
        3.0 * (t25 - t5) as f64 / SR
    }

    #[test]
    fn reverb_decays_in_the_time_asked() {
        for (kind, decay) in [(ReverbKind::Room, 0.6), (ReverbKind::Hall, 2.4), (ReverbKind::Plate, 1.5)] {
            let mut r = Reverb::new(ReverbParams { kind, decay_s: decay, predelay_ms: 10.0, damp: 0.0 }, SR);
            let ir: Vec<f64> = (0..(SR * decay * 2.0) as usize).map(|i| r.tick(if i == 0 { 1.0 } else { 0.0 }, if i == 0 { 1.0 } else { 0.0 }).0).collect();
            let got = rt60(&ir);
            assert!((got - decay).abs() / decay < 0.15, "{kind:?}: RT60 {got:.2} s, asked {decay}");
            let onset = ir.iter().position(|x| x.abs() > 1e-6).unwrap();
            assert!(onset >= (0.010 * SR) as usize, "{kind:?}: predelay respected (onset at {onset})");
        }
    }

    #[test]
    fn reverb_is_wide_and_about_unity_energy() {
        let mut r = Reverb::new(ReverbParams::of(ReverbKind::Hall), SR);
        let mut seed = 1u32;
        let mut noise = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as f64 / u32::MAX as f64 - 0.5
        };
        let n = (SR * 6.0) as usize;
        let (mut ein, mut el, mut er, mut lr) = (0.0, 0.0, 0.0, 0.0);
        for i in 0..n {
            let x = noise();
            let (l, rr) = r.tick(x, x);
            if i > n / 2 {
                ein += x * x;
                el += l * l;
                er += rr * rr;
                lr += l * rr;
            }
        }
        let gain_db = 10.0 * (el / ein).log10();
        assert!(gain_db.abs() < 6.0, "wet level {gain_db:.1} dB relative to the input");
        let corr = lr / (el * er).sqrt();
        assert!(corr.abs() < 0.5, "left and right decorrelated: {corr:.2}");
    }

    #[test]
    fn delay_repeats_on_time_and_fade_by_the_feedback() {
        let mut d = Delay::new(DelayParams { seconds: 0.25, feedback: 0.5, highpass: None, lowpass: None, pingpong: false }, SR);
        let out: Vec<f64> = (0..(SR * 1.1) as usize).map(|i| d.tick(if i == 0 { 1.0 } else { 0.0 }, 0.0).0).collect();
        let step = (0.25 * SR) as usize;
        for (k, want) in [(1, 1.0), (2, 0.5), (3, 0.25), (4, 0.125)] {
            assert!((out[k * step] - want).abs() < 1e-9, "repeat {k}: {} (want {want})", out[k * step]);
        }
        assert_eq!(out.iter().filter(|x| x.abs() > 1e-12).count(), 4, "nothing between the repeats");
    }

    #[test]
    fn pingpong_alternates_sides() {
        let mut d = Delay::new(DelayParams { seconds: 0.1, feedback: 0.6, highpass: None, lowpass: None, pingpong: true }, SR);
        let out: Vec<(f64, f64)> = (0..(SR * 0.45) as usize).map(|i| d.tick(if i == 0 { 1.0 } else { 0.0 }, 0.0)).collect();
        let step = (0.1 * SR) as usize;
        assert!(out[step].0 > 0.4 && out[step].1 == 0.0, "first repeat left");
        assert!(out[2 * step].1 > 0.2 && out[2 * step].0 == 0.0, "second repeat right");
        assert!(out[3 * step].0 > 0.1 && out[3 * step].1 == 0.0, "third left again");
    }

    #[test]
    fn delay_tone_filters_darken_each_repeat() {
        let mut d = Delay::new(DelayParams { seconds: 0.05, feedback: 0.7, highpass: Some(300.0), lowpass: Some(2000.0), pingpong: false }, SR);
        let n = (SR * 0.4) as usize;
        let out: Vec<f64> = (0..n).map(|i| d.tick(if i == 0 { 1.0 } else { 0.0 }, 0.0).0).collect();
        // Each repeat passes the filters again, so its high-frequency content keeps dropping:
        // measure how spiky (peak / RMS) each repeat's window is.
        let step = (0.05 * SR) as usize;
        let crest = |k: usize| {
            let w = &out[k * step..(k + 1) * step];
            let rms = (w.iter().map(|x| x * x).sum::<f64>() / w.len() as f64).sqrt();
            w.iter().fold(0f64, |m, x| m.max(x.abs())) / rms
        };
        assert!(crest(1) > crest(3) && crest(3) > crest(5), "{} {} {}", crest(1), crest(3), crest(5));
        assert!(DelayParams { seconds: 0.5, feedback: 0.5, highpass: None, lowpass: None, pingpong: false }.tail_s() > 5.0);
    }
}
