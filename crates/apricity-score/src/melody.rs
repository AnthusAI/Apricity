//! What the Melodies editor (the piano roll) needs from a score: its key's scale (to label rows), and every track
//! that plays a `notes` melody, with the line it's written on and its notes. The web app rewrites only the quoted
//! melody on that line; the text stays the score.

use crate::beat::{last_line, statement};
use crate::dsl;
use crate::score::{parse_notes, Pattern, Sound};
use apricity_theory::key::Key;
use serde_json::{json, Value};

/// The melody view of an `.apr` score, or its parse errors.
pub fn melody_view(text: &str) -> Result<Value, Vec<String>> {
    let (score, map) = dsl::parse(text).map_err(|es| es.iter().map(|e| e.to_string()).collect::<Vec<_>>())?;
    let lines: Vec<&str> = text.lines().collect();
    let find = |word: &str| lines.iter().position(|l| statement(l) == Some(word)).map(|i| i + 1);
    let scale: Vec<Value> = match score.key.parse::<Key>() {
        Ok(k) => (0..7).map(|d| json!({ "degree": d + 1, "semitones": k.mode.steps()[d], "name": k.degree(d).name() })).collect(),
        Err(_) => Vec::new(),
    };
    let mut tracks = Vec::new();
    for (i, t) in score.tracks.iter().enumerate() {
        let Pattern::Notes(src) = &t.pattern else { continue };
        let line = map.tracks.get(i).copied().unwrap_or(0);
        let mut v = json!({
            "index": i,
            "line": line,
            "lastLine": if line > 0 { last_line(&lines, line) } else { 0 },
            "name": t.name.clone().unwrap_or_else(|| t.clip.clone()),
            "clip": t.clip,
            "grid": t.grid.unwrap_or(16),
            "octave": t.octave,
        });
        match parse_notes(src) {
            Ok((steps, n)) => {
                v["steps"] = steps
                    .iter()
                    .filter_map(|s| match s.sound {
                        Some(Sound::Degree { degree, accidental, octave }) => {
                            Some(json!({ "at": s.at, "len": s.len, "degree": degree, "accidental": accidental, "octave": octave, "vel": s.vel }))
                        }
                        _ => None,
                    })
                    .collect();
                v["nSteps"] = json!(n);
            }
            Err(e) => v["error"] = json!(e),
        }
        tracks.push(v);
    }
    Ok(json!({
        "key": score.key,
        "tempo": score.tempo,
        "meter": score.meter,
        "bars": score.bars,
        "barsLine": find("bars"),
        "tempoLine": find("tempo"),
        "scale": scale,
        "tracks": tracks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_tracks_and_notes() {
        let text = "tempo 100\nkey F major\nbars 2\nclip horn = a.wav  shot-7\nclip tuba = b.wav\n\ntrack horn  notes \"5 _ b3 . 1' | 7,@80 . . .\"  grid 8   # the tune\n  pan -10\ntrack tuba  follow\ntrack horn  as echo  notes \"1\"\n";
        let v = melody_view(text).unwrap();
        assert_eq!(v["key"], "F major");
        assert_eq!(v["barsLine"], 3);
        assert_eq!(v["scale"][4], json!({ "degree": 5, "semitones": 7, "name": "C" }));
        assert_eq!(v["scale"][3]["name"], "Bb");
        let t = &v["tracks"];
        assert_eq!(t.as_array().unwrap().len(), 2, "only the notes tracks");
        assert_eq!((t[0]["line"].as_u64(), t[0]["lastLine"].as_u64()), (Some(7), Some(8)), "its pan line belongs to it");
        assert_eq!((t[0]["grid"].as_u64(), t[0]["nSteps"].as_f64()), (Some(8), Some(9.0)));
        assert_eq!(t[0]["steps"][0], json!({ "at": 0.0, "len": 2.0, "degree": 5, "accidental": 0, "octave": 0, "vel": null }));
        assert_eq!(t[0]["steps"][1], json!({ "at": 2.0, "len": 1.0, "degree": 3, "accidental": -1, "octave": 0, "vel": null }));
        assert_eq!(t[0]["steps"][3], json!({ "at": 5.0, "len": 1.0, "degree": 7, "accidental": 0, "octave": -1, "vel": 80 }));
        assert_eq!(t[1]["name"], "echo");
        let dorian = melody_view("tempo 90\nkey D dorian\nclip a = a.wav\ntrack a notes \"1\"\n").unwrap();
        let names: Vec<&str> = dorian["scale"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["D", "E", "F", "G", "A", "B", "C"]);
    }

    #[test]
    fn bad_melodies_and_scores() {
        let v = melody_view("tempo 90\nkey C\nclip a = a.wav\ntrack a notes \"1 . 3\"\n").unwrap();
        assert!(v["tracks"][0]["error"].is_null());
        assert!(melody_view("tempo\n").is_err());
    }
}
