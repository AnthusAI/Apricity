Feature: Score references
  Saving a score records which samples and clips it uses, as ScoreRef records (design/storage.md §1,
  §1.3 and §5), so "which scores use this sample or clip" is a query.

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-1", "title": "The Thunderer", "collection": "marine-band"}]
      """
    And these Sample records exist:
      """
      [
        {"id": "smp-1", "recordingId": "rec-1", "path": "marine-band/stems/Thunderer/drums.wav", "collection": "marine-band", "title": "Thunderer drums", "audio": {"key": "audio/smp-1/drums.wav", "sha256": "aa"}},
        {"id": "smp-2", "recordingId": "rec-1", "path": "marine-band/Thunderer.mp3", "collection": "marine-band", "title": "Thunderer", "audio": {"key": "audio/smp-2/Thunderer.mp3", "sha256": "bb"}}
      ]
      """
    And these Clip records exist:
      """
      [
        {"id": "clp-a", "sampleId": "smp-1", "name": "loop-1", "start": 10, "end": 14, "source": "ml"},
        {"id": "clp-h", "sampleId": "smp-2", "name": "hit-3",  "start": 19.8, "end": 20.3, "source": "ml"}
      ]
      """

  Scenario: Saving a score records its sample and clip references
    When I save score "score-1" with text:
      """
      tempo 90
      key C
      bars 1
      clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
      track beat
      """
    Then the call succeeds
    And exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-1"}, "sampleId": {"eq": "smp-1"}, "clipId": {"eq": "clp-a"}, "start": {"eq": 10}, "end": {"eq": 14}}
      """

  Scenario: Drum-kit pads are references too
    When I save score "score-2" with text:
      """
      tempo 90
      key C
      bars 1
      clip band = marine-band/Thunderer.mp3
      kit drums
        crash = band  hit-3
      track drums  steps "crash . . ."
      """
    Then exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-2"}, "clipId": {"eq": "clp-h"}}
      """

  Scenario: Saving again replaces the references
    Given I save score "score-1" with text:
      """
      tempo 90
      key C
      bars 1
      clip beat = marine-band/stems/Thunderer/drums.wav  loop-1
      track beat
      """
    When I save score "score-1" with text:
      """
      tempo 90
      key C
      bars 1
      clip whole = marine-band/Thunderer.mp3
      track whole
      """
    Then exactly 0 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-1"}, "sampleId": {"eq": "smp-1"}}
      """
    And exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-1"}, "sampleId": {"eq": "smp-2"}}
      """

  Scenario: A reference to a sample that isn't in the library is kept, unresolved
    When I save score "score-3" with text:
      """
      tempo 90
      key C
      bars 1
      clip x = somewhere/else.wav
      track x
      """
    Then the call succeeds
    And exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-3"}, "samplePath": {"eq": "somewhere/else.wav"}, "sampleId": {"attributeExists": false}}
      """
