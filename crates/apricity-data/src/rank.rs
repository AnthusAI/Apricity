/// Ranking algorithm: port of analysis/apricity_analyze/curation.py rank() function.
/// Computes a feed ranked by proposer score × trait lift (smoothed keep rate per kind/proposer/recording/stem).
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A proposer reference in a candidate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Proposer {
    pub by: String,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
}

/// Context information for a candidate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beats: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stem: Option<String>,
}

/// A candidate: a proposed span of audio.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub kind: String,
    pub recording: String,
    pub proposers: Vec<Proposer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<CandidateContext>,
}

/// A verdict on a candidate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub verdict: String, // "keep", "skip", or "later"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stars: Option<u32>,
}

/// A ranked candidate with computed rank and explanations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Ranked {
    pub id: String,
    pub kind: String,
    pub recording: String,
    pub proposers: Vec<Proposer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<CandidateContext>,
    pub rank: f64,
    pub score: f64,
    pub why_ranked: Vec<String>,
    pub later: bool,
}

/// Compute the weight of a verdict: how much it contributes to taste.
/// keep (5 stars): 1.0, keep (1-2 stars): 0.4-0.7, skip: 0.0, later: None
fn weight(verdict: &Verdict) -> Option<f64> {
    match verdict.verdict.as_str() {
        "skip" => Some(0.0),
        "keep" => {
            let w = match verdict.stars {
                Some(1) => 0.4,
                Some(2) => 0.7,
                _ => 1.0, // 3+ stars or no stars
            };
            Some(w)
        }
        _ => None, // "later" or unknown
    }
}

/// Extract trait values from a candidate.
/// Traits: kind, proposer (first proposer's "by"), recording, stem (from context or "full mix")
/// Returns Vec of tuples to maintain consistent ordering: kind, proposer, recording, stem
fn traits(candidate: &Candidate) -> Vec<(String, String)> {
    let mut result = Vec::new();
    result.push(("kind".to_string(), candidate.kind.clone()));
    if let Some(first_proposer) = candidate.proposers.first() {
        result.push(("proposer".to_string(), first_proposer.by.clone()));
    }
    result.push(("recording".to_string(), candidate.recording.clone()));
    let stem = candidate
        .context
        .as_ref()
        .and_then(|c| c.stem.as_ref())
        .cloned()
        .unwrap_or_else(|| "full mix".to_string());
    result.push(("stem".to_string(), stem));
    result
}

/// Format a trait value for display.
fn trait_words(trait_name: &str, value: &str) -> String {
    match trait_name {
        "kind" => format!("{}s", value),
        "proposer" => format!("{}'s picks", value),
        "recording" => format!("from {}", value),
        "stem" => format!("{} clips", value),
        _ => value.to_string(),
    }
}

/// Format a number using Python's :g format (general format).
/// This uses up to 6 significant figures and removes trailing zeros.
fn format_g(value: f64) -> String {
    // Round to remove floating point artifacts
    let rounded = (value * 1e10).round() / 1e10;

    // Check if it's an integer
    if rounded.fract() == 0.0 && rounded.abs() < 1e10 {
        return format!("{:.0}", rounded);
    }

    // Use general format with 6 significant figures
    let formatted = format!("{:.6}", rounded);
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    trimmed.to_string()
}

/// Rank candidates: unjudged and "later" candidates, best first.
/// Rank = max(proposer_score) × trait_lift where lift is smoothed keep_rate / base_keep_rate.
pub fn rank(candidates: &[Candidate], verdicts: &HashMap<String, Verdict>) -> Vec<Ranked> {
    // Compute overall keep rate (smoothed with Beta(1,1) prior)
    let judged: Vec<_> = candidates
        .iter()
        .filter_map(|c| verdicts.get(&c.id).and_then(|v| weight(v).map(|w| (c, w))))
        .collect();

    let total = judged.len() as f64;
    let kept: f64 = judged.iter().map(|(_, w)| w).sum();
    let base = (kept + 1.0) / (total + 2.0);

    // Compute trait statistics: (kept_weight, count) per (trait_name, trait_value)
    let mut stats: HashMap<(String, String), (f64, f64)> = HashMap::new();
    for (c, w) in &judged {
        for (trait_name, trait_value) in traits(c) {
            let entry = stats.entry((trait_name, trait_value)).or_insert((0.0, 0.0));
            entry.0 += w;
            entry.1 += 1.0;
        }
    }

    // Rank each candidate
    let mut out = Vec::new();
    for c in candidates {
        let v = verdicts.get(&c.id);
        // Skip candidates that have been judged (keep or skip)
        if let Some(v) = v {
            if v.verdict != "later" {
                continue;
            }
        }

        // Compute rank and reasons
        let score = c.proposers.iter().map(|p| p.score).fold(0.0, f64::max);
        let mut lift = 1.0;
        let mut reasons: Vec<(f64, usize, String)> = Vec::new(); // (lift_magnitude, trait_index, reason)

        for (trait_idx, (trait_name, trait_value)) in traits(c).iter().enumerate() {
            let (kept_weight, count) = stats
                .get(&(trait_name.clone(), trait_value.clone()))
                .copied()
                .unwrap_or((0.0, 0.0));
            if count == 0.0 {
                continue;
            }

            let trait_keep_rate = (kept_weight + 1.0) / (count + 2.0);
            let f = trait_keep_rate / base;
            lift *= f;

            // Only report reasons when the condition is met and the effect is notable
            if count >= 2.0 && (f - 1.0).abs() > 0.15 {
                let report = if f > 1.0 {
                    // Report kept count
                    if kept_weight >= 1.0 {
                        let kept_display = format_g(kept_weight);
                        Some(format!(
                            "you kept {} of {} {}",
                            kept_display,
                            count as u32,
                            trait_words(&trait_name, &trait_value)
                        ))
                    } else {
                        None
                    }
                } else {
                    // Report skipped count
                    let skipped = count - kept_weight;
                    if skipped >= 1.0 {
                        let skipped_display = format_g(skipped);
                        Some(format!(
                            "you skipped {} of {} {}",
                            skipped_display,
                            count as u32,
                            trait_words(&trait_name, &trait_value)
                        ))
                    } else {
                        None
                    }
                };

                if let Some(reason) = report {
                    reasons.push((f.ln().abs(), trait_idx, reason));
                }
            }
        }

        // Sort by lift magnitude (descending), then by trait index (ascending) for determinism
        reasons.sort_by(
            |a, b| match b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal) {
                std::cmp::Ordering::Equal => a.1.cmp(&b.1),
                other => other,
            },
        );

        let why_ranked: Vec<String> = reasons.iter().take(2).map(|(_, _, r)| r.clone()).collect();

        let is_later = v.map(|v| v.verdict == "later").unwrap_or(false);

        out.push(Ranked {
            id: c.id.clone(),
            kind: c.kind.clone(),
            recording: c.recording.clone(),
            proposers: c.proposers.clone(),
            context: c.context.clone(),
            rank: (score * lift * 10000.0).round() / 10000.0, // Round to 4 decimal places
            score,
            why_ranked,
            later: is_later,
        });
    }

    // Sort: later=false first (ascending), then by rank descending
    out.sort_by(|a, b| {
        if a.later != b.later {
            a.later.cmp(&b.later)
        } else {
            b.rank
                .partial_cmp(&a.rank)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    });

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_weight() {
        let v_keep = Verdict {
            verdict: "keep".to_string(),
            stars: None,
        };
        assert_eq!(weight(&v_keep), Some(1.0));

        let v_keep_1star = Verdict {
            verdict: "keep".to_string(),
            stars: Some(1),
        };
        assert_eq!(weight(&v_keep_1star), Some(0.4));

        let v_keep_2star = Verdict {
            verdict: "keep".to_string(),
            stars: Some(2),
        };
        assert_eq!(weight(&v_keep_2star), Some(0.7));

        let v_skip = Verdict {
            verdict: "skip".to_string(),
            stars: None,
        };
        assert_eq!(weight(&v_skip), Some(0.0));

        let v_later = Verdict {
            verdict: "later".to_string(),
            stars: None,
        };
        assert_eq!(weight(&v_later), None);
    }

    #[test]
    fn test_traits() {
        let candidate = Candidate {
            id: "cand_test".to_string(),
            kind: "loop".to_string(),
            recording: "Thunderer".to_string(),
            proposers: vec![Proposer {
                by: "analyzer:markup/loops".to_string(),
                score: 0.8,
                why: None,
                evidence: None,
            }],
            context: Some(CandidateContext {
                seconds: Some(4.0),
                bpm: Some(120.0),
                beats: Some(8.0),
                key: Some("C major".to_string()),
                stem: Some("drums".to_string()),
            }),
        };

        let t = traits(&candidate);
        let t_map: std::collections::HashMap<&str, &str> =
            t.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(t_map.get("kind"), Some(&"loop"));
        assert_eq!(t_map.get("proposer"), Some(&"analyzer:markup/loops"));
        assert_eq!(t_map.get("recording"), Some(&"Thunderer"));
        assert_eq!(t_map.get("stem"), Some(&"drums"));
    }

    #[test]
    fn test_traits_no_stem() {
        let candidate = Candidate {
            id: "cand_test".to_string(),
            kind: "loop".to_string(),
            recording: "Thunderer".to_string(),
            proposers: vec![Proposer {
                by: "analyzer:markup/loops".to_string(),
                score: 0.8,
                why: None,
                evidence: None,
            }],
            context: None,
        };

        let t = traits(&candidate);
        let t_map: std::collections::HashMap<&str, &str> =
            t.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(t_map.get("stem"), Some(&"full mix"));
    }

    #[test]
    fn test_rank_empty() {
        let result = rank(&[], &HashMap::new());
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_rank_no_verdicts() {
        let candidate = Candidate {
            id: "cand_1".to_string(),
            kind: "loop".to_string(),
            recording: "test".to_string(),
            proposers: vec![Proposer {
                by: "analyzer:test".to_string(),
                score: 0.8,
                why: None,
                evidence: None,
            }],
            context: None,
        };

        let result = rank(&[candidate.clone()], &HashMap::new());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "cand_1");
        assert_eq!(result[0].rank, 0.8);
        assert_eq!(result[0].later, false);
    }
}
