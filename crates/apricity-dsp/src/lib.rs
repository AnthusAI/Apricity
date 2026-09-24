//! Apricity DSP: time-stretching / pitch-shifting (Rubber Band) and signal utilities.

pub mod color;
pub mod fx;
pub mod resample;
pub mod space;
pub mod rubberband;

pub use rubberband::{stretch_offline, StretchParams, WarpMode};

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sr: u32, secs: f32) -> Vec<f32> {
        (0..(sr as f32 * secs) as usize)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / sr as f32).sin() * 0.5)
            .collect()
    }

    /// Dominant frequency by zero-crossing count over the middle of the signal.
    fn zc_freq(x: &[f32], sr: u32) -> f32 {
        let mid = &x[x.len() / 4..x.len() * 3 / 4];
        let crossings = mid.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f32 * sr as f32 / mid.len() as f32
    }

    #[test]
    fn stretches_length() {
        let sr = 44100;
        let x = vec![sine(440.0, sr, 2.0)];
        for mode in [WarpMode::Beats, WarpMode::Complex, WarpMode::Texture] {
            let y = stretch_offline(&x, sr, &StretchParams { time_ratio: 1.5, mode, ..Default::default() });
            let expect = x[0].len() as f64 * 1.5;
            let got = y[0].len() as f64;
            assert!((got - expect).abs() / expect < 0.01, "{mode:?}: {got} vs {expect}");
            let f = zc_freq(&y[0], sr);
            assert!((f - 440.0).abs() < 5.0, "{mode:?}: pitch drifted to {f}");
        }
    }

    #[test]
    fn shifts_pitch() {
        let sr = 44100;
        let x = vec![sine(440.0, sr, 2.0)];
        let y = stretch_offline(&x, sr, &StretchParams { time_ratio: 1.0, semitones: 3.0, ..Default::default() });
        let f = zc_freq(&y[0], sr);
        let expect = 440.0 * 2f32.powf(3.0 / 12.0);
        assert!((f - expect).abs() < 5.0, "{f} vs {expect}");
        assert!((y[0].len() as i64 - x[0].len() as i64).abs() < 512);
    }

    #[test]
    fn empty_input_is_empty_output() {
        let y = stretch_offline(&[vec![], vec![]], 48000, &StretchParams { time_ratio: 1.5, semitones: 2.0, ..Default::default() });
        assert_eq!(y, vec![Vec::<f32>::new(), Vec::new()]);
    }

    #[test]
    fn key_frames_move_events() {
        // A click at 1.0s should land at 1.5s when warped with a key frame 1.0s -> 1.5s.
        let sr = 44100;
        let mut x = vec![0.0f32; sr as usize * 3];
        for i in 0..64 {
            x[sr as usize + i] = 0.9 * (1.0 - i as f32 / 64.0);
        }
        let y = stretch_offline(
            &[x],
            sr,
            &StretchParams {
                time_ratio: 1.0,
                key_frames: vec![(sr as usize, sr as usize * 3 / 2)],
                mode: WarpMode::Beats,
                ..Default::default()
            },
        );
        let peak = y[0].iter().enumerate().max_by(|a, b| a.1.abs().total_cmp(&b.1.abs())).unwrap().0;
        let target = sr as usize * 3 / 2;
        assert!((peak as i64 - target as i64).abs() < 1500, "click at {peak}, wanted ~{target}");
    }
}
