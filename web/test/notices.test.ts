import { test } from "node:test";
import assert from "node:assert/strict";

import { Notices, notices, reportError } from "../src/ui/notices.ts";
import { isNetworkError, listAll, retryDelays, SignedOut } from "../src/data/catalog.ts";

test("notices: the same message counts instead of stacking; dismissing removes it", () => {
  const n = new Notices();
  let changes = 0;
  n.onChange(() => changes++);
  const a = n.add("Couldn't load the ratings: network error");
  n.add("Couldn't load the ratings: network error");
  n.add("Couldn't draw a waveform");
  assert.deepEqual(n.list.map((x) => [x.message, x.count]), [["Couldn't load the ratings: network error", 2], ["Couldn't draw a waveform", 1]]);
  n.dismiss(a);
  assert.equal(n.list.length, 1);
  assert.equal(changes, 4);
});

test("reportError says what and why, and stays quiet when you're only signed out", () => {
  const before = notices.list.length;
  reportError("load your rating", new SignedOut());
  assert.equal(notices.list.length, before);
  reportError("load your rating", new Error("network error"));
  assert.equal(notices.list.at(-1)!.message, "Couldn't load your rating: network error");
});

test("a page that fails on the network is tried twice more; other failures fail at once", async () => {
  retryDelays.ms = [0, 0];
  let calls = 0;
  const flaky = async () => (++calls < 3 ? Promise.reject(new TypeError("Failed to fetch")) : { data: [1, 2], nextToken: null });
  assert.deepEqual(await listAll(flaky), [1, 2]);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(listAll(async () => (++calls, Promise.reject(new TypeError("Failed to fetch")))), /Failed to fetch/);
  assert.equal(calls, 3, "three tries, then the error");
  calls = 0;
  await assert.rejects(listAll(async () => (++calls, Promise.reject(Object.assign(new Error("No current user"), { name: "NoValidAuthTokens" })))), SignedOut);
  assert.equal(calls, 1, "signed out: no retry");
  assert.equal(isNetworkError(new Error("GraphQL error: bad input")), false);
});
