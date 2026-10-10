const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

Given("a clip with a valid stored vector", function () {
  this.relatedCommand = ["--test", "--test-name-pattern", "uses one actual stored source vector", "amplify/semantic/related-service.test.ts"];
});

When("its related audio is requested", function () {
  this.relatedResult = execFileSync("npx", ["tsx", ...this.relatedCommand], { cwd: path.join(root, "web"), encoding: "utf8" });
});

Then("sound matches are retrieved without loading any text encoder", function () {
  assert.match(this.relatedResult, /pass 1/);
  assert.doesNotMatch(this.relatedResult, /@huggingface\/transformers|encoder/i);
});
