// A curator asks for a voice line: the request is checked, then becomes a queued Job and a render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planRequest, DEFAULT_VOICE, MAX_TEXT } from "../amplify/functions/voice-request/request.ts";

const now = "2026-09-26T21:00:00.000Z";
const ok = (args: Record<string, unknown>) => planRequest({ args: { name: "intro", text: "Welcome to the show.", ...args }, requester: "alice", jobId: "job-1", now });

test("a valid request becomes a queued voice Job and a render input", () => {
  const plan = ok({ voice: "kokoro:am_adam", speed: 1.1 });
  assert.equal(plan.job.kind, "voice");
  assert.equal(plan.job.state, "queued");
  assert.deepEqual(JSON.parse(plan.job.input), { name: "intro", text: "Welcome to the show.", voice: "kokoro:am_adam", speed: 1.1, seed: null, requester: "alice" });
  // The renderer needs every key; speed and seed may be null.
  assert.deepEqual(plan.render, { jobId: "job-1", text: "Welcome to the show.", voice: "kokoro:am_adam", speed: 1.1, seed: null });
  assert.equal(plan.path, "voice/intro.wav");
});

test("the voice defaults to the house announcer", () => {
  assert.equal(ok({}).render.voice, DEFAULT_VOICE);
});

test("names are file-safe words", () => {
  for (const name of ["", "../etc", "has space", "x".repeat(65), "intro.wav"]) {
    assert.throws(() => ok({ name }), /name/, name);
  }
});

test("text must be there and not too long", () => {
  assert.throws(() => ok({ text: "   " }), /text/);
  assert.throws(() => ok({ text: "a".repeat(MAX_TEXT + 1) }), /text/);
});

test("only the deployed backend is accepted", () => {
  assert.throws(() => ok({ voice: "fish:narrator" }), /voice/);
  assert.throws(() => ok({ voice: "kokoro" }), /voice/);
});

test("speed stays in a sensible range", () => {
  assert.throws(() => ok({ speed: 0 }), /speed/);
  assert.throws(() => ok({ speed: 3 }), /speed/);
});
