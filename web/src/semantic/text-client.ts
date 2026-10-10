import { CLAP_BROWSER_MANIFEST, normalizeEmbedding, type EncoderEvent, type EncoderRequest } from "./encoder";

export interface WorkerLike {
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  postMessage(message: EncoderRequest): void;
  terminate(): void;
}

export type TextEncoderProgress = Extract<EncoderEvent, { type: "progress" }>;
export type TextEncoderResult = { embeddingSpace: typeof CLAP_BROWSER_MANIFEST.embeddingSpace; vector: number[] };

export class TextEncoderClientError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); this.name = "TextEncoderClientError"; }
}

export interface TextEncoderClient {
  encode(text: string, options?: { signal?: AbortSignal; onProgress?: (event: TextEncoderProgress) => void }): Promise<TextEncoderResult>;
  cancel(): void;
  dispose(): void;
}

let nextClientId = 0;

export function createTextEncoderClient(options: { workerFactory?: () => WorkerLike } = {}): TextEncoderClient {
  const workerFactory = options.workerFactory ?? (() => new Worker(new URL("./encoder-worker.ts", import.meta.url), { type: "module" }));
  const active = new Map<string, { resolve: (value: TextEncoderResult) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void; onProgress?: (event: TextEncoderProgress) => void }>();
  let sequence = 0;
  const clientId = ++nextClientId;
  let worker: WorkerLike | undefined;
  let disposed = false;

  const detach = (requestId: string) => {
    const request = active.get(requestId);
    if (!request) return undefined;
    active.delete(requestId);
    if (request.signal && request.abort) request.signal.removeEventListener("abort", request.abort);
    return request;
  };
  const discardWorker = () => {
    if (!worker) return;
    worker.removeEventListener("message", receive);
    worker.removeEventListener("error", failed);
    worker.removeEventListener("messageerror", failed);
    worker.terminate();
    worker = undefined;
  };
  const rejectAll = (code: string, message: string, retryable: boolean) => {
    for (const requestId of [...active.keys()]) {
      detach(requestId)?.reject(new TextEncoderClientError(code, message, retryable));
    }
  };
  const failed = (event: Event) => {
    const message = (event as ErrorEvent).message || "Worker failed before returning an encoder result";
    rejectAll("worker_failed", message, true);
    discardWorker();
  };
  const receive = (event: Event) => {
    const message = (event as MessageEvent<Partial<EncoderEvent> & { requestId?: unknown }>).data;
    if (!message || typeof message.requestId !== "string") return;
    const requestId = message.requestId;
    const request = active.get(requestId);
    if (!request) return; // Cancelled/disposed and out-of-order messages cannot repaint a caller.
    const rejectInvalidResponse = (detail: string) => {
      detach(requestId)?.reject(new TextEncoderClientError("invalid_response", detail, true));
    };
    if (message.type === "progress") {
      if (typeof message.loaded !== "number" || !Number.isFinite(message.loaded) || (message.total !== undefined && (typeof message.total !== "number" || !Number.isFinite(message.total))) || typeof message.phase !== "string") {
        rejectInvalidResponse("Worker sent invalid encoder progress");
        return;
      }
      try { request.onProgress?.({ type: "progress", requestId, loaded: message.loaded, total: message.total, phase: message.phase }); } catch { /* A caller callback cannot disrupt worker protocol handling. */ }
      return;
    }
    if (message.type === "result") {
      detach(requestId);
      try {
        if (message.embeddingSpace !== CLAP_BROWSER_MANIFEST.embeddingSpace) throw new Error("Embedding space does not match the pinned CLAP manifest");
        request.resolve({ embeddingSpace: message.embeddingSpace, vector: normalizeEmbedding(message.vector) });
      }
      catch (error) { request.reject(new TextEncoderClientError("invalid_embedding", error instanceof Error ? error.message : String(error), true)); }
      return;
    }
    if (message.type !== "error" || typeof message.code !== "string" || typeof message.message !== "string" || typeof message.retryable !== "boolean") {
      rejectInvalidResponse("Worker sent an unknown or malformed encoder message");
      return;
    }
    // A model error can leave its shared runtime unusable. No active caller may
    // remain attached to a worker that is about to be discarded.
    rejectAll(message.code, message.message, message.retryable);
    // An error can leave the model/worker in an unknown state. Retry gets a fresh worker.
    discardWorker();
  };
  const ensureWorker = () => {
    if (worker) return worker;
    worker = workerFactory();
    worker.addEventListener("message", receive);
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
    return worker;
  };
  const cancelRequest = (requestId: string, message: string) => {
    const request = detach(requestId);
    if (!request) return;
    try { worker?.postMessage({ type: "cancel", requestId }); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      request.reject(new TextEncoderClientError("worker_failed", detail, true));
      rejectAll("worker_failed", detail, true);
      discardWorker();
      return;
    }
    request.reject(new TextEncoderClientError("aborted", message, true));
  };

  return {
    encode(text, requestOptions = {}) {
      const normalized = text.trim();
      if (disposed) return Promise.reject(new TextEncoderClientError("disposed", "Text encoder client has been disposed", false));
      if (!normalized) return Promise.reject(new TextEncoderClientError("empty_text", "Text is required", false));
      if (requestOptions.signal?.aborted) return Promise.reject(new TextEncoderClientError("aborted", "Text encoding was aborted", true));
      return new Promise((resolve, reject) => {
        const requestId = `clap-text-${clientId}-${++sequence}`;
        const abort = () => cancelRequest(requestId, "Text encoding was aborted");
        active.set(requestId, { resolve, reject, signal: requestOptions.signal, abort, onProgress: requestOptions.onProgress });
        requestOptions.signal?.addEventListener("abort", abort, { once: true });
        try { ensureWorker().postMessage({ type: "encode", requestId, text: normalized }); }
        catch (error) {
          rejectAll("worker_failed", error instanceof Error ? error.message : String(error), true);
          discardWorker();
        }
      });
    },
    cancel() { for (const requestId of [...active.keys()]) cancelRequest(requestId, "Text encoding was cancelled"); },
    dispose() { if (disposed) return; disposed = true; for (const requestId of [...active.keys()]) cancelRequest(requestId, "Text encoder client was disposed"); discardWorker(); },
  };
}
