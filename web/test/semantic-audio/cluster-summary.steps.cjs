const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

Given("cluster members from multiple recordings and the versioned concept vocabulary", function () {
  this.clusterSummarySelection = "";
});
When("cluster summaries are generated", function () {
  this.clusterSummaryResult = execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", "analysis/tests/test_cluster_summaries.py", "-k", this.clusterSummarySelection], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "analysis") },
  });
});
Then("normalized centroids diverse playable representatives and traceable suggested labels are produced", function () {
  assert.match(this.clusterSummaryResult, /30 passed/);
  assert.doesNotMatch(this.clusterSummaryResult, /skipped/i);
});
