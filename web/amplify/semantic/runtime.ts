import { DynamoDBClient, type GetItemCommand, type QueryCommand, type SearchVectorsCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createCognitoTokenVerifier, type TokenVerifier } from "./auth";
import { createAwsSemanticStore, type AnalysisObjectReader, type AwsDynamoSend } from "./aws-store";
import { createCanonicalHydrator } from "./canonical";
import { createSemanticHttpHandler, type HttpResult } from "./http-handler";
import { createRelatedAudioService } from "./related-service";
import { createCloudSearchService, type SearchVectorsSend } from "./search-service";

const MAX_ANALYSIS_BYTES = 16 * 1024 * 1024;
type HttpEvent = Parameters<ReturnType<typeof createSemanticHttpHandler>>[0];
type Environment = Readonly<Record<string, string | undefined>>;
export type SemanticRuntimePorts = Readonly<{
  dynamoSend?: AwsDynamoSend & SearchVectorsSend;
  readAnalysisObject?: AnalysisObjectReader;
  verifier?: TokenVerifier;
}>;
export type SemanticRuntime = Readonly<{ handle: (event: HttpEvent) => Promise<HttpResult> }>;

// SDK clients keep only connection state at module scope. Per-request stores and hydrators are deliberately created
// inside handle so neither canonical content nor an authorization context can survive an invocation.
const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const verifierCache = new Map<string, TokenVerifier>();

export function createSemanticRuntime(environment: Environment = process.env, ports: SemanticRuntimePorts = {}): SemanticRuntime {
  const config = configOf(environment);
  return { async handle(event) {
    if (!config) return unavailable();
    // Do not construct a verifier (which validates pool configuration) or any store until an enabled operation needs it.
    // This makes a disabled deployment safely unavailable even while its Cognito parameters are being corrected.
    if (!config.searchEnabled && !config.relatedEnabled) return unavailable();
    if (event.rawPath === "/semantic/search" && !config.searchEnabled || event.rawPath === "/semantic/related" && !config.relatedEnabled) return unavailable();
    try {
      const verifier = ports.verifier ?? cachedVerifier(config.userPoolId, config.userPoolClientId);
      const send = ports.dynamoSend ?? ((command: GetItemCommand | QueryCommand | SearchVectorsCommand) => dynamo.send(command as never));
      const readAnalysisObject = ports.readAnalysisObject ?? s3Reader;
      const store = createAwsSemanticStore({
        send: send as AwsDynamoSend,
        readAnalysisObject,
        tables: { sample: config.sampleTable, recording: config.recordingTable, clip: config.clipTable, semantic: config.semanticTable },
        analysisBucket: config.bucket,
      });
      const hydrate = createCanonicalHydrator({ ...store, processingFingerprint: config.processingFingerprint });
      const search = createCloudSearchService({ send: send as SearchVectorsSend, tableName: config.semanticTable, indexName: config.vectorIndex, hydrate });
      const related = createRelatedAudioService({ readSource: store.readSource, readSampleSources: store.readSampleSources, hydrateSource: hydrate, search: search.search });
      return await createSemanticHttpHandler({ search, related, verifier, allowedOrigins: config.origins, searchEnabled: config.searchEnabled, relatedEnabled: config.relatedEnabled })(event);
    } catch {
      // Construction configuration and AWS adapter failures are intentionally indistinguishable at the public boundary.
      return unavailable();
    }
  } };
}

type Config = Readonly<{ semanticTable: string; vectorIndex: string; sampleTable: string; recordingTable: string; clipTable: string; bucket: string; userPoolId: string; userPoolClientId: string; processingFingerprint: string; origins: readonly string[]; searchEnabled: boolean; relatedEnabled: boolean }>;
function configOf(env: Environment): Config | null {
  const get = (key: string) => env[key]?.trim() || undefined;
  const required = ["SEMANTIC_TABLE", "SEMANTIC_VECTOR_INDEX", "SAMPLE_TABLE", "RECORDING_TABLE", "CLIP_TABLE", "STORAGE_BUCKET", "COGNITO_USER_POOL_ID", "COGNITO_USER_POOL_CLIENT_ID", "SEMANTIC_PROCESSING_FINGERPRINT"] as const;
  if (required.some((key) => !get(key))) return null;
  const origins = (get("SEMANTIC_ALLOWED_ORIGINS") ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const enabled = (key: string) => {
    const value = get(key);
    return value === undefined ? false : value === "true" ? true : value === "false" ? false : null;
  };
  const searchEnabled = enabled("SEMANTIC_SEARCH_ENABLED"), relatedEnabled = enabled("SEMANTIC_RELATED_ENABLED");
  if (!origins.length || origins.some((origin) => !exactHttpsOrigin(origin)) || searchEnabled === null || relatedEnabled === null) return null;
  return {
    semanticTable: get("SEMANTIC_TABLE")!, vectorIndex: get("SEMANTIC_VECTOR_INDEX")!, sampleTable: get("SAMPLE_TABLE")!, recordingTable: get("RECORDING_TABLE")!, clipTable: get("CLIP_TABLE")!, bucket: get("STORAGE_BUCKET")!,
    userPoolId: get("COGNITO_USER_POOL_ID")!, userPoolClientId: get("COGNITO_USER_POOL_CLIENT_ID")!, processingFingerprint: get("SEMANTIC_PROCESSING_FINGERPRINT")!, origins,
    searchEnabled, relatedEnabled,
  };
}
function exactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && !parsed.hostname.includes("*") && value === parsed.origin;
  } catch { return false; }
}
function cachedVerifier(userPoolId: string, clientId: string): TokenVerifier {
  const key = `${userPoolId}\0${clientId}`;
  let verifier = verifierCache.get(key);
  if (!verifier) { verifier = createCognitoTokenVerifier({ userPoolId, clientId }); verifierCache.set(key, verifier); }
  return verifier;
}
async function s3Reader(request: { Bucket: string; Key: string }): Promise<Uint8Array | null> {
  return readBoundedS3Object((command) => s3.send(command), request);
}
/** Reads the stream incrementally; callers can inject this seam without ever materialising an unbounded S3 body. */
export async function readBoundedS3Object(send: (command: GetObjectCommand) => Promise<unknown>, request: { Bucket: string; Key: string }): Promise<Uint8Array | null> {
  try {
    const response = await send(new GetObjectCommand(request)) as { Body?: unknown };
    const body = response.Body;
    if (!body || !(Symbol.asyncIterator in Object(body))) throw new Error("missing S3 object body");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw new Error("malformed S3 object chunk");
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.byteLength;
      if (size > MAX_ANALYSIS_BYTES) throw new Error("analysis object exceeds 16 MiB");
      chunks.push(bytes);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if (value?.name === "NoSuchKey" || value?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
function unavailable(): HttpResult { return { statusCode: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "semantic_unavailable", retryable: true } }) }; }
