Feature: Score references
  Saving a score records which clips and slices it uses, as ScoreRef records (design/storage.md §1,
  §1.3 and §5), so "which scores use this clip or slice" is a query.

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-1", "title": "The Thunderer", "collection": "marine-band"}]
      """
    And these Clip records exist:
      """
      [
        {"id": "clp-1", "recordingId": "rec-1", "path": "marine-band/stems/Thunderer/drums.wav", "collection": "marine-band", "title": "Thunderer drums", "audio": {"key": "audio/clp-1/drums.wav", "sha256": "aa"}},
        {"id": "clp-2", "recordingId": "rec-1", "path": "marine-band/Thunderer.mp3", "collection": "marine-band", "title": "Thunderer", "audio": {"key": "audio/clp-2/Thunderer.mp3", "sha256": "bb"}}
      ]
      """
    And these Slice records exist:
      """
      [
        {"id": "slc-a", "clipId": "clp-1", "name": "loop-1", "start": 10, "end": 14, "source": "ml"},
        {"id": "slc-h", "clipId": "clp-2", "name": "hit-3",  "start": 19.8, "end": 20.3, "source": "ml"}
      ]
      """

  Scenario: Saving a score records its clip and slice references
    When I save score "score-1" with text:
      """
      tempo 90
      key C
      bars 1
      clip beat = marine-band/stems/Thunderer/drums.wav  slice loop-1
      track beat
      """
    Then the call succeeds
    And exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-1"}, "clipId": {"eq": "clp-1"}, "sliceId": {"eq": "slc-a"}, "start": {"eq": 10}, "end": {"eq": 14}}
      """

  Scenario: Drum-kit pads are references too
    When I save score "score-2" with text:
      """
      tempo 90
      key C
      bars 1
      clip band = marine-band/Thunderer.mp3
      kit drums
        crash = band  slice hit-3
      track drums  steps "crash . . ."
      """
    Then exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-2"}, "sliceId": {"eq": "slc-h"}}
      """

  Scenario: Saving again replaces the references
    Given I save score "score-1" with text:
      """
      tempo 90
      key C
      bars 1
      clip beat = marine-band/stems/Thunderer/drums.wav  slice loop-1
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
      {"scoreId": {"eq": "score-1"}, "clipId": {"eq": "clp-1"}}
      """
    And exactly 1 ScoreRef records match:
      """
      {"scoreId": {"eq": "score-1"}, "clipId": {"eq": "clp-2"}}
      """

  Scenario: A reference to a clip that isn't in the library is kept, unresolved
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
      {"scoreId": {"eq": "score-3"}, "clipPath": {"eq": "somewhere/else.wav"}, "clipId": {"attributeExists": false}}
      """
