//! Keys, modes, scales, Camelot codes and key finding from pitch-class profiles.

use crate::pitch::PitchClass;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Major,
    /// Natural minor (Aeolian). Roman numerals in minor keys are built on this scale,
    /// so in A♭ minor `iv` is D♭ minor and `VI` is F♭ (E) major.
    Minor,
    HarmonicMinor,
    MelodicMinor,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    Locrian,
}

impl Mode {
    /// Scale steps above the tonic.
    pub fn steps(self) -> [i32; 7] {
        match self {
            Mode::Major => [0, 2, 4, 5, 7, 9, 11],
            Mode::Minor => [0, 2, 3, 5, 7, 8, 10],
            Mode::HarmonicMinor => [0, 2, 3, 5, 7, 8, 11],
            Mode::MelodicMinor => [0, 2, 3, 5, 7, 9, 11],
            Mode::Dorian => [0, 2, 3, 5, 7, 9, 10],
            Mode::Phrygian => [0, 1, 3, 5, 7, 8, 10],
            Mode::Lydian => [0, 2, 4, 6, 7, 9, 11],
            Mode::Mixolydian => [0, 2, 4, 5, 7, 9, 10],
            Mode::Locrian => [0, 1, 3, 5, 6, 8, 10],
        }
    }

    /// Does the mode have a minor third? Decides Camelot letter and `m` in names.
    pub fn is_minor(self) -> bool {
        self.steps()[2] == 3
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "" | "maj" | "major" | "ionian" => Mode::Major,
            "m" | "min" | "minor" | "aeolian" => Mode::Minor,
            "harmonic minor" | "harmonic_minor" | "harm" => Mode::HarmonicMinor,
            "melodic minor" | "melodic_minor" | "mel" => Mode::MelodicMinor,
            "dorian" => Mode::Dorian,
            "phrygian" => Mode::Phrygian,
            "lydian" => Mode::Lydian,
            "mixolydian" | "mixo" => Mode::Mixolydian,
            "locrian" => Mode::Locrian,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Key {
    pub tonic: PitchClass,
    pub mode: Mode,
}

impl Key {
    pub fn new(tonic: PitchClass, mode: Mode) -> Self {
        Self { tonic, mode }
    }

    /// Pitch class of scale degree `degree` (0-based, may exceed 6).
    pub fn degree(self, degree: usize) -> PitchClass {
        let steps = self.mode.steps();
        self.tonic.transpose(steps[degree % 7] + 12 * (degree / 7) as i32)
    }

    pub fn scale(self) -> [PitchClass; 7] {
        std::array::from_fn(|i| self.degree(i))
    }

    pub fn contains(self, pc: PitchClass) -> bool {
        self.scale().contains(&pc)
    }

    /// Camelot wheel code (C major = 8B, A minor = 8A). Other modes map by the quality of their
    /// third: D dorian is read as D minor (7A), G mixolydian as G major (9B).
    pub fn camelot(self) -> String {
        let (major_pc, letter) = if self.mode.is_minor() {
            (self.tonic.transpose(3), 'A')
        } else {
            (self.tonic, 'B')
        };
        let n = ((7 * major_pc.index()) % 12 + 7) % 12 + 1;
        format!("{n}{letter}")
    }

    pub fn transpose(self, semitones: i32) -> Self {
        Self { tonic: self.tonic.transpose(semitones), ..self }
    }
}

impl std::str::FromStr for Key {
    type Err = String;
    /// `C`, `Abm`, `A♭ minor`, `F# major`, `D dorian`, `Bb mixolydian`.
    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (tonic, n) = PitchClass::parse_prefix(s).ok_or_else(|| format!("{s:?}: a key starts with a note name, e.g. Abm or \"D dorian\""))?;
        let mode = Mode::parse(&s[n..]).ok_or_else(|| format!("{s:?}: unknown mode {:?} (major, minor/m, dorian, mixolydian, …)", s[n..].trim()))?;
        Ok(Key { tonic, mode })
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self.mode {
            Mode::Major => write!(f, "{}", self.tonic),
            Mode::Minor => write!(f, "{}m", self.tonic),
            m => write!(f, "{} {}", self.tonic, format!("{m:?}").to_lowercase()),
        }
    }
}

// ------------------------------------------------------------------ key finding

/// Temperley's (Kostka-Payne) key profiles, tonic first. Same as apricity-analyze uses.
const TEMPERLEY_MAJOR: [f64; 12] = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
const TEMPERLEY_MINOR: [f64; 12] = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];

/// All 24 major/minor keys ranked by correlation with a C-first pitch-class profile.
pub fn rank_keys(pcp: &[f64; 12]) -> Vec<(Key, f64)> {
    let mut out = Vec::with_capacity(24);
    if pcp.iter().all(|&v| v <= 0.0) {
        return out;
    }
    for (mode, prof) in [(Mode::Major, &TEMPERLEY_MAJOR), (Mode::Minor, &TEMPERLEY_MINOR)] {
        for t in 0..12 {
            let rotated: [f64; 12] = std::array::from_fn(|i| prof[(i + 12 - t) % 12]);
            out.push((Key::new(PitchClass::new(t as i32), mode), pearson(pcp, &rotated)));
        }
    }
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out
}

fn pearson(a: &[f64; 12], b: &[f64; 12]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    if da == 0.0 || db == 0.0 { 0.0 } else { num / (da * db).sqrt() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> Key {
        s.parse().unwrap()
    }

    #[test]
    fn parses_keys() {
        assert_eq!(k("Abm"), Key::new(PitchClass::new(8), Mode::Minor));
        assert_eq!(k("A♭ minor"), k("Abm"));
        assert_eq!(k("G#m"), k("Abm"));
        assert_eq!(k("Eb"), Key::new(PitchClass::new(3), Mode::Major));
        assert_eq!(k("D dorian").mode, Mode::Dorian);
        assert!("Abx".parse::<Key>().is_err());
        assert!("minor".parse::<Key>().is_err());
    }

    #[test]
    fn scales() {
        let names: Vec<_> = k("Abm").scale().iter().map(|p| p.name()).collect();
        assert_eq!(names, ["Ab", "Bb", "B", "Db", "Eb", "E", "Gb"]); // Cb and Fb spelled enharmonically
        assert!(k("C").contains(PitchClass::new(11)) && !k("C").contains(PitchClass::new(10)));
    }

    #[test]
    fn camelot() {
        for (key, code) in [("C", "8B"), ("Am", "8A"), ("Eb", "5B"), ("Abm", "1A"), ("F", "7B"), ("Dm", "7A"), ("B", "1B"), ("F#", "2B"), ("D dorian", "7A"), ("G mixolydian", "9B")] {
            assert_eq!(k(key).camelot(), code, "{key}");
        }
    }

    #[test]
    fn key_finding_recovers_scale() {
        for key in ["Eb", "Abm", "F#", "Dm"] {
            let key = k(key);
            let mut pcp = [0.0; 12];
            for (i, pc) in key.scale().iter().enumerate() {
                pcp[pc.index()] = if i == 0 || i == 4 { 2.0 } else if i == 2 { 1.5 } else { 1.0 };
            }
            assert_eq!(rank_keys(&pcp)[0].0, key);
        }
        assert!(rank_keys(&[0.0; 12]).is_empty());
    }
}
