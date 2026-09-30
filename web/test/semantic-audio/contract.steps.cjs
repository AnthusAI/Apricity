const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

Given("a saved clip and a four-bar window from the same sample", function () {
  const parent = {
    sample_id: "smp_A", recording_id: "rec_R1", start: 0, end: 8,
    audio_sha256: "a".repeat(64), embedding_space: "clap-htsat-unfused-512-v1",
    processing_fingerprint: "preprocess-v1",
  };
  this.regions = [
    { ...parent, kind: "saved_clip", clip_id: "clp_a1" },
    { ...parent, kind: "window", clip_id: null },
  ];
});

When("their semantic records are prepared", function () {
  const code = [
    "import json,sys",
    "from apricity_analyze.semantic_contract import SemanticIdentity",
    "regions=[SemanticIdentity(**r) for r in json.load(sys.stdin)]",
    "print(json.dumps([dict(semanticId=r.semantic_id,sampleId=r.sample_id,recordingId=r.recording_id,kind=r.kind,clipId=r.clip_id,start=r.start,end=r.end) for r in regions]))",
  ].join("\n");
  const call = () => JSON.parse(execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-c", code], {
    input: JSON.stringify(this.regions), encoding: "utf8", cwd: root,
    env: { ...process.env, PYTHONPATH: path.join(root, "analysis") },
  }));
  this.prepared = call();
  this.repeated = call();
});

Then("saved clips and windows have distinct stable identities with canonical parents and source boundaries", function () {
  assert.deepEqual(this.prepared, this.repeated);
  assert.notEqual(this.prepared[0].semanticId, this.prepared[1].semanticId);
  for (const record of this.prepared) {
    assert.match(record.semanticId, /^[0-9a-f]{64}$/);
    assert.equal(record.sampleId, "smp_A");
    assert.equal(record.recordingId, "rec_R1");
    assert.equal(record.start, 0);
    assert.equal(record.end, 8);
  }
  assert.equal(this.prepared[0].clipId, "clp_a1");
  assert.equal(this.prepared[1].clipId, null);
});
