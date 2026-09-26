/// Markup merge: match proposed ML clips to existing ones, handle names and retirement.
/// Implements design/storage.md §1.3 exactly.
use std::collections::{HashMap, HashSet};

/// A proposed clip from markup analysis.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ProposedClip {
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub rank: Option<i32>,
}

/// An existing clip to potentially match.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ExistingClip {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub source: String, // "ml", "user", "curated", etc.
    pub retired: bool,
}

/// Compute intersection over union (IoU) of two time spans.
/// Returns a value in [0, 1] where 1 means perfect overlap and 0 means no overlap.
pub fn iou(a: (f64, f64), b: (f64, f64)) -> f64 {
    let intersection_start = a.0.max(b.0);
    let intersection_end = a.1.min(b.1);

    if intersection_start >= intersection_end {
        return 0.0;
    }

    let intersection = intersection_end - intersection_start;
    let union = (a.1 - a.0) + (b.1 - b.0) - intersection;

    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

/// Action to take with an existing clip.
#[derive(Debug, Clone, PartialEq)]
pub enum ClipAction {
    Keep {
        new_span: (f64, f64),
        rank: Option<i32>,
    },
    Retire,
    Delete,
}

/// A merge plan: what to keep, create, retire, and delete.
#[derive(Debug, Clone)]
pub struct MergePlan {
    pub keep: Vec<(String, (f64, f64), Option<i32>)>, // (existing_id, new_span, rank)
    pub create: Vec<(String, f64, f64, Option<i32>)>, // (name, start, end, rank)
    pub retire: Vec<String>,                          // existing clip ids
    pub delete: Vec<String>,                          // existing clip ids
    pub name_counters: HashMap<String, u32>,          // updated counters
}

/// Plan a merge of proposed clips with existing active clips.
/// Matches same-kind ML clips with ≥0.8 IoU, keeping ids/names.
/// Unmatched clips get new names. Old clips not proposed become retired (if used by a score) or deleted.
pub fn plan_merge(
    existing: &[ExistingClip],
    proposed: &[ProposedClip],
    mut name_counters: HashMap<String, u32>,
    used_by_score: &HashSet<String>,
) -> MergePlan {
    // Only match active ML clips
    let active_ml: Vec<_> = existing
        .iter()
        .filter(|s| s.source == "ml" && !s.retired)
        .collect();

    // Track which existing and proposed clips are matched
    let mut matched_existing = HashSet::new();
    let mut matched_proposed = HashSet::new();
    let mut keep = Vec::new();

    // Greedy matching: for each proposed clip, find the best active ML clip to match
    for (pidx, proposed) in proposed.iter().enumerate() {
        let mut best_match: Option<(usize, f64)> = None;

        for (eidx, existing) in active_ml.iter().enumerate() {
            if matched_existing.contains(&eidx) {
                continue; // Already matched
            }
            if existing.kind != proposed.kind {
                continue; // Different kind
            }

            let overlap = iou(
                (existing.start, existing.end),
                (proposed.start, proposed.end),
            );
            if overlap >= 0.8 {
                if best_match.is_none() || overlap > best_match.unwrap().1 {
                    best_match = Some((eidx, overlap));
                }
            }
        }

        if let Some((eidx, _)) = best_match {
            matched_existing.insert(eidx);
            matched_proposed.insert(pidx);
            let existing = active_ml[eidx];
            keep.push((
                existing.id.clone(),
                (proposed.start, proposed.end),
                proposed.rank,
            ));
        }
    }

    // Sort keep by existing clip id to be deterministic
    keep.sort_by(|a, b| a.0.cmp(&b.0));

    // Create new clips for unmatched proposals, under names no clip on the sample has (people name clips too).
    let mut create = Vec::new();
    let mut taken: HashSet<String> = existing.iter().map(|s| s.name.clone()).collect();

    for (pidx, proposed) in proposed.iter().enumerate() {
        if matched_proposed.contains(&pidx) {
            continue; // This proposed clip was matched
        }

        // This is a new unmatched proposal; give it a new name
        let kind = &proposed.kind;
        let counter = name_counters.entry(kind.clone()).or_insert(0);
        let name = loop {
            *counter += 1;
            let name = format!("{}-{}", kind, counter);
            if taken.insert(name.clone()) {
                break name;
            }
        };

        create.push((name, proposed.start, proposed.end, proposed.rank));
    }

    // Handle old clips not proposed: retire if used by score, else delete
    let mut retire = Vec::new();
    let mut delete = Vec::new();

    for (eidx, existing) in active_ml.iter().enumerate() {
        if !matched_existing.contains(&eidx) {
            // This old ML clip is not in the new proposal
            if used_by_score.contains(&existing.id) {
                retire.push(existing.id.clone());
            } else {
                delete.push(existing.id.clone());
            }
        }
    }

    MergePlan {
        keep,
        create,
        retire,
        delete,
        name_counters,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_iou_perfect_overlap() {
        assert_eq!(iou((10.0, 14.0), (10.0, 14.0)), 1.0);
    }

    #[test]
    fn test_iou_partial_overlap() {
        // Overlap: [10.1, 14.0) = 3.9
        // Union: [10.0, 14.0) = 4.0 + overlap inside the range
        // Union = (14.0 - 10.0) + (14.0 - 10.1) - (14.0 - 10.1) = 4.0 + 3.9 - 3.9 = 4.0
        // Actually: intersection = min(14, 14) - max(10, 10.1) = 14 - 10.1 = 3.9
        // Union = (14-10) + (14-10.1) - 3.9 = 4 + 3.9 - 3.9 = 4.0
        // IoU = 3.9 / 4.0 = 0.975
        let result = iou((10.0, 14.0), (10.1, 14.0));
        assert!((result - 0.975).abs() < 0.001);
    }

    #[test]
    fn test_iou_no_overlap() {
        assert_eq!(iou((10.0, 14.0), (20.0, 24.0)), 0.0);
    }

    #[test]
    fn test_iou_touching() {
        assert_eq!(iou((10.0, 14.0), (14.0, 18.0)), 0.0);
    }

    #[test]
    fn test_iou_contained() {
        // a = [10, 14], b = [11, 13]
        // intersection = 13 - 11 = 2
        // union = (14 - 10) + (13 - 11) - 2 = 4 + 2 - 2 = 4
        // iou = 2 / 4 = 0.5
        let result = iou((10.0, 14.0), (11.0, 13.0));
        assert!((result - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_merge_overlapping_keeps_id() {
        let existing = vec![ExistingClip {
            id: "clp-a".to_string(),
            name: "loop-1".to_string(),
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            source: "ml".to_string(),
            retired: false,
        }];

        let proposed = vec![ProposedClip {
            kind: "loop".to_string(),
            start: 10.1,
            end: 14.0,
            rank: Some(1),
        }];

        let mut name_counters = HashMap::new();
        name_counters.insert("loop".to_string(), 1);

        let plan = plan_merge(&existing, &proposed, name_counters, &HashSet::new());

        assert_eq!(plan.keep.len(), 1);
        assert_eq!(plan.keep[0].0, "clp-a");
        assert_eq!(plan.create.len(), 0);
        assert_eq!(plan.retire.len(), 0);
        assert_eq!(plan.delete.len(), 0);
    }

    #[test]
    fn test_merge_new_proposal_creates_name() {
        let existing = vec![ExistingClip {
            id: "clp-a".to_string(),
            name: "loop-1".to_string(),
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            source: "ml".to_string(),
            retired: false,
        }];

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

        let mut name_counters = HashMap::new();
        name_counters.insert("loop".to_string(), 1);

        let plan = plan_merge(&existing, &proposed, name_counters, &HashSet::new());

        assert_eq!(plan.keep.len(), 1);
        assert_eq!(plan.create.len(), 1);
        assert_eq!(plan.create[0].0, "loop-2");
    }

    #[test]
    fn test_merge_no_proposal_deletes_unused() {
        let existing = vec![ExistingClip {
            id: "clp-a".to_string(),
            name: "loop-1".to_string(),
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            source: "ml".to_string(),
            retired: false,
        }];

        let proposed = vec![];
        let mut name_counters = HashMap::new();
        name_counters.insert("loop".to_string(), 1);

        let plan = plan_merge(&existing, &proposed, name_counters, &HashSet::new());

        assert_eq!(plan.keep.len(), 0);
        assert_eq!(plan.delete.len(), 1);
        assert_eq!(plan.delete[0], "clp-a");
    }

    #[test]
    fn test_merge_no_proposal_retires_used() {
        let existing = vec![ExistingClip {
            id: "clp-a".to_string(),
            name: "loop-1".to_string(),
            kind: "loop".to_string(),
            start: 10.0,
            end: 14.0,
            source: "ml".to_string(),
            retired: false,
        }];

        let proposed = vec![];
        let mut name_counters = HashMap::new();
        name_counters.insert("loop".to_string(), 1);
        let mut used_by_score = HashSet::new();
        used_by_score.insert("clp-a".to_string());

        let plan = plan_merge(&existing, &proposed, name_counters, &used_by_score);

        assert_eq!(plan.keep.len(), 0);
        assert_eq!(plan.retire.len(), 1);
        assert_eq!(plan.retire[0], "clp-a");
    }

    #[test]
    fn test_merge_ignores_user_clips() {
        let existing = vec![
            ExistingClip {
                id: "clp-a".to_string(),
                name: "loop-1".to_string(),
                kind: "loop".to_string(),
                start: 10.0,
                end: 14.0,
                source: "ml".to_string(),
                retired: false,
            },
            ExistingClip {
                id: "clp-u".to_string(),
                name: "mine".to_string(),
                kind: "loop".to_string(),
                start: 1.0,
                end: 2.0,
                source: "user".to_string(),
                retired: false,
            },
        ];

        let proposed = vec![];
        let mut name_counters = HashMap::new();
        name_counters.insert("loop".to_string(), 1);

        let plan = plan_merge(&existing, &proposed, name_counters, &HashSet::new());

        // Only the ML clip should be deleted; the user clip should be ignored
        assert_eq!(plan.delete.len(), 1);
        assert_eq!(plan.delete[0], "clp-a");
    }

    #[test]
    fn new_names_skip_names_people_took() {
        let mine = ExistingClip {
            id: "c1".into(),
            name: "loop-2".into(),
            kind: String::new(),
            start: 0.0,
            end: 1.0,
            source: "user".into(),
            retired: false,
        };
        let proposed = vec![
            ProposedClip { kind: "loop".into(), start: 4.0, end: 5.0, rank: None },
            ProposedClip { kind: "loop".into(), start: 6.0, end: 7.0, rank: None },
        ];
        let counters = HashMap::from([("loop".to_string(), 1)]);
        let plan = plan_merge(&[mine], &proposed, counters, &HashSet::new());
        let names: Vec<&str> = plan.create.iter().map(|c| c.0.as_str()).collect();
        assert_eq!(names, ["loop-3", "loop-4"]);
        assert_eq!(plan.name_counters["loop"], 4);
    }
}
