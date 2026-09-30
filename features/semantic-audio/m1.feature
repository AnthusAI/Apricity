Feature: M1 Semantic publication and retrieval

  @m1_records
  Scenario: Materialize only current canonical semantic records
    Given a v2 sidecar and current canonical sample clip recording and analysis metadata
    When semantic records are materialized
    Then each record has its canonical identity current display playback revision and metadata timestamp

  @m1_records
  Scenario: Preserve identity through a clip rename
    Given a v2 saved clip sidecar whose canonical clip was renamed
    When semantic records are materialized
    Then its semantic identity and revision remain stable while current clip display metadata is used

  @m1_records
  Scenario: Exclude invalid or stale sidecar regions
    Given v1 invalid vector stale grid ambiguous mapping retired and changed-boundary sidecars
    When semantic records are materialized
    Then every noncurrent region is excluded with a structured reason and no identifier is invented

  Scenario: Idempotent resumable publication
    Given current records and an interrupted publication checkpoint
    When publication is repeated after interruption
    Then the current corpus contains each semantic identity once and coverage reports omissions

  Scenario: Retire obsolete source regions
    Given published records for a deleted clip and an edited sample
    When publication reconciles the affected samples
    Then obsolete identities are retired without modifying unrelated samples

  Scenario: Exact local search contract
    Given a unit query and fixed vectors in one embedding space
    When searchAudio is called without a limit
    Then up to 24 current hits are ordered by descending dot product with stable identity ties

  Scenario: Validate requests and isolate versions
    Given invalid vectors limits and incompatible embedding versions
    When searchAudio is called
    Then invalid requests are rejected and versions never mix

  Scenario: Bounded native cloud retrieval
    Given a configured DynamoDB vector index
    When cloud search retrieves up to 100 candidates
    Then SearchVectors is used without scanning the catalog or promising deep pagination

  Scenario: Current canonical guards
    Given indexed hits for retired hidden deleted or boundary-edited content
    When those hits are returned by the vector index
    Then the endpoint omits stale or inaccessible hits and refreshes display metadata

  Scenario: Approximate recall evidence
    Given an exact local baseline and an available or unavailable cloud sandbox
    When cloud recall evaluation runs
    Then measured recall is reported or missing sandbox fails the evaluation gate explicitly
