//! Extensions, inversion, confidence, and the full per-span chord recognition output. A direct
//! port of the matching sections of `harmony2_ref.py` (`detect_extensions`, `chord_inversion`,
//! `recognise_chord_full`, `notes_from_activation`).

use crate::cqt::MIDI_C1;
use crate::notes::{recognise_chord, semitone_name, N_SEMITONES, QUALITIES};

/// Semitone offset from the root for each extension tag the design's candidate list carries
/// (`{6, 9, maj9, m9, add9}`).
pub const EXTENSION_TAGS: &[&str] = &["6", "9", "maj9", "m9", "add9"];

fn extension_semitone(tag: &str) -> i32 {
    match tag {
        "6" => 9,
        "9" | "maj9" | "m9" | "add9" => 2,
        _ => unreachable!(),
    }
}

/// Which base quality (as it appears in [`QUALITIES`]) each extension tag is checked against: a
/// dominant "9" only makes sense read against a dominant 7th (a triad plus a 9th with no 7th is
/// "add9", not "9"); "maj9"/"m9" against the matching 7th chord; "6"/"add9" against a bare triad.
fn extension_base_qualities(tag: &str) -> &'static [&'static str] {
    match tag {
        "6" => &["", "m"],
        "9" => &["7"],
        "maj9" => &["maj7"],
        "m9" => &["m7", "mMaj7", "m7b5"],
        "add9" => &["", "m"],
        _ => &[],
    }
}

pub const EXTENSION_REGISTER_FLOOR_MIDI: i32 = 60; // C4
pub const EXTENSION_MASS_FLOOR: f64 = 0.04;
pub const SEVENTH_QUALITIES: &[&str] = &["7", "maj7", "m7", "mMaj7", "m7b5", "dim7"];

/// Which extension tags are audibly present on top of `(root_pc, quality)`, from the octave-aware
/// `activation` (not a folded 12-pc profile: the register test needs to know WHERE the note
/// sounds). A candidate extension pitch class counts only when the activation summed over
/// semitone indices at/above C4, OR at/above a major ninth above the sounding bass, exceeds
/// [`EXTENSION_MASS_FLOOR`] of the total (a high extension is colour; a low one is mud).
pub fn detect_extensions(activation: &[f64], root_pc: usize, quality: &str, bass_idx: Option<usize>) -> Vec<&'static str> {
    let total: f64 = activation.iter().sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let floor_idx = (EXTENSION_REGISTER_FLOOR_MIDI - MIDI_C1).max(0) as usize;
    let bass_floor_idx = bass_idx.map_or(usize::MAX, |b| b + 14);
    let mut out = Vec::new();
    for &tag in EXTENSION_TAGS {
        if !extension_base_qualities(tag).contains(&quality) {
            continue;
        }
        let pc = ((root_pc as i32 + extension_semitone(tag)).rem_euclid(12)) as usize;
        let mass: f64 = (0..N_SEMITONES)
            .filter(|&i| (MIDI_C1 as usize + i) % 12 == pc && (i >= floor_idx || i >= bass_floor_idx))
            .map(|i| activation[i])
            .sum();
        if mass / total >= EXTENSION_MASS_FLOOR {
            out.push(tag);
        }
    }
    out
}

/// `"root" | "1st" | "2nd" | "3rd"` from the bass's position in the chord's own tone list (root,
/// 3rd, 5th, [7th]); `"root"` when the bass isn't one of the chord's own tones.
pub fn chord_inversion(root_pc: usize, quality: &str, bass_pc: usize) -> &'static str {
    let intervals = QUALITIES.iter().find(|&&(q, _)| q == quality).map(|&(_, iv)| iv).unwrap_or(&[0, 4, 7]);
    let tones: Vec<usize> = intervals.iter().map(|iv| ((root_pc as i32 + iv).rem_euclid(12)) as usize).collect();
    match tones.iter().position(|&t| t == bass_pc) {
        Some(idx) if idx < 4 => ["root", "1st", "2nd", "3rd"][idx],
        _ => "root",
    }
}

/// Sec 2.4's full per-span chord recognition output.
#[derive(Debug, Clone, PartialEq)]
pub struct Heard {
    pub root: &'static str,
    pub quality: &'static str,
    pub extensions: Vec<&'static str>,
    pub bass: &'static str,
    pub inversion: &'static str,
    pub confidence: f64,
    pub score: f64,
}

/// `{root, quality, extensions, bass, inversion, confidence}` from one combined
/// (summed-across-stems) `(N_SEMITONES,)` activation vector. `None` when there's no tonal mass at
/// all (a silent/unpitched span earns no `Q`, sec 2.5).
pub fn recognise_chord_full(activation: &[f64], known_bass_pc: Option<usize>) -> Option<Heard> {
    if activation.iter().sum::<f64>() <= 0.0 {
        return None;
    }
    let (root, quality, bass_pc, best_score) = recognise_chord(activation, known_bass_pc)?;
    let mut pcp = [0.0f64; 12];
    for (i, &x) in activation.iter().enumerate() {
        pcp[(MIDI_C1 as usize + i) % 12] += x;
    }
    let sum: f64 = pcp.iter().sum();
    for v in pcp.iter_mut() {
        *v /= sum;
    }
    let mut scores: Vec<f64> = Vec::with_capacity(12 * QUALITIES.len());
    for r in 0..12 {
        for &(_, intervals) in QUALITIES {
            let tones: Vec<usize> = intervals.iter().map(|iv| ((r as i32 + iv).rem_euclid(12)) as usize).collect();
            let on: f64 = tones.iter().map(|&p| pcp[p]).sum();
            let off: f64 = (0..12).filter(|p| !tones.contains(p)).map(|p| pcp[p]).sum();
            let s = on - 1.5 * off - 0.05 * intervals.len().saturating_sub(3) as f64 + if tones.contains(&bass_pc) { 0.15 } else { -0.15 };
            scores.push(s);
        }
    }
    scores.sort_by(|a, b| b.partial_cmp(a).unwrap());
    let best = scores[0];
    let second = scores.get(1).copied().unwrap_or(best);
    let confidence = if best > 1e-9 { (best - second) / best } else { 0.0 };
    let bass_idx = (0..N_SEMITONES).filter(|&i| (MIDI_C1 as usize + i) % 12 == bass_pc).max_by(|&a, &b| activation[a].partial_cmp(&activation[b]).unwrap());
    let extensions = detect_extensions(activation, root, quality, bass_idx);
    Some(Heard {
        root: crate::notes::NAMES[root],
        quality,
        extensions,
        bass: crate::notes::NAMES[bass_pc],
        inversion: chord_inversion(root, quality, bass_pc),
        confidence,
        score: best_score,
    })
}

/// MIDI note numbers whose activation is at least `thr_ratio` of this vector's peak -- the "which
/// notes are actually sounding" list `spacing`/`voice_leading` need.
pub fn notes_from_activation(activation: &[f64], thr_ratio: f64) -> Vec<i32> {
    let peak = activation.iter().cloned().fold(0.0f64, f64::max);
    if peak <= 0.0 {
        return Vec::new();
    }
    let thr = thr_ratio * peak;
    (0..N_SEMITONES).filter(|&i| activation[i] >= thr).map(|i| MIDI_C1 + i as i32).collect()
}

/// A pitch-class name (as `notes::NAMES` spells it, e.g. `"C#"`) back to its 0..11 index.
pub fn pc_index(name: &str) -> Option<usize> {
    crate::notes::NAMES.iter().position(|&n| n == name)
}

/// Semitone-name helper re-exported for callers that want `notes::semitone_name` alongside this
/// module without an extra `use`.
pub fn note_name(midi: i32) -> String {
    semitone_name(midi)
}
