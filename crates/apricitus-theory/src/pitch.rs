//! Pitch classes and note-name parsing.

use serde::{Deserialize, Serialize};
use std::fmt;

/// A pitch class, 0 = C … 11 = B. Always in range by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(into = "u8", try_from = "u8")]
pub struct PitchClass(u8);

impl PitchClass {
    pub const C: Self = Self(0);

    pub fn new(semitones: i32) -> Self {
        Self(semitones.rem_euclid(12) as u8)
    }

    pub fn index(self) -> usize {
        self.0 as usize
    }

    /// Transpose by `semitones` (any sign), wrapping around the octave.
    pub fn transpose(self, semitones: i32) -> Self {
        Self::new(self.0 as i32 + semitones)
    }

    /// Smallest signed interval from `self` up/down to `other`, in -5..=6.
    pub fn signed_interval_to(self, other: Self) -> i32 {
        let d = (other.0 as i32 - self.0 as i32).rem_euclid(12);
        if d > 6 { d - 12 } else { d }
    }

    /// Flat-leaning default spelling (Db, Eb, Gb, Ab, Bb): the common case for band keys.
    pub fn name(self) -> &'static str {
        ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"][self.index()]
    }

    /// Spelling with sharps (C#, D#, F#, G#, A#).
    pub fn sharp_name(self) -> &'static str {
        ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][self.index()]
    }

    /// Parse a note name: letter A–G, then any number of `b`/`♭`/`#`/`♯`. Returns the
    /// pitch class and the number of bytes consumed, so callers can keep parsing a suffix.
    pub fn parse_prefix(s: &str) -> Option<(Self, usize)> {
        let mut chars = s.char_indices();
        let (_, letter) = chars.next()?;
        let mut pc: i32 = match letter.to_ascii_uppercase() {
            'C' => 0,
            'D' => 2,
            'E' => 4,
            'F' => 5,
            'G' => 7,
            'A' => 9,
            'B' => 11,
            _ => return None,
        };
        let mut end = letter.len_utf8();
        for (i, c) in chars {
            match c {
                'b' | '♭' => pc -= 1,
                '#' | '♯' => pc += 1,
                _ => break,
            }
            end = i + c.len_utf8();
        }
        Some((Self::new(pc), end))
    }
}

impl From<PitchClass> for u8 {
    fn from(p: PitchClass) -> u8 {
        p.0
    }
}

impl TryFrom<u8> for PitchClass {
    type Error = String;
    fn try_from(v: u8) -> Result<Self, String> {
        if v < 12 { Ok(Self(v)) } else { Err(format!("pitch class {v} out of range 0..12")) }
    }
}

impl std::str::FromStr for PitchClass {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match Self::parse_prefix(s.trim()) {
            Some((pc, n)) if n == s.trim().len() => Ok(pc),
            _ => Err(format!("{s:?} is not a note name (expected e.g. C, F#, Ab, B♭)")),
        }
    }
}

impl fmt::Display for PitchClass {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_names() {
        for (s, pc) in [("C", 0), ("c", 0), ("C#", 1), ("Db", 1), ("D♭", 1), ("Fb", 4), ("E#", 5), ("Cb", 11), ("B#", 0), ("Abb", 7)] {
            assert_eq!(s.parse::<PitchClass>().unwrap().index(), pc, "{s}");
        }
        assert!("H".parse::<PitchClass>().is_err());
        assert!("Abm".parse::<PitchClass>().is_err(), "suffix must not be silently ignored");
        assert_eq!(PitchClass::parse_prefix("Abm7"), Some((PitchClass::new(8), 2)));
    }

    #[test]
    fn intervals_wrap() {
        let c = PitchClass::C;
        assert_eq!(c.transpose(-1).name(), "B");
        assert_eq!(c.signed_interval_to(PitchClass::new(7)), -5);
        assert_eq!(c.signed_interval_to(PitchClass::new(6)), 6);
        assert_eq!(PitchClass::new(11).signed_interval_to(c), 1);
    }
}
