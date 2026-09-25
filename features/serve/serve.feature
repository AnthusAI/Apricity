Feature: apricity serve
  A local server exposes one library to the web app over HTTP on 127.0.0.1
  (design/storage.md section 4). These scenarios are implemented as Rust tests in
  crates/apricity-cli/src/serve.rs and exercised end to end by scripts/serve-smoke.sh.

  Scenario: GraphQL needs the library's API key
    When I POST "/graphql" without an x-api-key header
    Then the status is 401
    When I POST "/graphql" with the library's API key and a listClips query
    Then the status is 200 and the response holds the library's clips

  Scenario: amplify_outputs.json describes the library
    When I GET "/amplify_outputs.json"
    Then data.url is this server's /graphql, data.api_key is the library's key
    And data.default_authorization_type is "API_KEY" and data.model_introspection is the contract's
    And custom.apricity.mode is "local" and there is no auth or storage section

  Scenario: Files are served whole or by byte range
    Given the file "audio/c1/a.wav" exists in the library
    When I GET "/files/audio/c1/a.wav" with "Range: bytes=2-5"
    Then the status is 206 with "Content-Range: bytes 2-5/<size>" and those 4 bytes
    When I GET it with a range starting past the end, an inverted range, or several ranges
    Then the status is 416 with "Content-Range: bytes */<size>"
    When I HEAD it
    Then I get its Content-Length and Accept-Ranges, and no body

  Scenario: Files can be written and removed
    When I PUT "/files/documents/r1/x.pdf" with a body
    Then the status is 201 and a GET returns the body
    When I DELETE it
    Then the status is 204 and a GET is 404

  Scenario: File keys cannot escape the library
    When I request a "/files/" key containing ".." or a backslash
    Then the status is 400 and nothing outside files/ is read or written

  Scenario: The web app is served with cross-origin isolation
    Given web/dist exists
    When I GET "/"
    Then I get index.html with Cross-Origin-Opener-Policy same-origin, Cross-Origin-Embedder-Policy require-corp and Cross-Origin-Resource-Policy same-origin
    Given web/dist does not exist
    Then GET "/" is a 404 that says the app is not built

  Scenario: Files are served from any Files store, not only a folder
    Given the library's files live in a store that has no local path (such as S3)
    When I GET, HEAD, PUT or DELETE "/files/<key>", with or without a Range header
    Then the answers are the same as for a folder, using only the store's stat and ranged read
