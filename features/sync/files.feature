Feature: Files store with ranged reads
  The `Files` trait (crates/apricity-data/src/files.rs) is the seam between `apricity serve`,
  the sync engine and any backing store: a folder (FsFiles) or an S3 bucket (S3Files). Keys are
  library-relative paths, so both stores hold the same key space. These scenarios are Rust tests
  in files.rs (FsFiles), s3.rs (S3Files against an in-process fake S3 endpoint) and serve.rs.

  Scenario: Ranged reads need no local path
    Given a store holding "audio/c1/a.wav" with 20 bytes
    When I read 4 bytes from offset 2
    Then I get bytes 2 through 5
    When I read 10 bytes from offset 15
    Then I get only the 5 bytes that exist
    When I read from offset 20 or beyond
    Then I get no bytes

  Scenario: Stat does not hash the file
    Given a store holding "audio/c1/a.wav"
    When I stat it
    Then I get its size and a change token without its content being read
    When I stat a key that does not exist
    Then I get nothing, not an error

  Scenario: Missing keys are not-found
    When I read a range of, get, or delete-with-check a key that does not exist
    Then the error is NotFound naming the key

  Scenario: Listing is by prefix
    Given keys "audio/a", "audio/b/c" and "Clip/c1.json"
    When I list "audio/"
    Then I get "audio/a" and "audio/b/c" with sizes, sorted, and nothing else

  Scenario: Keys cannot leave the store
    When I use a key with "..", an empty segment, a backslash or a leading slash
    Then the store refuses it and touches nothing

  Scenario: S3Files talks real S3 requests
    Given an S3 endpoint with a bucket and an optional key prefix
    Then put is a PUT of "<prefix>/<key>" carrying the content's sha256 as object metadata
    And a ranged read is a GET with a "Range: bytes=a-b" header for exactly that span
    And stat is a HEAD, delete is a DELETE, and list pages through ListObjectsV2 under the prefix
    And keys returned by list have the prefix removed
    And a missing key is NotFound, and stat of a missing key is nothing
    And credentials come from the standard AWS provider chain and are never logged
