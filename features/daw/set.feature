Feature: Export an editable Live 11 arrangement
  As a musician, I want my score exported as a Live set so that I can edit its clips and harmony.

  Scenario: Export arrangement and musical settings
    Given a synthetic four-bar score
    When I export the score
    Then the export succeeds
    And the set contains four editable arrangement clips at the score positions
    And the set preserves tempo meter and loop
    And the clips preserve warp pitch detune and gain
    And the set has chord change locators
    And the project collects the sample with a portable reference

  Scenario: Export is deterministic
    Given a synthetic four-bar score
    When I export the score twice to the same destination
    Then the export succeeds
    And the set bytes are identical

  Scenario: Distinct samples with the same filename are collected safely
    Given a score with two different samples named alike
    When I export the score
    Then the export succeeds
    And both different sample files are collected and referenced

  Scenario: Reference samples without collecting
    Given a synthetic four-bar score
    When I export the score without collecting
    Then the export succeeds
    And the set references the original sample without copying it

  Scenario: Refuse an existing destination without force
    Given a synthetic four-bar score
    And an existing destination
    When I export the score
    Then the export fails with a destination diagnostic
    And the existing destination is unchanged

  Scenario: A missing source does not destroy an existing destination even with force
    Given a synthetic four-bar score
    And an existing destination
    And the source sample is missing
    When I export the score with force
    Then the export fails with a missing source diagnostic
    And the existing destination is unchanged

  Scenario: Unsupported events identify their context
    Given a synthetic four-bar score with a reversed event
    When I export the score
    Then the export fails with an unsupported event diagnostic naming the track

  Scenario: Preserve a non-default meter and only mark chord changes
    Given a three-beat score with a repeated chord
    When I export the score
    Then the export succeeds
    And the set preserves three-beat meter and chord changes

  Scenario: Choose a default set destination
    Given a synthetic four-bar score
    When I export the score without an output option
    Then the export succeeds
    And a set exists in the working directory

  Scenario: Choose an output folder
    Given a synthetic four-bar score
    When I export the score to an output folder
    Then the export succeeds
    And a set exists in the output folder
