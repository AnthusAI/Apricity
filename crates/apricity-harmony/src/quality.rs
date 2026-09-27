//! `Q`, the chord-quality term; the v1 port onto CQT-folded chroma; `objective_v2`; and the
//! anti-gaming guards. A direct port of the matching sections of `harmony2_ref.py`.

use crate::chord::{notes_from_activation, recognise_chord_full, Heard};
use crate::cqt::MIDI_C1;
use crate::notes::{N_SEMITONES, QUALITIES};
use std::collections::{BTreeSet, HashMap};

/// Pitch-class names spelled with flats, matching `crates/apricity-theory`'s `Chord::name()` and
/// what `stems.json` writes for chord tones, bass and note names.
pub const PITCH_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

pub fn pitch_name_to_pc(name: &str) -> Option<usize> {
    PITCH_NAMES.iter().position(|&n| n == name)
}

// --------------------------------------------------------------------------- extensions, chord matching

const EXTENSION_TONE: &[(&str, i32)] = &[("6", 9), ("9", 2), ("maj9", 2), ("m9", 2), ("add9", 2)];

fn extension_semitone(tag: &str) -> i32 {
    EXTENSION_TONE.iter().find(|&&(t, _)| t == tag).map(|&(_, s)| s).unwrap_or(0)
}

/// Best-matching `QUALITIES` key for a written chord-tones list (pitch classes, root first), e.g.
/// `[0, 4, 7, 11]` (root C) -> `"maj7"`. `None` when there's no exact match (an unmodeled chord).
pub fn written_quality_from_tones(root_pc: usize, chord_tones_pc: &[usize]) -> Option<&'static str> {
    let mut ivs: Vec<i32> = chord_tones_pc.iter().map(|&t| (t as i32 - root_pc as i32).rem_euclid(12)).collect();
    ivs.sort_unstable();
    QUALITIES.iter().find(|&&(_, intervals)| {
        let mut sorted: Vec<i32> = intervals.to_vec();
        sorted.sort_unstable();
        sorted == ivs
    }).map(|&(q, _)| q)
}

// --------------------------------------------------------------------------- Q (sec 2.5)

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Q {
    pub target: f64,
    pub extension: f64,
    pub spacing: f64,
    pub voice_leading: f64,
    pub q: f64,
}

fn q_target(heard: &Heard, written_root_pc: Option<usize>, written_quality: Option<&str>, written_bass_pc: Option<usize>) -> f64 {
    let Some(written_root_pc) = written_root_pc else { return 0.0 };
    let heard_root_pc = PITCH_NAMES.iter().position(|&n| n == heard.root).unwrap_or_else(|| crate::notes::NAMES.iter().position(|&n| n == heard.root).unwrap());
    let heard_bass_pc = PITCH_NAMES.iter().position(|&n| n == heard.bass).unwrap_or_else(|| crate::notes::NAMES.iter().position(|&n| n == heard.bass).unwrap());
    let mut score = if heard_root_pc == written_root_pc { 0.5 } else { 0.0 };
    let want_bass = written_bass_pc.unwrap_or(written_root_pc);
    score += if heard_bass_pc == want_bass { 0.3 } else { 0.0 };
    if let Some(written_quality) = written_quality {
        let heard_intervals = QUALITIES.iter().find(|&&(q, _)| q == heard.quality).map(|&(_, iv)| iv).unwrap_or(&[0, 4, 7]);
        let written_intervals = QUALITIES.iter().find(|&&(q, _)| q == written_quality).map(|&(_, iv)| iv).unwrap_or(&[0, 4, 7]);
        let heard_tones: BTreeSet<usize> = heard_intervals.iter().map(|iv| ((heard_root_pc as i32 + iv).rem_euclid(12)) as usize).collect();
        let written_tones: BTreeSet<usize> = written_intervals.iter().map(|iv| ((written_root_pc as i32 + iv).rem_euclid(12)) as usize).collect();
        if heard_tones.is_subset(&written_tones) {
            score += 0.2;
        }
    }
    score
}

fn q_extension(heard: &Heard, written_quality: Option<&str>, key_scale_pcs: Option<&BTreeSet<usize>>) -> f64 {
    const SEVENTHS: &[&str] = &["7", "maj7", "m7", "mMaj7", "m7b5", "dim7"];
    let heard_root_pc = PITCH_NAMES.iter().position(|&n| n == heard.root).unwrap_or_else(|| crate::notes::NAMES.iter().position(|&n| n == heard.root).unwrap());
    let heard_has_seventh = SEVENTHS.contains(&heard.quality);
    if let Some(wq) = written_quality {
        if SEVENTHS.contains(&wq) {
            return if heard_has_seventh { 1.0 } else { 0.0 };
        }
    }
    if !heard.extensions.is_empty() || heard_has_seventh {
        let Some(key_scale_pcs) = key_scale_pcs else { return 0.5 };
        let tag_pc = if !heard.extensions.is_empty() {
            ((heard_root_pc as i32 + extension_semitone(heard.extensions[0])).rem_euclid(12)) as usize
        } else {
            let iv = if matches!(heard.quality, "7" | "m7" | "mMaj7" | "m7b5") { 10 } else { 11 };
            ((heard_root_pc as i32 + iv).rem_euclid(12)) as usize
        };
        return if key_scale_pcs.contains(&tag_pc) { 0.5 } else { 0.0 };
    }
    0.0
}

const SPACING_MAX_SEMITONES: i32 = 4;
const SPACING_REGISTER_MIDI: i32 = 48; // C3

/// `1 - (pairs of sounding notes <= SPACING_MAX_SEMITONES apart below C3, per note below C3)`.
/// A major 7th sitting a semitone under the bass, in its own octave, is treated as colour, not
/// mud: at most neutral, never a clash (with `allow_maj7_under_bass`, the default, a
/// semitone-apart pair between two different stems, both below C3, is left out of the pair
/// count; any other close low pair still counts).
pub fn q_spacing(notes_by_stem: &HashMap<String, Vec<i32>>, allow_maj7_under_bass: bool) -> f64 {
    let all_notes: Vec<(&str, i32)> = notes_by_stem.iter().flat_map(|(s, ns)| ns.iter().map(move |&n| (s.as_str(), n))).collect();
    let low_count = all_notes.iter().filter(|&&(_, n)| n < SPACING_REGISTER_MIDI).count();
    if low_count == 0 {
        return 1.0;
    }
    // Every unordered pair is visited exactly once (`i < j`), independent of `all_notes`'s order
    // (which depends only on `notes_by_stem`'s own iteration order, not anything musical): a pair
    // counts when AT LEAST ONE of its two notes is below C3, matching this function's own
    // contract ("pairs of sounding notes ... below C3"), not only when the lower-indexed one
    // happens to be.
    let mut pairs = 0usize;
    for i in 0..all_notes.len() {
        let (si, ni) = all_notes[i];
        for j in (i + 1)..all_notes.len() {
            let (sj, nj) = all_notes[j];
            if si == sj {
                continue;
            }
            if ni >= SPACING_REGISTER_MIDI && nj >= SPACING_REGISTER_MIDI {
                continue;
            }
            let d = (ni - nj).abs();
            if d == 0 || d > SPACING_MAX_SEMITONES {
                continue;
            }
            if allow_maj7_under_bass && d == 1 {
                continue;
            }
            pairs += 1;
        }
    }
    (1.0 - pairs as f64 / low_count.max(1) as f64).max(0.0)
}

/// `max(0, 1 - mean nearest-note movement (semitones) / 6)` between this span's and the previous
/// span's note sets; full credit when there's no previous span to compare.
pub fn q_voice_leading(notes_now: &[i32], notes_prev: Option<&[i32]>) -> f64 {
    let Some(notes_prev) = notes_prev.filter(|p| !p.is_empty()) else { return 1.0 };
    if notes_now.is_empty() {
        return 1.0;
    }
    let moves: Vec<f64> = notes_now.iter().map(|&n| notes_prev.iter().map(|&p| (n - p).unsigned_abs() as f64).fold(f64::INFINITY, f64::min)).collect();
    let mean = moves.iter().sum::<f64>() / moves.len() as f64;
    (1.0 - mean / 6.0).max(0.0)
}

/// `Q = 0.5*target + 0.2*extension + 0.15*spacing + 0.15*voice_leading` (sec 2.5).
pub fn compute_q(
    heard: &Heard,
    written_root_pc: Option<usize>,
    written_quality: Option<&str>,
    written_bass_pc: Option<usize>,
    notes_by_stem: &HashMap<String, Vec<i32>>,
    notes_prev: Option<&[i32]>,
    key_scale_pcs: Option<&BTreeSet<usize>>,
) -> Q {
    let target = q_target(heard, written_root_pc, written_quality, written_bass_pc);
    let extension = q_extension(heard, written_quality, key_scale_pcs);
    let spacing = q_spacing(notes_by_stem, true);
    let notes_now: Vec<i32> = notes_by_stem.values().flatten().copied().collect();
    let voice_leading = q_voice_leading(&notes_now, notes_prev);
    let q = 0.5 * target + 0.2 * extension + 0.15 * spacing + 0.15 * voice_leading;
    Q { target, extension, spacing, voice_leading, q }
}

// --------------------------------------------------------------------------- v1 port onto CQT-folded chroma (sec 2.6)

const INTERVAL_K: [f64; 12] = [0.0, 1.00, 0.35, 0.0, 0.0, 0.05, 0.70, 0.0, 0.05, 0.0, 0.30, 1.00];
const DOUBLED_AGAINST_BASS: [usize; 3] = [1, 2, 11];
const COVERAGE_MIN_SHARE: f64 = 0.05;
const COVERAGE_GUARD_PENALTY: f64 = 2.0;
const EXTENSION_GUARD_SHARE: f64 = 0.40;
const EXTENSION_GUARD_PENALTY: f64 = 5.0;
const BASS_ROOT_SEMITONE_WEIGHT: f64 = 1.0;

fn interval_kernel(bass_pair: bool) -> [[f64; 12]; 12] {
    let mut k = [[0.0f64; 12]; 12];
    for p in 0..12 {
        for q in 0..12 {
            let mut v = INTERVAL_K[(p as i32 - q as i32).unsigned_abs() as usize];
            if bass_pair && DOUBLED_AGAINST_BASS.contains(&((p as i32 - q as i32).unsigned_abs() as usize)) {
                v *= 2.0;
            }
            k[p][q] = v;
        }
    }
    k
}

/// `(84,) -> (12,)`, summed (not normalised) mass per pitch class: the v1 port's chroma, the
/// CQT/NNLS analogue of the checker's HPCP chroma (a documented deviation).
pub fn fold_activation_to_chroma(activation: &[f64]) -> [f64; 12] {
    let mut c = [0.0f64; 12];
    for (i, &x) in activation.iter().enumerate() {
        c[(MIDI_C1 as usize + i) % 12] += x;
    }
    c
}

/// Raw (un-inverted) clash and total tonal mass for ONE beat's per-stem chroma vectors: the
/// pairwise interval kernel plus the undiluted bass-vs-root term, with sec 2.6's one change -- a
/// pair of pitch classes that are BOTH chord tones of the span scores 0 in the pairwise kernel (a
/// correctly voiced maj7 stops being the worst case; its register problem, if any, is
/// `spacing`'s job instead).
fn beat_clash(stem_chromas: &HashMap<String, [f64; 12]>, chord_tones_pc: &BTreeSet<usize>, bass_pc: Option<usize>, bass_stem_name: Option<&str>) -> (f64, f64) {
    let names: Vec<&String> = stem_chromas.keys().collect();
    let total_mass: f64 = stem_chromas.values().map(|c| c.iter().sum::<f64>()).sum();
    if total_mass <= 1e-9 {
        return (0.0, 0.0);
    }
    let mut acc = 0.0;
    for i in 0..names.len() {
        let ci = &stem_chromas[names[i]];
        for j in (i + 1)..names.len() {
            let cj = &stem_chromas[names[j]];
            let bass_pair = Some(names[i].as_str()) == bass_stem_name || Some(names[j].as_str()) == bass_stem_name;
            let kernel = interval_kernel(bass_pair);
            for p in 0..12 {
                if ci[p] <= 0.0 {
                    continue;
                }
                for q in 0..12 {
                    if cj[q] <= 0.0 {
                        continue;
                    }
                    let k = if chord_tones_pc.contains(&p) && chord_tones_pc.contains(&q) { 0.0 } else { kernel[p][q] };
                    acc += ci[p] * cj[q] * k;
                }
            }
        }
    }
    let pairwise = acc / (total_mass * total_mass);
    let mut bonus = 0.0;
    if let (Some(bass_pc), Some(bass_stem_name)) = (bass_pc, bass_stem_name) {
        if let Some(bc) = stem_chromas.get(bass_stem_name) {
            for p in 0..12 {
                if bc[p] <= 0.0 {
                    continue;
                }
                let d = (p as i32 - bass_pc as i32).rem_euclid(12).min((bass_pc as i32 - p as i32).rem_euclid(12));
                if d == 1 {
                    bonus += bc[p] * BASS_ROOT_SEMITONE_WEIGHT;
                }
            }
            bonus /= total_mass;
        }
    }
    (pairwise + bonus, total_mass)
}

/// `consonance_v1'` computed the way the checker actually does it: one clash per BEAT (only pitch
/// classes that actually sound together in that beat interact), then the mass-weighted mean
/// across the span's beats. `stem_beat_chromas[name]` is one `[f64; 12]` per beat.
pub fn consonance_v1_ported_per_beat(stem_beat_activations: &HashMap<String, Vec<Vec<f64>>>, chord_tones_pc: &BTreeSet<usize>, bass_pc: Option<usize>, bass_stem_name: Option<&str>) -> f64 {
    let n_beats = stem_beat_activations.values().next().map_or(0, |v| v.len());
    let mut clashes = Vec::with_capacity(n_beats);
    let mut masses = Vec::with_capacity(n_beats);
    for b in 0..n_beats {
        let beat_chromas: HashMap<String, [f64; 12]> = stem_beat_activations.iter().map(|(name, beats)| (name.clone(), fold_activation_to_chroma(&beats[b]))).collect();
        let (clash, mass) = beat_clash(&beat_chromas, chord_tones_pc, bass_pc, bass_stem_name);
        clashes.push(clash);
        masses.push(mass);
    }
    let total_mass: f64 = masses.iter().sum();
    if total_mass <= 1e-9 {
        return 100.0;
    }
    let mean_clash: f64 = clashes.iter().zip(&masses).map(|(&c, &m)| c * m).sum::<f64>() / total_mass;
    100.0 * (1.0 - mean_clash.min(1.0))
}

// --------------------------------------------------------------------------- guards (sec 2.6)

/// The coverage guard (every written chord tone >= [`COVERAGE_MIN_SHARE`] of the span's tonal
/// energy) and the extension guard (a heard extension carrying more than
/// [`EXTENSION_GUARD_SHARE`] of the span's mass -- a 9th louder than the chord is not colour).
/// Returns `(violations, guard_penalty)`.
pub fn check_span_guards(combined: &[f64], chord_tones_pc: &BTreeSet<usize>, heard: Option<&Heard>) -> (Vec<String>, f64) {
    let total: f64 = combined.iter().sum();
    let mut violations = Vec::new();
    let mut guard_penalty = 0.0;
    if total > 0.0 && !chord_tones_pc.is_empty() {
        let chroma = fold_activation_to_chroma(combined);
        let share_total: f64 = chroma.iter().sum();
        if share_total > 0.0 {
            for &t in chord_tones_pc {
                let share = chroma[t] / share_total;
                if share < COVERAGE_MIN_SHARE {
                    violations.push(format!("chord tone {} is only {:.1}% of the tonal energy", PITCH_NAMES[t], share * 100.0));
                    guard_penalty += COVERAGE_GUARD_PENALTY;
                }
            }
        }
    }
    if let Some(heard) = heard {
        if let Some(&tag) = heard.extensions.first() {
            if total > 0.0 {
                let heard_root_pc = PITCH_NAMES.iter().position(|&n| n == heard.root).unwrap_or_else(|| crate::notes::NAMES.iter().position(|&n| n == heard.root).unwrap());
                let ext_pc = ((heard_root_pc as i32 + extension_semitone(tag)).rem_euclid(12)) as usize;
                let chroma = fold_activation_to_chroma(combined);
                let sum: f64 = chroma.iter().sum();
                if sum > 0.0 && chroma[ext_pc] / sum > EXTENSION_GUARD_SHARE {
                    violations.push(format!("extension {} carries {:.0}% of the span's mass", tag, chroma[ext_pc] / sum * 100.0));
                    guard_penalty += EXTENSION_GUARD_PENALTY;
                }
            }
        }
    }
    (violations, guard_penalty)
}

// --------------------------------------------------------------------------- objective_v2 (sec 2.6)

#[derive(Debug, Clone)]
pub struct SpanResult {
    pub heard: Option<Heard>,
    pub consonance_v1: f64,
    pub guard_violations: Vec<String>,
    pub guard_penalty: f64,
    pub q: Q,
    pub objective_v2: f64,
    pub mass: f64,
}

/// One span's `consonance_v1'`, `Q`, guards and `objective_v2 = consonance_v1' - guards + 10*Q`
/// (sec 2.5, 2.6). `stem_activations` is each stem's activation SUMMED over the span's beats
/// (drives chord recognition, the guards and `Q`); `stem_beat_activations` is each stem's
/// PER-BEAT activation for the span and drives `consonance_v1'` (the checker computes clash one
/// beat at a time, then mass-averages -- summing a whole span's beats together first would let
/// notes that never actually sounded in the same beat "clash" against each other).
/// `tonal_mass_floor`, when given, gates `Q` to 0 for a near-silent span.
#[allow(clippy::too_many_arguments)]
pub fn objective_v2_for_span(
    stem_activations: &HashMap<String, Vec<f64>>,
    stem_beat_activations: &HashMap<String, Vec<Vec<f64>>>,
    chord_tones_pc: &BTreeSet<usize>,
    written_root_pc: Option<usize>,
    written_quality: Option<&str>,
    written_bass_pc: Option<usize>,
    bass_stem_name: Option<&str>,
    notes_prev: Option<&[i32]>,
    key_scale_pcs: Option<&BTreeSet<usize>>,
    tonal_mass_floor: Option<f64>,
) -> SpanResult {
    let mut combined = vec![0.0f64; N_SEMITONES];
    for a in stem_activations.values() {
        for (i, &x) in a.iter().enumerate() {
            combined[i] += x;
        }
    }
    let total: f64 = combined.iter().sum();
    let known_bass_pc = if bass_stem_name.is_some() { written_bass_pc } else { None };
    let heard = recognise_chord_full(&combined, known_bass_pc);
    let (violations, guard_penalty) = check_span_guards(&combined, chord_tones_pc, heard.as_ref());

    let bass_pc_for_kernel = heard.as_ref().and_then(|h| PITCH_NAMES.iter().position(|&n| n == h.bass)).or(written_bass_pc);
    let consonance = consonance_v1_ported_per_beat(stem_beat_activations, chord_tones_pc, bass_pc_for_kernel, bass_stem_name);

    let starved = tonal_mass_floor.is_some_and(|f| total < f);
    let q = if heard.is_none() || starved {
        Q { target: 0.0, extension: 0.0, spacing: 1.0, voice_leading: 1.0, q: 0.0 }
    } else {
        let notes_by_stem: HashMap<String, Vec<i32>> = stem_activations.iter().map(|(name, a)| (name.clone(), notes_from_activation(a, 0.15))).collect();
        compute_q(heard.as_ref().unwrap(), written_root_pc, written_quality, written_bass_pc, &notes_by_stem, notes_prev, key_scale_pcs)
    };

    let objective_v2 = consonance - guard_penalty + 10.0 * q.q;
    SpanResult { heard, consonance_v1: consonance, guard_violations: violations, guard_penalty, q, objective_v2, mass: total }
}

#[derive(Debug, Clone, Copy)]
pub struct WindowResult {
    pub consonance_v1: f64,
    pub guard_penalty: f64,
    pub q_mean: f64,
    pub objective_v1: f64,
    pub objective_v2: f64,
}

/// The whole-window `objective_v2 = consonance_v1' - guards + 10*mean(Q)`: the mass-weighted mean
/// per-span `consonance_v1'`, guard penalties summed across spans, and `Q_mean` the plain mean of
/// each span's `Q` (silent spans, whose `Q` is gated to 0, still count in the mean).
pub fn window_objective(span_results: &[SpanResult], span_mass: &[f64]) -> WindowResult {
    let total_mass: f64 = span_mass.iter().sum::<f64>().max(1.0);
    let consonance = if span_results.is_empty() {
        100.0
    } else {
        span_results.iter().zip(span_mass).map(|(r, &m)| r.consonance_v1 * m).sum::<f64>() / total_mass
    };
    let guard_penalty: f64 = span_results.iter().map(|r| r.guard_penalty).sum();
    let q_mean = if span_results.is_empty() { 0.0 } else { span_results.iter().map(|r| r.q.q).sum::<f64>() / span_results.len() as f64 };
    let objective_v1 = (consonance - guard_penalty).max(0.0);
    let objective_v2 = consonance - guard_penalty + 10.0 * q_mean;
    WindowResult { consonance_v1: consonance, guard_penalty, q_mean, objective_v1, objective_v2 }
}

/// A pitch-class name, spelled with sharps, back to its 0..11 index (matches
/// `notes::NAMES`'s own spelling; used by callers that already have a sharp-spelled name).
pub fn sharp_pc(name: &str) -> Option<usize> {
    crate::notes::NAMES.iter().position(|&n| n == name)
}
