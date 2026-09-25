//! Help with chords: the chords a key offers (its palette), and how well the score's own sounds fit any chord.
//!
//! The Chords editor shows the palette as buttons and lights each one by how well the strings (the score's harmonic
//! tracks) fit it, using the same harmony solver the compiler uses. That is the ground an assistant stands on: it can
//! only suggest chords that these recordings can actually play.

use crate::score::Transpose;
use apricity_theory::chord::{Chord, Quality};
use apricity_theory::harmony::{solve, Role, Voice, Weights};
use apricity_theory::key::Key;
use apricity_theory::pitch::PitchClass;
use serde::{Deserialize, Serialize};

/// What the solver needs to know about one track, carried in the compiled timeline (`TrackInfo.voice`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInfo {
    pub name: String,
    /// Pitch-class energy of its region, C first.
    pub pcp: [f64; 12],
    /// Its own tonal center (a pinned `root`, or the region's detected key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tonic: Option<PitchClass>,
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub transpose: Transpose,
}

/// A chord of the key: `IV7` → `Bb7` in F mixolydian.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PaletteChord {
    /// What to write in a score (`IV7`, `viio`, `iiø`).
    pub numeral: String,
    /// What it is (`Bb7`).
    pub name: String,
    /// Scale degree, 1–7.
    pub degree: usize,
    /// `tonic`, `subdominant` or `dominant`: what the chord does in the key.
    pub function: &'static str,
    /// A seventh chord (the palette has a triad and a seventh on each degree).
    pub seventh: bool,
}

const NUMERALS: [&str; 7] = ["I", "II", "III", "IV", "V", "VI", "VII"];

/// The diatonic triads and seventh chords of a key, built from its scale, as numerals the compiler reads back to the
/// same chords.
pub fn palette(key: Key) -> Vec<PaletteChord> {
    let scale = key.scale();
    let above = |d: usize, n: usize| (scale[(d + n) % 7].index() as i32 - scale[d].index() as i32).rem_euclid(12);
    let mut out = Vec::new();
    for d in 0..7 {
        let (third, fifth, seventh) = (above(d, 2), above(d, 4), above(d, 6));
        let triad = match (third, fifth) {
            (4, 7) => Some((Quality::Major, true, "")),
            (3, 7) => Some((Quality::Minor, false, "")),
            (3, 6) => Some((Quality::Diminished, false, "o")),
            (4, 8) => Some((Quality::Augmented, true, "+")),
            _ => None,
        };
        let tetrad = match (third, fifth, seventh) {
            (4, 7, 10) => Some((Quality::Dominant7, true, "7")),
            (4, 7, 11) => Some((Quality::Major7, true, "maj7")),
            (3, 7, 10) => Some((Quality::Minor7, false, "7")),
            (3, 7, 11) => Some((Quality::MinorMajor7, false, "maj7")),
            (3, 6, 10) => Some((Quality::HalfDiminished7, false, "ø")),
            (3, 6, 9) => Some((Quality::Diminished7, false, "o7")),
            _ => None,
        };
        let function = match d {
            0 | 2 | 5 => "tonic",
            1 | 3 => "subdominant",
            _ => "dominant",
        };
        for (spec, is_seventh) in [(triad, false), (tetrad, true)] {
            let Some((quality, upper, suffix)) = spec else { continue };
            let numeral = format!("{}{suffix}", if upper { NUMERALS[d].to_string() } else { NUMERALS[d].to_lowercase() });
            // Only offer what the compiler reads back as the same chord.
            match Chord::parse(&numeral, key) {
                Ok(c) if c.quality == quality && c.root == scale[d] => {
                    out.push(PaletteChord { name: c.name(), numeral, degree: d + 1, function, seventh: is_seventh })
                }
                _ => {}
            }
        }
    }
    out
}

/// How well the voices fit one chord.
#[derive(Debug, Clone, Serialize)]
pub struct ChordFit {
    pub label: String,
    pub name: String,
    /// The solver's total score (higher is better; comparable between chords for the same voices).
    pub score: f64,
    /// How fully the voices supply the chord's tones (0–1).
    pub coverage: f64,
    /// Per voice: the shift it would take, and the share of its energy on chord tones.
    pub voices: Vec<VoiceShift>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceShift {
    pub name: String,
    pub semitones: i32,
    pub on_chord: f64,
}

/// Score each chord label against the voices, as the compiler would voice them (`follow` puts a voice's tonic on the
/// root; a fixed transpose stays fixed). Labels that don't parse come back as errors.
pub fn fit_chords(key: Key, voices: &[VoiceInfo], labels: &[String]) -> Result<Vec<ChordFit>, Vec<String>> {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for label in labels {
        let chord = match Chord::parse(label, key) {
            Ok(c) => c,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        let vs: Vec<Voice> = voices
            .iter()
            .map(|v| {
                let mut x = Voice::new(v.name.clone(), v.pcp);
                x.tonic = v.tonic;
                x.role = v.role;
                x.fixed = match (&v.transpose, v.tonic) {
                    (Transpose::Fixed(n), _) => Some(*n),
                    (Transpose::Follow, Some(t)) => Some(t.signed_interval_to(chord.root)),
                    _ => None,
                };
                x
            })
            .collect();
        if vs.is_empty() {
            out.push(ChordFit { label: label.clone(), name: chord.name(), score: 0.0, coverage: 0.0, voices: vec![] });
            continue;
        }
        let fit = solve(&vs, &chord, key, &Weights::default());
        out.push(ChordFit {
            label: label.clone(),
            name: chord.name(),
            score: fit.score,
            coverage: fit.coverage,
            voices: fit.voices.iter().map(|v| VoiceShift { name: v.name.clone(), semitones: v.semitones, on_chord: v.on_chord }).collect(),
        });
    }
    if errors.is_empty() { Ok(out) } else { Err(errors) }
}

/// `fit_chords` over JSON, for the web app: a key ("F mixolydian"), the voices (the compiled timeline's
/// `tracks[].voice`) and the chord labels. Returns `{"fits": [...]}`.
pub fn fit_json(key: &str, voices: &str, labels: &str) -> Result<serde_json::Value, Vec<String>> {
    let key: Key = key.parse().map_err(|e: String| vec![e])?;
    let voices: Vec<VoiceInfo> = serde_json::from_str(voices).map_err(|e| vec![format!("voices: {e}")])?;
    let labels: Vec<String> = serde_json::from_str(labels).map_err(|e| vec![format!("labels: {e}")])?;
    Ok(serde_json::json!({ "fits": fit_chords(key, &voices, &labels)? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(key: &str, seventh: bool) -> Vec<(String, String, &'static str)> {
        palette(key.parse().unwrap()).into_iter().filter(|p| p.seventh == seventh).map(|p| (p.numeral, p.name, p.function)).collect()
    }

    #[test]
    fn f_mixolydian() {
        let t = names("F mixolydian", false);
        assert_eq!(t.iter().map(|x| (x.0.as_str(), x.1.as_str())).collect::<Vec<_>>(), [("I", "F"), ("ii", "Gm"), ("iiio", "Adim"), ("IV", "Bb"), ("v", "Cm"), ("vi", "Dm"), ("VII", "Eb")]);
        let s = names("F mixolydian", true);
        assert_eq!(s.iter().map(|x| (x.0.as_str(), x.1.as_str())).collect::<Vec<_>>(), [("I7", "F7"), ("ii7", "Gm7"), ("iiiø", "Am7b5"), ("IVmaj7", "Bbmaj7"), ("v7", "Cm7"), ("vi7", "Dm7"), ("VIImaj7", "Ebmaj7")]);
        assert_eq!((t[0].2, t[3].2, t[4].2), ("tonic", "subdominant", "dominant"));
    }

    #[test]
    fn major_and_minor() {
        assert_eq!(names("C major", false).iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), ["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
        assert_eq!(names("C major", true).iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), ["Cmaj7", "Dm7", "Em7", "Fmaj7", "G7", "Am7", "Bm7b5"]);
        assert_eq!(names("Abm", false).iter().map(|x| x.1.as_str()).collect::<Vec<_>>()[3], "Dbm", "iv of A♭ minor");
        // Harmonic minor has an augmented III and a diminished-seventh vii.
        let hm = names("A harmonic_minor", false);
        assert!(hm.iter().any(|x| x.0 == "III+"), "{hm:?}");
    }

    #[test]
    fn fit_prefers_chords_the_voices_contain() {
        // One voice that is a C major triad (C, E, G), free to move.
        let mut pcp = [0.0; 12];
        pcp[0] = 1.0;
        pcp[4] = 0.8;
        pcp[7] = 0.9;
        let v = VoiceInfo { name: "pad".into(), pcp, tonic: Some(PitchClass::new(0)), role: Role::Any, transpose: Transpose::Auto };
        let key: Key = "C major".parse().unwrap();
        let fits = fit_chords(key, &[v.clone()], &["I".into(), "ii".into(), "IV".into()]).unwrap();
        assert_eq!(fits[0].voices[0].semitones, 0, "C already is I");
        assert_eq!(fits[2].voices[0].semitones, 5, "moved up a fourth for IV");
        assert!(fits[0].coverage > 0.85, "{}", fits[0].coverage);
        // A fixed voice can't move: ii fits it worse than I.
        let fixed = VoiceInfo { transpose: Transpose::Fixed(0), ..v };
        let f = fit_chords(key, &[fixed], &["I".into(), "ii".into()]).unwrap();
        assert!(f[0].score > f[1].score);
        assert!(fit_chords(key, &[], &["nonsense".into()]).is_err());
    }
}
