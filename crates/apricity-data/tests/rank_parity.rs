use apricity_data::rank::{rank, Candidate, CandidateContext, Proposer, Verdict};
use std::collections::HashMap;

#[test]
fn test_rank_parity_with_fixture() {
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rank.json");

    let fixture_text = std::fs::read_to_string(&fixture_path)
        .expect("Failed to read fixture file");
    let fixture: serde_json::Value = serde_json::from_str(&fixture_text)
        .expect("Failed to parse fixture JSON");

    // Extract candidates and verdicts from fixture
    let candidates_data = &fixture["candidates"];
    let verdicts_data = &fixture["verdicts"];
    let expected_data = &fixture["expected"];

    // Convert Python candidates to Rust Candidate structs
    let mut candidates = Vec::new();
    for cand_val in candidates_data.as_array().unwrap() {
        let id = cand_val["id"].as_str().unwrap().to_string();
        let kind = cand_val["kind"].as_str().unwrap().to_string();
        let recording = cand_val["recording"].as_str().unwrap().to_string();

        let proposers: Vec<Proposer> = cand_val["proposers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| Proposer {
                by: p["by"].as_str().unwrap().to_string(),
                score: p["score"].as_f64().unwrap(),
                why: p.get("why").and_then(|v| v.as_str()).map(|s| s.to_string()),
                evidence: p.get("evidence").cloned(),
            })
            .collect();

        let context = if let Some(ctx) = cand_val.get("context") {
            if ctx.is_object() {
                Some(CandidateContext {
                    seconds: ctx.get("seconds").and_then(|v| v.as_f64()),
                    bpm: ctx.get("bpm").and_then(|v| v.as_f64()),
                    beats: ctx.get("beats").and_then(|v| v.as_f64()),
                    key: ctx.get("key").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    stem: ctx.get("stem").and_then(|v| v.as_str()).map(|s| s.to_string()),
                })
            } else {
                None
            }
        } else {
            None
        };

        candidates.push(Candidate {
            id,
            kind,
            recording,
            proposers,
            context,
        });
    }

    // Convert Python verdicts to Rust Verdict structs
    let mut verdicts = HashMap::new();
    if let Some(obj) = verdicts_data.as_object() {
        for (cid, v_val) in obj {
            let verdict = Verdict {
                verdict: v_val["verdict"].as_str().unwrap().to_string(),
                stars: v_val.get("stars").and_then(|v| v.as_u64()).map(|s| s as u32),
            };
            verdicts.insert(cid.clone(), verdict);
        }
    }

    // Run our rank function
    let ranked = rank(&candidates, &verdicts);

    // Verify results match expected
    let expected_array = expected_data.as_array().unwrap();
    assert_eq!(
        ranked.len(),
        expected_array.len(),
        "Ranked results count mismatch"
    );

    for (i, (actual, expected)) in ranked.iter().zip(expected_array.iter()).enumerate() {
        let expected_id = expected["id"].as_str().unwrap();
        let expected_rank = expected["rank"].as_f64().unwrap();
        let expected_why = expected["why_ranked"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        let expected_later = expected["later"].as_bool().unwrap();

        assert_eq!(
            actual.id, expected_id,
            "Mismatch at position {}: id",
            i
        );

        // Check rank within 1e-4 tolerance
        if (actual.rank - expected_rank).abs() > 0.00011 {
            panic!(
                "Mismatch at position {}: rank. Expected {}, got {}",
                i, expected_rank, actual.rank
            );
        }

        assert_eq!(
            actual.why_ranked, expected_why,
            "Mismatch at position {}: why_ranked",
            i
        );

        assert_eq!(
            actual.later, expected_later,
            "Mismatch at position {}: later",
            i
        );
    }

    println!("✓ Rank parity test passed: {} candidates ranked correctly", ranked.len());
}
