//! NNLS note templates, beat aggregation, and chord recognition. A direct port of the matching
//! sections of `harmony2_ref.py`.

use crate::cqt::{BINS_PER_SEMITONE, MIDI_C1, N_BINS};
use crate::nnls::{nnls, Matrix};

pub const N_SEMITONES: usize = 84;

const HARMONIC_SEMITONES: [usize; 6] = [0, 12, 19, 24, 28, 31];
const HARMONIC_WEIGHTS: [f64; 6] = [1.0, 0.6, 0.4, 0.3, 0.2, 0.15];

pub const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// `(name, intervals)`, in the same order as the Python reference's `QUALITIES` dict (insertion
/// order matters only for tie-breaking, which the reference's `if score > best[3]` also leaves
/// to iteration order -- kept identical here).
pub const QUALITIES: &[(&str, &[i32])] = &[
    ("", &[0, 4, 7]),
    ("m", &[0, 3, 7]),
    ("dim", &[0, 3, 6]),
    ("aug", &[0, 4, 8]),
    ("sus2", &[0, 2, 7]),
    ("sus4", &[0, 5, 7]),
    ("7", &[0, 4, 7, 10]),
    ("maj7", &[0, 4, 7, 11]),
    ("m7", &[0, 3, 7, 10]),
    ("mMaj7", &[0, 3, 7, 11]),
    ("m7b5", &[0, 3, 6, 10]),
    ("dim7", &[0, 3, 6, 9]),
];

pub fn semitone_name(midi: i32) -> String {
    let pc = midi.rem_euclid(12) as usize;
    format!("{}{}", NAMES[pc], midi / 12 - 1)
}

/// `(N_SEMITONES, n_frames)`: each semitone's centre CQT bin (bin `3k`, sec 2.1/`fold_to_semitones`).
pub fn fold_to_semitones(c: &[Vec<f64>]) -> Vec<Vec<f64>> {
    (0..N_SEMITONES).map(|k| c[k * BINS_PER_SEMITONE].clone()).collect()
}

/// The `84x84` harmonic template matrix `T`: column `j` is the semitone salience a fundamental
/// at semitone `j` produces.
pub fn build_templates() -> Matrix {
    let mut cols = vec![vec![0.0f64; N_SEMITONES]; N_SEMITONES];
    for j in 0..N_SEMITONES {
        for (h, w) in HARMONIC_SEMITONES.iter().zip(HARMONIC_WEIGHTS) {
            let i = j + h;
            if i < N_SEMITONES {
                cols[j][i] = w;
            }
        }
    }
    Matrix::from_cols(N_SEMITONES, cols)
}

/// One frame's `(N_SEMITONES,)` NNLS activation against `templates` (build once with
/// [`build_templates`] and reuse; `max_iterations` matches the design's fixed cap, `3 * 84`).
pub fn nnls_notes(folded_frame: &[f64], templates: &Matrix, max_iterations: usize) -> Vec<f64> {
    nnls(templates, folded_frame, max_iterations)
}

/// `(N_SEMITONES, n_frames)` NNLS activations, one frame at a time.
pub fn nnls_activations(c_folded: &[Vec<f64>], templates: &Matrix) -> Vec<Vec<f64>> {
    let n_frames = c_folded.first().map_or(0, |r| r.len());
    let max_iter = 3 * N_SEMITONES;
    let mut out = vec![vec![0.0f64; n_frames]; N_SEMITONES];
    for f in 0..n_frames {
        let frame: Vec<f64> = c_folded.iter().map(|row| row[f]).collect();
        let a = nnls_notes(&frame, templates, max_iter);
        for (k, v) in a.into_iter().enumerate() {
            out[k][f] = v;
        }
    }
    out
}

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

/// The median activation over all frames (used by the crate's parity tests, matching the
/// reference test harness's "whole clip is one beat" convention).
pub fn median_activation(a: &[Vec<f64>]) -> Vec<f64> {
    a.iter().map(|row| median(row.clone())).collect()
}

/// Each CQT frame's centre time in seconds: frame `i` is centred on sample `i*hop` of the
/// (unpadded) input, since `cqt()` pads by `n_fft/2` on both sides before framing.
pub fn frame_times(n_frames: usize, hop: usize, sr: f64) -> Vec<f64> {
    (0..n_frames).map(|i| (i * hop) as f64 / sr).collect()
}

/// `(n_beats, N_SEMITONES)`: the per-beat median activation, then a semitone-axis local-max pick
/// (a note's own-bin neighbours are leakage/harmonics, not a second note). `a` is
/// `(N_SEMITONES, n_frames)`, row-major per semitone (matching [`nnls_activations`]'s output).
pub fn beat_aggregate(a: &[Vec<f64>], frame_times: &[f64], tempo: f64, offset_beats: f64, n_beats: usize) -> Vec<Vec<f64>> {
    let spb = 60.0 / tempo;
    let mut b = vec![vec![0.0f64; N_SEMITONES]; n_beats];
    for beat in 0..n_beats {
        let t0 = (offset_beats + beat as f64) * spb;
        let t1 = (offset_beats + beat as f64 + 1.0) * spb;
        let sel: Vec<usize> = frame_times.iter().enumerate().filter(|&(_, &t)| t >= t0 && t < t1).map(|(i, _)| i).collect();
        if sel.is_empty() {
            continue;
        }
        for (semitone, row) in a.iter().enumerate() {
            let vals: Vec<f64> = sel.iter().map(|&f| row[f]).collect();
            b[beat][semitone] = median(vals);
        }
    }
    let mut p = vec![vec![0.0f64; N_SEMITONES]; n_beats];
    for beat in 0..n_beats {
        let v = &b[beat];
        for i in 0..N_SEMITONES {
            let left = if i > 0 { v[i - 1] } else { 0.0 };
            let right = if i + 1 < N_SEMITONES { v[i + 1] } else { 0.0 };
            if v[i] > 0.0 && v[i] >= left && v[i] >= right {
                p[beat][i] = v[i];
            }
        }
    }
    p
}

/// `(root_pc, quality, bass_pc, score)` for one combined `(N_SEMITONES,)` activation vector (sec
/// 2.4). `known_bass_pc` is the score's own bass pitch class when known; otherwise the lowest
/// note with >= 25% of the loudest activation is used.
pub fn recognise_chord(activation: &[f64], known_bass_pc: Option<usize>) -> Option<(usize, &'static str, usize, f64)> {
    let total: f64 = activation.iter().sum();
    if total <= 0.0 {
        return None;
    }
    let mut pcp = [0.0f64; 12];
    for (i, &x) in activation.iter().enumerate() {
        pcp[(MIDI_C1 as usize + i) % 12] += x;
    }
    let sum: f64 = pcp.iter().sum();
    for v in pcp.iter_mut() {
        *v /= sum;
    }
    let bass_pc = match known_bass_pc {
        Some(b) => b,
        None => {
            // sec 2.4's floor: "at or above G1 (49 Hz)". The reference's 84-row NNLS
            // simplification can, on a real low-register stem, put spurious post-NNLS activation
            // an octave below the true fundamental; below-G1 activation is never a real bass note
            // at this register, so the audio-only fallback never considers it. This fallback is
            // only reached when the caller has no known bass from the score (sec 2.3).
            let floor_idx = (31i32 - MIDI_C1).max(0) as usize; // G1 = MIDI 31
            let max_v = activation.iter().cloned().fold(0.0f64, f64::max);
            let thr = 0.25 * max_v;
            let low = activation
                .iter()
                .enumerate()
                .skip(floor_idx)
                .find(|&(_, &v)| v >= thr)
                .map(|(i, _)| i)
                .unwrap_or_else(|| {
                    activation
                        .iter()
                        .enumerate()
                        .skip(floor_idx)
                        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                        .map(|(i, _)| i)
                        .unwrap_or_else(|| activation.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).map(|(i, _)| i).unwrap())
                });
            (MIDI_C1 as usize + low) % 12
        }
    };
    let mut best: Option<(usize, &'static str, usize, f64)> = None;
    for root in 0..12 {
        for &(quality, intervals) in QUALITIES {
            let tones: Vec<usize> = intervals.iter().map(|iv| ((root as i32 + iv).rem_euclid(12)) as usize).collect();
            let on: f64 = tones.iter().map(|&p| pcp[p]).sum();
            let off: f64 = (0..12).filter(|p| !tones.contains(p)).map(|p| pcp[p]).sum();
            let mut score = on - 1.5 * off - 0.05 * (intervals.len().saturating_sub(3)) as f64;
            score += if tones.contains(&bass_pc) { 0.15 } else { -0.15 };
            if best.map_or(true, |b| score > b.3) {
                best = Some((root, quality, bass_pc, score));
            }
        }
    }
    best
}

/// How well `activation` matches a SPECIFIC written chord (sec 2.5's `target`), not the best over
/// all roots/qualities. Mirrors `recognise_chord`'s scoring shape for one named chord.
pub fn chord_match_score(activation: &[f64], root_pc: usize, quality: &str, bass_pc: Option<usize>) -> f64 {
    let total: f64 = activation.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    let mut pcp = [0.0f64; 12];
    for (i, &x) in activation.iter().enumerate() {
        pcp[(MIDI_C1 as usize + i) % 12] += x;
    }
    let sum: f64 = pcp.iter().sum();
    for v in pcp.iter_mut() {
        *v /= sum;
    }
    let intervals = QUALITIES.iter().find(|&&(q, _)| q == quality).map(|&(_, iv)| iv).unwrap_or(&[0, 4, 7]);
    let tones: Vec<usize> = intervals.iter().map(|iv| ((root_pc as i32 + iv).rem_euclid(12)) as usize).collect();
    let on: f64 = tones.iter().map(|&p| pcp[p]).sum();
    let off: f64 = (0..12).filter(|p| !tones.contains(p)).map(|p| pcp[p]).sum();
    let mut score = on - 1.5 * off - 0.05 * (intervals.len().saturating_sub(3)) as f64;
    if let Some(b) = bass_pc {
        score += if tones.contains(&b) { 0.15 } else { -0.15 };
    }
    score
}

/// Rolls `span_activation` by every semitone shift in `-6..6`, `other_activation` held fixed,
/// scored against the written `(target_root_pc, target_quality, target_bass_pc)` (sec 3.2).
/// Returns `(shift, score)` pairs, `shift` ascending.
pub fn transposition_map(span_activation: &[f64], other_activation: &[f64], target_root_pc: usize, target_quality: &str, target_bass_pc: Option<usize>) -> Vec<(i32, f64)> {
    let n = span_activation.len();
    (-6..6)
        .map(|s: i32| {
            let mut rolled = vec![0.0f64; n];
            for i in 0..n {
                let src = (i as i32 - s).rem_euclid(n as i32) as usize;
                rolled[i] = span_activation[src];
            }
            let combo: Vec<f64> = rolled.iter().zip(other_activation).map(|(a, b)| a + b).collect();
            (s, chord_match_score(&combo, target_root_pc, target_quality, target_bass_pc))
        })
        .collect()
}

/// Sanity: `N_BINS` folds evenly into `N_SEMITONES` groups of `BINS_PER_SEMITONE`.
const _: () = assert!(N_BINS == N_SEMITONES * BINS_PER_SEMITONE);
