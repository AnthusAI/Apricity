Feature: M4 Versioned ground audio clusters

  Scenario: Corpus source-region deduplication
    Given current records with aliases retired clips and incompatible versions
    When a clustering snapshot is built
    Then identical source regions are deduplicated with traceable alias membership and only one valid space

  Scenario: Accepted reproducible presets
    Given the same snapshot and one of the three accepted presets
    When clustering is run twice
    Then effective parameters provenance membership and outliers are reproducible

  Scenario: Small corpus remains unclustered
    Given fewer than five valid regions
    When clustering is requested
    Then all regions are explicitly unclustered without invalid reduction settings

  Scenario: Independent display projection
    Given a clustering run and its source vectors
    When the display map is generated
    Then two-dimensional positions do not replace high-dimensional clustering or listening evidence

  Scenario: Representative summaries and label provenance
    Given cluster members from multiple recordings and the versioned concept vocabulary
    When cluster summaries are generated
    Then normalized centroids diverse playable representatives and traceable suggested labels are produced

  Scenario: Immutable draft runs
    Given a completed clustering run and an existing published run
    When run artifacts are saved or generated again
    Then immutable draft artifacts retain their corpus and model manifest without changing publication

  Scenario: Listening quality gate
    Given representative passages and an absent or completed listening review
    When cluster quality is evaluated
    Then listening judgments are recorded or quality remains explicitly unapproved
