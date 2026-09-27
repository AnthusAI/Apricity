//! Offline rendering: arrange the whole timeline with the engine's renderer and bounce it.

use apricity_engine::{Renderer, Stereo, TrackControl};
use apricity_score::Timeline;
use std::collections::HashMap;
use std::path::Path;

pub const OUT_SR: u32 = 48_000;

pub struct Rendered {
    pub mix: Stereo,
    /// The stems summed pre-master (`Arrangement::bounce_raw`) — not used by the `--out` path
    /// (which writes `mix`, exactly as before this field existed), only by `--stems`' `mix.wav`,
    /// so a reviewer can check it against the sum of the per-track stem files directly.
    pub mix_raw: Stereo,
    pub unique_events: usize,
    /// Integrated loudness of the finished mix (LUFS) and its sample peak (dBFS).
    pub lufs: f64,
    pub peak_db: f64,
    /// The master's loudness make-up gain (dB).
    pub makeup_db: f64,
    pub stems: usize,
    /// One line per track, group and return: routing, level, and compressor gain reduction.
    pub report: Vec<String>,
}

pub fn render(tl: &Timeline, beats: Option<(f64, f64)>) -> Result<Rendered, String> {
    let mut r = Renderer::with_file_decoder(OUT_SR);
    let (arr, stats) = r.arrange(tl, beats)?;
    let mix = arr.bounce();
    let mix_raw = arr.bounce_raw();
    let lufs = apricity_dsp::fx::loudness_lufs(&mix[0], &mix[1], OUT_SR as f64);
    let peak = mix.iter().flatten().fold(0f32, |m, x| m.max(x.abs()));
    let report = mix_report(&r, &arr, tl);
    Ok(Rendered { mix, mix_raw, unique_events: stats.rendered, lufs, peak_db: 20.0 * (peak.max(1e-9) as f64).log10(), makeup_db: arr.master.gain_db, stems: arr.stems.len(), report })
}

/// Level of each stem as it enters the mix, and how hard each compressor worked (deepest gain
/// reduction over the loop).
fn mix_report(r: &Renderer, arr: &apricity_engine::Arrangement, tl: &Timeline) -> Vec<String> {
    let Some(m) = r.mix() else { return Vec::new() };
    let level = |b: &Stereo| {
        let lufs = apricity_dsp::fx::loudness_lufs(&b[0], &b[1], OUT_SR as f64);
        let peak = b.iter().flatten().fold(0f32, |p, x| p.max(x.abs()));
        let lufs = if lufs.is_finite() { format!("{lufs:6.1} LUFS") } else { "  silent   ".into() };
        format!("{lufs}  peak {:6.1} dBFS", 20.0 * (peak.max(1e-9) as f64).log10())
    };
    let comps = |red: &[(String, f64)]| red.iter().map(|(what, db)| format!("   {what}: {db:.1} dB")).collect::<String>();
    let mut out = Vec::new();
    for t in &m.tracks {
        let route = if t.sends.is_empty() { t.out.clone() } else { format!("{} + {}", t.out, t.sends.iter().map(|s| s.0.as_str()).collect::<Vec<_>>().join(", ")) };
        out.push(format!("track {:<14} → {:<16} {}{}", t.name, route, level(&t.buf), comps(&t.reductions)));
    }
    let kind = |n: &str| tl.buses.iter().find(|b| b.name == n).map_or("group", |b| if b.kind == "return" { "return" } else { "group" });
    for b in &m.buses {
        let lvl = arr.stems.iter().find(|s| s.name == b.name).map_or_else(|| format!("(inside {})", b.out), |s| level(&s.buf));
        let red = r.bus_report().iter().find(|(n, _)| *n == b.name).map_or(String::new(), |(_, red)| comps(red));
        out.push(format!("{:<6}{:<14} → {:<16} {lvl}{red}", kind(&b.name), b.name, b.out));
    }
    out
}

pub fn write_wav(path: &Path, mix: &Stereo) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 2, sample_rate: OUT_SR, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for i in 0..mix[0].len() {
        for c in mix {
            w.write_sample((c[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| e.to_string())?;
        }
    }
    w.finalize().map_err(|e| e.to_string())
}

/// Write a 32-bit IEEE-float stereo WAV: stems (and the pre-clamp mix) can exceed ±1, so they're
/// never clamped to the 16-bit int range the way `write_wav`'s file is.
pub fn write_wav_float(path: &Path, mix: &Stereo) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 2, sample_rate: OUT_SR, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for i in 0..mix[0].len() {
        for c in mix {
            w.write_sample(c[i]).map_err(|e| e.to_string())?;
        }
    }
    w.finalize().map_err(|e| e.to_string())
}

/// One track's soloed stem: its own audio *as heard* (through its group's effects and any send's
/// return, pre-master), plus the bits of `stems.json` that describe it.
pub struct TrackStemOut {
    pub name: String,
    pub buf: Stereo,
    /// Does the score itself think this track carries tonal/harmonic content? True when
    /// `TrackInfo::pitch` (a pinned/heard single note, e.g. a bass or lead) or `TrackInfo::voice`
    /// (a loop the harmony solver moves) is set. False for a drum kit's pads and any other
    /// re-pitched one-shot that plays outside the harmony (a kick, a clap, a crash, a swell): the
    /// score compiler already knows these aren't chord material, which is a far more reliable
    /// signal than guessing "pitched" from the audio (a decaying kick thump reads as a pitch to
    /// chroma/HPCP just as readily as a real note does).
    pub pitched: bool,
    pub kit: Option<String>,
    /// A group track, or "master".
    pub out: String,
    /// Return tracks it sends to.
    pub sends: Vec<String>,
    /// A pitched, single-note track's clip pitch, with octave, e.g. "A1 (heard)" or "Bb2
    /// (pinned)" (see `TrackInfo::pitch`) -- the most reliable "this is the bass" signal the
    /// score itself offers, since a loop or kit carries no single octave. `None` for anything
    /// else (loops that follow the harmony solver, kits, unpitched tracks).
    pub pitch: Option<String>,
}

/// Render `tl` (same as `render`) and, in addition, one soloed-through-its-routing stem per track:
/// each is built by re-mixing the same arrangement with only that track (and whatever it sends to
/// or is grouped into) audible, then bouncing pre-master — so a group's breakdown filter and a
/// send's reverb tail land in the right stem, and the mix that `render` computed is untouched.
pub fn render_stems(tl: &Timeline, beats: Option<(f64, f64)>) -> Result<(Rendered, Vec<TrackStemOut>), String> {
    let mut r = Renderer::with_file_decoder(OUT_SR);
    render_stems_with(&mut r, tl, beats)
}

fn render_stems_with(r: &mut Renderer, tl: &Timeline, beats: Option<(f64, f64)>) -> Result<(Rendered, Vec<TrackStemOut>), String> {
    let (arr, stats) = r.arrange(tl, beats)?;
    let mix = arr.bounce();
    let mix_raw = arr.bounce_raw();
    let lufs = apricity_dsp::fx::loudness_lufs(&mix[0], &mix[1], OUT_SR as f64);
    let peak = mix.iter().flatten().fold(0f32, |m, x| m.max(x.abs()));
    let report = mix_report(r, &arr, tl);
    let rendered = Rendered { mix, mix_raw, unique_events: stats.rendered, lufs, peak_db: 20.0 * (peak.max(1e-9) as f64).log10(), makeup_db: arr.master.gain_db, stems: arr.stems.len(), report };

    let names: Vec<String> = r.mix().map_or_else(Vec::new, |m| m.tracks.iter().map(|t| t.name.clone()).collect());
    // Every direct-to-master track's name (not bus names): `Mix::build` pushes each of these as
    // its own `Arrangement` stem *unconditionally* (solo/mute for that category is meant to be
    // applied later, live, by the audio thread), so soloing via `remix` alone only actually
    // isolates a track that's grouped or sent (its bus is genuinely rebuilt from only the audible
    // tracks). To isolate a direct track too, mute every other one by name once we have the
    // built `Arrangement`'s own stem list.
    let track_names: std::collections::HashSet<&str> = tl.tracks.iter().map(|t| t.name.as_str()).collect();
    let mut stems = Vec::with_capacity(names.len());
    for name in &names {
        let mut controls: HashMap<String, TrackControl> = HashMap::new();
        controls.insert(name.clone(), TrackControl { solo: true, ..Default::default() });
        let buf = match r.remix(&controls) {
            Some(arr) => {
                let mut mute = vec![TrackControl::default(); arr.stems.len()];
                for (i, s) in arr.stems.iter().enumerate() {
                    if s.name != *name && track_names.contains(s.name.as_str()) {
                        mute[i].mute = true;
                    }
                }
                let mut l = vec![0.0f32; arr.length];
                let mut r_ch = vec![0.0f32; arr.length];
                arr.mix_into(0, &mut [&mut l, &mut r_ch], arr.length, 1.0, &mute);
                [l, r_ch]
            }
            None => [Vec::new(), Vec::new()],
        };
        let info = tl.tracks.iter().find(|t| t.name == *name);
        stems.push(TrackStemOut {
            name: name.clone(),
            buf,
            pitched: info.map_or(true, |t| t.pitch.is_some() || t.voice.is_some()),
            kit: info.and_then(|t| t.kit.clone()),
            out: info.map_or_else(|| "master".into(), |t| t.out.clone()),
            sends: info.map_or_else(Vec::new, |t| t.sends.keys().cloned().collect()),
            pitch: info.and_then(|t| t.pitch.clone()),
        });
    }
    Ok((rendered, stems))
}

/// `stems.json`: everything `check-stems.py` needs to align chroma frames to the score's own
/// beat/bar grid and to know which chord tones each span calls for, without re-running the
/// harmony solver or beat-tracking the audio.
pub fn stems_manifest(tl: &Timeline, beats: Option<(f64, f64)>, stems: &[TrackStemOut]) -> String {
    let offset_beats = beats.map_or(0.0, |(b0, _)| b0);
    let length = stems.first().map_or(0, |s| s.buf[0].len());
    let harmony: Vec<serde_json::Value> = tl
        .harmony
        .iter()
        .map(|h| {
            let chord_tones: Vec<&str> = h.fit.as_ref().map_or_else(Vec::new, |f| f.chord_tones.iter().map(|p| p.name()).collect());
            serde_json::json!({
                "start_beat": h.start_beat,
                "end_beat": h.end_beat,
                "label": h.label,
                "chord": h.fit.as_ref().map(|f| f.chord.clone()),
                "chord_tones": chord_tones,
            })
        })
        .collect();
    let tracks: Vec<serde_json::Value> = stems
        .iter()
        .map(|s| serde_json::json!({"name": s.name, "pitched": s.pitched, "kit": s.kit, "out": s.out, "sends": s.sends, "pitch": s.pitch}))
        .collect();
    let manifest = serde_json::json!({
        "sample_rate": OUT_SR,
        "tempo": tl.tempo,
        "meter": tl.meter,
        "key": tl.key,
        "offset_beats": offset_beats,
        "length": length,
        "harmony": harmony,
        "tracks": tracks,
    });
    serde_json::to_string_pretty(&manifest).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use apricity_engine::Audio;
    use std::path::PathBuf;

    /// A short constant tone as a fake decoded source, so tests don't need real audio files.
    fn tone(n: usize, amp: f32) -> Audio {
        Audio { sr: OUT_SR, channels: vec![vec![amp; n], vec![amp; n]] }
    }

    fn source_ref(clip: &str) -> apricity_score::compile::SourceRef {
        apricity_score::compile::SourceRef { clip: clip.into(), path: PathBuf::from(clip), bpm: None, key: "C".into(), region: None }
    }

    fn track_info(name: &str, out: &str, sends: &[(&str, f64)]) -> apricity_score::TrackInfo {
        apricity_score::TrackInfo {
            name: name.into(),
            clip: name.into(),
            region_key: "C".into(),
            region_beats: (0.0, 1.0),
            beat_ratio: 1.0,
            stretch: None,
            retune_cents: 0.0,
            level_db: 0.0,
            level_groups: Vec::new(),
            chops: None,
            kit: None,
            pieces: Vec::new(),
            effects: Vec::new(),
            pan: 0.0,
            out: out.into(),
            sends: sends.iter().map(|(n, l)| (n.to_string(), *l)).collect(),
            varispeed: None,
            pitch: None,
            voice: None,
            automation: Vec::new(),
            automation_specs: Vec::new(),
            filter: None,
            attack_s: None,
            release_s: None,
        }
    }

    fn event(track: &str, source: usize, start_beat: f64) -> apricity_score::Event {
        apricity_score::Event {
            track: track.into(),
            source,
            start_beat,
            dur_beats: 1.0,
            src_start: 0.0,
            src_end: 1.0,
            warp: Vec::new(),
            semitones: 0,
            tuning_cents: 0.0,
            gain_db: 0.0,
            mode: apricity_score::score::WarpModeSpec::Repitch,
            reverse: false,
            filter: None,
            piece: 0,
            velocity: None,
            attack_s: None,
            release_s: None,
        }
    }

    fn timeline(sources: Vec<&str>, tracks: Vec<apricity_score::TrackInfo>, events: Vec<apricity_score::Event>, buses: Vec<apricity_score::BusInfo>) -> Timeline {
        Timeline {
            tempo: 120.0,
            meter: 4,
            key: "C major".into(),
            length_beats: 4.0,
            sources: sources.into_iter().map(source_ref).collect(),
            events,
            harmony: Vec::new(),
            tracks,
            warnings: Vec::new(),
            buses,
            master: Default::default(),
        }
    }

    fn empty_renderer() -> Renderer {
        Renderer::new(OUT_SR, |p: &Path| Err(format!("no file loader in tests: {}", p.display())))
    }

    fn insert(r: &mut Renderer, name: &str, n: usize, amp: f32) {
        r.insert_source(Path::new(name), tone(n, amp));
    }

    #[test]
    fn two_tracks_straight_to_master_sum_to_bounce_raw() {
        let mut r = empty_renderer();
        insert(&mut r, "a", OUT_SR as usize, 0.4);
        insert(&mut r, "b", OUT_SR as usize, 0.2);
        let tracks = vec![track_info("a", "master", &[]), track_info("b", "master", &[])];
        let events = vec![event("a", 0, 0.0), event("b", 1, 0.0)];
        let tl = timeline(vec!["a", "b"], tracks, events, Vec::new());

        let (_rendered, stems) = render_stems_with(&mut r, &tl, None).expect("render_stems");
        assert_eq!(stems.len(), 2);

        // Reference: a plain arrangement of the same timeline, summed with unity controls.
        let mut r2 = empty_renderer();
        insert(&mut r2, "a", OUT_SR as usize, 0.4);
        insert(&mut r2, "b", OUT_SR as usize, 0.2);
        let (arr, _) = r2.arrange(&tl, None).expect("arrange");
        let reference = arr.bounce_raw();

        let len = reference[0].len();
        for ch in 0..2 {
            for i in 0..len {
                let summed: f32 = stems.iter().map(|s| s.buf[ch][i]).sum();
                assert!((summed - reference[ch][i]).abs() < 1e-6, "channel {ch} frame {i}: summed stems {summed} vs bounce_raw {}", reference[ch][i]);
            }
        }
    }

    #[test]
    fn a_send_carries_the_returns_tail() {
        use apricity_score::score::{DelaySpec, Effect};

        let n = OUT_SR as usize / 4; // 250ms note
        let mut r = empty_renderer();
        insert(&mut r, "a", n, 0.5);
        let tracks = vec![track_info("a", "master", &[("echo", 1.0)])];
        let events = vec![event("a", 0, 0.0)];
        // A delay return: one beat of feedback so the tail rings on well past the dry note.
        let delay = Effect::Delay(DelaySpec { beats: Some(1.0), feedback: Some(0.5), ..Default::default() });
        let bus = apricity_score::BusInfo {
            name: "echo".into(),
            kind: "return".into(),
            effects: vec![delay],
            gain_db: 0.0,
            out: "master".into(),
            automation: Vec::new(),
            automation_specs: Vec::new(),
        };
        let tl = timeline(vec!["a"], tracks, events, vec![bus]);

        let (_rendered, stems) = render_stems_with(&mut r, &tl, None).expect("render_stems");
        assert_eq!(stems.len(), 1, "one track's stem, dry + wet summed");
        let a = &stems[0];
        // 1 beat = 0.5s at 120bpm = 24000 frames; the delay's echo lands there, well after the
        // 250ms dry note ended, proving the return's tail rode along in the track's own stem.
        let echo_at = (OUT_SR as f64 * 0.5) as usize;
        let energy = a.buf[0][echo_at..echo_at + 200].iter().map(|x| x.abs()).sum::<f32>();
        assert!(energy > 0.01, "expected the delay's echo inside the soloed stem, got energy {energy}");
    }

    #[test]
    fn stems_json_shifts_by_offset_beats() {
        let harmony = vec![apricity_score::ChordSpan { start_beat: 0.0, end_beat: 4.0, label: "I".into(), fit: None }];
        let mut tl = timeline(Vec::new(), Vec::new(), Vec::new(), Vec::new());
        tl.harmony = harmony;
        let json = stems_manifest(&tl, Some((4.0, 8.0)), &[]);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["offset_beats"], 4.0);
        assert_eq!(v["harmony"][0]["start_beat"], 0.0, "the span itself keeps its absolute beats");
    }
}
