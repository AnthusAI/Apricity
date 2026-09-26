Feature: Generated samples and voice jobs
  A voice line rendered in the cloud (Auritus on AWS Batch) becomes a Sample with role "generated"
  that records how it was made, and the request that asked for it is a Job of kind "voice" carrying
  its input. Both are catalog models: members read them, curators write them.

  Background:
    Given I am user "alice" in groups "members,curators"
    And these Recording records exist:
      """
      [{"id": "rec-gen", "title": "Generated voice lines", "collection": "generated", "license": "cc0-1.0"}]
      """

  Scenario: A curator records a generated sample with its generator
    When I create a Sample with:
      """
      {"id": "smp-g1", "recordingId": "rec-gen", "path": "voice/intro.wav", "collection": "generated",
       "title": "intro", "role": "generated", "audio": {"key": "audio/smp-g1/intro.wav", "sha256": "ab"},
       "generator": "{\"engine\": \"auritus\", \"backend\": \"kokoro\", \"voice\": \"kokoro:am_adam\", \"text\": \"Welcome.\"}"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "smp-g1", "role": "generated", "generator": "<any>"}
      """

  Scenario: A voice job carries its request
    When I create a Job with:
      """
      {"id": "job-v1", "kind": "voice", "state": "queued",
       "input": "{\"name\": \"intro\", \"text\": \"Welcome.\", \"voice\": \"kokoro:am_adam\"}"}
      """
    Then the call succeeds
    And data matches:
      """
      {"id": "job-v1", "kind": "voice", "state": "queued", "input": "<any>"}
      """

  Scenario: Members can't request voice lines
    Given I am user "bob" in groups "members"
    When I create a Job with:
      """
      {"id": "job-v2", "kind": "voice", "state": "queued", "input": "{\"text\": \"Hi.\"}"}
      """
    Then the error type is "Unauthorized"
