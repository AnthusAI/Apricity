/** Shared, narrowly scoped transport for semantic retrieval endpoints. */
export interface SemanticAuthSession {
  tokens?: { accessToken?: string | { toString(): string } };
}

export interface SemanticTransportDeps {
  bootstrap: () => Promise<unknown>;
  semanticUrl: () => string | null;
  mode: () => "local" | "cloud";
  /** Required deliberately: production must explicitly choose its Cognito session reader. */
  fetchAuthSession: () => Promise<SemanticAuthSession>;
  fetch: typeof globalThis.fetch;
  /** Test port; browsers default to location.origin. */
  origin?: () => string;
}

export class SemanticTransportError extends Error {
  constructor(readonly code: "semantic_unavailable" | "semantic_auth_unavailable", message: string, readonly retryable: boolean) {
    super(message);
    this.name = "SemanticTransportError";
  }
}

export function createSemanticTransport(deps: SemanticTransportDeps) {
  return {
    async post(path: "search" | "related", body: unknown, options: { signal?: AbortSignal } = {}): Promise<Response> {
      throwIfAborted(options.signal);
      await deps.bootstrap();
      throwIfAborted(options.signal);
      const target = endpoint(deps.semanticUrl(), path, deps.origin);
      const headers: Record<string, string> = { "content-type": "application/json" };
      let redirect: RequestRedirect | undefined;
      if (deps.mode() === "cloud") {
        if (!trustedCloudTarget(target.url, currentOrigin(deps.origin))) {
          throw new SemanticTransportError("semantic_unavailable", "Semantic retrieval is not configured for a trusted service", true);
        }
        let session: SemanticAuthSession;
        try {
          session = await deps.fetchAuthSession();
        } catch {
          throw new SemanticTransportError("semantic_auth_unavailable", "Sign-in session is temporarily unavailable", true);
        }
        throwIfAborted(options.signal);
        const accessToken = token(session);
        if (accessToken) {
          headers.authorization = `Bearer ${accessToken}`;
          // Never permit fetch to replay this bearer token to an unvalidated redirect target.
          redirect = "error";
        }
      }
      throwIfAborted(options.signal);
      return deps.fetch(target.requestUrl, { method: "POST", headers, body: JSON.stringify(body), signal: options.signal, ...(redirect ? { redirect } : {}) });
    },
  };
}

function endpoint(base: string | null, path: "search" | "related", origin: SemanticTransportDeps["origin"]): { url: URL; requestUrl: string } {
  if (!base) throw new SemanticTransportError("semantic_unavailable", "Semantic retrieval is not configured for this deployment", true);
  try {
    const url = new URL(base, currentOrigin(origin));
    if (url.username || url.password || url.hash) throw new TypeError("unsafe semantic URL");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`;
    const relative = !/^[a-z][a-z\d+.-]*:/i.test(base);
    return { url, requestUrl: relative ? `${url.pathname}${url.search}` : url.href };
  } catch {
    throw new SemanticTransportError("semantic_unavailable", "Semantic retrieval is not configured for this deployment", true);
  }
}

function currentOrigin(origin?: () => string): string {
  if (origin) return origin();
  if (typeof location !== "undefined") return location.origin;
  return "http://localhost";
}

function trustedCloudTarget(target: URL, origin: string): boolean {
  let configuredOrigin: URL;
  try { configuredOrigin = new URL(origin); } catch { return false; }
  return target.origin === configuredOrigin.origin || target.protocol === "https:";
}

function token(session: SemanticAuthSession): string | null {
  const value = session.tokens?.accessToken;
  if (typeof value === "string") return value || null;
  if (!value) return null;
  const result = value.toString();
  return result || null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}
