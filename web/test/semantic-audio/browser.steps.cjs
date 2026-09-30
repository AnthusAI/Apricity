const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "../../..");
const evidence = () => JSON.parse(readFileSync(path.join(root, "fixtures/semantic-audio/browser-parity-fp32.json"), "utf8"));
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const top20 = (query, audio) => audio.map(({ semanticId, vector512 }) => ({ semanticId, score: dot(query, vector512) }))
  .sort((a, b) => b.score - a.score || a.semanticId.localeCompare(b.semanticId)).slice(0, 20).map((row) => row.semanticId);

Given("pinned browser and Python encoders with fixed prompts and reference vectors", function () {
  this.browserEvidence = evidence();
  assert.equal(this.browserEvidence.pinnedManifest.dtype, "fp32");
  assert.equal(this.browserEvidence.pinnedManifest.device, "wasm");
  assert.equal(this.browserEvidence.pinnedManifest.revision, "c28f2883575e590e04d3146ff0713c2448d691ba");
  assert.equal(this.browserEvidence.reference.metadata.checkpointRevision, "8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a");
});
When("the model-backed evaluation is requested", function () {
  const audio = this.browserEvidence.reference.audio;
  assert.ok(audio.length >= 40);
  assert.equal(new Set(audio.map((row) => row.semanticId)).size, audio.length);
  this.cosines = this.browserEvidence.desktop.prompts.map(({ prompt, browserVector512, browserTop20, pythonTop20 }, index) => {
    const reference = this.browserEvidence.reference.prompts[index];
    assert.equal(prompt, reference.text);
    const pythonVector512 = reference.vector512;
    for (const vector of [browserVector512, pythonVector512]) {
      assert.equal(vector.length, 512);
      assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector) - 1) <= 1e-4);
    }
    const webIds = top20(browserVector512, audio), pyIds = top20(pythonVector512, audio);
    assert.deepEqual(webIds, browserTop20);
    assert.deepEqual(pyIds, pythonTop20);
    return { prompt, cosine: dot(browserVector512, pythonVector512), retention: webIds.filter((id) => pyIds.includes(id)).length / 20 };
  });
});
Then("each cosine is at least 0.98 and average top-20 retention is at least 0.90", function () {
  const failures = this.cosines.filter((r) => r.cosine < .98);
  assert.deepEqual(failures, [], `Measured CLAP fp32 parity gate failed: ${JSON.stringify(failures)}`);
  assert.ok(this.cosines.reduce((sum, row) => sum + row.retention, 0) / this.cosines.length >= .90);
});

Given("a desktop and designated mobile device or an unavailable device", function () { this.browserEvidence = evidence(); });
When("warm encoding is evaluated", function () {
  const times = [...this.browserEvidence.desktop.warmMs].sort((a, b) => a - b);
  assert.equal(times.length, 20);
  assert.ok(times.every((v) => Number.isFinite(v) && v >= 0));
  this.desktopP95 = times[Math.ceil(times.length * .95) - 1];
  assert.equal(this.browserEvidence.mobile, undefined);
  // There is no complete desktop/mobile report: invoke the actual gate, not a fabricated successful measurement.
  const result = spawnSync(path.join(root, "web/node_modules/.bin/tsx"), ["scripts/semantic-eval.ts", "--report", "../fixtures/semantic-audio/browser-parity-fp32.json"], {
    cwd: path.join(root, "web"), encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  this.performanceGate = { ...JSON.parse(result.stdout.trim()), exitCode: result.status };
});
Then("measured p95 meets two and five seconds respectively or the gate reports not evaluated and fails", function () {
  assert.ok(this.desktopP95 <= 2000);
  assert.equal(this.performanceGate.status, "not_evaluated");
  assert.deepEqual(this.performanceGate.reasons, ["mobile measurement is not_evaluated"]);
  assert.notEqual(this.performanceGate.exitCode, 0);
  // This asserts truthful failure reporting, never approval of a missing mobile measurement.
});
