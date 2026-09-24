#!/usr/bin/env python3
"""Export a rank fixture from the Python curation module for testing parity with Rust.

Run with: PYTHONPATH=analysis analysis/.venv/bin/python scripts/export-rank-fixture.py
"""

import json
import sys
from pathlib import Path

# Add analysis to path
sys.path.insert(0, str(Path(__file__).parent.parent / "analysis"))

from apricitus_analyze import curation

def main():
    root = Path(__file__).parent.parent

    # Load candidates
    candidates_path = root / "library" / "candidates.json"
    with open(candidates_path) as f:
        data = json.load(f)
    candidates = data["candidates"]

    print(f"Loaded {len(candidates)} candidates")

    # Create deterministic synthetic verdicts for ~40% of candidates
    # i % 5 == 0 → keep with cycling stars 1-5
    # i % 7 == 0 → skip
    # i % 11 == 0 → later
    # else → no verdict (unjudged)
    verdicts = {}

    for i, candidate in enumerate(candidates):
        cid = candidate["id"]

        # Deterministic pattern based on index (~40% get verdicts)
        if i % 5 == 0:
            # Keep every 5th with cycling stars 1-5
            verdict = "keep"
            stars = (i % 5) + 1  # Stars 1-5 cycling
        elif i % 7 == 0:
            # Skip every 7th
            verdict = "skip"
            stars = None
        elif i % 11 == 0:
            # Later every 11th
            verdict = "later"
            stars = None
        else:
            # No verdict for rest (~60% of candidates remain unjudged)
            continue

        v = {"verdict": verdict}
        if stars is not None:
            v["stars"] = stars
        verdicts[cid] = v

    print(f"Created verdicts for {len(verdicts)} candidates")

    # Run the rank function
    ranked = curation.rank(candidates, verdicts)

    print(f"Ranked {len(ranked)} candidates")

    # Build fixture: candidates, verdicts, and expected ranked output
    fixture = {
        "candidates": candidates,
        "verdicts": verdicts,
        "expected": [
            {
                "id": r["id"],
                "rank": round(r["rank"], 4),
                "score": round(r["score"], 4),
                "why_ranked": r["why_ranked"],
                "later": r["later"],
            }
            for r in ranked
        ]
    }

    # Write fixture
    output_path = root / "crates" / "apricitus-data" / "tests" / "fixtures" / "rank.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(fixture, f, indent=2)

    print(f"Wrote fixture to {output_path}")
    print(f"Fixture contains {len(fixture['candidates'])} candidates, {len(fixture['expected'])} ranked results")

if __name__ == "__main__":
    main()
