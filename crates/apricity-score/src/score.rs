//! The score format (YAML or JSON). Unknown fields are errors, so typos can't be silently ignored.

use apricity_theory::Role;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Score {
    /// Format version; must be 0.1.
    pub apricity: f64,
    pub tempo: f64,
    /// Beats per bar.
    #[serde(default = "four")]
    pub meter: u32,
    /// Home key, e.g. "Abm". Roman numerals in the progression are relative to it.
    pub key: String,
    /// Folder that clip `source` paths are relative to (itself relative to the score file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub samples: Option<String>,
    pub clips: BTreeMap<String, ClipSpec>,
    /// Kits: a clip chopped into numbered pieces (`k.1`, `k.2`, …), like a sampler's pads.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub kits: BTreeMap<String, KitSpec>,
    #[serde(default)]
    pub progression: Vec<ChordSpec>,
    /// Length in bars when there is no progression (otherwise the progression sets it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bars: Option<u32>,
    pub tracks: Vec<TrackSpec>,
    /// Buses: shared effect returns (a reverb tracks send to) and groups (tracks routed with `out`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub buses: BTreeMap<String, BusSpec>,
    /// The master bus: its effects (in order) and the loudness target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master: Option<MasterSpec>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct MasterSpec {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// Integrated loudness target in LUFS (default −16).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loudness: Option<f64>,
}

/// A bus: sends and grouped tracks sum into it, run through its effects, and go to `out`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct BusSpec {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// The bus's fader, dB.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub gain: f64,
    /// Where it goes: another bus, or the master (the default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
}

fn is_zero(x: &f64) -> bool {
    *x == 0.0
}

/// One effect in a chain. Written in YAML as a single-key map: `{eq: {...}}`, `{comp: {...}}`.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Eq(EqSpec),
    Comp(CompSpec),
    Limit(LimitSpec),
    Reverb(ReverbSpec),
    Delay(DelaySpec),
    Drive(DriveSpec),
    Lofi(LofiSpec),
    NoiseGate(GateSpec),
    /// Stereo width, 0 (mono) … 2 (twice as wide); 1 = unchanged.
    Width(f64),
}

impl Effect {
    pub fn name(&self) -> &'static str {
        match self {
            Effect::Eq(_) => "eq",
            Effect::Comp(_) => "comp",
            Effect::Limit(_) => "limit",
            Effect::Reverb(_) => "reverb",
            Effect::Delay(_) => "delay",
            Effect::Drive(_) => "drive",
            Effect::Lofi(_) => "lofi",
            Effect::NoiseGate(_) => "noisegate",
            Effect::Width(_) => "width",
        }
    }
}

/// Saturation: `db` of gain into a soft clipper (level is matched afterwards).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct DriveSpec {
    pub db: f64,
    /// Low-pass after the saturator, Hz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<f64>,
}

/// Sampler character: bit depth, sample-and-hold rate, and wow.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct LofiSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits: Option<f64>,
    /// Hz.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    /// 0–1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wow: Option<f64>,
}

/// Noise gate: silence below `threshold` dB.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct GateSpec {
    pub threshold: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attack_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_ms: Option<f64>,
    /// How far a closed gate turns down, dB (default −80).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReverbType {
    Room,
    #[default]
    Hall,
    Plate,
}

/// Algorithmic reverb. Unset values come from the type (room 0.8 s, hall 2.4 s, plate 1.6 s).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReverbSpec {
    #[serde(default, rename = "type")]
    pub kind: ReverbType,
    /// Seconds to fall 60 dB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decay_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predelay_ms: Option<f64>,
    /// High-frequency damping, 0–1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub damp: Option<f64>,
    /// Wet share, 0–1 (default: 1 on a bus, 0.25 as a track insert).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix: Option<f64>,
}

/// Echoes. The time is musical (`beats`: 0.75 = a dotted eighth in 4/4) or absolute (`ms`).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct DelaySpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<f64>,
    /// Each repeat's level relative to the one before, 0–0.95 (default 0.35).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<f64>,
    /// Filters in the feedback loop, Hz: each repeat gets thinner / darker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highpass: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lowpass: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pingpong: bool,
    /// Wet share, 0–1 (default: 1 on a bus, 0.25 as a track insert).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct EqSpec {
    /// High-pass (Hz).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lowcut: Option<f64>,
    /// Low-pass (Hz).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highcut: Option<f64>,
    /// Low shelf: [dB, Hz].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low: Option<[f64; 2]>,
    /// High shelf: [dB, Hz].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high: Option<[f64; 2]>,
    /// Bell bands: [dB, Hz, Q].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub peaks: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompSpec {
    pub ratio: f64,
    /// dB.
    pub threshold: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attack_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_ms: Option<f64>,
    /// dB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knee: Option<f64>,
    /// dB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub makeup: Option<f64>,
    /// Key the compressor from another track (ducking): it listens to that track, not its input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidechain: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct LimitSpec {
    /// dB (≤ 0).
    pub ceiling: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_ms: Option<f64>,
}

impl serde::Serialize for Effect {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(1))?;
        match self {
            Effect::Eq(e) => m.serialize_entry("eq", e)?,
            Effect::Comp(c) => m.serialize_entry("comp", c)?,
            Effect::Limit(l) => m.serialize_entry("limit", l)?,
            Effect::Reverb(r) => m.serialize_entry("reverb", r)?,
            Effect::Delay(d) => m.serialize_entry("delay", d)?,
            Effect::Drive(d) => m.serialize_entry("drive", d)?,
            Effect::Lofi(l) => m.serialize_entry("lofi", l)?,
            Effect::NoiseGate(g) => m.serialize_entry("noisegate", g)?,
            Effect::Width(w) => m.serialize_entry("width", w)?,
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for Effect {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            #[serde(default)]
            eq: Option<EqSpec>,
            #[serde(default)]
            comp: Option<CompSpec>,
            #[serde(default)]
            limit: Option<LimitSpec>,
            #[serde(default)]
            reverb: Option<ReverbSpec>,
            #[serde(default)]
            delay: Option<DelaySpec>,
            #[serde(default)]
            drive: Option<DriveSpec>,
            #[serde(default)]
            lofi: Option<LofiSpec>,
            #[serde(default)]
            noisegate: Option<GateSpec>,
            #[serde(default)]
            width: Option<f64>,
        }
        const KINDS: &str = "{eq: …}, {comp: …}, {limit: …}, {reverb: …}, {delay: …}, {drive: …}, {lofi: …}, {noisegate: …} or {width: 1.5}";
        let raw = Raw::deserialize(d).map_err(|e| serde::de::Error::custom(format!("an effect is {KINDS} ({e})")))?;
        let mut found: Vec<Effect> = Vec::new();
        found.extend(raw.eq.map(Effect::Eq));
        found.extend(raw.comp.map(Effect::Comp));
        found.extend(raw.limit.map(Effect::Limit));
        found.extend(raw.reverb.map(Effect::Reverb));
        found.extend(raw.delay.map(Effect::Delay));
        found.extend(raw.drive.map(Effect::Drive));
        found.extend(raw.lofi.map(Effect::Lofi));
        found.extend(raw.noisegate.map(Effect::NoiseGate));
        found.extend(raw.width.map(Effect::Width));
        match found.len() {
            1 => Ok(found.pop().unwrap()),
            _ => Err(serde::de::Error::custom(format!("each effect is one of {KINDS}; put several in the list, one per item"))),
        }
    }
}

fn four() -> u32 {
    4
}

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClipSpec {
    pub source: String,
    /// Region in the clip's own beats (0 = its first downbeat): [from, to).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<[f64; 2]>,
    /// Region in source seconds: [from, to).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<[f64; 2]>,
    /// A named slice from the clip's manifest annotations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slice: Option<String>,
    /// Let the compiler choose the region: the stretch of this length (e.g. "2bars"), starting on
    /// a bar line, that best fits the progression's chords.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<String>,
    #[serde(default)]
    pub warp: WarpModeSpec,
    /// Varispeed for an unwarped clip (`warp: off`): 1.5 plays it 1.5× as fast and a fifth higher,
    /// like a turntable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// The pitch this region is built on (e.g. "C" for a riff on the dominant). Defaults to the
    /// tonic detected from the region's chroma. Used by `role` and `transpose: follow`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// How many of the clip's detected beats make one score beat. Beat trackers often lock onto
    /// double or half time; by default the compiler picks ½, 1 or 2, whichever needs the least stretch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beat_ratio: Option<f64>,
}

/// A kit is either one clip chopped into numbered pieces (`clip` + `chop`), or named pads
/// gathered from anywhere (`pads`), like a drum machine's kick, snare and hats.
#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct KitSpec {
    /// The clip to chop (its region: beats / seconds / slice / pick).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chop: Option<Chop>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pads: BTreeMap<String, PadSpec>,
}

impl KitSpec {
    pub fn chopped(clip: impl Into<String>, chop: Chop) -> Self {
        Self { clip: Some(clip.into()), chop: Some(chop), pads: BTreeMap::new() }
    }
}

/// One pad of a drum kit: a clip (or a chop like `k.3`) and optionally a region of it.
#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PadSpec {
    pub clip: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<[f64; 2]>,
}

/// How a kit's clip is cut into chops.
#[derive(Debug, Clone, PartialEq)]
pub enum Chop {
    /// Every n score beats.
    Beats(f64),
    /// Every n bars.
    Bars(f64),
    /// Into n equal pieces.
    Into(u32),
    /// At the clip's marked hits (automatic markup or your own markers named "hit").
    Hits,
    /// At the clip's spoken phrases (slices named phrase-1, phrase-2, … from automatic markup).
    Phrases,
}

impl serde::Serialize for Chop {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Chop::Hits => return s.serialize_str("hits"),
            Chop::Phrases => return s.serialize_str("phrases"),
            _ => {}
        }
        let mut m = s.serialize_map(Some(1))?;
        match self {
            Chop::Hits | Chop::Phrases => unreachable!(),
            Chop::Beats(n) => m.serialize_entry("beats", n)?,
            Chop::Bars(n) => m.serialize_entry("bars", n)?,
            // A whole number, so it reads back as one (`into: 8`, not `8.0`).
            Chop::Into(n) => m.serialize_entry("into", n)?,
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for Chop {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            #[serde(default)]
            beats: Option<f64>,
            #[serde(default)]
            bars: Option<f64>,
            #[serde(default)]
            into: Option<u32>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Any {
            Text(String),
            Map(Raw),
        }
        let bad = || serde::de::Error::custom("chop must be {beats: 1}, {bars: 2}, {into: 8}, \"hits\" or \"phrases\"");
        match Any::deserialize(d).map_err(|_| bad())? {
            Any::Text(t) if t == "hits" => Ok(Chop::Hits),
            Any::Text(t) if t == "phrases" => Ok(Chop::Phrases),
            Any::Text(_) => Err(bad()),
            Any::Map(Raw { beats: Some(n), bars: None, into: None }) => Ok(Chop::Beats(n)),
            Any::Map(Raw { beats: None, bars: Some(n), into: None }) => Ok(Chop::Bars(n)),
            Any::Map(Raw { beats: None, bars: None, into: Some(n) }) => Ok(Chop::Into(n)),
            Any::Map(_) => Err(bad()),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WarpModeSpec {
    Beats,
    #[default]
    Complex,
    Texture,
    /// Not warped: plays as recorded (at its `speed`), on the grid but not stretched to it.
    Off,
}

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChordSpec {
    /// Roman numeral relative to the key (iv, V7, bVI, V/V) or a chord symbol (Dbm, Eb7).
    pub chord: String,
    pub bars: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrackSpec {
    pub clip: String,
    /// Optional display name (defaults to the clip name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Role,
    /// "auto" (solver decides per chord) or a fixed number of semitones.
    #[serde(default)]
    pub transpose: Transpose,
    #[serde(default)]
    pub pattern: Pattern,
    /// Bars the track plays, 1-based inclusive: "1-8", "5" (or 5), or omitted for the whole piece.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "opt_text_or_number")]
    pub bars: Option<String>,
    /// Gain in dB.
    #[serde(default)]
    pub gain: f64,
    /// Step size for `steps` patterns as a note value: 16 = sixteenth notes (default), 8, 4…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<u32>,
    /// Swing in percent: 50 is straight; 56–62 is the classic sampler range; up to 75.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swing: Option<f64>,
    /// Play each hit backwards.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reverse: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterSpec>,
    /// Shorten each hit to this fraction of its length (0–1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<f64>,
    /// Retrigger the start of each hit this many times within it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stutter: Option<u32>,
    /// Playback speed against the beat: 0.5 = half-time, 2 = double-time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// Insert effects on the track, applied in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// Stereo placement: −100 (left) … 100 (right).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    /// Route the track into a bus (a group) instead of the master.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    /// Post-fader sends: bus → level (0–1, linear; 0.25 ≈ −12 dB).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sends: BTreeMap<String, f64>,
}

/// A simple filter on a track: `{lowpass: 800}` or `{highpass: 200}` (Hz).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FilterSpec {
    Lowpass(f64),
    Highpass(f64),
}

impl serde::Serialize for FilterSpec {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (k, v) = match self {
            FilterSpec::Lowpass(h) => ("lowpass", h),
            FilterSpec::Highpass(h) => ("highpass", h),
        };
        let mut m = s.serialize_map(Some(1))?;
        m.serialize_entry(k, v)?;
        m.end()
    }
}

impl<'de> Deserialize<'de> for FilterSpec {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            #[serde(default)]
            lowpass: Option<f64>,
            #[serde(default)]
            highpass: Option<f64>,
        }
        let bad = || serde::de::Error::custom("filter must be {lowpass: <Hz>} or {highpass: <Hz>}");
        match Raw::deserialize(d).map_err(|_| bad())? {
            Raw { lowpass: Some(h), highpass: None } => Ok(FilterSpec::Lowpass(h)),
            Raw { lowpass: None, highpass: Some(h) } => Ok(FilterSpec::Highpass(h)),
            _ => Err(bad()),
        }
    }
}

/// A value written as text or as a number (`bars: 5`, `at: [3, "7:2"]`), kept as text.
#[derive(Deserialize)]
#[serde(untagged)]
enum TextOrNumber {
    Text(String),
    Int(i64),
    Float(f64),
}

impl TextOrNumber {
    fn text(self) -> String {
        match self {
            TextOrNumber::Text(s) => s,
            TextOrNumber::Int(n) => n.to_string(),
            TextOrNumber::Float(x) => x.to_string(),
        }
    }
}

fn opt_text_or_number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Option::<TextOrNumber>::deserialize(d)?.map(TextOrNumber::text))
}

#[derive(Debug, Clone, Default, PartialEq)]
pub enum Transpose {
    /// The harmony solver picks a shift per chord.
    #[default]
    Auto,
    /// A fixed number of semitones, whatever the chord.
    Fixed(i32),
    /// Move with the chord root (smallest move that puts the clip's root on it): the way a blues
    /// riff or a bass pattern is played in parallel on I, IV and V.
    Follow,
}

impl serde::Serialize for Transpose {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Transpose::Auto => s.serialize_str("auto"),
            Transpose::Follow => s.serialize_str("follow"),
            Transpose::Fixed(n) => s.serialize_i32(*n),
        }
    }
}

impl<'de> Deserialize<'de> for Transpose {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Num(i32),
            Text(String),
        }
        match Raw::deserialize(d)? {
            Raw::Num(n) => Ok(Transpose::Fixed(n)),
            Raw::Text(s) if s == "auto" => Ok(Transpose::Auto),
            Raw::Text(s) if s == "follow" => Ok(Transpose::Follow),
            Raw::Text(s) => Err(serde::de::Error::custom(format!("transpose must be \"auto\", \"follow\" or a whole number of semitones, not {s:?}"))),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub enum Pattern {
    /// Repeat the region back to back.
    #[default]
    Loop,
    /// Retrigger the region every duration ("1bar", "2beats", "0.5bar"); each hit plays at most that long.
    Every(String),
    /// Trigger at positions "bar:beat" (1-based), e.g. "3:1".
    At(Vec<String>),
    /// A step sequence over a kit: "1 . 3 . [5 5] . 7 _" (numbers are chops; `.` rest; `_` hold).
    Steps(String),
}

impl serde::Serialize for Pattern {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Pattern::Loop => s.serialize_str("loop"),
            Pattern::Every(d) => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("every", d)?;
                m.end()
            }
            Pattern::At(v) => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("at", v)?;
                m.end()
            }
            Pattern::Steps(v) => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("steps", v)?;
                m.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Pattern {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Every {
            every: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct At {
            at: Vec<TextOrNumber>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Steps {
            steps: String,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Text(String),
            Every(Every),
            At(At),
            Steps(Steps),
        }
        let raw = Raw::deserialize(d).map_err(|_| serde::de::Error::custom("pattern must be \"loop\", {every: 1bar}, {at: [3, \"7:2\"]} or {steps: \"1 . 3 .\"}"))?;
        match raw {
            Raw::Text(s) if s == "loop" => Ok(Pattern::Loop),
            Raw::Text(s) => Err(serde::de::Error::custom(format!("pattern must be \"loop\", {{every: 1bar}} or {{at: [\"1:1\"]}}, not {s:?}"))),
            Raw::Every(e) => Ok(Pattern::Every(e.every)),
            Raw::At(a) => Ok(Pattern::At(a.at.into_iter().map(TextOrNumber::text).collect())),
            Raw::Steps(st) => Ok(Pattern::Steps(st.steps)),
        }
    }
}

/// What a step triggers.
#[derive(Debug, Clone, PartialEq)]
pub enum Sound {
    /// Chop n of a chopped kit (1-based).
    Index(usize),
    /// A named pad of a drum kit.
    Name(String),
    /// `x`: the track's own sound (a clip, one chop, or one pad).
    This,
}

/// One trigger in a step pattern: when (in steps from the pattern start), how long (in steps),
/// and what it plays, or `None` for silence.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub at: f64,
    pub len: f64,
    pub sound: Option<Sound>,
    /// Whether this trigger falls on an odd whole step (the ones swing delays).
    pub offbeat: bool,
}

/// Parse a step pattern. Returns the triggers and the pattern's length in steps.
/// Grammar: tokens separated by spaces; `n` = chop n; a name = that pad; `x` = the track's own
/// sound; `.` or `~` = rest; `_` = hold the previous sound one more step; `[a b c]` = one step split
/// evenly; `|` is ignored (for reading).
pub fn parse_steps(src: &str) -> Result<(Vec<Step>, f64), String> {
    fn tokens(s: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = String::new();
        for c in s.chars() {
            match c {
                '[' | ']' => {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                    out.push(c.to_string());
                }
                c if c.is_whitespace() || c == '|' => {
                    if !cur.is_empty() {
                        out.push(std::mem::take(&mut cur));
                    }
                }
                c => cur.push(c),
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
        out
    }
    fn group(toks: &[String], i: &mut usize, at: f64, width: f64, whole: bool, out: &mut Vec<Step>) -> Result<(), String> {
        // Parse items until the matching ']' (or the end), laid out evenly over `width`.
        let start = *i;
        let mut items = Vec::new();
        let mut depth = 0;
        while *i < toks.len() {
            let t = &toks[*i];
            if t == "]" && depth == 0 {
                break;
            }
            if t == "]" {
                // Closes a nested group; the group was already counted at its '['.
                depth -= 1;
                *i += 1;
                continue;
            }
            if depth == 0 {
                items.push(*i);
            }
            if t == "[" {
                depth += 1;
            }
            *i += 1;
        }
        let _ = start;
        let n = items.len().max(1) as f64;
        for (k, &idx) in items.iter().enumerate() {
            let pos = at + width * k as f64 / n;
            let w = width / n;
            let t = &toks[idx];
            match t.as_str() {
                "[" => {
                    let mut j = idx + 1;
                    group(toks, &mut j, pos, w, false, out)?;
                    if toks.get(j).map(String::as_str) != Some("]") {
                        return Err("a `[` is never closed".into());
                    }
                }
                "." | "~" => out.push(Step { at: pos, len: w, sound: None, offbeat: whole && k % 2 == 1 }),
                "_" => match out.last_mut() {
                    Some(prev) => prev.len += w,
                    None => return Err("`_` holds the previous sound, but nothing has played yet".into()),
                },
                "x" | "X" => out.push(Step { at: pos, len: w, sound: Some(Sound::This), offbeat: whole && k % 2 == 1 }),
                n if n.chars().all(|c| c.is_ascii_digit()) => {
                    let chop: usize = n.parse().map_err(|_| format!("`{n}` is too big for a chop number"))?;
                    if chop == 0 {
                        return Err("chops are numbered from 1".into());
                    }
                    out.push(Step { at: pos, len: w, sound: Some(Sound::Index(chop)), offbeat: whole && k % 2 == 1 });
                }
                n if n.chars().next().is_some_and(|c| c.is_alphabetic()) && n.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') => {
                    out.push(Step { at: pos, len: w, sound: Some(Sound::Name(n.to_string())), offbeat: whole && k % 2 == 1 })
                }
                n => return Err(format!("`{n}` isn't a chop number, a pad name, `x`, `.`, `_` or `[ ]`")),
            }
        }
        Ok(())
    }
    let toks = tokens(src);
    if toks.is_empty() {
        return Err("the step pattern is empty".into());
    }
    // Top level: one item per step (a bracket group counts as one step).
    let mut out = Vec::new();
    let mut i = 0;
    let mut step = 0usize;
    while i < toks.len() {
        match toks[i].as_str() {
            "[" => {
                i += 1;
                let mut j = i;
                group(&toks, &mut j, step as f64, 1.0, false, &mut out)?;
                if toks.get(j).map(String::as_str) != Some("]") {
                    return Err("a `[` is never closed".into());
                }
                i = j + 1;
            }
            "]" => return Err("a `]` has no matching `[`".into()),
            _ => {
                let mut j = i;
                let single = [toks[i].clone()];
                group(&single, &mut 0, step as f64, 1.0, true, &mut out)?;
                // Mark offbeat by the step's position, not the item's index in its (1-item) group.
                if let Some(last) = out.last_mut() {
                    if (last.at - step as f64).abs() < 1e-9 {
                        last.offbeat = step % 2 == 1;
                    }
                }
                j += 1;
                i = j;
            }
        }
        step += 1;
    }
    Ok((out, step as f64))
}

/// A reference from a score to a clip or slice. Used to answer "which clips and slices does
/// this score use?" for dependency tracking and to pre-fetch manifests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ref {
    /// The clip name declared under `clips:` (e.g. "drums", "bass", "horns").
    pub alias: String,
    /// Source path exactly as written in the score: "marine-band/stems/Thunderer/drums.wav" or "@clp_abc123".
    pub source: String,
    /// Normalized path relative to `samples:` folder and base directory. None for "@clp_…" id forms.
    pub path: Option<std::path::PathBuf>,
    /// Slice name within the clip (optional).
    pub slice: Option<String>,
    /// When this reference is from a kit (chopped kit or pad kit), this is set:
    /// - For chopped kits: kit name (e.g. "b" for `kit b = chop brk by beats 0.5`)
    /// - For pad kits: qualified name (e.g. "drums.kick" for `kick = tdrums beats 62..62.5` in `kit drums`)
    pub kit_pad: Option<String>,
}

/// Parse a duration like "1bar", "2 bars", "3beats", "0.5bar" into beats.
pub fn parse_duration(s: &str, meter: u32) -> Result<f64, String> {
    let t = s.trim().to_ascii_lowercase();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let n: f64 = num.parse().map_err(|_| format!("{s:?}: expected a number then bar(s) or beat(s), e.g. \"1bar\""))?;
    let beats = match unit.trim() {
        "bar" | "bars" => n * meter as f64,
        "beat" | "beats" => n,
        u => return Err(format!("{s:?}: unknown unit {u:?} (use bar/bars or beat/beats)")),
    };
    if beats <= 0.0 {
        return Err(format!("{s:?}: must be longer than zero"));
    }
    Ok(beats)
}

/// Parse "bar:beat" (1-based) into a beat offset from the start of the piece.
pub fn parse_position(s: &str, meter: u32) -> Result<f64, String> {
    let (bar, beat) = s.split_once(':').unwrap_or((s, "1"));
    let bar: f64 = bar.trim().parse().map_err(|_| format!("{s:?}: expected \"bar:beat\", e.g. \"3:1\""))?;
    let beat: f64 = beat.trim().parse().map_err(|_| format!("{s:?}: expected \"bar:beat\", e.g. \"3:1\""))?;
    if bar < 1.0 || beat < 1.0 || beat >= meter as f64 + 1.0 {
        return Err(format!("{s:?}: bars start at 1 and beats run 1..={meter}"));
    }
    Ok((bar - 1.0) * meter as f64 + (beat - 1.0))
}

/// Parse "1-8" / "5" (1-based, inclusive) into a beat range.
pub fn parse_bars(s: &str, meter: u32) -> Result<(f64, f64), String> {
    let (a, b) = s.split_once('-').unwrap_or((s, s));
    let a: u32 = a.trim().parse().map_err(|_| format!("bars {s:?}: expected e.g. \"1-8\" or \"5\""))?;
    let b: u32 = b.trim().parse().map_err(|_| format!("bars {s:?}: expected e.g. \"1-8\" or \"5\""))?;
    if a < 1 || b < a {
        return Err(format!("bars {s:?}: bars start at 1 and the range must not run backwards"));
    }
    Ok(((a - 1) as f64 * meter as f64, b as f64 * meter as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_positions_bars() {
        assert_eq!(parse_duration("1bar", 4), Ok(4.0));
        assert_eq!(parse_duration("2 bars", 3), Ok(6.0));
        assert_eq!(parse_duration("0.5bar", 4), Ok(2.0));
        assert_eq!(parse_duration("3beats", 4), Ok(3.0));
        assert!(parse_duration("0bar", 4).is_err());
        assert!(parse_duration("1 measure", 4).is_err());
        assert_eq!(parse_position("3:1", 4), Ok(8.0));
        assert_eq!(parse_position("1:3", 4), Ok(2.0));
        assert!(parse_position("1:5", 4).is_err());
        assert!(parse_position("0:1", 4).is_err());
        assert_eq!(parse_bars("1-8", 4), Ok((0.0, 32.0)));
        assert_eq!(parse_bars("5", 4), Ok((16.0, 20.0)));
        assert!(parse_bars("8-1", 4).is_err());
    }

    #[test]
    fn step_patterns() {
        let (steps, len) = parse_steps("1 . 3 _ [5 6] ~ 7 _").unwrap();
        assert_eq!(len, 8.0);
        let got: Vec<(f64, f64, Option<Sound>, bool)> = steps.iter().map(|s| (s.at, s.len, s.sound.clone(), s.offbeat)).collect();
        let i = |n| Some(Sound::Index(n));
        assert_eq!(got, vec![
            (0.0, 1.0, i(1), false),
            (1.0, 1.0, None, true),
            (2.0, 2.0, i(3), false),
            (4.0, 0.5, i(5), false),
            (4.5, 0.5, i(6), false),
            (5.0, 1.0, None, true),
            (6.0, 2.0, i(7), false),
        ]);
        let named: Vec<Option<Sound>> = parse_steps("kick x . snare").unwrap().0.into_iter().map(|s| s.sound).collect();
        assert_eq!(named, vec![Some(Sound::Name("kick".into())), Some(Sound::This), None, Some(Sound::Name("snare".into()))]);
        assert_eq!(parse_steps("1 [2 [3 4]]").unwrap().0.iter().map(|s| (s.at, s.len)).collect::<Vec<_>>(), vec![(0.0, 1.0), (1.0, 0.5), (1.5, 0.25), (1.75, 0.25)]);
        assert!(parse_steps("_ 1").unwrap_err().contains("nothing has played"));
        assert!(parse_steps("1 [2").unwrap_err().contains("never closed"));
        assert!(parse_steps("1 ?").unwrap_err().contains("`?`"));
        assert!(parse_steps("0").unwrap_err().contains("from 1"));
    }

    #[test]
    fn kits_and_transforms_parse() {
        let y = "apricity: 0.1\ntempo: 90\nkey: C\nclips: {br: {source: x.wav}}\nkits: {k: {clip: br, chop: {beats: 1}}, h: {clip: br, chop: hits}}\nbars: 2\ntracks: [{clip: k, pattern: {steps: '1 . 3 .'}, swing: 58, reverse: true, filter: {lowpass: 800}, gate: 0.5, stutter: 2, speed: 0.5, grid: 8}]\n";
        let s: Score = serde_yaml::from_str(y).unwrap();
        assert_eq!(s.kits["k"].chop, Some(Chop::Beats(1.0)));
        assert_eq!(s.kits["h"].chop, Some(Chop::Hits));
        let t = &s.tracks[0];
        assert_eq!(t.pattern, Pattern::Steps("1 . 3 .".into()));
        assert_eq!((t.swing, t.reverse, t.filter, t.gate, t.stutter, t.speed, t.grid), (Some(58.0), true, Some(FilterSpec::Lowpass(800.0)), Some(0.5), Some(2), Some(0.5), Some(8)));
        let back: Score = serde_yaml::from_str(&serde_yaml::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        let bad = serde_yaml::from_str::<Score>(&y.replace("{beats: 1}", "{beats: 1, into: 2}")).unwrap_err().to_string();
        assert!(bad.contains("chop must be"), "{bad}");
    }

    #[test]
    fn effects_and_master_parse() {
        let y = "apricity: 0.1\ntempo: 90\nkey: C\nbars: 1\nclips: {a: {source: x.wav}}\ntracks: [{clip: a, pan: -20, effects: [{eq: {lowcut: 120, low: [-3, 250], peaks: [[-4, 800, 1.4]]}}, {comp: {ratio: 4, threshold: -18, attack_ms: 10}}]}]\nmaster: {effects: [{limit: {ceiling: -1}}], loudness: -14}\n";
        let s: Score = serde_yaml::from_str(y).unwrap();
        let t = &s.tracks[0];
        assert_eq!(t.pan, Some(-20.0));
        assert!(matches!(&t.effects[0], Effect::Eq(e) if e.lowcut == Some(120.0) && e.peaks == vec![[-4.0, 800.0, 1.4]]));
        assert!(matches!(&t.effects[1], Effect::Comp(c) if c.ratio == 4.0 && c.attack_ms == Some(10.0)));
        let m = s.master.as_ref().unwrap();
        assert_eq!((m.loudness, m.effects.len()), (Some(-14.0), 1));
        let back: Score = serde_yaml::from_str(&serde_yaml::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        let two = serde_yaml::from_str::<Score>(&y.replace("{eq: {lowcut: 120,", "{eq: {lowcut: 120}, comp: {ratio: 2, threshold: -10}, x: {")).unwrap_err().to_string();
        assert!(two.contains("effect"), "{two}");
    }

    #[test]
    fn rejects_unknown_fields_and_bad_values() {
        let base = "apricity: 0.1\ntempo: 120\nkey: C\nclips: {a: {source: x.wav}}\n";
        assert!(serde_yaml::from_str::<Score>(&format!("{base}tracks: [{{clip: a}}]")).is_ok());
        let typo = serde_yaml::from_str::<Score>(&format!("{base}tracks: [{{clip: a, gian: 3}}]")).unwrap_err().to_string();
        assert!(typo.contains("gian"), "{typo}");
        let bad = serde_yaml::from_str::<Score>(&format!("{base}tracks: [{{clip: a, transpose: up}}]")).unwrap_err().to_string();
        assert!(bad.contains("transpose"), "{bad}");
        let pat = serde_yaml::from_str::<Score>(&format!("{base}tracks: [{{clip: a, pattern: {{every: 1bar}}}}]")).unwrap();
        assert_eq!(pat.tracks[0].pattern, Pattern::Every("1bar".into()));
        let nums = serde_yaml::from_str::<Score>(&format!("{base}tracks: [{{clip: a, bars: 5, pattern: {{at: [1, \"3:2\"]}}}}]")).unwrap();
        assert_eq!(nums.tracks[0].bars.as_deref(), Some("5"));
        assert_eq!(nums.tracks[0].pattern, Pattern::At(vec!["1".into(), "3:2".into()]));
        let bad = serde_yaml::from_str::<Score>(&format!("{base}tracks: [{{clip: a, pattern: {{evry: 1bar}}}}]")).unwrap_err().to_string();
        assert!(bad.contains("pattern must be"), "{bad}");
    }
}
