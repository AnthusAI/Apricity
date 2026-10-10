import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { GetItemCommand, QueryCommand, SearchVectorsCommand } from "@aws-sdk/client-dynamodb";
import type { Jwks } from "aws-jwt-verify/jwk";
import { createCognitoTokenVerifier } from "./auth";
import { canonicalSemanticId } from "./canonical";
import { createSemanticRuntime, readBoundedS3Object } from "./runtime";

const env = { SEMANTIC_TABLE: "Semantic", SEMANTIC_VECTOR_INDEX: "semantic-embedding-v1", SAMPLE_TABLE: "Sample", RECORDING_TABLE: "Recording", CLIP_TABLE: "Clip", STORAGE_BUCKET: "files", COGNITO_USER_POOL_ID: "us-east-1_example", COGNITO_USER_POOL_CLIENT_ID: "client", SEMANTIC_PROCESSING_FINGERPRINT: "fingerprint", SEMANTIC_ALLOWED_ORIGINS: "https://app.example" };
const event = (path: "/semantic/search" | "/semantic/related", body: unknown) => ({ rawPath: path, requestContext: { http: { method: "POST" } }, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("invalid configuration and independently disabled operations return 503 before authentication or stores", async () => {
  let calls = 0;
  const invalid = createSemanticRuntime({}, { dynamoSend: async () => { calls++; return {}; } });
  assert.equal((await invalid.handle(event("/semantic/search", {}))).statusCode, 503);
  const disabled = createSemanticRuntime(env, { dynamoSend: async () => { calls++; return {}; }, verifier: { verify: async () => { calls++; return { curator: true }; } } });
  assert.equal((await disabled.handle(event("/semantic/search", { embeddingSpace: "clap-htsat-unfused-512-v1", queryVector: [0], limit: 1 }))).statusCode, 503);
  assert.equal(calls, 0);
});

test("invalid origins and every construction failure are a sanitized 503, while disabled paths never construct verification", async () => {
  for (const origin of ["https://app.example/path", "https://user@app.example", "https://*.example", "http://app.example"]) {
    const runtime = createSemanticRuntime({ ...env, SEMANTIC_ALLOWED_ORIGINS: origin, SEMANTIC_SEARCH_ENABLED: "true" });
    assert.equal((await runtime.handle(event("/semantic/search", {}))).statusCode, 503);
  }
  let constructed = 0;
  const explosive = { get verifier() { constructed++; throw new Error("invalid pool"); } } as unknown as Parameters<typeof createSemanticRuntime>[1];
  const disabled = createSemanticRuntime(env, explosive);
  assert.equal((await disabled.handle(event("/semantic/search", {}))).statusCode, 503);
  assert.equal(constructed, 0);
  const enabled = createSemanticRuntime({ ...env, SEMANTIC_SEARCH_ENABLED: "true" }, explosive);
  assert.equal((await enabled.handle(event("/semantic/search", {}))).statusCode, 503);
  assert.equal(constructed, 1);
});

test("each related request creates a fresh AWS store and uses the native sample GSI query", async () => {
  const commands: unknown[] = [];
  const runtime = createSemanticRuntime({ ...env, SEMANTIC_RELATED_ENABLED: "true" }, { dynamoSend: async (command) => { commands.push(command); return { Items: [] }; }, verifier: { verify: async () => ({ curator: false }) } });
  const body = { embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "sample", limit: 1 };
  assert.equal((await runtime.handle(event("/semantic/related", body))).statusCode, 200);
  assert.equal((await runtime.handle(event("/semantic/related", body))).statusCode, 200);
  assert.equal(commands.length, 2); assert.ok(commands.every((command) => command instanceof QueryCommand));
  assert.equal((commands[0] as QueryCommand).input.IndexName, "semantic-by-sample");
});

test("actual related runtime reads multiple GSI passages, searches each representative, and returns only other recordings", async () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const av = (value: unknown): any => typeof value === "string" ? { S: value } : typeof value === "number" ? { N: String(value) } : typeof value === "boolean" ? { BOOL: value } : Array.isArray(value) ? { L: value.map(av) } : value && typeof value === "object" ? { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, av(item)])) } : { NULL: true };
  const identity = (sampleId: string, recordingId: string, clipId: string, start: number, end: number) => {
    const value = { sampleId, recordingId, kind: "saved_clip" as const, clipId, start, end, audioSha256: sha(sampleId), embeddingSpace: "clap-htsat-unfused-512-v1" as const, processingFingerprint: "fingerprint" };
    return { ...value, semanticId: canonicalSemanticId(value)! };
  };
  const record = (value: ReturnType<typeof identity>, vector: number[]) => ({ identity: value, vector, display: { samplePath: `${value.sampleId}.wav`, sampleTitle: value.sampleId, clipName: value.clipId, tags: [] }, playback: { fileKey: `audio/${value.sampleId}.wav`, start: value.start, end: value.end }, revision: sha(JSON.stringify([value.semanticId, ""])), metadataUpdatedAt: "2026-01-01T00:00:00Z" });
  const sourceA = record(identity("source", "source-recording", "source-a", 0, 1), [1, ...Array(511).fill(0)]);
  const sourceB = record(identity("source", "source-recording", "source-b", 1, 2), [0, 1, ...Array(510).fill(0)]);
  const targetA = record(identity("target-a", "recording-a", "target-a", 0, 1), [1, ...Array(511).fill(0)]);
  const targetB = record(identity("target-b", "recording-b", "target-b", 1, 2), [0, 1, ...Array(510).fill(0)]);
  const commands: Array<GetItemCommand | QueryCommand | SearchVectorsCommand> = [];
  const runtime = createSemanticRuntime({ ...env, SEMANTIC_RELATED_ENABLED: "true" }, {
    verifier: { verify: async () => ({ curator: false }) },
    dynamoSend: async (command): Promise<any> => {
      commands.push(command);
      if (command instanceof QueryCommand) return { Items: [av(sourceA).M, av(sourceB).M] };
      if (command instanceof SearchVectorsCommand) {
        const candidate = command.input.SearchVector?.[0]?.N === "1" ? targetA : targetB;
        return { SearchResults: [{ Score: 0.9, Item: { embeddingSpace: av(candidate.identity.embeddingSpace), semanticId: av(candidate.identity.semanticId), identity: av(candidate.identity), revision: av(candidate.revision) } }] };
      }
      const id = command.input.Key?.id?.S!;
      if (command.input.TableName === "Sample") return { Item: { id: av(id), recordingId: av(id === "source" ? "source-recording" : id === "target-a" ? "recording-a" : "recording-b"), path: av(`${id}.wav`), title: av(id), status: av("ready"), duration: av(8), audio: av({ key: `audio/${id}.wav`, sha256: sha(id) }) } };
      if (command.input.TableName === "Recording") return { Item: { id: av(id), license: av("cc0-1.0") } };
      return { Item: { id: av(id), sampleId: av(id.startsWith("source") ? "source" : id), name: av(id), start: av(id.endsWith("b") ? 1 : 0), end: av(id.endsWith("b") ? 2 : 1), retired: av(false) } };
    },
  });
  const response = await runtime.handle(event("/semantic/related", { embeddingSpace: "clap-htsat-unfused-512-v1", sampleId: "source", limit: 2 }));
  assert.equal(response.statusCode, 200, `${response.body} ${commands.map((command) => command.constructor.name).join(",")}`);
  const hits = JSON.parse(response.body!).hits;
  assert.deepEqual(hits.map((hit: any) => hit.identity.sampleId).sort(), ["target-a", "target-b"]);
  assert.equal(hits.some((hit: any) => hit.identity.sampleId === "source"), false, "related never returns its source sample");
  assert.equal(new Set(hits.map((hit: any) => hit.parent.recordingId)).size, 2, "results retain distinct canonical recordings");
  const queries = commands.filter((command): command is QueryCommand => command instanceof QueryCommand);
  const searches = commands.filter((command): command is SearchVectorsCommand => command instanceof SearchVectorsCommand);
  assert.equal(queries.length, 1); assert.equal(queries[0].input.IndexName, "semantic-by-sample");
  assert.equal(searches.length, 2); assert.ok(searches.every((command) => command.input.TableName === "Semantic" && command.input.IndexName === "semantic-embedding-v1"));
});

test("bounded S3 reading distinguishes missing objects, outages, and overflow while streaming", async () => {
  let closed = false;
  const stream = async function* () { try { yield new Uint8Array(16 * 1024 * 1024); yield new Uint8Array(1); } finally { closed = true; } };
  await assert.rejects(() => readBoundedS3Object(async () => ({ Body: stream() }), { Bucket: "files", Key: "files/analysis/a.json" }));
  assert.equal(closed, true);
  assert.equal(await readBoundedS3Object(async () => { throw { name: "NoSuchKey" }; }, { Bucket: "files", Key: "files/analysis/a.json" }), null);
  assert.equal(await readBoundedS3Object(async () => { throw { $metadata: { httpStatusCode: 404 } }; }, { Bucket: "files", Key: "files/analysis/a.json" }), null);
  await assert.rejects(() => readBoundedS3Object(async () => ({ Body: (async function* () { yield {} as Uint8Array; })() }), { Bucket: "files", Key: "files/analysis/a.json" }));
  await assert.rejects(() => readBoundedS3Object(async () => { throw new Error("outage"); }, { Bucket: "files", Key: "files/analysis/a.json" }));
});

test("a real signed Cognito request traverses native search, current DynamoDB rows and SHA-verified S3 without cross-request visibility cache", async (t) => {
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const audio = "a".repeat(64), analysis = Buffer.from(JSON.stringify({ source: { sha256: audio }, rhythm: { beats: [0, 1, 2, 3, 4], bpm: 120, downbeats: [0, 1, 2, 3, 4], meter: 4 } }));
  const grid = sha('{"beats":[0,1,2,3,4],"bpm":120,"downbeats":[0,1,2,3,4],"meter":4}');
  const identity = { sampleId: "sample", recordingId: "recording", kind: "window" as const, start: 0, end: 4, audioSha256: audio, embeddingSpace: "clap-htsat-unfused-512-v1" as const, processingFingerprint: "fingerprint" };
  const candidate = { ...identity, semanticId: canonicalSemanticId(identity)! }; const revision = sha(JSON.stringify([candidate.semanticId, grid]));
  let privateRecording = false, staleAudio = false;
  const av = (value: unknown): any => typeof value === "string" ? { S: value } : typeof value === "number" ? { N: String(value) } : typeof value === "boolean" ? { BOOL: value } : Array.isArray(value) ? { L: value.map(av) } : value && typeof value === "object" ? { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, av(item)])) } : { NULL: true };
  const send = async (command: GetItemCommand | QueryCommand | SearchVectorsCommand): Promise<any> => {
    if (command instanceof SearchVectorsCommand) return { SearchResults: [{ Score: 0.9, Item: { embeddingSpace: av(candidate.embeddingSpace), semanticId: av(candidate.semanticId), identity: av(candidate), revision: av(revision) } }] };
    assert.ok(command instanceof GetItemCommand, "search path uses only native SearchVectors then canonical GetItem");
    if (command.input.TableName === "Sample") return { Item: { id: av("sample"), recordingId: av("recording"), path: av("breaks/one.wav"), title: av("One"), status: av("ready"), duration: av(10), tags: av(["break"]), audio: av({ key: "audio/one.wav", sha256: staleAudio ? "b".repeat(64) : audio }), analysis: av({ key: "analysis/one.json", sha256: sha(analysis) }) } };
    return { Item: { id: av("recording"), license: av(privateRecording ? "not-cleared" : "cc0-1.0") } };
  };
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const now = Date.UTC(2030, 0, 1);
  const jwks = { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256" }] } as Jwks;
  const verifier = createCognitoTokenVerifier({ userPoolId: "us-east-1_example", clientId: "client", jwks });
  const runtime = createSemanticRuntime({ ...env, SEMANTIC_SEARCH_ENABLED: "true" }, { dynamoSend: send, readAnalysisObject: async ({ Bucket, Key }) => { assert.equal(Bucket, "files"); assert.equal(Key, "files/analysis/one.json"); return analysis; }, verifier });
  const request = { embeddingSpace: candidate.embeddingSpace, queryVector: [1, ...Array(511).fill(0)], limit: 1 };
  t.mock.method(Date, "now", () => now);
  const guest = await runtime.handle(event("/semantic/search", request));
  assert.equal(guest.statusCode, 200); assert.equal(JSON.parse(guest.body!).hits[0].playback.fileKey, "audio/one.wav"); assert.equal(guest.body!.includes("vector"), false);
  privateRecording = true;
  const token = jwt({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example", client_id: "client", token_use: "access", exp: now / 1000 + 60, "cognito:groups": ["curators"] }, keys.privateKey);
  const curator = await runtime.handle({ ...event("/semantic/search", request), headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
  assert.equal(curator.statusCode, 200);
  const curatorHits = JSON.parse(curator.body!).hits;
  assert.equal(curatorHits.length, 1, "a curator-visible private recording must produce a real hit, not an empty 200");
  assert.deepEqual(curatorHits[0].identity, candidate, "the exposed hit keeps its canonical identity");
  assert.deepEqual(curatorHits[0].playback, { fileKey: "audio/one.wav", start: 0, end: 4 }, "the real hit has canonical playback");
  assert.deepEqual(JSON.parse((await runtime.handle(event("/semantic/search", request))).body!).hits, [], "guest after curator cannot receive cached canonical content");
  staleAudio = true;
  assert.deepEqual(JSON.parse((await runtime.handle({ ...event("/semantic/search", request), headers: { "content-type": "application/json", authorization: `Bearer ${token}` } })).body!).hits, [], "edited hash is rejected as stale");
});

test("the actual search runtime never exposes retired, boundary-edited, or wrong-space vector candidates", async () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const audio = "c".repeat(64);
  const base = { sampleId: "source", recordingId: "recording", kind: "saved_clip" as const, clipId: "clip", start: 1, end: 3, audioSha256: audio, embeddingSpace: "clap-htsat-unfused-512-v1" as const, processingFingerprint: "fingerprint" };
  const candidate = { ...base, semanticId: canonicalSemanticId(base)! };
  const av = (value: unknown): any => typeof value === "string" ? { S: value } : typeof value === "number" ? { N: String(value) } : typeof value === "boolean" ? { BOOL: value } : Array.isArray(value) ? { L: value.map(av) } : value && typeof value === "object" ? { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, av(item)])) } : { NULL: true };
  let retired = false, edited = false, wrongSpace = false, canonicalReads = 0;
  const runtime = createSemanticRuntime({ ...env, SEMANTIC_SEARCH_ENABLED: "true" }, {
    verifier: { verify: async () => ({ curator: false }) },
    dynamoSend: async (command): Promise<any> => {
      if (command instanceof SearchVectorsCommand) {
        const indexed = wrongSpace ? { ...candidate, embeddingSpace: "other-space" } : candidate;
        return { SearchResults: [{ Score: 1, Item: { embeddingSpace: av(indexed.embeddingSpace), semanticId: av(indexed.semanticId), identity: av(indexed), revision: av(sha(JSON.stringify([candidate.semanticId, ""]))) } }] };
      }
      canonicalReads++;
      if (command.input.TableName === "Sample") return { Item: { id: av("source"), recordingId: av("recording"), path: av("source.wav"), title: av("Source"), status: av("ready"), duration: av(8), audio: av({ key: "audio/source.wav", sha256: audio }) } };
      if (command.input.TableName === "Recording") return { Item: { id: av("recording"), license: av("cc0-1.0") } };
      return { Item: { id: av("clip"), sampleId: av("source"), name: av("Source clip"), start: av(1), end: av(edited ? 2.5 : 3), retired: av(retired) } };
    },
  });
  const request = { embeddingSpace: candidate.embeddingSpace, queryVector: [1, ...Array(511).fill(0)], limit: 1 };
  assert.equal(JSON.parse((await runtime.handle(event("/semantic/search", request))).body!).hits.length, 1);
  retired = true;
  assert.deepEqual(JSON.parse((await runtime.handle(event("/semantic/search", request))).body!).hits, [], "retired saved clips are filtered by fresh canonical reads");
  retired = false; edited = true;
  assert.deepEqual(JSON.parse((await runtime.handle(event("/semantic/search", request))).body!).hits, [], "edited saved-clip boundaries are filtered by fresh canonical reads");
  edited = false; wrongSpace = true; canonicalReads = 0;
  assert.equal((await runtime.handle(event("/semantic/search", request))).statusCode, 503, "a wrong-space native candidate fails closed");
  assert.equal(canonicalReads, 0, "wrong-space candidates never reach canonical reads");
});

function jwt(payload: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test", typ: "JWT" })).toString("base64url"), body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
}
