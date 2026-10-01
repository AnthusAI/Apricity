const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

Given("a sample with diverse passage vectors", function () {
  this.relatedRankingCommand = ["--test", "--test-name-pattern", "selects up to four deterministic farthest-point", "amplify/semantic/related-service.test.ts"];
});
Given("multiple matching clips from multiple samples sharing recordings", function () {
  this.relatedRankingCommand = ["--test", "--test-name-pattern", "groups sample results by parent sample", "amplify/semantic/related-service.test.ts"];
});
When("sample related audio is requested", runRelatedRanking);
When("six related suggestions are selected", runRelatedRanking);
Then("at most four deterministic farthest-point representatives contribute candidates", assertFocusedPass);
Then("the source sample is excluded and strongest matches from distinct recordings appear first", assertFocusedPass);

function runRelatedRanking() {
  this.relatedRankingResult = execFileSync("npx", ["tsx", ...this.relatedRankingCommand], { cwd: path.join(root, "web"), encoding: "utf8" });
}
function assertFocusedPass() {
  assert.match(this.relatedRankingResult, /pass 1/);
  assert.doesNotMatch(this.relatedRankingResult, /@huggingface\/transformers|encoder/i);
}
