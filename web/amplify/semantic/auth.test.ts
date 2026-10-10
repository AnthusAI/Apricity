import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { FetchError } from "aws-jwt-verify/error";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import type { Jwks } from "aws-jwt-verify/jwk";
import { authenticate, createCognitoTokenVerifier } from "./auth";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example";
const clientId = "semantic-client";
const now = Date.UTC(2001, 0, 1) / 1000;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "offline-test-key", use: "sig", alg: "RS256" } as const;
const verifier = createCognitoTokenVerifier({ userPoolId: "us-east-1_example", clientId, jwks: { keys: [jwk] } as Jwks });

test("cryptographically verifies offline-JWKS Cognito access tokens and enforces NumericDate boundaries", async (t) => {
  freezeNow(t, now);
  assert.deepEqual(await authenticate(`Bearer ${token({ "cognito:groups": ["curators"], exp: now + 1, nbf: now })}`, verifier), { curator: true });
  assert.deepEqual(await authenticate(`Bearer ${token({ "cognito:groups": ["members"], exp: now + 1, nbf: now })}`, verifier), { curator: false });
  assert.deepEqual(await authenticate(`Bearer ${token({ exp: now + 0.5, nbf: now })}`, verifier), { curator: false });
  await assert.rejects(authenticate(`Bearer ${token({ exp: now, nbf: now })}`, verifier), { code: "invalid_token" });
  await assert.rejects(authenticate(`Bearer ${token({ exp: now - 1 })}`, verifier), { code: "invalid_token" });
  await assert.rejects(authenticate(`Bearer ${token({ nbf: now + 1 })}`, verifier), { code: "invalid_token" });
  for (const exp of [undefined, "not-a-date", null]) {
    await assert.rejects(authenticate(`Bearer ${token({ exp })}`, verifier), { code: "invalid_token" });
  }
  await assert.rejects(authenticate(`Bearer ${rawPayloadToken(`{"iss":"${issuer}","client_id":"${clientId}","token_use":"access","sub":"subject","iat":${now - 10},"exp":1e309}`)}`, verifier), { code: "invalid_token" });
});

for (const [name, claims] of Object.entries({
  "wrong issuer": { iss: "https://evil.example/pool" },
  "wrong client": { client_id: "other-client" },
  "wrong token use": { token_use: "id" },
})) test(`rejects ${name}`, async (t) => {
  freezeNow(t, now);
  assert.deepEqual(await authenticate(`Bearer ${token()}`, verifier), { curator: false });
  await assert.rejects(authenticate(`Bearer ${token(claims)}`, verifier), { code: "invalid_token" });
});

test("rejects unknown keys and forged signatures without leaking auth state to the following guest", async (t) => {
  freezeNow(t, now);
  assert.deepEqual(await authenticate(`Bearer ${token()}`, verifier), { curator: false });
  await assert.rejects(authenticate(`Bearer ${token({}, keys.privateKey, "unknown-key")}`, verifier), { code: "invalid_token" });
  const forged = token({}, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
  await assert.rejects(authenticate(`Bearer ${forged}`, verifier), { code: "invalid_token" });
  assert.deepEqual(await authenticate(undefined, verifier), { curator: false });
});

test("maps a real remote-JWKS fetch failure to retryable auth unavailability", async (t) => {
  freezeNow(t, now);
  const remote = createCognitoTokenVerifier({ userPoolId: "us-east-1_example", clientId, jwksCache: new SimpleJwksCache({ fetcher: { fetch: async (uri) => { throw new FetchError(uri, "offline"); } } }) });
  await assert.rejects(authenticate(`Bearer ${token()}`, remote), { code: "auth_unavailable", retryable: true });
});

function token(extra: Record<string, unknown> = {}, privateKey = keys.privateKey, kid = "offline-test-key"): string {
  const header = base64url({ alg: "RS256", kid, typ: "JWT" });
  const payload = base64url({ iss: issuer, client_id: clientId, token_use: "access", sub: "subject", iat: now - 10, exp: now + 60, ...extra });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
}
function rawPayloadToken(payload: string): string {
  const header = base64url({ alg: "RS256", kid: "offline-test-key", typ: "JWT" });
  const encodedPayload = Buffer.from(payload).toString("base64url");
  return `${header}.${encodedPayload}.${sign("RSA-SHA256", Buffer.from(`${header}.${encodedPayload}`), keys.privateKey).toString("base64url")}`;
}
function base64url(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function freezeNow(t: test.TestContext, seconds: number): void { t.mock.method(Date, "now", () => seconds * 1000); }
