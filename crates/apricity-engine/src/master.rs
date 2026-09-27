//! Effect chains: the master chain (real time, fixed-size, no allocation) and offline track
//! inserts. Settings arrive as plain `Copy` data, so a new arrangement can retune a running chain
//! without allocating or resetting filter memory.

use apricity_dsp::color::{self, DriveParams, Gate, GateParams, LofiParams};
use apricity_dsp::fx::{Biquad, BiquadKind, CompParams, Compressor, Eq, EqParams, HarmonicBank, HarmonicChord as DspHarmonicChord, HarmonicMode as DspHarmonicMode, HarmonicParams as DspHarmonicParams, Limiter, MAX_BANDS};
use std::collections::HashMap;
use std::sync::Arc;
use apricity_dsp::space::{Delay, DelayParams, Reverb, ReverbKind, ReverbParams};
use apricity_score::score::{CompSpec, DelaySpec, Effect, EqSpec, FilterFxSpec, FilterKind, HarmonicFxMode, HarmonicSpanSpec, HarmonicSpec, ReverbSpec, ReverbType};
use crate::automation::{Curve, scale_for};
use apricity_score::compile::Lane;

/// Most stages a chain may have.
pub const MAX_STAGES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stage {
    Eq(EqParams),
    Comp(CompParams),
    Limit { ceiling_db: f64, release_ms: f64 },
    Width(f64),
    Filter(FilterParams),
}

/// A resonant filter stage's real-time settings: the resolved biquad response, and how many
/// cascaded passes (1 for 12 dB/octave, 2 for 24).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilterParams {
    pub kind: BiquadKind,
    pub passes: u8,
}

pub fn filter_params(f: &FilterFxSpec) -> FilterParams {
    let q = std::f64::consts::FRAC_1_SQRT_2 * 20f64.powf(f.res);
    let kind = match f.kind {
        FilterKind::Lp => BiquadKind::LowPass { hz: f.hz, q },
        FilterKind::Hp => BiquadKind::HighPass { hz: f.hz, q },
        FilterKind::Bp => BiquadKind::BandPass { hz: f.hz, q },
    };
    FilterParams { kind, passes: (f.slope / 12).max(1) as u8 }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MasterParams {
    pub stages: [Option<Stage>; MAX_STAGES],
    /// Loudness make-up, applied just before the last limiter (or at the end if there is none).
    pub gain_db: f64,
}

pub fn eq_params(e: &EqSpec) -> EqParams {
    let mut p = EqParams::default();
    let q = std::f64::consts::FRAC_1_SQRT_2;
    let bands = e
        .lowcut
        .map(|hz| BiquadKind::HighPass { hz, q })
        .into_iter()
        .chain(e.highcut.map(|hz| BiquadKind::LowPass { hz, q }))
        .chain(e.low.map(|[db, hz]| BiquadKind::LowShelf { hz, db }))
        .chain(e.high.map(|[db, hz]| BiquadKind::HighShelf { hz, db }))
        .chain(e.peaks.iter().map(|&[db, hz, q]| BiquadKind::Peak { hz, db, q }));
    for (slot, b) in p.bands.iter_mut().zip(bands.take(MAX_BANDS)) {
        *slot = Some(b);
    }
    p
}

/// The real-time stage for an effect; `None` for reverb and delay, which only run offline.
pub fn comp_params(c: &CompSpec) -> CompParams {
    let d = CompParams::default();
    CompParams {
        threshold_db: c.threshold,
        ratio: c.ratio,
        attack_ms: c.attack_ms.unwrap_or(d.attack_ms),
        release_ms: c.release_ms.unwrap_or(d.release_ms),
        knee_db: c.knee.unwrap_or(d.knee_db),
        makeup_db: c.makeup.unwrap_or(0.0),
    }
}

/// The real-time stage for an effect; `None` for the effects that only run offline (reverb,
/// delay, drive, lofi, noisegate, and a comp keyed by another track).
pub fn stage(e: &Effect) -> Option<Stage> {
    Some(match e {
        Effect::Eq(q) => Stage::Eq(eq_params(q)),
        Effect::Comp(c) if c.sidechain.is_none() => Stage::Comp(comp_params(c)),
        Effect::Limit(l) => Stage::Limit { ceiling_db: l.ceiling, release_ms: l.release_ms.unwrap_or(50.0) },
        Effect::Width(w) => Stage::Width(*w),
        Effect::Filter(f) => Stage::Filter(filter_params(f)),
        _ => return None,
    })
}

/// Settings for a chain from the score's effects; `safety_limit` appends a −1 dB limiter when the
/// chain has none (the master always ends in a limiter).
pub fn params(effects: &[Effect], safety_limit: bool) -> MasterParams {
    let mut p = MasterParams::default();
    for (slot, st) in p.stages.iter_mut().zip(effects.iter().filter_map(stage).take(MAX_STAGES)) {
        *slot = Some(st);
    }
    let has_limit = p.stages.iter().any(|s| matches!(s, Some(Stage::Limit { .. })));
    if safety_limit && !has_limit {
        let n = p.stages.iter().filter(|s| s.is_some()).count().min(MAX_STAGES - 1);
        p.stages[n] = Some(Stage::Limit { ceiling_db: -1.0, release_ms: 50.0 });
    }
    p
}

/// `HarmonicSpec`'s user-facing fields, with sec 4.4's defaults applied (mirrors how `LofiSpec`/
/// `GateSpec` are resolved elsewhere in this module).
pub fn harmonic_params(spec: &HarmonicSpec) -> DspHarmonicParams {
    let [lo, hi] = spec.range.unwrap_or([80.0, 4000.0]);
    // Sec 4.4: "depth" is the cut depth for `cut`/`both`, and doubles as the boost amount for
    // `boost` when the DSL didn't also write an explicit `boost NdB` (`harmonic boost 6dB` reads
    // that 6dB as depth_db in the parsed spec; here it becomes the boost the DSP layer applies).
    let boost_db = match spec.mode {
        HarmonicFxMode::Boost => spec.boost_db.or(spec.depth_db).unwrap_or(6.0),
        _ => spec.boost_db.unwrap_or(6.0),
    };
    DspHarmonicParams {
        mode: match spec.mode {
            HarmonicFxMode::Cut => DspHarmonicMode::Cut,
            HarmonicFxMode::Boost => DspHarmonicMode::Boost,
            HarmonicFxMode::Both => DspHarmonicMode::Both,
        },
        depth_db: spec.depth_db.unwrap_or(9.0),
        boost_db,
        tolerance_cents: spec.tolerance_cents.unwrap_or(30.0),
        harmonics: spec.harmonics.unwrap_or(6),
        range_lo_hz: lo,
        range_hi_hz: hi,
        tune_hz: spec.tune_hz.unwrap_or(440.0),
        mix: spec.mix.unwrap_or(1.0),
    }
}

/// One compiled `HarmonicSpanSpec` as `HarmonicBank` needs it (sec 4.2/4.5): the bass placed at
/// octave 2, its other chord tones voiced in the nearest octave at or above it (the same "voice
/// up from the bass" idea `Chord::voiced` uses), so `harmonics` has real fundamentals to protect.
fn harmonic_chord(span: &HarmonicSpanSpec, tune_hz: f64) -> DspHarmonicChord {
    let midi_hz = |midi: i32| tune_hz * 2f64.powf((midi as f64 - 69.0) / 12.0);
    let mut tones_pc = [false; 12];
    for &t in &span.tones_pc {
        tones_pc[(t % 12) as usize] = true;
    }
    let bass_midi = 12 * 3 + span.bass_pc as i32; // octave 2
    let bass_hz = midi_hz(bass_midi);
    let mut fundamentals_hz = vec![bass_hz];
    for &t in &span.tones_pc {
        if t == span.bass_pc {
            continue;
        }
        let mut midi = 12 * 4 + t as i32; // start around octave 3, voice up to clear the bass
        while midi <= bass_midi {
            midi += 12;
        }
        fundamentals_hz.push(midi_hz(midi));
    }
    DspHarmonicChord { tones_pc, bass_hz, fundamentals_hz }
}

/// Map effect automation lanes to curves, one Vec per effect index.
/// Returns Vec<Vec<(target_name, Curve)>> where each inner vec has the curves for that effect.
/// "eq.X" targets the 1st Eq, "eq2.X" targets the 2nd Eq, etc.
pub fn chain_curves(
    effects: &[Effect],
    lanes: &[Lane],
    sr: f64,
    secs_per_beat: f64,
    offset_beats: f64,
) -> Vec<Vec<(String, Curve)>> {
    let mut result = vec![Vec::new(); effects.len()];

    // Build a map of (effect_type_prefix, number) → effect_index
    let mut eq_indices = Vec::new();
    let mut comp_indices = Vec::new();
    let mut reverb_indices = Vec::new();
    let mut delay_indices = Vec::new();
    let mut filter_indices = Vec::new();
    let mut harmonic_indices = Vec::new();

    for (idx, effect) in effects.iter().enumerate() {
        match effect {
            Effect::Eq(_) => eq_indices.push(idx),
            Effect::Comp(_) => comp_indices.push(idx),
            Effect::Reverb(_) => reverb_indices.push(idx),
            Effect::Delay(_) => delay_indices.push(idx),
            Effect::Filter(_) => filter_indices.push(idx),
            Effect::Harmonic(_) => harmonic_indices.push(idx),
            _ => {}
        }
    }

    for lane in lanes {
        let target = &lane.target;
        let effect_idx = if target == "width" {
            // Find the Width effect (if it exists)
            effects.iter().position(|e| matches!(e, Effect::Width(_)))
        } else if target.starts_with("eq.") || target.starts_with("eq2.") || target.starts_with("eq3.") || target.starts_with("eq4.") || target.starts_with("eq5.") {
            // Parse eq prefix
            let (eq_num, _) = if target.starts_with("eq2.") {
                (2, "eq2.")
            } else if target.starts_with("eq3.") {
                (3, "eq3.")
            } else if target.starts_with("eq4.") {
                (4, "eq4.")
            } else if target.starts_with("eq5.") {
                (5, "eq5.")
            } else {
                (1, "eq.")
            };
            eq_indices.get(eq_num - 1).copied()
        } else if target.starts_with("comp.") || target.starts_with("comp2.") || target.starts_with("comp3.") || target.starts_with("comp4.") || target.starts_with("comp5.") {
            // Parse comp prefix
            let (comp_num, _) = if target.starts_with("comp2.") {
                (2, "comp2.")
            } else if target.starts_with("comp3.") {
                (3, "comp3.")
            } else if target.starts_with("comp4.") {
                (4, "comp4.")
            } else if target.starts_with("comp5.") {
                (5, "comp5.")
            } else {
                (1, "comp.")
            };
            comp_indices.get(comp_num - 1).copied()
        } else if target.starts_with("reverb.") || target.starts_with("reverb2.") {
            let (reverb_num, _) = if target.starts_with("reverb2.") {
                (2, "reverb2.")
            } else {
                (1, "reverb.")
            };
            reverb_indices.get(reverb_num - 1).copied()
        } else if target.starts_with("delay.") || target.starts_with("delay2.") {
            let (delay_num, _) = if target.starts_with("delay2.") {
                (2, "delay2.")
            } else {
                (1, "delay.")
            };
            delay_indices.get(delay_num - 1).copied()
        } else if target.starts_with("filter.") || target.starts_with("filter2.") {
            let (filter_num, _) = if target.starts_with("filter2.") {
                (2, "filter2.")
            } else {
                (1, "filter.")
            };
            filter_indices.get(filter_num - 1).copied()
        } else if target.starts_with("harmonic.") || target.starts_with("harmonic2.") {
            let (harmonic_num, _) = if target.starts_with("harmonic2.") { (2, "harmonic2.") } else { (1, "harmonic.") };
            harmonic_indices.get(harmonic_num - 1).copied()
        } else {
            None
        };

        if let Some(idx) = effect_idx {
            let points: Vec<(f64, f64)> = lane.points.iter().map(|p| (p[0], p[1])).collect();
            let curve = Curve::from_lane(points, lane.step, scale_for(target), sr, secs_per_beat, offset_beats);
            result[idx].push((target.clone(), curve));
        }
    }

    result
}

enum State {
    Off,
    Width(f64),
    Eq(Eq),
    Comp(Compressor),
    Limit(Limiter),
    /// Up to two cascaded biquads (24 dB/octave uses both) and how many are active.
    Filter([Biquad; 2], u8),
}

/// A running chain. `set` retunes it in place (no allocation), keeping each stage's memory when
/// the stage in that slot is the same kind.
pub struct MasterChain {
    sr: f64,
    params: MasterParams,
    states: [State; MAX_STAGES],
    /// Index of the stage before which `gain_db` is applied.
    gain_at: usize,
}

impl MasterChain {
    pub fn new(sr: f64) -> Self {
        Self { sr, params: MasterParams::default(), states: std::array::from_fn(|_| State::Off), gain_at: 0 }
    }

    pub fn set(&mut self, p: MasterParams) {
        self.params = p;
        for (st, stage) in self.states.iter_mut().zip(p.stages) {
            match (st, stage) {
                (State::Eq(e), Some(Stage::Eq(q))) => e.set(q),
                (State::Comp(c), Some(Stage::Comp(q))) => c.set(q, self.sr),
                (State::Limit(l), Some(Stage::Limit { ceiling_db, release_ms })) => l.set(ceiling_db, release_ms, self.sr),
                (State::Width(w), Some(Stage::Width(v))) => *w = v,
                (State::Filter(bqs, passes), Some(Stage::Filter(fp))) => {
                    bqs[0].set(fp.kind, self.sr);
                    if fp.passes > 1 {
                        bqs[1].set(fp.kind, self.sr);
                    }
                    *passes = fp.passes;
                }
                (st, stage) => {
                    *st = match stage {
                        None => State::Off,
                        Some(Stage::Eq(q)) => State::Eq(Eq::new(q, self.sr)),
                        Some(Stage::Comp(q)) => State::Comp(Compressor::new(q, self.sr)),
                        Some(Stage::Limit { ceiling_db, release_ms }) => State::Limit(Limiter::new(ceiling_db, release_ms, self.sr)),
                        Some(Stage::Width(v)) => State::Width(v),
                        Some(Stage::Filter(fp)) => {
                            let mut bqs = [Biquad::default(); 2];
                            bqs[0].set(fp.kind, self.sr);
                            if fp.passes > 1 {
                                bqs[1].set(fp.kind, self.sr);
                            }
                            State::Filter(bqs, fp.passes)
                        }
                    }
                }
            }
        }
        let last_limit = p.stages.iter().rposition(|s| matches!(s, Some(Stage::Limit { .. })));
        self.gain_at = last_limit.unwrap_or(MAX_STAGES);
    }

    pub fn sample_rate(&self) -> f64 {
        self.sr
    }

    /// Frames of delay the chain adds (limiter look-ahead).
    pub fn latency(&self) -> usize {
        self.states.iter().map(|s| if let State::Limit(l) = s { l.latency() } else { 0 }).sum()
    }

    /// Process a stereo block in place. Real-time safe.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let g = 10f64.powf(self.params.gain_db / 20.0);
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let (mut x, mut y) = (*a as f64, *b as f64);
            for (i, st) in self.states.iter_mut().enumerate() {
                if i == self.gain_at {
                    x *= g;
                    y *= g;
                }
                match st {
                    State::Off => {}
                    State::Eq(e) => {
                        x = e.tick(0, x);
                        y = e.tick(1, y);
                    }
                    State::Comp(c) => (x, y) = c.tick(x, y, x.abs().max(y.abs())),
                    State::Limit(lim) => (x, y) = lim.tick(x, y),
                    State::Width(w) => (x, y) = color::width(x, y, *w),
                    State::Filter(bqs, passes) => {
                        x = bqs[0].tick(0, x);
                        y = bqs[0].tick(1, y);
                        if *passes > 1 {
                            x = bqs[1].tick(0, x);
                            y = bqs[1].tick(1, y);
                        }
                    }
                }
            }
            if self.gain_at >= MAX_STAGES {
                x *= g;
                y *= g;
            }
            *a = x as f32;
            *b = y as f32;
        }
    }

    /// Deepest compressor gain reduction since the last call (dB, ≤ 0), for metering.
    pub fn take_reduction(&mut self) -> f64 {
        self.states.iter_mut().map(|s| if let State::Comp(c) = s { c.take_max_reduction() } else { 0.0 }).fold(0.0, f64::min)
    }
}

/// Run `p` over two cycles of a loop and return the second, lined up with the grid.
pub fn run_looped(buf: &[Vec<f32>; 2], p: MasterParams, sr: f64) -> [Vec<f32>; 2] {
    let mut chain = MasterChain::new(sr);
    chain.set(p);
    let n = buf[0].len();
    let (mut l, mut r) = ([buf[0].as_slice(), buf[0].as_slice()].concat(), [buf[1].as_slice(), buf[1].as_slice()].concat());
    chain.process(&mut l, &mut r);
    let lat = chain.latency();
    let take = |v: &Vec<f32>| (0..n).map(|i| v[(n + i + lat).min(2 * n - 1)]).collect::<Vec<f32>>();
    [take(&l), take(&r)]
}

/// Make-up gain (dB) that brings the master chain's output to `target` LUFS: measured with the
/// limiter bypassed, then refined once through the whole chain (the limiter shaves some loudness
/// off hot mixes). Clamped to ±24 dB; 0 for silence.
pub fn loudness_gain(mix: &[Vec<f32>; 2], p: MasterParams, sr: f64, target: f64) -> f64 {
    let measure = |q: MasterParams| {
        let [l, r] = run_looped(mix, q, sr);
        apricity_dsp::fx::loudness_lufs(&l, &r, sr)
    };
    let mut open = p;
    open.gain_db = 0.0;
    for s in open.stages.iter_mut() {
        if matches!(s, Some(Stage::Limit { .. })) {
            *s = None;
        }
    }
    let first = measure(open);
    if !first.is_finite() {
        return 0.0;
    }
    let mut g = (target - first).clamp(-24.0, 24.0);
    let second = measure(MasterParams { gain_db: g, ..p });
    if second.is_finite() {
        g = (g + (target - second).clamp(-3.0, 3.0)).clamp(-24.0, 24.0);
    }
    g
}

pub fn reverb_params(r: &ReverbSpec) -> ReverbParams {
    let kind = match r.kind {
        ReverbType::Room => ReverbKind::Room,
        ReverbType::Hall => ReverbKind::Hall,
        ReverbType::Plate => ReverbKind::Plate,
    };
    let d = ReverbParams::of(kind);
    ReverbParams { kind, decay_s: r.decay_s.unwrap_or(d.decay_s), predelay_ms: r.predelay_ms.unwrap_or(d.predelay_ms), damp: r.damp.unwrap_or(d.damp) }
}

pub fn delay_params(d: &DelaySpec, frames_per_beat: f64, sr: f64) -> DelayParams {
    let seconds = match (d.beats, d.ms) {
        (Some(b), _) => b * frames_per_beat / sr,
        (None, Some(m)) => m / 1000.0,
        (None, None) => 0.5 * frames_per_beat / sr,
    };
    DelayParams { seconds, feedback: d.feedback.unwrap_or(0.35), highpass: d.highpass, lowpass: d.lowpass, pingpong: d.pingpong }
}

/// How long a chain keeps sounding after its input stops, in seconds.
pub fn tail_s(effects: &[Effect], frames_per_beat: f64, sr: f64) -> f64 {
    effects
        .iter()
        .map(|e| match e {
            Effect::Reverb(r) => reverb_params(r).tail_s(),
            Effect::Delay(d) => delay_params(d, frames_per_beat, sr).tail_s(),
            Effect::Comp(c) => c.release_ms.unwrap_or(100.0) / 1000.0,
            Effect::NoiseGate(g) => (g.hold_ms.unwrap_or(30.0) + g.release_ms.unwrap_or(100.0)) / 1000.0,
            Effect::Eq(_) | Effect::Limit(_) | Effect::Drive(_) | Effect::Lofi(_) | Effect::Width(_) | Effect::Filter(_) | Effect::Harmonic(_) => 0.0,
        })
        .sum()
}

/// Longest audio (seconds) an offline chain renders to settle a loop; tails longer than this
/// minus one loop are cut short where they wrap.
const MAX_SETTLE_S: f64 = 90.0;

/// Sidechain keys: track name → that track's stem (after its own effects).
pub type Keys = HashMap<String, Arc<[Vec<f32>; 2]>>;

/// What a chain did: the deepest gain reduction (dB, ≤ 0) of each compressor over the kept cycle,
/// labelled like the score (`comp 4:1 -14dB`).
pub type Reductions = Vec<(String, f64)>;

/// Create an automated version of an effect by applying curve values to its spec fields.
fn automated_effect(e: &Effect, curves: &[(String, Curve)], frame: u64) -> Effect {
    match e {
        Effect::Eq(spec) => {
            let mut s = spec.clone();
            for (target, curve) in curves {
                let v = curve.value_at(frame);
                if target.contains("highcut") {
                    s.highcut = Some(v);
                } else if target.contains("lowcut") {
                    s.lowcut = Some(v);
                } else if target.contains("low") && !target.contains("lowcut") {
                    if let Some([_, hz]) = s.low {
                        s.low = Some([v, hz]);
                    } else {
                        s.low = Some([v, 200.0]);
                    }
                } else if target.contains("high") && !target.contains("highcut") {
                    if let Some([_, hz]) = s.high {
                        s.high = Some([v, hz]);
                    } else {
                        s.high = Some([v, 3000.0]);
                    }
                }
            }
            Effect::Eq(s)
        }
        Effect::Comp(spec) => {
            let mut s = spec.clone();
            for (target, curve) in curves {
                if target.contains("threshold") {
                    let v = curve.value_at(frame);
                    s.threshold = v;
                }
            }
            Effect::Comp(s)
        }
        Effect::Width(_) => {
            for (target, curve) in curves {
                if target == "width" {
                    let v = curve.value_at(frame);
                    return Effect::Width(v);
                }
            }
            e.clone()
        }
        Effect::Filter(spec) => {
            let mut s = *spec;
            for (target, curve) in curves {
                let v = curve.value_at(frame);
                if target.contains("cutoff") {
                    s.hz = v;
                } else if target.contains("res") {
                    s.res = v;
                }
            }
            Effect::Filter(s)
        }
        _ => e.clone(),
    }
}

/// Run an effect chain over a loop, offline, so the loop joins seamlessly: the loop is processed
/// for as many cycles as the tails need (at least two) and the last cycle is kept, so the reverb
/// and echoes from the end ring on into the start, and compressors start already settled.
/// `wet` is the reverb/delay mix when the effect doesn't set one (1 on a bus, 0.25 on a track).
/// A comp with `sidechain` listens to that track's stem in `keys` (silence if it isn't there).
/// `lanes` are the chain's automation lanes (e.g. `eq.highcut`, `comp.mix`, `reverb.mix`), evaluated at
/// score time: the loop frame plus `offset_beats` (the start of a `--bars` render).
pub fn process_chain(buf: &[Vec<f32>; 2], effects: &[Effect], sr: f64, frames_per_beat: f64, wet: f64, keys: &Keys, lanes: &[Lane], offset_beats: f64) -> ([Vec<f32>; 2], Reductions) {
    let n = buf[0].len();
    let mut reductions = Vec::new();
    if effects.is_empty() || n == 0 {
        return (buf.clone(), reductions);
    }
    let tail = (tail_s(effects, frames_per_beat, sr) * sr) as usize;
    let cycles = (1 + tail.div_ceil(n)).max(2).min(((MAX_SETTLE_S * sr) as usize / n).max(2));
    let last = (cycles - 1) * n;
    let mut b: [Vec<f32>; 2] = [buf[0].iter().copied().cycle().take(n * cycles).collect(), buf[1].iter().copied().cycle().take(n * cycles).collect()];
    let mut lat = 0;
    let label = |c: &CompSpec| format!("comp {}:1 {}dB{}", c.ratio, c.threshold, c.sidechain.as_ref().map_or(String::new(), |k| format!(" sidechain {k}")));

    let effect_curves = chain_curves(effects, lanes, sr, frames_per_beat / sr, offset_beats);
    // A lane's curve for effect `ei` whose target ends in `.{param}` (e.g. "reverb.mix").
    let curve_for = |ei: usize, param: &str| effect_curves[ei].iter().find(|(t, _)| t.rsplit('.').next() == Some(param)).map(|(_, c)| c);

    for (ei, e) in effects.iter().enumerate() {
        let mix = |x: f32, w: f64, m: f64| (x as f64 * (1.0 - m) + w * m) as f32;
        let [l, r] = &mut b;
        match e {
            Effect::Reverb(spec) => {
                let m = spec.mix.unwrap_or(wet);
                let curve = curve_for(ei, "mix");
                let mut rv = Reverb::new(reverb_params(spec), sr);
                for (i, (a, b)) in l.iter_mut().zip(r.iter_mut()).enumerate() {
                    let m = curve.map_or(m, |c| c.value_at((i % n) as u64));
                    let (wl, wr) = rv.tick(*a as f64, *b as f64);
                    (*a, *b) = (mix(*a, wl, m), mix(*b, wr, m));
                }
            }
            Effect::Delay(spec) => {
                let m = spec.mix.unwrap_or(wet);
                let curve = curve_for(ei, "mix");
                let mut d = Delay::new(delay_params(spec, frames_per_beat, sr), sr);
                for (i, (a, b)) in l.iter_mut().zip(r.iter_mut()).enumerate() {
                    let m = curve.map_or(m, |c| c.value_at((i % n) as u64));
                    let (wl, wr) = d.tick(*a as f64, *b as f64);
                    (*a, *b) = (mix(*a, wl, m), mix(*b, wr, m));
                }
            }
            Effect::Harmonic(spec) => {
                // Sized once per chain build (bank state doesn't need to survive across renders);
                // re-targeted every 32 frames from the chord sounding at that block's beat, the
                // same automation grain every other block-driven effect uses. A score with no
                // `chords` line compiles `spans` empty, which is the effect's documented no-op.
                if !spec.spans.is_empty() {
                    let base = harmonic_params(spec);
                    let tune_hz = spec.tune_hz.unwrap_or(440.0);
                    let (depth_curve, boost_curve, tol_curve, mix_curve, glide_curve) =
                        (curve_for(ei, "depth"), curve_for(ei, "boost"), curve_for(ei, "tolerance"), curve_for(ei, "mix"), curve_for(ei, "glide"));
                    const BLOCK: usize = 32;
                    let block_dur_s = BLOCK as f64 / sr;
                    let mut bank = HarmonicBank::new(sr, &base);
                    let mut start = 0usize;
                    while start < l.len() {
                        let end = (start + BLOCK).min(l.len());
                        let frame_in_loop = start % n;
                        let at = |c: &Curve| c.value_at(frame_in_loop as u64);
                        let mut dp = base;
                        if let Some(c) = depth_curve {
                            dp.depth_db = at(c);
                        }
                        if let Some(c) = boost_curve {
                            dp.boost_db = at(c);
                        }
                        if let Some(c) = tol_curve {
                            dp.tolerance_cents = at(c);
                            bank.set_tolerance(dp.tolerance_cents);
                        }
                        let wet = mix_curve.map_or(spec.mix.unwrap_or(1.0), at);
                        let glide_s = glide_curve.map_or(spec.glide_ms.unwrap_or(40.0), at) / 1000.0;
                        let beat = frame_in_loop as f64 / frames_per_beat + offset_beats;
                        let span = spec.spans.iter().find(|s| beat >= s.start_beat && beat < s.end_beat);
                        let chord = span.map(|s| harmonic_chord(s, tune_hz));
                        bank.update(chord.as_ref(), &dp, glide_s, block_dur_s);
                        for i in start..end {
                            let (a, b2) = (l[i], r[i]);
                            let (wl, wr) = (bank.tick(0, a as f64), bank.tick(1, b2 as f64));
                            (l[i], r[i]) = (mix(a, wl, wet), mix(b2, wr, wet));
                        }
                        start = end;
                    }
                }
            }
            Effect::Drive(d) => color::drive(&mut b, DriveParams { db: d.db, tone_hz: d.tone }, sr),
            Effect::Lofi(f) => color::lofi(&mut b, LofiParams { bits: f.bits.unwrap_or(24.0), rate_hz: f.rate, wow: f.wow.unwrap_or(0.0) }, sr, n),
            Effect::NoiseGate(g) => {
                let d = GateParams::default();
                let mut gate = Gate::new(
                    GateParams {
                        threshold_db: g.threshold,
                        attack_ms: g.attack_ms.unwrap_or(d.attack_ms),
                        hold_ms: g.hold_ms.unwrap_or(d.hold_ms),
                        release_ms: g.release_ms.unwrap_or(d.release_ms),
                        range_db: g.range.unwrap_or(d.range_db),
                    },
                    sr,
                );
                for (a, b) in l.iter_mut().zip(r.iter_mut()) {
                    let (x, y) = gate.tick(*a as f64, *b as f64);
                    (*a, *b) = (x as f32, y as f32);
                }
            }
            Effect::Comp(c) if c.sidechain.is_some() => {
                let key = keys.get(c.sidechain.as_deref().unwrap_or_default()).filter(|k| k[0].len() == n);
                let mut comp = Compressor::new(comp_params(c), sr);
                for (i, (a, b)) in l.iter_mut().zip(r.iter_mut()).enumerate() {
                    if i == last {
                        comp.take_max_reduction();
                    }
                    let k = key.map_or(0.0, |k| (k[0][i % n] as f64).abs().max((k[1][i % n] as f64).abs()));
                    let (x, y) = comp.tick(*a as f64, *b as f64, k);
                    (*a, *b) = (x as f32, y as f32);
                }
                reductions.push((label(c), comp.take_max_reduction()));
            }
            rt => {
                let has_curves = !effect_curves[ei].is_empty();
                // A comp's dry/wet: its `mix` lane, else its static `mix`; None means all wet.
                let comp_mix = match rt {
                    Effect::Comp(c) => curve_for(ei, "mix").map(|c| Err(c)).or(c.mix.filter(|m| *m < 1.0).map(Ok)),
                    _ => None,
                };

                if has_curves || comp_mix.is_some() {
                    // Process with automation: 32-frame blocks
                    const BLOCK_SIZE: usize = 32;
                    let mut chain = MasterChain::new(sr);

                    for block_start in (0..l.len()).step_by(BLOCK_SIZE) {
                        let block_end = (block_start + BLOCK_SIZE).min(l.len());
                        let frame_in_loop = block_start % n;

                        let auto_effect = automated_effect(rt, &effect_curves[ei], frame_in_loop as u64);
                        chain.set(params(std::slice::from_ref(&auto_effect), false));
                        let dry = comp_mix.map(|_| (l[block_start..block_end].to_vec(), r[block_start..block_end].to_vec()));
                        chain.process(&mut l[block_start..block_end], &mut r[block_start..block_end]);
                        if let (Some(m), Some((dl, dr))) = (comp_mix, dry) {
                            for (j, i) in (block_start..block_end).enumerate() {
                                let m = match m {
                                    Ok(m) => m,
                                    Err(c) => c.value_at((i % n) as u64),
                                };
                                l[i] = mix(dl[j], l[i] as f64, m);
                                r[i] = mix(dr[j], r[i] as f64, m);
                            }
                        }

                        if block_start < last && block_end >= last {
                            chain.take_reduction();
                        }
                    }

                    if let Effect::Comp(c) = rt {
                        reductions.push((label(c), chain.take_reduction()));
                    }
                    lat += chain.latency();
                } else {
                    // No automation: use original path unchanged
                    let mut chain = MasterChain::new(sr);
                    chain.set(params(std::slice::from_ref(rt), false));
                    chain.process(&mut l[..last], &mut r[..last]);
                    chain.take_reduction();
                    chain.process(&mut l[last..], &mut r[last..]);
                    if let Effect::Comp(c) = rt {
                        reductions.push((label(c), chain.take_reduction()));
                    }
                    lat += chain.latency();
                }
            }
        }
    }
    // Keep the last cycle, lined up with the grid (limiters delay their output).
    let start = last + lat;
    let at = |i: usize| if start + i < n * cycles { start + i } else { start + i - n };
    ([(0..n).map(|i| b[0][at(i)]).collect(), (0..n).map(|i| b[1][at(i)]).collect()], reductions)
}

/// Default wet share for reverb and delay used as a track insert.
pub const INSERT_WET: f64 = 0.25;

#[cfg(test)]
mod tests {
    use super::*;
    use apricity_dsp::fx::loudness_lufs;
    use apricity_score::score::{CompSpec, LimitSpec};

    const SR: f64 = 48_000.0;

    /// A 2-second loop: a 220 Hz tone that pulses on and off every quarter second.
    fn pulses(amp: f32) -> [Vec<f32>; 2] {
        let l: Vec<f32> = (0..96_000)
            .map(|i| {
                let on = (i / 12_000) % 2 == 0;
                if on { amp * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / SR).sin() as f32 } else { 0.0 }
            })
            .collect();
        [l.clone(), l]
    }

    #[test]
    fn loudness_lands_on_target_through_the_whole_chain() {
        for (amp, target) in [(0.05, -16.0), (0.5, -16.0), (0.9, -9.0), (0.2, -23.0)] {
            let mix = pulses(amp);
            let p = params(&[], true);
            let g = loudness_gain(&mix, MasterParams { gain_db: 0.0, ..p }, SR, target);
            let [l, r] = run_looped(&mix, MasterParams { gain_db: g, ..p }, SR);
            let got = loudness_lufs(&l, &r, SR);
            let peak = l.iter().fold(0f32, |m, x| m.max(x.abs()));
            assert!((got - target).abs() < 0.6, "amp {amp} → {got:.2} LUFS, wanted {target}");
            assert!(peak <= 10f32.powf(-1.0 / 20.0) + 1e-4, "the safety limiter held: {peak}");
        }
    }

    #[test]
    fn make_up_gain_is_clamped() {
        // About −46 LUFS: reaching −16 would take +30 dB, more than the ±24 dB allowed.
        assert_eq!(loudness_gain(&pulses(0.01), params(&[], true), SR, -16.0), 24.0);
    }

    #[test]
    fn silence_gets_no_gain() {
        let mix = [vec![0.0; 48_000], vec![0.0; 48_000]];
        assert_eq!(loudness_gain(&mix, params(&[], true), SR, -16.0), 0.0);
    }

    #[test]
    fn master_always_ends_in_a_limiter_unless_it_has_one() {
        assert!(matches!(params(&[], true).stages[0], Some(Stage::Limit { ceiling_db, .. }) if ceiling_db == -1.0));
        let own = params(&[Effect::Limit(LimitSpec { ceiling: -0.3, release_ms: None })], true);
        assert_eq!(own.stages.iter().flatten().count(), 1);
        assert!(params(&[], false).stages.iter().all(Option::is_none), "track inserts get no safety limiter");
    }

    #[test]
    fn inserts_wrap_so_the_loop_start_sounds_like_the_middle() {
        // A compressor on a steady tone: with no wrap, the first frames would be uncompressed (the
        // detector starting from rest); the two-cycle render makes the start already settled.
        let mut buf = [vec![0.5f32; 48_000], vec![0.5f32; 48_000]];
        let comp = Effect::Comp(CompSpec { ratio: 4.0, threshold: -20.0, attack_ms: Some(5.0), release_ms: Some(100.0), knee: None, makeup: None, sidechain: None, mix: None });
        buf = process_chain(&buf, &[comp], SR, 24_000.0, INSERT_WET, &Keys::new(), &[], 0.0).0;
        let (start, mid) = (buf[0][10], buf[0][24_000]);
        assert!((start - mid).abs() < 1e-3, "start {start} vs middle {mid}");
        assert!(mid < 0.2, "and it compressed: {mid}");
    }
}

#[cfg(test)]
mod timing {
    #[test]
    #[ignore]
    fn loudness_gain_cost() {
        let n = 48_000 * 16;
        let l: Vec<f32> = (0..n).map(|i| (i as f32 * 0.01).sin() * 0.3).collect();
        let mix = [l.clone(), l];
        let t = std::time::Instant::now();
        let g = super::loudness_gain(&mix, super::params(&[], true), 48_000.0, -16.0);
        eprintln!("16 s loop: {:.1} ms (gain {g:.2})", t.elapsed().as_secs_f64() * 1e3);
    }
}

#[cfg(test)]
mod automation_tests {
    use super::*;
    use apricity_score::score::FilterSpec;

    const SR: f64 = 48_000.0;
    const FPB: f64 = 24_000.0; // 120 BPM
    const N: usize = 8 * 24_000; // two bars

    fn noise() -> [Vec<f32>; 2] {
        let mut s: u64 = 42;
        let mut next = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.2
        };
        let l: Vec<f32> = (0..N).map(|_| next()).collect();
        [l.clone(), l]
    }

    fn tone(amp: f32) -> [Vec<f32>; 2] {
        let l: Vec<f32> = (0..N).map(|i| amp * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / SR).sin() as f32).collect();
        [l.clone(), l]
    }

    /// Energy (dB) of `x` above 5 kHz.
    fn highs_db(x: &[f32]) -> f64 {
        let mut y = x.to_vec();
        crate::render::biquad(&mut y, FilterSpec::Highpass { hz: 5000.0, res: 0.0, slope: 12 }, SR);
        10.0 * (y.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / y.len() as f64 + 1e-20).log10()
    }

    fn lane(target: &str, step: bool, points: &[[f64; 2]]) -> Lane {
        Lane { target: target.into(), step, points: points.to_vec() }
    }

    fn run(buf: &[Vec<f32>; 2], fx: &[Effect], lanes: &[Lane], offset: f64) -> [Vec<f32>; 2] {
        process_chain(buf, fx, SR, FPB, INSERT_WET, &Keys::new(), lanes, offset).0
    }

    #[test]
    fn an_eq_highcut_lane_closes_the_highs_over_the_loop() {
        let eq = Effect::Eq(EqSpec { highcut: Some(20_000.0), ..Default::default() });
        let out = run(&noise(), &[eq], &[lane("eq.highcut", false, &[[0.0, 20_000.0], [8.0, 1_000.0]])], 0.0);
        let (first, last) = (highs_db(&out[0][..12_000]), highs_db(&out[0][N - 12_000..]));
        assert!(last < first - 15.0, "highs {first:.1} dB at the start, {last:.1} dB at the end");
    }

    #[test]
    fn an_effect_lane_reaches_its_own_effect_after_a_delay() {
        // The eq is the second effect; its lane must not be looked up by a count of real-time effects.
        let fx = [Effect::Delay(DelaySpec { beats: Some(0.5), mix: Some(0.0), ..Default::default() }), Effect::Eq(EqSpec { highcut: Some(20_000.0), ..Default::default() })];
        let input = noise();
        let out = run(&input, &fx, &[lane("eq.highcut", false, &[[0.0, 1_000.0]])], 0.0);
        let (dry, wet) = (highs_db(&input[0][24_000..48_000]), highs_db(&out[0][24_000..48_000]));
        assert!(wet < dry - 15.0, "highs {dry:.1} dB in, {wet:.1} dB out");
    }

    #[test]
    fn a_comp_mix_lane_is_dry_until_it_opens() {
        let comp = Effect::Comp(CompSpec { ratio: 8.0, threshold: -30.0, attack_ms: Some(1.0), release_ms: Some(50.0), knee: None, makeup: None, sidechain: None, mix: None });
        let input = tone(0.9);
        let out = run(&input, &[comp], &[lane("comp.mix", true, &[[0.0, 0.0], [4.0, 1.0]])], 0.0);
        for i in [0, 1_000, 50_000, 95_999] {
            assert!((out[0][i] - input[0][i]).abs() < 1e-6, "frame {i}: {} vs dry {}", out[0][i], input[0][i]);
        }
        let peak_after = out[0][100_000..].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak_after < 0.6, "compressed after beat 4, peak {peak_after}");
    }

    #[test]
    fn a_static_comp_mix_blends_dry_and_wet() {
        let spec = CompSpec { ratio: 8.0, threshold: -30.0, attack_ms: Some(1.0), release_ms: Some(50.0), knee: None, makeup: None, sidechain: None, mix: None };
        let input = tone(0.9);
        let wet = run(&input, &[Effect::Comp(spec.clone())], &[], 0.0);
        let half = run(&input, &[Effect::Comp(CompSpec { mix: Some(0.5), ..spec })], &[], 0.0);
        for i in [10_000, 60_000, 150_000] {
            let want = 0.5 * input[0][i] + 0.5 * wet[0][i];
            assert!((half[0][i] - want).abs() < 1e-3, "frame {i}: {} vs {}", half[0][i], want);
        }
    }

    #[test]
    fn a_reverb_mix_lane_is_dry_until_it_opens() {
        let rv = Effect::Reverb(ReverbSpec { mix: Some(0.3), ..Default::default() });
        let input = tone(0.5);
        let out = run(&input, &[rv], &[lane("reverb.mix", true, &[[0.0, 0.0], [4.0, 1.0]])], 0.0);
        for i in [0, 30_000, 95_999] {
            assert!((out[0][i] - input[0][i]).abs() < 1e-6, "frame {i}");
        }
        assert!((96_000..N).any(|i| (out[0][i] - input[0][i]).abs() > 1e-3), "wet after beat 4");
    }

    #[test]
    fn effect_lanes_follow_the_bars_offset() {
        // Rendering from beat 4: the step lane is already open at the first frame.
        let rv = Effect::Reverb(ReverbSpec { mix: Some(0.3), ..Default::default() });
        let input = tone(0.5);
        let from_start = run(&input, &[rv.clone()], &[lane("reverb.mix", true, &[[0.0, 0.0], [4.0, 1.0]])], 0.0);
        let from_beat_4 = run(&input, &[rv], &[lane("reverb.mix", true, &[[0.0, 0.0], [4.0, 1.0]])], 4.0);
        assert!((from_start[0][10] - input[0][10]).abs() < 1e-6);
        assert!((from_beat_4[0][10] - input[0][10]).abs() > 1e-4, "wet at frame 10 when rendering from beat 4");
    }

    #[test]
    fn a_filter_effect_cutoff_lane_opens_the_highs_over_the_loop() {
        // A filter effect on a group (any chain, real or bus): automate filter.cutoff 1=200 5=20k
        // (here in beats, not bars, since Lane is post-compile). The energy above 5 kHz in the
        // first half-beat should be well below the last half-beat, once the cutoff has opened up.
        let filt = Effect::Filter(FilterFxSpec { kind: FilterKind::Lp, hz: 20_000.0, res: 0.0, slope: 12 });
        let out = run(&noise(), &[filt], &[lane("filter.cutoff", false, &[[0.0, 200.0], [8.0, 20_000.0]])], 0.0);
        let (first_half, last_half) = (highs_db(&out[0][..12_000]), highs_db(&out[0][N - 12_000..]));
        assert!(last_half > first_half + 20.0, "filter cutoff sweep: highs {first_half:.1} dB in the first half-beat, {last_half:.1} dB in the last");
    }

    #[test]
    fn an_effect_lanes_curves_reach_a_second_filter_by_index() {
        // A second filter effect's own cutoff lane (filter2.cutoff) must reach the second Filter,
        // not the first (mirrors the eq2/comp2 indexing tests already covering other effect kinds).
        let f1 = Effect::Filter(FilterFxSpec { kind: FilterKind::Hp, hz: 20.0, res: 0.0, slope: 12 });
        let f2 = Effect::Filter(FilterFxSpec { kind: FilterKind::Lp, hz: 20_000.0, res: 0.0, slope: 12 });
        let out = run(&noise(), &[f1, f2], &[lane("filter2.cutoff", false, &[[0.0, 200.0], [8.0, 20_000.0]])], 0.0);
        let (first_half, last_half) = (highs_db(&out[0][..12_000]), highs_db(&out[0][N - 12_000..]));
        assert!(last_half > first_half + 20.0, "filter2.cutoff sweep: highs {first_half:.1} dB in the first half-beat, {last_half:.1} dB in the last");
    }

    #[test]
    fn filter_res_step_automation_raises_the_gain_at_the_cutoff() {
        // automate filter.res step 1=0% 3=80% (here at beat 4, since Lane is post-compile beats):
        // the gain at the cutoff frequency should rise once the step lands.
        let cutoff = 800.0;
        let filt = Effect::Filter(FilterFxSpec { kind: FilterKind::Lp, hz: cutoff, res: 0.0, slope: 12 });
        let l: Vec<f32> = (0..N).map(|i| 0.3 * (2.0 * std::f64::consts::PI * cutoff * i as f64 / SR).sin() as f32).collect();
        let input = [l.clone(), l];
        let out = run(&input, &[filt], &[lane("filter.res", true, &[[0.0, 0.0], [4.0, 0.8]])], 0.0);
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
        let before = rms(&out[0][..FPB as usize]); // beat 0-1, before the step at beat 4
        let after = rms(&out[0][(5.0 * FPB) as usize..(6.0 * FPB) as usize]); // beat 5-6, after it
        assert!(after > before * 1.5, "gain at the cutoff should rise once res steps up at beat 4: before {before}, after {after}");
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// A 4-chord progression over the 8-beat loop (`N`/`FPB`, 120 bpm): Am7, Fmaj7, Dm7, G, 2
    /// beats each — the fixture spec-harmony-v2.md sec 4.3 asks for, embedded the way the
    /// compiler would (`fill_harmonic_spans`).
    fn four_chord_spans() -> Vec<HarmonicSpanSpec> {
        vec![
            HarmonicSpanSpec { start_beat: 0.0, end_beat: 2.0, tones_pc: vec![9, 0, 4, 7], bass_pc: 9 }, // Am7
            HarmonicSpanSpec { start_beat: 2.0, end_beat: 4.0, tones_pc: vec![5, 9, 0, 4], bass_pc: 5 }, // Fmaj7
            HarmonicSpanSpec { start_beat: 4.0, end_beat: 6.0, tones_pc: vec![2, 5, 9, 0], bass_pc: 2 }, // Dm7
            HarmonicSpanSpec { start_beat: 6.0, end_beat: 8.0, tones_pc: vec![7, 11, 2], bass_pc: 7 },   // G
        ]
    }

    #[test]
    fn harmonic_cut_notch_moves_with_the_chord_span() {
        // A steady C4 tone (pitch class 0): a chord tone of Am7 (span 0, spared) but not of G
        // (span 3, cut) — the acceptance test of Kanbus apricitus-24f6b5 / spec sec 6 task 10.
        let c4 = 261.6255653005986;
        let l: Vec<f32> = (0..N).map(|i| 0.4 * (2.0 * std::f64::consts::PI * c4 * i as f64 / SR).sin() as f32).collect();
        let input = [l.clone(), l];
        let fx = Effect::Harmonic(HarmonicSpec {
            mode: HarmonicFxMode::Cut,
            depth_db: Some(18.0),
            tolerance_cents: Some(30.0),
            harmonics: Some(0),
            range: Some([20.0, 20_000.0]),
            glide_ms: Some(0.0),
            mix: Some(1.0),
            spans: four_chord_spans(),
            ..Default::default()
        });
        let out = run(&input, &[fx], &[], 0.0);
        let spared = rms(&out[0][..(2.0 * FPB) as usize]); // Am7: C is a chord tone
        let cut = rms(&out[0][(6.0 * FPB) as usize..]); // G: C is not
        // The full `Cut` band comb (every non-chord semitone at once) leaks a little onto a
        // semitone-adjacent chord tone too (see `apricity-dsp`'s `chromatic_comb_neighbors_add_up`),
        // so this isn't the ~8x an isolated band gives — the notch clearly follows the chord either way.
        assert!(spared > cut * 3.0, "C4 should be cut under G but spared under Am7: spared {spared}, cut {cut}");
    }

    #[test]
    fn harmonic_depth_lane_ramps_the_cut_over_the_loop() {
        // One span (no chord change) so only the depth lane moves the cut. D4 is not a chord
        // tone of the Am7 triad throughout.
        let d4 = 293.6647679174076;
        let l: Vec<f32> = (0..N).map(|i| 0.4 * (2.0 * std::f64::consts::PI * d4 * i as f64 / SR).sin() as f32).collect();
        let input = [l.clone(), l];
        let span = HarmonicSpanSpec { start_beat: 0.0, end_beat: 8.0, tones_pc: vec![9, 0, 4], bass_pc: 9 };
        let fx = Effect::Harmonic(HarmonicSpec {
            mode: HarmonicFxMode::Cut,
            depth_db: Some(0.0),
            tolerance_cents: Some(30.0),
            harmonics: Some(0),
            range: Some([20.0, 20_000.0]),
            glide_ms: Some(0.0),
            mix: Some(1.0),
            spans: vec![span],
            ..Default::default()
        });
        let out = run(&input, &[fx], &[lane("harmonic.depth", false, &[[0.0, 0.0], [8.0, 24.0]])], 0.0);
        let before = rms(&out[0][..FPB as usize]);
        let after = rms(&out[0][N - FPB as usize..]);
        assert!(after < before * 0.3, "the cut should deepen as depth ramps from 0 to 24 dB: before {before}, after {after}");
    }

    #[test]
    fn harmonic_depth_zero_is_a_bit_exact_bypass_through_process_chain() {
        let l: Vec<f32> = (0..N).map(|i| 0.37 * (2.0 * std::f64::consts::PI * 300.0 * i as f64 / SR).sin() as f32).collect();
        let input = [l.clone(), l];
        let fx = Effect::Harmonic(HarmonicSpec { mode: HarmonicFxMode::Cut, depth_db: Some(0.0), spans: four_chord_spans(), ..Default::default() });
        let out = run(&input, &[fx], &[], 0.0);
        for i in [0, 1000, N / 2, N - 1] {
            assert_eq!(out[0][i], input[0][i], "frame {i}: depth 0 must pass through unchanged");
        }
    }

    #[test]
    fn harmonic_with_no_spans_is_a_no_op() {
        // A score with no `chords` line: `fill_harmonic_spans` leaves `spans` empty (sec 4.5).
        let l: Vec<f32> = (0..N).map(|i| 0.37 * (2.0 * std::f64::consts::PI * 300.0 * i as f64 / SR).sin() as f32).collect();
        let input = [l.clone(), l];
        let fx = Effect::Harmonic(HarmonicSpec { mode: HarmonicFxMode::Cut, depth_db: Some(18.0), spans: vec![], ..Default::default() });
        let out = run(&input, &[fx], &[], 0.0);
        assert_eq!(out[0], input[0], "no spans: nothing to follow, so the effect does nothing");
    }
}
