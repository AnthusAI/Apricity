//! Thin FFI to the Rubber Band C API (single-file build compiled by build.rs),
//! plus a safe offline stretcher that supports warp markers via key-frame maps.

use std::os::raw::{c_double, c_int, c_uint};

#[allow(non_camel_case_types)]
type RubberBandState = *mut std::ffi::c_void;

unsafe extern "C" {
    fn rubberband_new(
        sample_rate: c_uint,
        channels: c_uint,
        options: c_int,
        initial_time_ratio: c_double,
        initial_pitch_scale: c_double,
    ) -> RubberBandState;
    fn rubberband_delete(state: RubberBandState);
    fn rubberband_set_expected_input_duration(state: RubberBandState, samples: c_uint);
    fn rubberband_set_max_process_size(state: RubberBandState, samples: c_uint);
    fn rubberband_set_key_frame_map(
        state: RubberBandState,
        count: c_uint,
        from: *mut c_uint,
        to: *mut c_uint,
    );
    fn rubberband_study(state: RubberBandState, input: *const *const f32, samples: c_uint, fin: c_int);
    fn rubberband_process(state: RubberBandState, input: *const *const f32, samples: c_uint, fin: c_int);
    fn rubberband_available(state: RubberBandState) -> c_int;
    fn rubberband_retrieve(state: RubberBandState, output: *const *mut f32, samples: c_uint) -> c_uint;
}

mod opt {
    pub const PROCESS_OFFLINE: i32 = 0x0000_0000;
    pub const TRANSIENTS_CRISP: i32 = 0x0000_0000;
    pub const TRANSIENTS_SMOOTH: i32 = 0x0000_0200;
    pub const DETECTOR_PERCUSSIVE: i32 = 0x0000_0400;
    pub const WINDOW_LONG: i32 = 0x0020_0000;
    pub const FORMANT_PRESERVED: i32 = 0x0100_0000;
    pub const PITCH_HIGH_QUALITY: i32 = 0x0200_0000;
    pub const CHANNELS_TOGETHER: i32 = 0x1000_0000;
    pub const ENGINE_FASTER: i32 = 0x0000_0000;
    pub const ENGINE_FINER: i32 = 0x2000_0000;
}

/// Rough analogue of a DAW's warp modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WarpMode {
    /// Drums and percussive loops: crisp transients (R2 engine, percussive detector).
    Beats,
    /// General material: R3 "finer" engine. The default.
    #[default]
    Complex,
    /// Pads and textures: R3 with smooth transients and long windows.
    Texture,
}

#[derive(Debug, Clone, Default)]
pub struct StretchParams {
    /// Output length / input length for the parts not covered by key frames.
    pub time_ratio: f64,
    /// Transposition in semitones (can be fractional).
    pub semitones: f64,
    /// Warp markers: (input sample, output sample) pairs, strictly increasing in both.
    pub key_frames: Vec<(usize, usize)>,
    pub mode: WarpMode,
    pub preserve_formants: bool,
}

const BLOCK: usize = 1024;

/// Offline time-stretch + pitch-shift of planar audio (`input[channel][frame]`).
pub fn stretch_offline(input: &[Vec<f32>], sample_rate: u32, p: &StretchParams) -> Vec<Vec<f32>> {
    let channels = input.len();
    assert!(channels > 0, "need at least one channel");
    let frames = input[0].len();
    assert!(input.iter().all(|c| c.len() == frames), "channels differ in length");
    if frames == 0 {
        return vec![Vec::new(); channels];
    }
    let ratio = if p.time_ratio > 0.0 { p.time_ratio } else { 1.0 };

    let mut options = opt::PROCESS_OFFLINE | opt::CHANNELS_TOGETHER | opt::PITCH_HIGH_QUALITY;
    options |= match p.mode {
        WarpMode::Beats => opt::ENGINE_FASTER | opt::TRANSIENTS_CRISP | opt::DETECTOR_PERCUSSIVE,
        WarpMode::Complex => opt::ENGINE_FINER,
        WarpMode::Texture => opt::ENGINE_FINER | opt::TRANSIENTS_SMOOTH | opt::WINDOW_LONG,
    };
    if p.preserve_formants {
        options |= opt::FORMANT_PRESERVED;
    }
    let pitch_scale = 2f64.powf(p.semitones / 12.0);

    let expected_out = p
        .key_frames
        .last()
        .map(|&(i, o)| o + ((frames.saturating_sub(i)) as f64 * ratio) as usize)
        .unwrap_or((frames as f64 * ratio) as usize);

    let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(expected_out + BLOCK); channels];

    unsafe {
        let rb = rubberband_new(sample_rate, channels as u32, options, ratio, pitch_scale);
        rubberband_set_expected_input_duration(rb, frames as u32);
        rubberband_set_max_process_size(rb, BLOCK as u32);

        let ptrs_at = |pos: usize| -> Vec<*const f32> {
            input.iter().map(|c| c[pos..].as_ptr()).collect()
        };

        let mut pos = 0;
        while pos < frames {
            let n = BLOCK.min(frames - pos);
            let ptrs = ptrs_at(pos);
            rubberband_study(rb, ptrs.as_ptr(), n as u32, (pos + n >= frames) as c_int);
            pos += n;
        }

        if !p.key_frames.is_empty() {
            let mut from: Vec<u32> = p.key_frames.iter().map(|k| k.0 as u32).collect();
            let mut to: Vec<u32> = p.key_frames.iter().map(|k| k.1 as u32).collect();
            rubberband_set_key_frame_map(rb, from.len() as u32, from.as_mut_ptr(), to.as_mut_ptr());
        }

        let mut scratch: Vec<Vec<f32>> = vec![vec![0.0; BLOCK * 4]; channels];
        let mut drain = |rb: RubberBandState, out: &mut Vec<Vec<f32>>| loop {
            let avail = rubberband_available(rb);
            if avail <= 0 {
                break;
            }
            let n = (avail as usize).min(BLOCK * 4);
            let optrs: Vec<*mut f32> = scratch.iter_mut().map(|c| c.as_mut_ptr()).collect();
            let got = rubberband_retrieve(rb, optrs.as_ptr(), n as u32) as usize;
            for (o, s) in out.iter_mut().zip(&scratch) {
                o.extend_from_slice(&s[..got]);
            }
        };

        pos = 0;
        while pos < frames {
            let n = BLOCK.min(frames - pos);
            let ptrs = ptrs_at(pos);
            rubberband_process(rb, ptrs.as_ptr(), n as u32, (pos + n >= frames) as c_int);
            pos += n;
            drain(rb, &mut out);
        }
        drain(rb, &mut out);
        rubberband_delete(rb);
    }
    out
}
