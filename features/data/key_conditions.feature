Feature: Index queries with key conditions
  An index query takes a partition value and an optional sort-key condition, and returns results in
  sort-key order (design/storage.md §2.2).

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Slice records exist:
      """
      [
        {"id": "s1", "clipId": "clp-1", "name": "loop-1",  "start": 0,  "end": 4,  "source": "ml"},
        {"id": "s2", "clipId": "clp-1", "name": "loop-2",  "start": 4,  "end": 8,  "source": "ml"},
        {"id": "s3", "clipId": "clp-1", "name": "hit-1",   "start": 8,  "end": 9,  "source": "ml"},
        {"id": "s4", "clipId": "clp-1", "name": "break-1", "start": 12, "end": 16, "source": "ml"},
        {"id": "s5", "clipId": "clp-2", "name": "loop-1",  "start": 2,  "end": 6,  "source": "ml"}
      ]
      """

  Scenario: Partition only, in ascending sort-key order
    When I query all Slice by slicesByClip with:
      """
      {"key": {"clipId": "clp-1"}}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}, {"id": "s4"}]
      """

  Scenario: Descending order
    When I query all Slice by slicesByClip with:
      """
      {"key": {"clipId": "clp-1"}, "sortDirection": "DESC"}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "s4"}, {"id": "s3"}, {"id": "s2"}, {"id": "s1"}]
      """

  Scenario Outline: Sort-key conditions
    When I query all Slice by slicesByClip with:
      """
      {"key": {"clipId": "clp-1", "start": <condition>}}
      """
    Then data contains exactly these items in this order:
      """
      <expected>
      """

    Examples:
      | condition           | expected                                      |
      | {"eq": 4}           | [{"id": "s2"}]                                |
      | {"lt": 8}           | [{"id": "s1"}, {"id": "s2"}]                  |
      | {"le": 8}           | [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}]    |
      | {"gt": 4}           | [{"id": "s3"}, {"id": "s4"}]                  |
      | {"ge": 4}           | [{"id": "s2"}, {"id": "s3"}, {"id": "s4"}]    |
      | {"between": [4, 8]} | [{"id": "s2"}, {"id": "s3"}]                  |

  Scenario: beginsWith on a string sort key
    When I query all Slice by slicesByClipAndName with:
      """
      {"key": {"clipId": "clp-1", "name": {"beginsWith": "loop"}}}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "s1"}, {"id": "s2"}]
      """

  Scenario: A filter on an index query
    When I query all Slice by slicesByClip with:
      """
      {"key": {"clipId": "clp-1"}, "filter": {"name": {"beginsWith": "loop"}}}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "s1"}, {"id": "s2"}]
      """

  Scenario: An index without a sort key
    Given these Clip records exist:
      """
      [
        {"id": "clp-1", "recordingId": "rec-1", "path": "marine-band/Thunderer.mp3", "collection": "marine-band", "title": "Thunderer", "audio": {"key": "audio/clp-1/Thunderer.mp3", "sha256": "aa"}},
        {"id": "clp-2", "recordingId": "rec-1", "path": "marine-band/stems/Thunderer/drums.wav", "collection": "marine-band", "title": "Thunderer drums", "audio": {"key": "audio/clp-2/drums.wav", "sha256": "bb"}}
      ]
      """
    When I query all Clip by clipsByPath with:
      """
      {"key": {"path": "marine-band/stems/Thunderer/drums.wav"}}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "clp-2", "title": "Thunderer drums"}]
      """
