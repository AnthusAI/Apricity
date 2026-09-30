Feature: M0 Reliable embeddings and browser compatibility

  @m0_contract
  Scenario: Valid region identity
    Given a saved clip and a four-bar window from the same sample
    When their semantic records are prepared
    Then saved clips and windows have distinct stable identities with canonical parents and source boundaries

  @m0_ground
  Scenario: Freshness distinguishes rename from boundary edit
    Given current clip vectors and unchanged source audio
    When one clip is renamed and another clip boundary is changed
    Then only the boundary-edited vector is recomputed and display metadata is refreshed

  @m0_ground @model
  Scenario: Deterministic long input
    Given synthetic mono audio longer than ten seconds
    When ground analysis embeds the same region twice
    Then preprocessing is reproducible and valid normalized vectors are equivalent

  @m0_ground
  Scenario: Invalid vectors are reported
    Given missing zero nonfinite and incompatible embedding fixtures
    When analysis validates the corpus
    Then invalid records are excluded with explicit reasons

  @m0_browser_gate
  Scenario: Browser parity gate
    Given pinned browser and Python encoders with fixed prompts and reference vectors
    When the model-backed evaluation is requested
    Then each cosine is at least 0.98 and average top-20 retention is at least 0.90

  @m0_browser_evidence
  Scenario: Performance evidence is not fabricated
    Given a desktop and designated mobile device or an unavailable device
    When warm encoding is evaluated
    Then measured p95 meets two and five seconds respectively or the gate reports not evaluated and fails
