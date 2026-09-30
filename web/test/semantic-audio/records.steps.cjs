const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const driver = path.join(root, "analysis/tests/test_semantic_records.py");

const scenarios = {
  "a v2 sidecar and current canonical sample clip recording and analysis metadata": "test_materializes_current_metadata_and_preserves_rename_revision",
  "a v2 saved clip sidecar whose canonical clip was renamed": "test_real_before_after_rename_keeps_identity_and_revision_and_refreshes_name",
  "v1 invalid vector stale grid ambiguous mapping retired and changed-boundary sidecars": "test_rejects_legacy_provenance_invalid_vectors_duration_and_stale_grid or test_alias_source_bounds_must_select_one_live_clip_and_parent_path_must_be_unique or test_saved_regions_exclude_missing_retired_or_changed_canonical_clips",
};

Given(/^(a v2 sidecar and current canonical sample clip recording and analysis metadata|a v2 saved clip sidecar whose canonical clip was renamed|v1 invalid vector stale grid ambiguous mapping retired and changed-boundary sidecars)$/, function (given) {
  this.recordsDriver = driver;
  this.recordsSelection = scenarios[given];
});

When("semantic records are materialized", function () {
  this.recordsResult = execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", this.recordsDriver, "-k", this.recordsSelection], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "analysis") }, encoding: "utf8" });
});

Then(/^(?:each record has its canonical identity current display playback revision and metadata timestamp|its semantic identity and revision remain stable while current clip display metadata is used|every noncurrent region is excluded with a structured reason and no identifier is invented)$/, function () {
  assert.match(this.recordsResult, /\d+ passed/);
  assert.doesNotMatch(this.recordsResult, /skipped/i);
});
