Feature: M5 Published cluster exploration and curator control

  Scenario: Bookmarkable published exploration
    Given published runs and draft runs
    When a visitor follows a run preset or cluster link
    Then only published current-visible members are shown and selections survive URL round trips

  Scenario: Leaderboard and member ordering
    Given clusters with distinct sample counts clip counts and ratings
    When the visitor switches leaderboard or member ordering
    Then distinct sample count is default and alternatives are deterministic with representatives first

  Scenario: Accessible map drill down
    Given an interactive sound map and keyboard-accessible member list
    When the visitor selects a cluster or passage
    Then playable details and parent links are accessible without requiring map interaction

  Scenario: Curator-only validated controls
    Given a public reader and a curator with invalid or valid parameters
    When a clustering job is requested or a draft is read
    Then public mutations and draft access are denied while valid curator jobs enter the queue

  Scenario: Offline queue and worker lease
    Given queued jobs and an offline or competing ground worker
    When workers claim or renew jobs
    Then offline jobs remain queued and only one valid lease owns processing

  Scenario: Retry and draft preview
    Given a failed job or a completed draft
    When a curator retries or previews it
    Then failure evidence is retained and preview does not replace the published run

  Scenario: Explicit atomic publication
    Given a reviewed complete draft and a previous published run
    When a curator publishes or publication fails
    Then successful publication updates the selected pointer atomically and failure preserves the previous run

  Scenario: Curator label overrides
    Given a traceable suggested label and a current draft revision
    When a curator sets a validated override
    Then the override retains suggestion provenance and stale revisions are rejected

  Scenario: Independent controlled rollout
    Given unverified semantic features and existing lexical search
    When rollout flags are disabled or approved independently
    Then lexical search remains available and coverage lag latency failures and job states are observable
