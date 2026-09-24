//! Effect chains: the master chain (real time, fixed-size, no allocation) and offline track
//! inserts. Settings arrive as plain `Copy` data, so a new arrangement can retune a running chain
//! without allocating or resetting filter memory.

use apricitus_dsp::color::{self, DriveParams, Gate, GateParams, LofiParams};
use apricitus_dsp::fx::{BiquadKind, CompParams, Compressor, Eq, EqParams, Limiter, MAX_BANDS};
use std::collections::HashMap;
use std::sync::Arc;
use apricitus_dsp::space::{Delay, DelayParams, Reverb, ReverbKind, ReverbParams};
use apricitus_score::score::{CompSpec, DelaySpec, Effect, EqSpec, ReverbSpec, ReverbType};

/// Most stages a chain may have.
pub const MAX_STAGES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stage {
    Eq(EqParams),
    Comp(CompParams),
    Limit { ceiling_db: f64, release_ms: f64 },
    Width(f64),
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

enum State {
    Off,
    Width(f64),
    Eq(Eq),
    Comp(Compressor),
    Limit(Limiter),
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
                (st, stage) => {
                    *st = match stage {
                        None => State::Off,
                        Some(Stage::Eq(q)) => State::Eq(Eq::new(q, self.sr)),
                        Some(Stage::Comp(q)) => State::Comp(Compressor::new(q, self.sr)),
                        Some(Stage::Limit { ceiling_db, release_ms }) => State::Limit(Limiter::new(ceiling_db, release_ms, self.sr)),
                        Some(Stage::Width(v)) => State::Width(v),
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
        apricitus_dsp::fx::loudness_lufs(&l, &r, sr)
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
            Effect::Eq(_) | Effect::Limit(_) | Effect::Drive(_) | Effect::Lofi(_) | Effect::Width(_) => 0.0,
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

/// Run an effect chain over a loop, offline, so the loop joins seamlessly: the loop is processed
/// for as many cycles as the tails need (at least two) and the last cycle is kept, so the reverb
/// and echoes from the end ring on into the start, and compressors start already settled.
/// `wet` is the reverb/delay mix when the effect doesn't set one (1 on a bus, 0.25 on a track).
/// A comp with `sidechain` listens to that track's stem in `keys` (silence if it isn't there).
pub fn process_chain(buf: &[Vec<f32>; 2], effects: &[Effect], sr: f64, frames_per_beat: f64, wet: f64, keys: &Keys) -> ([Vec<f32>; 2], Reductions) {
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
    for e in effects {
        let mix = |x: f32, w: f64, m: f64| (x as f64 * (1.0 - m) + w * m) as f32;
        let [l, r] = &mut b;
        match e {
            Effect::Reverb(spec) => {
                let m = spec.mix.unwrap_or(wet);
                let mut rv = Reverb::new(reverb_params(spec), sr);
                for (a, b) in l.iter_mut().zip(r.iter_mut()) {
                    let (wl, wr) = rv.tick(*a as f64, *b as f64);
                    (*a, *b) = (mix(*a, wl, m), mix(*b, wr, m));
                }
            }
            Effect::Delay(spec) => {
                let m = spec.mix.unwrap_or(wet);
                let mut d = Delay::new(delay_params(spec, frames_per_beat, sr), sr);
                for (a, b) in l.iter_mut().zip(r.iter_mut()) {
                    let (wl, wr) = d.tick(*a as f64, *b as f64);
                    (*a, *b) = (mix(*a, wl, m), mix(*b, wr, m));
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
    use apricitus_dsp::fx::loudness_lufs;
    use apricitus_score::score::{CompSpec, LimitSpec};

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
        let comp = Effect::Comp(CompSpec { ratio: 4.0, threshold: -20.0, attack_ms: Some(5.0), release_ms: Some(100.0), knee: None, makeup: None, sidechain: None });
        buf = process_chain(&buf, &[comp], SR, 24_000.0, INSERT_WET, &Keys::new()).0;
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
