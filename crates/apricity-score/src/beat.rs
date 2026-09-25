//! What a step-sequencer view of a score needs: its kits (pads in written order, with their lines), and every track
//! that plays a kit with a step pattern (its line span, options and parsed steps). The web app's Beat editor reads
//! this to draw a grid, and writes its edits back into the text by replacing those lines; the text stays the score.

use crate::dsl;
use crate::score::{parse_steps, Pattern, Sound, TrackSpec};
use serde_json::{json, Value};

/// The statement word of a non-indented line (comments and blank lines have none).
pub(crate) fn statement(line: &str) -> Option<&str> {
    if line.starts_with([' ', '\t']) {
        return None;
    }
    let code = line.split('#').next().unwrap_or("").trim();
    code.split_whitespace().next()
}

/// The last line (1-based) of the statement starting at `line`: it and the indented lines under it (blank lines
/// in between count only when more indented lines follow).
pub(crate) fn last_line(lines: &[&str], line: usize) -> usize {
    let mut last = line;
    for (i, l) in lines.iter().enumerate().skip(line) {
        if l.trim().is_empty() {
            continue;
        }
        if l.starts_with([' ', '\t']) {
            last = i + 1;
        } else {
            break;
        }
    }
    last
}

/// Whether a step track uses anything a step grid does not show (the grid shows steps, volume, swing and grid).
/// Tracks without steps (`at 1`, `loop`) are not on the grid at all; the editor leaves them alone.
fn has_other(t: &TrackSpec) -> bool {
    t.name.is_some()
        || t.role != Default::default()
        || t.transpose != Default::default()
        || t.bars.is_some()
        || t.reverse
        || t.filter.is_some()
        || t.gate.is_some()
        || t.stutter.is_some()
        || t.speed.is_some()
        || t.swing_base.is_some()
        || t.velocity.is_some()
        || t.humanize.is_some()
        || t.seed.is_some()
        || !t.effects.is_empty()
        || t.pan.is_some()
        || t.group.is_some()
        || !t.sends.is_empty()
}

fn sound(s: &Option<Sound>) -> Value {
    match s {
        None => Value::Null,
        Some(Sound::This) => json!("x"),
        Some(Sound::Name(n)) => json!(n),
        Some(Sound::Index(i)) => json!(i),
    }
}

/// The step view of an `.apr` score, or its parse errors.
pub fn beat_view(text: &str) -> Result<Value, Vec<String>> {
    let (score, map) = dsl::parse(text).map_err(|es| es.iter().map(|e| e.to_string()).collect::<Vec<_>>())?;
    let lines: Vec<&str> = text.lines().collect();
    let find = |word: &str| lines.iter().position(|l| statement(l) == Some(word)).map(|i| i + 1);

    let mut kits = Vec::new();
    for (name, kit) in &score.kits {
        let line = map.kits.get(name).copied().unwrap_or(0);
        let last = if line > 0 { last_line(&lines, line) } else { 0 };
        // Pads in the order they are written (the score keeps them sorted by name).
        let mut pads = Vec::new();
        for (i, l) in lines.iter().enumerate().take(last).skip(line) {
            let code = l.split('#').next().unwrap_or("").trim();
            if let Some((pad, _)) = code.split_once('=') {
                let pad = pad.trim();
                if kit.pads.contains_key(pad) {
                    pads.push(json!({ "name": pad, "line": i + 1 }));
                }
            }
        }
        kits.push(json!({ "name": name, "line": line, "lastLine": last, "sliced": kit.slice.is_some(), "pads": pads }));
    }

    let mut tracks = Vec::new();
    for (i, t) in score.tracks.iter().enumerate() {
        let (kit, pad) = match t.clip.split_once('.') {
            Some((k, p)) if score.kits.contains_key(k) => (Some(k.to_string()), Some(p.to_string())),
            _ if score.kits.contains_key(&t.clip) => (Some(t.clip.clone()), None),
            _ => (None, None),
        };
        let line = map.tracks.get(i).copied().unwrap_or(0);
        let mut v = json!({
            "index": i,
            "line": line,
            "lastLine": if line > 0 { last_line(&lines, line) } else { 0 },
            "sound": t.clip,
            "kit": kit,
            "pad": pad,
            "grid": t.grid.unwrap_or(16),
            "swing": t.swing.unwrap_or(50.0),
            "volume": t.volume,
            "other": has_other(t),
        });
        if let Pattern::Steps(src) = &t.pattern {
            match parse_steps(src) {
                Ok((steps, n)) => {
                    v["steps"] = steps
                        .iter()
                        .map(|s| {
                            let mut o = json!({ "at": s.at, "len": s.len, "sound": sound(&s.sound) });
                            if let Some(v) = s.vel {
                                o["vel"] = json!(v);
                            }
                            o
                        })
                        .collect();
                    v["nSteps"] = json!(n);
                }
                Err(e) => v["error"] = json!(e),
            }
        }
        tracks.push(v);
    }

    Ok(json!({
        "tempo": score.tempo,
        "tempoLine": find("tempo"),
        "meter": score.meter,
        "bars": score.bars,
        "barsLine": find("bars"),
        "kits": kits,
        "tracks": tracks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEAT: &str = "# a beat\ntempo 96\nkey C major\nbars 2\n\nclip kick = a.wav  warp repitch\nclip hat = b.wav\n\nkit drums\n  kick = kick   # the kick\n  hat  = hat\n\n# steps\ntrack drums      steps \"kick . . . [kick kick] . _ .\"  volume -3\ntrack drums.hat  steps \"x . x .\"  swing 56\n  pan -20\ntrack drums.kick at 1\n";

    #[test]
    fn kits_tracks_lines_and_steps() {
        let v = beat_view(BEAT).unwrap();
        assert_eq!(v["tempo"], 96.0);
        assert_eq!(v["tempoLine"], 2);
        assert_eq!(v["bars"], 2);
        assert_eq!(v["barsLine"], 4);
        let kit = &v["kits"][0];
        assert_eq!(kit["name"], "drums");
        assert_eq!((kit["line"].as_u64(), kit["lastLine"].as_u64()), (Some(9), Some(11)));
        assert_eq!(kit["pads"], json!([{ "name": "kick", "line": 10 }, { "name": "hat", "line": 11 }]), "written order, not sorted");
        assert_eq!(kit["sliced"], false);

        let t = &v["tracks"];
        assert_eq!((t[0]["line"].as_u64(), t[0]["lastLine"].as_u64()), (Some(14), Some(14)));
        assert_eq!((t[0]["kit"].as_str(), t[0]["pad"].as_str()), (Some("drums"), None));
        assert_eq!(t[0]["volume"], -3.0);
        assert_eq!(t[0]["other"], false);
        assert_eq!(t[0]["nSteps"], 8.0);
        assert_eq!(t[0]["steps"][0], json!({ "at": 0.0, "len": 1.0, "sound": "kick" }));
        assert_eq!(t[0]["steps"][4], json!({ "at": 4.0, "len": 0.5, "sound": "kick" }), "a split step");
        assert_eq!(t[0]["steps"][6], json!({ "at": 5.0, "len": 2.0, "sound": null }), "a rest held by _");

        assert_eq!((t[1]["pad"].as_str(), t[1]["swing"].as_f64()), (Some("hat"), Some(56.0)));
        assert_eq!((t[1]["line"].as_u64(), t[1]["lastLine"].as_u64()), (Some(15), Some(16)), "its pan line belongs to it");
        assert_eq!(t[1]["other"], true, "pan is not on the grid");
        assert_eq!(t[1]["steps"][0]["sound"], "x");
        assert_eq!(t[2]["other"], false, "a track without steps is not on the grid");
        assert!(t[2].get("steps").is_none());
    }

    #[test]
    fn sliced_kits_and_errors() {
        let v = beat_view("tempo 90\nkey C major\nclip brk = a.wav\nkit b = slice brk by beats 0.5\ntrack b steps \"1 . 2 3\"\n").unwrap();
        assert_eq!(v["kits"][0]["sliced"], true);
        assert_eq!(v["tracks"][0]["steps"][2]["sound"], 2);
        assert_eq!(v["barsLine"], Value::Null);
        assert!(beat_view("tempo\n").is_err());
    }
}
