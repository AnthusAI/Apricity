//! Audio-thread side. `Mixer::process` never allocates, frees, or locks:
//! - new arrangements arrive as `Arc`s through a lock-free ring buffer (`Controller::load`);
//! - swaps happen at the next bar line (or immediately), with a short crossfade;
//! - replaced arrangements are sent *back* through a second ring buffer, so their memory is
//!   freed on the control thread (`Controller::collect_garbage`), never on the audio thread;
//! - live track controls (fader, mute, solo) are fixed-size `Copy` data, addressed by the
//!   arrangement's generation and stem index, and the master chain retunes in place on a swap.

use crate::arrangement::{Arrangement, TrackControl, MAX_STEMS, UNITY};
use crate::master::MasterChain;
use std::collections::HashMap;
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// Crossfade length when swapping arrangements, in frames (~5 ms at 48 kHz).
pub const XFADE: usize = 256;
const XFADE_STEP: usize = 32;
/// Largest block `process_interleaved` handles in one go (it loops for bigger ones).
const SCRATCH: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapAt {
    Now,
    NextBar,
}

pub type Controls = [TrackControl; MAX_STEMS];

pub enum Command {
    /// An arrangement, when to swap it in, its generation, and its stems' starting controls.
    Load(Arc<Arrangement>, SwapAt, u64, Controls),
    /// Set one stem's controls in the arrangement of that generation (current or pending).
    SetTrack { generation: u64, index: usize, control: TrackControl },
    Play,
    Pause,
    /// Jump to a frame of the current arrangement.
    Seek(usize),
}

/// Shared, lock-free view of the transport for UIs.
#[derive(Default)]
pub struct Status {
    pub position: AtomicU64,
    pub length: AtomicU64,
    pub frames_per_bar: AtomicU64,
    pub playing: AtomicBool,
    pub pending_swap: AtomicBool,
    pub swaps: AtomicU64,
    /// Deepest master-compressor gain reduction in the last block (dB, as f64 bits; ≤ 0).
    pub reduction_db: AtomicU64,
}

impl Status {
    /// Current (bar, beat), 1-based.
    pub fn bar_beat(&self, beats_per_bar: u32) -> (u64, u64) {
        let fpbar = f64::from_bits(self.frames_per_bar.load(Ordering::Relaxed));
        if fpbar <= 0.0 {
            return (1, 1);
        }
        let pos = self.position.load(Ordering::Relaxed) as f64;
        let bar = (pos / fpbar).floor();
        let beat = ((pos - bar * fpbar) / (fpbar / beats_per_bar as f64)).floor();
        (bar as u64 + 1, beat as u64 + 1)
    }
}

pub struct Controller {
    commands: Producer<Command>,
    garbage: Consumer<Arc<Arrangement>>,
    pub status: Arc<Status>,
    /// Live controls by track name; they survive re-renders and apply to every new arrangement.
    controls: HashMap<String, TrackControl>,
    /// Stem names of the last two arrangements loaded (the playing one and a pending one).
    loaded: Vec<(u64, Vec<String>)>,
    generation: u64,
}

impl Controller {
    pub fn load(&mut self, a: Arrangement, at: SwapAt) -> Result<(), &'static str> {
        self.generation += 1;
        let names: Vec<String> = a.stems.iter().map(|s| s.name.clone()).collect();
        let mut controls = UNITY;
        for (c, n) in controls.iter_mut().zip(&names) {
            *c = self.controls.get(n).copied().unwrap_or_default();
        }
        self.send(Command::Load(Arc::new(a), at, self.generation, controls))?;
        self.loaded.push((self.generation, names));
        if self.loaded.len() > 2 {
            self.loaded.remove(0);
        }
        Ok(())
    }

    /// Set a track's live fader (linear gain), mute and solo. Takes effect within one audio block,
    /// and sticks across re-renders.
    pub fn set_track(&mut self, name: &str, control: TrackControl) -> Result<(), &'static str> {
        self.controls.insert(name.to_string(), control);
        let targets: Vec<(u64, usize)> =
            self.loaded.iter().filter_map(|(g, names)| names.iter().position(|n| n == name).map(|i| (*g, i))).collect();
        for (generation, index) in targets {
            self.send(Command::SetTrack { generation, index, control })?;
        }
        Ok(())
    }

    /// Every live control set so far, by track or bus name.
    pub fn controls(&self) -> &HashMap<String, TrackControl> {
        &self.controls
    }

    pub fn track(&self, name: &str) -> TrackControl {
        self.controls.get(name).copied().unwrap_or_default()
    }

    /// Stem names of the most recently loaded arrangement.
    pub fn tracks(&self) -> &[String] {
        self.loaded.last().map_or(&[], |(_, n)| n.as_slice())
    }

    pub fn send(&mut self, c: Command) -> Result<(), &'static str> {
        self.collect_garbage();
        self.commands.push(c).map_err(|_| "engine command queue is full")
    }

    /// Free arrangements the audio thread has finished with. Returns how many.
    pub fn collect_garbage(&mut self) -> usize {
        let mut n = 0;
        while self.garbage.pop().is_ok() {
            n += 1;
        }
        n
    }
}

struct Fading {
    arr: Arc<Arrangement>,
    controls: Controls,
    pos: usize,
    done: usize,
}

struct Pending {
    arr: Arc<Arrangement>,
    generation: u64,
    controls: Controls,
    countdown: usize,
}

pub struct Mixer {
    commands: Consumer<Command>,
    garbage: Producer<Arc<Arrangement>>,
    status: Arc<Status>,
    current: Option<Arc<Arrangement>>,
    generation: u64,
    controls: Controls,
    pos: usize,
    playing: bool,
    pending: Option<Pending>,
    fading: Option<Fading>,
    chain: MasterChain,
    scratch: [Vec<f32>; 2],
}

/// Create a connected (control side, audio side) pair.
pub fn engine() -> (Controller, Mixer) {
    let (ctx, crx) = RingBuffer::new(64);
    let (gtx, grx) = RingBuffer::new(64);
    let status = Arc::new(Status::default());
    (
        Controller { commands: ctx, garbage: grx, status: status.clone(), controls: HashMap::new(), loaded: Vec::new(), generation: 0 },
        Mixer {
            commands: crx,
            garbage: gtx,
            status,
            current: None,
            generation: 0,
            controls: UNITY,
            pos: 0,
            playing: false,
            pending: None,
            fading: None,
            chain: MasterChain::new(48_000.0),
            scratch: [vec![0.0; SCRATCH], vec![0.0; SCRATCH]],
        },
    )
}

impl Mixer {
    fn discard(&mut self, a: Arc<Arrangement>) {
        if let Err(rtrb::PushError::Full(a)) = self.garbage.push(a) {
            // The control thread isn't collecting; leaking beats freeing on the audio thread.
            std::mem::forget(a);
        }
    }

    fn drain_commands(&mut self) {
        while let Ok(cmd) = self.commands.pop() {
            match cmd {
                Command::Play => self.playing = true,
                Command::Pause => self.playing = false,
                Command::Seek(f) => {
                    if let Some(c) = &self.current {
                        self.pos = f % c.length.max(1);
                    }
                }
                Command::SetTrack { generation, index, control } => {
                    if generation == self.generation && index < MAX_STEMS {
                        self.controls[index] = control;
                    }
                    if let Some(p) = self.pending.as_mut().filter(|p| p.generation == generation) {
                        if index < MAX_STEMS {
                            p.controls[index] = control;
                        }
                    }
                }
                Command::Load(a, at, generation, controls) => {
                    if let Some(old) = self.pending.take() {
                        self.discard(old.arr);
                    }
                    let countdown = match (&self.current, at) {
                        (Some(c), SwapAt::NextBar) if self.playing => {
                            let fpbar = c.frames_per_bar();
                            let next = ((self.pos as f64 / fpbar).floor() + 1.0) * fpbar;
                            let boundary = (next.round() as usize).min(c.length);
                            boundary - self.pos
                        }
                        _ => 0,
                    };
                    self.pending = Some(Pending { arr: a, generation, controls, countdown });
                }
            }
        }
    }

    fn swap(&mut self) {
        let Some(Pending { arr: new, generation, controls, .. }) = self.pending.take() else { return };
        let new_pos = match &self.current {
            Some(c) if new.length > 0 => ((self.pos as f64 / c.frames_per_beat * new.frames_per_beat).round() as usize) % new.length,
            _ => 0,
        };
        if let Some(old) = self.current.take() {
            if let Some(f) = self.fading.take() {
                self.discard(f.arr);
            }
            self.fading = Some(Fading { arr: old, controls: self.controls, pos: self.pos, done: 0 });
        }
        self.pos = new_pos;
        self.generation = generation;
        self.controls = controls;
        if self.chain.sample_rate() != new.sample_rate as f64 {
            self.chain = MasterChain::new(new.sample_rate as f64);
        }
        self.chain.set(new.master);
        self.status.length.store(new.length as u64, Ordering::Relaxed);
        self.status.frames_per_bar.store(new.frames_per_bar().to_bits(), Ordering::Relaxed);
        self.status.swaps.fetch_add(1, Ordering::Relaxed);
        self.current = Some(new);
    }

    /// Fill a planar stereo block. Everything the audio callback needs; real-time safe.
    pub fn process(&mut self, out: &mut [&mut [f32]; 2]) {
        let n = out[0].len();
        for c in out.iter_mut() {
            c.fill(0.0);
        }
        self.drain_commands();
        if self.current.is_none() && self.pending.is_some() {
            self.swap();
        }
        let mut done = 0;
        while done < n {
            if self.pending.as_ref().is_some_and(|p| p.countdown == 0) {
                self.swap();
            }
            let Some(cur) = self.current.clone() else { break };
            if !self.playing || cur.length == 0 {
                break;
            }
            let mut chunk = (n - done).min(cur.length - self.pos);
            if let Some(p) = &self.pending {
                chunk = chunk.min(p.countdown);
            }
            if let Some(f) = &self.fading {
                // Stepped linear ramp; never overshoot the end of the fade.
                chunk = chunk.min(XFADE_STEP).min(XFADE - f.done);
            }
            let (g_new, g_old) = match &self.fading {
                Some(f) => {
                    let t = ((f.done + chunk / 2) as f32 / XFADE as f32).min(1.0);
                    (t, 1.0 - t)
                }
                None => (1.0, 0.0),
            };
            let [l, r] = out;
            let mut dst = [&mut l[done..done + chunk], &mut r[done..done + chunk]];
            cur.mix_into(self.pos, &mut dst, chunk, g_new, &self.controls);
            if let Some(f) = &mut self.fading {
                let flen = f.arr.length.max(1);
                let mut left = chunk;
                let mut off = 0;
                while left > 0 {
                    let c = left.min(flen - f.pos);
                    let [dl, dr] = &mut dst;
                    let mut d = [&mut dl[off..off + c], &mut dr[off..off + c]];
                    f.arr.mix_into(f.pos, &mut d, c, g_old, &f.controls);
                    f.pos = (f.pos + c) % flen;
                    off += c;
                    left -= c;
                }
                f.done += chunk;
            }
            if self.fading.as_ref().is_some_and(|f| f.done >= XFADE) {
                let f = self.fading.take().unwrap();
                self.discard(f.arr);
            }
            drop(cur); // just a refcount decrement: `self.current` still holds it
            self.pos = (self.pos + chunk) % self.current.as_ref().unwrap().length;
            if let Some(p) = &mut self.pending {
                p.countdown -= chunk;
            }
            done += chunk;
        }
        // The master chain always runs (even paused, so compressor and limiter tails settle).
        let [l, r] = out;
        self.chain.process(l, r);
        self.status.reduction_db.store(self.chain.take_reduction().to_bits(), Ordering::Relaxed);
        self.status.position.store(self.pos as u64, Ordering::Relaxed);
        self.status.playing.store(self.playing, Ordering::Relaxed);
        self.status.pending_swap.store(self.pending.is_some(), Ordering::Relaxed);
    }

    /// Interleaved output for audio APIs like CoreAudio/cpal; extra channels get silence.
    pub fn process_interleaved(&mut self, out: &mut [f32], channels: usize) {
        let frames = out.len() / channels.max(1);
        let mut at = 0;
        while at < frames {
            let n = (frames - at).min(SCRATCH);
            let [l, r] = &mut self.scratch;
            let (mut l, mut r) = (std::mem::take(l), std::mem::take(r));
            self.process(&mut [&mut l[..n], &mut r[..n]]);
            for i in 0..n {
                let o = &mut out[(at + i) * channels..(at + i + 1) * channels];
                o[0] = l[i];
                if channels > 1 {
                    o[1] = r[i];
                }
                for x in o.iter_mut().skip(2) {
                    *x = 0.0;
                }
            }
            self.scratch = [l, r];
            at += n;
        }
    }
}
