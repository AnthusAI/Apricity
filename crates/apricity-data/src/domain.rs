//! Domain operations: judge, markup merge, save score.
//! Implements design/storage.md §3.2 and features/data/domain/*.feature.
//!
//! These are idempotent, multi-step operations over the library that coordinate
//! creating/updating verdicts, curated clips, and score references.

use crate::markup::{self, ExistingClip, ProposedClip};
use crate::score_refs;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
use virtuus_amplify::Identity as VirtuusIdentity;

/// A proposal for a new candidate (markup analysis result).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub candidate_id: String,
    pub sample_id: String,
    pub recording_id: String,
    pub start: f64,
    pub end: f64,
    pub kind: String,
    pub proposer: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Value>,
}

/// Input to the judge operation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeInput {
    pub candidate_id: String,
    pub verdict: String, // "keep", "skip", or "later"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crates: Option<Vec<String>>,
}

/// Error type for domain operations.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DomainError {
    pub message: String,
    pub error_type: Option<String>,
}

impl From<DomainError> for Value {
    fn from(err: DomainError) -> Self {
        json!({
            "message": err.message,
            "errorType": err.error_type.unwrap_or("Internal".to_string())
        })
    }
}

pub type Result<T> = std::result::Result<T, DomainError>;

/// Keep a candidate: create a verdict, a curated clip, and crate item.
/// Idempotent: keeping the same candidate twice changes nothing.
pub fn judge(
    engine: &mut virtuus_amplify::Engine,
    input: &JudgeInput,
    identity: &VirtuusIdentity,
) -> Result<Value> {
    let candidate_id = &input.candidate_id;
    let verdict_str = &input.verdict;

    // Fetch the candidate
    let candidate_args = json!({ "id": candidate_id });
    let (candidate_data, errors) = engine
        .call("Candidate", "get", &candidate_args, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    if let Some(error_list) = errors {
        if !error_list.is_empty() {
            return Err(DomainError {
                message: format!("Failed to fetch candidate: {:?}", error_list),
                error_type: Some("Engine".to_string()),
            });
        }
    }

    if candidate_data.is_null() {
        return Err(DomainError {
            message: format!("Candidate not found: {}", candidate_id),
            error_type: Some("NotFound".to_string()),
        });
    }

    // Get the current user's sub for the judge field
    let judge = match identity {
        VirtuusIdentity::User { sub, .. } => sub.clone(),
        VirtuusIdentity::ApiKey => "local".to_string(),
    };

    // Create or update the verdict
    let verdict_args = json!({
        "candidateId": candidate_id,
        "judge": judge,
        "verdict": verdict_str,
        "stars": input.stars,
        "tags": input.tags,
        "judgedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "by": match identity {
            VirtuusIdentity::User { sub, .. } => sub.clone(),
            VirtuusIdentity::ApiKey => "agent:domain".to_string(),
        }
    });

    let (_, errors) = engine
        .call("Verdict", "create", &verdict_args, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    if let Some(error_list) = errors {
        if !error_list.is_empty() {
            // If it's a duplicate (ConditionalCheckFailedException), update instead
            let is_duplicate = error_list.iter().any(|e| {
                e.get("errorType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.contains("ConditionalCheckFailedException"))
                    .unwrap_or(false)
            });

            if is_duplicate {
                // Try to update the existing verdict
                let update_args = json!({
                    "candidateId": candidate_id,
                    "judge": judge,
                    "verdict": verdict_str,
                    "stars": input.stars,
                    "tags": input.tags,
                });
                let _ = engine
                    .call("Verdict", "update", &update_args, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;
            } else {
                return Err(DomainError {
                    message: format!("Failed to create verdict: {:?}", error_list),
                    error_type: Some("Engine".to_string()),
                });
            }
        }
    }

    // If verdict is "keep", also create the curated clip and crate item
    if verdict_str == "keep" {
        let sample_id = candidate_data
            .get("sampleId")
            .and_then(|v| v.as_str())
            .ok_or(DomainError {
                message: "Candidate missing sampleId".to_string(),
                error_type: Some("Validation".to_string()),
            })?;

        let start = candidate_data
            .get("start")
            .and_then(|v| v.as_f64())
            .ok_or(DomainError {
                message: "Candidate missing start".to_string(),
                error_type: Some("Validation".to_string()),
            })?;

        let end = candidate_data
            .get("end")
            .and_then(|v| v.as_f64())
            .ok_or(DomainError {
                message: "Candidate missing end".to_string(),
                error_type: Some("Validation".to_string()),
            })?;

        let kind = candidate_data
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or(DomainError {
                message: "Candidate missing kind".to_string(),
                error_type: Some("Validation".to_string()),
            })?;

        // Create curated clip with deterministic id based on candidate id
        let clip_id = crate::curated_clip_id(candidate_id);
        let clip_name = input
            .name
            .clone()
            .unwrap_or_else(|| format!("curated-{}", Uuid::new_v4().to_string()[..8].to_string()));

        let clip_args = json!({
            "id": clip_id,
            "sampleId": sample_id,
            "name": clip_name,
            "start": start,
            "end": end,
            "source": "curated",
            "kind": kind,
            "candidateId": candidate_id,
            "owner": match identity {
                VirtuusIdentity::User { sub, .. } => sub.clone(),
                VirtuusIdentity::ApiKey => "local".to_string(),
            }
        });

        let (_, errors) = engine
            .call("Clip", "create", &clip_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;

        if let Some(error_list) = errors {
            if !error_list.is_empty() {
                // If it's a duplicate (ConditionalCheckFailedException), that's OK for idempotency
                let is_duplicate = error_list.iter().any(|e| {
                    e.get("errorType")
                        .and_then(|v| v.as_str())
                        .map(|s| s.contains("ConditionalCheckFailedException"))
                        .unwrap_or(false)
                });

                if !is_duplicate {
                    return Err(DomainError {
                        message: format!("Failed to create clip: {:?}", error_list),
                        error_type: Some("Engine".to_string()),
                    });
                }
            }
        }

        // Create crate items for any specified crates
        if let Some(crate_names) = &input.crates {
            for crate_name in crate_names {
                // First, get or create the crate
                let crate_args = json!({
                    "name": crate_name,
                    "owner": match identity {
                        VirtuusIdentity::User { sub, .. } => sub.clone(),
                        VirtuusIdentity::ApiKey => "local".to_string(),
                    }
                });

                let (crate_data, _) = engine
                    .call("Crate", "create", &crate_args, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;

                let crate_id = crate_data
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                // Create crate item with a fractional position
                let item_args = json!({
                    "crateId": crate_id,
                    "position": "a0",
                    "candidateId": candidate_id,
                    "owner": match identity {
                        VirtuusIdentity::User { sub, .. } => sub.clone(),
                        VirtuusIdentity::ApiKey => "local".to_string(),
                    }
                });

                let (_, errors) = engine
                    .call("CrateItem", "create", &item_args, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;

                if let Some(error_list) = errors {
                    if !error_list.is_empty() {
                        // Duplicate is OK for idempotency
                        let is_duplicate = error_list.iter().any(|e| {
                            e.get("errorType")
                                .and_then(|v| v.as_str())
                                .map(|s| s.contains("ConditionalCheckFailedException"))
                                .unwrap_or(false)
                        });

                        if !is_duplicate {
                            return Err(DomainError {
                                message: format!("Failed to create crate item: {:?}", error_list),
                                error_type: Some("Engine".to_string()),
                            });
                        }
                    }
                }
            }
        }
    } else if verdict_str == "skip" {
        // If verdict is "skip", remove the curated clip if nobody else keeps it
        let clip_id = crate::curated_clip_id(candidate_id);

        // Check how many keep verdicts exist for this candidate
        let verdicts_args = json!({ "filter": { "candidateId": { "eq": candidate_id } } });
        let (verdicts_data, _) = engine
            .call("Verdict", "list", &verdicts_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;

        let keeps_count =
            if let Some(verdicts) = verdicts_data.get("items").and_then(|v| v.as_array()) {
                verdicts
                    .iter()
                    .filter(|v| {
                        v.get("verdict")
                            .and_then(|verdict| verdict.as_str())
                            .map(|s| s == "keep")
                            .unwrap_or(false)
                    })
                    .count()
            } else {
                0
            };

        // Only delete if no one else keeps it
        if keeps_count == 0 {
            // Check if any score uses this clip
            let refs_args = json!({ "key": { "clipId": clip_id.clone() } });
            let (refs_data, _) = engine
                .call("ScoreRef", "refsByClip", &refs_args, identity)
                .map_err(|e| DomainError {
                    message: e.to_string(),
                    error_type: Some("Engine".to_string()),
                })?;

            let score_uses_it =
                if let Some(refs) = refs_data.get("items").and_then(|v| v.as_array()) {
                    !refs.is_empty()
                } else {
                    false
                };

            if score_uses_it {
                // Retire the clip
                let clip_update = json!({
                    "id": clip_id,
                    "retired": true
                });
                let _ = engine
                    .call("Clip", "update", &clip_update, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;
            } else {
                // Delete the clip and associated crate items
                let clip_delete = json!({ "id": clip_id });
                let _ = engine
                    .call("Clip", "delete", &clip_delete, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;

                // Delete crate items
                let items_args = json!({ "key": { "candidateId": candidate_id } });
                let (items_data, _) = engine
                    .call("CrateItem", "crateItemsByCandidate", &items_args, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;

                if let Some(items) = items_data.get("items").and_then(|v| v.as_array()) {
                    for item in items {
                        let item_id = item.get("id").and_then(|v| v.as_str());
                        if let Some(id) = item_id {
                            let _ = engine
                                .call("CrateItem", "delete", &json!({ "id": id }), identity)
                                .map_err(|e| DomainError {
                                    message: e.to_string(),
                                    error_type: Some("Engine".to_string()),
                                })?;
                        }
                    }
                }
            }
        }
    }

    Ok(json!({
        "candidateId": candidate_id,
        "verdict": verdict_str
    }))
}

/// Merge markup: match proposed ML clips to existing ones, handle names and retirement.
/// Implements design/storage.md §1.3.
pub fn apply_markup_merge(
    engine: &mut virtuus_amplify::Engine,
    sample_id: &str,
    proposed: Vec<ProposedClip>,
    identity: &VirtuusIdentity,
) -> Result<Value> {
    // Fetch the sample to get nameCounters
    let sample_args = json!({ "id": sample_id });
    let (sample_data, errors) = engine
        .call("Sample", "get", &sample_args, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    if let Some(error_list) = errors {
        if !error_list.is_empty() {
            return Err(DomainError {
                message: format!("Failed to fetch sample: {:?}", error_list),
                error_type: Some("Engine".to_string()),
            });
        }
    }

    if sample_data.is_null() {
        return Err(DomainError {
            message: format!("Sample not found: {}", sample_id),
            error_type: Some("NotFound".to_string()),
        });
    }

    // Parse name counters
    // `nameCounters` is AWSJSON: a JSON string in the contract, though older writers stored an object.
    let name_counters: HashMap<String, u32> = if let Some(nc) = sample_data.get("nameCounters") {
        match nc.as_str() {
            Some(text) => serde_json::from_str(text).unwrap_or_default(),
            None => serde_json::from_value(nc.clone()).unwrap_or_default(),
        }
    } else {
        HashMap::new()
    };

    // Fetch existing clips for this sample
    let clips_args = json!({ "key": { "sampleId": sample_id } });
    let (clips_data, errors) = engine
        .call("Clip", "clipsBySample", &clips_args, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    if let Some(error_list) = errors {
        if !error_list.is_empty() {
            return Err(DomainError {
                message: format!("Failed to fetch clips: {:?}", error_list),
                error_type: Some("Engine".to_string()),
            });
        }
    }

    let existing_clips: Vec<ExistingClip> =
        if let Some(items) = clips_data.get("items").and_then(|v| v.as_array()) {
            items
                .iter()
                .filter_map(|s| {
                    let source = s
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let retired = s.get("retired").and_then(|v| v.as_bool()).unwrap_or(false);

                    Some(ExistingClip {
                        id: s
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        name: s
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        kind: s
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        start: s.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        end: s.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        source,
                        retired,
                    })
                })
                .collect()
        } else if let Some(arr) = clips_data.as_array() {
            arr.iter()
                .filter_map(|s| {
                    let source = s
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let retired = s.get("retired").and_then(|v| v.as_bool()).unwrap_or(false);

                    Some(ExistingClip {
                        id: s
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        name: s
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        kind: s
                            .get("kind")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        start: s.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        end: s.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        source,
                        retired,
                    })
                })
                .collect()
        } else {
            Vec::new()
        };

    // Get clips used by scores
    let mut used_by_score = HashSet::new();
    for existing in &existing_clips {
        let refs_args = json!({ "key": { "clipId": existing.id.clone() } });
        let (refs_data, _) = engine
            .call("ScoreRef", "refsByClip", &refs_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;

        if let Some(items) = refs_data.get("items").and_then(|v| v.as_array()) {
            if !items.is_empty() {
                used_by_score.insert(existing.id.clone());
            }
        }
    }

    // Plan the merge
    let plan = markup::plan_merge(&existing_clips, &proposed, name_counters, &used_by_score);

    // Execute the plan: update kept clips
    for (existing_id, new_span, rank) in plan.keep {
        let update_args = json!({
            "id": existing_id,
            "start": new_span.0,
            "end": new_span.1,
            "rank": rank
        });
        let _ = engine
            .call("Clip", "update", &update_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;
    }

    // Create new clips
    for (name, start, end, rank) in plan.create {
        let create_args = json!({
            "id": format!("clp_{}", Uuid::new_v4().simple()),
            "sampleId": sample_id,
            "name": name,
            "start": start,
            "end": end,
            "source": "ml",
            "rank": rank
        });
        let _ = engine
            .call("Clip", "create", &create_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;
    }

    // Retire clips
    for clip_id in plan.retire {
        let update_args = json!({
            "id": clip_id,
            "retired": true
        });
        let _ = engine
            .call("Clip", "update", &update_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;
    }

    // Delete clips
    for clip_id in plan.delete {
        let delete_args = json!({ "id": clip_id });
        let _ = engine
            .call("Clip", "delete", &delete_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;
    }

    // Update sample's nameCounters
    let updated_counters = plan.name_counters;
    let sample_update = json!({
        "id": sample_id,
        "nameCounters": json!(updated_counters).to_string()
    });
    let _ = engine
        .call("Sample", "update", &sample_update, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    Ok(json!({
        "sampleId": sample_id,
        "processed": true
    }))
}

/// Save a score: parse it, extract references, and save ScoreRefs.
pub fn save_score_impl(
    engine: &mut virtuus_amplify::Engine,
    score_id: &str,
    text: &str,
    identity: &VirtuusIdentity,
) -> Result<Value> {
    // Parse the score to extract references
    let refs =
        score_refs::catalog_refs(text, "scores", &format!("{}.apr", score_id)).map_err(|errs| {
            DomainError {
                message: errs.join("; "),
                error_type: Some("Validation".to_string()),
            }
        })?;

    // Create or update the Score record
    let score_args = json!({
        "id": score_id,
        "text": text,
        "folder": "scores",
        "title": score_id,
        "owner": match identity {
            VirtuusIdentity::User { sub, .. } => sub.clone(),
            VirtuusIdentity::ApiKey => "local".to_string(),
        }
    });

    let (_score_data, errors) = engine
        .call("Score", "create", &score_args, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    if let Some(error_list) = errors {
        if !error_list.is_empty() {
            // Try updating if it already exists
            let score_args = json!({
                "id": score_id,
                "text": text,
            });
            let (_, errors) = engine
                .call("Score", "update", &score_args, identity)
                .map_err(|e| DomainError {
                    message: e.to_string(),
                    error_type: Some("Engine".to_string()),
                })?;

            if let Some(error_list) = errors {
                if !error_list.is_empty() {
                    return Err(DomainError {
                        message: format!("Failed to save score: {:?}", error_list),
                        error_type: Some("Engine".to_string()),
                    });
                }
            }
        }
    }

    // Delete existing score references for this score
    let existing_refs_args = json!({ "key": { "scoreId": score_id } });
    let (existing_refs, _) = engine
        .call("ScoreRef", "refsByScore", &existing_refs_args, identity)
        .map_err(|e| DomainError {
            message: e.to_string(),
            error_type: Some("Engine".to_string()),
        })?;

    if let Some(items) = existing_refs.get("items").and_then(|v| v.as_array()) {
        for ref_item in items {
            if let Some(ref_id) = ref_item.get("id").and_then(|v| v.as_str()) {
                let _ = engine
                    .call("ScoreRef", "delete", &json!({ "id": ref_id }), identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;
            }
        }
    }

    // Track the number of refs created
    let refs_count = refs.len();

    // Create new ScoreRefs
    for catalog_ref in refs {
        // Resolve sample id from path if needed
        let sample_id = if let Some(cid) = &catalog_ref.sample_id {
            Some(cid.clone())
        } else if let Some(path) = &catalog_ref.catalog_path {
            // Look up sample by path
            let samples_args = json!({ "key": { "path": path } });
            let (samples_data, _) = engine
                .call("Sample", "samplesByPath", &samples_args, identity)
                .map_err(|e| DomainError {
                    message: e.to_string(),
                    error_type: Some("Engine".to_string()),
                })?;

            if let Some(items) = samples_data.get("items").and_then(|v| v.as_array()) {
                items
                    .first()
                    .and_then(|c| c.get("id").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
            } else if let Some(c) = samples_data.as_object() {
                c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        } else {
            None
        };

        // Get clip id if clip name is specified
        let clip_id = if let Some(sid) = &catalog_ref.clip_id {
            Some(sid.clone())
        } else if let Some(sample_id_val) = &sample_id {
            if let Some(clip_name) = &catalog_ref.clip_name {
                let clips_args = json!({ "key": { "sampleId": sample_id_val } });
                let (clips_data, _) = engine
                    .call("Clip", "clipsBySample", &clips_args, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;

                if let Some(items) = clips_data.get("items").and_then(|v| v.as_array()) {
                    items
                        .iter()
                        .find(|s| {
                            s.get("name")
                                .and_then(|v| v.as_str())
                                .map(|n| n == clip_name)
                                .unwrap_or(false)
                        })
                        .and_then(|s| s.get("id").and_then(|v| v.as_str()))
                        .map(|s| s.to_string())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        // Get start and end from clip if available
        let (start, end) = if let Some(ref sid) = clip_id {
            if let Some(ref cid) = sample_id {
                let clips_args = json!({ "key": { "sampleId": cid } });
                let (clips_data, _) = engine
                    .call("Clip", "clipsBySample", &clips_args, identity)
                    .map_err(|e| DomainError {
                        message: e.to_string(),
                        error_type: Some("Engine".to_string()),
                    })?;

                if let Some(items) = clips_data.get("items").and_then(|v| v.as_array()) {
                    let clip = items.iter().find(|s| {
                        s.get("id")
                            .and_then(|v| v.as_str())
                            .map(|id| id == sid)
                            .unwrap_or(false)
                    });
                    if let Some(s) = clip {
                        let start = s.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let end = s.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        (Some(start), Some(end))
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        let ref_id = format!("sref_{}_{}", score_id, catalog_ref.id_suffix);
        let ref_args = json!({
            "id": ref_id,
            "scoreId": score_id,
            "clipAlias": catalog_ref.alias,
            "source": catalog_ref.source,
            "sampleId": sample_id,
            "samplePath": catalog_ref.catalog_path,
            "clipName": catalog_ref.clip_name,
            "clipId": clip_id,
            "start": start,
            "end": end,
            "kitPad": catalog_ref.kit_pad,
            "owner": match identity {
                VirtuusIdentity::User { sub, .. } => sub.clone(),
                VirtuusIdentity::ApiKey => "local".to_string(),
            }
        });

        let _ = engine
            .call("ScoreRef", "create", &ref_args, identity)
            .map_err(|e| DomainError {
                message: e.to_string(),
                error_type: Some("Engine".to_string()),
            })?;
    }

    Ok(json!({
        "scoreId": score_id,
        "refsCreated": refs_count
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_judge_input_deserialization() {
        let json = r#"{"candidateId": "c1", "verdict": "keep", "stars": 4}"#;
        let input: JudgeInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.candidate_id, "c1");
        assert_eq!(input.verdict, "keep");
        assert_eq!(input.stars, Some(4));
    }

    #[test]
    fn test_proposal_deserialization() {
        let json = r#"{"candidateId": "c1", "sampleId": "smp-1", "recordingId": "rec-1", "start": 10.0, "end": 14.0, "kind": "loop", "proposer": "ml", "score": 0.9}"#;
        let proposal: Proposal = serde_json::from_str(json).unwrap();
        assert_eq!(proposal.candidate_id, "c1");
        assert_eq!(proposal.kind, "loop");
    }
}
