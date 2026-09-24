# Conformance step vocabulary (normative)

Every scenario in `features/data/` uses **only** the steps below. Three runners implement them
identically:
- Rust: cucumber-rs over `Engine::call` (`crates/apricity-data/tests/conformance.rs`);
- TypeScript: cucumber-js over the real `aws-amplify` client (`web/test/conformance/`);
- Python: behave over the `apricity_data` PyO3 module (domain steps).

Patterns are [Cucumber Expressions](https://github.com/cucumber/cucumber-expressions):
`{string}` is a double-quoted string, `{int}` an integer, and `{word}` a single word, used here for
model names and index `queryField`s. A step ending in `:` takes a JSON **docstring** (`"""` block).

Semantics follow `design/storage.md` §2.2.

## State kept by a runner

- **identity:** the current user (`sub`, `groups`).
- **result:** the outcome of the last call, `{ data, errors, nextToken }`. `errors` is `[]` on success. For `… all …` calls, `data` is every page's items concatenated, `nextToken` is `null` and `pages` is the number of calls made.
- **last call:** the last list or query call, so it can be repeated with a token.
- **remembered:** named values. In any JSON docstring or `{string}` argument, `${name}` is replaced with the remembered value before use. A whole JSON string `"${name}"` is replaced by the value itself, keeping its type.
  - Two names are predefined: `${me}` is the current identity's `sub`, and `${sub:<user>}` is the `sub` of the user named `<user>`, whether or not the scenario has switched to that user yet.
  - Locally a user's `sub` is its name. On AWS the runner signs in as a test account per user name, so the `sub` is that account's real Cognito sub. Scenarios that store a user id (Verdict `judge`, `owner`) must use these names, never a literal.

## Matching rules (for every `matches` / `contain` step)

- **Subset match:** an expected object matches an actual object when every expected key matches. Unlisted keys are ignored.
- **Markers:**
  - `"<any>"`: present and not null;
  - `"<absent>"`: missing or null;
  - `"<uuid>"`: a UUID;
  - `"<datetime>"`: an ISO-8601 timestamp.
- **Numbers** compare numerically: `1` equals `1.0`.
- **Arrays inside objects** match exactly: same length, element by element with subset match.

## Identity

| Step | Meaning |
|---|---|
| `Given I am user {string} in groups {string}` | Set identity `sub` to the first argument. Groups are comma-separated (`"members,curators"`); `""` means none. Later calls run as this user. |

## Model operations

`{word}` is a model name from the contract (`Crate`, `Slice`, `Verdict`, …). Each step replaces `result`.

| Step | Call (Amplify `client.models.<Model>` shape) |
|---|---|
| `When I create a {word} with:` | `create(<json>)` |
| `When I get a {word} with key:` | `get(<json identifier>)`, e.g. `{"id": "x"}` or `{"candidateId": "c", "judge": "u"}` |
| `When I get a {word} with:` | `get(<key>, { selectionSet })`: the JSON is `{"key": {...}, "selectionSet": ["id", "slices.*", "clip.title"]}` |
| `When I update a {word} with:` | `update(<json>)`: identifier fields plus the fields to change; `null` removes a field |
| `When I delete a {word} with key:` | `delete(<json identifier>)` |
| `When I list {word} with:` | `list(<json options>)`: `filter`, `limit`, `nextToken`, `selectionSet`. One page. |
| `When I list all {word} with:` | as above, repeated with each `nextToken` until it's `null`; see **result** |
| `When I query {word} by {word} with:` | `<Model>.<queryField>(<key>, <options>)`. The JSON is `{"key": {<partition field>: v, <sort field>?: <key condition>}, "filter"?, "limit"?, "sortDirection"?, "nextToken"?, "selectionSet"?}`. One page. |
| `When I query all {word} by {word} with:` | as above, until `nextToken` is `null` |
| `When I ask for the next page` | repeat the last list or query call with `nextToken` = result's `nextToken` |
| `When I ask for the next page with token {string}` | repeat the last list or query call with this token (e.g. a bogus one) |

## Fixtures

| Step | Meaning |
|---|---|
| `Given these {word} records exist:` | JSON **array**: `create` each item in order as the current identity. Any error fails the scenario immediately. |
| `Given I remember data field {string} as {string}` | Store the value at the dotted path (e.g. `"id"`, `"items.0.id"`) of result's `data` under a name. |

## Assertions

| Step | Meaning |
|---|---|
| `Then the call succeeds` | `errors` is empty |
| `Then the call fails` | `errors` is non-empty. Use it where AppSync's exact `errorType` is still unconfirmed; task T31 pins these down against the sandbox. |
| `Then the error type is {string}` | `errors[0].errorType` equals it (e.g. `"DynamoDB:ConditionalCheckFailedException"`, `"Unauthorized"`, `"ValidationException"`) |
| `Then the error message contains {string}` | `errors[0].message` contains it (case-insensitive) |
| `Then data is null` | `data` is `null` |
| `Then data matches:` | `data` (an object) subset-matches the JSON object |
| `Then data has {int} items` | `data` is a list of exactly N items |
| `Then data contains exactly these items in any order:` | `data` is a list of the same length as the JSON array, and each expected item subset-matches a distinct actual item |
| `Then data contains exactly these items in this order:` | same length, and item *i* subset-matches expected item *i* |
| `Then data field {string} has {int} items` | the value at the dotted path is a list of exactly N items (e.g. `"slices.items"`) |
| `Then data field {string} is {string}` | the value at the dotted path, compared as a string (numbers and booleans stringified; `null` becomes `"null"`) |
| `Then there is a next token` | `nextToken` is a non-empty string |
| `Then there is no next token` | `nextToken` is `null` |
| `Then {int} pages were fetched` | for `… all …` calls: the number of calls made |
| `Then exactly {int} {word} records match:` | `list all <Model>` with the JSON as `filter` (as a fully privileged checker identity, sub `"checker"`, all groups) returns exactly N items |

## Domain operations

These go through the domain layer (`apricity-data::domain` in Rust and Python, `web/src/data/domain.ts` in TypeScript), not raw model calls. Each sets `result` to `{ data, errors }`.

| Step | Meaning |
|---|---|
| `When I keep candidate {string} with:` | `judge(candidateId, "keep", <json: stars?, tags?, name?, crates?: [names]>)` |
| `When I skip candidate {string}` | `judge(candidateId, "skip")` |
| `When I put off candidate {string}` | `judge(candidateId, "later")` |
| `When I merge markup for clip {string} with:` | `markup::merge(clipId, <json array of proposed ML slices: {kind, start, end, rank?, evidence?}>)` |
| `When I save score {string} with text:` | `save_score(scoreId, <docstring: the .apr text, not JSON>)`; creates the Score if missing and rebuilds its ScoreRefs |
| `Then clip {string} has these active slices:` | the clip's slices with `retired` not true, via `slicesByClip`, subset-match the JSON array in `start` order |
| `Then clip {string} has these retired slices:` | the same for `retired: true` |
