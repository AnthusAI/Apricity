const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

Given("a completed clustering run and an existing published run", function () {
  this.clusterRunSelection = "";
});
When("run artifacts are saved or generated again", function () {
  this.clusterRunResult = execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", "analysis/tests/test_cluster_runs.py", "-vv"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "analysis") },
  });
});
Then("immutable draft artifacts retain their corpus and model manifest without changing publication", function () {
  assert.match(this.clusterRunResult, /test_save_leaves_published_pointer_sentinel_untouched PASSED/);
  assert.match(this.clusterRunResult, /passed/);
  assert.doesNotMatch(this.clusterRunResult, /(?:FAILED|ERROR)/);
  assert.doesNotMatch(this.clusterRunResult, /skipped/i);
});
