const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
function run(action) {
  return JSON.parse(execFileSync(path.join(root, "analysis/.venv/bin/python"), [path.join(root, "analysis/tests/semantic_scenario_driver.py"), action], {
    encoding: "utf8", cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "analysis") },
    timeout: 120000,
  }).trim().split("\n").at(-1));
}
Given("current clip vectors and unchanged source audio", function () { this.semanticAction = "freshness"; });
When("one clip is renamed and another clip boundary is changed", function () { this.semanticObservation = run(this.semanticAction); });
Then("only the boundary-edited vector is recomputed and display metadata is refreshed", function () {
  const r = this.semanticObservation;
  assert.deepEqual(r.recomputedClipIds, ["a1"]);
  assert.equal(r.renamed, "a2-renamed");
  assert.equal(r.renamedVectorUnchanged, true);
  assert.equal(r.windowVectorUnchanged, true);
});
Given("synthetic mono audio longer than ten seconds", function () { this.semanticAction = "repeatability"; });
When("ground analysis embeds the same region twice", function () { this.semanticObservation = run(this.semanticAction); });
Then("preprocessing is reproducible and valid normalized vectors are equivalent", function () {
  const r = this.semanticObservation;
  assert.equal(r.status, "measured");
  assert.equal(r.dimensions, 512);
  assert.equal(r.finite, true);
  assert.equal(r.equivalent, true);
  assert.equal(r.cropFrames, 480000);
  assert.ok(r.norms.every((v) => Math.abs(v - 1) <= 1e-4));
});
Given("missing zero nonfinite and incompatible embedding fixtures", function () { this.semanticAction = "invalid"; });
When("analysis validates the corpus", function () { this.semanticObservation = run(this.semanticAction); });
Then("invalid records are excluded with explicit reasons", function () {
  const r = this.semanticObservation;
  assert.deepEqual(r.excluded, ["missing", "zero", "nonfinite", "wrong_dimension", "incompatible_space"]);
  assert.equal(r.incompatibleVectorReused, false);
  assert.ok(r.reports.includes("provenance_changed"));
});
