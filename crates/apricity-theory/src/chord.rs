//! Chords: parsed from roman numerals (relative to a key) or chord symbols.

use crate::key::{Key, Mode};
use crate::pitch::PitchClass;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Major,
    Minor,
    Diminished,
    Augmented,
    Sus2,
    Sus4,
    Dominant7,
    Major7,
    Minor7,
    MinorMajor7,
    HalfDiminished7,
    Diminished7,
}

impl Quality {
    /// Semitones above the root.
    pub fn intervals(self) -> &'static [i32] {
        match self {
            Quality::Major => &[0, 4, 7],
            Quality::Minor => &[0, 3, 7],
            Quality::Diminished => &[0, 3, 6],
            Quality::Augmented => &[0, 4, 8],
            Quality::Sus2 => &[0, 2, 7],
            Quality::Sus4 => &[0, 5, 7],
            Quality::Dominant7 => &[0, 4, 7, 10],
            Quality::Major7 => &[0, 4, 7, 11],
            Quality::Minor7 => &[0, 3, 7, 10],
            Quality::MinorMajor7 => &[0, 3, 7, 11],
            Quality::HalfDiminished7 => &[0, 3, 6, 10],
            Quality::Diminished7 => &[0, 3, 6, 9],
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Quality::Major => "",
            Quality::Minor => "m",
            Quality::Diminished => "dim",
            Quality::Augmented => "aug",
            Quality::Sus2 => "sus2",
            Quality::Sus4 => "sus4",
            Quality::Dominant7 => "7",
            Quality::Major7 => "maj7",
            Quality::Minor7 => "m7",
            Quality::MinorMajor7 => "mMaj7",
            Quality::HalfDiminished7 => "m7b5",
            Quality::Diminished7 => "dim7",
        }
    }
}

/// Which tones of a chord a pitched track plays together (`voicing triad`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Voicing {
    /// The root alone (a bass line).
    Root,
    /// Root and fifth.
    Power,
    /// Root, third and fifth.
    Triad,
    /// Root, third, fifth and seventh (a triad stays a triad).
    Seventh,
}

impl Voicing {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "root" => Ok(Voicing::Root),
            "power" => Ok(Voicing::Power),
            "triad" => Ok(Voicing::Triad),
            "seventh" => Ok(Voicing::Seventh),
            _ => Err(format!("voicing is root, power, triad or seventh, not {s:?}")),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Voicing::Root => "root",
            Voicing::Power => "power",
            Voicing::Triad => "triad",
            Voicing::Seventh => "seventh",
        }
    }
}

/// Which chord member a pitch is. Used by the solver's `role` hints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Member {
    Root,
    Third,
    Fifth,
    Seventh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Chord {
    pub root: PitchClass,
    pub quality: Quality,
    /// A slash chord's bass (`IV/3`, `Bb/D`, `C/Bb`): the note under the chord, which need not be a chord tone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bass: Option<PitchClass>,
    /// What the user wrote, e.g. "iv" or "Dbm".
    pub label: String,
}

impl Chord {
    pub fn new(root: PitchClass, quality: Quality) -> Self {
        let mut c = Self { root, quality, bass: None, label: String::new() };
        c.label = c.name();
        c
    }

    /// The chord's tones, root first; a slash chord's bass is one of them even when it isn't a chord tone.
    pub fn pitch_classes(&self) -> Vec<PitchClass> {
        let mut out: Vec<PitchClass> = self.quality.intervals().iter().map(|&i| self.root.transpose(i)).collect();
        if let Some(b) = self.bass.filter(|b| !out.contains(b)) {
            out.push(b);
        }
        out
    }

    /// The lowest note: a slash chord's bass, otherwise the root.
    pub fn bass_note(&self) -> PitchClass {
        self.bass.unwrap_or(self.root)
    }

    pub fn contains(&self, pc: PitchClass) -> bool {
        self.pitch_classes().contains(&pc)
    }

    /// The tones a voicing plays, in semitones from the root, low to high. A slash chord puts its bass lowest (the
    /// nearest one to the root, up or down) and stacks the other tones above it: `C/E` is E G C, an inversion. The
    /// `root` voicing is the bass line, so it plays the bass.
    pub fn voiced(&self, v: Voicing) -> Vec<i32> {
        let iv = self.quality.intervals();
        let tones = match v {
            Voicing::Root => vec![0],
            Voicing::Power => vec![0, iv[2]],
            Voicing::Triad => iv[..3].to_vec(),
            Voicing::Seventh => iv.to_vec(),
        };
        let Some(bass) = self.bass.filter(|b| *b != self.root) else { return tones };
        let low = self.root.signed_interval_to(bass);
        if v == Voicing::Root {
            return vec![low];
        }
        let mut out = vec![low];
        for t in tones {
            if self.root.transpose(t) == bass {
                continue;
            }
            let mut t = t;
            while t <= low {
                t += 12;
            }
            out.push(t);
        }
        out.sort();
        out
    }

    /// Pitch class of a chord member (sus chords use the suspended tone as "third").
    pub fn member(&self, m: Member) -> Option<PitchClass> {
        let iv = self.quality.intervals();
        let idx = match m {
            Member::Root => 0,
            Member::Third => 1,
            Member::Fifth => 2,
            Member::Seventh => 3,
        };
        iv.get(idx).map(|&i| self.root.transpose(i))
    }

    /// Chord-symbol name with flat-leaning spelling, e.g. "Dbm", "Eb7", "Bb/D".
    pub fn name(&self) -> String {
        match self.bass.filter(|b| *b != self.root) {
            Some(b) => format!("{}{}/{}", self.root, self.quality.suffix(), b),
            None => format!("{}{}", self.root, self.quality.suffix()),
        }
    }

    /// Parse either a roman numeral relative to `key` (`iv`, `V7`, `bVI`, `vii°`, `V/V`)
    /// or a chord symbol (`Dbm`, `Eb7`, `F#dim`, `Bbmaj7`), either one with a bass after a slash: a chord tone
    /// (`IV/3`, `V7/7`: 1, 3, 5 or 7) or a note (`IV/D`, `C/Bb`). A numeral after the slash is a secondary chord.
    pub fn parse(s: &str, key: Key) -> Result<Self, String> {
        let t = s.trim();
        if let Some((head, tail)) = t.rsplit_once('/') {
            let member = match tail {
                "1" => Some(Member::Root),
                "3" => Some(Member::Third),
                "5" => Some(Member::Fifth),
                "7" => Some(Member::Seventh),
                _ => None,
            };
            let note = tail
                .starts_with(|c: char| matches!(c, 'A'..='G'))
                .then(|| PitchClass::parse_prefix(tail).filter(|(_, n)| *n == tail.len()).map(|(pc, _)| pc))
                .flatten();
            if member.is_some() || note.is_some() || tail.starts_with(|c: char| c.is_ascii_digit()) {
                let mut c = Self::parse(head, key)?;
                c.bass = Some(match (member, note) {
                    (Some(m), _) => c.member(m).ok_or_else(|| format!("{t:?}: {} has no {}", c.name(), tail_name(tail)))?,
                    (_, Some(pc)) => pc,
                    _ => return Err(format!("{t:?}: after the slash, a bass is 1, 3, 5 or 7 (a chord tone) or a note like D or Bb")),
                });
                c.label = t.to_string();
                return Ok(c);
            }
        }
        let first = t.chars().next().ok_or("empty chord")?;
        let is_roman = matches!(first, 'b' | '♭' | '#' | '♯') || roman_prefix(t.trim_start_matches(['b', '♭', '#', '♯'])).is_some();
        let mut c = if is_roman { parse_roman(t, key)? } else { parse_symbol(t)? };
        c.label = t.to_string();
        Ok(c)
    }
}

fn tail_name(tail: &str) -> &'static str {
    match tail {
        "7" => "seventh",
        "5" => "fifth",
        _ => "third",
    }
}

impl fmt::Display for Chord {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.name())
    }
}

/// Longest roman numeral at the start of `s` (case-insensitive): (degree 0..7, is_upper, bytes).
fn roman_prefix(s: &str) -> Option<(usize, bool, usize)> {
    const NUMERALS: [(&str, usize); 7] = [("vii", 6), ("iii", 2), ("iv", 3), ("vi", 5), ("ii", 1), ("v", 4), ("i", 0)];
    for (n, deg) in NUMERALS {
        // `get`, not slicing: the text may go on with a multi-byte character (`iiø`).
        if let Some(head) = s.get(..n.len()).filter(|h| h.eq_ignore_ascii_case(n)) {
            let upper = head.chars().all(|c| c.is_ascii_uppercase());
            let lower = head.chars().all(|c| c.is_ascii_lowercase());
            if !(upper || lower) {
                return None; // "Iv" is a typo, not a chord
            }
            return Some((deg, upper, n.len()));
        }
    }
    None
}

fn parse_roman(s: &str, key: Key) -> Result<Chord, String> {
    // Secondary chords: "V/V" = V of the key built on this key's V.
    if let Some((head, target)) = s.split_once('/') {
        let t = parse_roman(target, key).map_err(|e| format!("{s:?}: after '/': {e}"))?;
        // Secondary functions are read against the major scale of the target, by convention.
        return parse_roman(head, Key::new(t.root, Mode::Major));
    }
    let mut rest = s;
    let mut shift = 0;
    while let Some(c) = rest.chars().next() {
        match c {
            'b' | '♭' => shift -= 1,
            '#' | '♯' => shift += 1,
            _ => break,
        }
        rest = &rest[c.len_utf8()..];
    }
    let (degree, upper, n) = roman_prefix(rest).ok_or_else(|| format!("{s:?} is not a roman numeral (I–VII / i–vii)"))?;
    let root = key.degree(degree).transpose(shift);
    let quality = parse_quality(&rest[n..], upper).map_err(|e| format!("{s:?}: {e}"))?;
    Ok(Chord::new(root, quality))
}

fn parse_symbol(s: &str) -> Result<Chord, String> {
    let (root, n) = PitchClass::parse_prefix(s).ok_or_else(|| format!("{s:?} is neither a roman numeral nor a chord symbol"))?;
    let suffix = &s[n..];
    let quality = match suffix {
        "m" | "min" | "-" => Quality::Minor,
        // Minor-based qualities: m7, min7, -7, mMaj7, m7b5 …
        _ if suffix.starts_with("min") => parse_quality(&suffix[3..], false).map_err(|e| format!("{s:?}: {e}"))?,
        _ if suffix.starts_with('-') => parse_quality(&suffix[1..], false).map_err(|e| format!("{s:?}: {e}"))?,
        _ if suffix.starts_with('m') && !suffix.starts_with("maj") => {
            parse_quality(&suffix[1..], false).map_err(|e| format!("{s:?}: {e}"))?
        }
        _ => parse_quality(suffix, true).map_err(|e| format!("{s:?}: {e}"))?,
    };
    Ok(Chord::new(root, quality))
}

/// Quality from the text after the root/numeral. `upper` = major-ish base (uppercase numeral
/// or chord symbol without `m`).
fn parse_quality(suffix: &str, upper: bool) -> Result<Quality, String> {
    Ok(match (suffix, upper) {
        ("", true) => Quality::Major,
        ("", false) => Quality::Minor,
        ("o" | "°" | "dim", _) => Quality::Diminished,
        ("o7" | "°7" | "dim7", _) => Quality::Diminished7,
        ("ø" | "ø7", _) | ("7b5" | "7♭5", false) => Quality::HalfDiminished7,
        ("7b5" | "7♭5", true) => {
            return Err("a dominant 7♭5 isn't supported; for half-diminished write m7b5 (or ø / viiø7)".into())
        }
        ("+" | "aug", _) => Quality::Augmented,
        ("sus2", _) => Quality::Sus2,
        ("sus4" | "sus", _) => Quality::Sus4,
        ("7", true) => Quality::Dominant7,
        ("7", false) => Quality::Minor7,
        ("maj7" | "Maj7" | "M7" | "Δ" | "Δ7", true) => Quality::Major7,
        ("maj7" | "Maj7" | "M7" | "Δ" | "Δ7", false) => Quality::MinorMajor7,
        ("6" | "64" | "65" | "43" | "42", _) => {
            return Err(format!("inversion figures ({suffix}) aren't supported; write a slash chord instead, like I/3 or V7/5"))
        }
        _ => return Err(format!("unknown chord quality {suffix:?} (try m, dim, aug, 7, maj7, m7, ø7, dim7, sus4)")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(ch: &Chord) -> Vec<&'static str> {
        ch.pitch_classes().iter().map(|p| p.name()).collect()
    }

    fn roman(s: &str, key: &str) -> Chord {
        Chord::parse(s, key.parse().unwrap()).unwrap()
    }

    #[test]
    fn the_user_example_iv_vs_iv_in_ab_minor() {
        // Fb spelled E: D♭ F♭ A♭ = pitch classes 1, 4, 8.
        assert_eq!(names(&roman("iv", "Abm")), ["Db", "E", "Ab"]);
        assert_eq!(roman("iv", "Abm").name(), "Dbm");
        assert_eq!(names(&roman("IV", "Abm")), ["Db", "F", "Ab"]);
        assert_eq!(roman("IV", "Abm").name(), "Db");
    }

    #[test]
    fn a_short_numeral_before_a_multibyte_suffix() {
        // "iiø" once panicked: the 3-letter numerals were tried by slicing into the ø.
        assert_eq!(roman("iiø", "C").name(), "Dm7b5");
        assert_eq!(roman("viiø", "C").name(), "Bm7b5");
        assert_eq!(roman("i°", "Am").name(), "Adim");
    }

    #[test]
    fn voicings() {
        let c7 = roman("V7", "F");
        assert_eq!(c7.voiced(Voicing::Root), [0]);
        assert_eq!(c7.voiced(Voicing::Power), [0, 7]);
        assert_eq!(c7.voiced(Voicing::Triad), [0, 4, 7]);
        assert_eq!(c7.voiced(Voicing::Seventh), [0, 4, 7, 10]);
        assert_eq!(roman("I", "F").voiced(Voicing::Seventh), [0, 4, 7], "a triad stays a triad");
        assert_eq!(roman("viio", "C").voiced(Voicing::Power), [0, 6], "a diminished fifth");
        assert_eq!(Voicing::parse("triad"), Ok(Voicing::Triad));
        assert!(Voicing::parse("cluster").is_err());
    }

    #[test]
    fn romans_in_major_and_minor() {
        assert_eq!(roman("I", "C").name(), "C");
        assert_eq!(roman("ii", "C").name(), "Dm");
        assert_eq!(roman("V7", "C").name(), "G7");
        assert_eq!(roman("vii°", "C").name(), "Bdim");
        assert_eq!(roman("viiø7", "C").name(), "Bm7b5");
        assert_eq!(roman("bVI", "C").name(), "Ab");
        assert_eq!(roman("bVII", "C").name(), "Bb");
        assert_eq!(roman("Imaj7", "Eb").name(), "Ebmaj7");
        assert_eq!(roman("VI", "Abm").name(), "E"); // F♭ major, spelled enharmonically
        assert_eq!(roman("VII", "Am").name(), "G");
        assert_eq!(roman("V", "A harmonic minor").name(), "E");
        assert_eq!(roman("v", "Am").name(), "Em");
        assert_eq!(roman("V/V", "C").name(), "D");
        assert_eq!(roman("V7/ii", "C").name(), "A7");
        assert_eq!(roman("viio7/V", "C").name(), "F#dim7".replace("F#", "Gb")); // G♭ = F♯
    }

    #[test]
    fn symbols() {
        let c = |s: &str| Chord::parse(s, "C".parse().unwrap()).unwrap().name();
        assert_eq!(c("Dbm"), "Dbm");
        assert_eq!(c("C#m"), "Dbm");
        assert_eq!(c("Eb7"), "Eb7");
        assert_eq!(c("Bbmaj7"), "Bbmaj7");
        assert_eq!(c("F#dim"), "Gbdim");
        assert_eq!(c("Am7"), "Am7");
        assert_eq!(c("Gsus4"), "Gsus4");
        assert_eq!(c("Bm7b5"), "Bm7b5");
        assert_eq!(c("Cmin7"), "Cm7");
        assert_eq!(c("C-7"), "Cm7");
        assert_eq!(c("C-"), "Cm");
        assert_eq!(c("CmMaj7"), "CmMaj7");
    }

    #[test]
    fn members() {
        let c = roman("iv", "Abm");
        assert_eq!(c.member(Member::Root).unwrap().name(), "Db");
        assert_eq!(c.member(Member::Third).unwrap().name(), "E");
        assert_eq!(c.member(Member::Fifth).unwrap().name(), "Ab");
        assert_eq!(c.member(Member::Seventh), None);
    }

    #[test]
    fn slash_chords() {
        let c = |s: &str| roman(s, "F");
        assert_eq!(c("IV/3").name(), "Bb/D");
        assert_eq!(c("IV/D").name(), "Bb/D");
        assert_eq!(c("Bb/D").name(), "Bb/D");
        assert_eq!(c("IV/3").label, "IV/3");
        assert_eq!(c("I/5").name(), "F/C");
        assert_eq!(c("V7/7").name(), "C7/Bb");
        assert_eq!(c("I/1").name(), "F", "the root in the bass is root position");
        assert_eq!(c("C/Bb").name(), "C/Bb", "a bass outside the chord");
        assert_eq!(names(&c("C/Bb")), ["C", "E", "G", "Bb"]);
        assert_eq!(c("V/V").name(), "G", "still a secondary chord");
        assert_eq!(c("V/V/3").name(), "G/B", "a secondary chord with a bass");
        assert_eq!(c("IV/3").bass_note().name(), "D");
        assert_eq!(c("IV").bass_note().name(), "Bb");
        let key: Key = "F".parse().unwrap();
        assert!(Chord::parse("IV/7", key).unwrap_err().contains("no seventh"));
        assert!(Chord::parse("IV/9", key).unwrap_err().contains("1, 3, 5 or 7"));
    }

    #[test]
    fn inversions_put_the_bass_lowest() {
        let c = |s: &str| Chord::parse(s, "C".parse().unwrap()).unwrap();
        assert_eq!(c("C/E").voiced(Voicing::Triad), [4, 7, 12], "first inversion: E G C");
        assert_eq!(c("C/G").voiced(Voicing::Triad), [-5, 0, 4], "second inversion, G below the root");
        assert_eq!(c("G7/F").voiced(Voicing::Seventh), [-2, 0, 4, 7], "third inversion");
        assert_eq!(c("C/Bb").voiced(Voicing::Triad), [-2, 0, 4, 7], "a bass outside the chord goes under it");
        assert_eq!(c("C/E").voiced(Voicing::Root), [4], "the bass line plays the bass");
        assert_eq!(c("C/E").voiced(Voicing::Power), [4, 7, 12]);
        assert_eq!(c("C").voiced(Voicing::Triad), [0, 4, 7]);
    }

    #[test]
    fn helpful_errors() {
        let key: Key = "C".parse().unwrap();
        assert!(Chord::parse("Iv", key).unwrap_err().contains("neither"));
        assert!(Chord::parse("I6", key).unwrap_err().contains("inversion"));
        assert!(Chord::parse("C7b5", key).unwrap_err().contains("m7b5"));
        assert!(Chord::parse("Vxyz", key).unwrap_err().contains("unknown chord quality"));
        assert!(Chord::parse("H7", key).is_err());
    }
}
