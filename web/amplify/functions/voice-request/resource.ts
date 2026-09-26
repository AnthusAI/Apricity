import { defineFunction } from "@aws-amplify/backend";

// requestVoiceLine: queues a voice Job and starts its render on the SpeechRenderer (wired in
// backend.ts; the mutation is in data/resource.ts).
export const voiceRequest = defineFunction({
  name: "apricity-voice-request",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
  resourceGroupName: "data",
});
