Feature: Judging candidates
  keep / skip / later through the domain layer (design/storage.md §1.4, §3.2). Judging is idempotent.
  A curated clip is shared catalog material created by the first keep; stars and tags live on each
  person's verdict.

  Background:
    Given I am user "carla" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-1", "title": "The Thunderer", "collection": "marine-band"}]
      """
    And these Sample records exist:
      """
      [{"id": "smp-1", "recordingId": "rec-1", "path": "marine-band/Thunderer.mp3", "collection": "marine-band", "title": "Thunderer", "audio": {"key": "audio/smp-1/Thunderer.mp3", "sha256": "aa"}}]
      """
    And these Candidate records exist:
      """
      [{"id": "cand-1", "sampleId": "smp-1", "recordingId": "rec-1", "start": 10, "end": 14, "kind": "loop", "name": "loop-cand",
        "proposers": [{"by": "analyzer:markup/loops", "score": 0.9, "why": "loops cleanly", "at": "2026-09-24T00:00:00.000Z"}], "baseScore": 0.9}]
      """
    Given I am user "alice" in groups "members,curators"

  Scenario: Keeping creates a verdict, a curated clip and a crate item
    When I keep candidate "cand-1" with:
      """
      {"stars": 4, "tags": ["brass"], "name": "horn-loop", "crates": ["digs"]}
      """
    Then the call succeeds
    And exactly 1 Verdict records match:
      """
      {"candidateId": {"eq": "cand-1"}, "verdict": {"eq": "keep"}, "stars": {"eq": 4}}
      """
    And exactly 1 Clip records match:
      """
      {"candidateId": {"eq": "cand-1"}, "source": {"eq": "curated"}}
      """
    And exactly 1 CrateItem records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """
    And sample "smp-1" has these active clips:
      """
      [{"name": "horn-loop", "start": 10, "end": 14, "source": "curated", "candidateId": "cand-1"}]
      """

  Scenario: Keeping twice changes nothing
    When I keep candidate "cand-1" with:
      """
      {"stars": 4, "crates": ["digs"]}
      """
    And I keep candidate "cand-1" with:
      """
      {"stars": 4, "crates": ["digs"]}
      """
    Then the call succeeds
    And exactly 1 Verdict records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """
    And exactly 1 Clip records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """
    And exactly 1 CrateItem records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """

  Scenario: Skipping after keeping removes the curated clip
    When I keep candidate "cand-1" with:
      """
      {"crates": ["digs"]}
      """
    And I skip candidate "cand-1"
    Then the call succeeds
    And exactly 1 Verdict records match:
      """
      {"candidateId": {"eq": "cand-1"}, "verdict": {"eq": "skip"}}
      """
    And exactly 0 Clip records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """
    And exactly 0 CrateItem records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """

  Scenario: A skip keeps the clip while someone else still keeps it
    When I keep candidate "cand-1" with:
      """
      {}
      """
    Given I am user "bob" in groups "members,curators"
    When I keep candidate "cand-1" with:
      """
      {}
      """
    Given I am user "alice" in groups "members,curators"
    When I skip candidate "cand-1"
    Then exactly 1 Clip records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """
    And exactly 2 Verdict records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """

  Scenario: Putting off records a verdict and no clip
    When I put off candidate "cand-1"
    Then the call succeeds
    And exactly 1 Verdict records match:
      """
      {"candidateId": {"eq": "cand-1"}, "verdict": {"eq": "later"}}
      """
    And exactly 0 Clip records match:
      """
      {"candidateId": {"eq": "cand-1"}}
      """

  Scenario: Keeping an unknown candidate fails
    When I keep candidate "no-such-candidate" with:
      """
      {}
      """
    Then the call fails
