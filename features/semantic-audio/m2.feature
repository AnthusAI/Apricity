Feature: M2 Related samples and clips

  Scenario: Clip related audio uses stored vectors
    Given a clip with a valid stored vector
    When its related audio is requested
    Then sound matches are retrieved without loading any text encoder

  Scenario: Sample representative selection
    Given a sample with diverse passage vectors
    When sample related audio is requested
    Then at most four deterministic farthest-point representatives contribute candidates

  Scenario: Diverse best-passage ranking
    Given multiple matching clips from multiple samples sharing recordings
    When six related suggestions are selected
    Then the source sample is excluded and strongest matches from distinct recordings appear first

  Scenario: Related playback boundaries
    Given a related saved clip or unsaved window
    When the visitor auditions the suggestion
    Then playback uses the exact matched source time range with a parent sample link

  Scenario: Related states remain truthful
    Given missing embeddings empty matches or a retrieval failure
    When the related list is opened
    Then awaiting analysis empty or retry states are shown without confidence percentages

  Scenario: Navigation discards stale related responses
    Given a pending related request for one detail page
    When the visitor navigates to another detail page
    Then the older response cannot repaint the new page
