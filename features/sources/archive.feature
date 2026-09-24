Feature: Archive sources
  A source can be one downloaded archive (tar.bz2) whose listed files are extracted under the samples
  directory. The archive is verified, extracted through a staging area, and deleted afterwards.

  Background:
    Given an archive source "kit" with these files:
      | path             | content |
      | kit/OH/kick.wav  | KICK    |
      | kit/OH/snare.wav | SNARE   |
      | kit/ALL.sfz      | SFZ     |

  Scenario: Fetch downloads the archive and extracts the listed files
    When I fetch the source
    Then the fetch succeeds
    And the file "kit/OH/kick.wav" exists with content "KICK"
    And the file "kit/OH/snare.wav" exists with content "SNARE"
    And the file "kit/ALL.sfz" exists with content "SFZ"
    And 1 files were downloaded
    And the report lists "kit/OH/kick.wav" as downloaded
    And the report records a sha256 for "kit/OH/kick.wav"

  Scenario: The archive is deleted after a successful fetch
    When I fetch the source
    Then the file "kit/.archive.part" does not exist
    And no partial files remain
    And no staging directory remains

  Scenario: Fetching twice downloads nothing the second time
    Given I fetch the source
    When I fetch the source
    Then the fetch succeeds
    And 0 files were downloaded
    And the report lists "kit/OH/kick.wav" as skipped
    And the report lists "kit/ALL.sfz" as skipped

  Scenario: A corrupt extracted file is repaired and the rest are kept
    Given I fetch the source
    And the file "kit/OH/kick.wav" already contains "XXXX"
    When I fetch the source
    Then the fetch succeeds
    And 1 files were downloaded
    And the file "kit/OH/kick.wav" exists with content "KICK"
    And the report lists "kit/OH/kick.wav" as downloaded
    And the report lists "kit/OH/snare.wav" as skipped

  Scenario: Status works on the extracted files
    Given I fetch the source
    And the file "kit/ALL.sfz" already contains "XXXX"
    When I check the status
    Then the status of "kit/OH/kick.wav" is present
    And the status of "kit/ALL.sfz" is corrupt

  Scenario: An archive with the wrong sha256 fails and leaves nothing
    Given the archive "kit" is served with wrong bytes
    When I fetch the source
    Then the fetch fails
    And the report lists "kit/OH/kick.wav" as failed
    And the file "kit/OH/kick.wav" does not exist
    And nothing exists under "kit"

  Scenario: An archive entry that escapes the root is rejected
    Given the archive "kit" also contains the entry "../evil.txt"
    When I fetch the source
    Then the fetch fails
    And the report lists "kit/OH/kick.wav" as failed
    And the file "evil.txt" does not exist
    And the file "kit/OH/kick.wav" does not exist
    And nothing exists under "kit"

  Scenario: An archive symlink entry is rejected
    Given the archive "kit" also contains a symlink "OH/link"
    When I fetch the source
    Then the fetch fails
    And nothing exists under "kit"

  Scenario: A listed file missing from the archive fails
    Given the archive "kit" lacks the entry "OH/snare.wav"
    When I fetch the source
    Then the fetch fails
    And nothing exists under "kit"

  Scenario: Remove deletes the extracted files only
    Given I fetch the source
    And an unrelated file "kit/mine.txt" exists
    When I remove the source
    Then the file "kit/OH/kick.wav" does not exist
    And the file "kit/ALL.sfz" does not exist
    And the file "kit/mine.txt" exists with content "unrelated"

  Scenario: Progress events cover the download and the extraction
    When I fetch the source
    Then the first progress event for "kit/.archive.part" is started
    And the progress events include bytes for "kit/.archive.part"
    And the progress events include finished for "kit/.archive.part"
    And the progress events include extracting for "kit/.archive.part"
    And the progress events include finished for "kit/OH/kick.wav"

  Scenario: The catalog lists the Salamander Drumkit
    When I list the sources
    Then the catalog has source "salamander-drumkit" with 545 files
    And the source "salamander-drumkit" is an archive extracted into "salamander-drumkit"
    And the catalog has 6 sources
