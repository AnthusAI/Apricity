//! Automation curves: parameter changes over time during rendering.

/// Interpolation scale for automation curves.
#[derive(Debug, Clone, Copy)]
pub enum Scale {
    Linear,
    Log,
}

/// Determine the appropriate scale for a target parameter.
pub fn scale_for(target: &str) -> Scale {
    matches!(
        target,
        "filter"
            | "filter.cutoff"
            | "filter2.cutoff"
            | "eq.lowcut"
            | "eq.highcut"
            | "eq2.lowcut"
            | "eq2.highcut"
            | "eq3.lowcut"
            | "eq3.highcut"
            | "eq4.lowcut"
            | "eq4.highcut"
            | "eq5.lowcut"
            | "eq5.highcut"
    )
    .then(|| Scale::Log)
    .unwrap_or(Scale::Linear)
}

/// A curve that interpolates between breakpoints, evaluated at render time.
#[derive(Debug, Clone)]
pub struct Curve {
    /// Interpolation points: (beat, value).
    points: Vec<(f64, f64)>,
    /// Step mode: hold each value until the next point instead of ramping.
    step: bool,
    /// Sample rate in Hz.
    sample_rate: f64,
    /// Samples per beat.
    spb: f64,
    /// Offset from the start of the piece in beats (for `--bars` start).
    offset_beats: f64,
    /// Interpolation scale for this curve.
    scale: Scale,
}

impl Curve {
    /// Create a curve from a lane specification.
    /// `sr` is sample rate in Hz, `secs_per_beat` is seconds per beat (60.0 / tempo).
    /// `offset_beats` is used when rendering a subset of the piece with `--bars`.
    pub fn from_lane(
        points: Vec<(f64, f64)>,
        step: bool,
        scale: Scale,
        sr: f64,
        secs_per_beat: f64,
        offset_beats: f64,
    ) -> Self {
        let spb = sr * secs_per_beat;
        Curve {
            points,
            step,
            sample_rate: sr,
            spb,
            offset_beats,
            scale,
        }
    }

    /// Evaluate the curve at a sample index (0-based).
    /// For looping, `i % n` where n is loop_frames.
    pub fn value_at(&self, frame: u64) -> f64 {
        if self.points.is_empty() {
            return 0.0;
        }
        if self.points.len() == 1 {
            return self.points[0].1;
        }

        // Beat position: offset_beats + frame / spb
        let beat = self.offset_beats + frame as f64 / self.spb;

        // Find the surrounding points
        let mut lo_idx = 0;
        while lo_idx + 1 < self.points.len() && self.points[lo_idx + 1].0 <= beat {
            lo_idx += 1;
        }

        let lo = self.points[lo_idx];
        if lo_idx == self.points.len() - 1 {
            // Past the last point: hold the last value
            return lo.1;
        }

        let hi = self.points[lo_idx + 1];
        if beat <= lo.0 {
            // Before the first point: hold the first value
            return lo.1;
        }

        if self.step {
            // Step mode: hold until the next point
            return lo.1;
        }

        // Interpolation: linear for most parameters, logarithmic for frequencies
        let t = (beat - lo.0) / (hi.0 - lo.0);
        match self.scale {
            Scale::Linear => lo.1 * (1.0 - t) + hi.1 * t,
            Scale::Log => (lo.1.ln() + (hi.1.ln() - lo.1.ln()) * t).exp(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve(points: &[[f64; 2]], step: bool, scale: Scale) -> Curve {
        let vec_points: Vec<(f64, f64)> = points.iter().map(|p| (p[0], p[1])).collect();
        Curve::from_lane(vec_points, step, scale, 48000.0, 0.02, 0.0) // 48 kHz, 960 spb (quarter note = 1 beat)
    }

    #[test]
    fn linear_interpolation() {
        let c = curve(&[[0.0, 100.0], [4.0, 200.0]], false, Scale::Linear);
        assert!(c.value_at(0) == 100.0); // at beat 0
        assert!(c.value_at(960 * 2) > 145.0 && c.value_at(960 * 2) < 155.0); // midpoint at beat 2
        assert!(c.value_at(960 * 4) == 200.0); // at beat 4
    }

    #[test]
    fn step_mode() {
        let c = curve(&[[0.0, 100.0], [2.0, 200.0]], true, Scale::Linear);
        assert!(c.value_at(0) == 100.0);
        assert!(c.value_at(960) == 100.0); // step holds until beat 2
        assert!(c.value_at(960 * 2) == 200.0); // at beat 2, jumps to 200
    }

    #[test]
    fn hold_before_and_after() {
        let c = curve(&[[2.0, 150.0]], false, Scale::Linear);
        assert!(c.value_at(0) == 150.0); // before first point: hold first value
        assert!(c.value_at(960 * 5) == 150.0); // after last point: hold last value
    }

    #[test]
    fn offset_beats_shifts_evaluation() {
        let c1_points: Vec<(f64, f64)> = vec![(0.0, 100.0), (4.0, 200.0)];
        let c2_points: Vec<(f64, f64)> = vec![(0.0, 100.0), (4.0, 200.0)];
        let c1 = Curve::from_lane(c1_points, false, Scale::Linear, 48000.0, 0.02, 0.0);
        let c2 = Curve::from_lane(c2_points, false, Scale::Linear, 48000.0, 0.02, 4.0);

        // At frame 0, c1 is at beat 0 (value 100), c2 is at beat 4 (value 200)
        assert!(c1.value_at(0) == 100.0);
        assert!(c2.value_at(0) == 200.0);

        // At frame 4*960 (beat 4 for c1), c1 is at beat 4 (value 200), c2 is at beat 8 (still 200)
        assert!(c1.value_at(960 * 4) == 200.0);
        assert!(c2.value_at(960 * 4) == 200.0);
    }

    #[test]
    fn volume_automation_applies_gain() {
        // Test that a volume curve from -60dB to 0dB works correctly
        let c_points: Vec<(f64, f64)> = vec![(0.0, -60.0), (4.0, 0.0)];
        let c = Curve::from_lane(c_points, false, Scale::Linear, 48000.0, 0.02, 0.0);

        // At beat 0: -60dB (silent)
        let v0 = c.value_at(0);
        assert_eq!(v0, -60.0);

        // At beat 4: 0dB (full volume)
        let v4 = c.value_at(960 * 4);
        assert_eq!(v4, 0.0);
    }

    #[test]
    fn log_scale_frequency_interpolation() {
        // Test that frequency curves use logarithmic interpolation
        let c_points: Vec<(f64, f64)> = vec![(0.0, 200.0), (8.0, 20000.0)];
        let c = Curve::from_lane(c_points, false, Scale::Log, 48000.0, 0.5, 0.0);
        // secs_per_beat = 0.5 => spb = 48000 * 0.5 = 24000

        // At beat 4 (geometric mean): sqrt(200 * 20000) = 2000
        let v4 = c.value_at((4.0 * 24000.0) as u64);
        assert!((v4 - 2000.0).abs() < 0.5, "beat 4: {} (expected 2000)", v4);

        // At beat 1: exp(ln(200) + 1/8 * (ln(20000) - ln(200)))
        let v1 = c.value_at((1.0 * 24000.0) as u64);
        assert!((v1 - 355.7).abs() < 0.5, "beat 1: {} (expected 355.7)", v1);
    }

    #[test]
    fn linear_scale_frequency_interpolation() {
        // Test that linear interpolation works for non-log scales
        let c_points: Vec<(f64, f64)> = vec![(0.0, 200.0), (8.0, 20000.0)];
        let c = Curve::from_lane(c_points, false, Scale::Linear, 48000.0, 0.5, 0.0);
        // secs_per_beat = 0.5 => spb = 48000 * 0.5 = 24000

        // At beat 4 (arithmetic mean): 200 + (20000-200)*0.5 = 10100
        let v4 = c.value_at((4.0 * 24000.0) as u64);
        assert!((v4 - 10100.0).abs() < 0.5, "beat 4: {} (expected 10100)", v4);
    }
}
