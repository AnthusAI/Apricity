//! Integration tests for domain operations: judge, markup merge, save_score.
//! Tests build full state through Library/facades and verify domain operation results.

use apricity_data::{apply_markup_merge, judge, save_score_impl, JudgeInput};
use apricity_data::markup::ProposedClip;
use serde_json::json;
use tempfile::TempDir;
use virtuus_amplify::Identity as VirtuusIdentity;

// Helper to create and open a library with test data
fn setup_library() -> (TempDir, apricity_data::Library) {
    let temp_dir = TempDir::new().unwrap();
    let lib = apricity_data::Library::create(temp_dir.path()).unwrap();
    (temp_dir, lib)
}

// Helper to create a recording
fn create_recording(lib: &mut apricity_data::Library, id: &str, title: &str, collection: &str) {
    let recording = json!({
        "id": id,
        "title": title,
        "collection": collection
    });
    if let Some(table) = lib.engine_mut().table_mut("Recording") {
        table.put(recording);
    }
}

// Helper to create a sample
fn create_sample(
    lib: &mut apricity_data::Library,
    id: &str,
    recording_id: &str,
    path: &str,
    collection: &str,
    title: &str,
) {
    create_sample_with_counters(lib, id, recording_id, path, collection, title, json!({}));
}

// Helper to create a sample with initial nameCounters
fn create_sample_with_counters(
    lib: &mut apricity_data::Library,
    id: &str,
    recording_id: &str,
    path: &str,
    collection: &str,
    title: &str,
    counters: serde_json::Value,
) {
    let sample = json!({
        "id": id,
        "recordingId": recording_id,
        "path": path,
        "collection": collection,
        "title": title,
        "audio": {"key": format!("audio/{}/test.wav", id), "sha256": "aa"},
        "nameCounters": counters
    });
    if let Some(table) = lib.engine_mut().table_mut("Sample") {
        table.put(sample);
    }
}

// Helper to create a candidate
fn create_candidate(
    lib: &mut apricity_data::Library,
    id: &str,
    sample_id: &str,
    recording_id: &str,
    start: f64,
    end: f64,
    kind: &str,
) {
    let candidate = json!({
        "id": id,
        "sampleId": sample_id,
        "recordingId": recording_id,
        "start": start,
        "end": end,
        "kind": kind,
        "proposers": [
            {"by": "analyzer:markup/loops", "score": 0.9, "why": "loops cleanly", "at": "2026-09-24T00:00:00.000Z"}
        ],
        "baseScore": 0.9
    });
    if let Some(table) = lib.engine_mut().table_mut("Candidate") {
        table.put(candidate);
    }
}

// Helper to create a clip
fn create_clip(
    lib: &mut apricity_data::Library,
    id: &str,
    sample_id: &str,
    name: &str,
    start: f64,
    end: f64,
    source: &str,
    kind: Option<&str>,
) {
    let mut clip_json = json!({
        "id": id,
        "sampleId": sample_id,
        "name": name,
        "start": start,
        "end": end,
        "source": source
    });
    if let Some(k) = kind {
        clip_json["kind"] = json!(k);
    }
    if let Some(table) = lib.engine_mut().table_mut("Clip") {
        table.put(clip_json);
    }
}

// Helper to get identity for operations
fn local_identity() -> VirtuusIdentity {
    VirtuusIdentity::User {
        sub: "alice".to_string(),
        username: "alice".to_string(),
        groups: vec!["members".to_string(), "curators".to_string()],
    }
}

#[test]
fn test_keep_candidate_creates_verdict_clip_crate_item() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    // Setup: Recording and Sample
    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "smp-1", "rec-1", 10.0, 14.0, "loop");

    // Action: keep candidate
    let input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "keep".to_string(),
        stars: Some(4),
        tags: None, // tags must be an array in the model
        name: Some("horn-loop".to_string()),
        crates: Some(vec!["digs".to_string()]),
    };

    let result = judge(lib.engine_mut(), &input, &identity).unwrap();
    assert_eq!(result["candidateId"], "cand-1");
    assert_eq!(result["verdict"], "keep");

    // Verify: Curated Clip exists
    let clip_id = apricity_data::curated_clip_id("cand-1");
    let clip_args = json!({ "id": clip_id });
    let (clip_data, _) = lib
        .engine_mut()
        .call("Clip", "get", &clip_args, &identity)
        .unwrap();
    assert!(!clip_data.is_null());
    assert_eq!(clip_data["candidateId"], "cand-1");
    assert_eq!(clip_data["source"], "curated");
    assert_eq!(clip_data["start"], 10.0);
    assert_eq!(clip_data["end"], 14.0);

    // Verify: Crate item exists
    let items_args = json!({ "key": { "candidateId": "cand-1" } });
    let (items_data, _) = lib
        .engine_mut()
        .call("CrateItem", "crateItemsByCandidate", &items_args, &identity)
        .unwrap();
    let items = items_data.get("items").unwrap().as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["candidateId"], "cand-1");
}

#[test]
fn test_keep_candidate_idempotent() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "smp-1", "rec-1", 10.0, 14.0, "loop");

    let input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "keep".to_string(),
        stars: Some(4),
        tags: None,
        name: None,
        crates: Some(vec!["digs".to_string()]),
    };

    // Keep first time
    let _ = judge(lib.engine_mut(), &input, &identity).unwrap();

    // Keep second time (idempotent - should not error)
    let _ = judge(lib.engine_mut(), &input, &identity).unwrap();

    // Verify: Still only 1 curated clip
    let clips_args = json!({ "key": { "sampleId": "smp-1" } });
    let (clips_data, _) = lib
        .engine_mut()
        .call("Clip", "clipsBySample", &clips_args, &identity)
        .unwrap();
    let clips = clips_data.get("items").unwrap().as_array().unwrap();
    let curated_clips: Vec<_> = clips
        .iter()
        .filter(|s| s.get("candidateId").unwrap_or(&json!(null)) == "cand-1")
        .collect();
    assert_eq!(curated_clips.len(), 1);
}

#[test]
fn test_skip_candidate_removes_clip_when_alone() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "smp-1", "rec-1", 10.0, 14.0, "loop");

    // Keep first
    let keep_input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "keep".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: Some(vec!["digs".to_string()]),
    };
    let _ = judge(lib.engine_mut(), &keep_input, &identity).unwrap();

    // Then skip
    let skip_input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "skip".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: None,
    };
    let _ = judge(lib.engine_mut(), &skip_input, &identity).unwrap();

    // Verify: No curated clip (should be deleted since no other keeps)
    let clips_args = json!({ "key": { "sampleId": "smp-1" } });
    let (clips_data, _) = lib
        .engine_mut()
        .call("Clip", "clipsBySample", &clips_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_clips = Vec::new();
    let clips = clips_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_clips);
    let curated_clips: Vec<_> = clips
        .iter()
        .filter(|s| s.get("source").unwrap_or(&json!(null)) == "curated")
        .collect();
    assert_eq!(curated_clips.len(), 0);
}

#[test]
fn test_later_verdict_creates_no_clip() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "smp-1", "rec-1", 10.0, 14.0, "loop");

    let input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "later".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: None,
    };

    let _ = judge(lib.engine_mut(), &input, &identity).unwrap();

    // Verify: No clip created (later verdict doesn't create clips)
    let clips_args = json!({ "key": { "sampleId": "smp-1" } });
    let (clips_data, _) = lib
        .engine_mut()
        .call("Clip", "clipsBySample", &clips_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_clips = Vec::new();
    let clips = clips_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_clips);
    assert_eq!(clips.len(), 0);
}

#[test]
fn test_keep_unknown_candidate_fails() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    let input = JudgeInput {
        candidate_id: "no-such-candidate".to_string(),
        verdict: "keep".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: None,
    };

    let result = judge(lib.engine_mut(), &input, &identity);
    assert!(result.is_err());
    assert!(result.unwrap_err().message.contains("not found"));
}

#[test]
fn test_markup_merge_overlapping_keeps_id() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_clip(&mut lib, "clp-a", "smp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Propose overlapping clip (IoU > 0.8)
    let proposed = vec![ProposedClip {
        kind: "loop".to_string(),
        start: 10.1,
        end: 14.0,
        rank: Some(1),
    }];

    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed, &identity).unwrap();

    // Verify: Clip still has same id
    let clip_args = json!({ "id": "clp-a" });
    let (clip_data, _) = lib
        .engine_mut()
        .call("Clip", "get", &clip_args, &identity)
        .unwrap();
    assert!(!clip_data.is_null());
    assert_eq!(clip_data["id"], "clp-a");
    assert_eq!(clip_data["name"], "loop-1");
    assert_eq!(clip_data["start"], 10.1); // Updated
    assert_eq!(clip_data["end"], 14.0);
}

#[test]
fn test_markup_merge_new_proposal_creates_name() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample_with_counters(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
        json!({"loop": 1}),
    );
    create_clip(&mut lib, "clp-a", "smp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Propose overlapping + new
    let proposed = vec![
        ProposedClip {
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            rank: Some(2),
        },
        ProposedClip {
            kind: "loop".to_string(),
            start: 30.0,
            end: 34.0,
            rank: Some(1),
        },
    ];

    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed, &identity).unwrap();

    // Verify: New clip has name "loop-2"
    let clips_args = json!({ "key": { "sampleId": "smp-1" } });
    let (clips_data, _) = lib
        .engine_mut()
        .call("Clip", "clipsBySample", &clips_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_clips = Vec::new();
    let clips = clips_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_clips);
    let loop_2 = clips
        .iter()
        .find(|s| s.get("name").unwrap_or(&json!(null)) == "loop-2");
    assert!(loop_2.is_some(), "Should find loop-2 clip");
    let loop_2 = loop_2.unwrap();
    assert_eq!(loop_2["start"], 30.0);
    assert_eq!(loop_2["end"], 34.0);
}

#[test]
fn test_markup_merge_names_never_reused() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample_with_counters(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
        json!({"loop": 1}),
    );
    create_clip(&mut lib, "clp-a", "smp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // First merge: add loop-2 at 30-34
    let proposed1 = vec![
        ProposedClip {
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            rank: None,
        },
        ProposedClip {
            kind: "loop".to_string(),
            start: 30.0,
            end: 34.0,
            rank: None,
        },
    ];
    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed1, &identity).unwrap();

    // Second merge: add another (should be loop-3, never reuse loop-2)
    let proposed2 = vec![
        ProposedClip {
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            rank: None,
        },
        ProposedClip {
            kind: "loop".to_string(),
            start: 30.0,
            end: 34.0,
            rank: None,
        },
        ProposedClip {
            kind: "loop".to_string(),
            start: 50.0,
            end: 54.0,
            rank: None,
        },
    ];
    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed2, &identity).unwrap();

    // Verify: New clip has name "loop-3" (not reused)
    let clips_args = json!({ "key": { "sampleId": "smp-1" } });
    let (clips_data, _) = lib
        .engine_mut()
        .call("Clip", "clipsBySample", &clips_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_clips = Vec::new();
    let clips = clips_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_clips);
    // The clips the first merge made keep their names (matched by the kind in their name); the new one is loop-3.
    let name_at = |t: f64| {
        clips
            .iter()
            .find(|s| s["start"] == t)
            .and_then(|s| s["name"].as_str())
            .unwrap_or("")
            .to_string()
    };
    assert_eq!((name_at(10.0), name_at(30.0), name_at(50.0)), ("loop-1".into(), "loop-2".into(), "loop-3".into()));
    assert_eq!(clips.len(), 3, "nothing retired or doubled");
}

#[test]
fn test_markup_merge_deletes_unused_clip() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_clip(&mut lib, "clp-a", "smp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Propose empty (no clips)
    let proposed = vec![];
    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed, &identity).unwrap();

    // Verify: Clip is deleted
    let clip_args = json!({ "id": "clp-a" });
    let (clip_data, _) = lib
        .engine_mut()
        .call("Clip", "get", &clip_args, &identity)
        .unwrap();
    assert!(clip_data.is_null());
}

#[test]
fn test_markup_merge_ignores_user_clips() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_clip(&mut lib, "clp-u", "smp-1", "mine", 1.0, 2.0, "user", None);

    // Propose empty
    let proposed = vec![];
    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed, &identity).unwrap();

    // Verify: User clip still exists
    let clip_args = json!({ "id": "clp-u" });
    let (clip_data, _) = lib
        .engine_mut()
        .call("Clip", "get", &clip_args, &identity)
        .unwrap();
    assert!(!clip_data.is_null());
    assert_eq!(clip_data["source"], "user");
}

#[test]
fn test_save_score_creates_references() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_clip(
        &mut lib,
        "clp-a",
        "smp-1",
        "loop-1",
        10.0,
        14.0,
        "ml",
        Some("loop"),
    );

    let score_text = r#"tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat"#;

    let _ = save_score_impl(lib.engine_mut(), "score-1", score_text, &identity).unwrap();

    // Verify: ScoreRef exists
    let refs_args = json!({ "key": { "scoreId": "score-1" } });
    let (refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsByScore", &refs_args, &identity)
        .unwrap();
    let refs = refs_data.get("items").unwrap().as_array().unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["sampleId"], "smp-1");
    assert_eq!(refs[0]["clipId"], "clp-a");
    assert_eq!(refs[0]["start"], 10.0);
    assert_eq!(refs[0]["end"], 14.0);
}

#[test]
fn test_save_score_idempotent_replaces_references() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_sample(
        &mut lib,
        "smp-2",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_clip(
        &mut lib,
        "clp-a",
        "smp-1",
        "loop-1",
        10.0,
        14.0,
        "ml",
        Some("loop"),
    );

    let score_text1 = r#"tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat"#;

    let _ = save_score_impl(lib.engine_mut(), "score-1", score_text1, &identity).unwrap();

    // Save again with different references
    let score_text2 = r#"tempo 90
key C
bars 1
clip whole = marine-band/Thunderer.mp3
track whole"#;

    let _ = save_score_impl(lib.engine_mut(), "score-1", score_text2, &identity).unwrap();

    // Verify: Old references are gone, new one exists
    let refs_args = json!({ "key": { "scoreId": "score-1" } });
    let (refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsByScore", &refs_args, &identity)
        .unwrap();
    let refs = refs_data.get("items").unwrap().as_array().unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["sampleId"], "smp-2");

    // Verify: Old sample reference is gone
    let old_refs_args = json!({ "key": { "sampleId": "smp-1" } });
    let (old_refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsBySample", &old_refs_args, &identity)
        .unwrap();
    let old_refs = old_refs_data.get("items").unwrap().as_array().unwrap();
    assert_eq!(old_refs.len(), 0);
}

#[test]
fn test_save_score_unresolved_reference_kept() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    let score_text = r#"tempo 90
key C
bars 1
clip x = somewhere/else.wav
track x"#;

    let _ = save_score_impl(lib.engine_mut(), "score-3", score_text, &identity).unwrap();

    // Verify: ScoreRef exists but unresolved
    let refs_args = json!({ "key": { "scoreId": "score-3" } });
    let (refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsByScore", &refs_args, &identity)
        .unwrap();
    let refs = refs_data.get("items").unwrap().as_array().unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["samplePath"], "somewhere/else.wav");
    let sample_id = refs[0].get("sampleId");
    assert!(sample_id.is_none() || sample_id == Some(&json!(null)));
}

#[test]
fn test_skip_keeps_clip_when_someone_else_keeps() {
    let (_temp, mut lib) = setup_library();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "smp-1", "rec-1", 10.0, 14.0, "loop");

    // Alice keeps
    let alice_identity = VirtuusIdentity::User {
        sub: "alice".to_string(),
        username: "alice".to_string(),
        groups: vec!["members".to_string(), "curators".to_string()],
    };
    let keep_input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "keep".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: None,
    };
    let _ = judge(lib.engine_mut(), &keep_input, &alice_identity).unwrap();

    // Bob keeps
    let bob_identity = VirtuusIdentity::User {
        sub: "bob".to_string(),
        username: "bob".to_string(),
        groups: vec!["members".to_string(), "curators".to_string()],
    };
    let _ = judge(lib.engine_mut(), &keep_input, &bob_identity).unwrap();

    // Alice skips
    let skip_input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "skip".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: None,
    };
    let _ = judge(lib.engine_mut(), &skip_input, &alice_identity).unwrap();

    // Verify: Clip still exists (bob keeps it)
    let clip_id = apricity_data::curated_clip_id("cand-1");
    let clip_args = json!({ "id": clip_id });
    let (clip_data, _) = lib
        .engine_mut()
        .call("Clip", "get", &clip_args, &alice_identity)
        .unwrap();
    assert!(!clip_data.is_null());
    assert_eq!(clip_data["candidateId"], "cand-1");
}

#[test]
fn test_save_score_drum_kit_pads_are_references() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample(
        &mut lib,
        "smp-2",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_clip(
        &mut lib,
        "clp-h",
        "smp-2",
        "hit-3",
        19.8,
        20.3,
        "ml",
        Some("hit"),
    );

    // Score with drum kit pad reference
    let score_text = r#"tempo 90
key C
bars 1
clip band = marine-band/Thunderer.mp3
kit drums
  crash = band  hit-3
track drums  steps "crash . . ."
"#;

    let _ = save_score_impl(lib.engine_mut(), "score-2", score_text, &identity).unwrap();

    // Verify: ScoreRef exists for the kit pad clip
    let refs_args = json!({ "key": { "scoreId": "score-2" } });
    let (refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsByScore", &refs_args, &identity)
        .unwrap();
    let refs = refs_data.get("items").unwrap().as_array().unwrap();
    // There should be at least one ref for the clip
    let clip_ref = refs.iter().find(|r| r.get("clipId") == Some(&json!("clp-h")));
    assert!(clip_ref.is_some(), "Should find reference to clip clp-h");
    assert_eq!(clip_ref.unwrap()["clipId"], "clp-h");
}

#[test]
fn test_markup_merge_retires_clip_used_by_score() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_sample_with_counters(
        &mut lib,
        "smp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
        json!({"loop": 1}),
    );
    create_clip(&mut lib, "clp-a", "smp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Create a score that uses the clip
    let score_text = r#"tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat"#;
    let _ = save_score_impl(lib.engine_mut(), "score-1", score_text, &identity).unwrap();

    // Merge with empty proposal (no clips)
    let proposed = vec![];
    let _ = apply_markup_merge(lib.engine_mut(), "smp-1", proposed, &identity).unwrap();

    // Verify: Clip is retired (not deleted, because score uses it)
    let clip_args = json!({ "id": "clp-a" });
    let (clip_data, _) = lib
        .engine_mut()
        .call("Clip", "get", &clip_args, &identity)
        .unwrap();
    assert!(!clip_data.is_null());
    assert_eq!(clip_data["retired"], true);
}
