const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

function run(selection) {
  return execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", "analysis/tests/test_audio_clusters.py", "-k", selection], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "analysis") },
  });
}

Given("the same snapshot and one of the three accepted presets", function () { this.clusterSelection = "accepted_presets or actual_algorithm"; });
When("clustering is run twice", function () { this.clusterResult = run(this.clusterSelection); });
Then("effective parameters provenance membership and outliers are reproducible", function () { assert.match(this.clusterResult, /4 passed/); });

Given("fewer than five valid regions", function () { this.clusterSelection = "small_corpus or actual_algorithm"; });
When("clustering is requested", function () { this.clusterResult = run(this.clusterSelection); });
Then("all regions are explicitly unclustered without invalid reduction settings", function () { assert.match(this.clusterResult, /2 passed/); });

Given("a clustering run and its source vectors", function () { this.clusterSelection = "accepted_presets or actual_algorithm"; });
When("the display map is generated", function () { this.clusterResult = run(this.clusterSelection); });
Then("two-dimensional positions do not replace high-dimensional clustering or listening evidence", function () { assert.match(this.clusterResult, /4 passed/); });
