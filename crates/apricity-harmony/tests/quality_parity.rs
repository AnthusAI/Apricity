//! Parity for chord recognition, `Q`, `objective_v2` and the guards (Kanbus `apricitus-d401a2`,
//! Task 5 of Harmony v2 Phase 1) against the Python reference's committed activation-summary
//! fixtures (`analysis/tests/fixtures/harmony2/{lounge,cycle2}_summaries.json`; numbers only, no
//! audio). Each fixture holds, per span, the real per-beat NNLS activations from one render and
//! the Python reference's own computed result (`heard`/`consonance_v1`/`Q`/`objective_v2`); this
//! file replays them through this crate and checks parity, and separately reproduces the two
//! rankings the design's acceptance criteria call for -- entirely from the committed numbers, no
//! rendering needed here.

use apricity_harmony::notes::N_SEMITONES;
use apricity_harmony::{objective_v2_for_span, window_objective, PITCH_NAMES, SpanResult};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../analysis/tests/fixtures/harmony2")
}

fn load(name: &str) -> Value {
    let path = fixtures_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn pc(name: &str) -> Option<usize> {
    PITCH_NAMES.iter().position(|&n| n == name)
}

/// Replays every span of every song in a fixture through `objective_v2_for_span`, returning
/// `(song_name, span_index, label, rust_result, python_result_json)`.
fn replay(fixture: &Value) -> Vec<(String, usize, String, SpanResult, Value)> {
    let mut out = Vec::new();
    for (song_name, song) in fixture.as_object().unwrap() {
        let spans = song["spans"].as_array().unwrap();
        let mut prev_notes: Option<Vec<i32>> = None;
        for (i, span) in spans.iter().enumerate() {
            let chord_tones_ordered: Vec<usize> = span["chord_tones"].as_array().unwrap().iter().filter_map(|v| v.as_str()).filter_map(pc).collect();
            let chord_tones_pc: BTreeSet<usize> = chord_tones_ordered.iter().copied().collect();
            let written_root_pc = chord_tones_ordered.first().copied();
            let written_quality = written_root_pc.and_then(|r| apricity_harmony::written_quality_from_tones(r, &chord_tones_ordered));
            let written_bass_pc = span["bass"].as_str().and_then(pc);
            let bass_stem_name = span["bass_stem_name"].as_str().map(|s| s.to_string());

            let activations_by_beat = span["activations_by_beat"].as_object().unwrap();
            let stem_beat_activations: HashMap<String, Vec<Vec<f64>>> = activations_by_beat
                .iter()
                .map(|(name, beats)| {
                    let beats: Vec<Vec<f64>> = beats.as_array().unwrap().iter().map(|beat| beat.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()).collect();
                    (name.clone(), beats)
                })
                .collect();
            let stem_activations: HashMap<String, Vec<f64>> = stem_beat_activations
                .iter()
                .map(|(name, beats)| {
                    let mut sum = vec![0.0f64; N_SEMITONES];
                    for beat in beats {
                        for (i, &x) in beat.iter().enumerate() {
                            sum[i] += x;
                        }
                    }
                    (name.clone(), sum)
                })
                .collect();

            let result = objective_v2_for_span(
                &stem_activations,
                &stem_beat_activations,
                &chord_tones_pc,
                written_root_pc,
                written_quality,
                written_bass_pc,
                bass_stem_name.as_deref(),
                prev_notes.as_deref(),
                None,
                None,
            );
            let mut notes_now: Vec<i32> = Vec::new();
            for a in stem_activations.values() {
                notes_now.extend(apricity_harmony::notes_from_activation(a, 0.15));
            }
            if !notes_now.is_empty() {
                prev_notes = Some(notes_now);
            }
            let label = span["label"].as_str().unwrap_or_default().to_string();
            out.push((song_name.clone(), i, label, result, span["python_result"].clone()));
        }
    }
    out
}

fn window_objective_v2(fixture: &Value, song_name: &str) -> f64 {
    let replayed = replay(fixture);
    let song_spans: Vec<&(String, usize, String, SpanResult, Value)> = replayed.iter().filter(|(s, ..)| s == song_name).collect();
    let results: Vec<SpanResult> = song_spans.iter().map(|(_, _, _, r, _)| r.clone()).collect();
    let mass: Vec<f64> = song_spans.iter().map(|(_, _, _, r, _)| r.mass).collect();
    window_objective(&results, &mass).objective_v2
}

#[test]
fn chord_recognition_matches_the_reference_on_every_lounge_and_cycle2_span() {
    for fname in ["lounge_summaries.json", "cycle2_summaries.json"] {
        let fixture = load(fname);
        for (song, i, label, result, python) in replay(&fixture) {
            let py_heard = &python["heard"];
            match (&result.heard, py_heard.is_null()) {
                (None, true) => {}
                (Some(h), false) => {
                    assert_eq!(h.root, py_heard["root"].as_str().unwrap(), "{fname} {song} span {i} ({label}): root mismatch");
                    assert_eq!(h.quality, py_heard["quality"].as_str().unwrap(), "{fname} {song} span {i} ({label}): quality mismatch");
                    assert_eq!(h.bass, py_heard["bass"].as_str().unwrap(), "{fname} {song} span {i} ({label}): bass mismatch");
                    assert_eq!(h.inversion, py_heard["inversion"].as_str().unwrap(), "{fname} {song} span {i} ({label}): inversion mismatch");
                    let py_ext: Vec<String> = py_heard["extensions"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
                    let rust_ext: Vec<String> = h.extensions.iter().map(|s| s.to_string()).collect();
                    assert_eq!(rust_ext, py_ext, "{fname} {song} span {i} ({label}): extensions mismatch");
                }
                (rust, py_null) => panic!("{fname} {song} span {i} ({label}): heard-presence mismatch (rust None={}, python null={py_null})", rust.is_none()),
            }
        }
    }
}

#[test]
fn q_matches_the_reference_within_1e_minus_3_on_every_lounge_and_cycle2_span() {
    for fname in ["lounge_summaries.json", "cycle2_summaries.json"] {
        let fixture = load(fname);
        let mut worst = 0.0f64;
        for (song, i, label, result, python) in replay(&fixture) {
            let want = python["Q"]["Q"].as_f64().unwrap();
            let got = result.q.q;
            let d = (got - want).abs();
            worst = worst.max(d);
            assert!(d <= 1e-3, "{fname} {song} span {i} ({label}): Q {got:.4} vs reference {want:.4} (diff {d:.4})");
        }
        eprintln!("{fname}: worst Q deviation = {worst:e}");
    }
}

#[test]
fn objective_v2_matches_the_reference_within_0_01_on_every_lounge_and_cycle2_span() {
    for fname in ["lounge_summaries.json", "cycle2_summaries.json"] {
        let fixture = load(fname);
        let mut worst = 0.0f64;
        for (song, i, label, result, python) in replay(&fixture) {
            let want = python["objective_v2"].as_f64().unwrap();
            let got = result.objective_v2;
            let d = (got - want).abs();
            worst = worst.max(d);
            assert!(d <= 0.01, "{fname} {song} span {i} ({label}): objective_v2 {got:.4} vs reference {want:.4} (diff {d:.4})");
        }
        eprintln!("{fname}: worst objective_v2 deviation = {worst:e}");
    }
}

#[test]
fn lounge_ranking_reproduces_emerge_first_with_q_weight_10() {
    let fixture = load("lounge_summaries.json");
    let names = ["1-absolutely-clear", "2-come-up-for-air", "3-emerge", "4-stay-for-this-moment"];
    let mut scores: Vec<(&str, f64)> = names.iter().map(|&n| (n, window_objective_v2(&fixture, n))).collect();
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    assert_eq!(scores[0].0, "3-emerge", "expected Emerge to rank first, got {scores:?}");
}

#[test]
fn cycle2_ranking_reproduces_the_incumbent_keep_first_with_q_weight_10() {
    let fixture = load("cycle2_summaries.json");
    let names = ["aveloop2", "comeup", "csoul", "keep"];
    let mut scores: Vec<(&str, f64)> = names.iter().map(|&n| (n, window_objective_v2(&fixture, n))).collect();
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    assert_eq!(scores[0].0, "keep", "expected 'keep' to rank first, got {scores:?}");
}
