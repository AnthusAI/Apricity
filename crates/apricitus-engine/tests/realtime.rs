//! Mixer behaviour, including the real-time rule: `process` must never allocate or free.

use apricitus_engine::mixer::XFADE;
use apricitus_engine::master::{MasterParams, Stage};
use apricitus_engine::{engine, Arrangement, Command, Placement, Stem, SwapAt, TrackControl};
use apricitus_dsp::fx::{CompParams, EqParams, BiquadKind};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// ---- allocation counter: counts (de)allocations made on this thread while armed.
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
thread_local!(static ARMED: Cell<bool> = const { Cell::new(false) });

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if ARMED.with(|a| a.get()) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if ARMED.with(|a| a.get()) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static GLOBAL: Counting = Counting;

fn armed<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = ALLOCS.load(Ordering::Relaxed);
    ARMED.with(|a| a.set(true));
    let r = f();
    ARMED.with(|a| a.set(false));
    (r, ALLOCS.load(Ordering::Relaxed) - before)
}

/// A loop of `bars` 4-beat bars at 100 frames per beat, one constant-level buffer per bar.
fn constant(level: f32, bars: usize) -> Arrangement {
    let fpb = 100.0;
    let bar = 400;
    let placements = (0..bars)
        .map(|b| Placement { start: b * bar, skip: 0, buf: Arc::new([vec![level; bar], vec![-level; bar]]), gain: 1.0 })
        .collect();
    Arrangement::new(48_000, fpb, 4, bars * bar, placements)
}

/// Two stems, `a` and `b`, each a constant level (left positive, right negative), one bar long.
fn two_stems(a: f32, b: f32, master: MasterParams) -> Arrangement {
    let stem = |name: &str, v: f32| Stem { name: name.into(), buf: Arc::new([vec![v; 400], vec![-v; 400]]), pan: 0.0, solo_safe: false };
    Arrangement::from_stems(48_000, 100.0, 4, 400, vec![stem("a", a), stem("b", b)], master)
}

fn full_chain() -> MasterParams {
    let mut p = MasterParams::default();
    let mut eq = EqParams::default();
    eq.bands[0] = Some(BiquadKind::HighPass { hz: 30.0, q: 0.707 });
    eq.bands[1] = Some(BiquadKind::Peak { hz: 2000.0, db: 2.0, q: 1.0 });
    p.stages[0] = Some(Stage::Eq(eq));
    p.stages[1] = Some(Stage::Comp(CompParams { threshold_db: -20.0, ratio: 4.0, ..CompParams::default() }));
    p.stages[2] = Some(Stage::Width(1.3));
    p.stages[3] = Some(Stage::Limit { ceiling_db: -1.0, release_ms: 50.0 });
    p.gain_db = 6.0;
    p
}

fn run(mixer: &mut apricitus_engine::Mixer, frames: usize, block: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let (mut l, mut r) = (vec![0.0; block], vec![0.0; block]);
    let mut done = 0;
    while done < frames {
        let n = block.min(frames - done);
        mixer.process(&mut [&mut l[..n], &mut r[..n]]);
        out.extend_from_slice(&l[..n]);
        assert!(l[..n].iter().zip(&r[..n]).all(|(a, b)| (a + b).abs() < 1e-6), "stereo channels kept apart");
        done += n;
    }
    out
}

#[test]
fn swaps_exactly_at_the_next_bar_with_a_crossfade() {
    let (mut ctl, mut mix) = engine();
    ctl.load(constant(0.25, 4), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    let a = run(&mut mix, 150, 64);
    assert!(a.iter().all(|&x| (x - 0.25).abs() < 1e-6));

    ctl.load(constant(0.5, 4), SwapAt::NextBar).unwrap();
    // 150 frames in; the next bar line is at 400. Odd block sizes on purpose.
    let b = run(&mut mix, 1000, 37);
    let swap_at = 400 - 150;
    assert!(b[..swap_at].iter().all(|&x| (x - 0.25).abs() < 1e-6), "old material right up to the bar line");
    let bad: Vec<(usize, f32)> = b.iter().enumerate().skip(swap_at + XFADE).filter(|(_, x)| (**x - 0.5).abs() >= 1e-6).map(|(i, x)| (i, *x)).take(5).collect();
    assert!(bad.is_empty(), "new material after the crossfade: {bad:?}");
    let fade = &b[swap_at..swap_at + XFADE];
    assert!(fade.windows(2).all(|w| w[1] >= w[0] - 1e-6), "crossfade rises monotonically");
    assert!(fade[0] < 0.3 && fade[XFADE - 1] > 0.48);
    assert_eq!(ctl.status.swaps.load(Ordering::Relaxed), 2);
    assert_eq!(ctl.collect_garbage(), 1, "the replaced arrangement came back to be freed off the audio thread");
}

#[test]
fn loops_wrap_and_position_maps_by_beat_across_tempo_changes() {
    let (mut ctl, mut mix) = engine();
    ctl.load(constant(0.25, 2), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    run(&mut mix, 800 + 100, 128); // wrapped once, now at frame 100 (beat 1)
    assert_eq!(ctl.status.position.load(Ordering::Relaxed), 100);

    // Same music at half the tempo (200 frames per beat): beat 1 is now frame 200.
    let mut slow = constant(0.5, 2);
    slow.frames_per_beat = 200.0;
    ctl.load(slow, SwapAt::Now).unwrap();
    run(&mut mix, 10, 10);
    assert_eq!(ctl.status.position.load(Ordering::Relaxed), 210);
}

#[test]
fn paused_engine_is_silent_and_swaps_immediately() {
    let (mut ctl, mut mix) = engine();
    ctl.load(constant(0.25, 1), SwapAt::NextBar).unwrap();
    assert!(run(&mut mix, 100, 50).iter().all(|&x| x == 0.0));
    ctl.load(constant(0.5, 1), SwapAt::NextBar).unwrap();
    ctl.send(Command::Play).unwrap();
    // The Load was processed before Play in the same drain, so it swapped immediately; the
    // crossfade from the first arrangement then completes within XFADE frames.
    let out = run(&mut mix, 600, 64);
    assert!(out[XFADE..].iter().all(|&x| (x - 0.5).abs() < 1e-6));
}

#[test]
fn the_audio_thread_never_allocates_or_frees() {
    let (mut ctl, mut mix) = engine();
    ctl.load(constant(0.25, 4), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    let mut l = vec![0.0; 512];
    let mut r = vec![0.0; 512];
    let mut inter = vec![0.0; 512 * 2];
    // Warm up (first block, first swap).
    mix.process(&mut [&mut l, &mut r]);
    for round in 0..6 {
        // Queue a swap each round (allocation happens here, on the control thread) ...
        ctl.load(constant(0.1 * round as f32, 4), if round % 2 == 0 { SwapAt::NextBar } else { SwapAt::Now }).unwrap();
        // ... then run many audio callbacks through swaps, crossfades, loop wraps and garbage hand-off.
        let ((), n) = armed(|| {
            for i in 0..40 {
                if i % 3 == 0 {
                    mix.process_interleaved(&mut inter, 2);
                } else {
                    mix.process(&mut [&mut l, &mut r]);
                }
            }
        });
        assert_eq!(n, 0, "round {round}: the audio thread allocated or freed {n} times");
        ctl.collect_garbage();
    }
}

#[test]
fn live_fader_mute_and_solo() {
    let (mut ctl, mut mix) = engine();
    ctl.load(two_stems(0.25, 0.125, MasterParams::default()), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    let level = |mix: &mut apricitus_engine::Mixer| *run(mix, 64, 64).last().unwrap();
    assert!((level(&mut mix) - 0.375).abs() < 1e-6, "both stems");
    ctl.set_track("a", TrackControl { mute: true, ..Default::default() }).unwrap();
    assert!((level(&mut mix) - 0.125).abs() < 1e-6, "a muted");
    ctl.set_track("a", TrackControl { gain: 0.5, ..Default::default() }).unwrap();
    assert!((level(&mut mix) - 0.25).abs() < 1e-6, "a at half");
    ctl.set_track("b", TrackControl { solo: true, ..Default::default() }).unwrap();
    assert!((level(&mut mix) - 0.125).abs() < 1e-6, "b solo");
    // Controls stick to track names across a re-render, even with the stems in another order.
    let swapped = Arrangement::from_stems(
        48_000, 100.0, 4, 400,
        vec![Stem { name: "b".into(), buf: Arc::new([vec![0.125; 400], vec![-0.125; 400]]), pan: 0.0, solo_safe: false },
             Stem { name: "a".into(), buf: Arc::new([vec![0.25; 400], vec![-0.25; 400]]), pan: 0.0, solo_safe: false }],
        MasterParams::default(),
    );
    ctl.load(swapped, SwapAt::Now).unwrap();
    run(&mut mix, 1000, 64);
    ctl.set_track("b", TrackControl::default()).unwrap();
    assert!((level(&mut mix) - 0.25).abs() < 1e-6, "b unsoloed, a still at half: {}", level(&mut mix));
    assert_eq!(ctl.tracks(), ["b", "a"]);
}

#[test]
fn a_control_sent_before_a_pending_swap_lands_in_both() {
    let (mut ctl, mut mix) = engine();
    ctl.load(two_stems(0.25, 0.125, MasterParams::default()), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    run(&mut mix, 100, 50);
    ctl.load(two_stems(0.25, 0.125, MasterParams::default()), SwapAt::NextBar).unwrap();
    ctl.set_track("a", TrackControl { mute: true, ..Default::default() }).unwrap();
    let out = run(&mut mix, 900, 50);
    assert!(out.iter().all(|x| (x - 0.125).abs() < 1e-6), "muted before and after the swap");
}

#[test]
fn the_master_limiter_holds_its_ceiling() {
    let (mut ctl, mut mix) = engine();
    // Far too hot: +6 dB make-up on stems summing to 2.0.
    ctl.load(two_stems(1.2, 0.8, full_chain()), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    let out = run(&mut mix, 20_000, 128);
    let ceiling = 10f32.powf(-1.0 / 20.0);
    let peak = out.iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(peak <= ceiling + 1e-4, "peak {peak} over the -1 dB ceiling");
    assert!(ctl.status.reduction_db.load(Ordering::Relaxed) != 0, "the compressor reported gain reduction");
}

#[test]
fn master_chain_and_live_controls_stay_allocation_free() {
    let (mut ctl, mut mix) = engine();
    ctl.load(two_stems(0.3, 0.2, full_chain()), SwapAt::Now).unwrap();
    ctl.send(Command::Play).unwrap();
    let mut l = vec![0.0; 256];
    let mut r = vec![0.0; 256];
    mix.process(&mut [&mut l, &mut r]);
    for round in 0..6 {
        let mut p = full_chain();
        if round % 2 == 1 {
            p.stages[1] = None; // a stage changes kind across the swap
        }
        ctl.load(two_stems(0.1 * round as f32, 0.2, p), if round % 2 == 0 { SwapAt::NextBar } else { SwapAt::Now }).unwrap();
        ctl.set_track("a", TrackControl { gain: 0.5, mute: round % 3 == 0, solo: false }).unwrap();
        ctl.set_track("b", TrackControl { solo: round % 2 == 0, ..Default::default() }).unwrap();
        let ((), n) = armed(|| {
            for _ in 0..40 {
                mix.process(&mut [&mut l, &mut r]);
            }
        });
        assert_eq!(n, 0, "round {round}: the audio thread allocated or freed {n} times");
        ctl.collect_garbage();
    }
}
