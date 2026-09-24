Feature: Predefined sources
  The SDK downloads predefined public-domain sources into a samples directory, verifies them,
  and never leaves a half-written file behind.

  Background:
    Given a source "demo" with these files:
      | path            | content | fetch | sha256 |
      | demo/a.wav      | AAAA    | http  | ok     |
      | demo/b.wav      | BBBB    | http  |        |
      | demo/score.pdf  | PDF     | manual |       |

  Scenario: List sources
    When I list the sources
    Then the catalog has source "loc-edison" with 15 files
    And the catalog has source "loc-tony-schwartz" with 6 files
    And the catalog has source "marine-band" with 15 files
    And the catalog has 6 sources

  Scenario: Status of an empty directory
    When I check the status
    Then the status of "demo/a.wav" is missing
    And the status of "demo/b.wav" is missing

  Scenario: Status reports present and corrupt files
    Given the file "demo/a.wav" already contains "AAAA"
    And the file "demo/b.wav" already contains "BBBB"
    When I check the status
    Then the status of "demo/a.wav" is present
    And the status of "demo/b.wav" is present

  Scenario: A file failing its sha256 is corrupt
    Given the file "demo/a.wav" already contains "XXXX"
    When I check the status
    Then the status of "demo/a.wav" is corrupt

  Scenario: Fetch into an empty directory
    When I fetch the source
    Then the fetch succeeds
    And the file "demo/a.wav" exists with content "AAAA"
    And the file "demo/b.wav" exists with content "BBBB"
    And 2 files were downloaded
    And the report lists "demo/a.wav" as downloaded
    And no partial files remain

  Scenario: Fetching twice downloads nothing the second time
    Given I fetch the source
    When I fetch the source
    Then the fetch succeeds
    And 0 files were downloaded
    And the report lists "demo/a.wav" as skipped
    And the report lists "demo/b.wav" as skipped

  Scenario: A corrupt file is fetched again
    Given the file "demo/a.wav" already contains "XXXX"
    When I fetch the source
    Then the fetch succeeds
    And the file "demo/a.wav" exists with content "AAAA"
    And the report lists "demo/a.wav" as downloaded
    And the report lists "demo/b.wav" as downloaded

  Scenario: An interrupted download is ignored and overwritten
    Given a partial download "demo/a.wav" contains "AA"
    When I fetch the source
    Then the fetch succeeds
    And the file "demo/a.wav" exists with content "AAAA"
    And no partial files remain

  Scenario: A leftover partial file does not count as present
    Given a partial download "demo/a.wav" contains "AAAA"
    When I check the status
    Then the status of "demo/a.wav" is missing

  Scenario: A sha256 mismatch fails and leaves no final file
    Given the source "demo" serves wrong bytes for "demo/a.wav"
    When I fetch the source
    Then the fetch fails
    And the report lists "demo/a.wav" as failed
    And the file "demo/a.wav" does not exist
    And no partial files remain

  Scenario: A network error fails that file and is reported
    Given the server is unreachable for "demo/b.wav"
    When I fetch the source
    Then the fetch fails
    And the report lists "demo/b.wav" as failed
    And the report lists "demo/a.wav" as downloaded
    And the file "demo/b.wav" does not exist

  Scenario: Files without a sha256 are accepted and the digest is recorded
    When I fetch the source
    Then the report records a sha256 for "demo/b.wav"

  Scenario: Manual files are skipped and reported
    When I fetch the source
    Then the report lists "demo/score.pdf" as manual
    And the file "demo/score.pdf" does not exist
    And 2 files were downloaded

  Scenario: Progress events
    When I fetch the source
    Then the first progress event for "demo/a.wav" is started
    And the progress events include bytes for "demo/a.wav"
    And the progress events include finished for "demo/a.wav"
    And the progress events include manual for "demo/score.pdf"

  Scenario: Progress reports skipped files
    Given I fetch the source
    When I fetch the source
    Then the progress events include skipped for "demo/a.wav"

  Scenario: Remove deletes only that source's files
    Given I fetch the source
    And an unrelated file "other/keep.wav" exists
    When I remove the source
    Then the file "demo/a.wav" does not exist
    And the file "demo/b.wav" does not exist
    And the file "other/keep.wav" exists with content "unrelated"
