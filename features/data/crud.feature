Feature: Create, get, update and delete
  Amplify-shaped model operations behave the same on every backend (design/storage.md §2.2).

  Background:
    Given I am user "alice" in groups "members,curators"

  Scenario: Create fills in a generated id and timestamps
    When I create a Crate with:
      """
      {"name": "digs"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "<uuid>", "name": "digs", "owner": "<any>", "createdAt": "<datetime>", "updatedAt": "<datetime>"}
      """

  Scenario: A generated id can be used to get the record
    When I create a Crate with:
      """
      {"name": "digs"}
      """
    Given I remember data field "id" as "new-crate"
    When I get a Crate with key:
      """
      {"id": "${new-crate}"}
      """
    Then data matches:
      """
      {"id": "${new-crate}", "name": "digs"}
      """

  Scenario: Create with a given id, then get it
    Given these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs", "note": "horns"}]
      """
    When I get a Crate with key:
      """
      {"id": "crate-1"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "crate-1", "name": "digs", "note": "horns"}
      """

  Scenario: Getting a missing record returns null, not an error
    When I get a Crate with key:
      """
      {"id": "no-such-crate"}
      """
    Then the call succeeds
    And data is null

  Scenario: Update changes only the given fields
    Given these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs", "note": "horns"}]
      """
    When I update a Crate with:
      """
      {"id": "crate-1", "name": "breaks"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "crate-1", "name": "breaks", "note": "horns", "updatedAt": "<datetime>"}
      """

  Scenario: Updating a field to null removes it
    Given these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs", "note": "horns"}]
      """
    When I update a Crate with:
      """
      {"id": "crate-1", "note": null}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "crate-1", "name": "digs", "note": "<absent>"}
      """

  Scenario: Delete returns the deleted record, which is then gone
    Given these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs"}]
      """
    When I delete a Crate with key:
      """
      {"id": "crate-1"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "crate-1", "name": "digs"}
      """
    When I get a Crate with key:
      """
      {"id": "crate-1"}
      """
    Then data is null

  Scenario: Composite identifiers
    Given these Verdict records exist:
      """
      [{"candidateId": "cand-1", "judge": "${me}", "verdict": "keep", "stars": 4, "judgedAt": "2026-09-24T00:00:00.000Z"}]
      """
    When I get a Verdict with key:
      """
      {"candidateId": "cand-1", "judge": "${me}"}
      """
    Then the call succeeds
    And data matches:
      """
      {"candidateId": "cand-1", "judge": "${me}", "verdict": "keep", "stars": 4}
      """

  Scenario: A required field is enforced
    When I create a Recording with:
      """
      {"id": "rec-1", "collection": "marine-band"}
      """
    Then the call fails

  Scenario: An enum field only takes its values
    When I create a Clip with:
      """
      {"id": "clp-1", "sampleId": "smp-1", "name": "loop-1", "start": 0, "end": 4, "source": "robot"}
      """
    Then the call fails
