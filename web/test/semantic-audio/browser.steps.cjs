const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const evidence = () => JSON.parse(readFileSync(path.join(root, "fixtures/semantic-audio/browser-parity-preflight.json"), "utf8"));

Given("pinned browser and Python encoders with fixed prompts and reference vectors", function () {
  this.browserEvidence = evidence();
  assert.equal(this.browserEvidence.dtype, "q8");
  assert.equal(this.browserEvidence.device, "wasm");
  assert.equal(this.browserEvidence.tokenizerIdsAndMasksMatch, true);
});
When("the model-backed evaluation is requested", function () {
  this.cosines = this.browserEvidence.prompts.map(({ prompt, browserVector512, pythonVector512 }) => {
    for (const vector of [browserVector512, pythonVector512]) {
      assert.equal(vector.length, 512);
      assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector) - 1) <= 1e-4);
    }
    return { prompt, cosine: browserVector512.reduce((sum, value, i) => sum + value * pythonVector512[i], 0) };
  });
});
Then("each cosine is at least 0.98 and average top-20 retention is at least 0.90", function () {
  const failures = this.cosines.filter((r) => r.cosine < .98);
  assert.deepEqual(failures, [], `Measured CLAP q8 parity gate failed: ${JSON.stringify(failures)}`);
  assert.equal(this.browserEvidence.top20Status, "measured", "Top-20 retention is not_evaluated; it cannot pass by omission");
  assert.ok(this.browserEvidence.meanTop20Retention >= .90);
});

Given("a desktop and designated mobile device or an unavailable device", function () { this.browserEvidence = evidence(); });
When("warm encoding is evaluated", function () {
  const times = [...this.browserEvidence.warmMs].sort((a, b) => a - b);
  assert.equal(times.length, 20);
  assert.ok(times.every((v) => Number.isFinite(v) && v >= 0));
  this.desktopP95 = times[Math.ceil(times.length * .95) - 1];
  assert.equal(this.browserEvidence.mobileStatus, "not_evaluated");
  // There is no complete desktop/mobile report: invoke the actual gate, not a fabricated successful measurement.
  const result = spawnSync(path.join(root, "web/node_modules/.bin/tsx"), ["scripts/semantic-eval.ts"], {
    cwd: path.join(root, "web"), encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  this.performanceGate = { ...JSON.parse(result.stdout.trim()), exitCode: result.status };
});
Then("measured p95 meets two and five seconds respectively or the gate reports not evaluated and fails", function () {
  assert.ok(this.desktopP95 <= 2000);
  assert.equal(this.performanceGate.status, "not_evaluated");
  assert.notEqual(this.performanceGate.exitCode, 0);
  // This asserts truthful failure reporting, never approval of a missing mobile measurement.
});
