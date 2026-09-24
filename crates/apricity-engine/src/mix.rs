//! The mix graph: track stems → (fader, pan) → master, groups and sends → buses → master.
//!
//! Buses render ahead (reverb and delay are too heavy for the audio thread), so an `Arrangement`
//! holds a stem for every track that goes straight to the master (live fader, mute and solo) and
//! one for every bus that does (its inputs baked in). When a live control changes a track that
//! feeds a bus, the control thread calls `Mix::arrangement` again (tens of milliseconds) and swaps
//! the result in; direct tracks change within one audio block.

use crate::arrangement::{Arrangement, Stem, Stereo, TrackControl};
use crate::master::{self, MasterParams};
use std::collections::HashMap;
use std::sync::Arc;

/// One track's audio for the loop, after its insert effects, before fader and pan.
pub struct TrackStem {
    pub name: String,
    pub buf: Arc<Stereo>,
    pub pan: f32,
    /// A bus, or "master".
    pub out: String,
    /// Post-fader sends: (bus, linear level).
    pub sends: Vec<(String, f32)>,
    /// Gain reduction of the track's own compressors (for reports).
    pub reductions: master::Reductions,
}

pub struct BusDef {
    pub name: String,
    pub effects: Vec<apricity_score::score::Effect>,
    /// Linear fader.
    pub gain: f32,
    pub out: String,
}

pub struct Mix {
    pub sample_rate: u32,
    pub frames_per_beat: f64,
    pub beats_per_bar: u32,
    pub length: usize,
    pub tracks: Vec<TrackStem>,
    /// Feeders first.
    pub buses: Vec<BusDef>,
    pub master: MasterParams,
}

const MASTER: &str = "master";

impl Mix {
    /// Does a live change to `name` need a re-mix (it's baked into a bus), rather than only the
    /// audio thread's fader?
    pub fn baked(&self, name: &str) -> bool {
        self.tracks.iter().any(|t| t.name == name && (t.out != MASTER || !t.sends.is_empty()))
            || self.buses.iter().any(|b| b.name == name && b.out != MASTER)
    }

    pub fn has_buses(&self) -> bool {
        !self.buses.is_empty()
    }

    /// Every track and bus name, in mixer order.
    pub fn names(&self) -> Vec<String> {
        self.tracks.iter().map(|t| t.name.clone()).chain(self.buses.iter().map(|b| b.name.clone())).collect()
    }

    /// The buses `bus` flows through on its way to the master (itself included).
    fn downstream(&self, bus: &str) -> Vec<String> {
        let mut path: Vec<String> = Vec::new();
        let mut bus = bus.to_string();
        while bus != MASTER && !path.contains(&bus) {
            path.push(bus.clone());
            bus = self.buses.iter().find(|b| b.name == bus).map_or_else(|| MASTER.to_string(), |b| b.out.clone());
        }
        path
    }

    /// Build the playable arrangement with these live controls baked into the buses.
    pub fn arrangement(&self, controls: &HashMap<String, TrackControl>) -> Arrangement {
        self.build(controls).0
    }

    /// `arrangement`, plus each bus's compressor gain reduction.
    pub fn build(&self, controls: &HashMap<String, TrackControl>) -> (Arrangement, Vec<(String, master::Reductions)>) {
        let keys: master::Keys = self.tracks.iter().map(|t| (t.name.clone(), t.buf.clone())).collect();
        let mut report = Vec::new();
        let ctl = |n: &str| controls.get(n).copied().unwrap_or_default();
        let any_solo = self.names().iter().any(|n| ctl(n).solo);
        let soloed_bus = |t: &TrackStem| {
            std::iter::once(t.out.as_str()).chain(t.sends.iter().map(|s| s.0.as_str())).any(|b| self.downstream(b).iter().any(|d| ctl(d).solo))
        };
        let audible = |t: &TrackStem| {
            let c = ctl(&t.name);
            !c.mute && (!any_solo || c.solo || soloed_bus(t))
        };
        let n = self.length;
        let mut inputs: HashMap<String, Stereo> = HashMap::new();
        let add = |bus: &str, src: &Stereo, gain: [f32; 2], inputs: &mut HashMap<String, Stereo>| {
            let dst = inputs.entry(bus.to_string()).or_insert_with(|| [vec![0.0; n], vec![0.0; n]]);
            for c in 0..2 {
                for (d, s) in dst[c].iter_mut().zip(&src[c]) {
                    *d += s * gain[c];
                }
            }
        };

        let mut stems = Vec::new();
        for t in &self.tracks {
            if t.out == MASTER {
                stems.push(Stem { name: t.name.clone(), buf: t.buf.clone(), pan: t.pan, solo_safe: false });
            }
            if !audible(t) {
                continue;
            }
            let (pl, pr) = apricity_dsp::fx::balance(t.pan as f64);
            let g = ctl(&t.name).gain;
            let post = [g * pl as f32, g * pr as f32];
            if t.out != MASTER {
                add(&t.out, &t.buf, post, &mut inputs);
            }
            for (bus, level) in &t.sends {
                add(bus, &t.buf, [post[0] * level, post[1] * level], &mut inputs);
            }
        }
        let sr = self.sample_rate as f64;
        for b in &self.buses {
            let Some(input) = inputs.remove(&b.name) else { continue };
            if input[0].iter().chain(&input[1]).all(|x| *x == 0.0) {
                continue; // nothing reached it (muted, or another render worker has its tracks)
            }
            let (mut out, red) = master::process_chain(&input, &b.effects, sr, self.frames_per_beat, 1.0, &keys);
            report.push((b.name.clone(), red));
            for c in out.iter_mut() {
                c.iter_mut().for_each(|x| *x *= b.gain);
            }
            if b.out == MASTER {
                stems.push(Stem { name: b.name.clone(), buf: Arc::new(out), pan: 0.0, solo_safe: true });
            } else {
                let c = ctl(&b.name);
                if !c.mute {
                    add(&b.out, &out, [c.gain, c.gain], &mut inputs);
                }
            }
        }
        (Arrangement::from_stems(self.sample_rate, self.frames_per_beat, self.beats_per_bar, self.length, stems, self.master), report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apricity_score::score::{DelaySpec, Effect, ReverbSpec, ReverbType};

    const N: usize = 4800; // 0.1 s loops at 48 kHz, 100 frames per beat

    fn track(name: &str, level: f32, out: &str, sends: &[(&str, f32)]) -> TrackStem {
        TrackStem { name: name.into(), buf: Arc::new([vec![level; N], vec![level; N]]), pan: 0.0, out: out.into(), sends: sends.iter().map(|(b, l)| (b.to_string(), *l)).collect(), reductions: Vec::new() }
    }

    fn bus(name: &str, effects: Vec<Effect>, gain: f32, out: &str) -> BusDef {
        BusDef { name: name.into(), effects, gain, out: out.into() }
    }

    fn mix(tracks: Vec<TrackStem>, buses: Vec<BusDef>) -> Mix {
        Mix { sample_rate: 48_000, frames_per_beat: 100.0, beats_per_bar: 4, length: N, tracks, buses, master: MasterParams::default() }
    }

    fn stem<'a>(a: &'a Arrangement, name: &str) -> Option<&'a Stem> {
        a.stems.iter().find(|s| s.name == name)
    }

    #[test]
    fn groups_and_sends_reach_their_buses() {
        let m = mix(
            vec![track("a", 0.4, "master", &[("fx", 0.5)]), track("b", 0.2, "grp", &[]), track("c", 0.1, "grp", &[])],
            vec![bus("fx", vec![], 1.0, "master"), bus("grp", vec![], 0.5, "master")],
        );
        let a = m.arrangement(&HashMap::new());
        let names: Vec<&str> = a.stems.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["a", "fx", "grp"], "grouped tracks live inside their bus");
        assert!((stem(&a, "fx").unwrap().buf[0][10] - 0.2).abs() < 1e-6, "send at 50%");
        assert!((stem(&a, "grp").unwrap().buf[0][10] - 0.15).abs() < 1e-6, "(0.2 + 0.1) at the bus fader's 0.5");
        assert!(m.baked("b") && m.baked("a") && !m.baked("fx"));
    }

    #[test]
    fn live_controls_are_baked_into_buses_and_solo_keeps_the_returns() {
        let m = mix(
            vec![track("a", 0.4, "master", &[("fx", 1.0)]), track("b", 0.2, "master", &[("fx", 1.0)]), track("c", 0.1, "grp", &[])],
            vec![bus("fx", vec![], 1.0, "master"), bus("grp", vec![], 1.0, "master")],
        );
        let ctl = |pairs: &[(&str, TrackControl)]| pairs.iter().map(|(n, c)| (n.to_string(), *c)).collect::<HashMap<_, _>>();
        let muted = TrackControl { mute: true, ..Default::default() };
        let soloed = TrackControl { solo: true, ..Default::default() };

        let a = m.arrangement(&ctl(&[("c", muted), ("b", TrackControl { gain: 0.5, ..Default::default() })]));
        assert!(stem(&a, "grp").is_none(), "the group's only track is muted");
        assert!((stem(&a, "fx").unwrap().buf[0][10] - (0.4 + 0.1)).abs() < 1e-6, "b's send follows its fader");

        let a = m.arrangement(&ctl(&[("a", soloed)]));
        let fx = stem(&a, "fx").unwrap();
        assert!(fx.solo_safe && (fx.buf[0][10] - 0.4).abs() < 1e-6, "soloing a keeps its reverb, without b's");
        assert!(stem(&a, "grp").is_none(), "c isn't soloed");

        let a = m.arrangement(&ctl(&[("grp", soloed)]));
        assert!((stem(&a, "grp").unwrap().buf[0][10] - 0.1).abs() < 1e-6, "soloing a bus keeps what feeds it");
        assert!(stem(&a, "fx").is_none(), "and silences the rest");
    }

    #[test]
    fn delay_on_a_bus_follows_the_tempo() {
        let mut t = track("a", 0.0, "master", &[("echo", 1.0)]);
        let mut click = [vec![0.0; N], vec![0.0; N]];
        click[0][0] = 1.0;
        click[1][0] = 1.0;
        t.buf = Arc::new(click);
        let d = DelaySpec { beats: Some(1.0), feedback: Some(0.5), ..Default::default() };
        let m = mix(vec![t], vec![bus("echo", vec![Effect::Delay(d)], 1.0, "master")]);
        let a = m.arrangement(&HashMap::new());
        let e = &stem(&a, "echo").unwrap().buf[0];
        assert!((e[100] - 1.0).abs() < 1e-6 && (e[200] - 0.5).abs() < 1e-6 && (e[300] - 0.25).abs() < 1e-6, "{} {} {}", e[100], e[200], e[300]);
        assert!(e[0].abs() < 1e-6, "a return is all wet: no dry click");
    }

    #[test]
    fn a_bus_ducks_under_a_voice() {
        const L: usize = 48_000; // a 1 s loop: voice for the first half, then silence
        let voice = TrackStem {
            name: "voice".into(),
            buf: Arc::new([(0..L).map(|i| if i < L / 2 { 0.5 } else { 0.0 }).collect(), (0..L).map(|i| if i < L / 2 { 0.5 } else { 0.0 }).collect()]),
            pan: 0.0,
            out: "master".into(),
            sends: vec![],
            reductions: vec![],
        };
        let music = TrackStem { name: "music".into(), buf: Arc::new([vec![0.3; L], vec![0.3; L]]), pan: 0.0, out: "music".into(), sends: vec![], reductions: vec![] };
        let duck = Effect::Comp(apricity_score::score::CompSpec {
            ratio: 4.0,
            threshold: -30.0,
            attack_ms: Some(2.0),
            release_ms: Some(40.0),
            knee: Some(0.0),
            makeup: None,
            sidechain: Some("voice".into()),
        });
        let mut m = mix(vec![voice, music], vec![bus("music", vec![duck], 1.0, "master")]);
        m.length = L;
        let (a, report) = m.build(&HashMap::new());
        let out = &stem(&a, "music").unwrap().buf[0];
        // The voice is 24 dB over the threshold; at 4:1 that's 18 dB of ducking.
        let ducked = 20.0 * (out[L / 4] / 0.3).log10();
        assert!((ducked + 18.0).abs() < 0.5, "ducked by {ducked:.1} dB");
        assert!((out[L - 100] - 0.3).abs() < 1e-3, "back up once the voice stops: {}", out[L - 100]);
        assert_eq!(report[0].0, "music");
        assert!((report[0].1[0].1 + 18.0).abs() < 0.5 && report[0].1[0].0.contains("sidechain voice"), "{report:?}");
    }

    #[test]
    fn tails_wrap_so_the_loop_is_seamless() {
        // A click mid-loop through a hall far longer than the loop: the last cycle of a long run
        // is what steady looping sounds like. The chain must reproduce it, start included.
        let mut click = [vec![0.0f32; N], vec![0.0f32; N]];
        click[0][N / 2] = 1.0;
        click[1][N / 2] = 1.0;
        let fx = vec![Effect::Reverb(ReverbSpec { kind: ReverbType::Hall, decay_s: Some(0.35), ..Default::default() })];
        let got = master::process_chain(&click, &fx, 48_000.0, 100.0, 1.0, &master::Keys::new()).0;
        let long: [Vec<f32>; 2] = [click[0].repeat(40), click[1].repeat(40)];
        let mut rv = apricity_dsp::space::Reverb::new(master::reverb_params(match &fx[0] { Effect::Reverb(r) => r, _ => unreachable!() }), 48_000.0);
        let reference: Vec<f32> = long[0].iter().zip(&long[1]).map(|(l, r)| rv.tick(*l as f64, *r as f64).0 as f32).collect();
        let last = &reference[39 * N..];
        let err = got[0].iter().zip(last).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        let peak = last.iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(err < peak * 1e-3, "max error {err} (peak {peak})");
        assert!(got[0][..N / 2].iter().any(|x| x.abs() > peak * 0.01), "the tail from the end rings into the start");
    }
}
