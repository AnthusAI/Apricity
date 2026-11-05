//! Deterministic, editable Live 11 arrangement export.
use apricity_score::{Event, Timeline, score::WarpModeSpec};
use flate2::{Compression, GzBuilder, read::GzDecoder};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Read, Write},
};

#[derive(Debug, Clone)]
pub struct SampleReference {
    pub absolute_path: String,
    pub relative_path: String,
    pub relative_path_type: u8,
    pub byte_len: u64,
    pub frames: u64,
    pub sample_rate: u32,
}
#[derive(Debug)]
pub struct SetExport {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
    pub track_count: usize,
    pub clip_count: usize,
    pub locator_count: usize,
}

/// Reject representations that would change the arrangement, before staging any media.
pub fn validate_timeline(t: &Timeline) -> Result<(), String> {
    // Live tempo is 20–999 BPM; meter and clip pitch/gain limits follow
    // design/daw-set.md sections 3–4 (the upper gain bound is provisional).
    if !t.tempo.is_finite()
        || !(20.0..=999.0).contains(&t.tempo)
        || !(1..=99).contains(&t.meter)
        || !t.length_beats.is_finite()
        || t.length_beats <= 0.0
    {
        return Err("invalid tempo, meter, or arrangement length".into());
    }
    let mut names = HashSet::new();
    for track in &t.tracks {
        if !xml_valid(&track.name) || !xml_valid(&track.clip) {
            return Err(format!(
                "track name or clip contains invalid XML characters: {:?}",
                track.name
            ));
        }
        if !names.insert(&track.name) {
            return Err(format!("duplicate track name {}", track.name));
        }
    }
    let mut ends: HashMap<&str, f64> = HashMap::new();
    let mut events: Vec<_> = t.events.iter().collect();
    events.sort_by(|a, b| a.start_beat.total_cmp(&b.start_beat));
    for e in events {
        let context = format!("track '{}' clip at beat {}", e.track, e.start_beat);
        let track = t
            .tracks
            .iter()
            .find(|x| x.name == e.track)
            .ok_or_else(|| format!("{context}: unknown track"))?;
        if track.kit.is_some() || track.chops.is_some() {
            return Err(format!("{context}: kit events are unsupported"));
        }
        if e.reverse {
            return Err(format!("{context}: reverse is unsupported"));
        }
        if e.mode == WarpModeSpec::Repitch {
            return Err(format!("{context}: Re-Pitch is unsupported"));
        }
        if e.source >= t.sources.len() {
            return Err(format!("{context}: invalid source index"));
        }
        if !e.start_beat.is_finite()
            || e.start_beat < 0.0
            || !e.dur_beats.is_finite()
            || e.dur_beats <= 0.0
            || e.start_beat + e.dur_beats > t.length_beats + 1e-7
            || !e.src_start.is_finite()
            || !e.src_end.is_finite()
            || e.src_start < 0.0
            || e.src_end <= e.src_start
        {
            return Err(format!("{context}: invalid clip bounds"));
        }
        if ends
            .get(e.track.as_str())
            .is_some_and(|end| e.start_beat < *end - 1e-8)
        {
            return Err(format!("{context}: overlapping clips are unsupported"));
        }
        ends.insert(&e.track, e.start_beat + e.dur_beats);
        if e.warp.len() < 2
            || e.warp.iter().any(|(s, b)| !s.is_finite() || !b.is_finite())
            || e.warp
                .windows(2)
                .any(|w| w[1].0 <= w[0].0 || w[1].1 <= w[0].1)
            || (e.warp[0].0 - e.src_start).abs() > 1e-5
            || (e.warp[0].1).abs() > 1e-5
            || (e.warp.last().unwrap().0 - e.src_end).abs() > 1e-5
            || (e.warp.last().unwrap().1 - e.dur_beats).abs() > 1e-5
        {
            return Err(format!("{context}: invalid warp markers"));
        }
        let cents = e.semitones as f64 * 100.0 + e.tuning_cents;
        let rounded = cents.round();
        let final_coarse = ((rounded + 50.0) / 100.0).floor();
        if !cents.is_finite()
            || !(-48.0..=48.0).contains(&final_coarse)
            || !e.gain_db.is_finite()
            || !(0.0003162277571..=15.85).contains(&10f64.powf(e.gain_db / 20.0))
        {
            return Err(format!(
                "{context}: pitch, detune or gain outside Live range"
            ));
        }
    }
    let mut last = -1.0;
    for h in &t.harmony {
        if !xml_valid(&h.label) {
            return Err("chord label contains invalid XML characters".into());
        }
        if !h.start_beat.is_finite()
            || h.start_beat < last
            || h.start_beat < 0.0
            || h.start_beat > t.length_beats
        {
            return Err("invalid chord locator position".into());
        }
        last = h.start_beat;
    }
    Ok(())
}

#[derive(Clone)]
struct Node {
    name: String,
    attrs: BTreeMap<String, String>,
    children: Vec<Node>,
    text: Option<String>,
}
impl Node {
    fn parse(n: roxmltree::Node<'_, '_>) -> Self {
        Self {
            name: n.tag_name().name().into(),
            attrs: n
                .attributes()
                .map(|a| (a.name().into(), a.value().into()))
                .collect(),
            children: n
                .children()
                .filter(|x| x.is_element())
                .map(Self::parse)
                .collect(),
            text: n
                .children()
                .find(|x| x.is_text() && !x.text().unwrap_or("").trim().is_empty())
                .and_then(|x| x.text())
                .map(str::to_string),
        }
    }
    fn child(&mut self, name: &str) -> &mut Self {
        self.children
            .iter_mut()
            .find(|n| n.name == name)
            .unwrap_or_else(|| panic!("reference missing {name}"))
    }
    fn path(&mut self, path: &str) -> &mut Self {
        path.split('/').fold(self, |n, p| n.child(p))
    }
    fn set(&mut self, path: &str, value: impl ToString) {
        self.path(path)
            .attrs
            .insert("Value".into(), value.to_string());
    }
    fn val(name: &str, value: impl ToString) -> Self {
        Self {
            name: name.into(),
            attrs: BTreeMap::from([("Value".into(), value.to_string())]),
            children: vec![],
            text: None,
        }
    }
    fn xml(&self, out: &mut String) {
        out.push('<');
        out.push_str(&self.name);
        for (k, v) in &self.attrs {
            out.push(' ');
            out.push_str(k);
            out.push_str("=\"");
            escape(v, out);
            out.push('"');
        }
        if self.children.is_empty() && self.text.is_none() {
            out.push_str("/>");
            return;
        }
        out.push('>');
        if let Some(t) = &self.text {
            escape(t, out)
        }
        for c in &self.children {
            c.xml(out)
        }
        out.push_str("</");
        out.push_str(&self.name);
        out.push('>');
    }
}
fn xml_valid(s: &str) -> bool {
    s.chars().all(|c| matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}'))
}
fn escape(s: &str, o: &mut String) {
    for c in s.chars() {
        match c {
            '\n' => o.push_str("&#10;"),
            '\r' => o.push_str("&#13;"),
            '\t' => o.push_str("&#9;"),
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '\"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            _ => o.push(c),
        }
    }
}
fn parse(s: &str) -> Node {
    Node::parse(
        roxmltree::Document::parse(s)
            .expect("embedded XML")
            .root_element(),
    )
}
fn remap(n: &mut Node, map: &mut HashMap<String, String>, next: &mut u64) {
    if (n.name == "Pointee" || n.name.ends_with("Target")) && n.attrs.contains_key("Id") {
        let old = n.attrs["Id"].clone();
        let new = next.to_string();
        *next += 1;
        map.insert(old, new.clone());
        n.attrs.insert("Id".into(), new);
    }
    for c in &mut n.children {
        remap(c, map, next)
    }
}
fn remap_refs(n: &mut Node, map: &HashMap<String, String>) {
    if n.name == "PointeeId" {
        if let Some(v) = n.attrs.get_mut("Value") {
            if let Some(new) = map.get(v) {
                *v = new.clone()
            }
        }
    }
    for c in &mut n.children {
        remap_refs(c, map)
    }
}
fn clear_refs(n: &mut Node) {
    if n.name == "FileRef" {
        for c in &mut n.children {
            if ["RelativePath", "Path", "LivePackName", "LivePackId"].contains(&c.name.as_str()) {
                c.attrs.insert("Value".into(), String::new());
            }
            if c.name == "RelativePathType" {
                c.attrs.insert("Value".into(), "0".into());
            }
        }
    }
    for c in &mut n.children {
        clear_refs(c)
    }
}
fn pitch(semitones: i32, tuning_cents: f64) -> (i32, i32) {
    let cents = (semitones as f64 * 100.0 + tuning_cents).round() as i32;
    let coarse = (cents + 50).div_euclid(100);
    (coarse, cents - coarse * 100)
}

fn clip(e: &Event, name: &str, sample: &SampleReference, id: usize) -> Node {
    let mut c = parse(include_str!("clip.xml"));
    c.attrs.insert("Id".into(), id.to_string());
    c.attrs.insert("Time".into(), e.start_beat.to_string());
    c.set("CurrentStart", e.start_beat);
    c.set("CurrentEnd", e.start_beat + e.dur_beats);
    c.set("Name", name);
    for x in ["LoopEnd", "OutMarker", "HiddenLoopEnd"] {
        c.set(&format!("Loop/{x}"), e.dur_beats)
    }
    c.set(
        "WarpMode",
        match e.mode {
            WarpModeSpec::Beats => 0,
            WarpModeSpec::Texture => 2,
            WarpModeSpec::Complex => 6,
            WarpModeSpec::Repitch => unreachable!(),
        },
    );
    let (coarse, fine) = pitch(e.semitones, e.tuning_cents);
    c.set("PitchCoarse", coarse);
    c.set("PitchFine", fine);
    c.set("SampleVolume", 10f64.powf(e.gain_db / 20.0));
    for (path, v) in [
        ("RelativePathType", sample.relative_path_type.to_string()),
        ("RelativePath", sample.relative_path.clone()),
        ("Path", sample.absolute_path.clone()),
        ("OriginalFileSize", sample.byte_len.to_string()),
    ] {
        c.set(&format!("SampleRef/FileRef/{path}"), v)
    }
    c.set("SampleRef/DefaultDuration", sample.frames);
    c.set("SampleRef/DefaultSampleRate", sample.sample_rate);
    let last = e.warp[e.warp.len() - 1];
    let prev = e.warp[e.warp.len() - 2];
    let trailing = (
        last.0 + (last.0 - prev.0) / (last.1 - prev.1) / 32.0,
        last.1 + 1.0 / 32.0,
    );
    let points = e.warp.iter().copied().chain([trailing]);
    let markers = c.path("WarpMarkers");
    for (i, (s, b)) in points.enumerate() {
        markers.children.push(Node {
            name: "WarpMarker".into(),
            attrs: BTreeMap::from([
                ("Id".into(), i.to_string()),
                ("SecTime".into(), s.to_string()),
                ("BeatTime".into(), b.to_string()),
            ]),
            children: vec![],
            text: None,
        });
    }
    c
}

pub fn export_set(t: &Timeline, samples: &[Option<SampleReference>]) -> Result<SetExport, String> {
    validate_timeline(t)?;
    for e in &t.events {
        let s = samples
            .get(e.source)
            .and_then(Option::as_ref)
            .ok_or_else(|| {
                format!(
                    "track '{}' clip at beat {}: missing sample reference",
                    e.track, e.start_beat
                )
            })?;
        if ![1, 3].contains(&s.relative_path_type)
            || !xml_valid(&s.relative_path)
            || !xml_valid(&s.absolute_path)
            || s.relative_path.is_empty()
            || s.absolute_path.is_empty()
            || s.sample_rate == 0
            || s.frames == 0
            || s.byte_len == 0
            || e.src_end > s.frames as f64 / s.sample_rate as f64 + 1e-5
        {
            return Err(format!(
                "track '{}' clip at beat {}: invalid sample reference or source bounds",
                e.track, e.start_beat
            ));
        }
    }
    let mut xml = String::new();
    GzDecoder::new(&include_bytes!("../tests/fixtures/reference/set/owner-11.3.43-empty.als")[..])
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    let mut root = parse(&xml);
    clear_refs(&mut root);
    let live = root.child("LiveSet");
    let mut next = live.child("NextPointeeId").attrs["Value"]
        .parse::<u64>()
        .map_err(|e| e.to_string())?;
    let tracks = live.child("Tracks");
    let template = tracks
        .children
        .iter()
        .find(|n| n.name == "AudioTrack")
        .unwrap()
        .clone();
    tracks.children.retain(|n| n.name == "ReturnTrack");
    let mut built = Vec::new();
    for (i, track) in t.tracks.iter().enumerate() {
        let mut n = template.clone();
        let mut ids = HashMap::new();
        remap(&mut n, &mut ids, &mut next);
        remap_refs(&mut n, &ids);
        n.attrs.insert("Id".into(), (1000 + i).to_string());
        n.set("Name/UserName", &track.name);
        n.set("Name/EffectiveName", &track.name);
        let events = n.path("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events");
        events.children.clear();
        for (j, e) in t
            .events
            .iter()
            .filter(|e| e.track == track.name)
            .enumerate()
        {
            events
                .children
                .push(clip(e, &track.clip, samples[e.source].as_ref().unwrap(), j));
        }
        built.push(n)
    }
    built.append(&mut tracks.children);
    tracks.children = built;
    live.set("NextPointeeId", next);
    let master = live.child("MasterTrack");
    let sig = 197 + t.meter;
    master.set("DeviceChain/Mixer/Tempo/Manual", t.tempo);
    master.set("DeviceChain/Mixer/TimeSignature/Manual", sig);
    let envs = master.path("AutomationEnvelopes/Envelopes");
    for e in &mut envs.children {
        let target = e.path("EnvelopeTarget/PointeeId").attrs["Value"].clone();
        if target == "8" {
            e.path("Automation/Events/FloatEvent")
                .attrs
                .insert("Value".into(), t.tempo.to_string());
        } else if target == "10" {
            e.path("Automation/Events/EnumEvent")
                .attrs
                .insert("Value".into(), sig.to_string());
        }
    }
    let transport = live.child("Transport");
    transport.set("LoopOn", "true");
    transport.set("LoopStart", 0);
    transport.set("LoopLength", t.length_beats);
    transport.set("CurrentTime", 0);
    let locs = live.path("Locators/Locators");
    locs.children.clear();
    let mut previous = None;
    for h in &t.harmony {
        if previous == Some(h.label.as_str()) {
            continue;
        }
        previous = Some(&h.label);
        let id = locs.children.len() + 1;
        locs.children.push(Node {
            name: "Locator".into(),
            attrs: BTreeMap::from([("Id".into(), id.to_string())]),
            children: vec![
                Node::val("LomId", 0),
                Node::val("Time", h.start_beat),
                Node::val("Name", &h.label),
                Node::val("Annotation", ""),
                Node::val("IsSongStart", "false"),
            ],
            text: None,
        });
    }
    let locator_count = locs.children.len();
    let mut warnings = Vec::new();
    if t.master.loudness.is_some() {
        warnings.push("Master loudness normalization is not exported".into());
    }
    if !t.master.effects.is_empty()
        || t.tracks
            .iter()
            .any(|x| !x.effects.is_empty() || x.filter.is_some())
        || t.events.iter().any(|e| e.filter.is_some())
    {
        warnings.push("Effects and filters are not exported".into());
    }
    if !t.buses.is_empty()
        || t.tracks
            .iter()
            .any(|x| x.pan != 0.0 || !x.sends.is_empty() || x.out != "master")
    {
        warnings.push("Bus routing, sends and pan are not exported".into());
    }
    if t.tracks.iter().any(|x| !x.automation.is_empty()) {
        warnings.push("Automation is not exported".into());
    }
    if t.events
        .iter()
        .any(|e| e.attack_s.unwrap_or(0.0) > 0.0 || e.release_s.unwrap_or(0.0) > 0.0)
    {
        warnings.push("Clip fades are not exported".into());
    }
    let mut result = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    root.xml(&mut result);
    let mut gzip = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::default());
    gzip.write_all(result.as_bytes())
        .map_err(|e| e.to_string())?;
    let bytes = gzip.finish().map_err(|e| e.to_string())?;
    Ok(SetExport {
        bytes,
        warnings,
        track_count: t.tracks.len(),
        clip_count: t.events.len(),
        locator_count,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn xml_characters_are_escaped_or_rejected() {
        assert!(!super::xml_valid("bad\u{1}"));
        assert!(super::xml_valid("a\n&b"));
        let mut value = String::new();
        super::escape("a\n&b", &mut value);
        assert_eq!(value, "a&#10;&amp;b");
    }
    #[test]
    fn fractional_detune_rounds_to_nearest_cent() {
        assert_eq!(super::pitch(5, -23.4), (5, -23));
        assert_eq!(super::pitch(5, -23.6), (5, -24));
        assert_eq!(super::pitch(0, -50.6), (-1, 49));
    }
}
