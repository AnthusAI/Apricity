Feature: Stable clip names across markup re-runs
  markup::merge matches each newly proposed ML clip to an existing active ML clip of the same kind
  when their spans overlap by at least 0.8 (intersection over union). A match keeps its id and name.
  A new clip takes the next unused name from the sample's nameCounters; names are never reused. An old
  ML clip that is no longer proposed is retired if a score uses it and deleted otherwise. Clips
  made by people (source user or curated) are never touched. (design/storage.md §1.3.)

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-1", "title": "The Thunderer", "collection": "marine-band"}]
      """
    And these Sample records exist:
      """
      [{"id": "smp-1", "recordingId": "rec-1", "path": "marine-band/stems/Thunderer/drums.wav", "collection": "marine-band", "title": "Thunderer drums",
        "audio": {"key": "audio/smp-1/drums.wav", "sha256": "aa"}, "nameCounters": "{\"loop\": 1}"}]
      """
    And these Clip records exist:
      """
      [{"id": "clp-a", "sampleId": "smp-1", "name": "loop-1", "start": 10, "end": 14, "source": "ml", "kind": "loop", "rank": 1}]
      """

  Scenario: An overlapping proposal keeps the clip's id and name
    When I merge markup for sample "smp-1" with:
      """
      [{"kind": "loop", "start": 10.1, "end": 14, "rank": 1}]
      """
    Then the call succeeds
    And sample "smp-1" has these active clips:
      """
      [{"id": "clp-a", "name": "loop-1", "start": 10.1, "end": 14}]
      """

  Scenario: A new proposal gets a new name
    When I merge markup for sample "smp-1" with:
      """
      [{"kind": "loop", "start": 10, "end": 14, "rank": 2}, {"kind": "loop", "start": 30, "end": 34, "rank": 1}]
      """
    Then sample "smp-1" has these active clips:
      """
      [{"id": "clp-a", "name": "loop-1", "rank": 2}, {"name": "loop-2", "start": 30, "end": 34, "rank": 1}]
      """

  Scenario: Names are never reused
    Given I merge markup for sample "smp-1" with:
      """
      [{"kind": "loop", "start": 30, "end": 34}]
      """
    When I merge markup for sample "smp-1" with:
      """
      [{"kind": "loop", "start": 50, "end": 54}]
      """
    Then sample "smp-1" has these active clips:
      """
      [{"name": "loop-3", "start": 50, "end": 54}]
      """

  Scenario: A clip no longer proposed and not used by any score is deleted
    When I merge markup for sample "smp-1" with:
      """
      []
      """
    Then sample "smp-1" has these active clips:
      """
      []
      """
    And sample "smp-1" has these retired clips:
      """
      []
      """

  Scenario: A clip a score uses is retired, not deleted
    Given I save score "score-1" with text:
      """
      tempo 90
      key C
      bars 1
      clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
      track beat
      """
    When I merge markup for sample "smp-1" with:
      """
      []
      """
    Then sample "smp-1" has these retired clips:
      """
      [{"id": "clp-a", "name": "loop-1"}]
      """

  Scenario: Clips made by people are left alone
    Given these Clip records exist:
      """
      [{"id": "clp-u", "sampleId": "smp-1", "name": "mine", "start": 1, "end": 2, "source": "user"}]
      """
    When I merge markup for sample "smp-1" with:
      """
      []
      """
    Then sample "smp-1" has these active clips:
      """
      [{"id": "clp-u", "name": "mine"}]
      """
