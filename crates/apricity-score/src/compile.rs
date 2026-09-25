//! Score → Timeline: validate everything, lay out pattern notes, solve harmony per chord,
//! split notes at chord changes, and attach warp maps.

use crate::manifest::Clip;
use crate::score::{parse_bars, parse_duration, parse_position, parse_steps, Effect, FilterSpec, MasterSpec, Pattern, Score, SliceBy, Sound, Transpose, WarpModeSpec};
use apricity_theory::{rank_keys, solve, Chord, Fit, Key, PitchClass, Voice, Weights};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The compiled piece: everything a renderer needs, in beats and source seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timeline {
    pub tempo: f64,
    pub meter: u32,
    pub key: String,
    pub length_beats: f64,
    pub sources: Vec<SourceRef>,
    pub events: Vec<Event>,
    pub harmony: Vec<ChordSpan>,
    pub tracks: Vec<TrackInfo>,
    pub warnings: Vec<String>,
    /// Buses, feeders first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buses: Vec<BusInfo>,
    /// The master chain and loudness target (defaults filled in).
    #[serde(default)]
    pub master: MasterSpec,
}

/// Loudness target when the score doesn't set one.
pub const DEFAULT_LOUDNESS: f64 = -16.0;

/// Check an effect chain's settings; errors name `at` (e.g. "tracks[2].effects[1]").
fn check_effects(at: &str, fx: &[Effect], errors: &mut Vec<String>) {
    let range = |errors: &mut Vec<String>, what: String, v: f64, lo: f64, hi: f64, unit: &str| {
        if !(lo..=hi).contains(&v) {
            errors.push(format!("{what}: {v}{unit} is outside {lo}{unit} to {hi}{unit}"));
        }
    };
    for (i, e) in fx.iter().enumerate() {
        let at = format!("{at}.effects[{i}]");
        match e {
            Effect::Eq(q) => {
                for (name, f) in [("lowcut", q.lowcut), ("highcut", q.highcut)] {
                    if let Some(f) = f {
                        range(errors, format!("{at}.eq.{name}"), f, 20.0, 20000.0, " Hz");
                    }
                }
                for (name, b) in [("low", q.low), ("high", q.high)] {
                    if let Some([g, f]) = b {
                        range(errors, format!("{at}.eq.{name} gain"), g, -24.0, 24.0, " dB");
                        range(errors, format!("{at}.eq.{name} frequency"), f, 20.0, 20000.0, " Hz");
                    }
                }
                if q.peaks.len() > 4 {
                    errors.push(format!("{at}.eq: {} peak bands; an eq holds at most 4 (add another eq for more)", q.peaks.len()));
                }
                for [g, f, qq] in &q.peaks {
                    range(errors, format!("{at}.eq.peak gain"), *g, -24.0, 24.0, " dB");
                    range(errors, format!("{at}.eq.peak frequency"), *f, 20.0, 20000.0, " Hz");
                    range(errors, format!("{at}.eq.peak q"), *qq, 0.1, 18.0, "");
                }
                if *q == Default::default() {
                    errors.push(format!("{at}.eq: an empty eq does nothing; give it lowcut, highcut, low, high or peak"));
                }
            }
            Effect::Comp(c) => {
                range(errors, format!("{at}.comp.ratio"), c.ratio, 1.0, 50.0, ":1");
                range(errors, format!("{at}.comp.threshold"), c.threshold, -60.0, 0.0, " dB");
                if let Some(v) = c.attack_ms {
                    range(errors, format!("{at}.comp.attack"), v, 0.1, 500.0, " ms");
                }
                if let Some(v) = c.release_ms {
                    range(errors, format!("{at}.comp.release"), v, 5.0, 3000.0, " ms");
                }
                if let Some(v) = c.knee {
                    range(errors, format!("{at}.comp.knee"), v, 0.0, 24.0, " dB");
                }
                if let Some(v) = c.makeup {
                    range(errors, format!("{at}.comp.makeup"), v, -12.0, 24.0, " dB");
                }
            }
            Effect::Limit(l) => {
                range(errors, format!("{at}.limit.ceiling"), l.ceiling, -24.0, 0.0, " dB");
                if let Some(v) = l.release_ms {
                    range(errors, format!("{at}.limit.release"), v, 1.0, 2000.0, " ms");
                }
            }
            Effect::Drive(d) => {
                range(errors, format!("{at}.drive"), d.db, 0.0, 36.0, " dB");
                if let Some(t) = d.tone {
                    range(errors, format!("{at}.drive.tone"), t, 200.0, 20000.0, " Hz");
                }
            }
            Effect::Lofi(f) => {
                if *f == Default::default() {
                    errors.push(format!("{at}.lofi: give it bits, rate and/or wow"));
                }
                if let Some(b) = f.bits {
                    range(errors, format!("{at}.lofi.bits"), b, 2.0, 16.0, " bits");
                }
                if let Some(r) = f.rate {
                    range(errors, format!("{at}.lofi.rate"), r, 1000.0, 48000.0, " Hz");
                }
                if let Some(w) = f.wow {
                    range(errors, format!("{at}.lofi.wow"), w * 100.0, 0.0, 100.0, "%");
                }
            }
            Effect::NoiseGate(g) => {
                range(errors, format!("{at}.noisegate.threshold"), g.threshold, -90.0, 0.0, " dB");
                for (name, v, lo, hi) in [("attack", g.attack_ms, 0.1, 100.0), ("hold", g.hold_ms, 0.0, 2000.0), ("release", g.release_ms, 5.0, 3000.0)] {
                    if let Some(v) = v {
                        range(errors, format!("{at}.noisegate.{name}"), v, lo, hi, " ms");
                    }
                }
                if let Some(r) = g.range {
                    range(errors, format!("{at}.noisegate.range"), r, -90.0, 0.0, " dB");
                }
            }
            Effect::Width(w) => range(errors, format!("{at}.width"), w * 100.0, 0.0, 200.0, "%"),
            Effect::Reverb(r) => {
                if let Some(v) = r.decay_s {
                    range(errors, format!("{at}.reverb.decay"), v, 0.1, 20.0, " s");
                }
                if let Some(v) = r.predelay_ms {
                    range(errors, format!("{at}.reverb.predelay"), v, 0.0, 500.0, " ms");
                }
                for (name, v) in [("damp", r.damp), ("mix", r.mix)] {
                    if let Some(v) = v {
                        range(errors, format!("{at}.reverb.{name}"), v * 100.0, 0.0, 100.0, "%");
                    }
                }
            }
            Effect::Delay(d) => {
                match (d.beats, d.ms) {
                    (Some(_), Some(_)) | (None, None) => errors.push(format!("{at}.delay: give the time once, as beats (0.75 = a dotted eighth) or ms")),
                    (Some(b), None) => range(errors, format!("{at}.delay.beats"), b, 1.0 / 64.0, 16.0, " beats"),
                    (None, Some(m)) => range(errors, format!("{at}.delay.ms"), m, 1.0, 10_000.0, " ms"),
                }
                if let Some(f) = d.feedback {
                    range(errors, format!("{at}.delay.feedback"), f * 100.0, 0.0, 95.0, "%");
                }
                if let Some(m) = d.mix {
                    range(errors, format!("{at}.delay.mix"), m * 100.0, 0.0, 100.0, "%");
                }
                for (name, f) in [("highpass", d.highpass), ("lowpass", d.lowpass)] {
                    if let Some(f) = f {
                        range(errors, format!("{at}.delay.{name}"), f, 20.0, 20000.0, " Hz");
                    }
                }
            }
        }
    }
}

/// A position: "bar:beat" (`"3:2.5"`, `"5"`) or seconds from the start (`"12.5s"`), in beats.
fn position(pos: &str, meter: u32, tempo: f64) -> Result<f64, String> {
    if let Some(secs) = pos.strip_suffix('s').filter(|_| !pos.contains(':')) {
        let secs: f64 = secs.trim().parse().map_err(|_| format!("{pos:?}: expected seconds like \"12.5s\" or a bar like \"3:2\""))?;
        if secs < 0.0 {
            return Err(format!("{pos:?}: seconds count from the start, so they can't be negative"));
        }
        return Ok(secs * tempo / 60.0);
    }
    parse_position(pos, meter)
}

/// A group or return track after compiling: where it goes and what it does. `Timeline::buses`
/// lists them so that each comes after everything that feeds it (render in order).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusInfo {
    pub name: String,
    /// "group" or "return".
    #[serde(default = "group_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    pub gain_db: f64,
    /// A group track, or "master".
    pub out: String,
}

fn group_kind() -> String {
    "group".into()
}

/// Check group and return tracks, `group` and `send` targets, and cycles; returns them
/// feeders-first (groups inside out, then returns).
fn route(score: &Score, errors: &mut Vec<String>) -> Vec<BusInfo> {
    let groups: Vec<String> = score.groups.keys().cloned().collect();
    let returns: Vec<String> = score.returns.keys().cloned().collect();
    let group_ok = |g: &str, at: String, errors: &mut Vec<String>| {
        if score.groups.contains_key(g) {
            return;
        }
        let hint = if score.returns.contains_key(g) {
            format!("; `{g}` is a return track: reach it with send {g} 20%")
        } else if groups.is_empty() {
            format!("; add one: `group {g}` with its effects below")
        } else {
            did_you_mean(g, groups.iter())
        };
        errors.push(format!("{at}: there's no group track `{g}`{hint}"));
    };
    let track_names: Vec<String> = score.tracks.iter().map(|t| t.name.clone().unwrap_or_else(|| t.clip.clone())).collect();
    for (i, tr) in score.tracks.iter().enumerate() {
        if let Some(g) = &tr.group {
            group_ok(g, format!("tracks[{i}].group"), errors);
        }
        for (r, lvl) in &tr.sends {
            if r == "master" {
                errors.push(format!("tracks[{i}].sends: a track already plays into the master; send to a return track"));
                continue;
            }
            if !score.returns.contains_key(r) {
                let hint = if score.groups.contains_key(r) {
                    format!("; `{r}` is a group track: put the track in it with group {r}")
                } else if returns.is_empty() {
                    format!("; add one: `return {r}` with its effects below")
                } else {
                    did_you_mean(r, returns.iter())
                };
                errors.push(format!("tracks[{i}].sends.{r}: there's no return track `{r}`{hint}"));
            }
            if !(0.0..=1.0).contains(lvl) {
                errors.push(format!("tracks[{i}].sends.{r}: {}% is outside 0–100%", lvl * 100.0));
            }
        }
    }
    let both = score.groups.iter().map(|(n, g)| (n, "groups", &g.effects, g.volume)).chain(score.returns.iter().map(|(n, r)| (n, "returns", &r.effects, r.volume)));
    for (name, kind, effects, volume) in both {
        let at = format!("{kind}.{name}");
        if track_names.contains(name) {
            errors.push(format!("{at}: a track is also named `{name}`; give the {} track another name", &kind[..kind.len() - 1]));
        }
        if kind == "returns" && score.groups.contains_key(name) {
            errors.push(format!("{at}: a group track is also named `{name}`; give one of them another name"));
        }
        if !(-60.0..=12.0).contains(&volume) {
            errors.push(format!("{at}.volume: {volume} dB is outside -60 to +12"));
        }
        check_effects(&at, effects, errors);
    }
    for (name, g) in &score.groups {
        let at = format!("groups.{name}");
        if let Some(p) = &g.group {
            group_ok(p, format!("{at}.group"), errors);
        }
        let fed = score.tracks.iter().any(|t| t.group.as_deref() == Some(name.as_str())) || score.groups.values().any(|o| o.group.as_deref() == Some(name.as_str()));
        if !fed {
            errors.push(format!("{at}: nothing plays in this group; put a track in it (track … group {name})"));
        }
    }
    for name in score.returns.keys() {
        if !score.tracks.iter().any(|t| t.sends.contains_key(name)) {
            errors.push(format!("returns.{name}: nothing sends to this return track; send a track to it (send {name} 20%)"));
        }
    }
    // Sidechains: keyed by a track (by name), never by itself, and no ducking loops between tracks.
    let keys_of = |fx: &[Effect]| fx.iter().filter_map(|e| if let Effect::Comp(c) = e { c.sidechain.clone() } else { None }).collect::<Vec<String>>();
    let chains = score.tracks.iter().enumerate().map(|(i, t)| (format!("tracks[{i}]"), track_names[i].clone(), keys_of(&t.effects)));
    let chains = chains
        .chain(score.groups.iter().map(|(n, g)| (format!("groups.{n}"), String::new(), keys_of(&g.effects))))
        .chain(score.returns.iter().map(|(n, r)| (format!("returns.{n}"), String::new(), keys_of(&r.effects))));
    for (at, own, keys) in chains {
        for k in keys {
            if k == own {
                errors.push(format!("{at}: a comp can't be keyed by its own track; that's just a compressor (drop sidechain)"));
            } else if !track_names.contains(&k) {
                let hint = if score.groups.contains_key(&k) || score.returns.contains_key(&k) { " (a group or return track can't key a sidechain; key it from one of the tracks)".to_string() } else { did_you_mean(&k, track_names.iter()) };
                errors.push(format!("{at}: sidechain `{k}`: there's no track by that name{hint}"));
            }
        }
    }
    let track_keys: Vec<Vec<String>> = score.tracks.iter().map(|t| keys_of(&t.effects)).collect();
    for (i, keys) in track_keys.iter().enumerate() {
        // Follow the keys: does anything lead back to this track?
        let mut seen = vec![false; track_names.len()];
        let mut stack: Vec<usize> = keys.iter().filter_map(|k| track_names.iter().position(|n| n == k)).collect();
        while let Some(j) = stack.pop() {
            if j == i {
                errors.push(format!("tracks[{i}]: `{}` is ducked by a track that is (in turn) ducked by it; one of them must not use sidechain", track_names[i]));
                break;
            }
            if !std::mem::replace(&mut seen[j], true) {
                stack.extend(track_keys[j].iter().filter_map(|k| track_names.iter().position(|n| n == k)));
            }
        }
    }
    // Groups inside out (a group comes after the groups in it); anything left over sits on a cycle.
    let out_of = |n: &str| score.groups.get(n).and_then(|g| g.group.clone()).filter(|p| score.groups.contains_key(p)).unwrap_or_else(|| "master".into());
    let mut order: Vec<String> = Vec::new();
    let mut left: Vec<String> = groups.clone();
    while !left.is_empty() {
        let ready: Vec<String> = left.iter().filter(|n| !left.iter().any(|m| m != *n && out_of(m) == **n)).cloned().collect();
        if ready.is_empty() {
            errors.push(format!("groups: {} sit inside each other in a loop; one of them must play into the master", left.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ")));
            break;
        }
        left.retain(|n| !ready.contains(n));
        order.extend(ready);
    }
    let mut out: Vec<BusInfo> = order.iter().map(|n| BusInfo { name: n.clone(), kind: "group".into(), effects: score.groups[n].effects.clone(), gain_db: score.groups[n].volume, out: out_of(n) }).collect();
    out.extend(score.returns.iter().map(|(n, r)| BusInfo { name: n.clone(), kind: "return".into(), effects: r.effects.clone(), gain_db: r.volume, out: "master".into() }));
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub clip: String,
    pub path: PathBuf,
    pub bpm: Option<f64>,
    pub key: String,
    /// The clip's region in its sample, in source seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub track: String,
    /// Index into `sources`.
    pub source: usize,
    pub start_beat: f64,
    pub dur_beats: f64,
    /// Source seconds covered.
    pub src_start: f64,
    pub src_end: f64,
    /// Warp map: (source seconds, beats from event start), increasing in both.
    pub warp: Vec<(f64, f64)>,
    /// Transposition chosen by the harmony solver (or fixed in the score).
    pub semitones: i32,
    /// Fine correction that brings the source to A440 (negated `tuning_cents` from analysis).
    pub tuning_cents: f64,
    pub gain_db: f64,
    pub mode: WarpModeSpec,
    /// Play backwards (applied after warping).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reverse: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
    /// Which of its track's `pieces` this plays (the pad, or slice), for tracing a sound to its source.
    #[serde(default)]
    pub piece: usize,
}

/// One sound a track can play: its clip's region, one slice, or one pad, and where it is recorded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PieceInfo {
    /// Index into `sources`.
    pub source: usize,
    pub src_start: f64,
    pub src_end: f64,
    /// A drum-kit pad's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChordSpan {
    pub start_beat: f64,
    pub end_beat: f64,
    pub label: String,
    pub fit: Option<Fit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackInfo {
    pub name: String,
    pub clip: String,
    /// Key of the clip region as detected from its chroma.
    pub region_key: String,
    pub region_beats: (f64, f64),
    /// Clip beats per score beat.
    pub beat_ratio: f64,
    /// Source tempo / score tempo (1.0 = no stretch needed).
    pub stretch: Option<f64>,
    /// Fine tuning applied to bring the source to A440.
    pub retune_cents: f64,
    /// Automatic level match: brings the region to a common loudness before the track's `gain`.
    pub level_db: f64,
    /// Number of pads when the track plays a kit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chops: Option<usize>,
    /// The kit it plays, if it plays a whole kit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kit: Option<String>,
    /// What it can play (its clip, or a kit's pads: slices or clips); events point into this.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pieces: Vec<PieceInfo>,
    /// Insert effects, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// −1 (left) … 1 (right).
    #[serde(default)]
    pub pan: f64,
    /// A group track, or "master".
    #[serde(default = "master_name")]
    pub out: String,
    /// Post-fader sends: return track → level (0–1, linear).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sends: BTreeMap<String, f64>,
    /// Set when the clip plays re-pitched (`warp repitch`): its playback speed (1 = as recorded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub varispeed: Option<f64>,
    /// What the harmony solver knows about it, so an editor can ask how it would fit any chord (`assist::fit_chords`).
    /// Absent when it plays re-pitched and sits out of the harmony.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<crate::assist::VoiceInfo>,
}

fn master_name() -> String {
    "master".into()
}

/// A playable piece: a region of a resolved clip, optionally named (a drum-kit pad).
#[derive(Clone)]
struct Piece {
    /// Key into the resolved clips.
    clip: String,
    from: f64,
    to: f64,
    name: Option<String>,
}

/// What a track plays: one piece (a clip's region, one slice, one pad), or a whole kit.
struct TrackSrc {
    pieces: Vec<Piece>,
    /// Set when the track plays a whole kit (pieces addressed by `steps`).
    kit: Option<String>,
}

/// Resolve a clip region from `beats` / `seconds` / a saved clip (all in the sample's terms).
fn region_of(clip: &Clip, whole: (f64, f64), beats: Option<[f64; 2]>, seconds: Option<[f64; 2]>, saved: Option<&str>) -> Result<(f64, f64), String> {
    let (lo, hi) = clip.beat_range();
    let r = if let Some([a, b]) = beats {
        if a < lo - 0.01 || b > hi + 0.01 {
            return Err(format!("beats [{a}, {b}] is outside the clip's beats [{lo}, {hi}]"));
        }
        (a, b)
    } else if let Some([a, b]) = seconds {
        if a < 0.0 || b > clip.duration() + 1e-6 {
            return Err(format!("seconds [{a}, {b}] is outside the clip (0..{:.2} s)", clip.duration()));
        }
        (clip.beat_at(a), clip.beat_at(b))
    } else if let Some(sl) = saved {
        let s = clip.manifest.annotations.clips.iter().find(|s| s.name == sl).ok_or_else(|| format!("no saved clip {sl:?} in this sample"))?;
        (clip.beat_at(s.start), clip.beat_at(s.end))
    } else {
        whole
    };
    if r.1 - r.0 < 0.05 {
        return Err(format!("the region is empty or backwards ({:.2}..{:.2} beats)", r.0, r.1));
    }
    Ok(r)
}

struct ResolvedClip {
    name: String,
    clip: Clip,
    source: usize,
    /// Region in the clip's own beats.
    from: f64,
    to: f64,
    mode: WarpModeSpec,
    /// Clip beats per score beat.
    ratio: f64,
    /// `pick:` length in score beats; the region is chosen once chords are known.
    pick: Option<f64>,
    /// Pinned root (`root:`), else detected from the region.
    root: Option<PitchClass>,
}

/// Every track's region is brought to this RMS level before its own `gain`, so `gain` is a mix
/// decision (e.g. "horns 2 dB under the groove") rather than compensation for recording levels.
const TARGET_DBFS: f64 = -20.0;

/// Clip beats per score beat: ½, 1 or 2, whichever brings the clip's tempo closest to the score's.
fn auto_beat_ratio(clip_bpm: Option<f64>, tempo: f64) -> f64 {
    let Some(bpm) = clip_bpm else { return 1.0 };
    [0.5, 1.0, 2.0].into_iter().min_by(|a, b| (bpm / a / tempo).ln().abs().total_cmp(&(bpm / b / tempo).ln().abs())).unwrap()
}

/// Compile a score file. Errors are collected and returned together.
pub fn compile_file(path: &Path) -> Result<Timeline, Vec<String>> {
    let text = std::fs::read_to_string(path).map_err(|e| vec![format!("{}: {e}", path.display())])?;
    compile_text(&text, path, &mut |p: &Path| Clip::load(p))
}

/// Read a score from text: `.apr` files use the text language, anything else is YAML/JSON.
/// The source map (text language only) lets compile errors point at lines.
pub fn parse_score(text: &str, path: &Path) -> Result<(Score, Option<crate::dsl::SourceMap>), Vec<String>> {
    let shown = path.display();
    if path.extension().is_some_and(|e| e == "apr") {
        crate::dsl::parse(text).map(|(s, m)| (s, Some(m))).map_err(|es| es.into_iter().map(|e| format!("{shown}: {e}")).collect())
    } else {
        serde_yaml::from_str(text).map(|s| (s, None)).map_err(|e| vec![format!("{shown}: {e}")])
    }
}

/// Parse (either format) and compile, with clips from `load`; errors carry line numbers when
/// the text language can place them.
pub fn compile_text(text: &str, path: &Path, load: &mut dyn FnMut(&Path) -> Result<Clip, String>) -> Result<Timeline, Vec<String>> {
    let (score, map) = parse_score(text, path)?;
    compile_with(&score, path.parent().unwrap_or(Path::new(".")), load).map_err(|errs| match map {
        Some(m) => errs.iter().map(|e| format!("{}: {}", path.display(), m.locate(e))).collect(),
        None => errs,
    })
}

pub fn compile(score: &Score, base_dir: &Path) -> Result<Timeline, Vec<String>> {
    compile_with(score, base_dir, &mut |p: &Path| Clip::load(p))
}

/// Audio paths a score refers to (resolved against `base_dir` and `samples:`), without loading
/// anything. A browser fetches these clips' manifests and then calls `compile_with`.
pub fn source_paths(score: &Score, base_dir: &Path) -> Vec<PathBuf> {
    let samples = normalize(&base_dir.join(score.samples.as_deref().unwrap_or(".")));
    score.clips.values().map(|c| normalize(&samples.join(&c.source))).collect()
}

/// Every clip and kit pad reference in the score: sample paths and the saved clips used.
/// Used to track which samples a score depends on and detect when saved clips have drifted.
pub fn references(score: &Score, base_dir: &Path) -> Vec<crate::score::Ref> {
    let samples = normalize(&base_dir.join(score.samples.as_deref().unwrap_or(".")));
    let mut refs = Vec::new();

    // Helper to resolve a clip name to its source and path, or None if not found.
    let resolve_clip = |clip_name: &str| -> Option<(String, Option<PathBuf>, Option<String>)> {
        score.clips.get(clip_name).map(|clip_spec| {
            let path = if clip_spec.source.starts_with("@") {
                None // ID form - don't resolve
            } else {
                Some(normalize(&samples.join(&clip_spec.source)))
            };
            (clip_spec.source.clone(), path, clip_spec.saved.clone())
        })
    };

    // 1. References from clips (direct uses).
    for (alias, clip) in &score.clips {
        let path = if clip.source.starts_with("@") {
            None // ID form - don't resolve
        } else {
            Some(normalize(&samples.join(&clip.source)))
        };
        refs.push(crate::score::Ref {
            alias: alias.clone(),
            source: clip.source.clone(),
            path,
            slice: clip.saved.clone(),
            kit_pad: None,
        });
    }

    // 2. References from sliced kits.
    for (kit_name, kit) in &score.kits {
        if let Some(clip_name) = &kit.clip {
            if let Some((source, path, slice)) = resolve_clip(clip_name) {
                refs.push(crate::score::Ref {
                    alias: clip_name.clone(),
                    source,
                    path,
                    slice,
                    kit_pad: Some(kit_name.clone()),
                });
            }
        }
    }

    // 3. References from kit pads (named pieces of clips).
    for (kit_name, kit) in &score.kits {
        for (pad_name, pad) in &kit.pads {
            // Resolve the clip reference: either a clip name or a slice reference like "k.3".
            let (clip_alias, source_str, path, slice_from_clip) = if let Some((kit_name_ref, _chop_idx)) = pad.clip.rsplit_once('.') {
                // Possible slice reference: check if kit_name_ref is a sliced kit.
                if let Some(chop_kit) = score.kits.get(kit_name_ref) {
                    if let Some(original_clip_name) = &chop_kit.clip {
                        // It's a valid slice reference - resolve to the original clip.
                        if let Some((source, path, slice)) = resolve_clip(original_clip_name) {
                            (original_clip_name.clone(), source, path, slice)
                        } else {
                            continue; // Clip not found, skip
                        }
                    } else {
                        // It's a drum kit, not a sliced kit - this reference is invalid, skip.
                        continue;
                    }
                } else {
                    // It's not a kit reference, treat as a regular clip name (e.g., "foo.bar" as a clip).
                    if let Some((source, path, slice)) = resolve_clip(&pad.clip) {
                        (pad.clip.clone(), source, path, slice)
                    } else {
                        continue; // Clip not found, skip
                    }
                }
            } else {
                // Regular clip reference.
                if let Some((source, path, slice)) = resolve_clip(&pad.clip) {
                    (pad.clip.clone(), source, path, slice)
                } else {
                    continue; // Clip not found, skip
                }
            };

            let kit_pad = format!("{kit_name}.{pad_name}");
            refs.push(crate::score::Ref {
                alias: clip_alias,
                source: source_str,
                path,
                // Use the pad's saved clip if it names one, otherwise the clip's.
                slice: pad.saved.clone().or(slice_from_clip),
                kit_pad: Some(kit_pad),
            });
        }
    }

    refs
}

/// Lexically resolve `.` and `..` (no filesystem access), so paths work as keys in a browser.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// `compile`, with clips supplied by `load` (given the resolved audio path).
pub fn compile_with(score: &Score, base_dir: &Path, load: &mut dyn FnMut(&Path) -> Result<Clip, String>) -> Result<Timeline, Vec<String>> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if (score.apricity - 0.1).abs() > 1e-9 {
        errors.push(format!("apricity: this compiler reads format 0.1, not {}", score.apricity));
    }
    if !(20.0..=400.0).contains(&score.tempo) {
        errors.push(format!("tempo: {} is outside 20..400 BPM", score.tempo));
    }
    if !(1..=16).contains(&score.meter) {
        errors.push(format!("time: {}/4 is outside 1/4..16/4", score.meter));
    }
    let key: Option<Key> = score.key.parse().map_err(|e| errors.push(format!("key: {e}"))).ok();
    let meter = score.meter.clamp(1, 16);
    let samples = normalize(&base_dir.join(score.samples.as_deref().unwrap_or(".")));

    // ---- clips
    let mut clips: BTreeMap<String, ResolvedClip> = BTreeMap::new();
    let mut sources = Vec::new();
    for (name, spec) in &score.clips {
        let at = format!("clips.{name}");
        let mut clip = match load(&normalize(&samples.join(&spec.source))) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{at}.source: {e}"));
                continue;
            }
        };
        let unwarped = spec.warp == WarpModeSpec::Repitch;
        if unwarped {
            let speed = spec.speed.unwrap_or(1.0);
            if !(0.25..=4.0).contains(&speed) {
                errors.push(format!("{at}.speed: {speed}× is outside 0.25–4"));
                continue;
            }
            if spec.beat_ratio.is_some() || spec.pick.is_some() {
                errors.push(format!("{at}: `{}` needs the clip's own beats, but it plays re-pitched (warp repitch); choose the region with seconds, beats or a saved clip", if spec.pick.is_some() { "pick" } else { "beat_ratio" }));
                continue;
            }
            // An even grid at tempo / speed: warping it onto the score's grid is varispeed.
            clip.unwarp(score.tempo.max(1.0) / speed);
        } else if spec.speed.is_some() {
            errors.push(format!("{at}.speed: speed is for re-pitched clips (warp repitch), which play like a record; a warped clip follows the score's tempo (use the track's half, double or speed to change how it sits on the grid)"));
            continue;
        } else if !clip.has_beats() {
            errors.push(format!("{at}: no beat grid was detected, so it can't be warped by beats; add `warp repitch` to play it as recorded"));
            continue;
        }
        let given = [spec.beats.is_some(), spec.seconds.is_some(), spec.saved.is_some(), spec.pick.is_some()].iter().filter(|&&b| b).count();
        if given > 1 {
            errors.push(format!("{at}: give at most one of beats, seconds, a saved clip or pick"));
            continue;
        }
        let (lo, hi) = clip.beat_range();
        let region = if let Some([a, b]) = spec.beats {
            if a < lo - 0.01 || b > hi + 0.01 {
                Err(format!("{at}.beats: [{a}, {b}] is outside the clip's beats [{lo}, {hi}]"))
            } else {
                Ok((a, b))
            }
        } else if let Some([a, b]) = spec.seconds {
            if a < 0.0 || b > clip.duration() + 1e-6 {
                Err(format!("{at}.seconds: [{a}, {b}] is outside the clip (0..{:.2} s)", clip.duration()))
            } else {
                Ok((clip.beat_at(a), clip.beat_at(b)))
            }
        } else if let Some(sl) = &spec.saved {
            match clip.manifest.annotations.clips.iter().find(|s| &s.name == sl) {
                Some(s) => Ok((clip.beat_at(s.start), clip.beat_at(s.end))),
                None => {
                    let have: Vec<_> = clip.manifest.annotations.clips.iter().map(|s| s.name.as_str()).collect();
                    Err(format!("{at}.saved: no saved clip {sl:?} in this sample{}", if have.is_empty() { " (it has no saved clips yet; mark some in the Library or run automatic markup)".into() } else { format!("; it has {have:?}") }))
                }
            }
        } else if unwarped {
            Ok((0.0, clip.beat_at(clip.duration())))
        } else {
            Ok((lo.max(0.0).ceil(), hi.floor()))
        };
        match region {
            Ok((a, b)) if b - a < 0.25 => errors.push(format!("{at}: the region is empty or backwards ({a:.2}..{b:.2} beats)")),
            Ok((from, to)) => {
                let m = &clip.manifest;
                sources.push(SourceRef { clip: name.clone(), path: clip.audio.clone(), bpm: m.rhythm.bpm, key: format!("{} {}", m.tonal.key.tonic, m.tonal.key.mode), region: Some((clip.seconds_at(from), clip.seconds_at(to))) });
                let ratio = match spec.beat_ratio.or(unwarped.then_some(1.0)) {
                    Some(r) if r > 0.0 => r,
                    Some(r) => {
                        errors.push(format!("{at}.beat_ratio: must be more than zero, not {r}"));
                        continue;
                    }
                    None => auto_beat_ratio(m.rhythm.bpm, score.tempo),
                };
                let pick = match spec.pick.as_deref().map(|d| parse_duration(d, meter)) {
                    None => None,
                    Some(Ok(len)) if len * ratio <= to - from => Some(len),
                    Some(Ok(len)) => {
                        errors.push(format!("{at}.pick: {} score beats is longer than the clip ({:.0} of its beats at beat_ratio {ratio})", len, to - from));
                        continue;
                    }
                    Some(Err(e)) => {
                        errors.push(format!("{at}.pick: {e}"));
                        continue;
                    }
                };
                let root = match spec.root.as_deref().map(str::parse::<PitchClass>) {
                    None => None,
                    Some(Ok(pc)) => Some(pc),
                    Some(Err(e)) => {
                        errors.push(format!("{at}.root: {e}"));
                        continue;
                    }
                };
                clips.insert(name.clone(), ResolvedClip { name: name.clone(), clip, source: sources.len() - 1, from, to, mode: spec.warp, ratio, pick, root });
            }
            Err(e) => errors.push(e),
        }
    }

    // ---- progression
    let mut spans: Vec<(f64, f64, Option<Chord>, String)> = Vec::new();
    let mut t = 0.0;
    for (i, c) in score.progression.iter().enumerate() {
        if c.bars <= 0.0 {
            errors.push(format!("progression[{i}].bars: must be more than zero"));
            continue;
        }
        let len = c.bars * meter as f64;
        let chord = key.and_then(|k| Chord::parse(&c.chord, k).map_err(|e| errors.push(format!("progression[{i}].chord: {e}"))).ok());
        spans.push((t, t + len, chord, c.chord.clone()));
        t += len;
    }
    let mut length = if spans.is_empty() {
        match score.bars {
            Some(b) if b > 0 => b as f64 * meter as f64,
            _ => {
                errors.push("give a progression, or `bars:` for a piece without chords".into());
                0.0
            }
        }
    } else {
        if score.bars.is_some_and(|b| (b as f64 * meter as f64 - t).abs() > 1e-9) {
            errors.push(format!("bars: {} doesn't match the progression's {} bars; drop `bars:`", score.bars.unwrap(), t / meter as f64));
        }
        t
    };
    // An unwarped layer cued with `at` (a voice, a speech) plays at its own length; if it runs past
    // the chords, the piece grows to hold it and the progression repeats underneath.
    if !spans.is_empty() && score.bars.is_none() {
        let mut need = (0.0, String::new());
        for tr in &score.tracks {
            let (Some(rc), Pattern::At(list), None) = (clips.get(&tr.clip), &tr.pattern, &tr.bars) else { continue };
            if rc.mode != WarpModeSpec::Repitch {
                continue;
            }
            let len = (rc.to - rc.from) / tr.speed.unwrap_or(1.0);
            for p in list.iter().filter_map(|p| position(p, meter, score.tempo).ok()) {
                if p + len > need.0 {
                    need = (p + len, tr.name.clone().unwrap_or_else(|| tr.clip.clone()));
                }
            }
        }
        if need.0 > length + 1e-6 && length > 0.0 {
            let grown = (need.0 / meter as f64 - 1e-9).ceil() * meter as f64;
            let one = spans.clone();
            let mut k = 1.0;
            while spans.last().is_some_and(|s| s.1 < grown - 1e-9) {
                for (a, b, c, l) in &one {
                    let (a, b) = (a + k * length, (b + k * length).min(grown));
                    if a < grown - 1e-9 {
                        spans.push((a, b, c.clone(), l.clone()));
                    }
                }
                k += 1.0;
            }
            warnings.push(format!(
                "{}: plays {:.1} s, past the {} bars of chords; the piece grows to {} bars and the chords repeat (set `bars` to choose the length yourself)",
                need.1, need.0 * 60.0 / score.tempo, length / meter as f64, grown / meter as f64
            ));
            length = grown;
        }
    }
    if spans.is_empty() {
        spans.push((0.0, length, None, String::new()));
    }

    // ---- pick: choose each auto region as the bar-aligned window that best fits the chords, and
    // also has a steady beat, harmony that holds still (so it transposes cleanly), and something
    // actually playing (stems are often near-silent for stretches).
    if let Some(k) = key {
        let chords: Vec<&Chord> = spans.iter().filter_map(|s| s.2.as_ref()).collect();
        for rc in clips.values_mut() {
            let Some(len) = rc.pick else { continue };
            // Judge windows the way they'll be played: moved onto each chord's root if any track follows.
            let follows = score.tracks.iter().any(|t| t.clip == rc.name && t.transpose == Transpose::Follow);
            let (lo, hi) = (rc.from, rc.to);
            let win = len * rc.ratio;
            let step = meter as f64 * rc.ratio;
            let mut best: Option<(f64, f64)> = None;
            let mut b = lo.max(0.0).ceil();
            while b + win <= hi + 1e-9 {
                let range = (b, b + win);
                let mut v = Voice::new(&rc.name, rc.clip.pcp(range));
                v.tonic = rc.root.or(rank_keys(&v.pcp).first().map(|x| x.0.tonic));
                let harmony = if chords.is_empty() {
                    0.0
                } else {
                    chords.iter().map(|ch| {
                        let mut v = v.clone();
                        if follows {
                            v.fixed = v.tonic.map(|t| t.signed_interval_to(ch.root));
                        }
                        solve(std::slice::from_ref(&v), ch, k, &Weights::default()).score
                    }).sum::<f64>() / chords.len() as f64
                };
                let score = harmony - 2.0 * rc.clip.beat_irregularity(range) - 1.5 * rc.clip.harmonic_motion(range) - rc.clip.quietness(range);
                if best.is_none_or(|(_, s)| score > s) {
                    best = Some((b, score));
                }
                b += step;
            }
            if let Some((b, _)) = best {
                rc.from = b;
                rc.to = b + win;
            }
        }
    }

    // ---- kits: sliced kits first (one clip's slices on numbered pads), then drum kits (named pads
    // from anywhere, which may hold another kit's slice like "k.3").
    let mut kits: BTreeMap<String, Vec<Piece>> = BTreeMap::new();
    for (name, kit) in &score.kits {
        let at = format!("kits.{name}");
        if score.clips.contains_key(name) {
            errors.push(format!("{at}: `{name}` is already a clip name; kits and clips share names"));
            continue;
        }
        match (&kit.clip, &kit.slice, kit.pads.is_empty()) {
            (Some(_), Some(_), true) | (None, None, false) => {}
            _ => {
                errors.push(format!("{at}: a kit is either `clip` + `slice` (a sliced clip) or `pads` (a drum kit), not both or neither"));
                continue;
            }
        }
        let (Some(clip_name), Some(by)) = (&kit.clip, &kit.slice) else { continue };
        let Some(rc) = clips.get(clip_name) else {
            if !score.clips.contains_key(clip_name) {
                errors.push(format!("{at}.clip: no clip named {:?}{}", clip_name, did_you_mean(clip_name, score.clips.keys())));
            }
            continue;
        };
        let (lo, hi) = (rc.from, rc.to);
        let even = |step: f64| -> Vec<(f64, f64)> {
            let mut v = Vec::new();
            let mut b = lo;
            while b < hi - 1e-6 {
                v.push((b, (b + step).min(hi)));
                b += step;
            }
            v
        };
        let chops = match by {
            SliceBy::Beats(n) if *n > 0.0 => even(n * rc.ratio),
            SliceBy::Bars(n) if *n > 0.0 => even(n * meter as f64 * rc.ratio),
            SliceBy::Into(n) if *n > 0 => even((hi - lo) / *n as f64),
            SliceBy::Transients => {
                let mut ts: Vec<f64> = rc.clip.manifest.annotations.markers.iter().filter(|m| m.name == "transient").map(|m| rc.clip.beat_at(m.seconds)).filter(|&b| b >= lo - 1e-6 && b < hi).collect();
                ts.sort_by(|a, b| a.total_cmp(b));
                ts.dedup_by(|a, b| (*a - *b).abs() < 0.05);
                if ts.is_empty() {
                    errors.push(format!("{at}.slice: `{clip_name}` has no transients marked in its region; run automatic markup, mark transients yourself, or slice by beats"));
                    continue;
                }
                // Each slice is a one-shot lasting until the next transient, at most a bar.
                let cap = meter as f64 * rc.ratio;
                ts.iter().enumerate().map(|(i, &t)| (t, ts.get(i + 1).copied().unwrap_or(hi).min(t + cap).min(hi))).collect()
            }
            SliceBy::Phrases => {
                let number = |n: &str| n.strip_prefix("phrase-").and_then(|k| k.parse::<u32>().ok());
                let mut ph: Vec<(u32, f64, f64)> = rc
                    .clip
                    .manifest
                    .annotations
                    .clips
                    .iter()
                    .filter_map(|sl| number(&sl.name).map(|k| (k, rc.clip.beat_at(sl.start).max(lo), rc.clip.beat_at(sl.end).min(hi))))
                    .filter(|(_, a, b)| b > a)
                    .collect();
                ph.sort_by(|a, b| a.0.cmp(&b.0));
                if ph.is_empty() {
                    errors.push(format!("{at}.slice: `{clip_name}` has no phrases marked in its region; run automatic markup (it finds the pauses in speech), or slice by transients or beats"));
                    continue;
                }
                ph.into_iter().map(|(_, a, b)| (a, b)).collect()
            }
            _ => {
                errors.push(format!("{at}.slice: sizes and counts must be more than zero"));
                continue;
            }
        };
        let chops: Vec<Piece> = chops.into_iter().filter(|(a, b)| b - a > 0.05 * rc.ratio).map(|(from, to)| Piece { clip: clip_name.clone(), from, to, name: None }).collect();
        if chops.len() > 256 {
            errors.push(format!("{at}.slice: that makes {} slices; 256 is the most a kit can hold", chops.len()));
            continue;
        }
        kits.insert(name.clone(), chops);
    }
    for (name, kit) in score.kits.iter().filter(|(_, k)| !k.pads.is_empty() && k.clip.is_none()) {
        let mut pads = Vec::new();
        for (pad, ps) in &kit.pads {
            let at = format!("kits.{name}.pads.{pad}");
            // A pad can hold a slice of a sliced kit ("k.3")…
            if let Some((k, n)) = ps.clip.rsplit_once('.') {
                if let Some(chops) = kits.get(k).filter(|c| c.iter().all(|p| p.name.is_none())) {
                    match n.parse::<usize>() {
                        Ok(i) if i >= 1 && i <= chops.len() => pads.push(Piece { name: Some(pad.clone()), ..chops[i - 1].clone() }),
                        _ => errors.push(format!("{at}.clip: kit `{k}` has pads 1–{}; there's no `{}`", chops.len(), ps.clip)),
                    }
                    continue;
                }
            }
            // …or a region of a clip.
            let Some(rc) = clips.get(&ps.clip) else {
                if !score.clips.contains_key(&ps.clip) {
                    let all: Vec<String> = score.clips.keys().chain(score.kits.keys()).cloned().collect();
                    errors.push(format!("{at}.clip: no clip or slice named {:?}{}", ps.clip, did_you_mean(&ps.clip, all.iter())));
                }
                continue;
            };
            match region_of(&rc.clip, (rc.from, rc.to), ps.beats, ps.seconds, ps.saved.as_deref()) {
                Ok((from, to)) => pads.push(Piece { clip: ps.clip.clone(), from, to, name: Some(pad.clone()) }),
                Err(e) => errors.push(format!("{at}: {e}")),
            }
        }
        kits.insert(name.clone(), pads);
    }

    // What each track plays: a clip, a whole kit, or one pad ("k.3", "drums.kick").
    let resolve_src = |name: &str| -> Result<TrackSrc, String> {
        if let Some(rc) = clips.get(name) {
            return Ok(TrackSrc { pieces: vec![Piece { clip: name.to_string(), from: rc.from, to: rc.to, name: None }], kit: None });
        }
        if let Some(pieces) = kits.get(name) {
            return Ok(TrackSrc { pieces: pieces.clone(), kit: Some(name.to_string()) });
        }
        if let Some((kit, which)) = name.rsplit_once('.') {
            if let Some(pieces) = kits.get(kit) {
                let named = pieces.iter().any(|p| p.name.is_some());
                let found = if named {
                    pieces.iter().find(|p| p.name.as_deref() == Some(which)).cloned()
                } else {
                    which.parse::<usize>().ok().filter(|&i| i >= 1 && i <= pieces.len()).map(|i| pieces[i - 1].clone())
                };
                return match found {
                    Some(p) => Ok(TrackSrc { pieces: vec![p], kit: None }),
                    None if named => {
                        let names: Vec<String> = pieces.iter().filter_map(|p| p.name.clone()).collect();
                        Err(format!("kit `{kit}` has no pad `{which}`{}; its pads are {}", did_you_mean(which, names.iter()), names.join(", ")))
                    }
                    None => Err(format!("kit `{kit}` has pads 1–{}; there's no `{name}`", pieces.len())),
                };
            }
        }
        let all: Vec<String> = score.clips.keys().chain(score.kits.keys()).cloned().collect();
        Err(format!("no clip or kit named {name:?}{}", did_you_mean(name, all.iter())))
    };

    // ---- tracks → notes (start beat, duration, which piece, clip-beat offset)
    struct Hit {
        track: usize,
        start: f64,
        dur: f64,
        piece: usize,
        clip_from: f64,
    }
    let mut srcs: Vec<Option<TrackSrc>> = Vec::new();
    let mut hits = Vec::new();
    let mut track_names = Vec::new();
    for (i, tr) in score.tracks.iter().enumerate() {
        let at = format!("tracks[{i}]");
        if tr.transpose == Transpose::Follow && !matches!(tr.role, apricity_theory::Role::Any | apricity_theory::Role::Root) {
            errors.push(format!("{at}: transpose: follow always puts the clip's root on the chord root, so role: {} can't apply; drop the role or use transpose: auto", format!("{:?}", tr.role).to_lowercase()));
        }
        let name = tr.name.clone().unwrap_or_else(|| tr.clip.clone());
        if track_names.contains(&name) {
            errors.push(format!("{at}: track name {name:?} is used twice; name one with `as` (`name:` in YAML) to tell them apart"));
        }
        track_names.push(name);
        // Check the track's own fields even when its source is broken, so every mistake shows up at once.
        let span = match tr.bars.as_deref().map(|b| parse_bars(b, meter)) {
            None => (0.0, length),
            Some(Ok((a, b))) if b <= length + 1e-9 || length == 0.0 => (a, b),
            Some(Ok(_)) => {
                errors.push(format!("{at}.bars: {:?} runs past the end of the piece ({} bars)", tr.bars.as_ref().unwrap(), length / meter as f64));
                srcs.push(None);
                continue;
            }
            Some(Err(e)) => {
                errors.push(format!("{at}.{e}"));
                srcs.push(None);
                continue;
            }
        };
        let speed = tr.speed.unwrap_or(1.0);
        if !(0.125..=8.0).contains(&speed) {
            errors.push(format!("{at}.speed: {speed} is outside 0.125–8 (0.5 = half-time, 2 = double-time)"));
        }
        if let Some(g) = tr.gate {
            if !(g > 0.0 && g <= 1.0) {
                errors.push(format!("{at}.gate: {g} must be between 0 and 1 (50% = 0.5)"));
            }
        }
        if tr.stutter.is_some_and(|n| n == 0 || n > 64) {
            errors.push(format!("{at}.stutter: must be 1–64 repeats"));
        }
        if let Some(sw) = tr.swing {
            if !(50.0..=75.0).contains(&sw) {
                errors.push(format!("{at}.swing: {sw} is outside 50–75 (50 = straight)"));
            }
        }
        if let Some(f) = tr.filter {
            let hz = match f {
                FilterSpec::Lowpass(h) | FilterSpec::Highpass(h) => h,
            };
            if !(20.0..=20000.0).contains(&hz) {
                errors.push(format!("{at}.filter: {hz} Hz is outside 20–20000"));
            }
        }
        check_effects(&at, &tr.effects, &mut errors);
        if let Some(p) = tr.pan {
            if !(-100.0..=100.0).contains(&p) {
                errors.push(format!("{at}.pan: {p} is outside -100 (left) to 100 (right)"));
            }
        }
        let grid = tr.grid.unwrap_or(16);
        if !(1..=64).contains(&grid) {
            errors.push(format!("{at}.grid: {grid} isn't a note value between 1 and 64 (16 = sixteenth notes)"));
        }
        let src = match resolve_src(&tr.clip) {
            Ok(src) => src,
            Err(e) => {
                let base = tr.clip.split('.').next().unwrap_or("");
                // Don't pile on when the clip or kit itself already failed (its own error is reported).
                let failed_already = (score.clips.contains_key(base) && !clips.contains_key(base)) || (score.kits.contains_key(base) && !kits.contains_key(base));
                if !failed_already {
                    errors.push(format!("{at}.clip: {e}"));
                }
                srcs.push(None);
                continue;
            }
        };
        if src.pieces.iter().any(|p| clips[&p.clip].mode == WarpModeSpec::Repitch) && tr.transpose != Transpose::Auto && tr.transpose != Transpose::Fixed(0) {
            errors.push(format!("{at}.transpose: `{}` plays re-pitched (as recorded), so it isn't transposed; to change its pitch use the clip's speed (like a turntable), or warp it", tr.clip));
        }
        let (s0, s1) = span;
        let first_hit = hits.len();
        let piece_len = |p: &Piece| (p.to - p.from) / (clips[&p.clip].ratio * speed); // score beats
        let mut push = |start: f64, max_len: f64, piece: usize| {
            let p = &src.pieces[piece];
            let dur = piece_len(p).min(max_len).min(s1 - start);
            if dur > 1e-6 {
                hits.push(Hit { track: i, start, dur, piece, clip_from: p.from });
            }
        };
        let single = src.kit.is_none();
        if !single && !matches!(tr.pattern, Pattern::Steps(_)) {
            let example = if src.pieces.iter().any(|p| p.name.is_some()) {
                let names: Vec<&str> = src.pieces.iter().filter_map(|p| p.name.as_deref()).take(2).collect();
                format!("steps \"{} . {} .\" (or one pad: {}.{})", names.first().unwrap_or(&"kick"), names.get(1).unwrap_or(&"snare"), tr.clip, names.first().unwrap_or(&"kick"))
            } else {
                format!("steps \"1 . 2 . 3 . 4 .\" (or one pad: {}.1)", tr.clip)
            };
            errors.push(format!("{at}.pattern: `{}` is a kit; play it with {example}", tr.clip));
        }
        match &tr.pattern {
            Pattern::Steps(p) => match parse_steps(p) {
                Err(e) => errors.push(format!("{at}.pattern.steps: {e}")),
                Ok((steps, n_steps)) => {
                    // Map each step's sound to a piece of this track's source.
                    let named = src.pieces.iter().any(|p| p.name.is_some());
                    let mut which = Vec::with_capacity(steps.len());
                    let mut bad = None;
                    for st in &steps {
                        let w = match (&st.sound, single, named) {
                            (None, ..) => Ok(None),
                            (Some(Sound::This), true, _) => Ok(Some(0)),
                            (Some(Sound::This), false, _) => Err(format!("`x` plays the track's own sound, but this track is the whole kit `{}`; name the {} to play", tr.clip, if named { "pad" } else { "pad number" })),
                            (Some(Sound::Index(n)), false, false) if *n <= src.pieces.len() => Ok(Some(n - 1)),
                            (Some(Sound::Index(n)), false, false) => Err(format!("uses pad {n}, but kit `{}` has {} pads", tr.clip, src.pieces.len())),
                            (Some(Sound::Index(n)), false, true) => Err(format!("`{n}`: kit `{}` has named pads; call them by name ({})", tr.clip, src.pieces.iter().filter_map(|p| p.name.clone()).collect::<Vec<_>>().join(", "))),
                            (Some(Sound::Name(nm)), false, true) => match src.pieces.iter().position(|p| p.name.as_deref() == Some(nm)) {
                                Some(k) => Ok(Some(k)),
                                None => {
                                    let names: Vec<String> = src.pieces.iter().filter_map(|p| p.name.clone()).collect();
                                    Err(format!("kit `{}` has no pad `{nm}`{}", tr.clip, did_you_mean(nm, names.iter())))
                                }
                            },
                            (Some(Sound::Name(nm)), false, false) => Err(format!("`{nm}`: kit `{}` is sliced; its pads are numbered 1–{}", tr.clip, src.pieces.len())),
                            (Some(Sound::Index(n)), true, _) => Err(format!("`{n}` picks a pad, but `{}` is a single sound; use x (e.g. \"x . x .\"), or slice it into a kit", tr.clip)),
                            (Some(Sound::Name(nm)), true, _) => Err(format!("`{nm}` names a pad, but `{}` is a single sound; use x (e.g. \"x . x .\")", tr.clip)),
                        };
                        match w {
                            Ok(w) => which.push(w),
                            Err(e) => {
                                bad = Some(e);
                                break;
                            }
                        }
                    }
                    if let Some(e) = bad {
                        errors.push(format!("{at}.pattern.steps: {e}"));
                    } else {
                        let step_beats = 4.0 / grid.max(1) as f64;
                        let swing = (tr.swing.unwrap_or(50.0) - 50.0) / 50.0 * step_beats;
                        let plen = n_steps * step_beats;
                        let mut rep = s0;
                        while rep < s1 - 1e-9 {
                            for (st, w) in steps.iter().zip(&which) {
                                let Some(k) = *w else { continue };
                                let start = rep + st.at * step_beats + if st.offbeat { swing } else { 0.0 };
                                if start < s1 - 1e-9 {
                                    push(start, st.len * step_beats, k);
                                }
                            }
                            rep += plen;
                        }
                    }
                }
            },
            Pattern::Loop if single => {
                let len = piece_len(&src.pieces[0]);
                let mut p = s0;
                while p < s1 - 1e-9 {
                    push(p, len, 0);
                    p += len;
                }
            }
            Pattern::Every(d) if single => match parse_duration(d, meter) {
                Ok(step) => {
                    let mut p = s0;
                    while p < s1 - 1e-9 {
                        push(p, step, 0);
                        p += step;
                    }
                }
                Err(e) => errors.push(format!("{at}.pattern.every: {e}")),
            },
            Pattern::At(list) if single => {
                for (j, pos) in list.iter().enumerate() {
                    match position(pos, meter, score.tempo) {
                        Ok(p) if p >= s0 && p < s1 => push(p, f64::INFINITY, 0),
                        Ok(_) => errors.push(format!("{at}.pattern.at[{j}]: {pos:?} is outside the bars this track plays")),
                        Err(e) => errors.push(format!("{at}.pattern.at[{j}]: {e}")),
                    }
                }
            }
            _ => {} // a whole kit without steps: reported above
        }
        // Gate and stutter apply to whatever the pattern produced.
        let gate = tr.gate.unwrap_or(1.0).clamp(0.0, 1.0);
        let stutter = tr.stutter.unwrap_or(1).clamp(1, 64);
        if gate < 1.0 || stutter > 1 {
            let made: Vec<Hit> = hits.drain(first_hit..).collect();
            for h in made {
                let part = h.dur / stutter as f64;
                for k in 0..stutter {
                    if part * gate > 1e-6 {
                        hits.push(Hit { track: h.track, start: h.start + part * k as f64, dur: part * gate, piece: h.piece, clip_from: h.clip_from });
                    }
                }
            }
        }
        srcs.push(Some(src));
    }

    let buses = route(score, &mut errors);
    let master = score.master.clone().unwrap_or_default();
    check_effects("master", &master.effects, &mut errors);
    for (i, e) in master.effects.iter().enumerate() {
        match e {
            Effect::Reverb(_) | Effect::Delay(_) | Effect::Drive(_) | Effect::Lofi(_) | Effect::NoiseGate(_) => {
                errors.push(format!("master.effects[{i}]: {} doesn't go on the master (it plays live); put it on a return track and send tracks to it", e.name()))
            }
            Effect::Comp(c) if c.sidechain.is_some() => errors.push(format!(
                "master.effects[{i}]: the master can't duck (it plays live); put the music in a group track (group music) and put the sidechain comp there"
            )),
            _ => {}
        }
    }
    if let Some(l) = master.loudness {
        if !(-40.0..=-5.0).contains(&l) {
            errors.push(format!("master.loudness: {l} LUFS is outside -40 to -5 (streaming services aim for about -14)"));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let key = key.unwrap();

    // ---- per-track region info (kits: pitch profile summed over their pieces; level per piece)
    let mut infos = Vec::new();
    let mut voices_base = Vec::new();
    let mut piece_levels: Vec<Vec<f64>> = Vec::new();
    let mut warned_irregular: Vec<String> = Vec::new();
    let level_of = |p: &Piece| clips[&p.clip].clip.loudness((p.from, p.to)).map_or(0.0, |l| ((TARGET_DBFS - l) * 10.0).round() / 10.0).clamp(-24.0, 30.0);
    for (ti, tr) in score.tracks.iter().enumerate() {
        let src = srcs[ti].as_ref().expect("resolved when there are no errors");
        let first = &src.pieces[0];
        let rc = &clips[&first.clip];
        let mut pcp = [0.0; 12];
        for p in &src.pieces {
            for (o, v) in pcp.iter_mut().zip(clips[&p.clip].clip.pcp((p.from, p.to))) {
                *o += v;
            }
        }
        let region_key = rank_keys(&pcp).first().map(|k| k.0);
        let unwarped = rc.mode == WarpModeSpec::Repitch;
        let stretch = rc.clip.manifest.rhythm.bpm.filter(|_| !unwarped).map(|b| (b / rc.ratio / score.tempo * 1000.0).round() / 1000.0);
        if let Some(s) = stretch {
            if !(0.5..=2.0).contains(&s) {
                warnings.push(format!("{}: source is {:.0} BPM (beat_ratio {}) vs score {:.0}; stretching {s:.2}× will sound strained", rc.name, rc.clip.manifest.rhythm.bpm.unwrap(), rc.ratio, score.tempo));
            }
        }
        for p in &src.pieces {
            let prc = &clips[&p.clip];
            let irregular = prc.clip.beat_irregularity((p.from, p.to));
            if prc.mode != WarpModeSpec::Repitch && irregular > 0.1 && p.to - p.from > 2.0 * prc.ratio && !warned_irregular.contains(&prc.name) {
                warned_irregular.push(prc.name.clone());
                warnings.push(format!("{}: its beats are uneven here (intervals vary {:.0}%), so it won't lock to the grid. Free-time playing or a compound meter (6/8) read in twos are the usual causes; try beat_ratio: 3 or 1.5, or another region.", prc.name, irregular * 100.0));
            }
        }
        let levels: Vec<f64> = src.pieces.iter().map(level_of).collect();
        for (p, lvl) in src.pieces.iter().zip(&levels) {
            if *lvl > 24.0 {
                let what = p.name.as_ref().map_or_else(|| tr.clip.clone(), |n| format!("{}.{n}", tr.clip));
                warnings.push(format!("{what}: its region is nearly silent (level matching needs {lvl:+.0} dB); check the region or slice, it may have missed the sound"));
            }
        }
        infos.push(TrackInfo {
            name: tr.name.clone().unwrap_or_else(|| tr.clip.clone()),
            clip: tr.clip.clone(),
            region_key: match (rc.root, src.kit.is_some()) {
                (Some(r), false) => format!("{r} (pinned)"),
                _ => region_key.map_or("?".into(), |k| k.to_string()),
            },
            region_beats: (first.from, first.to),
            beat_ratio: rc.ratio * tr.speed.unwrap_or(1.0),
            stretch,
            retune_cents: -rc.clip.manifest.tonal.tuning_cents,
            level_db: levels[0],
            chops: src.kit.as_ref().map(|_| src.pieces.len()),
            kit: src.kit.clone(),
            pieces: src
                .pieces
                .iter()
                .map(|p| {
                    let prc = &clips[&p.clip];
                    PieceInfo { source: prc.source, src_start: prc.clip.seconds_at(p.from), src_end: prc.clip.seconds_at(p.to), name: p.name.clone() }
                })
                .collect(),
            effects: tr.effects.clone(),
            pan: tr.pan.unwrap_or(0.0) / 100.0,
            out: tr.group.clone().unwrap_or_else(master_name),
            sends: tr.sends.clone(),
            varispeed: unwarped.then(|| score.tempo / rc.clip.manifest.rhythm.bpm.unwrap_or(score.tempo) * tr.speed.unwrap_or(1.0)),
            voice: None,
        });
        piece_levels.push(levels);
        let mut v = Voice::new(infos.last().unwrap().name.clone(), pcp);
        v.tonic = if src.kit.is_none() { rc.root } else { None }.or(region_key.map(|k| k.tonic));
        v.role = tr.role;
        if !unwarped {
            infos.last_mut().unwrap().voice = Some(crate::assist::VoiceInfo { name: v.name.clone(), pcp, tonic: v.tonic, role: tr.role, transpose: tr.transpose.clone() });
        }
        v.fixed = match tr.transpose {
            Transpose::Auto | Transpose::Follow => None,
            Transpose::Fixed(n) => Some(n),
        };
        voices_base.push(v);
    }

    // ---- harmony per chord span
    let mut shifts: Vec<Vec<i32>> = vec![vec![0; score.tracks.len()]; spans.len()];
    let mut harmony = Vec::new();
    let mut previous: Vec<Option<i32>> = vec![None; score.tracks.len()];
    let mut clashes: Vec<Vec<(u32, f64)>> = vec![Vec::new(); score.tracks.len()];
    for (si, (a, b, chord, label)) in spans.iter().enumerate() {
        // Unwarped tracks play as recorded: they sit out of the harmony (their shift stays 0).
        let active: Vec<usize> = (0..score.tracks.len())
            .filter(|&ti| infos[ti].varispeed.is_none() && hits.iter().any(|h| h.track == ti && h.start < *b && h.start + h.dur > *a))
            .collect();
        let fit = match chord {
            Some(ch) if !active.is_empty() => {
                let voices: Vec<Voice> = active
                    .iter()
                    .map(|&ti| {
                        let base = &voices_base[ti];
                        // `follow`: the smallest move that puts the clip's root on the chord root.
                        let fixed = match (&score.tracks[ti].transpose, base.tonic) {
                            (Transpose::Follow, Some(t)) => Some(t.signed_interval_to(ch.root)),
                            _ => base.fixed,
                        };
                        Voice { previous: previous[ti], fixed, ..base.clone() }
                    })
                    .collect();
                let fit = solve(&voices, ch, key, &Weights::default());
                for (vi, &ti) in active.iter().enumerate() {
                    let vf = &fit.voices[vi];
                    shifts[si][ti] = vf.semitones;
                    previous[ti] = Some(vf.semitones);
                    if vf.off_key > 0.25 && !matches!(score.tracks[ti].transpose, Transpose::Fixed(_)) {
                        clashes[ti].push(((a / meter as f64) as u32 + 1, vf.off_key));
                    }
                }
                Some(fit)
            }
            _ => {
                for &ti in &active {
                    shifts[si][ti] = voices_base[ti].fixed.unwrap_or(0);
                }
                None
            }
        };
        harmony.push(ChordSpan { start_beat: *a, end_beat: *b, label: chord.as_ref().map_or(label.clone(), |c| format!("{label} ({})", c.name())), fit });
    }

    for (ti, c) in clashes.iter().enumerate().filter(|(_, c)| !c.is_empty()) {
        let bars: Vec<String> = c.iter().map(|(b, _)| b.to_string()).collect();
        let (lo, hi) = c.iter().fold((1.0f64, 0.0f64), |(lo, hi), &(_, x)| (lo.min(x), hi.max(x)));
        let pct = if (hi - lo) < 0.02 { format!("{:.0}%", hi * 100.0) } else { format!("{:.0}–{:.0}%", lo * 100.0, hi * 100.0) };
        warnings.push(format!(
            "{}: {pct} of its sound falls outside {key} (bar{} {}). Its material is in {}; transposing moves every note together, so it can't change which notes clash. Try another region, or give it a smaller role.",
            infos[ti].name, if c.len() == 1 { "" } else { "s" }, bars.join(", "), infos[ti].region_key
        ));
    }

    // ---- events: split hits at chord boundaries, attach warp maps
    let mut events = Vec::new();
    for h in &hits {
        let tr = &score.tracks[h.track];
        let piece = &srcs[h.track].as_ref().unwrap().pieces[h.piece];
        let rc = &clips[&piece.clip];
        let ratio = rc.ratio * tr.speed.unwrap_or(1.0);
        let unwarped = rc.mode == WarpModeSpec::Repitch;
        // Unwarped hits don't follow the chords, so they stay whole (no seams at chord changes).
        let whole = [(h.start, h.start + h.dur, None, String::new())];
        let parts = if unwarped { &whole[..] } else { &spans[..] };
        for (si, (a, b, ..)) in parts.iter().enumerate() {
            let s = h.start.max(*a);
            let e = (h.start + h.dur).min(*b);
            if e - s < 1e-6 {
                continue;
            }
            // Clip beats for this piece, then one warp point per clip beat (in score beats from the event start).
            let cb0 = h.clip_from + (s - h.start) * ratio;
            let cb1 = cb0 + (e - s) * ratio;
            let mut warp = vec![(rc.clip.seconds_at(cb0), 0.0)];
            let mut bt = cb0.floor() + 1.0;
            while bt < cb1 - 1e-6 {
                warp.push((rc.clip.seconds_at(bt), (bt - cb0) / ratio));
                bt += 1.0;
            }
            warp.push((rc.clip.seconds_at(cb1), (cb1 - cb0) / ratio));
            events.push(Event {
                track: infos[h.track].name.clone(),
                source: rc.source,
                start_beat: s,
                dur_beats: e - s,
                src_start: warp[0].0,
                src_end: warp[warp.len() - 1].0,
                warp,
                semitones: if unwarped { 0 } else { shifts[si][h.track] },
                tuning_cents: if unwarped { 0.0 } else { -rc.clip.manifest.tonal.tuning_cents },
                gain_db: tr.volume + piece_levels[h.track][h.piece],
                mode: rc.mode,
                reverse: tr.reverse,
                filter: tr.filter,
                piece: h.piece,
            });
        }
    }
    events.sort_by(|a, b| a.start_beat.total_cmp(&b.start_beat).then(a.track.cmp(&b.track)));

    let master = MasterSpec { loudness: Some(master.loudness.unwrap_or(DEFAULT_LOUDNESS)), ..master };
    Ok(Timeline { tempo: score.tempo, meter, key: key.to_string(), length_beats: length, sources, events, harmony, tracks: infos, warnings, buses, master })
}

fn did_you_mean<'a>(word: &str, options: impl Iterator<Item = &'a String>) -> String {
    let best = options.map(|o| (levenshtein(word, o), o)).min();
    match best {
        Some((d, o)) if d <= 2.max(word.len() / 3) => format!(" (did you mean {o:?}?)"),
        _ => String::new(),
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
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

impl Timeline {
    /// Human-readable explanation of the harmony choices.
    /// The mix as written: where each track, group and return goes, and its chain (in `.apr` notation).
    pub fn explain_mix(&self) -> String {
        let fx = |effects: &[Effect], s: &mut String| {
            for e in effects {
                *s += &format!("      {}\n", crate::dsl::effect_text(e));
            }
        };
        let mut s = String::from("\nMix:\n");
        for t in &self.tracks {
            s += &format!("  track {:<14} → {:<8}", t.name, t.out);
            if t.pan != 0.0 {
                s += &format!("  pan {:+.0}", t.pan * 100.0);
            }
            if !t.sends.is_empty() {
                s += &format!("  send {}", t.sends.iter().map(|(b, l)| format!("{b} {:.0}%", l * 100.0)).collect::<Vec<_>>().join(", "));
            }
            s += "\n";
            fx(&t.effects, &mut s);
        }
        for b in &self.buses {
            s += &format!("  {:<6}{:<14} → {:<8}", b.kind, b.name, b.out);
            if b.gain_db != 0.0 {
                s += &format!("  volume {:+} dB", b.gain_db);
            }
            s += "\n";
            fx(&b.effects, &mut s);
        }
        s += &format!("  master{:<16}   loudness {} LUFS, then a limiter (−1 dB unless one is given)\n", "", self.master.loudness.unwrap_or(DEFAULT_LOUDNESS));
        fx(&self.master.effects, &mut s);
        s
    }

    pub fn explain(&self) -> String {
        let mut s = String::new();
        let bar = |b: f64| b / self.meter as f64 + 1.0;
        s += &format!("{} BPM, {}/4, key {}, {} bars\n\nClips:\n", self.tempo, self.meter, self.key, self.length_beats / self.meter as f64);
        for t in &self.tracks {
            if let Some(v) = t.varispeed {
                s += &format!("  {:<14} {:<10} seconds {:>6.1}–{:<6.1} re-pitched, plays as recorded at {v}× (not in the harmony)  level {:+.1} dB\n", t.name, t.clip, t.region_beats.0 * 60.0 * v / (self.tempo * t.beat_ratio), t.region_beats.1 * 60.0 * v / (self.tempo * t.beat_ratio), t.level_db);
                continue;
            }
            s += &format!("  {:<14} {:<10} clip beats {:>6.1}–{:<6.1} (×{}) sounds in {:<5} stretch {:<7} retune {:+.0}¢  level {:+.1} dB\n", t.name, t.clip, t.region_beats.0, t.region_beats.1, t.beat_ratio, t.region_key,
                t.stretch.map_or("?".into(), |x| format!("{x:.3}×")), t.retune_cents, t.level_db);
        }
        s += "\nHarmony:\n";
        for span in &self.harmony {
            s += &format!("  bars {:>4}–{:<4} {}\n", bar(span.start_beat), bar(span.end_beat) - 1.0, if span.label.is_empty() { "(no chord)" } else { &span.label });
            if let Some(f) = &span.fit {
                let tones: Vec<_> = f.chord_tones.iter().map(|p: &PitchClass| p.name()).collect();
                s += &format!("      tones {}   coverage {:.0}%\n", tones.join(" "), f.coverage * 100.0);
                for v in &f.voices {
                    let alts: Vec<String> = v.runners_up.iter().map(|(k, d)| format!("{k:+} ({d:+.2})")).collect();
                    s += &format!("      {:<14} {:+3} st  tonic→{:<3} on-chord {:>3.0}%  off-key {:>3.0}%   next best: {}\n",
                        v.name, v.semitones, v.tonic_lands_on.map_or("?", |p| p.name()), v.on_chord * 100.0, v.off_key * 100.0, alts.join(", "));
                }
            }
        }
        s += &self.explain_mix();
        if !self.warnings.is_empty() {
            s += "\nWarnings:\n";
            for w in &self.warnings {
                s += &format!("  ! {w}\n");
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beat_ratio_folds_double_and_half_time() {
        assert_eq!(auto_beat_ratio(Some(230.8), 120.0), 2.0);
        assert_eq!(auto_beat_ratio(Some(120.0), 120.0), 1.0);
        assert_eq!(auto_beat_ratio(Some(62.0), 120.0), 0.5);
        assert_eq!(auto_beat_ratio(Some(162.0), 120.0), 1.0);
        assert_eq!(auto_beat_ratio(None, 120.0), 1.0);
    }

    #[test]
    fn suggestions() {
        let opts = ["cotton".to_string(), "cadets".to_string()];
        assert_eq!(did_you_mean("cotten", opts.iter()), " (did you mean \"cotton\"?)");
        assert_eq!(did_you_mean("zzzzzz", opts.iter()), "");
    }
}
