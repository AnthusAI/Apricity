Feature: Pagination
  `limit` caps how many records are *read*, and the filter applies afterwards, as in DynamoDB. A page
  can be short or even empty while a next token remains. Callers loop until there is no next token
  (design/storage.md §2.2). Index queries are used where page contents must be deterministic.

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Clip records exist:
      """
      [
        {"id": "p0", "sampleId": "smp-1", "name": "a", "start": 0, "end": 1, "source": "ml"},
        {"id": "p1", "sampleId": "smp-1", "name": "b", "start": 1, "end": 2, "source": "ml"},
        {"id": "p2", "sampleId": "smp-1", "name": "a", "start": 2, "end": 3, "source": "ml"},
        {"id": "p3", "sampleId": "smp-1", "name": "b", "start": 3, "end": 4, "source": "ml"},
        {"id": "p4", "sampleId": "smp-1", "name": "a", "start": 4, "end": 5, "source": "ml"}
      ]
      """

  Scenario: The limit applies before the filter
    When I query Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "filter": {"name": {"eq": "a"}}, "limit": 2}
      """
    Then the call succeeds
    And data contains exactly these items in this order:
      """
      [{"id": "p0"}]
      """
    And there is a next token

  Scenario: Collecting every page returns every match
    When I query all Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "filter": {"name": {"eq": "a"}}, "limit": 2}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "p0"}, {"id": "p2"}, {"id": "p4"}]
      """
    And there is no next token

  Scenario: A page can be empty while a next token remains
    When I query Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "filter": {"name": {"eq": "a"}}, "limit": 1}
      """
    And I ask for the next page
    Then data has 0 items
    And there is a next token

  Scenario: Paging with next tokens, page by page
    When I query Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "limit": 2}
      """
    Then data contains exactly these items in this order:
      """
      [{"id": "p0"}, {"id": "p1"}]
      """
    And there is a next token
    When I ask for the next page
    Then data contains exactly these items in this order:
      """
      [{"id": "p2"}, {"id": "p3"}]
      """
    When I ask for the next page
    Then data contains exactly these items in this order:
      """
      [{"id": "p4"}]
      """
    And there is no next token

  Scenario: A full last page still returns a next token, and one more call ends it
    When I query all Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "limit": 5}
      """
    Then data has 5 items
    And 2 pages were fetched

  Scenario: Pages continue after the last key even when records are added
    When I query Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "limit": 2}
      """
    Given these Clip records exist:
      """
      [{"id": "p05", "sampleId": "smp-1", "name": "a", "start": 0.5, "end": 1, "source": "ml"}]
      """
    When I ask for the next page
    Then data contains exactly these items in this order:
      """
      [{"id": "p2"}, {"id": "p3"}]
      """

  Scenario: A list collects across pages
    When I list all Clip with:
      """
      {"limit": 2}
      """
    Then data has 5 items
    And there is no next token

  Scenario: A bogus token is rejected
    When I query Clip by clipsBySample with:
      """
      {"key": {"sampleId": "smp-1"}, "limit": 2}
      """
    And I ask for the next page with token "not-a-real-token"
    Then the call fails
