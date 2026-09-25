//! Compiler behaviour on a synthetic clip: layout, chord splitting, beat ratio, and the
//! guardrails (every mistake is reported, with a location and a suggestion where possible).

use apricity_score::{compile, Score};
use std::path::{Path, PathBuf};

/// A 32-beat clip at 60 BPM (one beat per second) whose chroma is a C major triad, plus a slice.
fn fixture(dir: &Path, name: &str, bpm: f64) -> PathBuf {
    let audio = dir.join(name);
    std::fs::write(&audio, b"not real audio; the compiler only reads the manifest").unwrap();
    let spb = 60.0 / bpm;
    let beats: Vec<f64> = (0..33).map(|i| 1.0 + i as f64 * spb).collect();
    let mut chroma = vec![0.02; 12];
    chroma[0] = 1.0;
    chroma[4] = 0.7;
    chroma[7] = 0.8;
    let manifest = serde_json::json!({
        "apricity_manifest": 1,
        "source": { "path": name, "sha256": "0".repeat(64), "sample_rate": 48000, "channels": 2, "duration": 1.0 + 33.0 * spb },
        "rhythm": {
            "bpm": bpm, "bpm_stability": 1.0, "beats": beats, "downbeats": [], "meter": 4,
            "warp_markers": beats.iter().enumerate().map(|(i, t)| serde_json::json!({"seconds": t, "beat": i as f64})).collect::<Vec<_>>()
        },
        "tonal": { "key": {"tonic": "C", "mode": "major", "strength": 0.9}, "tuning_hz": 440.0, "tuning_cents": 0.0,
                   "pitch_class_profile": chroma, "beat_chroma": vec![chroma.clone(); 32] },
        "annotations": {
            "clips": [{ "name": "intro", "start": 1.0, "end": 1.0 + 4.0 * spb }],
            "markers": [{ "name": "transient", "seconds": 1.0 + 2.0 * spb }, { "name": "transient", "seconds": 1.0 + 5.0 * spb }]
        }
    });
    std::fs::write(dir.join(format!("{name}.apricity.json")), manifest.to_string()).unwrap();
    audio
}

/// 20 seconds of speech: no beat grid at all, three phrases marked by automatic markup.
fn speech_fixture(dir: &Path) {
    std::fs::write(dir.join("speech.wav"), b"not real audio").unwrap();
    let manifest = serde_json::json!({
        "apricity_manifest": 1,
        "source": { "path": "speech.wav", "sha256": "0".repeat(64), "sample_rate": 48000, "channels": 1, "duration": 20.0 },
        "rhythm": { "bpm": null, "bpm_stability": 0.0, "beats": [], "downbeats": [], "meter": null, "warp_markers": [], "loudness": vec![-30.0; 40] },
        "tonal": { "key": {"tonic": "F#", "mode": "minor", "strength": 0.1}, "tuning_hz": 440.0, "tuning_cents": 12.0,
                   "pitch_class_profile": vec![0.5; 12], "beat_chroma": [] },
        "annotations": { "clips": [
            { "name": "phrase-1", "start": 0.4, "end": 3.1 },
            { "name": "phrase-2", "start": 3.9, "end": 7.5 },
            { "name": "phrase-3", "start": 8.2, "end": 19.0 }
        ] }
    });
    std::fs::write(dir.join("speech.wav.apricity.json"), manifest.to_string()).unwrap();
}

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("apricity-score-test-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&d).unwrap();
    fixture(&d, "horn.wav", 60.0);
    fixture(&d, "fast.wav", 240.0);
    speech_fixture(&d);
    d
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

fn run(yaml: &str) -> Result<apricity_score::Timeline, Vec<String>> {
    let dir = tmp();
    let score: Score = serde_yaml::from_str(yaml).map_err(|e| vec![e.to_string()])?;
    compile(&score, &dir)
}

#[test]
fn loops_tile_and_split_at_chord_changes() {
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: C
clips: { horn: { source: horn.wav, beats: [0, 8], beat_ratio: 1 } }
progression: [ { chord: I, bars: 1 }, { chord: V, bars: 3 } ]
tracks: [ { clip: horn, role: root } ]
"#)
    .unwrap();
    assert_eq!(tl.length_beats, 16.0);
    // An 8-beat loop over 16 beats = 2 notes; the first is split at the I→V change at beat 4.
    let spans: Vec<(f64, f64, i32)> = tl.events.iter().map(|e| (e.start_beat, e.dur_beats, e.semitones)).collect();
    assert_eq!(spans, vec![(0.0, 4.0, 0), (4.0, 4.0, -5), (8.0, 8.0, -5)]);
    // The split half starts 4 clip beats (= 4 s) into the region, and warps one point per beat.
    let e = &tl.events[1];
    assert!((e.src_start - 5.0).abs() < 1e-9 && (e.src_end - 9.0).abs() < 1e-9, "{e:?}");
    assert_eq!(e.warp.len(), 5);
    assert!(e.warp.windows(2).all(|w| w[1].0 > w[0].0 && w[1].1 > w[0].1));
}

#[test]
fn double_time_clips_fold_automatically() {
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: C
bars: 1
clips: { fast: { source: fast.wav, beats: [0, 8] } }
tracks: [ { clip: fast } ]
"#)
    .unwrap();
    // 240 BPM against 120: two clip beats per score beat, so 8 clip beats fill 4 score beats.
    assert_eq!(tl.tracks[0].beat_ratio, 2.0);
    assert_eq!(tl.events.len(), 1);
    assert_eq!(tl.events[0].dur_beats, 4.0);
    assert_eq!(tl.tracks[0].stretch, Some(1.0));
}

#[test]
fn patterns_every_and_at() {
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: C
bars: 4
clips: { horn: { source: horn.wav, saved: intro, beat_ratio: 1 } }
tracks:
  - { clip: horn, name: a, pattern: { every: 2beats } }
  - { clip: horn, name: b, pattern: { at: ["2:1", "4:3"] }, transpose: 3 }
"#)
    .unwrap();
    let a: Vec<_> = tl.events.iter().filter(|e| e.track == "a").map(|e| (e.start_beat, e.dur_beats)).collect();
    assert_eq!(a.len(), 8);
    assert!(a.iter().all(|&(_, d)| d == 2.0));
    let b: Vec<_> = tl.events.iter().filter(|e| e.track == "b").map(|e| (e.start_beat, e.dur_beats, e.semitones)).collect();
    // The second hit is cut off by the end of the piece.
    assert_eq!(b, vec![(4.0, 4.0, 3), (14.0, 2.0, 3)]);
}

#[test]
fn every_mistake_is_reported_with_a_location() {
    let errors = run(r#"
apricity: 0.1
tempo: 120
key: Abm
clips:
  horn:  { source: horn.wav, beats: [0, 99] }
  horn2: { source: missing.wav }
  horn3: { source: horn.wav, beats: [0, 4], saved: intro }
  horn4: { source: horn.wav, saved: chorus }
progression: [ { chord: iv, bars: 2 }, { chord: I6, bars: 2 } ]
tracks:
  - { clip: hron }
  - { clip: horn4, bars: "3-9" }
"#)
    .unwrap_err();
    let all = errors.join("\n");
    for expected in [
        "clips.horn.beats: [0, 99] is outside the clip's beats [0, 32]",
        "clips.horn2.source: audio file",
        "clips.horn3: give at most one of beats, seconds, a saved clip or pick",
        "clips.horn4.saved: no saved clip \"chorus\" in this sample; it has [\"intro\"]",
        "progression[1].chord: \"I6\": inversion figures",
        "tracks[0].clip: no clip or kit named \"hron\" (did you mean \"horn\"?)",
        "tracks[1].bars: \"3-9\" runs past the end of the piece (4 bars)",
    ] {
        assert!(all.contains(expected), "missing {expected:?} in:\n{all}");
    }
}

#[test]
fn typos_in_field_names_are_rejected() {
    let err = run("apricity: 0.1\ntempo: 120\nkey: C\nbars: 1\nclips: { horn: { source: horn.wav, beat: [0, 4] } }\ntracks: [ { clip: horn } ]\n").unwrap_err();
    assert!(err[0].contains("unknown field `beat`"), "{err:?}");
}

#[test]
fn pick_finds_the_best_window() {
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
clips: { horn: { source: horn.wav, pick: 2bars } }
progression: [ { chord: I, bars: 2 } ]
tracks: [ { clip: horn, role: root } ]
"#)
    .unwrap();
    let (a, b) = tl.tracks[0].region_beats;
    assert_eq!(b - a, 8.0);
    assert_eq!(a % 4.0, 0.0, "picked windows start on a bar line");
    assert!(tl.events.iter().all(|e| e.semitones == 0), "a C-major clip already fits I of C");
}

#[test]
fn follow_moves_with_the_chord_root() {
    // A C-rooted riff through a 12-bar blues in F: I7 = F (+5), IV7 = Bb (-2), V7 = C (0).
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: F
clips: { riff: { source: horn.wav, beats: [0, 4], beat_ratio: 1 } }
progression:
  - { chord: I7, bars: 4 }
  - { chord: IV7, bars: 2 }
  - { chord: I7, bars: 2 }
  - { chord: V7, bars: 1 }
  - { chord: IV7, bars: 1 }
  - { chord: I7, bars: 1 }
  - { chord: V7, bars: 1 }
tracks: [ { clip: riff, transpose: follow } ]
"#)
    .unwrap();
    let per_bar: Vec<i32> = tl.events.iter().map(|e| e.semitones).collect();
    assert_eq!(per_bar, vec![5, 5, 5, 5, -2, -2, 5, 5, 0, -2, 5, 0]);
}

#[test]
fn root_pins_what_a_region_is_built_on() {
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: F
progression: [ { chord: I, bars: 1 } ]
clips: { riff: { source: horn.wav, beats: [0, 4], beat_ratio: 1, root: G } }
tracks: [ { clip: riff, transpose: follow } ]
"#)
    .unwrap();
    assert_eq!(tl.events[0].semitones, -2, "G moved to F");
    assert_eq!(tl.tracks[0].region_key, "G (pinned)");
    let err = run(r#"
apricity: 0.1
tempo: 120
key: F
progression: [ { chord: I, bars: 1 } ]
clips: { riff: { source: horn.wav, beats: [0, 4], root: H } }
tracks: [ { clip: riff, transpose: follow, role: third } ]
"#)
    .unwrap_err()
    .join("\n");
    assert!(err.contains("clips.riff.root") && err.contains("follow"), "{err}");
}

fn hits_of(tl: &apricity_score::Timeline, track: &str) -> Vec<(f64, f64, f64)> {
    // (start beat, duration, source second where it starts) — horn.wav: clip beat b is at 1 + b seconds.
    tl.events.iter().filter(|e| e.track == track).map(|e| (round(e.start_beat), round(e.dur_beats), round(e.src_start))).collect()
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

#[test]
fn sliced_kits_play_with_steps() {
    // 60 BPM so one clip beat = one score beat = one second (no folding).
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits: { k: { clip: horn, slice: { beats: 2 } } }
tracks:
  - { clip: k, pattern: { steps: "1 . 3 _" }, grid: 4 }
"#)
    .unwrap();
    assert_eq!(tl.tracks[0].chops, Some(8));
    // pad 1 = clip beats 0–2, pad 3 = clip beats 4–6. `.` is silence, `_` holds pad 3 to 2 beats.
    assert_eq!(hits_of(&tl, "k"), vec![(0.0, 1.0, 1.0), (2.0, 2.0, 5.0)]);
}

#[test]
fn swing_delays_the_offbeat_steps() {
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits: { k: { clip: horn, slice: { beats: 1 } } }
tracks: [ { clip: k, pattern: { steps: "1 2 3 4" }, swing: 75 } ]
"#)
    .unwrap();
    // Sixteenths (0.25 beat); swing 75 pushes steps 2 and 4 late by half a step (0.125).
    let starts: Vec<f64> = hits_of(&tl, "k").iter().map(|h| h.0).collect();
    assert_eq!(starts[..4], [0.0, 0.375, 0.5, 0.875]);
}

const GROOVE: &str = r#"
apricity: 0.1
tempo: 60
key: C
bars: 2
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits: { k: { clip: horn, slice: { beats: 1 } } }
"#;

fn groove(extra: &str, tracks: &str) -> apricity_score::Timeline {
    run(&format!("{GROOVE}{extra}\ntracks: [ {tracks} ]\n")).unwrap()
}

fn starts(tl: &apricity_score::Timeline, track: &str) -> Vec<f64> {
    hits_of(tl, track).iter().map(|h| h.0).collect()
}

#[test]
fn score_swing_is_the_default_and_a_track_overrides_it() {
    let tl = groove("swing: 75", r#"{ clip: k, pattern: { steps: "1 2 3 4" } }, { clip: k, name: straight, pattern: { steps: "1 2 3 4" }, swing: 50 }"#);
    assert_eq!(starts(&tl, "k")[..4], [0.0, 0.375, 0.5, 0.875]);
    assert_eq!(starts(&tl, "straight")[..4], [0.0, 0.25, 0.5, 0.75]);
}

#[test]
fn swing_on_eighths_leaves_the_sixteenths_between_them() {
    // Base 1/8, swing 60: the offbeat eighth (beat 0.5) lands at 60% of the beat; the sixteenths
    // at 0.25 and 0.75 aren't on the eighth grid, so they stay.
    let tl = groove("", r#"{ clip: k, pattern: { steps: "1 2 3 4" }, swing: 60, swing_base: 8 }"#);
    assert_eq!(starts(&tl, "k")[..4], [0.0, 0.25, 0.6, 0.75]);
}

#[test]
fn an_odd_length_pattern_keeps_its_swing_in_every_bar() {
    // Three steps repeating: step 1 lands on even and odd sixteenths in turn; only the odd ones swing.
    let tl = groove("swing: 75", r#"{ clip: k, pattern: { steps: "1 2 3" } }"#);
    for s in starts(&tl, "k") {
        let slot = (s / 0.25).floor();
        let late = s - slot * 0.25;
        assert!(if slot as i64 % 2 == 1 { (late - 0.125).abs() < 1e-9 } else { late.abs() < 1e-9 }, "{s} swung on the wrong step");
    }
}

#[test]
fn velocity_is_a_level_change_after_level_matching() {
    let tl = groove("", r#"{ clip: k, pattern: { steps: "1 1@40 1! 1" } }, { clip: k, name: soft, pattern: { steps: "1" }, velocity: 50 }"#);
    let gains: Vec<f64> = tl.events.iter().filter(|e| e.track == "k").take(4).map(|e| e.gain_db).collect();
    let base = gains[0];
    assert!((gains[1] - base - 40.0 * (0.4f64).log10()).abs() < 1e-9, "@40 is about −16 dB: {gains:?}");
    assert!((gains[2] - base - 40.0 * (1.27f64).log10()).abs() < 1e-9, "! is 127, about +4 dB: {gains:?}");
    assert_eq!(gains[3], base);
    let k: Vec<Option<f64>> = tl.events.iter().filter(|e| e.track == "k").take(4).map(|e| e.velocity).collect();
    assert_eq!(k, vec![None, Some(40.0), Some(127.0), None]);
    let soft = tl.events.iter().find(|e| e.track == "soft").unwrap();
    assert!((soft.gain_db - base - 40.0 * (0.5f64).log10()).abs() < 1e-9, "a track's velocity is its notes' default");
}

#[test]
fn humanize_is_bounded_repeatable_and_a_new_seed_is_a_new_take() {
    let tracks = r#"{ clip: k, pattern: { steps: "1 1 1 1" }, humanize: { timing_ms: 20, velocity: 25 } }"#;
    let a = groove("", tracks);
    let straight = groove("", r#"{ clip: k, pattern: { steps: "1 1 1 1" } }"#);
    let b = groove("", tracks);
    let other = groove("seed: 7", tracks);
    let (sa, s0) = (starts(&a, "k"), starts(&straight, "k"));
    assert_eq!(sa, starts(&b, "k"), "the same score gives the same take");
    assert_ne!(sa, starts(&other, "k"), "another seed, another take");
    assert!(sa.iter().zip(&s0).any(|(x, y)| x != y), "notes do move");
    for (x, y) in sa.iter().zip(&s0) {
        assert!((x - y).abs() <= 0.020 + 1e-3 && *x >= 0.0, "within ±20 ms at 60 BPM, never before the start: {x} vs {y}");
    }
    let g0 = straight.events[0].gain_db;
    for e in &a.events {
        let v = e.velocity.unwrap_or(100.0);
        assert!((75.0..=125.0).contains(&v), "velocity within ±25%: {v}");
        assert!((e.gain_db - g0 - 40.0 * (v / 100.0).log10()).abs() < 0.02, "{} vs {g0} at velocity {v}", e.gain_db);
    }
}

#[test]
fn groove_mistakes_are_reported() {
    let errs = run(&format!("{GROOVE}swing: 80\nhumanize: {{ timing_ms: 500 }}\ntracks: [ {{ clip: k, pattern: {{ steps: \"1\" }}, velocity: 200, swing: 58, swing_base: 3 }} ]\n")).unwrap_err();
    for want in ["swing: 80 is outside 50–75", "humanize: timing 500ms is outside 0–100ms", "tracks[0].velocity: 200 is outside 1–127", "tracks[0].swing: swing works on 1/2, 1/4, 1/8, 1/16 or 1/32, not 1/3"] {
        assert!(errs.iter().any(|e| e.contains(want)), "missing {want:?} in {errs:?}");
    }
    let bad = run(&format!("{GROOVE}tracks: [ {{ clip: k, pattern: {{ steps: \"1@0 .@50\" }} }} ]\n")).unwrap_err();
    assert!(bad.iter().any(|e| e.contains("velocity is a whole number 1–127")), "{bad:?}");
}

#[test]
fn slice_pads_stutter_gate_and_half_time() {
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits: { k: { clip: horn, slice: { into: 4 } } }
tracks:
  - { clip: k.3, name: stut, pattern: { every: 4beats }, stutter: 2, gate: 0.5, reverse: true, filter: { lowpass: 800 } }
  - { clip: k.2, name: slow, speed: 0.5 }
"#)
    .unwrap();
    // k.3 = clip beats 8–12. Stutter 2 → two 2-beat pieces, each restarting at the slice; gate halves them.
    assert_eq!(hits_of(&tl, "stut"), vec![(0.0, 1.0, 9.0), (2.0, 1.0, 9.0)]);
    let e = tl.events.iter().find(|e| e.track == "stut").unwrap();
    assert!(e.reverse && e.filter.is_some());
    // Half-time: the 4-beat slice k.2 (clip beats 4–8) now lasts 8 beats, so one bar holds half of it.
    assert_eq!(hits_of(&tl, "slow"), vec![(0.0, 4.0, 5.0)]);
    assert_eq!(tl.tracks[1].beat_ratio, 0.5);
}

#[test]
fn kits_sliced_at_transients() {
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 2
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits: { h: { clip: horn, slice: transients } }
tracks: [ { clip: h, pattern: { steps: "1 _ _ _ 2 _ _ _" }, grid: 4 } ]
"#)
    .unwrap();
    // Transients at clip beats 2 and 5: slice 1 runs to the next transient (3 beats), slice 2 up to a bar (4 beats).
    assert_eq!(tl.tracks[0].chops, Some(2));
    assert_eq!(hits_of(&tl, "h")[..2], [(0.0, 3.0, 3.0), (4.0, 4.0, 6.0)]);
}

#[test]
fn kit_mistakes_are_explained() {
    let errors = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits: { k: { clip: horn, slice: { beats: 4 } }, bad: { clip: hron, slice: { into: 2 } } }
tracks:
  - { clip: k, pattern: { steps: "1 2 9" } }
  - { clip: k }
  - { clip: horn, pattern: { steps: "1 2" } }
  - { clip: k.7 }
  - { clip: k, pattern: { steps: "1" }, swing: 90, gate: 2, speed: 20 }
"#)
    .unwrap_err()
    .join("\n");
    for expected in [
        "kits.bad.clip: no clip named \"hron\" (did you mean \"horn\"?)",
        "tracks[0].pattern.steps: uses pad 9, but kit `k` has 4 pads",
        "tracks[1].pattern: `k` is a kit; play it with steps",
        "tracks[2].pattern.steps: `1` picks a pad, but `horn` is a single sound; use x",
        "tracks[3].clip: kit `k` has pads 1–4; there's no `k.7`",
        "tracks[4].swing: 90 is outside 50–75",
        "tracks[4].gate: 2 must be between 0 and 1",
        "tracks[4].speed: 20 is outside 0.125–8",
    ] {
        assert!(errors.contains(expected), "missing {expected:?} in:\n{errors}");
    }
}

#[test]
fn drum_kits_mix_pads_from_different_clips() {
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 16] }, fast: { source: fast.wav, beats: [0, 16], beat_ratio: 1 } }
kits:
  k: { clip: horn, slice: { beats: 1 } }
  drums:
    pads:
      kick:  { clip: horn, beats: [2, 3] }
      snare: { clip: fast, beats: [4, 5] }
      rim:   { clip: k.8 }
tracks:
  - { clip: drums, pattern: { steps: "kick . snare rim" }, grid: 4 }
  - { clip: drums.kick, name: four, pattern: { steps: "x x x x" }, grid: 4, transpose: 0 }
"#)
    .unwrap();
    let pads: Vec<(f64, f64, usize)> = tl.events.iter().filter(|e| e.track == "drums").map(|e| (round(e.start_beat), round(e.src_start), e.source)).collect();
    // horn is 60 BPM (clip beat b at 1 + b s), fast is 240 BPM (1 + b/4 s): kick = horn beat 2 → 3.0 s,
    // snare = fast beat 4 → 2.0 s, rim = slice k.8 = horn beat 7 → 8.0 s. Each pad keeps its own source.
    let horn = tl.sources.iter().position(|s| s.clip == "horn").unwrap();
    let fast = tl.sources.iter().position(|s| s.clip == "fast").unwrap();
    assert_eq!(pads, vec![(0.0, 3.0, horn), (2.0, 2.0, fast), (3.0, 8.0, horn)]);
    assert_eq!(tl.tracks[0].chops, Some(3));
    assert_eq!(hits_of(&tl, "four").len(), 4);

    let errors = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 16] } }
kits:
  drums: { pads: { kick: { clip: horn, beats: [2, 3] }, clap: { clip: hron } } }
  both: { clip: horn, slice: { beats: 1 }, pads: { a: { clip: horn } } }
tracks:
  - { clip: drums, pattern: { steps: "kick . snair ." } }
  - { clip: drums, name: d2, pattern: { steps: "1 . 2 ." } }
  - { clip: drums.kik, name: d3 }
  - { clip: drums, name: d4, pattern: { steps: "x . x ." } }
"#)
    .unwrap_err()
    .join("\n");
    for expected in [
        "kits.drums.pads.clap.clip: no clip or slice named \"hron\" (did you mean \"horn\"?)",
        "kits.both: a kit is either `clip` + `slice` (a sliced clip) or `pads` (a drum kit)",
        "tracks[0].pattern.steps: kit `drums` has no pad `snair`",
        "tracks[1].pattern.steps: `1`: kit `drums` has named pads; call them by name",
        "tracks[2].clip: kit `drums` has no pad `kik` (did you mean \"kick\"?)",
        "tracks[3].pattern.steps: `x` plays the track's own sound, but this track is the whole kit `drums`",
    ] {
        assert!(errors.contains(expected), "missing {expected:?} in:\n{errors}");
    }
}

#[test]
fn routing_reaches_the_timeline_feeders_first() {
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 4] } }
tracks:
  - { clip: horn, name: a, sends: { room: 0.25 }, group: inner }
  - { clip: horn, name: b, group: beat, volume: -1 }
groups:
  beat: { effects: [ {comp: {ratio: 3, threshold: -12}} ], volume: -2 }
  inner: { group: beat }
returns:
  room: { effects: [ {reverb: {type: plate, decay_s: 1.8}} ], volume: -3 }
"#)
    .unwrap();
    let got: Vec<(&str, &str, &str)> = tl.buses.iter().map(|b| (b.name.as_str(), b.kind.as_str(), b.out.as_str())).collect();
    assert_eq!(got, [("inner", "group", "beat"), ("beat", "group", "master"), ("room", "return", "master")], "groups inside out, then returns");
    assert_eq!((tl.buses[1].gain_db, tl.buses[2].gain_db), (-2.0, -3.0));
    assert_eq!((tl.tracks[0].out.as_str(), tl.tracks[0].sends["room"]), ("inner", 0.25));
    assert_eq!(tl.tracks[1].out, "beat");
    assert!(tl.events.iter().filter(|e| e.track == "b").all(|e| (e.gain_db - (-1.0 + tl.tracks[1].level_db)).abs() < 1e-9), "volume is the track's fader");
}

#[test]
fn routing_mistakes_are_explained() {
    let errors = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 4] } }
tracks:
  - { clip: horn, group: bet, sends: { echo: 1.5, master: 0.2, beat: 0.1 } }
  - { clip: horn, group: echo }
  - { clip: horn }
groups:
  beat: { effects: [ {reverb: {decay_s: 60}} ], group: loop2 }
  loop2: { group: beat }
  horn: {}
returns:
  echo: { effects: [ {delay: {beats: 0.5, ms: 200, feedback: 1.2}} ], volume: 20 }
  room: {}
master: { effects: [ {reverb: {}} ] }
"#)
    .unwrap_err()
    .join("\n");
    for expected in [
        "tracks[0].group: there's no group track `bet` (did you mean \"beat\"?)",
        "tracks[0].sends.echo: 150% is outside 0–100%",
        "tracks[0].sends: a track already plays into the master; send to a return track",
        "tracks[0].sends.beat: there's no return track `beat`; `beat` is a group track: put the track in it with group beat",
        "tracks[1].group: there's no group track `echo`; `echo` is a return track: reach it with send echo 20%",
        "tracks[2]: track name \"horn\" is used twice",
        "groups.beat.effects[0].reverb.decay: 60 s is outside",
        "groups.horn: a track is also named `horn`",
        "groups.horn: nothing plays in this group",
        "groups: `beat`, `loop2` sit inside each other in a loop",
        "returns.echo.volume: 20 dB is outside -60 to +12",
        "returns.echo.effects[0].delay: give the time once",
        "returns.echo.effects[0].delay.feedback: 120% is outside",
        "returns.room: nothing sends to this return track",
        "master.effects[0]: reverb doesn't go on the master",
    ] {
        assert!(errors.contains(expected), "missing {expected:?} in:\n{errors}");
    }
}

#[test]
fn unwarped_speech_plays_as_recorded_and_the_piece_grows_to_hold_it() {
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: C
clips:
  speech: { source: speech.wav, warp: repitch }
  horn:   { source: horn.wav, beats: [0, 4] }
progression: [ { chord: I, bars: 1 }, { chord: IV, bars: 1 } ]
tracks:
  - { clip: speech, pattern: { at: ["1"] } }
  - { clip: horn }
"#)
    .unwrap();
    // 20 s at 120 BPM = 40 beats = 10 bars: the 2-bar progression repeats five times.
    assert_eq!(tl.length_beats, 40.0);
    assert_eq!(tl.harmony.len(), 10);
    assert!(tl.harmony[9].label.starts_with("IV"), "{}", tl.harmony[9].label);
    assert!(tl.warnings.iter().any(|w| w.contains("speech: plays 20.0 s, past the 2 bars of chords; the piece grows to 10 bars")), "{:?}", tl.warnings);
    let speech: Vec<_> = tl.events.iter().filter(|e| e.track == "speech").collect();
    assert_eq!(speech.len(), 1, "one event, not split at the chord changes");
    let e = speech[0];
    assert_eq!((e.start_beat, e.dur_beats, e.semitones, e.tuning_cents), (0.0, 40.0, 0, 0.0));
    assert!((e.src_start - 0.0).abs() < 1e-9 && (e.src_end - 20.0).abs() < 1e-9);
    assert_eq!(e.mode, apricity_score::score::WarpModeSpec::Repitch);
    assert_eq!(tl.tracks[0].varispeed, Some(1.0));
    assert!((tl.tracks[0].level_db - 10.0).abs() < 1e-6, "level-matched from the time curve (-30 dBFS → -20): {}", tl.tracks[0].level_db);
    assert!(tl.events.iter().filter(|e| e.track == "horn").map(|e| e.start_beat + e.dur_beats).fold(0.0, f64::max) >= 40.0 - 1e-9, "the other tracks fill the grown piece");
}

#[test]
fn varispeed_seconds_cues_and_phrases() {
    let tl = run(r#"
apricity: 0.1
tempo: 120
key: C
bars: 16
clips:
  fast:  { source: speech.wav, warp: repitch, speed: 2, seconds: [0, 10] }
  words: { source: speech.wav, warp: repitch }
kits: { w: { clip: words, slice: phrases } }
tracks:
  - { clip: fast, pattern: { at: ["1", "12.5s"] } }
  - { clip: w.2, pattern: { at: ["3:2.5"] } }
  - { clip: w, pattern: { steps: "3 . 1 ." }, grid: 4, bars: "9" }
"#)
    .unwrap();
    let fast: Vec<_> = tl.events.iter().filter(|e| e.track == "fast").collect();
    // 10 s at double speed = 5 s = 10 beats; the second cue at 12.5 s = beat 25.
    assert_eq!(fast.iter().map(|e| (e.start_beat, e.dur_beats)).collect::<Vec<_>>(), [(0.0, 10.0), (25.0, 10.0)]);
    assert!((fast[0].src_end - 10.0).abs() < 1e-9, "all 10 s of source in 5 s");
    assert_eq!(tl.tracks[0].varispeed, Some(2.0));
    let p2 = tl.events.iter().find(|e| e.track == "w.2").unwrap();
    assert_eq!(p2.start_beat, 9.5);
    assert!((p2.src_start - 3.9).abs() < 1e-6 && (p2.src_end - 7.5).abs() < 1e-6, "{} {}", p2.src_start, p2.src_end);
    assert!((p2.dur_beats - 3.6 * 2.0).abs() < 1e-6, "3.6 s of phrase at 120 BPM");
    // steps over phrases: phrase 3 on beat 1 of bar 9 (cut at the next step), phrase 1 on beat 3.
    let st: Vec<_> = tl.events.iter().filter(|e| e.track == "w").map(|e| (e.start_beat, (e.src_start * 10.0).round() / 10.0)).collect();
    assert_eq!(st, [(32.0, 8.2), (34.0, 0.4)]);
}

#[test]
fn voice_layer_mistakes_are_explained() {
    let errors = run(r#"
apricity: 0.1
tempo: 120
key: C
bars: 4
clips:
  speech: { source: speech.wav }
  horn:   { source: horn.wav, speed: 1.5 }
  talk:   { source: speech.wav, warp: repitch, speed: 9 }
  said:   { source: speech.wav, warp: repitch, pick: 1bar }
  line:   { source: speech.wav, warp: repitch }
  hornk:  { source: horn.wav, beats: [0, 4] }
kits: { k: { clip: hornk, slice: phrases } }
tracks:
  - { clip: line, transpose: follow, pattern: { at: ["1", "-3s", "soon"] } }
"#)
    .unwrap_err()
    .join("\n");
    for expected in [
        "clips.speech: no beat grid was detected, so it can't be warped by beats; add `warp repitch` to play it as recorded",
        "clips.horn.speed: speed is for re-pitched clips (warp repitch)",
        "clips.talk.speed: 9× is outside 0.25–4",
        "clips.said: `pick` needs the clip's own beats, but it plays re-pitched",
        "kits.k.slice: `hornk` has no phrases marked in its region",
        "tracks[0].transpose: `line` plays re-pitched (as recorded), so it isn't transposed",
        "tracks[0].pattern.at[1]: \"-3s\": seconds count from the start",
        "tracks[0].pattern.at[2]: \"soon\"",
    ] {
        assert!(errors.contains(expected), "missing {expected:?} in:\n{errors}");
    }
}

#[test]
fn sidechain_mistakes_are_explained() {
    let errors = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips: { horn: { source: horn.wav, beats: [0, 4] } }
tracks:
  - { clip: horn, name: a, effects: [ {comp: {ratio: 4, threshold: -30, sidechain: b}} ] }
  - { clip: horn, name: b, effects: [ {comp: {ratio: 4, threshold: -30, sidechain: a}} ], group: grp }
  - { clip: horn, name: c, effects: [ {comp: {ratio: 4, threshold: -30, sidechain: c}}, {comp: {ratio: 4, threshold: -30, sidechain: bee}}, {comp: {ratio: 4, threshold: -30, sidechain: grp}} ] }
  - { clip: horn, name: d, effects: [ {drive: {db: 50}}, {lofi: {}}, {lofi: {bits: 1}}, {width: 3}, {noisegate: {threshold: 5}} ] }
groups:
  grp: {}
master: { effects: [ {comp: {ratio: 2, threshold: -10, sidechain: a}}, {lofi: {bits: 8}}, {width: 1.2} ] }
"#)
    .unwrap_err()
    .join("\n");
    for expected in [
        "tracks[0]: `a` is ducked by a track that is (in turn) ducked by it",
        "tracks[2]: a comp can't be keyed by its own track",
        "tracks[2]: sidechain `bee`: there's no track by that name (did you mean \"b\"?)",
        "tracks[2]: sidechain `grp`: there's no track by that name (a group or return track can't key a sidechain",
        "tracks[3].effects[0].drive: 50 dB is outside",
        "tracks[3].effects[1].lofi: give it bits, rate and/or wow",
        "tracks[3].effects[2].lofi.bits: 1 bits is outside",
        "tracks[3].effects[3].width: 300% is outside",
        "tracks[3].effects[4].noisegate.threshold: 5 dB is outside",
        "master.effects[0]: the master can't duck",
        "master.effects[1]: lofi doesn't go on the master",
    ] {
        assert!(errors.contains(expected), "missing {expected:?} in:\n{errors}");
    }
    assert!(!errors.contains("master.effects[2]"), "width is fine on the master:\n{errors}");
}

#[test]
fn events_trace_back_to_the_piece_and_source_they_play() {
    // A sliced kit and a drum kit whose pads come from two clips: every event names its piece,
    // and the piece says which source it's from and where.
    let tl = run(r#"
apricity: 0.1
tempo: 60
key: C
bars: 1
clips:
  horn: { source: horn.wav, beats: [0, 16] }
  fast: { source: fast.wav, beats: [0, 16], beat_ratio: 1 }
kits:
  k: { clip: horn, slice: { beats: 2 } }
  d: { pads: { hi: { clip: horn, beats: [4, 5] }, lo: { clip: fast, beats: [2, 3] } } }
tracks:
  - { clip: k, pattern: { steps: "1 . 3 _" }, grid: 4 }
  - { clip: d, pattern: { steps: "hi lo hi lo" }, grid: 4 }
"#)
    .unwrap();
    let k = &tl.tracks[0];
    assert_eq!((k.kit.as_deref(), k.pieces.len()), (Some("k"), 8));
    // The slices tile their clip's region, end to end.
    let region = tl.sources[k.pieces[0].source].region.expect("sources carry their region");
    assert!((k.pieces[0].src_start - region.0).abs() < 1e-6 && (k.pieces[7].src_end - region.1).abs() < 1e-6, "{region:?}");
    let d = &tl.tracks[1];
    assert_eq!(d.pieces.iter().map(|p| p.name.as_deref().unwrap()).collect::<Vec<_>>(), ["hi", "lo"]);
    assert_ne!(d.pieces[0].source, d.pieces[1].source, "pads from two clips point at two sources");
    for e in &tl.events {
        let tr = tl.tracks.iter().find(|t| t.name == e.track).unwrap();
        let p = &tr.pieces[e.piece];
        assert_eq!(p.source, e.source);
        assert!(e.src_start >= p.src_start - 1e-6 && e.src_end <= p.src_end + 1e-6, "{e:?} inside {p:?}");
    }
    let played: Vec<usize> = tl.events.iter().filter(|e| e.track == "k").map(|e| e.piece).collect();
    assert_eq!(played, [0, 2], "steps 1 and 3");
}
