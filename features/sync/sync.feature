Feature: Library sync
  `apricity sync push|pull|status` keeps a library folder and a remote (an S3 bucket, or a
  folder with --remote-dir) identical, key for key. Keys are library-relative paths, so the bucket
  layout is the library layout. The engine is pure (crates/apricity-data/src/sync.rs) and is
  tested with two folders as local and remote; scripts/sync-smoke.sh drives the CLI end to end.

  Scenario: Only files that differ are transferred
    Given a library and an empty remote
    When I push
    Then every syncable file is uploaded and the remote tree matches byte for byte
    When I push again with nothing changed
    Then nothing is transferred
    When I change one file and add another and push
    Then exactly those two files are uploaded

  Scenario: Machine-local files never sync
    Given ".virtuus/lock", ".sync state", "apricity-library.json", upload scratch and ".DS_Store" files
    When I push or pull
    Then none of them is uploaded, downloaded, listed as a difference or deleted

  Scenario: Pull creates or updates a library
    Given a remote holding a library's files
    When I pull into a folder that is not yet a library
    Then it becomes a library holding every remote file, byte for byte
    And a pull verifies each file's sha256 before it replaces anything

  Scenario: Deletions need --delete
    Given a file was synced and then deleted locally
    When I push without --delete
    Then the remote file stays and the plan says the deletion was skipped
    When I push with --delete
    Then the remote file is deleted

  Scenario: Both sides changed is a conflict, never an overwrite
    Given a file changed on both sides since the last sync
    When I push or pull
    Then both copies are left untouched and the conflict is reported by key
    And the command exits with a failure status
    And a file added on both sides with different content is also a conflict
    When I run with --prefer local
    Then the local copy is pushed; with --prefer remote the remote copy is pulled

  Scenario: Status is a dry run
    When I ask for status or pass --dry-run
    Then the plan lists pushes, pulls, deletions and conflicts, and nothing is transferred or recorded

  Scenario: Last-sync state stays in the library
    Given a completed sync
    Then the library holds a state file recording each synced key's hash
    And that file is excluded from sync itself
