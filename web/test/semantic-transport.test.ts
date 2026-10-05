import assert from "node:assert/strict";
import { test } from "node:test";

import { SemanticTransportError, createSemanticTransport } from "../src/data/semantic-transport.ts";

const response = () => new Response(JSON.stringify({ ok: true }));
const cloud = (overrides: Partial<Parameters<typeof createSemanticTransport>[0]> = {}) => createSemanticTransport({
  bootstrap: async () => {},
  semanticUrl: () => "https://semantic.example.test/semantic",
  mode: () => "cloud",
  fetchAuthSession: async () => ({ tokens: { accessToken: { toString: () => "fresh-access-token" } } }),
  fetch: async () => response(),
  origin: () => "https://app.example.test",
  ...overrides,
});

test("cloud semantic transport obtains the current access token for every request and sends it only to the configured service", async () => {
  let sessions = 0;
  const requests: Array<[string, RequestInit | undefined]> = [];
  const transport = cloud({
    fetchAuthSession: async () => ({ tokens: { accessToken: { toString: () => `access-${++sessions}` } } }),
    fetch: async (url, init) => { requests.push([String(url), init]); return response(); },
  });
  await transport.post("search", { query: "one" });
  await transport.post("related", { query: "two" });
  assert.equal(sessions, 2);
  assert.deepEqual(requests.map(([url]) => url), ["https://semantic.example.test/semantic/search", "https://semantic.example.test/semantic/related"]);
  assert.equal(new Headers(requests[0][1]?.headers).get("authorization"), "Bearer access-1");
  assert.equal(new Headers(requests[1][1]?.headers).get("authorization"), "Bearer access-2");
  assert.equal(requests[0][1]?.redirect, "error");
});

test("local semantic transport never reads a session or sends authorization", async () => {
  let sessions = 0;
  let init: RequestInit | undefined;
  const transport = cloud({ mode: () => "local", semanticUrl: () => "/semantic", fetchAuthSession: async () => { sessions++; return {}; }, fetch: async (_url, request) => { init = request; return response(); } });
  await transport.post("search", {});
  assert.equal(sessions, 0);
  assert.equal(new Headers(init?.headers).has("authorization"), false);
});

test("a signed-out request has no previous token and anonymous sessions omit authorization", async () => {
  let signedIn = true;
  const headers: string[] = [];
  const transport = cloud({ fetchAuthSession: async () => signedIn ? { tokens: { accessToken: { toString: () => "old-token" } } } : {}, fetch: async (_url, init) => { headers.push(new Headers(init?.headers).get("authorization") ?? ""); return response(); } });
  await transport.post("search", {});
  signedIn = false;
  await transport.post("search", {});
  assert.deepEqual(headers, ["Bearer old-token", ""]);
});

test("session failures are sanitized retryable failures and never make an anonymous cloud request", async () => {
  let calls = 0;
  const transport = cloud({ fetchAuthSession: async () => { throw new Error("Cognito internal hostname"); }, fetch: async () => { calls++; return response(); } });
  await assert.rejects(transport.post("search", {}), (error: unknown) => error instanceof SemanticTransportError && error.code === "semantic_auth_unavailable" && error.retryable && !error.message.includes("Cognito"));
  assert.equal(calls, 0);
});

test("cancellation before or during auth suppresses fetch", async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(cloud({ fetch: async () => { calls++; return response(); } }).post("search", {}, { signal: before.signal }), { name: "AbortError" });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const auth = new Promise<{ tokens: { accessToken: string } }>((resolve) => (release = () => resolve({ tokens: { accessToken: "token" } })));
  const after = new AbortController();
  const pending = cloud({ fetchAuthSession: async () => { entered(); return auth; }, fetch: async () => { calls++; return response(); } }).post("search", {}, { signal: after.signal });
  await started;
  after.abort(); release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 0);
});

test("unsafe cloud token destinations are rejected before fetch", async () => {
  let calls = 0;
  const unsafe = cloud({ semanticUrl: () => "http://other.example.test/semantic", fetch: async () => { calls++; return response(); } });
  await assert.rejects(unsafe.post("search", {}), (error: unknown) => error instanceof SemanticTransportError && error.code === "semantic_unavailable");
  assert.equal(calls, 0);
});
