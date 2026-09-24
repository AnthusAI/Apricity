Feature: Error types
  Data errors come back in `errors` with AppSync's error types; they never crash a call.

  Background:
    Given I am user "alice" in groups "members,curators"

  Scenario: Creating an existing id is a conditional check failure
    Given these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs"}]
      """
    When I create a Crate with:
      """
      {"id": "crate-1", "name": "again"}
      """
    Then the error type is "DynamoDB:ConditionalCheckFailedException"
    And the error message contains "conditional"
    And data is null

  Scenario: Creating an existing composite key is a conditional check failure
    Given these Verdict records exist:
      """
      [{"candidateId": "cand-1", "judge": "${me}", "verdict": "keep", "judgedAt": "2026-09-24T00:00:00.000Z"}]
      """
    When I create a Verdict with:
      """
      {"candidateId": "cand-1", "judge": "${me}", "verdict": "skip", "judgedAt": "2026-09-24T01:00:00.000Z"}
      """
    Then the error type is "DynamoDB:ConditionalCheckFailedException"

  Scenario: Updating a missing record is a conditional check failure
    When I update a Crate with:
      """
      {"id": "no-such-crate", "name": "x"}
      """
    Then the error type is "DynamoDB:ConditionalCheckFailedException"

  Scenario: Deleting a missing record is a conditional check failure
    When I delete a Crate with key:
      """
      {"id": "no-such-crate"}
      """
    Then the error type is "DynamoDB:ConditionalCheckFailedException"

  Scenario: The record is unchanged after a failed create
    Given these Crate records exist:
      """
      [{"id": "crate-1", "name": "digs"}]
      """
    When I create a Crate with:
      """
      {"id": "crate-1", "name": "again"}
      """
    And I get a Crate with key:
      """
      {"id": "crate-1"}
      """
    Then data matches:
      """
      {"id": "crate-1", "name": "digs"}
      """
