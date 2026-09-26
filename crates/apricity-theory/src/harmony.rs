//! Harmonic fit: choose a transposition for each voice (clip) so that together they sound
//! a target chord.
//!
//! For one voice with normalized pitch-class profile `p`, shifting by `k` semitones scores
//!
//!   fit(k)  = Σ_i p[i] · w(i + k)        w = chord tone / other scale tone / outside the key
//!   role(k) = bonus if the voice's tonic lands on its assigned chord member
//!   cost(k) = per-semitone cost of shifting + cost of moving away from the previous chord's shift
//!
//! and the ensemble adds a coverage term: for each chord tone, how strongly the best voice
//! supplies it. The search is exhaustive over all combinations for up to five voices
//! (13^5 ≈ 371k), and coordinate ascent from each voice's solo best for larger ensembles.

use crate::chord::{Chord, Member};
use crate::key::Key;
use crate::pitch::PitchClass;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// No preference beyond fitting the chord.
    #[default]
    Any,
    /// The voice's tonic should be a chord tone.
    Chord,
    Root,
    Third,
    Fifth,
    Seventh,
    /// The voice's tonic should be the chord's lowest note: a slash chord's bass, otherwise its root.
    Bass,
}

#[derive(Debug, Clone)]
pub struct Voice {
    pub name: String,
    /// Pitch-class energy, C first. Need not be normalized.
    pub pcp: [f64; 12],
    /// The voice's own tonal center (from analysis), used by `role`.
    pub tonic: Option<PitchClass>,
    pub role: Role,
    /// Largest transposition allowed either way (semitones, ≤ 6 is enough to reach any pitch class).
    pub max_shift: i32,
    /// Shift chosen for the previous chord, to keep voices from jumping around.
    pub previous: Option<i32>,
    /// Force a shift (e.g. a drum loop that must not be transposed: `Some(0)`).
    pub fixed: Option<i32>,
}

impl Voice {
    pub fn new(name: impl Into<String>, pcp: [f64; 12]) -> Self {
        Self { name: name.into(), pcp, tonic: None, role: Role::Any, max_shift: 6, previous: None, fixed: None }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Weights {
    pub chord_tone: f64,
    pub scale_tone: f64,
    pub outside: f64,
    pub role_bonus: f64,
    pub coverage: f64,
    pub per_semitone: f64,
    pub continuity: f64,
}

impl Default for Weights {
    fn default() -> Self {
        Self { chord_tone: 1.0, scale_tone: 0.25, outside: -1.0, role_bonus: 0.35, coverage: 0.5, per_semitone: 0.015, continuity: 0.03 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceFit {
    pub name: String,
    pub semitones: i32,
    /// Share of the voice's energy that lands on chord tones after shifting (0..1).
    pub on_chord: f64,
    /// Share landing outside the key's scale (0..1).
    pub off_key: f64,
    pub fit: f64,
    pub role_bonus: f64,
    pub cost: f64,
    /// Where the voice's own tonic lands, if known.
    pub tonic_lands_on: Option<PitchClass>,
    /// Next-best shifts for this voice with the others held fixed: (semitones, total score delta).
    pub runners_up: Vec<(i32, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fit {
    pub chord: String,
    pub chord_tones: Vec<PitchClass>,
    pub voices: Vec<VoiceFit>,
    /// Mean over chord tones of how strongly the best voice supplies it (0..1).
    pub coverage: f64,
    pub score: f64,
}

struct Prepared<'a> {
    voice: &'a Voice,
    p: [f64; 12],
    peak: f64,
    candidates: Vec<i32>,
}

pub fn solve(voices: &[Voice], chord: &Chord, key: Key, w: &Weights) -> Fit {
    let prepared: Vec<Prepared> = voices
        .iter()
        .map(|v| {
            let sum: f64 = v.pcp.iter().map(|x| x.max(0.0)).sum();
            let p: [f64; 12] = std::array::from_fn(|i| if sum > 0.0 { v.pcp[i].max(0.0) / sum } else { 0.0 });
            let peak = p.iter().cloned().fold(0.0, f64::max);
            let candidates = match v.fixed {
                Some(k) => vec![k],
                None => (-v.max_shift.clamp(0, 6)..=v.max_shift.clamp(0, 6)).collect(),
            };
            Prepared { voice: v, p, peak, candidates }
        })
        .collect();

    // Solo score for every (voice, shift) — the ensemble only adds coverage on top.
    let solo: Vec<Vec<f64>> = prepared.iter().map(|pv| pv.candidates.iter().map(|&k| solo_score(pv, k, chord, key, w).0).collect()).collect();
    let tones = chord.pitch_classes();

    let total = |choice: &[usize]| -> f64 {
        let s: f64 = choice.iter().enumerate().map(|(v, &c)| solo[v][c]).sum();
        s + w.coverage * prepared.len() as f64 * coverage(&prepared, choice, &tones)
    };

    let mut best: Vec<usize> = solo.iter().map(|s| argmax(s)).collect();
    let combos: f64 = prepared.iter().map(|p| p.candidates.len() as f64).product();
    if combos <= 400_000.0 {
        let mut idx = vec![0usize; prepared.len()];
        let mut best_score = f64::NEG_INFINITY;
        'outer: loop {
            let s = total(&idx);
            if s > best_score + 1e-12 {
                best_score = s;
                best = idx.clone();
            }
            for v in 0..idx.len() {
                idx[v] += 1;
                if idx[v] < prepared[v].candidates.len() {
                    continue 'outer;
                }
                idx[v] = 0;
            }
            break;
        }
    } else {
        for _ in 0..8 {
            let mut changed = false;
            for v in 0..best.len() {
                let mut trial = best.clone();
                let (mut bi, mut bs) = (best[v], total(&best));
                for c in 0..prepared[v].candidates.len() {
                    trial[v] = c;
                    let s = total(&trial);
                    if s > bs + 1e-12 {
                        bi = c;
                        bs = s;
                    }
                }
                if bi != best[v] {
                    best[v] = bi;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    let score = total(&best);
    let voices_out = prepared
        .iter()
        .enumerate()
        .map(|(v, pv)| {
            let k = pv.candidates[best[v]];
            let (_, fit, role_bonus, cost, on_chord, off_key) = solo_score(pv, k, chord, key, w);
            let mut alts: Vec<(i32, f64)> = (0..pv.candidates.len())
                .filter(|&c| c != best[v])
                .map(|c| {
                    let mut t = best.clone();
                    t[v] = c;
                    (pv.candidates[c], total(&t) - score)
                })
                .collect();
            alts.sort_by(|a, b| b.1.total_cmp(&a.1));
            alts.truncate(3);
            VoiceFit {
                name: pv.voice.name.clone(),
                semitones: k,
                on_chord: round(on_chord),
                off_key: round(off_key),
                fit: round(fit),
                role_bonus: round(role_bonus),
                cost: round(cost),
                tonic_lands_on: pv.voice.tonic.map(|t| t.transpose(k)),
                runners_up: alts.into_iter().map(|(k, d)| (k, round(d))).collect(),
            }
        })
        .collect();

    Fit { chord: chord.name(), chord_tones: tones.clone(), voices: voices_out, coverage: round(coverage(&prepared, &best, &tones)), score: round(score) }
}

/// (total, fit, role bonus, cost, share on chord, share off key)
fn solo_score(pv: &Prepared, k: i32, chord: &Chord, key: Key, w: &Weights) -> (f64, f64, f64, f64, f64, f64) {
    let (mut fit, mut on_chord, mut off_key) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let pc = PitchClass::new(i as i32 + k);
        let e = pv.p[i];
        if chord.contains(pc) {
            fit += e * w.chord_tone;
            on_chord += e;
        } else if key.contains(pc) {
            fit += e * w.scale_tone;
        } else {
            fit += e * w.outside;
            off_key += e;
        }
    }
    let role_bonus = match (pv.voice.tonic, pv.voice.role) {
        (Some(t), role) => {
            let lands = t.transpose(k);
            let hit = match role {
                Role::Any => false,
                Role::Chord => chord.contains(lands),
                Role::Root => chord.member(Member::Root) == Some(lands),
                Role::Third => chord.member(Member::Third) == Some(lands),
                Role::Fifth => chord.member(Member::Fifth) == Some(lands),
                Role::Seventh => chord.member(Member::Seventh) == Some(lands),
                Role::Bass => chord.bass_note() == lands,
            };
            if hit { w.role_bonus } else { 0.0 }
        }
        (None, _) => 0.0,
    };
    let cost = w.per_semitone * k.abs() as f64 + pv.voice.previous.map_or(0.0, |prev| w.continuity * (k - prev).abs() as f64);
    (fit + role_bonus - cost, fit, role_bonus, cost, on_chord, off_key)
}

fn coverage(prepared: &[Prepared], choice: &[usize], tones: &[PitchClass]) -> f64 {
    if tones.is_empty() || prepared.is_empty() {
        return 0.0;
    }
    let mut total = 0.0;
    for &t in tones {
        let mut best: f64 = 0.0;
        for (v, pv) in prepared.iter().enumerate() {
            if pv.peak > 0.0 {
                let k = pv.candidates[choice[v]];
                best = best.max(pv.p[t.transpose(-k).index()] / pv.peak);
            }
        }
        total += best;
    }
    total / tones.len() as f64
}

fn argmax(v: &[f64]) -> usize {
    v.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map_or(0, |(i, _)| i)
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A profile that is a major or minor triad plus a little scale color.
    fn triad_pcp(root: i32, minor: bool) -> [f64; 12] {
        let mut p = [0.02; 12];
        for (iv, e) in [(0, 1.0), (if minor { 3 } else { 4 }, 0.7), (7, 0.8), (2, 0.15), (5, 0.1), (if minor { 10 } else { 11 }, 0.1)] {
            p[PitchClass::new(root + iv).index()] = e;
        }
        p
    }

    fn setup(key: &str, chord: &str) -> (Key, Chord) {
        let key: Key = key.parse().unwrap();
        (key, Chord::parse(chord, key).unwrap())
    }

    #[test]
    fn single_major_clip_moves_onto_a_major_target() {
        // An Eb major clip, target IV of Ab minor = Db major → down a whole step.
        let (key, chord) = setup("Abm", "IV");
        let mut v = Voice::new("brass", triad_pcp(3, false));
        v.tonic = Some(PitchClass::new(3));
        v.role = Role::Root;
        let fit = solve(&[v], &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].semitones, -2, "{fit:#?}");
        assert_eq!(fit.voices[0].tonic_lands_on.unwrap().name(), "Db");
    }

    #[test]
    fn a_bass_voice_takes_the_slash_note() {
        // One note, C. Over B♭/D it could move down to B♭ (the root) or up to D (the bass): the role decides.
        let (key, chord) = setup("F", "IV/3");
        let mut pcp = [0.0; 12];
        pcp[0] = 1.0;
        let mut v = Voice::new("tuba", pcp);
        v.tonic = Some(PitchClass::C);
        v.role = Role::Bass;
        let fit = solve(std::slice::from_ref(&v), &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].tonic_lands_on.unwrap().name(), "D", "{fit:#?}");
        v.role = Role::Root;
        let fit = solve(&[v], &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].tonic_lands_on.unwrap().name(), "Bb", "{fit:#?}");
    }

    #[test]
    fn minor_target_prefers_minor_material() {
        // Target iv of Ab minor = Db minor. A C minor clip should go up one (C→Db).
        let (key, chord) = setup("Abm", "iv");
        let mut v = Voice::new("pad", triad_pcp(0, true));
        v.tonic = Some(PitchClass::C);
        let fit = solve(&[v], &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].semitones, 1, "{fit:#?}");
        assert!(fit.voices[0].on_chord > 0.6);
    }

    #[test]
    fn four_clips_form_iv_of_ab_minor() {
        // The milestone: four clips in unrelated keys, voiced together as iv (Db Fb Ab).
        let (key, chord) = setup("Abm", "iv");
        let clips = [("cadets", 1, false, Role::Root), ("cotton", 3, false, Role::Fifth), ("bugle", 10, false, Role::Third), ("parade", 9, false, Role::Chord)];
        let voices: Vec<Voice> = clips
            .iter()
            .map(|&(n, root, minor, role)| {
                let mut v = Voice::new(n, triad_pcp(root, minor));
                v.tonic = Some(PitchClass::new(root));
                v.role = role;
                v
            })
            .collect();
        let fit = solve(&voices, &chord, key, &Weights::default());
        let lands: Vec<&str> = fit.voices.iter().map(|v| v.tonic_lands_on.unwrap().name()).collect();
        assert_eq!(lands[0], "Db", "root role: {fit:#?}");
        assert_eq!(lands[2], "E", "third role (F♭): {fit:#?}");
        for v in &fit.voices {
            assert!(chord.contains(v.tonic_lands_on.unwrap()), "{} lands off-chord: {fit:#?}", v.name);
        }
        assert!(fit.coverage > 0.9, "{fit:#?}");
        // Transposition can't change a clip's quality: the Db *major* clip keeps its F against
        // Db minor. The solver still picks it for the root, but reports the clash for `explain`.
        assert!(fit.voices[0].off_key > 0.2 && fit.voices[1..].iter().all(|v| v.off_key < 0.1), "{fit:#?}");
    }

    #[test]
    fn role_is_a_hint_and_consonance_wins() {
        // Asked to put an Eb *major* clip's tonic on the fifth of Db minor (Ab), the solver
        // would bring in C — clashing with Ab minor's Cb. Moving up a semitone instead gives
        // E-G#-B = Fb-Ab-Cb: two chord tones and nothing outside the key.
        let (key, chord) = setup("Abm", "iv");
        let mut v = Voice::new("cotton", triad_pcp(3, false));
        v.tonic = Some(PitchClass::new(3));
        v.role = Role::Fifth;
        let fit = solve(&[v], &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].semitones, 1, "{fit:#?}");
        assert_eq!(fit.voices[0].runners_up.iter().find(|r| r.0 == 5).map(|r| r.1 < 0.0), Some(true));
    }

    #[test]
    fn fixed_voice_is_not_moved_and_others_adapt() {
        let (key, chord) = setup("C", "V7");
        let mut drums = Voice::new("drums", [1.0; 12]);
        drums.fixed = Some(0);
        let mut v = Voice::new("horn", triad_pcp(0, false));
        v.tonic = Some(PitchClass::C);
        v.role = Role::Root;
        let fit = solve(&[drums, v], &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].semitones, 0);
        assert_eq!(fit.voices[1].tonic_lands_on.unwrap().name(), "G");
    }

    #[test]
    fn continuity_breaks_ties_toward_previous_shift() {
        // A chromatic (featureless) voice fits every shift equally; continuity keeps it put.
        let (key, chord) = setup("C", "I");
        let mut v = Voice::new("noise", [1.0; 12]);
        v.previous = Some(3);
        let fit = solve(&[v], &chord, key, &Weights::default());
        assert_eq!(fit.voices[0].semitones, 3);
    }

    #[test]
    fn large_ensembles_use_coordinate_ascent() {
        let (key, chord) = setup("Eb", "I");
        let voices: Vec<Voice> = (0..7).map(|i| {
            let mut v = Voice::new(format!("v{i}"), triad_pcp(i * 2, false));
            v.tonic = Some(PitchClass::new(i * 2));
            v.role = Role::Chord;
            v
        }).collect();
        let fit = solve(&voices, &chord, key, &Weights::default());
        for v in &fit.voices {
            assert!(chord.contains(v.tonic_lands_on.unwrap()), "{fit:#?}");
        }
    }
}
