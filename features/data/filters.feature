Feature: Filters
  Filter operators follow DynamoDB rules (design/storage.md §2.2): `contains` on a list checks
  membership, `ne` matches a missing field, and any other comparison against a missing field is false.

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Clip records exist:
      """
      [
        {"id": "s1", "sampleId": "smp-1", "name": "loop-1",  "start": 0,  "end": 4,   "source": "ml",      "kind": "loop",  "tags": ["brass", "low"]},
        {"id": "s2", "sampleId": "smp-1", "name": "loop-2",  "start": 4,  "end": 8,   "source": "ml",      "kind": "loop",  "tags": ["brass"]},
        {"id": "s3", "sampleId": "smp-1", "name": "hit-1",   "start": 8,  "end": 8.5, "source": "user",    "kind": "hit"},
        {"id": "s4", "sampleId": "smp-1", "name": "break-1", "start": 12, "end": 16,  "source": "curated", "kind": "break", "tags": ["drums"], "retired": true}
      ]
      """

  Scenario: eq
    When I list all Clip with:
      """
      {"filter": {"name": {"eq": "hit-1"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s3"}]
      """

  Scenario: ne on an enum
    When I list all Clip with:
      """
      {"filter": {"source": {"ne": "ml"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s3"}, {"id": "s4"}]
      """

  Scenario: ne matches records missing the field
    When I list all Clip with:
      """
      {"filter": {"retired": {"ne": true}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}]
      """

  Scenario: Comparisons against a missing field are false
    When I list all Clip with:
      """
      {"filter": {"rank": {"gt": 0}}}
      """
    Then data has 0 items

  Scenario Outline: Numeric comparisons
    When I list all Clip with:
      """
      {"filter": {"start": <condition>}}
      """
    Then data contains exactly these items in any order:
      """
      <expected>
      """

    Examples:
      | condition          | expected                                    |
      | {"lt": 4}          | [{"id": "s1"}]                              |
      | {"le": 4}          | [{"id": "s1"}, {"id": "s2"}]                |
      | {"gt": 8}          | [{"id": "s4"}]                              |
      | {"ge": 8}          | [{"id": "s3"}, {"id": "s4"}]                |
      | {"between": [4, 8]} | [{"id": "s2"}, {"id": "s3"}]               |

  Scenario: beginsWith
    When I list all Clip with:
      """
      {"filter": {"name": {"beginsWith": "loop"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s1"}, {"id": "s2"}]
      """

  Scenario: contains on a string is a substring match
    When I list all Clip with:
      """
      {"filter": {"name": {"contains": "oop"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s1"}, {"id": "s2"}]
      """

  Scenario: contains on a list is membership
    When I list all Clip with:
      """
      {"filter": {"tags": {"contains": "brass"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s1"}, {"id": "s2"}]
      """

  Scenario: notContains matches records missing the field
    When I list all Clip with:
      """
      {"filter": {"tags": {"notContains": "brass"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s3"}, {"id": "s4"}]
      """

  Scenario Outline: attributeExists
    When I list all Clip with:
      """
      {"filter": {"tags": {"attributeExists": <exists>}}}
      """
    Then data contains exactly these items in any order:
      """
      <expected>
      """

    Examples:
      | exists | expected                                     |
      | true   | [{"id": "s1"}, {"id": "s2"}, {"id": "s4"}]  |
      | false  | [{"id": "s3"}]                               |

  Scenario: size of a string
    When I list all Clip with:
      """
      {"filter": {"name": {"size": {"eq": 5}}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s3"}]
      """

  Scenario: and
    When I list all Clip with:
      """
      {"filter": {"and": [{"kind": {"eq": "loop"}}, {"start": {"ge": 4}}]}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s2"}]
      """

  Scenario: or
    When I list all Clip with:
      """
      {"filter": {"or": [{"kind": {"eq": "hit"}}, {"kind": {"eq": "break"}}]}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s3"}, {"id": "s4"}]
      """

  Scenario: not
    When I list all Clip with:
      """
      {"filter": {"not": {"kind": {"eq": "loop"}}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s3"}, {"id": "s4"}]
      """

  Scenario: Several fields in one filter are combined with and
    When I list all Clip with:
      """
      {"filter": {"kind": {"eq": "loop"}, "name": {"eq": "loop-2"}}}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "s2"}]
      """
