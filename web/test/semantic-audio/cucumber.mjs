export default {
  paths: ["../features/semantic-audio/*.feature"],
  import: ["test/semantic-audio/contract.steps.cjs", "test/semantic-audio/ground.steps.cjs", "test/semantic-audio/browser.steps.cjs", "test/semantic-audio/records.steps.cjs", "test/semantic-audio/publisher.steps.cjs", "test/semantic-audio/hybrid.steps.cjs", "test/semantic-audio/cluster-corpus.steps.cjs"],
  format: ["progress"],
};
