export default {
  paths: ["../features/semantic-audio/*.feature"],
  import: ["test/semantic-audio/contract.steps.cjs", "test/semantic-audio/ground.steps.cjs", "test/semantic-audio/browser.steps.cjs"],
  format: ["progress"],
};
