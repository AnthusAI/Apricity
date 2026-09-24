//! Varispeed: read a signal at an arbitrary, fractional rate with band-limited (windowed-sinc)
//! interpolation. Speed and pitch change together, like a record played at another speed; this is
//! also plain sample-rate conversion.

use std::f64::consts::PI;

/// Zero crossings of the sinc on each side of the read point (at unity cutoff).
const HALF: f64 = 16.0;

/// `out_len` samples read from `x` at positions `start + i * step` (in input samples). When
/// `step > 1` (faster, or down to a lower rate) the kernel low-passes at the new Nyquist, so
/// nothing aliases.
pub fn varispeed(x: &[f32], start: f64, step: f64, out_len: usize) -> Vec<f32> {
    let cutoff = (1.0 / step.max(1e-9)).min(1.0);
    let half = HALF / cutoff; // kernel half-width in input samples
    let n = x.len() as isize;
    (0..out_len)
        .map(|i| {
            let t = start + i as f64 * step;
            let lo = (t - half).ceil() as isize;
            let hi = (t + half).floor() as isize;
            let mut acc = 0.0;
            for k in lo.max(0)..=hi.min(n - 1) {
                let d = t - k as f64;
                let w = 0.42 + 0.5 * (PI * d / half).cos() + 0.08 * (2.0 * PI * d / half).cos(); // Blackman
                let s = if d.abs() < 1e-12 { cutoff } else { (PI * d * cutoff).sin() / (PI * d) };
                acc += x[k as usize] as f64 * s * w;
            }
            acc as f32
        })
        .collect()
}

/// Taps each side of a half-band interpolator (precomputed; used for 2× oversampling).
const HB: usize = 16;

/// sinc at the half-sample offsets k + ½ (so sin(π(k+½)) = ±1), Blackman-windowed over ±HB.
fn halfband() -> [f64; HB] {
    std::array::from_fn(|k| {
        let d = k as f64 + 0.5;
        let w = 0.42 + 0.5 * (PI * d / HB as f64).cos() + 0.08 * (2.0 * PI * d / HB as f64).cos();
        (if k % 2 == 0 { 1.0 } else { -1.0 }) / (PI * d) * w
    })
}

/// Upsample a *loop* 2× (reads wrap around, so the seam stays seamless).
pub fn up2(x: &[f32]) -> Vec<f64> {
    let h = halfband();
    let n = x.len();
    let at = |i: isize| x[i.rem_euclid(n as isize) as usize] as f64;
    let mut out = Vec::with_capacity(2 * n);
    for i in 0..n as isize {
        out.push(at(i));
        out.push((0..HB).map(|k| h[k] * (at(i - k as isize) + at(i + 1 + k as isize))).sum::<f64>());
    }
    out
}

/// Low-pass at the original Nyquist and take every other sample: the inverse of `up2` (wraps).
pub fn down2(y: &[f64]) -> Vec<f32> {
    let h = halfband();
    let m = y.len() as isize;
    let at = |i: isize| y[i.rem_euclid(m) as usize];
    (0..m / 2)
        .map(|j| {
            let c = 2 * j;
            // Half-band FIR: centre tap 1/2, odd taps from the table, even taps zero.
            (0.5 * at(c) + (0..HB).map(|k| 0.5 * h[k] * (at(c - 1 - 2 * k as isize) + at(c + 1 + 2 * k as isize))).sum::<f64>()) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f64, sr: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * PI * hz * i as f64 / sr).sin() as f32).collect()
    }

    /// Frequency by counting upward zero crossings.
    fn freq(x: &[f32], sr: f64) -> f64 {
        let ups = x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        ups as f64 * sr / x.len() as f64
    }

    #[test]
    fn faster_is_higher_like_a_record() {
        let sr = 48_000.0;
        let x = sine(440.0, sr, 48_000);
        let y = varispeed(&x, 0.0, 1.5, 32_000);
        let f = freq(&y[1000..31_000], sr);
        assert!((f - 660.0).abs() < 3.0, "1.5× speed: 440 Hz → {f:.1}");
        let rms = |v: &[f32]| (v.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
        assert!((rms(&y[1000..31_000]) / rms(&x) - 1.0).abs() < 0.01, "level kept");
    }

    #[test]
    fn speeding_up_does_not_alias() {
        // 18 kHz at 2× would fold to 12 kHz without the low-pass; it must vanish instead.
        let sr = 48_000.0;
        let x = sine(18_000.0, sr, 48_000);
        let y = varispeed(&x, 0.0, 2.0, 24_000);
        let peak = y[500..23_500].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak < 0.01, "aliased energy {peak}");
    }

    #[test]
    fn oversampling_round_trips_and_removes_the_upper_band() {
        let sr = 48_000.0;
        let x = sine(1000.0, sr, 4800); // a whole number of cycles: a clean loop
        let up = up2(&x);
        // The in-between samples land on the same sine at twice the rate.
        let err_up = (0..up.len()).map(|i| (up[i] - (2.0 * PI * 1000.0 * i as f64 / (2.0 * sr)).sin()).abs()).fold(0.0, f64::max);
        assert!(err_up < 2e-3, "interpolation error {err_up}");
        let back = down2(&up);
        let err = x.iter().zip(&back).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 2e-3, "round trip error {err}");
        // A tone above the original Nyquist (30 kHz at 96 kHz) is removed, not folded down.
        let hi: Vec<f64> = (0..9600).map(|i| (2.0 * PI * 30_000.0 * i as f64 / (2.0 * sr)).sin()).collect();
        let peak = down2(&hi).iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak < 0.01, "30 kHz leaked through as {peak}");
    }

    #[test]
    fn unity_is_transparent_and_rate_conversion_keeps_pitch() {
        let x = sine(1000.0, 44_100.0, 44_100);
        let same = varispeed(&x, 0.0, 1.0, 44_100);
        let err = x[100..44_000].iter().zip(&same[100..44_000]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(err < 1e-4, "unity step changes nothing: {err}");
        // 44.1 kHz → 48 kHz: step 44100/48000; played at 48 kHz it's still 1 kHz.
        let up = varispeed(&x, 0.0, 44_100.0 / 48_000.0, 48_000);
        let f = freq(&up[1000..47_000], 48_000.0);
        assert!((f - 1000.0).abs() < 3.0, "{f:.1}");
    }
}
