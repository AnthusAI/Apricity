import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { Jwks } from "aws-jwt-verify/jwk";
import { createCognitoTokenVerifier } from "./auth";
import { createSemanticHttpHandler } from "./http-handler";
import type { SemanticSearchResponse } from "../../src/semantic/contracts";

const body = JSON.stringify({ queryVector: Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0), embeddingSpace: "clap-htsat-unfused-512-v1" });
const calls: Array<{ name: string; context: unknown }> = [];
const handler = createSemanticHttpHandler({
  search: { search: async (_body, context) => { calls.push({ name: "search", context }); return { hits: [], embeddingSpace: "clap-htsat-unfused-512-v1", candidateCount: 0, filteredCount: 0 }; } },
  related: { related: async (_body, context) => { calls.push({ name: "related", context }); return { state: "awaiting_analysis", hits: [] }; } },
  verifier: { verify: async () => ({ curator: true }) },
  allowedOrigins: ["https://app.example"], searchEnabled: true, relatedEnabled: true,
});

test("uses a fixed CORS preflight allowlist", async () => {
  const allowed = await handler(event("OPTIONS", "/semantic/search", undefined, "https://app.example", { "access-control-request-method": "POST", "access-control-request-headers": "Content-Type, Authorization" }));
  assert.equal(allowed.statusCode, 204); assert.equal(allowed.headers["access-control-allow-methods"], "POST, OPTIONS"); assert.equal(allowed.headers["access-control-allow-headers"], "Content-Type, Authorization");
  assert.equal((await handler(event("OPTIONS", "/semantic/search", undefined, "https://app.example", { "access-control-request-method": "DELETE" }))).statusCode, 403);
  const denied = await handler(event("OPTIONS", "/semantic/search", undefined, "https://evil.example"));
  assert.equal(denied.statusCode, 403); assert.equal(denied.headers["access-control-allow-origin"], undefined);
});

test("rejects each request gate before authentication or a domain service", async () => {
  const cases: Array<[ReturnType<typeof event>, number]> = [
    [event("POST", "/unknown", "{}"), 404], [event("GET", "/semantic/search", "{}"), 405],
    [event("POST", "/semantic/search", "{}", undefined, { "content-type": "text/plain" }), 415],
    [event("POST", "/semantic/search", "{", undefined, { "content-type": "application/json" }), 400],
    [event("POST", "/semantic/search", "x", undefined, { "content-type": "application/json" }, true), 400],
    [event("POST", "/semantic/search", Buffer.from([0xc3, 0x28]).toString("base64"), undefined, { "content-type": "application/json" }, true), 400],
    [event("POST", "/semantic/search", Buffer.from(" ".repeat(64 * 1024)).toString("base64"), undefined, { "content-type": "application/json" }, true), 400],
    [event("POST", "/semantic/search", Buffer.from(" ".repeat(64 * 1024 + 1)).toString("base64"), undefined, { "content-type": "application/json" }, true), 413],
  ];
  for (const [request, status] of cases) assert.equal((await handler(request)).statusCode, status);
  assert.equal(calls.length, 0);
});

test("disabled operations are terminal even for a bearer token", async () => {
  let verificationCalls = 0, serviceCalls = 0;
  const disabled = createSemanticHttpHandler({ ...baseDeps(), verifier: { verify: async () => { verificationCalls += 1; return { curator: false }; } }, search: { search: async () => { serviceCalls += 1; return ok(); } }, searchEnabled: false });
  assert.equal((await disabled(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json", authorization: "Bearer a.b.c" }))).statusCode, 503);
  assert.equal(verificationCalls, 0); assert.equal(serviceCalls, 0);
});

test("malformed authorization is 401 without guest downgrade, and following guests stay guests", async () => {
  const before = calls.length;
  assert.equal((await handler(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json", authorization: "Basic nope" }))).statusCode, 401);
  assert.equal(calls.length, before);
  assert.equal((await handler(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json" }))).statusCode, 200);
  assert.deepEqual(calls.pop()?.context, { curator: false });
});

test("passes a genuinely RSA-signed bearer request through the handler", async (t) => {
  const now = Date.UTC(2002, 0, 1), issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example", clientId = "semantic-client";
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "key", use: "sig", alg: "RS256" };
  const verifier = createCognitoTokenVerifier({ userPoolId: "us-east-1_example", clientId, jwks: { keys: [jwk] } as Jwks });
  const signed = jwt({ iss: issuer, client_id: clientId, token_use: "access", exp: now / 1000 + 60, "cognito:groups": ["admins"] }, keys.privateKey);
  const real = createSemanticHttpHandler({ ...baseDeps(), verifier, search: { search: async (_request, context) => ({ ...ok(), curator: (context as { curator: boolean }).curator } as never) }, searchEnabled: true });
  t.mock.method(Date, "now", () => now);
  const response = await real(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json", authorization: `Bearer ${signed}` }));
  assert.equal(response.statusCode, 200); assert.deepEqual(JSON.parse(response.body!), { ...ok(), curator: true });
});

test("never serializes vectors and sanitizes unrecognized service failures", async () => {
  for (const leaked of [{ vector: [1] }, { sourceVector: [1] }, { queryVector: [1] }]) {
    const unsafe = createSemanticHttpHandler({ ...baseDeps(), search: { search: async () => ({ ...ok(), leaked } as never) }, searchEnabled: true });
    assert.equal((await unsafe(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json" }))).statusCode, 503);
  }
  const unknown = createSemanticHttpHandler({ ...baseDeps(), search: { search: async () => { throw { status: 400, code: "secret_error", retryable: false }; } }, searchEnabled: true });
  const response = await unknown(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json" }));
  assert.equal(response.statusCode, 503); assert.deepEqual(JSON.parse(response.body!), { error: { code: "semantic_unavailable", retryable: true } });
});

test("returns only the three exact domain failures", async () => {
  for (const [failure, status] of [
    [{ status: 400, code: "semantic_request_invalid", retryable: false }, 400],
    [{ status: 409, code: "semantic_space_unsupported", retryable: false }, 409],
    [{ status: 503, code: "semantic_unavailable", retryable: true }, 503],
  ] as const) {
    const domain = createSemanticHttpHandler({ ...baseDeps(), search: { search: async () => { throw failure; } }, searchEnabled: true });
    const response = await domain(event("POST", "/semantic/search", body, undefined, { "content-type": "application/json" }));
    assert.equal(response.statusCode, status); assert.deepEqual(JSON.parse(response.body!), { error: { code: failure.code, retryable: failure.retryable } });
  }
});

function ok(): SemanticSearchResponse { return { hits: [], embeddingSpace: "clap-htsat-unfused-512-v1", candidateCount: 0, filteredCount: 0 }; }
function baseDeps() { return { search: { search: async () => { throw Object.assign(new Error(), { status: 409, code: "semantic_space_unsupported", retryable: false }); } }, related: { related: async () => ({ state: "awaiting_analysis" as const, hits: [] }) }, verifier: { verify: async () => ({ curator: false }) }, allowedOrigins: ["https://app.example"], relatedEnabled: true }; }
function event(method: string, path: string, body?: string, origin?: string, headers: Record<string, string> = {}, isBase64Encoded = false) { return { version: "2.0", rawPath: path, requestContext: { http: { method } }, headers: { ...headers, ...(origin ? { origin } : {}) }, body, isBase64Encoded }; }
function jwt(payload: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string { const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key", typ: "JWT" })).toString("base64url"), encoded = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${header}.${encoded}.${sign("RSA-SHA256", Buffer.from(`${header}.${encoded}`), privateKey).toString("base64url")}`; }
