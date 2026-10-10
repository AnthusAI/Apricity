//! Control-thread side: turn a compiled `Timeline` into an `Arrangement` of pre-rendered stereo
//! buffers. Each distinct event (source span × length × transposition × tuning × mode) is warped
//! once with Rubber Band and cached, so re-arranging after an edit only renders what changed.

use crate::arrangement::{sum_placements, Arrangement, Placement, Stereo, TrackControl};
use crate::automation::{Curve, scale_for};
use crate::master;
use crate::mix::{BusDef, Mix, TrackStem};
use apricity_dsp::{stretch_offline, StretchParams, WarpMode};
use apricity_dsp::fx::{Biquad, BiquadKind};
use apricity_score::compile::{Event, DEFAULT_LOUDNESS, Lane};
use apricity_score::score::{FilterSpec, WarpModeSpec};
use apricity_score::Timeline;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const FADE_S: f64 = 0.004;
const FILTER_UPDATE_FRAMES: usize = 32;

/// An event's release, in output frames at `out_sr` (0 when it has none).
fn release_frames(e: &Event, out_sr: f64) -> usize {
    (e.release_s.unwrap_or(0.0) * out_sr).round().max(0.0) as usize
}

/// The gain at output frame `i` of `len` total frames: a raised-cosine (half-Hann) fade in over the
/// first `attack_frames`, full volume in between, then a raised-cosine fade to silence starting at
/// `release_start` over `release_frames`. Either envelope is skipped when its frame count is 0.
/// `len` isn't used in the shape itself (both windows are anchored to their own edge) but documents
/// the buffer the caller applies this over.
pub fn envelope_gain(i: usize, len: usize, attack_frames: usize, release_start: usize, release_frames: usize) -> f32 {
    let _ = len;
    let mut g = 1.0f64;
    if attack_frames > 0 && i < attack_frames {
        g *= 0.5 - 0.5 * (std::f64::consts::PI * i as f64 / attack_frames as f64).cos();
    }
    if release_frames > 0 && i >= release_start {
        let t = (i - release_start) as f64;
        g *= if t >= release_frames as f64 { 0.0 } else { 0.5 + 0.5 * (std::f64::consts::PI * t / release_frames as f64).cos() };
    }
    g as f32
}

/// Apply the header filter's automation (cutoff and/or resonance) to a stereo track buffer in
/// place. `base` is the track's static filter (its kind and slope, and the value(s) not
/// automated); either lane may be absent. Coefficients are recomputed every 32 frames; a 24 dB
/// slope cascades two independently-updated biquads.
pub fn filter_sweep(buf: &mut [Vec<f32>; 2], base: FilterSpec, cutoff_lane: Option<&Lane>, res_lane: Option<&Lane>, sr: f64, secs_per_beat: f64, offset_beats: f64) {
    let lowpass = matches!(base, FilterSpec::Lowpass { .. });
    let to_curve = |lane: &Lane| Curve::from_lane(lane.points.iter().map(|p| (p[0], p[1])).collect(), lane.step, scale_for(&lane.target), sr, secs_per_beat, offset_beats);
    let cutoff_curve = cutoff_lane.map(to_curve);
    let res_curve = res_lane.map(to_curve);
    let passes = (base.slope() / 12).max(1) as usize;
    let mut filt = [[Biquad::default(); 2]; 2]; // [pass][channel]
    let length = buf[0].len();

    for frame_idx in 0..length {
        // Recompute coefficients every 32 frames
        if frame_idx % FILTER_UPDATE_FRAMES == 0 {
            let hz = cutoff_curve.as_ref().map_or(base.hz(), |c| c.value_at(frame_idx as u64));
            let res = res_curve.as_ref().map_or(base.res(), |c| c.value_at(frame_idx as u64));
            let q = std::f64::consts::FRAC_1_SQRT_2 * 20f64.powf(res);
            let kind = if lowpass { BiquadKind::LowPass { hz, q } } else { BiquadKind::HighPass { hz, q } };
            for pass in filt.iter_mut().take(passes) {
                pass[0].set(kind, sr);
                pass[1].set(kind, sr);
            }
        }

        for pass in filt.iter_mut().take(passes) {
            buf[0][frame_idx] = pass[0].tick(0, buf[0][frame_idx] as f64) as f32;
            buf[1][frame_idx] = pass[1].tick(1, buf[1][frame_idx] as f64) as f32;
        }
    }
}

/// Apply volume and pan automation to a track buffer in-place.
/// Returns true if pan was automated (caller should set stem.pan to 0.0).
pub fn apply_track_automation(
    buf: &mut [Vec<f32>; 2],
    lanes: &[Lane],
    sr: f64,
    secs_per_beat: f64,
    offset_beats: f64,
) -> bool {
    let length = buf[0].len();
    let mut pan_automated = false;

    for lane in lanes {
        if lane.target == "volume" {
            let curve = Curve::from_lane(lane.points.iter().map(|p| (p[0], p[1])).collect(), lane.step, scale_for(&lane.target), sr, secs_per_beat, offset_beats);
            for i in 0..length {
                let v = curve.value_at(i as u64);
                let gain = 10f64.powf(v / 20.0);
                let gain = if v <= -60.0 { 0.0 } else { gain as f32 };
                buf[0][i] *= gain;
                buf[1][i] *= gain;
            }
        } else if lane.target == "pan" {
            let curve = Curve::from_lane(lane.points.iter().map(|p| (p[0], p[1])).collect(), lane.step, scale_for(&lane.target), sr, secs_per_beat, offset_beats);
            pan_automated = true; // Automation bakes pan into L/R
            for i in 0..length {
                let pan_val = curve.value_at(i as u64);
                let (pl, pr) = apricity_dsp::fx::balance(pan_val);
                buf[0][i] *= pl as f32;
                buf[1][i] *= pr as f32;
            }
        }
    }
    pan_automated
}

/// Decoded source audio, planar.
pub struct Audio {
    pub sr: u32,
    pub channels: Vec<Vec<f32>>,
}

type CacheKey = (usize, u64, u64, u64, i32, i64, u8, bool, i64, u64, u64, (u64, u16));

fn cache_key(source: usize, e: &Event) -> CacheKey {
    let q = |x: f64| (x * 1e5).round() as u64;
    let filter = match e.filter {
        None => 0,
        Some(FilterSpec::Lowpass { hz, .. }) => hz.round() as i64,
        Some(FilterSpec::Highpass { hz, .. }) => -(hz.round() as i64),
    };
    let filter_res = e.filter.map_or(0, |f| (f.res() * 1e4).round() as u64);
    let filter_slope = e.filter.map_or(12, |f| f.slope());
    (
        source,
        q(e.src_start),
        q(e.src_end),
        q(e.dur_beats * 1e3),
        e.semitones,
        (e.tuning_cents * 10.0).round() as i64,
        e.mode as u8,
        e.reverse,
        filter,
        q(e.attack_s.unwrap_or(0.0)),
        q(e.release_s.unwrap_or(0.0)),
        (filter_res, filter_slope),
    )
}

pub struct Renderer {
    pub sample_rate: u32,
    sources: HashMap<PathBuf, (usize, Arc<Audio>)>,
    /// Rendered events keyed by content *and* tempo-dependent length (frames), so a tempo change re-renders.
    cache: HashMap<(CacheKey, usize), Arc<Stereo>>,
    loader: Box<dyn Fn(&Path) -> Result<Audio, String> + Send>,
    /// The last arrangement's mix graph, for re-mixing after a live control change.
    mix: Option<Mix>,
    /// Gain reduction of each bus's compressors in the last arrangement.
    bus_report: Vec<(String, master::Reductions)>,
}

pub struct ArrangeStats {
    pub events: usize,
    pub rendered: usize,
    pub reused: usize,
}

impl Renderer {
    pub fn new(sample_rate: u32, loader: impl Fn(&Path) -> Result<Audio, String> + Send + 'static) -> Self {
        Self { sample_rate, sources: HashMap::new(), cache: HashMap::new(), loader: Box::new(loader), mix: None, bus_report: Vec::new() }
    }

    #[cfg(feature = "decode")]
    pub fn with_file_decoder(sample_rate: u32) -> Self {
        Self::new(sample_rate, crate::decode::decode)
    }

    /// Provide already-decoded audio for `path` (the browser decodes with Web Audio).
    pub fn insert_source(&mut self, path: &Path, audio: Audio) {
        let id = self.sources.get(path).map_or(self.sources.len(), |s| s.0);
        self.sources.insert(path.to_path_buf(), (id, Arc::new(audio)));
        self.cache.retain(|k, _| k.0 .0 != id);
    }

    pub fn has_source(&self, path: &Path) -> bool {
        self.sources.contains_key(path)
    }

    fn source(&mut self, path: &Path) -> Result<(usize, Arc<Audio>), String> {
        if let Some((id, a)) = self.sources.get(path) {
            return Ok((*id, a.clone()));
        }
        let audio = Arc::new((self.loader)(path)?);
        let id = self.sources.len();
        self.sources.insert(path.to_path_buf(), (id, audio.clone()));
        Ok((id, audio))
    }

    /// Build the arrangement for `tl`, optionally only the beats in `range`.
    pub fn arrange(&mut self, tl: &Timeline, range: Option<(f64, f64)>) -> Result<(Arrangement, ArrangeStats), String> {
        let sr = self.sample_rate as f64;
        let spb = 60.0 / tl.tempo;
        let fpb = spb * sr;
        let (b0, b1) = range.unwrap_or((0.0, tl.length_beats));
        let events: Vec<&Event> = tl.events.iter().filter(|e| e.start_beat < b1 && e.start_beat + e.dur_beats > b0).collect();

        // Resolve sources and figure out which events still need rendering.
        let mut jobs: Vec<((CacheKey, usize), &Event, Arc<Audio>)> = Vec::new();
        let mut keys = Vec::with_capacity(events.len());
        for e in &events {
            let (id, audio) = self.source(&tl.sources[e.source].path)?;
            let out_len = (e.dur_beats * fpb).round() as usize + release_frames(e, sr);
            let key = (cache_key(id, e), out_len);
            if !self.cache.contains_key(&key) && !jobs.iter().any(|j| j.0 == key) {
                jobs.push((key, e, audio));
            }
            keys.push(key);
        }
        let rendered = jobs.len();
        for (key, buf) in render_all(&jobs, fpb, self.sample_rate) {
            self.cache.insert(key, Arc::new(buf));
        }

        // One stem per track (in score order; events of unknown tracks get their own stems).
        let mut lanes: Vec<(String, Vec<Placement>)> = tl.tracks.iter().map(|t| (t.name.clone(), Vec::new())).collect();
        for (e, key) in events.iter().zip(&keys) {
            let i = match lanes.iter().position(|(n, _)| *n == e.track) {
                Some(i) => i,
                None => {
                    lanes.push((e.track.clone(), Vec::new()));
                    lanes.len() - 1
                }
            };
            lanes[i].1.push(Placement {
                start: ((e.start_beat - b0) * fpb).round().max(0.0) as usize,
                skip: ((b0 - e.start_beat) * fpb).round().max(0.0) as usize,
                buf: self.cache[key].clone(),
                gain: 10f32.powf(e.gain_db as f32 / 20.0),
            });
        }

        // Forget renders the new arrangement doesn't use (the old arrangement keeps its own Arcs).
        let used: std::collections::HashSet<_> = keys.iter().collect();
        self.cache.retain(|k, _| used.contains(k));

        let length = ((b1 - b0) * fpb).round() as usize;
        // Track stems, then their effects. A comp keyed by another track (sidechain) waits for that
        // track's finished stem, so tracks are processed in key order.
        let raw: Vec<(String, Stereo)> = lanes.into_iter().filter(|(_, p)| !p.is_empty()).map(|(name, p)| { let b = sum_placements(length, &p); (name, b) }).collect();
        let info = |name: &str| tl.tracks.iter().find(|t| t.name == name);
        let keys_of = |name: &str| -> Vec<String> {
            info(name).map_or_else(Vec::new, |t| t.effects.iter().filter_map(|e| if let apricity_score::score::Effect::Comp(c) = e { c.sidechain.clone() } else { None }).collect())
        };
        let present: Vec<String> = raw.iter().map(|(n, _)| n.clone()).collect();
        let mut done: master::Keys = HashMap::new();
        let mut finished: HashMap<String, (Arc<Stereo>, master::Reductions)> = HashMap::new();
        let mut pending: Vec<(String, Stereo)> = raw;
        while !pending.is_empty() {
            // Ready: every key it listens to is finished (or not rendered here at all).
            let ready = pending.iter().position(|(n, _)| keys_of(n).iter().all(|k| done.contains_key(k) || !present.contains(k))).unwrap_or(0);
            let (name, mut buf) = pending.remove(ready);

            // Apply the header filter's automation (cutoff and/or resonance), if it has any; the
            // resonance lane, if present, is consumed here and kept out of the chain effects below
            // (see the `effect_lanes` filtering), since the header owns `filter.res` when it has one.
            if let Some(t) = info(&name) {
                if let Some(filter_spec) = t.filter {
                    let cutoff_lane = t.automation.iter().find(|l| l.target == "filter");
                    let res_lane = t.automation.iter().find(|l| l.target == "filter.res");
                    if cutoff_lane.is_some() || res_lane.is_some() {
                        filter_sweep(&mut buf, filter_spec, cutoff_lane, res_lane, sr, 60.0 / tl.tempo, b0);
                    }
                }
            }

            let (buf, red) = match info(&name) {
                Some(t) => {
                    // A track with a header filter claims `filter.res` for it; a filter *effect*'s
                    // own resonance always uses `filter.cutoff`/`filter.res` too, but only a group or
                    // return (which have no header filter) can be ambiguous-free here, so strip the
                    // lane when this track has a header filter (handled above instead).
                    let has_header_filter = t.filter.is_some();
                    let effect_lanes: std::borrow::Cow<[apricity_score::compile::Lane]> = if has_header_filter {
                        std::borrow::Cow::Owned(t.automation.iter().filter(|l| l.target != "filter.res").cloned().collect())
                    } else {
                        std::borrow::Cow::Borrowed(&t.automation)
                    };
                    master::process_chain(&buf, &t.effects, sr, fpb, master::INSERT_WET, &done, &effect_lanes, b0)
                },
                None => (buf, Vec::new()),
            };
            let buf = Arc::new(buf);
            done.insert(name.clone(), buf.clone());
            finished.insert(name, (buf, red));
        }
        let tracks = present
            .into_iter()
            .map(|name| {
                let t = info(&name);
                let (buf_arc, reductions) = finished.remove(&name).expect("processed above");

                // Apply volume and pan automation after effects
                let original_pan = t.map_or(0.0, |t| t.pan as f32);
                let automation = t.map_or_else(Vec::new, |t| t.automation.clone());
                let mut buf_data = (*buf_arc).clone();
                let pan_baked = apply_track_automation(&mut buf_data, &automation, sr, 60.0 / tl.tempo, b0);
                let pan_override = if pan_baked { 0.0 } else { original_pan };

                TrackStem {
                    buf: Arc::new(buf_data),
                    pan: pan_override,
                    out: t.map_or_else(|| "master".into(), |t| t.out.clone()),
                    sends: t.map_or_else(Vec::new, |t| t.sends.iter().map(|(b, l)| (b.clone(), *l as f32)).collect()),
                    reductions,
                    automation,
                    name,
                }
            })
            .collect();
        let buses = tl.buses.iter().map(|b| BusDef { name: b.name.clone(), effects: b.effects.clone(), gain: 10f32.powf(b.gain_db as f32 / 20.0), out: b.out.clone(), wet: if b.kind == "return" { 1.0 } else { master::INSERT_WET }, automation: b.automation.clone() }).collect();
        let mut mix = Mix { sample_rate: self.sample_rate, frames_per_beat: fpb, beats_per_bar: tl.meter, length, tracks, buses, master: master::params(&tl.master.effects, true), offset_beats: b0 };
        let (mut arr, bus_report) = mix.build(&HashMap::new());
        self.bus_report = bus_report;
        let target = tl.master.loudness.unwrap_or(DEFAULT_LOUDNESS);
        mix.master.gain_db = master::loudness_gain(&arr.bounce_raw(), arr.master, sr, target);
        arr.master = mix.master;
        self.mix = Some(mix);
        Ok((arr, ArrangeStats { events: events.len(), rendered, reused: events.len() - rendered }))
    }
}

impl Renderer {
    /// Rebuild the last arrangement with new live controls baked into its buses (no re-render of
    /// events; buses re-run their effects). `None` before the first `arrange`.
    pub fn remix(&self, controls: &HashMap<String, TrackControl>) -> Option<Arrangement> {
        self.mix.as_ref().map(|m| m.arrangement(controls))
    }

    /// The last mix graph (track and bus names, routing, track compressor reports).
    pub fn mix(&self) -> Option<&Mix> {
        self.mix.as_ref()
    }

    /// Each bus's compressor gain reduction in the last arrangement.
    pub fn bus_report(&self) -> &[(String, master::Reductions)] {
        &self.bus_report
    }
}

#[cfg(not(target_family = "wasm"))]
fn render_all(jobs: &[((CacheKey, usize), &Event, Arc<Audio>)], fpb: f64, sr: u32) -> Vec<((CacheKey, usize), Stereo)> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out = std::sync::Mutex::new(Vec::with_capacity(jobs.len()));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(jobs.len().max(1));
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((key, e, audio)) = jobs.get(i) else { break };
                let r = render_event(e, audio, fpb, sr, key.1);
                out.lock().unwrap().push((*key, r));
            });
        }
    });
    out.into_inner().unwrap()
}

#[cfg(target_family = "wasm")]
fn render_all(jobs: &[((CacheKey, usize), &Event, Arc<Audio>)], fpb: f64, sr: u32) -> Vec<((CacheKey, usize), Stereo)> {
    jobs.iter().map(|(key, e, audio)| (*key, render_event(e, audio, fpb, sr, key.1))).collect()
}

/// Warp + transpose one event to stereo at `out_sr`, exactly `out_len` frames (the note's own
/// length, plus its release when it has one — see `release_frames`).
pub fn render_event(e: &Event, src: &Audio, frames_per_beat: f64, out_sr: u32, out_len: usize) -> Stereo {
    let rel = release_frames(e, out_sr as f64).min(out_len);
    let body_len = out_len - rel;
    let sr_in = src.sr as f64;
    let n = src.channels[0].len();
    let a = ((e.src_start * sr_in).floor().max(0.0) as usize).min(n);
    let b = ((e.src_end * sr_in).ceil() as usize).min(n);
    let mut body: Stereo = if b <= a || body_len == 0 {
        [vec![0.0; body_len], vec![0.0; body_len]]
    } else if e.mode == WarpModeSpec::Repitch {
        // Unwarped: varispeed straight from the source (speed, pitch and any rate change in one
        // band-limited read), no Rubber Band.
        let start = e.src_start * sr_in;
        let step = (e.src_end - e.src_start) * sr_in / body_len as f64;
        let mut chans: Vec<Vec<f32>> = src.channels.iter().take(2).map(|c| apricity_dsp::resample::varispeed(c, start, step, body_len)).collect();
        let right = chans.get(1).cloned().unwrap_or_else(|| chans[0].clone());
        [std::mem::take(&mut chans[0]), right]
    } else {
        let input: Vec<Vec<f32>> = src.channels.iter().take(2).map(|c| c[a..b].to_vec()).collect();
        // Key frames put each source beat at its score beat. Output positions are in out_sr samples
        // while Rubber Band runs at the source rate, so the rate change is folded into the stretch
        // (positions) and the pitch (sr_in / out_sr): resampling happens in the same pass.
        let key_frames: Vec<(usize, usize)> = e
            .warp
            .iter()
            .map(|&(sec, beat)| (((sec * sr_in).round() as usize).saturating_sub(a), (beat * frames_per_beat).round() as usize))
            .filter(|&(i, o)| i > 0 && o > 0 && i < b - a && o < body_len)
            .collect();
        let params = StretchParams {
            time_ratio: body_len as f64 / (b - a) as f64,
            semitones: e.semitones as f64 + e.tuning_cents / 100.0 + 12.0 * (sr_in / out_sr as f64).log2(),
            key_frames,
            mode: match e.mode {
                WarpModeSpec::Beats => WarpMode::Beats,
                WarpModeSpec::Complex => WarpMode::Complex,
                WarpModeSpec::Texture | WarpModeSpec::Repitch => WarpMode::Texture,
            },
            preserve_formants: false,
        };
        let mut out = stretch_offline(&input, src.sr, &params);
        for c in out.iter_mut() {
            c.resize(body_len, 0.0);
        }
        let right = out.get(1).cloned().unwrap_or_else(|| out[0].clone());
        [std::mem::take(&mut out[0]), right]
    };

    // Flips applied to the body, before the release tail is appended and before the envelope: filter,
    // then reverse. So the envelope (below) always lands at the start/end as heard, whichever way the
    // clip plays, and the tail (never itself reversed — it's what plays *after* the reversed note) is
    // unaffected by it.
    if let Some(f) = e.filter {
        for c in body.iter_mut() {
            biquad(c, f, out_sr as f64);
        }
    }
    if e.reverse {
        for c in body.iter_mut() {
            c.reverse();
        }
    }

    if rel == 0 {
        return finish(body, e, out_sr, out_len, body_len);
    }
    // The release tail: the source's own continuation past `src_end`, read forward at the same
    // rate the body was played at (so a pitched or `warp repitch` note's tail keeps its pitch/speed).
    // Reading past the end of the source (`n`) naturally yields silence (varispeed has nothing to
    // read there), which is exactly the "sample runs out" case.
    let rate = if b > a && body_len > 0 { (b - a) as f64 / body_len as f64 } else { 1.0 };
    let mut tail: Vec<Vec<f32>> = src.channels.iter().take(2).map(|c| apricity_dsp::resample::varispeed(c, b as f64, rate, rel)).collect();
    if let Some(f) = e.filter {
        for c in tail.iter_mut() {
            biquad(c, f, out_sr as f64);
        }
    }
    let tail_r = tail.get(1).cloned().unwrap_or_else(|| tail[0].clone());
    let full: Stereo = [[body[0].clone(), std::mem::take(&mut tail[0])].concat(), [body[1].clone(), tail_r].concat()];
    finish(full, e, out_sr, out_len, body_len)
}

/// The click-free edges: the attack/release envelope when the event has one (else the old 4 ms
/// fade on both edges, bit-identical to a score with no envelope). When only one of attack/release
/// is set, the other edge keeps its 4 ms fade so there's still no click there.
fn finish(mut lr: Stereo, e: &Event, out_sr: u32, out_len: usize, body_len: usize) -> Stereo {
    if e.attack_s.is_none() && e.release_s.is_none() {
        let fade = ((FADE_S * out_sr as f64) as usize).min(out_len / 2);
        for c in lr.iter_mut() {
            for i in 0..fade {
                let g = i as f32 / fade as f32;
                c[i] *= g;
                c[out_len - 1 - i] *= g;
            }
        }
        return lr;
    }
    let attack_frames = ((e.attack_s.unwrap_or(0.0) * out_sr as f64).round() as usize).min(body_len);
    let rel = out_len - body_len;
    for c in lr.iter_mut() {
        for (i, v) in c.iter_mut().enumerate() {
            *v *= envelope_gain(i, out_len, attack_frames, body_len, rel);
        }
    }
    if e.attack_s.is_none() {
        let fade = ((FADE_S * out_sr as f64) as usize).min(out_len / 2);
        for c in lr.iter_mut() {
            for i in 0..fade {
                c[i] *= i as f32 / fade as f32;
            }
        }
    }
    if e.release_s.is_none() {
        let fade = ((FADE_S * out_sr as f64) as usize).min(out_len / 2);
        for c in lr.iter_mut() {
            for i in 0..fade {
                c[out_len - 1 - i] *= i as f32 / fade as f32;
            }
        }
    }
    lr
}

/// 12 or 24 dB/octave low- or high-pass (RBJ cookbook biquad), in place. `res` 0 maps to the
/// default Q of 1/√2 (today's gentle response, bit-identical to before this had resonance); slope
/// 12 runs one biquad pass, 24 cascades two.
pub fn biquad(x: &mut [f32], f: FilterSpec, sr: f64) {
    let (hz, low, res, slope) = match f {
        FilterSpec::Lowpass { hz, res, slope } => (hz, true, res, slope),
        FilterSpec::Highpass { hz, res, slope } => (hz, false, res, slope),
    };
    let q = std::f64::consts::FRAC_1_SQRT_2 * 20f64.powf(res);
    for _ in 0..(slope / 12).max(1) {
        biquad_pass(x, hz, low, q, sr);
    }
}

/// One RBJ cookbook biquad pass, in place.
fn biquad_pass(x: &mut [f32], hz: f64, low: bool, q: f64, sr: f64) {
    let w = 2.0 * std::f64::consts::PI * (hz.clamp(10.0, sr * 0.45)) / sr;
    let (sin, cos) = w.sin_cos();
    let alpha = sin / (2.0 * q);
    let (b0, b1, b2) = if low { ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0) } else { ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0) };
    let (a0, a1, a2) = (1.0 + alpha, -2.0 * cos, 1.0 - alpha);
    let (b0, b1, b2, a1, a2) = (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for v in x.iter_mut() {
        let x0 = *v as f64;
        let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        (x2, x1, y2, y1) = (x1, x0, y1, y0);
        *v = y0 as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / 48000.0).sin() as f32).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// A minimal event: `Repitch` mode (plain varispeed, no Rubber Band) so tests can reason about
    /// exact sample positions. `src_start`/`src_end` span one second 1:1 at 48 kHz by default.
    fn base_event() -> Event {
        Event {
            track: "t".into(),
            source: 0,
            start_beat: 0.0,
            dur_beats: 1.0,
            src_start: 0.0,
            src_end: 1.0,
            warp: Vec::new(),
            semitones: 0,
            tuning_cents: 0.0,
            gain_db: 0.0,
            mode: WarpModeSpec::Repitch,
            reverse: false,
            filter: None,
            piece: 0,
            velocity: None,
            attack_s: None,
            release_s: None,
            midi: None,
        }
    }

    fn audio(sr: u32, channels: Vec<f32>) -> Audio {
        Audio { sr, channels: vec![channels.clone(), channels] }
    }

    #[test]
    fn envelope_gain_exact_values() {
        // Attack: raised-cosine ramp from 0 (i=0) up to (not including) full volume at i=attack_frames.
        let (attack, len) = (4, 100);
        assert_eq!(envelope_gain(0, len, attack, len, 0), 0.0);
        assert!((envelope_gain(1, len, attack, len, 0) - 0.14644661).abs() < 1e-6);
        assert!((envelope_gain(2, len, attack, len, 0) - 0.5).abs() < 1e-6);
        assert!((envelope_gain(3, len, attack, len, 0) - 0.85355339).abs() < 1e-6);
        assert_eq!(envelope_gain(4, len, attack, len, 0), 1.0); // past the attack window: full volume
        assert_eq!(envelope_gain(99, len, attack, len, 0), 1.0);

        // Release: raised-cosine fade from full volume at the release start down toward 0.
        let (release_start, release, len) = (100, 4, 104);
        assert_eq!(envelope_gain(50, len, 0, release_start, release), 1.0); // before release: untouched
        assert_eq!(envelope_gain(100, len, 0, release_start, release), 1.0); // release_start itself: still full
        assert!((envelope_gain(101, len, 0, release_start, release) - 0.85355339).abs() < 1e-6);
        assert!((envelope_gain(102, len, 0, release_start, release) - 0.5).abs() < 1e-6);
        assert!((envelope_gain(103, len, 0, release_start, release) - 0.14644661).abs() < 1e-6);

        // Both windows combine multiplicatively (only matters when they'd overlap on a tiny note):
        // attack 6 frames, release starting at 4 for 4 frames, at i=5 both are partway through.
        assert!((envelope_gain(5, 10, 6, 4, 4) - 0.796_375).abs() < 1e-4);
    }

    #[test]
    fn no_attack_or_release_is_bit_identical_to_the_old_edge_fade() {
        let src = audio(48000, vec![0.7; 48000]);
        let e = base_event();
        let got = render_event(&e, &src, 48000.0, 48000, 48000);

        // Reproduce the pre-envelope path by hand: the same varispeed body, then the old symmetric
        // 4 ms edge fade (no attack/release at all).
        let mut want = apricity_dsp::resample::varispeed(&src.channels[0], 0.0, 1.0, 48000);
        let fade = (FADE_S * 48000.0) as usize;
        for i in 0..fade {
            let g = i as f32 / fade as f32;
            want[i] *= g;
            want[47999 - i] *= g;
        }
        assert_eq!(got[0], want);
        assert_eq!(got[1], want);
    }

    #[test]
    fn attack_ramps_a_constant_source_in_from_silence() {
        let src = audio(48000, vec![1.0; 96000]);
        let mut e = base_event();
        e.src_end = 1.0; // 1 second body, 1:1
        e.attack_s = Some(0.1); // 100 ms
        let out = render_event(&e, &src, 48000.0, 48000, 48000);
        let first_10ms = rms(&out[0][..480]);
        let at_150ms = rms(&out[0][7200..7680]);
        assert!(at_150ms > 0.9, "past the attack the level should be ~1.0, got {at_150ms}");
        let db = 20.0 * (first_10ms / at_150ms).log10();
        assert!(db <= -20.0, "first 10ms ({first_10ms}) should be at least 20dB below 150ms ({at_150ms}), got {db}dB");
    }

    #[test]
    fn release_extends_the_note_with_the_sources_own_continuation() {
        // A 440 Hz tone long enough that the body (1s) and the release tail (300ms) both read real
        // source audio, so the tail is a genuine continuation, not silence.
        let src_len = 80_000;
        // A non-round frequency, so no probed sample happens to land on a zero crossing.
        let tone: Vec<f32> = (0..src_len).map(|i| (2.0 * std::f64::consts::PI * 442.7 * i as f64 / 48000.0).sin() as f32).collect();
        let src = audio(48000, tone.clone());
        let mut e = base_event();
        e.src_end = 1.0; // body: source[0..48000), 1:1
        e.release_s = Some(0.3); // 300 ms = 14400 frames
        let body_len = 48000;
        let release_frames_expected = 14400;
        let out_len = body_len + release_frames_expected;
        let out = render_event(&e, &src, 48000.0, 48000, out_len);

        // The rendered note is exactly 300ms (14400 frames) longer than its written length.
        assert_eq!(out[0].len(), body_len + release_frames_expected);

        // 100ms past the written end (frame 52800): non-silent, and matches the source's own
        // continuation (tone[52800]) scaled by the release envelope at that point.
        let idx = body_len + 4800; // 100ms into the release
        let g = envelope_gain(idx, out_len, 0, body_len, release_frames_expected);
        assert!(out[0][idx].abs() > 1e-3, "should be non-silent 100ms into the release, got {}", out[0][idx]);
        assert!((out[0][idx] - tone[idx] * g).abs() < 1e-3, "got {} want ~{}", out[0][idx], tone[idx] * g);

        // The last 1 ms (48 frames) is below -60 dBFS.
        let tail_rms = rms(&out[0][out_len - 48..]);
        assert!(tail_rms < 10f64.powf(-60.0 / 20.0), "last 1ms should be below -60dBFS, rms {tail_rms}");
    }

    #[test]
    fn release_running_off_the_sample_end_gives_silence_without_panicking() {
        // A very short sample: the release asks for far more tail than the source has left.
        let src = audio(48000, vec![1.0; 4800]); // 100ms, exactly the body's length
        let mut e = base_event();
        e.src_end = 0.1; // body: source[0..4800), all of it
        e.release_s = Some(0.5); // 500ms tail requested; nothing left to read
        let body_len = 4800;
        let release_frames = 24000;
        let out = render_event(&e, &src, 48000.0, 48000, body_len + release_frames);
        assert_eq!(out[0].len(), body_len + release_frames);
        assert!(out[0].iter().all(|v| v.is_finite()), "no NaN/inf reading past the source's end");
        // The interpolation kernel blurs a handful of frames right at the edge; well past that (100
        // frames in), there's nothing left to read and it's exactly silent.
        assert!(out[0][body_len + 100..].iter().all(|&v| v == 0.0), "running off the end should settle to silence, not garbage");
    }

    #[test]
    fn cache_key_distinguishes_notes_that_differ_only_in_release() {
        let mut a = base_event();
        let mut b = base_event();
        a.release_s = Some(0.1);
        b.release_s = Some(0.4);
        assert_ne!(cache_key(0, &a), cache_key(0, &b));
        let mut c = base_event();
        let mut d = base_event();
        c.attack_s = Some(0.01);
        d.attack_s = Some(0.05);
        assert_ne!(cache_key(0, &c), cache_key(0, &d));
    }

    #[test]
    fn filters_pass_and_cut_where_they_should() {
        let n = 48000;
        let lp = |hz| FilterSpec::Lowpass { hz, res: 0.0, slope: 12 };
        let hp = |hz| FilterSpec::Highpass { hz, res: 0.0, slope: 12 };
        for (hz, f, keep) in [(100.0, lp(1000.0), true), (8000.0, lp(1000.0), false), (8000.0, hp(1000.0), true), (100.0, hp(1000.0), false)] {
            let mut x = sine(hz, n);
            let before = rms(&x[n / 2..]);
            biquad(&mut x, f, 48000.0);
            let ratio = rms(&x[n / 2..]) / before;
            if keep {
                assert!(ratio > 0.9, "{hz} Hz through {f:?}: {ratio}");
            } else {
                assert!(ratio < 0.05, "{hz} Hz through {f:?}: {ratio}");
            }
        }
    }

    /// With no `res` and the default (12 dB) slope, `biquad` must be byte-identical to the plain
    /// RBJ biquad this crate rendered before resonance/slope existed (the pre-feature arithmetic is
    /// reproduced here literally, hardcoding Q = 1/√2 instead of going through `res`/`20f64.powf`).
    #[test]
    fn header_filter_with_no_res_is_bit_identical_to_the_old_plain_biquad() {
        fn old_biquad(x: &mut [f32], hz: f64, low: bool, sr: f64) {
            let w = 2.0 * std::f64::consts::PI * (hz.clamp(10.0, sr * 0.45)) / sr;
            let (sin, cos) = w.sin_cos();
            let alpha = sin / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
            let (b0, b1, b2) = if low { ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0) } else { ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0) };
            let (a0, a1, a2) = (1.0 + alpha, -2.0 * cos, 1.0 - alpha);
            let (b0, b1, b2, a1, a2) = (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
            let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for v in x.iter_mut() {
                let x0 = *v as f64;
                let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
                (x2, x1, y2, y1) = (x1, x0, y1, y0);
                *v = y0 as f32;
            }
        }
        let n = 48000;
        for (hz, low) in [(800.0, true), (250.0, false), (12000.0, true), (30.0, false)] {
            let mut got = sine(hz * 1.3, n);
            let mut want = got.clone();
            biquad(&mut got, if low { FilterSpec::Lowpass { hz, res: 0.0, slope: 12 } } else { FilterSpec::Highpass { hz, res: 0.0, slope: 12 } }, 48000.0);
            old_biquad(&mut want, hz, low, 48000.0);
            assert_eq!(got, want, "hz {hz} low {low}: not bit-identical to the pre-resonance biquad");
        }
    }

    #[test]
    fn pan_automation_bakes_left_to_right() {
        use apricity_score::compile::Lane;
        // Constant 0.5 on both channels, 4 bars at 120 bpm, 48 kHz
        // Pan from -1.0 (L>>R) to 1.0 (R>>L) over 16 beats
        let n = 16 * 24000; // 16 beats * 24000 samples/beat
        let mut buf = [vec![0.5; n], vec![0.5; n]];
        let lane = Lane {
            target: "pan".to_string(),
            step: false,
            points: vec![[0.0, -1.0], [16.0, 1.0]],
        };
        let pan_baked = apply_track_automation(&mut buf, &[lane], 48000.0, 0.5, 0.0);

        assert!(pan_baked, "pan automation should return true");

        // At frame 0: -1.0 pan means L >> R
        let (l0, r0) = (buf[0][0], buf[1][0]);
        assert!(l0 > 0.4 && l0 <= 0.5, "frame 0 left should be ~0.5, got {}", l0);
        assert!(r0 < 0.1, "frame 0 right should be ~0, got {}", r0);

        // At last frame: 1.0 pan means R >> L
        let (l_end, r_end) = (buf[0][n - 1], buf[1][n - 1]);
        assert!(l_end < 0.1, "last frame left should be ~0, got {}", l_end);
        assert!(r_end > 0.4 && r_end <= 0.5, "last frame right should be ~0.5, got {}", r_end);
    }

    #[test]
    fn step_volume_automation_jumps_at_beat() {
        use apricity_score::compile::Lane;
        // Constant 0.5, step volume [[0,-60],[4,0]]
        // 4 beats = 4 * 0.5 * 48000 = 96000 frames
        let n = 96001; // Enough to access frame 96000
        let mut buf = [vec![0.5; n], vec![0.5; n]];
        let lane = Lane {
            target: "volume".to_string(),
            step: true,
            points: vec![[0.0, -60.0], [4.0, 0.0]],
        };
        apply_track_automation(&mut buf, &[lane], 48000.0, 0.5, 0.0);

        // Frame 95999 (just before beat 4): -60dB in step mode
        assert!(buf[0][95999].abs() < 1e-6, "frame 95999 should be 0");

        // Frame 96000 (exactly at beat 4): 0dB step
        assert!((buf[0][96000] - 0.5).abs() < 1e-6, "frame 96000 should be 0.5");
    }

    #[test]
    fn linear_volume_automation_ramps() {
        use apricity_score::compile::Lane;
        // Linear volume [[0,-60],[4,0]]
        // Frame 48000 = beat 2 = midpoint, should be -30dB = 0.5 * 10^(-30/20)
        let n = 4 * 24000;
        let mut buf = [vec![0.5; n], vec![0.5; n]];
        let lane = Lane {
            target: "volume".to_string(),
            step: false,
            points: vec![[0.0, -60.0], [4.0, 0.0]],
        };
        apply_track_automation(&mut buf, &[lane], 48000.0, 0.5, 0.0);

        // At beat 2 (frame 48000): linear interpolation at midpoint = -30dB
        let expected = 0.5 * 10f32.powf(-30.0 / 20.0);
        assert!((buf[0][48000] - expected).abs() < 1e-3, "frame 48000 should be ~{}, got {}", expected, buf[0][48000]);
    }

    #[test]
    fn offset_beats_shifts_automation() {
        use apricity_score::compile::Lane;
        // Offset by 4 beats: frame 0 should evaluate at beat 4, which is 0dB
        let n = 100;
        let mut buf = [vec![0.5; n], vec![0.5; n]];
        let lane = Lane {
            target: "volume".to_string(),
            step: false,
            points: vec![[0.0, -60.0], [4.0, 0.0]],
        };
        apply_track_automation(&mut buf, &[lane], 48000.0, 0.5, 4.0);

        // At frame 0 with offset 4: evaluates at beat 4 = 0dB
        assert!((buf[0][0] - 0.5).abs() < 1e-6, "frame 0 with offset 4 should be 0.5");
    }

    // Seeded LCG for reproducible white noise
    struct Lcg {
        state: u64,
    }

    impl Lcg {
        fn new(seed: u64) -> Self {
            Lcg { state: seed }
        }

        fn next(&mut self) -> f32 {
            self.state = self.state.wrapping_mul(1103515245).wrapping_add(12345);
            ((self.state >> 8) as f32 / 16777215.0 - 0.5) * 0.1 // Scale down to [-0.05, 0.05]
        }
    }

    /// Measure RMS energy in time domain (simpler and more robust).
    fn rms_db(x: &[f32]) -> f64 {
        let ms: f64 = x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64;
        if ms > 0.0 {
            10.0 * ms.log10()
        } else {
            -160.0
        }
    }

    /// Energy in dB of the part of `x` above (`high`) or below `hz`, measured through a 12 dB/oct filter.
    fn band_db(x: &[f32], hz: f64, high: bool) -> f64 {
        let mut y = x.to_vec();
        biquad(&mut y, if high { FilterSpec::Highpass { hz, res: 0.0, slope: 12 } } else { FilterSpec::Lowpass { hz, res: 0.0, slope: 12 } }, 48000.0);
        rms_db(&y)
    }

    #[test]
    fn filter_sweep_lowpass_automation_reduces_high_freq() {
        use apricity_score::compile::Lane;
        // 8 beats at 120 BPM, 48 kHz = 8 * 0.5 * 48000 = 192000 frames
        // Lowpass automation: 200 Hz at beat 0, 20000 Hz at beat 8
        let sr = 48000.0;
        let frames = 192000;
        let mut lcg = Lcg::new(42);
        let mut buf = [
            (0..frames).map(|_| lcg.next()).collect::<Vec<_>>(),
            (0..frames).map(|_| lcg.next()).collect::<Vec<_>>(),
        ];

        let lane = Lane {
            target: "filter".to_string(),
            step: false,
            points: vec![[0.0, 200.0], [8.0, 20000.0]],
        };

        filter_sweep(&mut buf, FilterSpec::Lowpass { hz: 0.0, res: 0.0, slope: 12 }, Some(&lane), None, sr, 0.5, 0.0);

        // First half-bar (beat 0-0.5): 200 Hz lowpass, removes most energy
        let first_half = &buf[0][0..24000]; // 0.5 beat = 24000 frames
        let energy_first = band_db(first_half, 5000.0, true);

        // Last half-bar (beat 7.5-8): ~20kHz lowpass, passes most energy
        let last_half = &buf[0][frames - 24000..frames];
        let energy_last = band_db(last_half, 5000.0, true);

        // Overall energy should be higher (less attenuated) in last half than first half
        // Expect at least 1 dB difference from the filter sweep
        assert!(energy_last > energy_first + 20.0,
            "lowpass sweep: energy above 5 kHz, last half {:.1} dB should be above first half {:.1} dB",
            energy_last, energy_first);
    }

    #[test]
    fn filter_sweep_step_mode_jumps_at_beat() {
        use apricity_score::compile::Lane;
        // 10 beats at 120 BPM, 48 kHz = 10 * 0.5 * 48000 = 240000 frames
        // Step filter: 1000 Hz until beat 4, then 10000 Hz
        let sr = 48000.0;
        let frames = 240000;
        let mut lcg = Lcg::new(123);
        let mut buf = [
            (0..frames).map(|_| lcg.next()).collect::<Vec<_>>(),
            (0..frames).map(|_| lcg.next()).collect::<Vec<_>>(),
        ];

        let lane = Lane {
            target: "filter".to_string(),
            step: true,
            points: vec![[0.0, 1000.0], [4.0, 1000.0], [4.0, 10000.0]],
        };

        filter_sweep(&mut buf, FilterSpec::Lowpass { hz: 0.0, res: 0.0, slope: 12 }, Some(&lane), None, sr, 0.5, 0.0);

        // Before beat 4 (frames 91200-96000): 1000 Hz lowpass
        let before = &buf[0][91200..96000];
        let energy_before = band_db(before, 5000.0, true);

        // After beat 4 (frames 96000-100800): ~10000 Hz lowpass
        let after = &buf[0][96000..100800];
        let energy_after = band_db(after, 5000.0, true);

        // Energy should be higher after the step cutoff jump (filter opens)
        // Expect at least 0.3 dB difference from the step jump
        assert!(energy_after > energy_before + 10.0,
            "step filter: after beat 4 energy {:.1} dB should be above before {:.1} dB",
            energy_after, energy_before);
    }

    #[test]
    fn filter_sweep_highpass_automation_increases_high_freq() {
        use apricity_score::compile::Lane;
        // 8 beats at 120 BPM, 48 kHz = 8 * 0.5 * 48000 = 192000 frames
        // Highpass automation: 20000 Hz at beat 0, 200 Hz at beat 8
        let sr = 48000.0;
        let frames = 192000;
        let mut lcg = Lcg::new(999);
        let mut buf = [
            (0..frames).map(|_| lcg.next()).collect::<Vec<_>>(),
            (0..frames).map(|_| lcg.next()).collect::<Vec<_>>(),
        ];

        let lane = Lane {
            target: "filter".to_string(),
            step: false,
            points: vec![[0.0, 20000.0], [8.0, 200.0]],
        };

        filter_sweep(&mut buf, FilterSpec::Highpass { hz: 0.0, res: 0.0, slope: 12 }, Some(&lane), None, sr, 0.5, 0.0);

        // First half-bar (beat 0-0.5): 20000 Hz highpass, removes most energy
        let first_half = &buf[0][0..24000];
        let energy_first = band_db(first_half, 2000.0, false);

        // Last half-bar (beat 7.5-8): ~200 Hz highpass, passes most energy
        let last_half = &buf[0][frames - 24000..frames];
        let energy_last = band_db(last_half, 2000.0, false);

        // Energy should be higher in last half (highpass opens) than first half
        // Expect at least 0.5 dB difference from the filter sweep
        assert!(energy_last > energy_first + 20.0,
            "highpass sweep: last half energy {:.1} dB should be above first half {:.1} dB",
            energy_last, energy_first);
    }
}
