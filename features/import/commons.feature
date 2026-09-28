Feature: Wikimedia Commons audio sources
  Import direct members of the configured Commons categories only when the source page
  carries a supported license and all required attribution. Preserve the page revision
  and full source metadata for every accepted file.

  Scenario: Category discovery paginates direct file members and deduplicates overlap
    Given Commons categories contain a file across multiple pages and categories
    When I discover the configured Commons categories
    Then the result contains each direct file once
    And each file retains every category membership
    And subcategory members are not included

  Scenario: Supported audio has verified complete provenance
    Given a Commons audio file has CC BY-SA 4.0 metadata and an author
    When I qualify the Commons file
    Then it is eligible with the normalized license and attribution
    And its file page revision, raw metadata, and license statements are retained

  Scenario: Unsupported or incomplete rights are reported without importing audio
    Given a Commons file has an unsupported license or no required author
    When I qualify the Commons file
    Then it is excluded from the source catalog and production library
    And the review report includes the page and exclusion reason

  Scenario: Non-audio media is reported and excluded
    Given a Commons category member is a video container
    When I qualify the Commons file
    Then it is excluded from the source catalog and production library
    And the review report includes the page and exclusion reason

  Scenario: Accepted files download serially and resume by checksum
    Given an eligible Commons file has not been downloaded
    When I fetch the Commons source
    Then the audio is written atomically with a verified sha256
    And a repeated fetch skips the unchanged file
    And requests observe the configured delay and server retry guidance

  Scenario: Ogg audio is decoded for analysis and playback
    Given an eligible Commons source is encoded as Ogg Vorbis or Opus
    When Apricity analyzes and plays the sample
    Then the source decodes without conversion
    And the sample manifest and production record retain the original checksum and provenance
