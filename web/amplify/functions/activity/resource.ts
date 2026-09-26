import { defineFunction } from "@aws-amplify/backend";

// Keeps the Activity page: one card per item, moved up by anything new about it (streams on the Score, Sample, Clip,
// Rating and Comment tables; wired in backend.ts).
export const activity = defineFunction({
  name: "apricity-activity",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 256,
  resourceGroupName: "data",
});
