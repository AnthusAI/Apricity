//! The steering report (sec 3, Kanbus `apricitus-c46688`): wrong notes, fit/unfit regions and
//! suggestions mapped to optimizer ops. A direct port of `harmony2_ref.py`'s matching functions
//! (`wrong_notes_for_span`, `steer_regions`, `steer_suggestions`); see that module's own
//! docstrings for the same caveats (per-stem, not per-note, cents; the `track.hp`/`track.bars`
//! rows of sec 3.4's table are left for the agent/optimizer loop, not auto-suggested here).
//!
//! `apricity-cli`'s `steer` subcommand does the IO (reading `stems.json` and the WAVs, running
//! the CQT/NNLS pipeline per stem) and assembles the final `steer.json` from these functions'
//! output, the same division of labour `check.rs` already has with this crate's `quality`
//! module.

use crate::chord::{notes_from_activation, pc_index};
use crate::cqt::MIDI_C1;
use crate::notes::{semitone_name, N_SEMITONES};
use crate::quality::PITCH_NAMES;
use std::collections::BTreeMap;

pub const REGION_FIT_Q: f64 = 0.6;
pub const REGION_FIT_CLASH: f64 = 0.10;
pub const TUNING_CORRECTION_THRESHOLD_CENTS: f64 = 8.0;
pub const STEER_TRANSPOSE_MARGIN_DQ: f64 = 0.2;

const DEGREE_NAMES: [&str; 12] = ["root", "b2", "2nd", "b3", "3rd", "4th", "b5", "5th", "#5", "6th", "b7", "7th"];

fn hz_for_midi(midi: i32, tune: f64) -> f64 {
    tune * 2f64.powf((midi as f64 - 69.0) / 12.0)
}

#[derive(Debug, Clone)]
pub struct WrongNote {
    pub stem: String,
    pub note: String,
    pub midi: i32,
    pub hz: f64,
    pub cents: f64,
    pub share: f64,
    pub beats: Vec<f64>,
    pub against: String,
    pub reason: String,
}

/// Sec 3.3's `wrong_notes` for one span: per stem, the extracted notes whose pitch class isn't in
/// `target_tones_pc` (the written chord's tones, or the heard chord's under `--against heard`),
/// sorted by share times a root/bass-adjacency weight (a wrong note a semitone from the target
/// root sorts first, matching sec 3.3's "root/bass semitone first"). `cents` is each stem's own
/// tuning offset (sec 2.2), not a per-note fit -- see this module's docstring.
pub fn wrong_notes_for_span(
    stem_span_activation: &BTreeMap<String, Vec<f64>>,
    target_root_pc: Option<usize>,
    target_tones_pc: &std::collections::BTreeSet<usize>,
    target_label: &str,
    stem_cents: &BTreeMap<String, f64>,
    bars: &[f64],
) -> Vec<WrongNote> {
    let mut out: Vec<(f64, WrongNote)> = Vec::new();
    for (stem, activation) in stem_span_activation {
        let total: f64 = activation.iter().sum();
        if total <= 0.0 {
            continue;
        }
        for midi in notes_from_activation(activation, 0.15) {
            let pc = midi.rem_euclid(12) as usize;
            if target_tones_pc.contains(&pc) {
                continue;
            }
            let idx = (midi - MIDI_C1) as usize;
            let share = if idx < activation.len() { activation[idx] / total } else { 0.0 };
            let degree = target_root_pc.map_or("?".to_string(), |r| DEGREE_NAMES[(pc as i32 - r as i32).rem_euclid(12) as usize].to_string());
            let weight = target_root_pc.map_or(1.0, |r| {
                let d = (pc as i32 - r as i32).rem_euclid(12);
                if d == 1 || d == 11 {
                    2.0
                } else {
                    1.0
                }
            });
            let cents = stem_cents.get(stem).copied().unwrap_or(0.0);
            let sort_key = share * weight;
            out.push((
                sort_key,
                WrongNote {
                    stem: stem.clone(),
                    note: semitone_name(midi),
                    midi,
                    hz: (hz_for_midi(midi, 440.0) * 10.0).round() / 10.0,
                    cents: (cents * 10.0).round() / 10.0,
                    share: (share * 1000.0).round() / 1000.0,
                    beats: bars.to_vec(),
                    against: target_label.to_string(),
                    reason: format!("{degree} of {target_label}"),
                },
            ));
        }
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    out.into_iter().map(|(_, w)| w).collect()
}

/// One span's slice of the report `steer_regions`/`steer_suggestions` need: enough to decide
/// `fits` and to build a `track.transpose_span` suggestion.
pub struct RegionSpan {
    pub bars: [f64; 2],
    pub q: f64,
    pub clash: f64,
}

/// Sec 3.3's `regions`: spans with `Q >= REGION_FIT_Q` and `clash <= REGION_FIT_CLASH` are `fit`;
/// contiguous fit (or unfit) spans, in score order, merge into bar ranges.
pub fn steer_regions(spans: &[RegionSpan]) -> (Vec<[f64; 2]>, Vec<[f64; 2]>) {
    let mut fit: Vec<[f64; 2]> = Vec::new();
    let mut unfit: Vec<[f64; 2]> = Vec::new();
    let mut cur: Option<(bool, usize)> = None; // (is_fit, index into the owning Vec)
    for sp in spans {
        let is_fit = sp.q >= REGION_FIT_Q && sp.clash <= REGION_FIT_CLASH;
        let bucket = if is_fit { &mut fit } else { &mut unfit };
        match cur {
            Some((prev_fit, idx)) if prev_fit == is_fit && bucket.get(idx).is_some_and(|r| r[1] == sp.bars[0]) => {
                bucket[idx][1] = sp.bars[1];
            }
            _ => {
                bucket.push(sp.bars);
                cur = Some((is_fit, bucket.len() - 1));
            }
        }
    }
    (fit, unfit)
}

#[derive(Debug, Clone)]
pub struct Suggestion {
    pub op: String,
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// One span's inputs to [`steer_suggestions`]'s `track.transpose_span` row: the label, bars, the
/// per-loop-stem transposition map (sec 3.2, `shift -> score`) and the solver's own shift for
/// this span (from `stems.json`, when the track's transpose was fixed rather than `auto`).
pub struct SuggestSpan<'a> {
    pub label: &'a str,
    pub bars: [f64; 2],
    pub q: f64,
    pub transposition_map: &'a BTreeMap<String, BTreeMap<i32, f64>>,
    pub solver_shift: &'a BTreeMap<String, i32>,
    pub wrong_notes: &'a [WrongNote],
}

/// Sec 3.4's suggestions, ranked by projected gain. Generates `track.transpose_span` (from the
/// transposition map, sec 3.2's margin) and `track.eq_notch` (the loudest wrong note per span);
/// `clip.retune` comes from `stems_out`'s per-stem cents. `track.harmonic` is P2; `track.hp` and
/// `track.bars` need a register/arrangement judgement this analytic pass doesn't make, so they're
/// left for the agent/optimizer loop to propose from `wrong_notes`/`regions` instead.
pub fn steer_suggestions(spans: &[SuggestSpan], pitched_stem_cents: &BTreeMap<String, f64>) -> Vec<Suggestion> {
    let mut out: Vec<(Option<f64>, Suggestion)> = Vec::new();

    for sp in spans {
        // A span whose chord already reads well (`Q >= REGION_FIT_Q`, the same threshold
        // `steer_regions` uses for "fits") isn't worth re-transposing even when the analytic map
        // prefers a different shift by more than the margin: the map's score (`chord_match_score`,
        // sec 3.2) is a cheaper proxy for `Q` and can disagree with it on a span that's already a
        // good, complete chord (voice_leading/spacing/extension credit the proxy doesn't see) --
        // suggesting a change there would fix a problem the span doesn't actually have.
        if sp.q >= REGION_FIT_Q {
            continue;
        }
        for (stem, shifts) in sp.transposition_map {
            if shifts.is_empty() {
                continue;
            }
            let (&best_shift, &best_score) = shifts.iter().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap();
            let baseline_shift = sp.solver_shift.get(stem).copied().unwrap_or(0);
            let baseline_score = shifts.get(&baseline_shift).copied().unwrap_or(best_score);
            if best_shift == baseline_shift {
                continue;
            }
            let d_q = best_score - baseline_score;
            if d_q < STEER_TRANSPOSE_MARGIN_DQ {
                continue;
            }
            let mut fields = serde_json::Map::new();
            fields.insert("track".into(), stem.clone().into());
            fields.insert("bars".into(), serde_json::json!(sp.bars));
            fields.insert("value".into(), best_shift.into());
            fields.insert("expected_dQ".into(), serde_json::json!((d_q * 1000.0).round() / 1000.0));
            fields.insert("expected_dclash".into(), serde_json::Value::Null);
            fields.insert(
                "why".into(),
                format!("the loop's own notes at {best_shift:+} st score {best_score:.2} against {} vs {baseline_score:.2} at the solver's {baseline_shift:+}", sp.label).into(),
            );
            out.push((Some(d_q), Suggestion { op: "track.transpose_span".into(), fields }));
        }
    }

    for sp in spans {
        if let Some(top) = sp.wrong_notes.first() {
            let mut fields = serde_json::Map::new();
            fields.insert("track".into(), top.stem.clone().into());
            fields.insert("hz".into(), top.hz.into());
            fields.insert("gain".into(), (-9).into());
            fields.insert("q".into(), 12.into());
            fields.insert("bars".into(), serde_json::json!(sp.bars));
            fields.insert("why".into(), format!("{} is the loudest non-chord note under {}", top.note, sp.label).into());
            out.push((None, Suggestion { op: "track.eq_notch".into(), fields }));
        }
    }

    for (stem, &cents) in pitched_stem_cents {
        if cents.abs() > TUNING_CORRECTION_THRESHOLD_CENTS {
            let mut fields = serde_json::Map::new();
            fields.insert("clip".into(), stem.clone().into());
            fields.insert("cents".into(), serde_json::json!((-cents * 10.0).round() / 10.0));
            fields.insert("why".into(), format!("pinned root reads {cents:+.0} c {}", if cents > 0.0 { "sharp" } else { "flat" }).into());
            out.push((None, Suggestion { op: "clip.retune".into(), fields }));
        }
    }

    out.sort_by(|a, b| b.0.unwrap_or(0.05).partial_cmp(&a.0.unwrap_or(0.05)).unwrap());
    out.into_iter().map(|(_, s)| s).collect()
}

/// A pitch-class name (flats, matching [`PITCH_NAMES`]) back to its 0..11 index, tried before the
/// sharp-spelled fallback (matches `quality::pitch_name_to_pc` plus `chord::pc_index`).
pub fn pitch_name_pc(name: &str) -> Option<usize> {
    PITCH_NAMES.iter().position(|&n| n == name).or_else(|| pc_index(name))
}

/// Sanity: the degree-name table has one entry per semitone.
const _: () = assert!(DEGREE_NAMES.len() == 12);
const _: () = assert!(N_SEMITONES == 84);

// --------------------------------------------------------------------------- report_json: shared by the CLI and wasm

use crate::cqt::cqt;
use crate::notes::{beat_aggregate, build_templates, fold_to_semitones, frame_times, nnls_activations, QUALITIES};
use crate::pitch::cents_offset_from_cqt;
use crate::quality::{objective_v2_for_span, window_objective, written_quality_from_tones};
use std::collections::BTreeSet;

/// The full `apricity.steer/1` report (sec 3.1) for a stems window, given `manifest` (the
/// `stems.json` shape: `tempo`, `meter`, `key`, `offset_beats`, `length`, `harmony[]`,
/// `tracks[]`, `events[]`) and each pitched, non-kit stem's mono samples at [`crate::SR`]
/// (resampling to that rate is the caller's job -- `apricity-cli`'s `steer` subcommand reads and
/// resamples WAV files; `apricity-web`'s `rw_steer_add_stem` resamples whatever the browser
/// decoded). `against` is `"written"` or `"heard"`. `solver_shift` is each loop stem's harmony-
/// solver shift per span (`(track, start_beat)` -> semitones), when the caller has it (the CLI's
/// `--score`); pass an empty map when it isn't available, as `apricity-web`'s export does --
/// `track.transpose_span` suggestions then compare against a 0-semitone baseline instead (see
/// `steer_suggestions`'s own doc comment on why that can rank suggestions differently).
pub fn report_json(manifest: &serde_json::Value, stem_samples: &BTreeMap<String, Vec<f64>>, against: &str, solver_shift_lookup: &BTreeMap<(String, i64), i32>) -> Result<serde_json::Value, String> {
    let tempo = manifest["tempo"].as_f64().ok_or("stems.json: missing tempo")?;
    let meter = manifest["meter"].as_u64().unwrap_or(4) as f64;
    let key = manifest["key"].as_str().map(str::to_string);
    let offset_beats = manifest["offset_beats"].as_f64().unwrap_or(0.0);

    struct Track {
        name: String,
        pitched: bool,
        kit: Option<String>,
        pitch: Option<String>,
    }
    let tracks: Vec<Track> = manifest["tracks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|t| Track {
            name: t["name"].as_str().unwrap_or_default().to_string(),
            pitched: t["pitched"].as_bool().unwrap_or(true),
            kit: t["kit"].as_str().map(|s| s.to_string()),
            pitch: t["pitch"].as_str().map(|s| s.to_string()),
        })
        .collect();

    let templates = build_templates();
    let mut n_beats = 1usize;
    for span in manifest["harmony"].as_array().cloned().unwrap_or_default() {
        let end = span["end_beat"].as_f64().unwrap_or(0.0) - offset_beats;
        n_beats = n_beats.max(end.ceil().max(1.0) as usize);
    }

    let mut stem_beat_activation: BTreeMap<String, Vec<Vec<f64>>> = BTreeMap::new();
    let mut stem_cents: BTreeMap<String, f64> = BTreeMap::new();
    for t in &tracks {
        if t.kit.is_some() || !t.pitched {
            continue;
        }
        let Some(mono) = stem_samples.get(&t.name) else { continue };
        let (c, _n_fft) = cqt(mono, 0.0);
        stem_cents.insert(t.name.clone(), cents_offset_from_cqt(&c));
        let folded = fold_to_semitones(&c);
        let activations = nnls_activations(&folded, &templates);
        let n_frames = activations.first().map_or(0, |r| r.len());
        let times = frame_times(n_frames, crate::cqt::HOP, crate::SR);
        let beats = beat_aggregate(&activations, &times, tempo, 0.0, n_beats);
        stem_beat_activation.insert(t.name.clone(), beats);
    }

    let pitched_pitch: BTreeMap<&str, &str> = tracks.iter().filter_map(|t| t.pitch.as_deref().map(|p| (t.name.as_str(), p))).collect();
    let loop_names: Vec<&str> = stem_beat_activation.keys().map(String::as_str).filter(|n| !pitched_pitch.contains_key(n)).collect();

    let mut events_by_track: BTreeMap<String, Vec<(f64, f64, i64)>> = BTreeMap::new();
    if let Some(events) = manifest["events"].as_array() {
        for e in events {
            let track = e["track"].as_str().unwrap_or_default().to_string();
            let start = e["start_beat"].as_f64().unwrap_or(0.0);
            let end = e["end_beat"].as_f64().unwrap_or(0.0);
            let midi = e["midi"].as_i64().unwrap_or(0);
            events_by_track.entry(track).or_default().push((start, end, midi));
        }
    }

    let mut span_reports: Vec<serde_json::Value> = Vec::new();
    let mut region_spans: Vec<RegionSpan> = Vec::new();
    let mut all_guard_violations: Vec<String> = Vec::new();
    let mut span_mass = Vec::new();
    let mut span_results_for_window = Vec::new();
    let mut prev_notes: Option<Vec<i32>> = None;
    #[allow(clippy::type_complexity)]
    let mut suggest_spans_owned: Vec<(String, [f64; 2], f64, BTreeMap<String, BTreeMap<i32, f64>>, BTreeMap<String, i32>, Vec<WrongNote>)> = Vec::new();

    for span in manifest["harmony"].as_array().cloned().unwrap_or_default() {
        let start_beat = span["start_beat"].as_f64().unwrap_or(0.0);
        let end_beat = span["end_beat"].as_f64().unwrap_or(0.0);
        let a = ((start_beat - offset_beats).round() as i64).max(0) as usize;
        let b = (((end_beat - offset_beats).round() as i64).max(0) as usize).min(n_beats);
        if b <= a {
            continue;
        }
        let bars = [start_beat / meter + 1.0, end_beat / meter + 1.0];
        let label = span["label"].as_str().unwrap_or_default().to_string();

        let chord_tones_ordered: Vec<usize> = span["chord_tones"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str()).filter_map(pitch_name_pc).collect();
        let chord_tones_pc: BTreeSet<usize> = chord_tones_ordered.iter().copied().collect();
        let written_root_pc = chord_tones_ordered.first().copied();
        let written_quality = written_root_pc.and_then(|r| written_quality_from_tones(r, &chord_tones_ordered));
        let written_bass_pc = span["bass"].as_str().and_then(pitch_name_pc);
        let written_chord_label = format!("written {label}");

        let stem_span_beats: std::collections::HashMap<String, Vec<Vec<f64>>> = stem_beat_activation.iter().map(|(name, beats)| (name.clone(), beats[a..b].to_vec())).collect();
        let stem_activations: BTreeMap<String, Vec<f64>> = stem_beat_activation
            .iter()
            .map(|(name, beats)| {
                let mut sum = vec![0.0f64; N_SEMITONES];
                for beat in &beats[a..b] {
                    for (i, &x) in beat.iter().enumerate() {
                        sum[i] += x;
                    }
                }
                (name.clone(), sum)
            })
            .collect();

        let bass_stem_name = events_by_track.keys().find(|name| stem_activations.contains_key(*name)).cloned();
        let stem_activations_hashmap: std::collections::HashMap<String, Vec<f64>> = stem_activations.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

        let result = objective_v2_for_span(
            &stem_activations_hashmap,
            &stem_span_beats,
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
        for a_vec in stem_activations.values() {
            notes_now.extend(notes_from_activation(a_vec, 0.15));
        }
        if !notes_now.is_empty() {
            prev_notes = Some(notes_now);
        }

        let (target_root_pc, target_tones_pc, target_label) = if against == "heard" {
            if let Some(h) = &result.heard {
                let root_pc = pitch_name_pc(h.root);
                let intervals = QUALITIES.iter().find(|&&(q, _)| q == h.quality).map(|&(_, iv)| iv).unwrap_or(&[0, 4, 7]);
                let tones: BTreeSet<usize> = root_pc.map(|r| intervals.iter().map(|iv| ((r as i32 + iv).rem_euclid(12)) as usize).collect()).unwrap_or_default();
                (root_pc, tones, format!("heard {}{}", h.root, h.quality))
            } else {
                (written_root_pc, chord_tones_pc.clone(), written_chord_label.clone())
            }
        } else {
            (written_root_pc, chord_tones_pc.clone(), written_chord_label.clone())
        };

        let loop_span_activation: BTreeMap<String, Vec<f64>> = stem_activations.iter().filter(|(name, _)| !pitched_pitch.contains_key(name.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        let wrong_notes = wrong_notes_for_span(&loop_span_activation, target_root_pc, &target_tones_pc, &target_label, &stem_cents, &bars);

        let mut tmap: BTreeMap<String, BTreeMap<i32, f64>> = BTreeMap::new();
        for &stem in &loop_names {
            let Some(span_act) = stem_activations.get(stem) else { continue };
            if span_act.iter().sum::<f64>() <= 0.0 {
                continue;
            }
            let mut other = vec![0.0f64; N_SEMITONES];
            for (name, a) in &stem_activations {
                if name != stem {
                    for (i, &x) in a.iter().enumerate() {
                        other[i] += x;
                    }
                }
            }
            let rolled = crate::notes::transposition_map(span_act, &other, written_root_pc.unwrap_or(0), written_quality.unwrap_or(""), None);
            tmap.insert(stem.to_string(), rolled.into_iter().map(|(k, v)| (k, (v * 1000.0).round() / 1000.0)).collect());
        }

        let clash = ((1.0 - result.consonance_v1 / 100.0) * 10000.0).round() / 10000.0;
        let fits = result.q.q >= REGION_FIT_Q && clash <= REGION_FIT_CLASH;

        region_spans.push(RegionSpan { bars, q: result.q.q, clash });
        all_guard_violations.extend(result.guard_violations.clone());

        span_reports.push(serde_json::json!({
            "label": label,
            "bars": bars,
            "written": {
                "chord": span["chord"].clone(),
                "tones": chord_tones_ordered.iter().map(|&pc| PITCH_NAMES[pc]).collect::<Vec<_>>(),
                "bass": span["bass"].clone(),
            },
            "heard": result.heard.as_ref().map(|h| serde_json::json!({
                "root": h.root, "quality": h.quality, "extensions": h.extensions,
                "bass": h.bass, "inversion": h.inversion, "confidence": h.confidence,
            })),
            "Q": {"target": result.q.target, "extension": result.q.extension, "spacing": result.q.spacing, "voice_leading": result.q.voice_leading, "Q": result.q.q},
            "clash": clash,
            "wrong_notes": wrong_notes.iter().map(|w| serde_json::json!({
                "stem": w.stem, "note": w.note, "midi": w.midi, "hz": w.hz, "cents": w.cents,
                "share": w.share, "beats": w.beats, "against": w.against, "reason": w.reason,
            })).collect::<Vec<_>>(),
            "transposition_map": tmap,
            "fits": fits,
        }));

        let mut solver_shift: BTreeMap<String, i32> = BTreeMap::new();
        for &stem in &loop_names {
            if let Some(&shift) = solver_shift_lookup.get(&(stem.to_string(), start_beat as i64)) {
                solver_shift.insert(stem.to_string(), shift);
            }
        }
        suggest_spans_owned.push((label, bars, result.q.q, tmap, solver_shift, wrong_notes));
        span_mass.push(result.mass);
        span_results_for_window.push(result);
    }

    let window = window_objective(&span_results_for_window, &span_mass);

    let mut stems_out = serde_json::Map::new();
    let mut pitched_stem_cents: BTreeMap<String, f64> = BTreeMap::new();
    for t in &tracks {
        if t.kit.is_some() || !t.pitched {
            continue;
        }
        let cents = stem_cents.get(&t.name).copied().unwrap_or(0.0);
        if let Some(pitch) = &t.pitch {
            pitched_stem_cents.insert(t.name.clone(), cents);
            stems_out.insert(t.name.clone(), serde_json::json!({"kind": "pitched", "pitch": pitch, "cents": (cents * 10.0).round() / 10.0}));
        } else if stem_beat_activation.contains_key(&t.name) {
            stems_out.insert(t.name.clone(), serde_json::json!({"kind": "loop", "cents": (cents * 10.0).round() / 10.0, "cents_spread": 0.0}));
        }
    }

    let suggest_spans: Vec<SuggestSpan> = suggest_spans_owned
        .iter()
        .map(|(label, bars, q, tmap, solver_shift, wrong_notes)| SuggestSpan { label, bars: *bars, q: *q, transposition_map: tmap, solver_shift, wrong_notes })
        .collect();
    let suggestions = steer_suggestions(&suggest_spans, &pitched_stem_cents);
    let suggestions_json: Vec<serde_json::Value> = suggestions
        .into_iter()
        .map(|s| {
            let mut m = serde_json::Map::new();
            m.insert("op".to_string(), serde_json::Value::String(s.op));
            for (k, v) in s.fields {
                m.insert(k, v);
            }
            serde_json::Value::Object(m)
        })
        .collect();

    let (fit, unfit) = steer_regions(&region_spans);

    Ok(serde_json::json!({
        "schema": "apricity.steer/1",
        "render": {"bars": [region_spans.first().map_or(0.0, |s| s.bars[0]), region_spans.last().map_or(0.0, |s| s.bars[1])], "tempo": tempo, "meter": meter as u64, "key": key},
        "objective": {"v1": window.objective_v1, "v2": window.objective_v2, "consonance": window.consonance_v1, "guards": all_guard_violations, "Q_mean": window.q_mean},
        "stems": stems_out,
        "spans": span_reports,
        "regions": {"fit": fit, "unfit": unfit},
        "suggestions": suggestions_json,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_merges_contiguous_fit_spans_and_keeps_unfit_ones_separate() {
        let spans = [
            RegionSpan { bars: [1.0, 2.0], q: 0.9, clash: 0.02 },
            RegionSpan { bars: [2.0, 3.0], q: 0.8, clash: 0.05 },
            RegionSpan { bars: [3.0, 4.0], q: 0.2, clash: 0.30 }, // unfit: breaks the run
            RegionSpan { bars: [4.0, 5.0], q: 0.9, clash: 0.01 }, // fit again, but not adjacent to the first run
        ];
        let (fit, unfit) = steer_regions(&spans);
        assert_eq!(fit, vec![[1.0, 3.0], [4.0, 5.0]]);
        assert_eq!(unfit, vec![[3.0, 4.0]]);
    }

    #[test]
    fn regions_empty_when_no_spans() {
        let (fit, unfit) = steer_regions(&[]);
        assert!(fit.is_empty() && unfit.is_empty());
    }

    #[test]
    fn wrong_notes_skips_chord_tones_and_sorts_root_adjacent_ones_first() {
        // Two stems, each sounding exactly one off-chord note (so both have share 1.0 of their
        // own total mass, isolating the root-adjacency weight sec 3.3 asks for): "pad" sounds a
        // semitone above the root (C#, root-adjacent); "lead" sounds a whole tone above it (D,
        // not root-adjacent). Equal share, so the weight alone must put C# first.
        let mut pad = vec![0.0f64; N_SEMITONES];
        pad[(61 - MIDI_C1) as usize] = 0.3; // C#5: root-adjacent wrong note
        let mut lead = vec![0.0f64; N_SEMITONES];
        lead[(62 - MIDI_C1) as usize] = 0.3; // D5: not root-adjacent, same mass
        let stems: BTreeMap<String, Vec<f64>> = [("pad".to_string(), pad), ("lead".to_string(), lead)].into_iter().collect();
        let target_tones: std::collections::BTreeSet<usize> = [0usize, 4, 7].into_iter().collect(); // C major triad
        let cents: BTreeMap<String, f64> = BTreeMap::new();
        let notes = wrong_notes_for_span(&stems, Some(0), &target_tones, "written C", &cents, &[1.0, 2.0]);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].stem, "pad");
        assert_eq!(notes[0].note, "C#4");
        assert_eq!(notes[0].reason, "b2 of written C");
        assert_eq!(notes[1].stem, "lead");
    }

    #[test]
    fn suggestions_skip_a_span_that_already_fits_even_with_a_big_map_delta() {
        let tmap: BTreeMap<String, BTreeMap<i32, f64>> = [("bright".to_string(), [(0, -0.2), (3, 0.9)].into_iter().collect())].into_iter().collect();
        let solver_shift: BTreeMap<String, i32> = [("bright".to_string(), 0)].into_iter().collect();
        let wrong_notes: Vec<WrongNote> = Vec::new();
        let fitting = SuggestSpan { label: "I", bars: [1.0, 2.0], q: 0.95, transposition_map: &tmap, solver_shift: &solver_shift, wrong_notes: &wrong_notes };
        let unfit = SuggestSpan { label: "V", bars: [3.0, 4.0], q: 0.3, transposition_map: &tmap, solver_shift: &solver_shift, wrong_notes: &wrong_notes };
        let cents = BTreeMap::new();

        let only_fitting = steer_suggestions(&[fitting], &cents);
        assert!(only_fitting.iter().all(|s| s.op != "track.transpose_span"), "a well-fit span shouldn't get a transpose suggestion: {only_fitting:?}");

        let with_unfit = steer_suggestions(&[unfit], &cents);
        assert!(with_unfit.iter().any(|s| s.op == "track.transpose_span"), "an unfit span with a >= margin delta should: {with_unfit:?}");
    }

    #[test]
    fn suggestions_generate_a_retune_only_past_the_cents_threshold() {
        let cents: BTreeMap<String, f64> = [("low".to_string(), 9.4), ("bass2".to_string(), 2.0)].into_iter().collect();
        let out = steer_suggestions(&[], &cents);
        let retunes: Vec<&str> = out.iter().filter(|s| s.op == "clip.retune").map(|s| s.fields["clip"].as_str().unwrap()).collect();
        assert_eq!(retunes, vec!["low"]);
    }
}
