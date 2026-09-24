/**
 * Cucumber configuration for conformance tests
 */

// Build tags filter: always exclude @realtime, exclude @sandbox if running locally
const target = process.env.TARGET || "local";
const isLocal = target === "local";
const tagsFilter = isLocal ? "not @realtime and not @sandbox" : "not @realtime";

export default {
  requireModule: ["tsx/esm"],
  require: ["test/conformance/hooks.ts", "test/conformance/steps.ts"],
  paths: ["../features/data/**/*.feature"],
  format: ["progress-bar", "json:test/conformance/cucumber-report.json"],
  parallel: 1,
  tags: tagsFilter,
};
