Feature: Relationships and selection sets
  hasMany fields return a connection (`items`, `nextToken`) read through the child's index;
  belongsTo fields return the parent object (design/storage.md §2.2).

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-1", "title": "The Thunderer", "collection": "marine-band"}]
      """
    And these Clip records exist:
      """
      [
        {"id": "clp-1", "recordingId": "rec-1", "path": "marine-band/Thunderer.mp3", "collection": "marine-band", "title": "Thunderer", "audio": {"key": "audio/clp-1/Thunderer.mp3", "sha256": "aa"}},
        {"id": "clp-2", "recordingId": "rec-1", "path": "marine-band/stems/Thunderer/drums.wav", "collection": "marine-band", "title": "Thunderer drums", "audio": {"key": "audio/clp-2/drums.wav", "sha256": "bb"}}
      ]
      """
    And these Slice records exist:
      """
      [
        {"id": "s1", "clipId": "clp-1", "name": "loop-1", "start": 0, "end": 4,  "source": "ml"},
        {"id": "s2", "clipId": "clp-1", "name": "loop-2", "start": 4, "end": 8,  "source": "ml"},
        {"id": "s3", "clipId": "clp-1", "name": "hit-1",  "start": 8, "end": 9,  "source": "ml"}
      ]
      """

  Scenario: A hasMany connection through the child's index
    When I get a Clip with:
      """
      {"key": {"id": "clp-1"}, "selectionSet": ["id", "title", "slices.*"]}
      """
    Then the call succeeds
    And data field "title" is "Thunderer"
    And data field "slices.items" has 3 items
    And data field "slices.items.0.name" is "loop-1"

  Scenario: An empty hasMany connection
    When I get a Clip with:
      """
      {"key": {"id": "clp-2"}, "selectionSet": ["id", "slices.*"]}
      """
    Then data field "slices.items" has 0 items

  Scenario: A belongsTo field returns the parent
    When I get a Slice with:
      """
      {"key": {"id": "s2"}, "selectionSet": ["id", "name", "clip.title"]}
      """
    Then data field "name" is "loop-2"
    And data field "clip.title" is "Thunderer"

  Scenario: Two levels deep
    When I get a Slice with:
      """
      {"key": {"id": "s1"}, "selectionSet": ["id", "clip.recording.title"]}
      """
    Then data field "clip.recording.title" is "The Thunderer"

  Scenario: A selection set on a list
    When I list all Slice with:
      """
      {"filter": {"clipId": {"eq": "clp-1"}}, "selectionSet": ["id", "clip.title"]}
      """
    Then data contains exactly these items in any order:
      """
      [
        {"id": "s1", "clip": {"title": "Thunderer"}},
        {"id": "s2", "clip": {"title": "Thunderer"}},
        {"id": "s3", "clip": {"title": "Thunderer"}}
      ]
      """
