//! An immutable, fully rendered loop: one stereo **stem** per track (post track-effects, pre-fader),
//! plus the master chain's settings. Built on the control thread; shared with the audio thread
//! through an `Arc`. The audio thread applies live fader/mute/solo and runs the master chain.

use crate::master::{run_looped, MasterParams};
use std::sync::Arc;

pub type Stereo = [Vec<f32>; 2];

/// Most stems an arrangement may hold (live controls are a fixed-size array on the audio thread).
pub const MAX_STEMS: usize = 64;

/// A rendered buffer placed on the loop's timeline (the renderer sums these into stems).
pub struct Placement {
    /// Frame (within the arrangement) where the buffer starts sounding.
    pub start: usize,
    /// Frames of the buffer to skip (when a range cut into the middle of an event).
    pub skip: usize,
    pub buf: Arc<Stereo>,
    pub gain: f32,
}

impl Placement {
    pub fn len(&self) -> usize {
        self.buf[0].len().saturating_sub(self.skip)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One track's (or bus's) audio for the whole loop.
pub struct Stem {
    pub name: String,
    pub buf: Arc<Stereo>,
    /// −1 (left) … 1 (right).
    pub pan: f32,
    /// Keeps playing when something else is soloed (a bus: what reaches it already follows solo).
    pub solo_safe: bool,
}

/// Live, per-track mixer controls (the audio thread's copy).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrackControl {
    /// Linear gain on top of the scored level.
    pub gain: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for TrackControl {
    fn default() -> Self {
        Self { gain: 1.0, mute: false, solo: false }
    }
}

pub const UNITY: [TrackControl; MAX_STEMS] = [TrackControl { gain: 1.0, mute: false, solo: false }; MAX_STEMS];

pub struct Arrangement {
    pub sample_rate: u32,
    pub frames_per_beat: f64,
    pub beats_per_bar: u32,
    /// Loop length in frames.
    pub length: usize,
    pub stems: Vec<Stem>,
    pub master: MasterParams,
}

impl Arrangement {
    /// A single-stem arrangement summed from placements (used by tests and the browser, which
    /// hands over one pre-mixed loop). No master processing beyond what `master` says (none).
    pub fn new(sample_rate: u32, frames_per_beat: f64, beats_per_bar: u32, length: usize, placements: Vec<Placement>) -> Self {
        let buf = sum_placements(length, &placements);
        Self::from_stems(sample_rate, frames_per_beat, beats_per_bar, length, vec![Stem { name: "mix".into(), buf: Arc::new(buf), pan: 0.0, solo_safe: false }], MasterParams::default())
    }

    pub fn from_stems(sample_rate: u32, frames_per_beat: f64, beats_per_bar: u32, length: usize, mut stems: Vec<Stem>, master: MasterParams) -> Self {
        stems.truncate(MAX_STEMS);
        Self { sample_rate, frames_per_beat, beats_per_bar, length, stems, master }
    }

    pub fn frames_per_bar(&self) -> f64 {
        self.frames_per_beat * self.beats_per_bar as f64
    }

    /// Add frames [pos, pos + n) (no wrapping) of every stem into `out`, scaled by `gain`, with
    /// live controls. Real-time safe: no allocation, no locks.
    pub fn mix_into(&self, pos: usize, out: &mut [&mut [f32]; 2], n: usize, gain: f32, controls: &[TrackControl]) {
        let n = n.min(self.length.saturating_sub(pos));
        let any_solo = self.stems.iter().enumerate().any(|(i, _)| controls.get(i).is_some_and(|c| c.solo));
        for (i, stem) in self.stems.iter().enumerate() {
            let c = controls.get(i).copied().unwrap_or_default();
            if c.mute || (any_solo && !c.solo && !stem.solo_safe) {
                continue;
            }
            let (pl, pr) = apricitus_dsp::fx::balance(stem.pan as f64);
            let g = [gain * c.gain * pl as f32, gain * c.gain * pr as f32];
            for (ch, dst) in out.iter_mut().enumerate() {
                let src = &stem.buf[ch][pos..pos + n];
                for (d, s) in dst[..n].iter_mut().zip(src) {
                    *d += s * g[ch];
                }
            }
        }
    }

    /// The stems summed with default controls, before the master chain.
    pub fn bounce_raw(&self) -> Stereo {
        let mut l = vec![0.0; self.length];
        let mut r = vec![0.0; self.length];
        self.mix_into(0, &mut [&mut l, &mut r], self.length, 1.0, &UNITY);
        [l, r]
    }

    /// The finished loop: stems through the master chain. The chain runs over two cycles and the
    /// second is kept, so compressor/limiter state at the loop's start matches playback.
    pub fn bounce(&self) -> Stereo {
        run_looped(&self.bounce_raw(), self.master, self.sample_rate as f64)
    }
}

/// Sum placements into one loop-length stereo buffer (control thread).
pub fn sum_placements(length: usize, placements: &[Placement]) -> Stereo {
    let mut out = [vec![0.0f32; length], vec![0.0f32; length]];
    for p in placements {
        if p.start >= length {
            continue;
        }
        let n = p.len().min(length - p.start);
        for (c, dst) in out.iter_mut().enumerate() {
            let src = &p.buf[c][p.skip..p.skip + n];
            for (d, s) in dst[p.start..p.start + n].iter_mut().zip(src) {
                *d += s * p.gain;
            }
        }
    }
    out
}
