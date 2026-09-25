//! What the Chords editor (the chord harp) needs from a score: its key and the chords that key offers, the
//! progression with the lines it is written on, and the strings (tracks the harmony solver moves, with their jobs).
//! The web app writes its edits back into those lines; the text stays the score.

use crate::assist::palette;
use crate::beat::{last_line, statement};
use crate::dsl;
use crate::score::WarpModeSpec;
use apricity_theory::key::Key;
use serde_json::{json, Value};

/// The chords view of an `.apr` score, or its parse errors.
pub fn chords_view(text: &str) -> Result<Value, Vec<String>> {
    let (score, map) = dsl::parse(text).map_err(|es| es.iter().map(|e| e.to_string()).collect::<Vec<_>>())?;
    let lines: Vec<&str> = text.lines().collect();
    let find = |word: &str| lines.iter().position(|l| statement(l) == Some(word)).map(|i| i + 1);
    let chord_lines: Vec<[usize; 2]> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| statement(l) == Some("chords"))
        .map(|(i, _)| [i + 1, last_line(&lines, i + 1)])
        .collect();
    let key: Option<Key> = score.key.parse().ok();

    let mut strings = Vec::new();
    for (i, t) in score.tracks.iter().enumerate() {
        let kit = score.kits.contains_key(&t.clip) || t.clip.split_once('.').is_some_and(|(k, _)| score.kits.contains_key(k));
        let repitch = score.clips.get(&t.clip).is_some_and(|c| c.warp == WarpModeSpec::Repitch);
        if kit || repitch {
            continue;
        }
        let line = map.tracks.get(i).copied().unwrap_or(0);
        strings.push(json!({
            "index": i,
            "line": line,
            "lastLine": if line > 0 { last_line(&lines, line) } else { 0 },
            "clip": t.clip,
            "name": t.name.clone().unwrap_or_else(|| t.clip.clone()),
            "role": t.role,
            "transpose": t.transpose,
            "bars": t.bars,
        }));
    }

    Ok(json!({
        "key": score.key,
        "keyLine": find("key"),
        "tempo": score.tempo,
        "meter": score.meter,
        "barsLine": find("bars"),
        "chordLines": chord_lines,
        "progression": score.progression.iter().map(|c| json!({ "label": c.chord, "bars": c.bars })).collect::<Vec<_>>(),
        "strings": strings,
        "palette": key.map(palette).unwrap_or_default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLUES: &str = "# blues\ntempo 92\nkey F mixolydian   # dominant sevenths in key\nclip groove = a.wav warp beats\nclip tuba = b.wav\nclip bell = c.wav warp repitch\nclip k = d.wav\nkit drums\n  k = k\n\nchords I7 IV7 I7 . | IV7 . I7 .\nchords [V7 IV7] I7*2\n\ntrack groove  transpose 0\ntrack tuba    follow\ntrack tuba as t3 role third\ntrack bell\ntrack drums.k steps \"x . . .\"\n";

    #[test]
    fn key_lines_progression_and_strings() {
        let v = chords_view(BLUES).unwrap();
        assert_eq!(v["key"], "F mixolydian");
        assert_eq!(v["keyLine"], 3);
        assert_eq!(v["chordLines"], json!([[11, 11], [12, 12]]));
        let p: Vec<(String, f64)> = v["progression"].as_array().unwrap().iter().map(|c| (c["label"].as_str().unwrap().to_string(), c["bars"].as_f64().unwrap())).collect();
        assert_eq!(p[0], ("I7".to_string(), 1.0));
        assert_eq!(p[2], ("I7".to_string(), 2.0), "a held chord");
        assert!(p.iter().any(|(l, b)| l == "V7" && *b == 0.5), "a split bar: {p:?}");
        let s = v["strings"].as_array().unwrap();
        assert_eq!(s.iter().map(|x| x["name"].as_str().unwrap()).collect::<Vec<_>>(), ["groove", "tuba", "t3"], "no re-pitched clip, no kit");
        assert_eq!(s[0]["transpose"], 0);
        assert_eq!(s[1]["transpose"], "follow");
        assert_eq!((s[2]["role"].as_str(), s[2]["line"].as_u64()), (Some("third"), Some(16)));
        assert_eq!(v["palette"][0]["numeral"], "I");
    }
}
