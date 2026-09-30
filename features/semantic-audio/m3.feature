Feature: M3 Automatic browser hybrid search

  Scenario: Lexical results remain immediate
    Given an unloaded browser encoder and a nonempty audio query
    When the visitor types into existing search
    Then lexical matches keep their existing ordering while sound search waits for a 600 millisecond pause

  Scenario: Enter searches immediately
    Given a pending semantic debounce timer
    When the visitor presses Enter
    Then sound encoding starts without waiting for the timer

  Scenario: Lazy text-only model download
    Given no previous audio query
    When a nonempty audio query is made
    Then only the pinned quantized WASM text model loads with visible progress

  Scenario: Cache and storage failure
    Given a completed model download and a repeated query
    When persistent storage succeeds or is unavailable
    Then cached assets and vectors are reused when possible and text search remains usable

  Scenario: Section grouping and filters
    Given semantic clips and windows matching samples with section filters
    When Samples or Clips search is shown
    Then Samples expose best passages per parent and Clips show saved clips only with all existing filters

  Scenario: Clearing cancellation and stale responses
    Given two overlapping queries and a pending response
    When the query is cleared or navigation changes
    Then older timers inference and retrieval cannot repaint the page

  Scenario: Semantic failure isolation
    Given download inference storage or retrieval fails
    When the visitor continues lexical search and requests retry
    Then text results remain usable with a visible semantic retry state

  Scenario: First-use browser acceptance
    Given a fresh cache and the pinned approximately 127 MB text weights
    When browser acceptance runs
    Then download progress caching cold and warm timings are reported with no skipped gate counted as success
