const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
Given("current records and an interrupted publication checkpoint", function () { this.publisherCase = "interrupted_publication"; });
When("publication is repeated after interruption", function () {
  this.publisherOutput = execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", "analysis/tests/test_semantic_publisher.py", "-k", this.publisherCase], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "analysis") } });
});
Then("the current corpus contains each semantic identity once and coverage reports omissions", function () { assert.match(this.publisherOutput, /1 passed/); });
Given("published records for a deleted clip and an edited sample", function () { this.publisherCase = "test_explicit_scope_rejects_outside_rows_and_default_scope_retires_absent_old_sources"; });
When("publication reconciles the affected samples", function () {
  this.publisherOutput = execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", "analysis/tests/test_semantic_publisher.py", "-k", this.publisherCase], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "analysis") } });
});
Then("obsolete identities are retired without modifying unrelated samples", function () { assert.match(this.publisherOutput, /1 passed/); });
