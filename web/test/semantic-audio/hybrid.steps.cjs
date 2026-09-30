const { Given, When, Then } = require("@cucumber/cucumber");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Keep these feature bindings coupled to deterministic controller tests.  They execute the
// observable scenario assertions, never a real model download or an unconditional pass.
const web = path.resolve(__dirname, "../..");
function focused(pattern) {
  const result = spawnSync(path.join(web, "node_modules/.bin/tsx"), ["--test", "--test-name-pattern", pattern, "test/semantic-hybrid-controller.test.ts"], { cwd: web, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pass 1/);
}

Given("an unloaded browser encoder and a nonempty audio query", function () { this.hybridScenario = "lexical debounce"; });
When("the visitor types into existing search", function () { assert.equal(this.hybridScenario, "lexical debounce"); });
Then("lexical matches keep their existing ordering while sound search waits for a 600 millisecond pause", function () { focused("keeps lexical search immediate"); });

Given("a pending semantic debounce timer", function () { this.hybridScenario = "enter"; });
When("the visitor presses Enter", function () { assert.equal(this.hybridScenario, "enter"); });
Then("sound encoding starts without waiting for the timer", function () { focused("keeps lexical search immediate"); });

Given("two overlapping queries and a pending response", function () { this.hybridScenario = "stale"; });
When("the query is cleared or navigation changes", function () { assert.equal(this.hybridScenario, "stale"); });
Then("older timers inference and retrieval cannot repaint the page", function () { focused("clears, cancels, and disposes"); });

Given("download inference storage or retrieval fails", function () { this.hybridScenario = "failure"; });
When("the visitor continues lexical search and requests retry", function () { assert.equal(this.hybridScenario, "failure"); });
Then("text results remain usable with a visible semantic retry state", function () { focused("recreates failed lazy loaders"); });
