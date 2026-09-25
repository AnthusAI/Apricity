//! The Apricity text language (`.apr` files): a compact way to write a score. It parses into
//! the same `Score` as YAML, so every check the compiler makes applies unchanged.
//!
//! ```text
//! tempo 100
//! key F mixolydian
//! samples ../samples
//!
//! clip tuba  = marine-band/stems/WashingtonPost/bass.wav  pick 1bar
//! clip horns = marine-band/stems/WashingtonPost/other.wav beats 32..36 root C
//!
//! chords I7 IV7 I7 . | IV7 . I7 . | V7 IV7 I7 [V7 IV7]
//!
//! track tuba  follow
//! track horns as riff  follow  bars 5-12  volume -2
//! ```
//!
//! Chords: one per bar; `.` or `%` holds the previous chord; `X*2` lasts two bars (`*0.5` half);
//! `[A B]` splits one bar evenly; `(A B C D)*2` repeats a group; `|` is only for reading.
//! Several `chords` lines append.

use crate::score::{
    ChordSpec, ClipSpec, CompSpec, DelaySpec, DriveSpec, Effect, EqSpec, GateSpec, LofiSpec, FilterSpec, KitSpec, GroupSpec, ReturnSpec, SliceBy, LimitSpec, MasterSpec, PadSpec, Pattern, ReverbSpec, ReverbType, Score, TrackSpec,
    Transpose, WarpModeSpec,
};
use apricity_theory::Role;
use std::collections::BTreeMap;

/// Where things came from, so compiler errors (which name `tracks[2]`, `clips.tuba`,
/// `progression[5]`) can point at a line.
#[derive(Debug, Default, Clone)]
pub struct SourceMap {
    pub master: Option<usize>,
    pub clips: BTreeMap<String, usize>,
    pub kits: BTreeMap<String, usize>,
    pub groups: BTreeMap<String, usize>,
    pub returns: BTreeMap<String, usize>,
    pub tracks: Vec<usize>,
    /// (line, column) of each progression entry.
    pub chords: Vec<(usize, usize)>,
}

impl SourceMap {
    /// Rewrite a compiler error that names a score location into "line N column C: …".
    pub fn locate(&self, err: &str) -> String {
        let at = |line: usize, col: usize, rest: &str| format!("line {line} column {col}: {rest}");
        if let Some(rest) = err.strip_prefix("tracks[") {
            if let Some((i, tail)) = rest.split_once(']') {
                if let Some(&line) = i.parse::<usize>().ok().and_then(|i| self.tracks.get(i)) {
                    return at(line, 1, &format!("track{}", tail));
                }
            }
        }
        if let Some(rest) = err.strip_prefix("clips.") {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
            if let Some(&line) = self.clips.get(&name) {
                return at(line, 1, &format!("clip {rest}"));
            }
        }
        if let (Some(rest), Some(line)) = (err.strip_prefix("master"), self.master) {
            return at(line, 1, &format!("master{rest}"));
        }
        if let Some(rest) = err.strip_prefix("kits.") {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
            if let Some(&line) = self.kits.get(&name) {
                return at(line, 1, &format!("kit {rest}"));
            }
        }
        for (prefix, lines, word) in [("groups.", &self.groups, "group"), ("returns.", &self.returns, "return")] {
            if let Some(rest) = err.strip_prefix(prefix) {
                let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
                if let Some(&line) = lines.get(&name) {
                    return at(line, 1, &format!("{word} {rest}"));
                }
            }
        }
        if let Some(rest) = err.strip_prefix("progression[") {
            if let Some((i, tail)) = rest.split_once(']') {
                if let Some(&(line, col)) = i.parse::<usize>().ok().and_then(|i| self.chords.get(i)) {
                    return at(line, col, &format!("chord{}", tail));
                }
            }
        }
        err.to_string()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "line {} column {}: {}", self.line, self.column, self.message)
    }
}

/// A word on a line, with its 1-based column.
#[derive(Debug, Clone, Copy)]
struct Tok<'a> {
    text: &'a str,
    col: usize,
}

fn words(line: &str) -> Vec<Tok<'_>> {
    // A comment starts at a '#' outside quotes.
    let mut in_quote = false;
    let mut end = line.len();
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quote = !in_quote,
            '#' if !in_quote => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let code = &line[..end];
    let col = |i: usize| code[..i].chars().count() + 1;
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut chars = code.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '"' && start.is_none() {
            // A quoted token: everything up to the closing quote (or the end of the line).
            let from = i + 1;
            let mut to = code.len();
            for (j, d) in chars.by_ref() {
                if d == '"' {
                    to = j;
                    break;
                }
            }
            out.push(Tok { text: &code[from..to], col: col(i) });
            continue;
        }
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(st)) => {
                out.push(Tok { text: &code[st..i], col: col(st) });
                start = None;
            }
            _ => {}
        }
    }
    if let Some(st) = start {
        out.push(Tok { text: &code[st..], col: col(st) });
    }
    out
}

const STATEMENTS: &[&str] = &["apricity", "tempo", "time", "key", "samples", "bars", "clip", "kit", "chords", "track", "group", "return", "master"];
const TRACK_LINES: &[&str] = &["eq", "comp", "limit", "reverb", "delay", "drive", "lofi", "noisegate", "width", "pan", "send"];
const GROUP_LINES: &[&str] = &["eq", "comp", "limit", "reverb", "delay", "drive", "lofi", "noisegate", "width"];
const MASTER_LINES: &[&str] = &["eq", "comp", "limit", "width", "loudness"];
const EFFECTS: &[&str] = &["eq", "comp", "limit", "reverb", "delay", "drive", "lofi", "noisegate", "width"];

/// What indented lines belong to.
#[derive(Debug, Clone)]
enum Block {
    Track(usize),
    Group(String),
    Return(String),
    Master,
}

/// Shares: `25%`, or a level in dB (`-12dB`) for sends. Returns 0–1 (linear).
fn share(t: &str, db_ok: bool) -> Option<f64> {
    if let Some(p) = t.strip_suffix('%') {
        return p.parse::<f64>().ok().map(|v| v / 100.0);
    }
    if db_ok {
        return db(t).map(|d| 10f64.powf(d / 20.0));
    }
    None
}

/// Musical note values in beats (a quarter note is one beat): `1/8`, `1/8.` (dotted), `1/4t`
/// (triplet), or `3beats`.
fn note_beats(t: &str) -> Option<f64> {
    if let Some(b) = t.strip_suffix("beats").or_else(|| t.strip_suffix("beat")) {
        return b.parse().ok();
    }
    let d = t.strip_prefix("1/")?;
    let (d, mul) = if let Some(d) = d.strip_suffix('.') {
        (d, 1.5)
    } else if let Some(d) = d.strip_suffix('t') {
        (d, 2.0 / 3.0)
    } else {
        (d, 1.0)
    };
    let d: f64 = d.parse().ok()?;
    (d > 0.0).then(|| 4.0 / d * mul)
}

fn note_text(beats: f64) -> String {
    for d in [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0] {
        for (mul, suffix) in [(1.0, ""), (1.5, "."), (2.0 / 3.0, "t")] {
            if (beats - 4.0 / d * mul).abs() < 1e-12 {
                return format!("1/{d}{suffix}");
            }
        }
    }
    format!("{}beats", num(beats))
}

fn pct(x: f64) -> String {
    format!("{}%", num((x * 100.0 * 1e4).round() / 1e4))
}

/// A send level, written so it reads back exactly: a tidy percentage when that's exact, else dB.
fn send_text(x: f64) -> String {
    let p = pct(x);
    if share(&p, false) == Some(x) {
        return p;
    }
    let d = format!("{}dB", 20.0 * x.log10());
    if share(&d, true) == Some(x) {
        return d;
    }
    format!("{}%", x * 100.0)
}

/// Frequencies: `120`, `120Hz`, `6k`, `6kHz`.
fn hz(t: &str) -> Option<f64> {
    let l = t.to_ascii_lowercase();
    let l = l.strip_suffix("hz").unwrap_or(&l);
    match l.strip_suffix('k') {
        Some(k) => k.parse::<f64>().ok().map(|v| v * 1000.0),
        None => l.parse().ok(),
    }
}

/// Levels must say `dB`: `-18dB`, `+3dB`.
fn db(t: &str) -> Option<f64> {
    let l = t.to_ascii_lowercase();
    l.strip_suffix("db")?.trim_start_matches('+').parse().ok()
}

/// Times must say `ms` or `s`: `10ms`, `0.2s`.
fn ms(t: &str) -> Option<f64> {
    let l = t.to_ascii_lowercase();
    if let Some(v) = l.strip_suffix("ms") {
        return v.parse().ok();
    }
    l.strip_suffix('s')?.parse::<f64>().ok().map(|v| v * 1000.0)
}

/// `-3@250`, `+2dB@6k`: a gain (dB implied) at a frequency.
fn gain_at(t: &str) -> Option<[f64; 2]> {
    let (g, f) = t.split_once('@')?;
    let g = g.to_ascii_lowercase();
    let g: f64 = g.strip_suffix("db").unwrap_or(&g).trim_start_matches('+').parse().ok()?;
    Some([g, hz(f)?])
}

/// Parse one effect line (`eq …`, `comp …`, `limit …`) starting after its keyword.
fn effect_line(l: &mut Line, kind: Tok) -> Result<Effect, ParseError> {
    match kind.text {
        "eq" => {
            let mut e = EqSpec::default();
            while let Some(t) = l.peek() {
                l.pos += 1;
                match t.text {
                    "lowcut" | "highcut" => {
                        let v = l.next("a frequency like 120 or 6k")?;
                        let f = hz(v.text).ok_or_else(|| l.err(v.col, format!("`{}` isn't a frequency (e.g. 120, 120Hz, 6k)", v.text)))?;
                        if t.text == "lowcut" { e.lowcut = Some(f) } else { e.highcut = Some(f) }
                    }
                    "low" | "high" => {
                        let v = l.next("a shelf like -3@250")?;
                        let b = gain_at(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write a shelf as gain@frequency, e.g. -3@250 or +2@6k", v.text)))?;
                        if t.text == "low" { e.low = Some(b) } else { e.high = Some(b) }
                    }
                    "peak" => {
                        let v = l.next("a band like -4@800")?;
                        let [g, f] = gain_at(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write a band as gain@frequency, e.g. -4@800", v.text)))?;
                        let mut q = 1.0;
                        if let Some(n) = l.peek() {
                            if let Some(qv) = n.text.strip_prefix('q').or_else(|| n.text.strip_prefix('Q')) {
                                l.pos += 1;
                                q = if qv.is_empty() { l.num("a Q like 1.4")? } else { qv.parse().map_err(|_| l.err(n.col, format!("`{}`: Q is a number, e.g. q1.4", n.text)))? };
                            }
                        }
                        e.peaks.push([g, f, q]);
                    }
                    other => return Err(l.err(t.col, format!("unknown eq part `{other}`{}", suggest(other, &["lowcut", "highcut", "low", "high", "peak"])))),
                }
            }
            Ok(Effect::Eq(e))
        }
        "comp" => {
            let r = l.next("a ratio like 4:1")?;
            let ratio = r.text.strip_suffix(":1").and_then(|x| x.parse().ok()).ok_or_else(|| l.err(r.col, format!("`{}`: write the ratio like 4:1", r.text)))?;
            let t = l.next("a threshold like -18dB")?;
            let threshold = db(t.text).ok_or_else(|| l.err(t.col, format!("`{}`: write the threshold in dB, e.g. -18dB", t.text)))?;
            let mut c = CompSpec { ratio, threshold, attack_ms: None, release_ms: None, knee: None, makeup: None, sidechain: None };
            while let Some(o) = l.peek() {
                l.pos += 1;
                let v = l.next("a value")?;
                match o.text {
                    "sidechain" => c.sidechain = Some(v.text.to_string()),
                    "attack" | "release" => {
                        let x = ms(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write times with ms or s, e.g. 10ms", v.text)))?;
                        if o.text == "attack" { c.attack_ms = Some(x) } else { c.release_ms = Some(x) }
                    }
                    "knee" | "makeup" => {
                        let x = db(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write levels in dB, e.g. 6dB", v.text)))?;
                        if o.text == "knee" { c.knee = Some(x) } else { c.makeup = Some(x) }
                    }
                    other => return Err(l.err(o.col, format!("unknown comp part `{other}`{}", suggest(other, &["attack", "release", "knee", "makeup", "sidechain"])))),
                }
            }
            Ok(Effect::Comp(c))
        }
        "limit" => {
            let t = l.next("a ceiling like -1dB")?;
            let ceiling = db(t.text).ok_or_else(|| l.err(t.col, format!("`{}`: write the ceiling in dB, e.g. -1dB", t.text)))?;
            let mut lim = LimitSpec { ceiling, release_ms: None };
            if let Some(o) = l.peek() {
                l.pos += 1;
                if o.text != "release" {
                    return Err(l.err(o.col, format!("unknown limit part `{}` (only release)", o.text)));
                }
                let v = l.next("a release like 50ms")?;
                lim.release_ms = Some(ms(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write times with ms or s, e.g. 50ms", v.text)))?);
            }
            Ok(Effect::Limit(lim))
        }
        "reverb" => {
            let mut r = ReverbSpec::default();
            while let Some(t) = l.peek() {
                l.pos += 1;
                match t.text {
                    "room" => r.kind = ReverbType::Room,
                    "hall" => r.kind = ReverbType::Hall,
                    "plate" => r.kind = ReverbType::Plate,
                    "predelay" => {
                        let v = l.next("a predelay like 20ms")?;
                        r.predelay_ms = Some(ms(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write times with ms or s, e.g. 20ms", v.text)))?);
                    }
                    "damp" | "mix" => {
                        let v = l.next("a percentage like 50%")?;
                        let x = share(v.text, false).ok_or_else(|| l.err(v.col, format!("`{}`: write {} as a percentage, e.g. 50%", v.text, t.text)))?;
                        if t.text == "damp" { r.damp = Some(x) } else { r.mix = Some(x) }
                    }
                    other => match ms(other) {
                        Some(v) if other.ends_with('s') && !other.ends_with("ms") => r.decay_s = Some(v / 1000.0),
                        _ => return Err(l.err(t.col, format!("unknown reverb part `{other}`: reverb [room|hall|plate] [decay like 2.4s] [predelay 20ms] [damp 50%] [mix 30%]{}", suggest(other, &["room", "hall", "plate", "predelay", "damp", "mix"])))),
                    },
                }
            }
            Ok(Effect::Reverb(r))
        }
        "delay" => {
            let t = l.next("a time like 1/8., 1/4t, 3beats or 350ms")?;
            let mut d = DelaySpec::default();
            match (note_beats(t.text), ms(t.text)) {
                (Some(b), _) => d.beats = Some(b),
                (None, Some(m)) => d.ms = Some(m),
                _ => return Err(l.err(t.col, format!("`{}`: write the delay time as a note value (1/8, 1/8. dotted, 1/4t triplet), beats (3beats) or ms (350ms)", t.text))),
            }
            while let Some(o) = l.peek() {
                l.pos += 1;
                match o.text {
                    "pingpong" => d.pingpong = true,
                    "feedback" | "mix" => {
                        let v = l.next("a percentage like 35%")?;
                        let x = share(v.text, false).ok_or_else(|| l.err(v.col, format!("`{}`: write {} as a percentage, e.g. 35%", v.text, o.text)))?;
                        if o.text == "feedback" { d.feedback = Some(x) } else { d.mix = Some(x) }
                    }
                    "hp" | "lp" => {
                        let v = l.next("a frequency like 300 or 6k")?;
                        let f = hz(v.text).ok_or_else(|| l.err(v.col, format!("`{}` isn't a frequency (e.g. 300, 6k)", v.text)))?;
                        if o.text == "hp" { d.highpass = Some(f) } else { d.lowpass = Some(f) }
                    }
                    other => return Err(l.err(o.col, format!("unknown delay part `{other}`{}", suggest(other, &["feedback", "hp", "lp", "pingpong", "mix"])))),
                }
            }
            Ok(Effect::Delay(d))
        }
        "drive" => {
            let v = l.next("a drive like 6dB")?;
            let db_ = db(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write drive in dB, e.g. 6dB", v.text)))?;
            let mut d = DriveSpec { db: db_, tone: None };
            if let Some(o) = l.peek() {
                l.pos += 1;
                if o.text != "tone" {
                    return Err(l.err(o.col, format!("unknown drive part `{}` (only tone, e.g. tone 5k)", o.text)));
                }
                let f = l.next("a frequency like 5k")?;
                d.tone = Some(hz(f.text).ok_or_else(|| l.err(f.col, format!("`{}` isn't a frequency (e.g. 5k)", f.text)))?);
            }
            Ok(Effect::Drive(d))
        }
        "lofi" => {
            let mut f = LofiSpec::default();
            while let Some(t) = l.peek() {
                l.pos += 1;
                let low = t.text.to_ascii_lowercase();
                if let Some(b) = low.strip_suffix("bits").or_else(|| low.strip_suffix("bit")) {
                    f.bits = Some(b.parse().map_err(|_| l.err(t.col, format!("`{}`: write the bit depth like 12bit", t.text)))?);
                } else if t.text == "wow" {
                    let v = l.next("a wow amount like 20%")?;
                    f.wow = Some(share(v.text, false).ok_or_else(|| l.err(v.col, format!("`{}`: write wow as a percentage, e.g. 20%", v.text)))?);
                } else if let Some(r) = hz(t.text) {
                    f.rate = Some(r);
                } else {
                    return Err(l.err(t.col, format!("unknown lofi part `{}`: lofi [bits like 12bit] [rate like 26k] [wow 20%]", t.text)));
                }
            }
            if f == LofiSpec::default() {
                return Err(l.err(kind.col, "lofi needs something to do: bits (12bit), a rate (26k) and/or wow (wow 20%)"));
            }
            Ok(Effect::Lofi(f))
        }
        "noisegate" => {
            let t = l.next("a threshold like -40dB")?;
            let threshold = db(t.text).ok_or_else(|| l.err(t.col, format!("`{}`: write the threshold in dB, e.g. -40dB", t.text)))?;
            let mut g = GateSpec { threshold, ..Default::default() };
            while let Some(o) = l.peek() {
                l.pos += 1;
                let v = l.next("a value")?;
                match o.text {
                    "attack" | "hold" | "release" => {
                        let x = ms(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write times with ms or s, e.g. 100ms", v.text)))?;
                        match o.text {
                            "attack" => g.attack_ms = Some(x),
                            "hold" => g.hold_ms = Some(x),
                            _ => g.release_ms = Some(x),
                        }
                    }
                    "range" => g.range = Some(db(v.text).ok_or_else(|| l.err(v.col, format!("`{}`: write the range in dB, e.g. -60dB", v.text)))?),
                    other => return Err(l.err(o.col, format!("unknown noisegate part `{other}`{}", suggest(other, &["attack", "hold", "release", "range"])))),
                }
            }
            Ok(Effect::NoiseGate(g))
        }
        "width" => {
            let v = l.next("a width like 150% (0% = mono)")?;
            Ok(Effect::Width(share(v.text, false).ok_or_else(|| l.err(v.col, format!("`{}`: write width as a percentage, e.g. 150% (0% = mono)", v.text)))?))
        }
        _ => unreachable!("caller checks the keyword"),
    }
}
const CLIP_OPTIONS: &[&str] = &["beats", "seconds", "pick", "root", "ratio", "warp", "speed"];
const TRACK_OPTIONS: &[&str] = &[
    "as", "role", "follow", "transpose", "every", "at", "steps", "bars", "volume", "loop", "grid", "swing", "reverse", "filter", "gate", "stutter", "half", "double", "speed", "group",
];

fn suggest(word: &str, options: &[&str]) -> String {
    let best = options.iter().map(|o| (lev(word, o), *o)).min();
    match best {
        Some((d, o)) if d <= 2 => format!(" (did you mean `{o}`?)"),
        _ => format!(" (expected one of: {})", options.join(", ")),
    }
}

fn lev(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, &cb) in b.iter().enumerate() {
            cur.push((prev[j] + (ca != cb) as usize).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

struct Line<'a> {
    no: usize,
    toks: Vec<Tok<'a>>,
    pos: usize,
}

impl<'a> Line<'a> {
    fn err(&self, col: usize, message: impl Into<String>) -> ParseError {
        ParseError { line: self.no, column: col, message: message.into() }
    }
    fn end_col(&self) -> usize {
        self.toks.last().map_or(1, |t| t.col + t.text.chars().count())
    }
    fn next(&mut self, what: &str) -> Result<Tok<'a>, ParseError> {
        let t = self.toks.get(self.pos).copied().ok_or_else(|| self.err(self.end_col(), format!("expected {what}")))?;
        self.pos += 1;
        Ok(t)
    }
    fn peek(&self) -> Option<Tok<'a>> {
        self.toks.get(self.pos).copied()
    }
    fn num(&mut self, what: &str) -> Result<f64, ParseError> {
        let t = self.next(what)?;
        t.text.parse().map_err(|_| self.err(t.col, format!("expected {what}, got `{}`", t.text)))
    }
    fn rest(&mut self) -> &'a str {
        let rest = self.toks.get(self.pos).map(|t| t.col);
        self.pos = self.toks.len();
        rest.map_or("", |_| "")
    }
    fn done(&self) -> Result<(), ParseError> {
        match self.peek() {
            Some(t) => Err(self.err(t.col, format!("unexpected `{}`", t.text))),
            None => Ok(()),
        }
    }
}

fn range(l: &Line, t: Tok, what: &str) -> Result<[f64; 2], ParseError> {
    let (a, b) = t.text.split_once("..").ok_or_else(|| l.err(t.col, format!("{what} takes a range like 32..48, got `{}`", t.text)))?;
    let p = |s: &str| s.parse::<f64>().map_err(|_| l.err(t.col, format!("{what} range has a non-number: `{}`", t.text)));
    Ok([p(a)?, p(b)?])
}

/// Parse `.apr` text into a score and a source map.
pub fn parse(src: &str) -> Result<(Score, SourceMap), Vec<ParseError>> {
    let mut score = Score {
        apricity: 0.1,
        tempo: 0.0,
        meter: 4,
        key: String::new(),
        samples: None,
        clips: BTreeMap::new(),
        kits: BTreeMap::new(),
        progression: Vec::new(),
        master: None,
        bars: None,
        tracks: Vec::new(),
        groups: BTreeMap::new(),
        returns: BTreeMap::new(),
    };
    let mut map = SourceMap::default();
    let mut errors = Vec::new();
    let (mut have_tempo, mut have_key) = (false, false);

    // Blocks: indented lines belong to the statement above them.
    //   kit NAME        → pads   (`kick = clip shot-1`)
    //   track …         → the track's mix: effects in order, `pan` and `send`
    //   group NAME …    → the group track's effects
    //   return NAME …   → the return track's effects
    //   master          → the master chain and `loudness`
    let mut pad_kit: Option<(String, usize)> = None;
    let mut mix_block: Option<Block> = None;
    for (i, raw) in src.lines().enumerate() {
        let toks = words(raw);
        if toks.is_empty() {
            continue;
        }
        let indented = raw.starts_with([' ', '\t']);
        if !indented {
            mix_block = None;
            if let Some((k, line)) = pad_kit.take() {
                if score.kits.get(&k).is_some_and(|kit| kit.pads.is_empty()) {
                    errors.push(ParseError { line, column: 1, message: format!("kit `{k}` has no pads; list them on indented lines below it, e.g.  kick = drums shot-1") });
                }
            }
        }
        let mut l = Line { no: i + 1, toks, pos: 0 };
        if indented && mix_block.is_some() {
            let target = mix_block.clone().unwrap();
            let r = (|| -> Result<(), ParseError> {
                let kw = l.next("an effect")?;
                let allowed = match target {
                    Block::Track(_) => TRACK_LINES,
                    Block::Group(_) | Block::Return(_) => GROUP_LINES,
                    Block::Master => MASTER_LINES,
                };
                match (kw.text, &target) {
                    ("reverb" | "delay" | "drive" | "lofi" | "noisegate", Block::Master) => {
                        return Err(l.err(kw.col, format!("`{}` doesn't go on the master (it plays live); put it on a return track and send tracks to it (or on a group track)", kw.text)));
                    }
                    (k, _) if EFFECTS.contains(&k) => {
                        let fx = effect_line(&mut l, kw)?;
                        match &target {
                            Block::Track(t) => score.tracks[*t].effects.push(fx),
                            Block::Group(g) => score.groups.get_mut(g).expect("group exists").effects.push(fx),
                            Block::Return(r) => score.returns.get_mut(r).expect("return exists").effects.push(fx),
                            Block::Master => score.master.get_or_insert_with(MasterSpec::default).effects.push(fx),
                        }
                    }
                    ("pan", Block::Track(t)) => score.tracks[*t].pan = Some(l.num("a pan from -100 (left) to 100 (right)")?),
                    ("send", Block::Track(t)) => {
                        let t = *t;
                        loop {
                            let bus = l.next("a return track's name")?;
                            let v = l.next("a send level like 25% or -12dB")?;
                            let x = share(v.text, true).ok_or_else(|| l.err(v.col, format!("`{}`: write the send level as a percentage (25%) or in dB (-12dB)", v.text)))?;
                            if score.tracks[t].sends.insert(bus.text.to_string(), x).is_some() {
                                return Err(l.err(bus.col, format!("this track already sends to `{}`", bus.text)));
                            }
                            if l.peek().is_none() {
                                break;
                            }
                        }
                    }
                    ("loudness", Block::Master) => {
                        let v = l.next("a loudness like -14LUFS")?;
                        let x = v.text.to_ascii_lowercase();
                        let x = x.strip_suffix("lufs").ok_or_else(|| l.err(v.col, format!("`{}`: write loudness in LUFS, e.g. -14LUFS", v.text)))?;
                        score.master.get_or_insert_with(MasterSpec::default).loudness = Some(x.parse().map_err(|_| l.err(v.col, format!("`{}` isn't a loudness like -14LUFS", v.text)))?);
                    }
                    (other, _) => return Err(l.err(kw.col, format!("`{other}` doesn't belong here{}", suggest(other, allowed)))),
                }
                l.done()
            })();
            if let Err(e) = r {
                errors.push(e);
            }
            continue;
        }
        if indented && pad_kit.is_some() {
            let kit = pad_kit.as_ref().unwrap().0.clone();
            let r = (|| -> Result<(), ParseError> {
                let pad = l.next("a pad name")?;
                if !pad.text.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') || pad.text.chars().all(|c| c.is_ascii_digit()) {
                    return Err(l.err(pad.col, format!("pad names are words like kick or snare-2; got `{}`", pad.text)));
                }
                let eq = l.next("`=`")?;
                if eq.text != "=" {
                    return Err(l.err(eq.col, format!("expected `=` after the pad name, got `{}`", eq.text)));
                }
                let clip = l.next("a clip, or a slice like k.3")?.text.to_string();
                let mut ps = PadSpec { clip, saved: None, beats: None, seconds: None };
                // A saved clip of the sample, named right after the clip: `kick = tdrums shot-1`.
                if let Some(first) = l.peek() {
                    if !["beats", "seconds"].contains(&first.text) {
                        l.pos += 1;
                        ps.saved = Some(first.text.to_string());
                    }
                }
                while let Some(opt) = l.peek() {
                    l.pos += 1;
                    match opt.text {
                        "beats" => {
                            let t = l.next("a beat range")?;
                            ps.beats = Some(range(&l, t, "beats")?);
                        }
                        "seconds" => {
                            let t = l.next("a seconds range")?;
                            ps.seconds = Some(range(&l, t, "seconds")?);
                        }
                        other => return Err(l.err(opt.col, format!("unknown pad option `{other}`{}", suggest(other, &["beats", "seconds"])))),
                    }
                }
                let k = score.kits.get_mut(&kit).expect("pad kit exists");
                if k.pads.insert(pad.text.to_string(), ps).is_some() {
                    return Err(l.err(pad.col, format!("pad `{}` is defined twice in kit `{kit}`", pad.text)));
                }
                Ok(())
            })();
            if let Err(e) = r {
                errors.push(e);
            }
            continue;
        }
        let r = (|| -> Result<(), ParseError> {
            let head = l.next("a statement")?;
            match head.text {
                "apricity" => score.apricity = l.num("a format version like 0.1")?,
                "tempo" => {
                    score.tempo = l.num("a tempo in BPM")?;
                    have_tempo = true;
                }
                "time" => {
                    let t = l.next("a time signature like 4/4")?;
                    score.meter = crate::score::parse_time_signature(t.text).map_err(|e| l.err(t.col, e))?;
                }
                "key" => {
                    let from = l.peek().ok_or_else(|| l.err(l.end_col(), "expected a key like Abm or \"F mixolydian\""))?.col;
                    let code = raw.split('#').next().unwrap_or("");
                    score.key = code.chars().skip(from - 1).collect::<String>().trim().to_string();
                    l.rest();
                    have_key = true;
                    return Ok(());
                }
                "samples" => score.samples = Some(l.next("a folder")?.text.to_string()),
                "bars" => {
                    let t = l.next("a number of bars")?;
                    score.bars = Some(t.text.parse().map_err(|_| l.err(t.col, format!("bars is a whole number, got `{}`", t.text)))?);
                }
                "clip" => {
                    let name = l.next("a clip name")?;
                    if !name.text.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                        return Err(l.err(name.col, format!("clip names are letters, digits, - and _; got `{}`", name.text)));
                    }
                    let eq = l.next("`=`")?;
                    if eq.text != "=" {
                        return Err(l.err(eq.col, format!("expected `=` after the clip name, got `{}`", eq.text)));
                    }
                    let source = l.next("an audio path")?.text.to_string();
                    let mut c = ClipSpec { source, beats: None, seconds: None, saved: None, pick: None, warp: WarpModeSpec::Complex, speed: None, root: None, beat_ratio: None };
                    // A clip saved with the sample, named right after the path: `clip brk = drums.wav loop-1`.
                    if let Some(first) = l.peek() {
                        if !CLIP_OPTIONS.contains(&first.text) {
                            l.pos += 1;
                            c.saved = Some(first.text.to_string());
                        }
                    }
                    while let Some(opt) = l.peek() {
                        l.pos += 1;
                        match opt.text {
                            "beats" => {
                                let t = l.next("a beat range")?;
                                c.beats = Some(range(&l, t, "beats")?);
                            }
                            "seconds" => {
                                let t = l.next("a seconds range")?;
                                c.seconds = Some(range(&l, t, "seconds")?);
                            }
                            "pick" => c.pick = Some(l.next("a length like 2bars")?.text.to_string()),
                            "root" => c.root = Some(l.next("a note like C or Bb")?.text.to_string()),
                            "ratio" => c.beat_ratio = Some(l.num("clip beats per score beat")?),
                            "warp" => {
                                let t = l.next("beats, complex, texture or repitch")?;
                                c.warp = match t.text {
                                    "beats" => WarpModeSpec::Beats,
                                    "complex" => WarpModeSpec::Complex,
                                    "texture" => WarpModeSpec::Texture,
                                    "repitch" => WarpModeSpec::Repitch,
                                    other => return Err(l.err(t.col, format!("warp is beats, complex, texture or repitch, not `{other}`"))),
                                };
                            }
                            "speed" => {
                                let t = l.next("a speed like 1.5 or 2x")?;
                                c.speed = Some(t.text.trim_end_matches(['x', '×']).parse().map_err(|_| l.err(t.col, format!("speed is a multiplier like 1.5 or 2x, not `{}`", t.text)))?);
                            }
                            other => return Err(l.err(opt.col, format!("unknown clip option `{other}`{}", suggest(other, CLIP_OPTIONS)))),
                        }
                    }
                    if score.clips.contains_key(name.text) {
                        return Err(l.err(name.col, format!("clip `{}` is defined twice", name.text)));
                    }
                    map.clips.insert(name.text.to_string(), l.no);
                    score.clips.insert(name.text.to_string(), c);
                }
                "kit" => {
                    let name = l.next("a kit name")?;
                    if !name.text.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                        return Err(l.err(name.col, format!("kit names are letters, digits, - and _; got `{}`", name.text)));
                    }
                    if l.peek().is_none() {
                        // `kit drums` on its own line starts a drum kit: pads follow, indented.
                        if score.kits.contains_key(name.text) {
                            return Err(l.err(name.col, format!("kit `{}` is defined twice", name.text)));
                        }
                        map.kits.insert(name.text.to_string(), l.no);
                        score.kits.insert(name.text.to_string(), KitSpec { clip: None, slice: None, pads: BTreeMap::new() });
                        pad_kit = Some((name.text.to_string(), l.no));
                        return Ok(());
                    }
                    let eq = l.next("`=`")?;
                    if eq.text != "=" {
                        return Err(l.err(eq.col, format!("expected `=` after the kit name (or nothing, for a drum kit with pads below), got `{}`", eq.text)));
                    }
                    let kw = l.next("`slice`")?;
                    if kw.text != "slice" {
                        return Err(l.err(kw.col, format!("expected `slice <clip> by beats 1` (or by bars 2, into 8, by transients), got `{}`", kw.text)));
                    }
                    let clip = l.next("the clip to slice")?.text.to_string();
                    let how = l.next("`by` or `into`")?;
                    let by = match how.text {
                        "into" => {
                            let t = l.next("a number of slices")?;
                            SliceBy::Into(t.text.parse().map_err(|_| l.err(t.col, format!("`into` takes a whole number of slices, got `{}`", t.text)))?)
                        }
                        "by" => {
                            let unit = l.next("beats, bars, transients or phrases")?;
                            match unit.text {
                                "transients" | "transient" => SliceBy::Transients,
                                "phrases" => SliceBy::Phrases,
                                "beats" | "beat" => SliceBy::Beats(l.num("a number of beats")?),
                                "bars" | "bar" => SliceBy::Bars(l.num("a number of bars")?),
                                other => return Err(l.err(unit.col, format!("slice by beats, bars, transients or phrases, not `{other}`"))),
                            }
                        }
                        other => return Err(l.err(how.col, format!("expected `by beats 1`, `by bars 2`, `by transients` or `into 8`, got `{other}`"))),
                    };
                    if score.kits.contains_key(name.text) {
                        return Err(l.err(name.col, format!("kit `{}` is defined twice", name.text)));
                    }
                    map.kits.insert(name.text.to_string(), l.no);
                    score.kits.insert(name.text.to_string(), KitSpec::sliced(clip, by));
                }
                "master" => {
                    if score.master.is_some() {
                        return Err(l.err(head.col, "`master` appears twice; keep one master block"));
                    }
                    score.master = Some(MasterSpec::default());
                    map.master = Some(l.no);
                    mix_block = Some(Block::Master);
                }
                "group" | "return" => {
                    let kind = head.text;
                    let name = l.next(if kind == "group" { "a group track's name" } else { "a return track's name" })?;
                    if !name.text.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') || name.text == "master" {
                        return Err(l.err(name.col, format!("{kind} track names are letters, digits, - and _ (and not `master`); got `{}`", name.text)));
                    }
                    if score.groups.contains_key(name.text) || score.returns.contains_key(name.text) {
                        return Err(l.err(name.col, format!("`{}` is defined twice (group and return tracks share names)", name.text)));
                    }
                    let (mut volume, mut parent) = (0.0, None);
                    while let Some(opt) = l.peek() {
                        l.pos += 1;
                        match (opt.text, kind) {
                            ("volume", _) => volume = l.num("a volume in dB")?,
                            ("group", "group") => parent = Some(l.next("a group track's name")?.text.to_string()),
                            (other, "group") => return Err(l.err(opt.col, format!("unknown group option `{other}` (volume, group); effects go on indented lines below"))),
                            (other, _) => return Err(l.err(opt.col, format!("unknown return option `{other}` (volume); effects go on indented lines below"))),
                        }
                    }
                    if kind == "group" {
                        map.groups.insert(name.text.to_string(), l.no);
                        score.groups.insert(name.text.to_string(), GroupSpec { effects: Vec::new(), volume, group: parent });
                        mix_block = Some(Block::Group(name.text.to_string()));
                    } else {
                        map.returns.insert(name.text.to_string(), l.no);
                        score.returns.insert(name.text.to_string(), ReturnSpec { effects: Vec::new(), volume });
                        mix_block = Some(Block::Return(name.text.to_string()));
                    }
                }
                "chords" => {
                    let toks: Vec<Tok> = l.toks[l.pos..].to_vec();
                    l.pos = l.toks.len();
                    if toks.is_empty() {
                        return Err(l.err(l.end_col(), "expected chords, e.g. I7 IV7 I7 ."));
                    }
                    for (chord, bars, col) in chord_line(&toks).map_err(|(col, m)| l.err(col, m))? {
                        match (score.progression.last_mut(), chord.as_str()) {
                            (Some(prev), "." | "%") => prev.bars += bars,
                            (None, "." | "%") => return Err(l.err(col, "`.` holds the previous chord, but there isn't one yet")),
                            (Some(prev), c) if prev.chord == c => prev.bars += bars,
                            _ => {
                                score.progression.push(ChordSpec { chord, bars });
                                map.chords.push((l.no, col));
                            }
                        }
                    }
                }
                "track" => {
                    let clip = l.next("a clip name")?.text.to_string();
                    let mut t = TrackSpec {
                        clip,
                        name: None,
                        role: Role::Any,
                        transpose: Transpose::Auto,
                        pattern: Pattern::Loop,
                        bars: None,
                        volume: 0.0,
                        grid: None,
                        swing: None,
                        reverse: false,
                        filter: None,
                        gate: None,
                        stutter: None,
                        speed: None,
                        effects: Vec::new(),
                        pan: None,
                        group: None,
                        sends: BTreeMap::new(),
                    };
                    while let Some(opt) = l.peek() {
                        l.pos += 1;
                        match opt.text {
                            "as" => t.name = Some(l.next("a track name")?.text.to_string()),
                            "role" => {
                                let r = l.next("a role")?;
                                t.role = serde_yaml::from_str(r.text).map_err(|_| l.err(r.col, format!("role is any, chord, root, third, fifth or seventh, not `{}`", r.text)))?;
                            }
                            "follow" => t.transpose = Transpose::Follow,
                            "transpose" => {
                                let v = l.next("auto, follow or semitones")?;
                                t.transpose = match v.text {
                                    "auto" => Transpose::Auto,
                                    "follow" => Transpose::Follow,
                                    n => Transpose::Fixed(n.trim_start_matches('+').parse().map_err(|_| l.err(v.col, format!("transpose is auto, follow or whole semitones, not `{n}`")))?),
                                };
                            }
                            "loop" => t.pattern = Pattern::Loop,
                            "every" => t.pattern = Pattern::Every(l.next("a length like 1bar")?.text.to_string()),
                            "at" => {
                                let mut at = Vec::new();
                                while let Some(p) = l.peek() {
                                    if !p.text.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                                        break;
                                    }
                                    l.pos += 1;
                                    at.push(if p.text.contains(':') || p.text.ends_with('s') { p.text.to_string() } else { format!("{}:1", p.text) });
                                }
                                if at.is_empty() {
                                    return Err(l.err(opt.col, "`at` takes bar numbers like 3 7 11, bar:beat like 3:2.5, or seconds like 12.5s"));
                                }
                                t.pattern = Pattern::At(at);
                            }
                            "bars" => t.bars = Some(l.next("bars like 5-12")?.text.to_string()),
                            "volume" => t.volume = l.num("a volume in dB")?,
                            "steps" => {
                                let p = l.next("a quoted step pattern, e.g. \"1 . 3 .\"")?;
                                t.pattern = Pattern::Steps(p.text.to_string());
                            }
                            "grid" => {
                                let g = l.next("a note value like 16 or 8")?;
                                t.grid = Some(g.text.trim_start_matches("1/").parse().map_err(|_| l.err(g.col, format!("grid is a note value like 16 (sixteenths) or 8, not `{}`", g.text)))?);
                            }
                            "swing" => {
                                let v = l.next("a swing percentage like 56")?;
                                t.swing = Some(v.text.trim_end_matches('%').parse().map_err(|_| l.err(v.col, format!("swing is a percentage like 56, not `{}`", v.text)))?);
                            }
                            "gate" => {
                                let v = l.next("a gate like 50%")?;
                                let x: f64 = v.text.trim_end_matches('%').parse().map_err(|_| l.err(v.col, format!("gate is a percentage like 50%, not `{}`", v.text)))?;
                                t.gate = Some(if v.text.ends_with('%') || x > 1.0 { x / 100.0 } else { x });
                            }
                            "stutter" => {
                                let v = l.next("a number of repeats")?;
                                t.stutter = Some(v.text.parse().map_err(|_| l.err(v.col, format!("stutter takes a whole number of repeats, not `{}`", v.text)))?);
                            }
                            "reverse" => t.reverse = true,
                            "half" => t.speed = Some(0.5),
                            "double" => t.speed = Some(2.0),
                            "speed" => t.speed = Some(l.num("a speed like 0.5 or 2")?),
                            "group" => t.group = Some(l.next("a group track's name")?.text.to_string()),
                            "filter" => {
                                let kind = l.next("lp or hp")?;
                                let hz = l.num("a frequency in Hz")?;
                                t.filter = Some(match kind.text {
                                    "lp" | "lowpass" => FilterSpec::Lowpass(hz),
                                    "hp" | "highpass" => FilterSpec::Highpass(hz),
                                    other => return Err(l.err(kind.col, format!("filter is lp or hp, not `{other}`"))),
                                });
                            }
                            other => return Err(l.err(opt.col, format!("unknown track option `{other}`{}", suggest(other, TRACK_OPTIONS)))),
                        }
                    }
                    map.tracks.push(l.no);
                    score.tracks.push(t);
                    mix_block = Some(Block::Track(score.tracks.len() - 1));
                }
                other => return Err(l.err(head.col, format!("unknown statement `{other}`{}", suggest(other, STATEMENTS)))),
            }
            l.done()
        })();
        if let Err(e) = r {
            errors.push(e);
        }
    }
    if let Some((k, line)) = pad_kit {
        if score.kits.get(&k).is_some_and(|kit| kit.pads.is_empty()) {
            errors.push(ParseError { line, column: 1, message: format!("kit `{k}` has no pads; list them on indented lines below it, e.g.  kick = drums shot-1") });
        }
    }
    errors.sort_by_key(|e| (e.line, e.column));
    if !have_tempo {
        errors.push(ParseError { line: 1, column: 1, message: "missing `tempo`, e.g. tempo 110".into() });
    }
    if !have_key {
        errors.push(ParseError { line: 1, column: 1, message: "missing `key`, e.g. key Abm".into() });
    }
    if errors.is_empty() { Ok((score, map)) } else { Err(errors) }
}

/// Parse one `chords` line into (chord, bars, column) in order.
fn chord_line(toks: &[Tok]) -> Result<Vec<(String, f64, usize)>, (usize, String)> {
    // Split words further at brackets so "[I7" and "IV7]*2" work.
    let mut parts: Vec<(String, usize)> = Vec::new();
    for t in toks {
        let mut cur = String::new();
        let mut cur_col = t.col;
        for (i, c) in t.text.chars().enumerate() {
            if matches!(c, '[' | ']' | '(' | ')' | '|') {
                if !cur.is_empty() {
                    parts.push((std::mem::take(&mut cur), cur_col));
                }
                parts.push((c.to_string(), t.col + i));
                cur_col = t.col + i + 1;
            } else {
                if cur.is_empty() {
                    cur_col = t.col + i;
                }
                cur.push(c);
            }
        }
        if !cur.is_empty() {
            parts.push((cur, cur_col));
        }
    }
    // A trailing "*n" on a closing bracket arrives as its own part ("*2"): attach it.
    let mut pos = 0;
    let items = seq(&parts, &mut pos, None)?;
    if pos < parts.len() {
        return Err((parts[pos].1, format!("unexpected `{}`", parts[pos].0)));
    }
    let mut out = Vec::new();
    for item in &items {
        emit(item, 1.0, &mut out);
    }
    Ok(out)
}

#[derive(Debug)]
enum Item {
    Chord(String, usize, f64),
    /// One bar split evenly among the children (weights by their `*n`).
    Split(Vec<Item>, f64),
    /// A run of bars, repeated.
    Group(Vec<Item>, f64),
}

fn mult(parts: &[(String, usize)], pos: &mut usize) -> Result<f64, (usize, String)> {
    if let Some((p, col)) = parts.get(*pos) {
        if let Some(n) = p.strip_prefix('*') {
            *pos += 1;
            return match n.parse::<f64>() {
                Ok(v) if v > 0.0 => Ok(v),
                _ => Err((*col, format!("`*` takes a positive number, got `{p}`"))),
            };
        }
    }
    Ok(1.0)
}

fn seq(parts: &[(String, usize)], pos: &mut usize, close: Option<&str>) -> Result<Vec<Item>, (usize, String)> {
    let mut items = Vec::new();
    while let Some((p, col)) = parts.get(*pos) {
        let (p, col) = (p.as_str(), *col);
        match p {
            "|" => {
                *pos += 1;
            }
            "]" | ")" => {
                return if close == Some(p) { Ok(items) } else { Err((col, format!("unmatched `{p}`"))) };
            }
            "[" | "(" => {
                *pos += 1;
                let want = if p == "[" { "]" } else { ")" };
                // An unclosed bracket is reported where it opens.
                let inner = seq(parts, pos, Some(want)).map_err(|(c, m)| if m.starts_with("missing") { (col, format!("`{p}` is never closed")) } else { (c, m) })?;
                if parts.get(*pos).map(|x| x.0.as_str()) != Some(want) {
                    return Err((col, format!("`{p}` is never closed")));
                }
                *pos += 1;
                if inner.is_empty() {
                    return Err((col, format!("empty `{p}{want}`")));
                }
                let m = mult(parts, pos)?;
                if p == "(" && m.fract() != 0.0 {
                    return Err((col, format!("a repeated group `(…)*{m}` repeats a whole number of times")));
                }
                items.push(if p == "[" { Item::Split(inner, m) } else { Item::Group(inner, m) });
            }
            _ => {
                *pos += 1;
                // "I7*2" arrives as one part; split off the multiplier.
                let (name, m) = match p.split_once('*') {
                    Some((n, m)) => match m.parse::<f64>() {
                        Ok(v) if v > 0.0 && !n.is_empty() => (n, v),
                        _ => return Err((col, format!("`{p}`: write a chord then *number, like I7*2"))),
                    },
                    None => (p, mult(parts, pos)?),
                };
                items.push(Item::Chord(name.to_string(), col, m));
            }
        }
    }
    match close {
        Some(c) => Err((parts.last().map_or(1, |x| x.1), format!("missing `{c}`"))),
        None => Ok(items),
    }
}

fn weight(i: &Item) -> f64 {
    match i {
        Item::Chord(_, _, m) | Item::Split(_, m) => *m,
        Item::Group(inner, m) => inner.iter().map(weight).sum::<f64>() * m,
    }
}

/// Flatten into (chord, bars, column); `scale` is the length in bars of one unit of weight.
fn emit(item: &Item, scale: f64, out: &mut Vec<(String, f64, usize)>) {
    match item {
        Item::Chord(name, col, m) => out.push((name.clone(), scale * m, *col)),
        Item::Split(inner, m) => {
            let total: f64 = inner.iter().map(weight).sum();
            for i in inner {
                emit(i, scale * m / total, out);
            }
        }
        Item::Group(inner, m) => {
            for _ in 0..(*m as usize).max(1) {
                for i in inner {
                    emit(i, scale, out);
                }
            }
        }
    }
}

// ------------------------------------------------------------------ formatting

fn num(x: f64) -> String {
    if x.fract() == 0.0 { format!("{}", x as i64) } else { format!("{x}") }
}

/// One effect as `.apr` text (also used by `explain`).
pub fn effect_text(fx: &Effect) -> String {
    let hzs = |f: f64| if f >= 1000.0 && (f / 1000.0 * 100.0).fract() == 0.0 { format!("{}k", num(f / 1000.0)) } else { num(f) };
    let sign = |g: f64| if g > 0.0 { format!("+{}", num(g)) } else { num(g) };
    match fx {
        Effect::Eq(e) => {
            let mut s = String::from("eq");
            if let Some(f) = e.lowcut {
                s += &format!("  lowcut {}", hzs(f));
            }
            if let Some(f) = e.highcut {
                s += &format!("  highcut {}", hzs(f));
            }
            if let Some([g, f]) = e.low {
                s += &format!("  low {}@{}", sign(g), hzs(f));
            }
            if let Some([g, f]) = e.high {
                s += &format!("  high {}@{}", sign(g), hzs(f));
            }
            for [g, f, q] in &e.peaks {
                s += &format!("  peak {}@{} q{}", sign(*g), hzs(*f), num(*q));
            }
            s
        }
        Effect::Comp(c) => {
            let mut s = format!("comp  {}:1  {}dB", num(c.ratio), num(c.threshold));
            if let Some(v) = c.attack_ms {
                s += &format!("  attack {}ms", num(v));
            }
            if let Some(v) = c.release_ms {
                s += &format!("  release {}ms", num(v));
            }
            if let Some(v) = c.knee {
                s += &format!("  knee {}dB", num(v));
            }
            if let Some(v) = c.makeup {
                s += &format!("  makeup {}dB", sign(v));
            }
            if let Some(k) = &c.sidechain {
                s += &format!("  sidechain {k}");
            }
            s
        }
        Effect::Drive(d) => match d.tone {
            Some(t) => format!("drive  {}dB  tone {}", num(d.db), hzs(t)),
            None => format!("drive  {}dB", num(d.db)),
        },
        Effect::Lofi(f) => {
            let mut s = String::from("lofi");
            if let Some(b) = f.bits {
                s += &format!("  {}bit", num(b));
            }
            if let Some(r) = f.rate {
                s += &format!("  {}", hzs(r));
            }
            if let Some(w) = f.wow {
                s += &format!("  wow {}", pct(w));
            }
            s
        }
        Effect::NoiseGate(g) => {
            let mut s = format!("noisegate  {}dB", num(g.threshold));
            for (name, v) in [("attack", g.attack_ms), ("hold", g.hold_ms), ("release", g.release_ms)] {
                if let Some(v) = v {
                    s += &format!("  {name} {}ms", num(v));
                }
            }
            if let Some(r) = g.range {
                s += &format!("  range {}dB", num(r));
            }
            s
        }
        Effect::Width(w) => format!("width  {}", pct(*w)),
        Effect::Limit(l) => match l.release_ms {
            Some(r) => format!("limit {}dB  release {}ms", num(l.ceiling), num(r)),
            None => format!("limit {}dB", num(l.ceiling)),
        },
        Effect::Reverb(r) => {
            let mut s = format!("reverb  {}", match r.kind { ReverbType::Room => "room", ReverbType::Hall => "hall", ReverbType::Plate => "plate" });
            if let Some(d) = r.decay_s {
                s += &format!("  {}s", num(d));
            }
            if let Some(p) = r.predelay_ms {
                s += &format!("  predelay {}ms", num(p));
            }
            if let Some(d) = r.damp {
                s += &format!("  damp {}", pct(d));
            }
            if let Some(m) = r.mix {
                s += &format!("  mix {}", pct(m));
            }
            s
        }
        Effect::Delay(d) => {
            let mut s = match (d.beats, d.ms) {
                (Some(b), _) => format!("delay  {}", note_text(b)),
                (None, Some(m)) => format!("delay  {}ms", num(m)),
                (None, None) => "delay  1/8".into(),
            };
            if let Some(f) = d.feedback {
                s += &format!("  feedback {}", pct(f));
            }
            if let Some(f) = d.highpass {
                s += &format!("  hp {}", hzs(f));
            }
            if let Some(f) = d.lowpass {
                s += &format!("  lp {}", hzs(f));
            }
            if d.pingpong {
                s += "  pingpong";
            }
            if let Some(m) = d.mix {
                s += &format!("  mix {}", pct(m));
            }
            s
        }
    }
}

/// Write a score as `.apr` text. `parse(&format(s))` gives back `s`.
pub fn format(s: &Score) -> String {
    let mut out = String::new();
    if (s.apricity - 0.1).abs() > 1e-9 {
        out += &format!("apricity {}\n", num(s.apricity));
    }
    out += &format!("tempo {}\n", num(s.tempo));
    if s.meter != 4 {
        out += &format!("time {}/4\n", s.meter);
    }
    out += &format!("key {}\n", s.key);
    if let Some(sm) = &s.samples {
        out += &format!("samples {sm}\n");
    }
    if let Some(b) = s.bars {
        out += &format!("bars {b}\n");
    }
    out += "\n";
    let w = s.clips.keys().map(|k| k.len()).max().unwrap_or(0);
    for (name, c) in &s.clips {
        out += &format!("clip {name:<w$} = {}", c.source);
        if let Some(sv) = &c.saved {
            out += &format!("  {sv}");
        }
        if let Some([a, b]) = c.beats {
            out += &format!("  beats {}..{}", num(a), num(b));
        }
        if let Some([a, b]) = c.seconds {
            out += &format!("  seconds {}..{}", num(a), num(b));
        }
        if let Some(p) = &c.pick {
            out += &format!("  pick {p}");
        }
        if let Some(r) = &c.root {
            out += &format!("  root {r}");
        }
        if let Some(r) = c.beat_ratio {
            out += &format!("  ratio {}", num(r));
        }
        match c.warp {
            WarpModeSpec::Complex => {}
            WarpModeSpec::Beats => out += "  warp beats",
            WarpModeSpec::Texture => out += "  warp texture",
            WarpModeSpec::Repitch => out += "  warp repitch",
        }
        if let Some(x) = c.speed {
            out += &format!("  speed {}x", num(x));
        }
        out += "\n";
    }
    if !s.kits.is_empty() {
        out += "\n";
        let w = s.kits.keys().map(|k| k.len()).max().unwrap_or(0);
        for (name, k) in &s.kits {
            let (Some(clip), Some(by)) = (&k.clip, &k.slice) else {
                out += &format!("kit {name}\n");
                let pw = k.pads.keys().map(|p| p.len()).max().unwrap_or(0);
                for (pad, ps) in &k.pads {
                    out += &format!("  {pad:<pw$} = {}", ps.clip);
                    if let Some(sv) = &ps.saved {
                        out += &format!("  {sv}");
                    }
                    if let Some([a, b]) = ps.beats {
                        out += &format!("  beats {}..{}", num(a), num(b));
                    }
                    if let Some([a, b]) = ps.seconds {
                        out += &format!("  seconds {}..{}", num(a), num(b));
                    }
                    out += "\n";
                }
                continue;
            };
            let how = match by {
                SliceBy::Beats(n) => format!("by beats {}", num(*n)),
                SliceBy::Bars(n) => format!("by bars {}", num(*n)),
                SliceBy::Into(n) => format!("into {n}"),
                SliceBy::Transients => "by transients".into(),
                SliceBy::Phrases => "by phrases".into(),
            };
            out += &format!("kit {name:<w$} = slice {clip} {how}\n");
        }
    }
    if !s.progression.is_empty() {
        out += "\n";
        // Up to 4 bars' worth of chords per line, with "|" every 4 bars.
        let mut line = String::from("chords");
        let mut bars_on_line = 0.0;
        for c in &s.progression {
            let tok = if (c.bars - 1.0).abs() < 1e-9 { c.chord.clone() } else { format!("{}*{}", c.chord, num(c.bars)) };
            line += " ";
            line += &tok;
            bars_on_line += c.bars;
            if bars_on_line >= 4.0 - 1e-9 {
                out += &line;
                out += "\n";
                line = String::from("chords");
                bars_on_line = 0.0;
            }
        }
        if line != "chords" {
            out += &line;
            out += "\n";
        }
    }
    out += "\n";
    let w = s.tracks.iter().map(|t| t.clip.len()).max().unwrap_or(0);
    for t in &s.tracks {
        out += &format!("track {:<w$}", t.clip);
        if let Some(n) = &t.name {
            out += &format!("  as {n}");
        }
        match &t.transpose {
            Transpose::Auto => {}
            Transpose::Follow => out += "  follow",
            Transpose::Fixed(n) => out += &format!("  transpose {n}"),
        }
        if t.role != Role::Any {
            out += &format!("  role {}", serde_yaml::to_string(&t.role).unwrap().trim());
        }
        match &t.pattern {
            Pattern::Loop => {}
            Pattern::Every(d) => out += &format!("  every {d}"),
            Pattern::At(v) => out += &format!("  at {}", v.iter().map(|p| p.strip_suffix(":1").unwrap_or(p)).collect::<Vec<_>>().join(" ")),
            Pattern::Steps(p) => out += &format!("  steps \"{p}\""),
        }
        if let Some(g) = t.grid {
            out += &format!("  grid {g}");
        }
        if let Some(sw) = t.swing {
            out += &format!("  swing {}", num(sw));
        }
        match t.speed {
            None => {}
            Some(x) if x == 0.5 => out += "  half",
            Some(x) if x == 2.0 => out += "  double",
            Some(x) => out += &format!("  speed {}", num(x)),
        }
        if t.reverse {
            out += "  reverse";
        }
        match t.filter {
            None => {}
            Some(FilterSpec::Lowpass(h)) => out += &format!("  filter lp {}", num(h)),
            Some(FilterSpec::Highpass(h)) => out += &format!("  filter hp {}", num(h)),
        }
        if let Some(g) = t.gate {
            out += &format!("  gate {}%", num((g * 100.0 * 1000.0).round() / 1000.0));
        }
        if let Some(n) = t.stutter {
            out += &format!("  stutter {n}");
        }

        if let Some(b) = &t.bars {
            out += &format!("  bars {b}");
        }
        if t.volume != 0.0 {
            out += &format!("  volume {}", num(t.volume));
        }
        if let Some(g) = &t.group {
            out += &format!("  group {g}");
        }
        out = out.trim_end().to_string() + "\n";
        if let Some(p) = t.pan {
            out += &format!("  pan {}\n", num(p));
        }
        for fx in &t.effects {
            out += &format!("  {}\n", effect_text(fx));
        }
        if !t.sends.is_empty() {
            out += &format!("  send  {}\n", t.sends.iter().map(|(b, x)| format!("{b} {}", send_text(*x))).collect::<Vec<_>>().join("  "));
        }
    }
    for (name, g) in &s.groups {
        out += &format!("\ngroup {name}");
        if g.volume != 0.0 {
            out += &format!("  volume {}", num(g.volume));
        }
        if let Some(p) = &g.group {
            out += &format!("  group {p}");
        }
        out += "\n";
        for fx in &g.effects {
            out += &format!("  {}\n", effect_text(fx));
        }
    }
    for (name, r) in &s.returns {
        out += &format!("\nreturn {name}");
        if r.volume != 0.0 {
            out += &format!("  volume {}", num(r.volume));
        }
        out += "\n";
        for fx in &r.effects {
            out += &format!("  {}\n", effect_text(fx));
        }
    }
    if let Some(m) = &s.master {
        out += "\nmaster\n";
        for fx in &m.effects {
            out += &format!("  {}\n", effect_text(fx));
        }
        if let Some(l) = m.loudness {
            out += &format!("  loudness {}LUFS\n", num(l));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chords(s: &str) -> Vec<(String, f64)> {
        let (score, _) = parse(&format!("tempo 100\nkey C\nchords {s}\n")).unwrap();
        score.progression.into_iter().map(|c| (c.chord, c.bars)).collect()
    }

    fn c(v: &[(&str, f64)]) -> Vec<(String, f64)> {
        v.iter().map(|(a, b)| (a.to_string(), *b)).collect()
    }

    #[test]
    fn chord_notation() {
        assert_eq!(chords("I7 IV7 I7 . | IV7 . I7 ."), c(&[("I7", 1.0), ("IV7", 1.0), ("I7", 2.0), ("IV7", 2.0), ("I7", 2.0)]));
        assert_eq!(chords("I7*2 V7*0.5 IV7*0.5"), c(&[("I7", 2.0), ("V7", 0.5), ("IV7", 0.5)]));
        assert_eq!(chords("[ii V] I"), c(&[("ii", 0.5), ("V", 0.5), ("I", 1.0)]));
        assert_eq!(chords("[I IV V*2]"), c(&[("I", 0.25), ("IV", 0.25), ("V", 0.5)]));
        assert_eq!(chords("(I IV)*2 V"), c(&[("I", 1.0), ("IV", 1.0), ("I", 1.0), ("IV", 1.0), ("V", 1.0)]));
        assert_eq!(chords("[I IV]*2"), c(&[("I", 1.0), ("IV", 1.0)]));
        assert_eq!(chords("I % %"), c(&[("I", 3.0)]));
        assert_eq!(chords("[I7 .] IV7"), c(&[("I7", 1.0), ("IV7", 1.0)]));
        assert!(parse("tempo 1\nkey C\nchords (I IV)*1.5\n").unwrap_err()[0].message.contains("whole number"));
        assert_eq!(chords("Dbm7 V/V bVII"), c(&[("Dbm7", 1.0), ("V/V", 1.0), ("bVII", 1.0)]));
    }

    #[test]
    fn full_score_and_errors_with_positions() {
        let src = "tempo 100\nkey F mixolydian   # comment\nsamples ../samples\n\nclip tuba = a/bass.wav pick 1bar\nclip riff = a/other.wav beats 32..36 root C warp beats\n\nchords I7 IV7 I7 .\n\ntrack tuba follow\ntrack riff as horns follow bars 5-12 volume -2\ntrack riff as stabs at 3 7:3 volume -5\n";
        let (s, map) = parse(src).unwrap();
        assert_eq!(s.key, "F mixolydian");
        assert_eq!(s.clips["riff"].beats, Some([32.0, 36.0]));
        assert_eq!(s.clips["riff"].root.as_deref(), Some("C"));
        assert_eq!(s.tracks[1].name.as_deref(), Some("horns"));
        assert_eq!(s.tracks[1].volume, -2.0);
        assert_eq!(s.tracks[2].pattern, Pattern::At(vec!["3:1".into(), "7:3".into()]));
        assert_eq!(map.tracks, vec![10, 11, 12]);
        assert_eq!(map.locate("tracks[1].bars: runs past the end"), "line 11 column 1: track.bars: runs past the end");

        let errs = parse("tempo 100\nkey C\ntrakc x\nclip a = x.wav loop-1 pik 1bar\ntrack a volme 3\nchords [I IV\nchords . I\n").unwrap_err();
        let text: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
        assert!(text[0].starts_with("line 3 column 1: unknown statement `trakc` (did you mean `track`?)"), "{text:?}");
        assert!(text[1].contains("line 4 column 23: unknown clip option `pik` (did you mean `pick`?)"), "{text:?}");
        assert!(text[2].contains("line 5 column 9: unknown track option `volme` (did you mean `volume`?)"), "{text:?}");
        assert!(text[3].contains("line 6") && text[3].contains("never closed"), "{text:?}");
        assert!(text[4].contains("line 7 column 8") && text[4].contains("previous chord"), "{text:?}");
        let missing = parse("clip a = x.wav\n").unwrap_err();
        assert!(missing.iter().any(|e| e.message.contains("tempo")) && missing.iter().any(|e| e.message.contains("key")));
    }

    #[test]
    fn time_signatures_and_saved_clips() {
        let (s, _) = parse("tempo 90\ntime 3/4\nkey C\nclip br = d.wav loop-1 warp beats\nclip w = d.wav\nbars 2\ntrack br\n").unwrap();
        assert_eq!(s.meter, 3);
        assert_eq!((s.clips["br"].saved.as_deref(), s.clips["br"].warp), (Some("loop-1"), WarpModeSpec::Beats));
        assert_eq!(s.clips["w"].saved, None);
        let text = format(&s);
        assert!(text.contains("time 3/4") && text.contains("clip br = d.wav  loop-1  warp beats"), "{text}");
        assert_eq!(parse(&text).unwrap().0, s);
        let e = parse("tempo 90\ntime 6/8\nkey C\n").unwrap_err();
        assert!(e[0].message.contains("only x/4"), "{e:?}");
    }

    #[test]
    fn kits_steps_and_transforms() {
        let src = "tempo 90\nkey C\nclip br = d.wav break-1  # a break\nkit k = slice br by beats 1\nkit h = slice br by transients\nkit e = slice br into 8\nchords I\ntrack k steps \"1 . 3 . [5 5] . 7 _\" swing 56% grid 16   # comment with \"quotes\"\ntrack k.3 as rev every 1bar reverse filter lp 800 gate 50% stutter 2 half\n";
        let (s, map) = parse(src).unwrap();
        assert_eq!(s.clips["br"].saved.as_deref(), Some("break-1"));
        assert_eq!(s.kits["k"].slice, Some(SliceBy::Beats(1.0)));
        assert_eq!(s.kits["h"].slice, Some(SliceBy::Transients));
        assert_eq!(s.kits["e"].slice, Some(SliceBy::Into(8)));
        assert_eq!(map.kits["k"], 4);
        assert_eq!(s.tracks[0].pattern, Pattern::Steps("1 . 3 . [5 5] . 7 _".into()));
        assert_eq!((s.tracks[0].swing, s.tracks[0].grid), (Some(56.0), Some(16)));
        let t = &s.tracks[1];
        assert_eq!((t.reverse, t.filter, t.gate, t.stutter, t.speed), (true, Some(FilterSpec::Lowpass(800.0)), Some(0.5), Some(2), Some(0.5)));
        let (again, _) = parse(&format(&s)).unwrap();
        assert_eq!(again, s, "\n{}", format(&s));
        let e = parse("tempo 90\nkey C\nkit k = slice br by laps 2\ntrack k stepz \"1\"\n").unwrap_err();
        assert!(e[0].to_string().contains("line 3") && e[0].message.contains("beats, bars, transients or phrases"), "{e:?}");
        assert!(e[1].message.contains("did you mean `steps`"), "{e:?}");
    }

    #[test]
    fn drum_kits_are_blocks_of_pads() {
        let src = "tempo 90\nkey C\nclip a = x.wav\nclip b = y.wav\nkit k = slice a by beats 1\nkit drums\n  kick  = a shot-2\n  snare = b beats 4..5\n  rim   = k.3\nchords I\ntrack drums.kick steps \"x . . . x . . .\"\ntrack drums steps \"kick . snare .\"\n";
        let (s, map) = parse(src).unwrap();
        let d = &s.kits["drums"];
        assert!(d.clip.is_none() && d.slice.is_none());
        assert_eq!(d.pads["kick"], PadSpec { clip: "a".into(), saved: Some("shot-2".into()), beats: None, seconds: None });
        assert_eq!(d.pads["snare"].beats, Some([4.0, 5.0]));
        assert_eq!(d.pads["rim"].clip, "k.3");
        assert_eq!(map.kits["drums"], 6);
        let (again, _) = parse(&format(&s)).unwrap();
        assert_eq!(again, s, "\n{}", format(&s));

        let errs = parse("tempo 90\nkey C\nkit empty\nkit drums\n  kick = a shot-2 beets 1..2\n  snare = b\n  snare = a\nchords I\n").unwrap_err();
        let text: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
        assert!(text.iter().any(|t| t.starts_with("line 3") && t.contains("kit `empty` has no pads")), "{text:?}");
        assert!(text.iter().any(|t| t.starts_with("line 5") && t.contains("did you mean `beats`")), "{text:?}");
        assert!(text.iter().any(|t| t.starts_with("line 7") && t.contains("pad `snare` is defined twice")), "{text:?}");
    }

    #[test]
    fn mix_blocks() {
        let src = "tempo 90\nkey C\nclip a = x.wav\nchords I\ntrack a  follow\n  eq    lowcut 120  low -3@250  high +2dB@6k  peak -4@800 q1.4\n  comp  4:1  -18dB  attack 10ms  release 0.12s\n  pan   -20\n\nmaster\n  comp  2:1 -8dB\n  limit -1dB\n  loudness -14LUFS\n";
        let (s, _) = parse(src).unwrap();
        let t = &s.tracks[0];
        assert_eq!(t.pan, Some(-20.0));
        assert_eq!(t.effects[0], Effect::Eq(EqSpec { lowcut: Some(120.0), highcut: None, low: Some([-3.0, 250.0]), high: Some([2.0, 6000.0]), peaks: vec![[-4.0, 800.0, 1.4]] }));
        assert_eq!(t.effects[1], Effect::Comp(CompSpec { ratio: 4.0, threshold: -18.0, attack_ms: Some(10.0), release_ms: Some(120.0), knee: None, makeup: None, sidechain: None }));
        let m = s.master.as_ref().unwrap();
        assert_eq!((m.effects.len(), m.loudness), (2, Some(-14.0)));
        let (again, _) = parse(&format(&s)).unwrap();
        assert_eq!(again, s, "\n{}", format(&s));

        let errs = parse("tempo 90\nkey C\nchords I\ntrack a\n  comp 4:1 -18\n  eq lowcut 12x\n  loudness -14LUFS\n  reverbb hall\nmaster\n  pan 10\n  loudness -14\n").unwrap_err();
        let t: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
        assert!(t.iter().any(|e| e.starts_with("line 5") && e.contains("threshold in dB")), "{t:?}");
        assert!(t.iter().any(|e| e.starts_with("line 6") && e.contains("isn't a frequency")), "{t:?}");
        assert!(t.iter().any(|e| e.starts_with("line 7") && e.contains("doesn't belong here")), "{t:?}");
        assert!(t.iter().any(|e| e.starts_with("line 8") && e.contains("doesn't belong here")), "{t:?}");
        assert!(t.iter().any(|e| e.starts_with("line 10") && e.contains("`pan` doesn't belong here")), "{t:?}");
        assert!(t.iter().any(|e| e.starts_with("line 11") && e.contains("LUFS")), "{t:?}");
    }

    #[test]
    fn group_and_return_tracks_sends_and_space_effects() {
        let src = "tempo 90\nkey C\nclip a = x.wav\nclip d = y.wav\nchords I\n\
track a  follow\n  pan 20\n  send room 25%  echo -12dB\n\
track d  group beat\n  reverb room 0.6s mix 15%\n\n\
group beat  volume -2\n  comp 3:1 -12dB\n\n\
return room  volume -3\n  reverb plate 1.8s predelay 25ms damp 30%\n\n\
return echo\n  delay 1/8. feedback 40% hp 300 lp 5k pingpong\n  delay 1/4t\n  delay 350ms mix 50%\n\n\
group all\n\
master\n  limit -1dB\n";
        let (s, map) = parse(src).unwrap();
        let a = &s.tracks[0];
        assert_eq!(a.sends["room"], 0.25);
        assert!((a.sends["echo"] - 0.2512).abs() < 1e-4, "−12 dB ≈ 25%");
        assert_eq!(s.tracks[1].group.as_deref(), Some("beat"));
        assert_eq!(s.tracks[1].effects[0], Effect::Reverb(ReverbSpec { kind: ReverbType::Room, decay_s: Some(0.6), predelay_ms: None, damp: None, mix: Some(0.15) }));
        assert_eq!((s.groups["beat"].volume, s.returns["room"].volume), (-2.0, -3.0));
        assert_eq!(s.returns["room"].effects[0], Effect::Reverb(ReverbSpec { kind: ReverbType::Plate, decay_s: Some(1.8), predelay_ms: Some(25.0), damp: Some(0.3), mix: None }));
        let echo = &s.returns["echo"].effects;
        assert_eq!(echo[0], Effect::Delay(DelaySpec { beats: Some(0.75), ms: None, feedback: Some(0.4), highpass: Some(300.0), lowpass: Some(5000.0), pingpong: true, mix: None }));
        assert!(matches!(&echo[1], Effect::Delay(d) if (d.beats.unwrap() - 2.0 / 3.0).abs() < 1e-12));
        assert!(matches!(&echo[2], Effect::Delay(d) if d.ms == Some(350.0) && d.mix == Some(0.5)));
        assert_eq!((map.returns["room"], map.groups["beat"]), (15, 12));
        let text = format(&s);
        let (again, _) = parse(&text).unwrap();
        assert_eq!(again, s, "\n{text}");
        assert!(text.contains("delay  1/8.  feedback 40%  hp 300  lp 5k  pingpong") && text.contains("delay  1/4t"), "{text}");
        assert!(text.contains("group beat  volume -2") && text.contains("return room  volume -3"), "{text}");

        let errs = parse("tempo 90\nkey C\nchords I\ntrack a  group\ntrack b\n  send room\n  send room 20% room 10%\n  reverb cathedral\n  delay soon\nreturn master\nreturn fx  wet 50%\nmaster\n  reverb hall\ngroup g\nreturn g\nreturn r  group g\n").unwrap_err();
        let t: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
        for (line, want) in [
            (4, "expected a group track's name"),
            (6, "send level"),
            (7, "already sends to `room`"),
            (8, "unknown reverb part `cathedral`"),
            (9, "note value"),
            (10, "not `master`"),
            (11, "unknown return option `wet`"),
            (13, "doesn't go on the master"),
            (15, "defined twice"),
            (16, "unknown return option `group`"),
        ] {
            assert!(t.iter().any(|e| e.starts_with(&format!("line {line} ")) && e.contains(want)), "line {line}: {want}\n{t:#?}");
        }
    }

    #[test]
    fn voice_layer_syntax() {
        let src = "tempo 90\nkey C\nclip talk = v.wav  warp repitch\nclip fast = v.wav  warp repitch  speed 1.5x\nkit words = slice talk by phrases\nchords I\ntrack talk  at 1 12.5s 3:2.5\ntrack words.2  at 2\n";
        let (s, _) = parse(src).unwrap();
        assert_eq!((s.clips["talk"].warp, s.clips["fast"].speed), (WarpModeSpec::Repitch, Some(1.5)));
        assert_eq!(s.kits["words"].slice, Some(SliceBy::Phrases));
        assert_eq!(s.tracks[0].pattern, Pattern::At(vec!["1:1".into(), "12.5s".into(), "3:2.5".into()]));
        let text = format(&s);
        assert!(text.contains("warp repitch  speed 1.5x") && text.contains("slice talk by phrases") && text.contains("at 1 12.5s 3:2.5"), "{text}");
        assert_eq!(parse(&text).unwrap().0, s);
        let e = parse("tempo 90\nkey C\nclip a = v.wav  warp maybe\nclip b = v.wav  speed fast\n").unwrap_err();
        assert!(e[0].message.contains("beats, complex, texture or repitch") && e[1].message.contains("speed is a multiplier"), "{e:?}");
    }

    #[test]
    fn character_effects_and_sidechain() {
        let src = "tempo 90\nkey C\nclip a = x.wav\nclip v = v.wav  warp repitch\nchords I\n\
track a  group music\n  drive 9dB tone 6k\n  lofi 12bit 26k wow 15%\n  noisegate -45dB hold 20ms release 80ms range -60dB\n  width 60%\n\
track v  at 1\n\ngroup music\n  comp 4:1 -30dB attack 5ms release 250ms sidechain v\n\nmaster\n  width 110%\n";
        let (s, _) = parse(src).unwrap();
        let fx = &s.tracks[0].effects;
        assert_eq!(fx[0], Effect::Drive(DriveSpec { db: 9.0, tone: Some(6000.0) }));
        assert_eq!(fx[1], Effect::Lofi(LofiSpec { bits: Some(12.0), rate: Some(26000.0), wow: Some(0.15) }));
        assert_eq!(fx[2], Effect::NoiseGate(GateSpec { threshold: -45.0, attack_ms: None, hold_ms: Some(20.0), release_ms: Some(80.0), range: Some(-60.0) }));
        assert_eq!(fx[3], Effect::Width(0.6));
        assert!(matches!(&s.groups["music"].effects[0], Effect::Comp(c) if c.sidechain.as_deref() == Some("v")));
        assert_eq!(s.master.as_ref().unwrap().effects[0], Effect::Width(1.1));
        let text = format(&s);
        assert_eq!(parse(&text).unwrap().0, s, "\n{text}");
        assert!(text.contains("lofi  12bit  26k  wow 15%") && text.contains("sidechain v"), "{text}");

        let e = parse("tempo 90\nkey C\nchords I\ntrack a\n  drive hot\n  lofi\n  lofi 12bits crunchy\n  width wide\nmaster\n  drive 3dB\n  lofi 8bit\n").unwrap_err();
        let t: Vec<String> = e.iter().map(|e| e.to_string()).collect();
        for (line, want) in [(5, "write drive in dB"), (6, "lofi needs something to do"), (7, "unknown lofi part `crunchy`"), (8, "write width as a percentage"), (10, "doesn't go on the master"), (11, "doesn't go on the master")] {
            assert!(t.iter().any(|x| x.starts_with(&format!("line {line} ")) && x.contains(want)), "line {line}: {want}\n{t:#?}");
        }
    }

    #[test]
    fn format_round_trips() {
        let src = "tempo 100\nkey F mixolydian\nsamples ../samples\n\nclip a = x/a.wav  beats 32..36  root C  warp beats\nclip b = x/b.wav  pick 1bar\n\nchords I7 IV7 I7*2 IV7*2 I7*2\nchords V7 IV7 I7 V7*0.5 IV7*0.5\n\ntrack a  follow  bars 5-12  volume -2\ntrack b  as stabs  transpose 3  at 3 7:3\n";
        let (s, _) = parse(src).unwrap();
        let again = format(&s);
        let (s2, _) = parse(&again).unwrap();
        assert_eq!(s, s2, "\n{again}");
    }
}
