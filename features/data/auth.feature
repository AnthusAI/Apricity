@auth
Feature: Authorization
  Catalog models (Recording, Sample, Candidate, Job) are readable by members and writable by curators.
  Personal models (Crate, CrateItem, Score, ScoreRef, Clip, Marker) belong to their owner and are
  readable by members; curators may also write clips and markers. A Verdict belongs to its judge.
  (design/storage.md §1 and §1.1.)

  Scenario: The owner is filled in from the caller
    Given I am user "alice" in groups "members"
    When I create a Crate with:
      """
      {"id": "crate-1", "name": "digs"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "crate-1", "owner": "<any>"}
      """

  Scenario: Members can read someone else's personal record
    Given I am user "alice" in groups "members"
    And these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs"}]
      """
    Given I am user "bob" in groups "members"
    When I get a Crate with key:
      """
      {"id": "crate-1"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "crate-1", "name": "digs"}
      """

  Scenario: Nobody else can change a personal record
    Given I am user "alice" in groups "members"
    And these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs"}]
      """
    Given I am user "bob" in groups "members"
    When I update a Crate with:
      """
      {"id": "crate-1", "name": "mine now"}
      """
    Then the error type is "Unauthorized"

  Scenario: Members read the catalog
    Given I am user "carla" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-1", "title": "The Thunderer", "collection": "marine-band"}]
      """
    Given I am user "bob" in groups "members"
    When I list all Recording with:
      """
      {}
      """
    Then data contains exactly these items in any order:
      """
      [{"id": "rec-1"}]
      """

  Scenario: Only curators write the catalog
    Given I am user "bob" in groups "members"
    When I create a Recording with:
      """
      {"id": "rec-2", "title": "El Capitan", "collection": "marine-band"}
      """
    Then the error type is "Unauthorized"

  Scenario: Someone in no group can't read the catalog
    Given I am user "dave" in groups ""
    When I list Recording with:
      """
      {}
      """
    Then the error type is "Unauthorized"

  Scenario: A verdict is created by its judge
    Given I am user "alice" in groups "members"
    When I create a Verdict with:
      """
      {"candidateId": "cand-1", "judge": "${me}", "verdict": "keep", "judgedAt": "2026-09-24T00:00:00.000Z"}
      """
    Then the call succeeds

  Scenario: Nobody can record a verdict for someone else
    Given I am user "alice" in groups "members"
    When I create a Verdict with:
      """
      {"candidateId": "cand-1", "judge": "${sub:bob}", "verdict": "keep", "judgedAt": "2026-09-24T00:00:00.000Z"}
      """
    Then the error type is "Unauthorized"
