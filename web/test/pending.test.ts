import { test } from "node:test";
import assert from "node:assert/strict";

import { AudioFailure, once, Pending, reasonOf, withTimeout } from "../src/audio/pending.ts";

test("a dead renderer fails every wait with its reason", async () => {
  const p = new Pending<string, void>();
  const a = p.wait("0|a.wav");
  const b = p.wait("1|a.wav");
  p.resolve("0|a.wav", undefined);
  await a;
  p.failAll(new AudioFailure("an audio renderer stopped: out of memory"));
  await assert.rejects(b, /renderer stopped: out of memory/);
  assert.equal(p.size, 0);
  p.reject("nobody", new Error("x")); // a stale key does nothing
});

test("a failed load is forgotten, so the next try loads again", async () => {
  const cache = new Map<string, Promise<number>>();
  let calls = 0;
  const load = () => once(cache, "horns.wav", async () => (++calls === 1 ? Promise.reject(new AudioFailure("couldn't load horns.wav (404)")) : 7));
  await assert.rejects(load(), /404/);
  await Promise.resolve(); // the eviction runs on the rejection
  assert.equal(cache.has("horns.wav"), false);
  assert.equal(await load(), 7);
  assert.equal(await load(), 7, "a success stays cached");
  assert.equal(calls, 2);
});

test("nothing waits forever", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "starting the audio engine"), /starting the audio engine took too long/);
  assert.equal(await withTimeout(Promise.resolve(3), 20, "x"), 3);
  assert.equal(reasonOf(new Error(" boom ")), "boom");
  assert.equal(reasonOf(undefined), "something went wrong");
});
