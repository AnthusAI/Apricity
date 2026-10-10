const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");

Given("current records with aliases retired clips and incompatible versions", function () {
  this.clusterCorpusSelection = "test_snapshot_rechecks_current_parents_identity_revision_bounds_visibility_and_vectors or test_snapshot_deduplicates_saved_clip_and_aliases_with_traceable_parents_and_stable_digest or test_snapshot_excludes_every_valid_duplicate_semantic_id_without_representative_or_digest_input_order_dependence or test_snapshot_requires_window_analysis_source_and_current_window_revision";
});
When("a clustering snapshot is built", function () {
  this.clusterCorpusResult = execFileSync(path.join(root, "analysis/.venv/bin/python"), ["-m", "pytest", "analysis/tests/test_cluster_corpus.py", "-k", this.clusterCorpusSelection], {
    cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(root, "analysis") },
  });
});
Then("identical source regions are deduplicated with traceable alias membership and only one valid space", function () {
  assert.match(this.clusterCorpusResult, /4 passed/);
  assert.doesNotMatch(this.clusterCorpusResult, /skipped/i);
});
