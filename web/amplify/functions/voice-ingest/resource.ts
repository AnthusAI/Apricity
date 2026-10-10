import { defineFunction } from "@aws-amplify/backend";

// Turns a finished voice render into a generated Sample with phrase clips, or records why it failed
// (EventBridge status changes of the SpeechRenderer state machine; wired in backend.ts).
export const voiceIngest = defineFunction({
  name: "apricity-voice-ingest",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
