import { authenticate, AuthenticationError, type TokenVerifier } from "./auth";
import type { CloudSearchService } from "./search-service";
import type { RelatedAudioService } from "./related-service";
const MAX_BODY_BYTES = 64 * 1024;
type HttpEvent = Readonly<{ rawPath?: string; requestContext?: { http?: { method?: string } }; headers?: Record<string, string | undefined>; body?: string; isBase64Encoded?: boolean }>;
export type HttpResult = Readonly<{ statusCode: number; headers: Record<string, string>; body?: string }>;
export type SemanticHttpDependencies = Readonly<{ search: Pick<CloudSearchService, "search">; related: Pick<RelatedAudioService, "related">; verifier: TokenVerifier; allowedOrigins: readonly string[]; searchEnabled: boolean; relatedEnabled: boolean }>;
/** HTTP API v2 boundary. Dependency wiring intentionally remains with the owning infrastructure layer. */
export function createSemanticHttpHandler(deps: SemanticHttpDependencies) {
  const origins = new Set(deps.allowedOrigins);
  return async (event: HttpEvent): Promise<HttpResult> => {
    const method = event.requestContext?.http?.method, path = event.rawPath, origin = header(event, "origin"), cors: Record<string, string> = origin && origins.has(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {};
    if (method === "OPTIONS") return knownPath(path) && origin && origins.has(origin) && validPreflight(event) ? { statusCode: 204, headers: { ...cors, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type, Authorization", "access-control-max-age": "600" } } : response(403, "cors_forbidden", false, cors);
    if (!knownPath(path)) return response(404, "not_found", false, cors);
    if (method !== "POST") return response(405, "method_not_allowed", false, { ...cors, allow: "POST, OPTIONS" });
    // A disabled operation is terminal: neither authentication nor either domain service is consulted.
    if (path === "/semantic/search" && !deps.searchEnabled || path === "/semantic/related" && !deps.relatedEnabled) return response(503, "semantic_unavailable", true, cors);
    if (!isJson(header(event, "content-type"))) return response(415, "unsupported_media_type", false, cors);
    let body: unknown; try { body = parseBody(event); } catch (error) { return response(error === tooLarge ? 413 : 400, error === tooLarge ? "request_too_large" : "invalid_request", false, cors); }
    let context; try { context = await authenticate(header(event, "authorization"), deps.verifier); } catch (error) { return error instanceof AuthenticationError ? response(error.retryable ? 503 : 401, error.code, error.retryable, cors) : response(503, "auth_unavailable", true, cors); }
    try { const value = path === "/semantic/search" ? await deps.search.search(body, context) : await deps.related.related(body, context); return hasVector(value) ? response(503, "semantic_unavailable", true, cors) : { statusCode: 200, headers: { "content-type": "application/json", ...cors }, body: JSON.stringify(value) }; } catch (error) { return serviceFailure(error, cors); }
  };
}
const tooLarge = Symbol("tooLarge");
function parseBody(event: HttpEvent): unknown { const text = event.body ?? ""; let bytes: Buffer; if (event.isBase64Encoded) { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("base64"); bytes = Buffer.from(text, "base64"); } else bytes = Buffer.from(text, "utf8"); if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge; return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function knownPath(path: string | undefined): path is "/semantic/search" | "/semantic/related" { return path === "/semantic/search" || path === "/semantic/related"; }
function isJson(contentType: string | undefined): boolean { return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json"; }
function header(event: HttpEvent, name: string): string | undefined { const pair = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name); return pair?.[1]; }
function validPreflight(event: HttpEvent): boolean { const requestedMethod = header(event, "access-control-request-method"); if (requestedMethod !== undefined && requestedMethod.toUpperCase() !== "POST") return false; const requestedHeaders = header(event, "access-control-request-headers"); return requestedHeaders === undefined || requestedHeaders.split(",").every((value) => ["content-type", "authorization"].includes(value.trim().toLowerCase())); }
function response(statusCode: number, code: string, retryable: boolean, cors: Record<string, string>): HttpResult { return { statusCode, headers: { "content-type": "application/json", ...cors }, body: JSON.stringify({ error: { code, retryable } }) }; }
function serviceFailure(error: unknown, cors: Record<string, string>): HttpResult { if (error && typeof error === "object") { const value = error as { status?: unknown; code?: unknown; retryable?: unknown }; if (value.status === 400 && value.code === "semantic_request_invalid" && value.retryable === false) return response(400, value.code, false, cors); if (value.status === 409 && value.code === "semantic_space_unsupported" && value.retryable === false) return response(409, value.code, false, cors); if (value.status === 503 && value.code === "semantic_unavailable" && value.retryable === true) return response(503, value.code, true, cors); } return response(503, "semantic_unavailable", true, cors); }
function hasVector(value: unknown): boolean { if (!value || typeof value !== "object") return false; if (Array.isArray(value)) return value.some(hasVector); return Object.entries(value as Record<string, unknown>).some(([key, child]) => key === "vector" || key === "sourceVector" || key === "queryVector" || hasVector(child)); }
