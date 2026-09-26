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

/// A note with its octave, as a MIDI number (C4 = 60, scientific pitch: `Bb2` = 46, `C-1` = 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Note(pub i32);

impl Note {
    pub fn class(self) -> PitchClass {
        PitchClass::new(self.0)
    }
    pub fn octave(self) -> i32 {
        self.0.div_euclid(12) - 1
    }
    /// A pitch class in an octave: `Note::at(Bb, 2)` = Bb2.
    pub fn at(pc: PitchClass, octave: i32) -> Self {
        Note(12 * (octave + 1) + pc.index() as i32)
    }
    /// Parse `Bb2`, `C#4`, `F-1`: a note name and an octave. `Ok(None)` when there is no octave (a bare `Bb`).
    pub fn parse_optional(s: &str) -> Result<(PitchClass, Option<Note>), String> {
        let s = s.trim();
        let (pc, n) = PitchClass::parse_prefix(s).ok_or_else(|| format!("{s:?} is not a note (expected e.g. Bb, Bb2 or C#4)"))?;
        let rest = &s[n..];
        if rest.is_empty() {
            return Ok((pc, None));
        }
        let oct: i32 = rest.parse().map_err(|_| format!("{s:?}: after the note name comes an octave number (e.g. Bb2)"))?;
        if !(-1..=9).contains(&oct) {
            return Err(format!("{s:?}: octave {oct} is out of range (-1 to 9)"));
        }
        // The octave counts from C: Cb4 is B3 and B#3 is C4, as spelled.
        let letter = PitchClass::parse_prefix(&s[..1]).map(|x| x.0.index() as i32).unwrap_or(0);
        let offset = pc.index() as i32 - letter;
        let wrap = if offset > 6 { -12 } else if offset < -6 { 12 } else { 0 };
        Ok((pc, Some(Note(12 * (oct + 1) + letter + offset + wrap))))
    }
}

impl std::str::FromStr for Note {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match Note::parse_optional(s)? {
            (_, Some(n)) => Ok(n),
            (_, None) => Err(format!("{s:?} needs an octave (e.g. {}3)", s.trim())),
        }
    }
}

impl fmt::Display for Note {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}{}", self.class().name(), self.octave())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_with_octaves() {
        for (s, midi) in [("C4", 60), ("A4", 69), ("Bb2", 46), ("B♭2", 46), ("C#4", 61), ("C-1", 0), ("G9", 127), ("Cb4", 59), ("B#3", 60), ("E3", 52)] {
            assert_eq!(s.parse::<Note>().unwrap(), Note(midi), "{s}");
        }
        assert_eq!(Note(46).to_string(), "Bb2");
        assert_eq!(Note(60).to_string(), "C4");
        assert_eq!(Note::at(PitchClass::new(10), 2), Note(46));
        assert_eq!((Note(46).class().index(), Note(46).octave()), (10, 2));
        assert_eq!(Note::parse_optional("Bb").unwrap(), (PitchClass::new(10), None));
        assert!("Bb".parse::<Note>().unwrap_err().contains("octave"));
        assert!("Bbx".parse::<Note>().is_err());
        assert!("C12".parse::<Note>().is_err());
    }

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
