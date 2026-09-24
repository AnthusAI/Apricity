//! Control-thread side: turn a compiled `Timeline` into an `Arrangement` of pre-rendered stereo
//! buffers. Each distinct event (source span × length × transposition × tuning × mode) is warped
//! once with Rubber Band and cached, so re-arranging after an edit only renders what changed.

use crate::arrangement::{sum_placements, Arrangement, Placement, Stereo, TrackControl};
use crate::master;
use crate::mix::{BusDef, Mix, TrackStem};
use apricity_dsp::{stretch_offline, StretchParams, WarpMode};
use apricity_score::compile::{Event, DEFAULT_LOUDNESS};
use apricity_score::score::{FilterSpec, WarpModeSpec};
use apricity_score::Timeline;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const FADE_S: f64 = 0.004;

/// Decoded source audio, planar.
pub struct Audio {
    pub sr: u32,
    pub channels: Vec<Vec<f32>>,
}

type CacheKey = (usize, u64, u64, u64, i32, i64, u8, bool, i64);

fn cache_key(source: usize, e: &Event) -> CacheKey {
    let q = |x: f64| (x * 1e5).round() as u64;
    let filter = match e.filter {
        None => 0,
        Some(FilterSpec::Lowpass(h)) => h.round() as i64,
        Some(FilterSpec::Highpass(h)) => -(h.round() as i64),
    };
    (source, q(e.src_start), q(e.src_end), q(e.dur_beats * 1e3), e.semitones, (e.tuning_cents * 10.0).round() as i64, e.mode as u8, e.reverse, filter)
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
            let out_len = (e.dur_beats * fpb).round() as usize;
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
            let (name, buf) = pending.remove(ready);
            let (buf, red) = match info(&name) {
                Some(t) => master::process_chain(&buf, &t.effects, sr, fpb, master::INSERT_WET, &done),
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
                let (buf, reductions) = finished.remove(&name).expect("processed above");
                TrackStem {
                    buf,
                    pan: t.map_or(0.0, |t| t.pan as f32),
                    out: t.map_or_else(|| "master".into(), |t| t.out.clone()),
                    sends: t.map_or_else(Vec::new, |t| t.sends.iter().map(|(b, l)| (b.clone(), *l as f32)).collect()),
                    reductions,
                    name,
                }
            })
            .collect();
        let buses = tl.buses.iter().map(|b| BusDef { name: b.name.clone(), effects: b.effects.clone(), gain: 10f32.powf(b.gain_db as f32 / 20.0), out: b.out.clone() }).collect();
        let mut mix = Mix { sample_rate: self.sample_rate, frames_per_beat: fpb, beats_per_bar: tl.meter, length, tracks, buses, master: master::params(&tl.master.effects, true) };
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

/// Warp + transpose one event to stereo at `out_sr`, exactly `out_len` frames.
pub fn render_event(e: &Event, src: &Audio, frames_per_beat: f64, out_sr: u32, out_len: usize) -> Stereo {
    let sr_in = src.sr as f64;
    let n = src.channels[0].len();
    let a = ((e.src_start * sr_in).floor().max(0.0) as usize).min(n);
    let b = ((e.src_end * sr_in).ceil() as usize).min(n);
    if b <= a || out_len == 0 {
        return [vec![0.0; out_len], vec![0.0; out_len]];
    }
    if e.mode == WarpModeSpec::Off {
        // Unwarped: varispeed straight from the source (speed, pitch and any rate change in one
        // band-limited read), no Rubber Band.
        let start = e.src_start * sr_in;
        let step = (e.src_end - e.src_start) * sr_in / out_len as f64;
        let mut chans: Vec<Vec<f32>> = src.channels.iter().take(2).map(|c| apricity_dsp::resample::varispeed(c, start, step, out_len)).collect();
        let right = chans.get(1).cloned().unwrap_or_else(|| chans[0].clone());
        return finish([std::mem::take(&mut chans[0]), right], e, out_sr, out_len);
    }
    let input: Vec<Vec<f32>> = src.channels.iter().take(2).map(|c| c[a..b].to_vec()).collect();
    // Key frames put each source beat at its score beat. Output positions are in out_sr samples
    // while Rubber Band runs at the source rate, so the rate change is folded into the stretch
    // (positions) and the pitch (sr_in / out_sr): resampling happens in the same pass.
    let key_frames: Vec<(usize, usize)> = e
        .warp
        .iter()
        .map(|&(sec, beat)| (((sec * sr_in).round() as usize).saturating_sub(a), (beat * frames_per_beat).round() as usize))
        .filter(|&(i, o)| i > 0 && o > 0 && i < b - a && o < out_len)
        .collect();
    let params = StretchParams {
        time_ratio: out_len as f64 / (b - a) as f64,
        semitones: e.semitones as f64 + e.tuning_cents / 100.0 + 12.0 * (sr_in / out_sr as f64).log2(),
        key_frames,
        mode: match e.mode {
            WarpModeSpec::Beats => WarpMode::Beats,
            WarpModeSpec::Complex => WarpMode::Complex,
            WarpModeSpec::Texture | WarpModeSpec::Off => WarpMode::Texture,
        },
        preserve_formants: false,
    };
    let mut out = stretch_offline(&input, src.sr, &params);
    for c in out.iter_mut() {
        c.resize(out_len, 0.0);
    }
    let right = out.get(1).cloned().unwrap_or_else(|| out[0].clone());
    finish([std::mem::take(&mut out[0]), right], e, out_sr, out_len)
}

/// After warping: the flips (filter, then reverse) and click-free edges.
fn finish(mut lr: Stereo, e: &Event, out_sr: u32, out_len: usize) -> Stereo {
    // Flips applied after warping: filter, then reverse (the edge fades below keep both click-free).
    if let Some(f) = e.filter {
        for c in lr.iter_mut() {
            biquad(c, f, out_sr as f64);
        }
    }
    if e.reverse {
        for c in lr.iter_mut() {
            c.reverse();
        }
    }
    let fade = ((FADE_S * out_sr as f64) as usize).min(out_len / 2);
    for c in lr.iter_mut() {
        for i in 0..fade {
            let g = i as f32 / fade as f32;
            c[i] *= g;
            c[out_len - 1 - i] *= g;
        }
    }
    lr
}

/// 12 dB/octave low- or high-pass (RBJ cookbook biquad, Q = 1/√2), in place.
pub fn biquad(x: &mut [f32], f: FilterSpec, sr: f64) {
    let (hz, low) = match f {
        FilterSpec::Lowpass(h) => (h, true),
        FilterSpec::Highpass(h) => (h, false),
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f64, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / 48000.0).sin() as f32).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn filters_pass_and_cut_where_they_should() {
        let n = 48000;
        for (hz, f, keep) in [(100.0, FilterSpec::Lowpass(1000.0), true), (8000.0, FilterSpec::Lowpass(1000.0), false), (8000.0, FilterSpec::Highpass(1000.0), true), (100.0, FilterSpec::Highpass(1000.0), false)] {
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
}
