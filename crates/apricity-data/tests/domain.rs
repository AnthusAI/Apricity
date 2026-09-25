//! Integration tests for domain operations: judge, markup merge, save_score.
//! Tests build full state through Library/facades and verify domain operation results.

use apricity_data::{apply_markup_merge, judge, save_score_impl, JudgeInput};
use apricity_data::markup::ProposedSlice;
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

// Helper to create a clip
fn create_clip(
    lib: &mut apricity_data::Library,
    id: &str,
    recording_id: &str,
    path: &str,
    collection: &str,
    title: &str,
) {
    create_clip_with_counters(lib, id, recording_id, path, collection, title, json!({}));
}

// Helper to create a clip with initial nameCounters
fn create_clip_with_counters(
    lib: &mut apricity_data::Library,
    id: &str,
    recording_id: &str,
    path: &str,
    collection: &str,
    title: &str,
    counters: serde_json::Value,
) {
    let clip = json!({
        "id": id,
        "recordingId": recording_id,
        "path": path,
        "collection": collection,
        "title": title,
        "audio": {"key": format!("audio/{}/test.wav", id), "sha256": "aa"},
        "nameCounters": counters
    });
    if let Some(table) = lib.engine_mut().table_mut("Clip") {
        table.put(clip);
    }
}

// Helper to create a candidate
fn create_candidate(
    lib: &mut apricity_data::Library,
    id: &str,
    clip_id: &str,
    recording_id: &str,
    start: f64,
    end: f64,
    kind: &str,
) {
    let candidate = json!({
        "id": id,
        "clipId": clip_id,
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

// Helper to create a slice
fn create_slice(
    lib: &mut apricity_data::Library,
    id: &str,
    clip_id: &str,
    name: &str,
    start: f64,
    end: f64,
    source: &str,
    kind: Option<&str>,
) {
    let mut slice_json = json!({
        "id": id,
        "clipId": clip_id,
        "name": name,
        "start": start,
        "end": end,
        "source": source
    });
    if let Some(k) = kind {
        slice_json["kind"] = json!(k);
    }
    if let Some(table) = lib.engine_mut().table_mut("Slice") {
        table.put(slice_json);
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
fn test_keep_candidate_creates_verdict_slice_crate_item() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    // Setup: Recording and Clip
    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "clp-1", "rec-1", 10.0, 14.0, "loop");

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

    // Verify: Curated Slice exists
    let slice_id = apricity_data::curated_slice_id("cand-1");
    let slice_args = json!({ "id": slice_id });
    let (slice_data, _) = lib
        .engine_mut()
        .call("Slice", "get", &slice_args, &identity)
        .unwrap();
    assert!(!slice_data.is_null());
    assert_eq!(slice_data["candidateId"], "cand-1");
    assert_eq!(slice_data["source"], "curated");
    assert_eq!(slice_data["start"], 10.0);
    assert_eq!(slice_data["end"], 14.0);

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
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "clp-1", "rec-1", 10.0, 14.0, "loop");

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

    // Verify: Still only 1 curated slice
    let slices_args = json!({ "key": { "clipId": "clp-1" } });
    let (slices_data, _) = lib
        .engine_mut()
        .call("Slice", "slicesByClip", &slices_args, &identity)
        .unwrap();
    let slices = slices_data.get("items").unwrap().as_array().unwrap();
    let curated_slices: Vec<_> = slices
        .iter()
        .filter(|s| s.get("candidateId").unwrap_or(&json!(null)) == "cand-1")
        .collect();
    assert_eq!(curated_slices.len(), 1);
}

#[test]
fn test_skip_candidate_removes_slice_when_alone() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "clp-1", "rec-1", 10.0, 14.0, "loop");

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

    // Verify: No curated slice (should be deleted since no other keeps)
    let slices_args = json!({ "key": { "clipId": "clp-1" } });
    let (slices_data, _) = lib
        .engine_mut()
        .call("Slice", "slicesByClip", &slices_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_slices = Vec::new();
    let slices = slices_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_slices);
    let curated_slices: Vec<_> = slices
        .iter()
        .filter(|s| s.get("source").unwrap_or(&json!(null)) == "curated")
        .collect();
    assert_eq!(curated_slices.len(), 0);
}

#[test]
fn test_later_verdict_creates_no_slice() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "clp-1", "rec-1", 10.0, 14.0, "loop");

    let input = JudgeInput {
        candidate_id: "cand-1".to_string(),
        verdict: "later".to_string(),
        stars: None,
        tags: None,
        name: None,
        crates: None,
    };

    let _ = judge(lib.engine_mut(), &input, &identity).unwrap();

    // Verify: No slice created (later verdict doesn't create slices)
    let slices_args = json!({ "key": { "clipId": "clp-1" } });
    let (slices_data, _) = lib
        .engine_mut()
        .call("Slice", "slicesByClip", &slices_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_slices = Vec::new();
    let slices = slices_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_slices);
    assert_eq!(slices.len(), 0);
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
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_slice(&mut lib, "slc-a", "clp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Propose overlapping slice (IoU > 0.8)
    let proposed = vec![ProposedSlice {
        kind: "loop".to_string(),
        start: 10.1,
        end: 14.0,
        rank: Some(1),
    }];

    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed, &identity).unwrap();

    // Verify: Slice still has same id
    let slice_args = json!({ "id": "slc-a" });
    let (slice_data, _) = lib
        .engine_mut()
        .call("Slice", "get", &slice_args, &identity)
        .unwrap();
    assert!(!slice_data.is_null());
    assert_eq!(slice_data["id"], "slc-a");
    assert_eq!(slice_data["name"], "loop-1");
    assert_eq!(slice_data["start"], 10.1); // Updated
    assert_eq!(slice_data["end"], 14.0);
}

#[test]
fn test_markup_merge_new_proposal_creates_name() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip_with_counters(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
        json!({"loop": 1}),
    );
    create_slice(&mut lib, "slc-a", "clp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Propose overlapping + new
    let proposed = vec![
        ProposedSlice {
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            rank: Some(2),
        },
        ProposedSlice {
            kind: "loop".to_string(),
            start: 30.0,
            end: 34.0,
            rank: Some(1),
        },
    ];

    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed, &identity).unwrap();

    // Verify: New slice has name "loop-2"
    let slices_args = json!({ "key": { "clipId": "clp-1" } });
    let (slices_data, _) = lib
        .engine_mut()
        .call("Slice", "slicesByClip", &slices_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_slices = Vec::new();
    let slices = slices_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_slices);
    let loop_2 = slices
        .iter()
        .find(|s| s.get("name").unwrap_or(&json!(null)) == "loop-2");
    assert!(loop_2.is_some(), "Should find loop-2 slice");
    let loop_2 = loop_2.unwrap();
    assert_eq!(loop_2["start"], 30.0);
    assert_eq!(loop_2["end"], 34.0);
}

#[test]
fn test_markup_merge_names_never_reused() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip_with_counters(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
        json!({"loop": 1}),
    );
    create_slice(&mut lib, "slc-a", "clp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // First merge: add loop-2 at 30-34
    let proposed1 = vec![
        ProposedSlice {
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            rank: None,
        },
        ProposedSlice {
            kind: "loop".to_string(),
            start: 30.0,
            end: 34.0,
            rank: None,
        },
    ];
    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed1, &identity).unwrap();

    // Second merge: add another (should be loop-3, never reuse loop-2)
    let proposed2 = vec![
        ProposedSlice {
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            rank: None,
        },
        ProposedSlice {
            kind: "loop".to_string(),
            start: 30.0,
            end: 34.0,
            rank: None,
        },
        ProposedSlice {
            kind: "loop".to_string(),
            start: 50.0,
            end: 54.0,
            rank: None,
        },
    ];
    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed2, &identity).unwrap();

    // Verify: New slice has name "loop-3" (not reused)
    let slices_args = json!({ "key": { "clipId": "clp-1" } });
    let (slices_data, _) = lib
        .engine_mut()
        .call("Slice", "slicesByClip", &slices_args, &identity)
        .unwrap();
    let empty_json = json!([]);
    let default_slices = Vec::new();
    let slices = slices_data
        .get("items")
        .unwrap_or(&empty_json)
        .as_array()
        .unwrap_or(&default_slices);
    let loop_3 = slices
        .iter()
        .find(|s| s.get("name").unwrap_or(&json!(null)) == "loop-3")
        .expect("loop-3 should exist");
    assert_eq!(loop_3["start"], 50.0);
    assert_eq!(loop_3["end"], 54.0);
}

#[test]
fn test_markup_merge_deletes_unused_slice() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_slice(&mut lib, "slc-a", "clp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Propose empty (no slices)
    let proposed = vec![];
    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed, &identity).unwrap();

    // Verify: Slice is deleted
    let slice_args = json!({ "id": "slc-a" });
    let (slice_data, _) = lib
        .engine_mut()
        .call("Slice", "get", &slice_args, &identity)
        .unwrap();
    assert!(slice_data.is_null());
}

#[test]
fn test_markup_merge_ignores_user_slices() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_slice(&mut lib, "slc-u", "clp-1", "mine", 1.0, 2.0, "user", None);

    // Propose empty
    let proposed = vec![];
    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed, &identity).unwrap();

    // Verify: User slice still exists
    let slice_args = json!({ "id": "slc-u" });
    let (slice_data, _) = lib
        .engine_mut()
        .call("Slice", "get", &slice_args, &identity)
        .unwrap();
    assert!(!slice_data.is_null());
    assert_eq!(slice_data["source"], "user");
}

#[test]
fn test_save_score_creates_references() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_slice(
        &mut lib,
        "slc-a",
        "clp-1",
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
    assert_eq!(refs[0]["clipId"], "clp-1");
    assert_eq!(refs[0]["sliceId"], "slc-a");
    assert_eq!(refs[0]["start"], 10.0);
    assert_eq!(refs[0]["end"], 14.0);
}

#[test]
fn test_save_score_idempotent_replaces_references() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
    );
    create_clip(
        &mut lib,
        "clp-2",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_slice(
        &mut lib,
        "slc-a",
        "clp-1",
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
    assert_eq!(refs[0]["clipId"], "clp-2");

    // Verify: Old clip reference is gone
    let old_refs_args = json!({ "key": { "clipId": "clp-1" } });
    let (old_refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsByClip", &old_refs_args, &identity)
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
    assert_eq!(refs[0]["clipPath"], "somewhere/else.wav");
    let clip_id = refs[0].get("clipId");
    assert!(clip_id.is_none() || clip_id == Some(&json!(null)));
}

#[test]
fn test_skip_keeps_slice_when_someone_else_keeps() {
    let (_temp, mut lib) = setup_library();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_candidate(&mut lib, "cand-1", "clp-1", "rec-1", 10.0, 14.0, "loop");

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

    // Verify: Slice still exists (bob keeps it)
    let slice_id = apricity_data::curated_slice_id("cand-1");
    let slice_args = json!({ "id": slice_id });
    let (slice_data, _) = lib
        .engine_mut()
        .call("Slice", "get", &slice_args, &alice_identity)
        .unwrap();
    assert!(!slice_data.is_null());
    assert_eq!(slice_data["candidateId"], "cand-1");
}

#[test]
fn test_save_score_drum_kit_pads_are_references() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip(
        &mut lib,
        "clp-2",
        "rec-1",
        "marine-band/Thunderer.mp3",
        "marine-band",
        "Thunderer",
    );
    create_slice(
        &mut lib,
        "slc-h",
        "clp-2",
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

    // Verify: ScoreRef exists for the kit pad slice
    let refs_args = json!({ "key": { "scoreId": "score-2" } });
    let (refs_data, _) = lib
        .engine_mut()
        .call("ScoreRef", "refsByScore", &refs_args, &identity)
        .unwrap();
    let refs = refs_data.get("items").unwrap().as_array().unwrap();
    // There should be at least one ref for the slice
    let slice_ref = refs.iter().find(|r| r.get("sliceId") == Some(&json!("slc-h")));
    assert!(slice_ref.is_some(), "Should find reference to slice slc-h");
    assert_eq!(slice_ref.unwrap()["sliceId"], "slc-h");
}

#[test]
fn test_markup_merge_retires_slice_used_by_score() {
    let (_temp, mut lib) = setup_library();
    let identity = local_identity();

    create_recording(&mut lib, "rec-1", "The Thunderer", "marine-band");
    create_clip_with_counters(
        &mut lib,
        "clp-1",
        "rec-1",
        "marine-band/stems/Thunderer/drums.wav",
        "marine-band",
        "Thunderer drums",
        json!({"loop": 1}),
    );
    create_slice(&mut lib, "slc-a", "clp-1", "loop-1", 10.0, 14.0, "ml", Some("loop"));

    // Create a score that uses the slice
    let score_text = r#"tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
track beat"#;
    let _ = save_score_impl(lib.engine_mut(), "score-1", score_text, &identity).unwrap();

    // Merge with empty proposal (no slices)
    let proposed = vec![];
    let _ = apply_markup_merge(lib.engine_mut(), "clp-1", proposed, &identity).unwrap();

    // Verify: Slice is retired (not deleted, because score uses it)
    let slice_args = json!({ "id": "slc-a" });
    let (slice_data, _) = lib
        .engine_mut()
        .call("Slice", "get", &slice_args, &identity)
        .unwrap();
    assert!(!slice_data.is_null());
    assert_eq!(slice_data["retired"], true);
}
