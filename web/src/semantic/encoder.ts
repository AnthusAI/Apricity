/**
 * Pinned, text-only CLAP encoder used by the browser feasibility harness.
 * Nothing in this module loads the model until an `encode` request arrives.
 */
export const CLAP_BROWSER_MANIFEST = {
  embeddingSpace: "clap-htsat-unfused-512-v1",
  modelId: "Xenova/clap-htsat-unfused",
  revision: "c28f2883575e590e04d3146ff0713c2448d691ba",
  runtime: "@huggingface/transformers@3.8.1",
  architecture: "ClapTextModelWithProjection",
  dtype: "fp32",
  device: "wasm",
  textOnly: true,
  assets: ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/text_model.onnx"],
} as const;

export type EncoderRequest =
  | { type: "encode"; requestId: string; text: string; bypassCache?: boolean }
  | { type: "cancel"; requestId: string };

export type EncoderEvent =
  | { type: "progress"; requestId: string; loaded: number; total?: number; phase: string }
  | { type: "result"; requestId: string; embeddingSpace: typeof CLAP_BROWSER_MANIFEST.embeddingSpace; vector: number[] }
  | { type: "error"; requestId: string; code: string; message: string; retryable: boolean };

export interface TextEncoderRuntime {
  encode(text: string): Promise<ArrayLike<number>>;
}

export type RuntimeLoader = (progress: (event: Omit<Extract<EncoderEvent, { type: "progress" }>, "type" | "requestId">) => void) => Promise<TextEncoderRuntime>;

export interface EncoderService {
  handle(request: EncoderRequest): Promise<void>;
}

const DIMENSIONS = 512;
const MIN_NORM = 1e-9;
const CACHE_LIMIT = 128;

export function normalizeEmbedding(value: ArrayLike<number> | undefined): number[] {
  if (!value || value.length !== DIMENSIONS) throw new Error("Embedding must contain 512 finite values");
  const vector = Array.from(value);
  if (!vector.every(Number.isFinite)) throw new Error("Embedding must contain 512 finite values");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm <= MIN_NORM) throw new Error("Embedding is near-zero");
  return vector.map((item) => item / norm);
}

/** Dependency injection keeps protocol tests deterministic and model-free. */
export function createEncoderService(options: { post: (event: EncoderEvent) => void; loadRuntime?: RuntimeLoader }): EncoderService {
  const loadRuntime = options.loadRuntime ?? loadPinnedClapTextRuntime;
  const cancelled = new Set<string>();
  const activeSubscriptions = new Set<string>();
  const cache = new Map<string, number[]>();
  let runtime: Promise<TextEncoderRuntime> | undefined;
  const post = (event: EncoderEvent) => { try { options.post(event); } catch { /* A worker post failure must not strand service state. */ } };

  const remember = (key: string, vector: number[]) => {
    cache.delete(key);
    cache.set(key, vector);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  };

  return {
    async handle(request) {
      if (request.type === "cancel") {
        if (activeSubscriptions.has(request.requestId)) {
          cancelled.add(request.requestId);
          activeSubscriptions.delete(request.requestId);
        }
        return;
      }

      const text = request.text.trim();
      if (!text) {
        post({ type: "error", requestId: request.requestId, code: "empty_text", message: "Text is required", retryable: false });
        return;
      }
      cancelled.delete(request.requestId);
      activeSubscriptions.add(request.requestId);
      const key = `${JSON.stringify(CLAP_BROWSER_MANIFEST)}:${text}`;
      try {
        let vector = request.bypassCache ? undefined : cache.get(key);
        if (vector) remember(key, vector);
        if (!vector) {
          runtime ??= loadRuntime((progress) => {
            for (const requestId of activeSubscriptions) post({ type: "progress", requestId, ...progress });
          });
          let loaded: TextEncoderRuntime;
          try {
            loaded = await runtime;
          } catch (error) {
            runtime = undefined;
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "model_load_failed" });
          }
          vector = normalizeEmbedding(await loaded.encode(text));
          if (!request.bypassCache) remember(key, vector);
        }
        if (!cancelled.has(request.requestId)) {
          post({ type: "result", requestId: request.requestId, embeddingSpace: CLAP_BROWSER_MANIFEST.embeddingSpace, vector: [...vector] });
        }
      } catch (error) {
        if (cancelled.has(request.requestId)) return;
        const detail = error instanceof Error ? error : new Error(String(error));
        post({
          type: "error",
          requestId: request.requestId,
          code: typeof (detail as Error & { code?: unknown }).code === "string" ? (detail as Error & { code: string }).code : "inference_failed",
          message: detail.message,
          retryable: (detail as Error & { retryable?: boolean }).retryable ?? true,
        });
      } finally {
        activeSubscriptions.delete(request.requestId);
        // Cancellation is transient state, never an unbounded tombstone cache.
        cancelled.delete(request.requestId);
      }
    },
  };
}

/**
 * Dynamic import is deliberately inside this loader: importing the application
 * or creating the worker cannot download model code or weights.
 */
export const loadPinnedClapTextRuntime: RuntimeLoader = async (progress) => {
  const transformers: any = await import("@huggingface/transformers");
  const { createModelCache } = await import("./model-cache");
  transformers.env.backends.onnx.wasm.proxy = false;
  transformers.env.backends.onnx.wasm.numThreads = 1;
  // Transformers.js documents this Cache API-shaped hook. It lets blocked
  // persistent storage degrade to downloads/memory rather than inference failure.
  transformers.env.useBrowserCache = false;
  transformers.env.useCustomCache = true;
  transformers.env.customCache = createModelCache({ onProgress: progress });
  const options = {
    revision: CLAP_BROWSER_MANIFEST.revision,
    dtype: CLAP_BROWSER_MANIFEST.dtype,
    device: CLAP_BROWSER_MANIFEST.device,
    progress_callback: (event: { loaded?: number; total?: number; status?: string; file?: string }) => {
      const loaded = Number.isFinite(event.loaded) ? event.loaded! : 0;
      const total = Number.isFinite(event.total) ? event.total : undefined;
      try { progress({ loaded, total, phase: typeof event.status === "string" ? event.status : typeof event.file === "string" ? event.file : "loading" }); } catch { /* Progress observers cannot interrupt model loading. */ }
    },
  };
  const [tokenizer, model] = await Promise.all([
    transformers.AutoTokenizer.from_pretrained(CLAP_BROWSER_MANIFEST.modelId, options),
    transformers.ClapTextModelWithProjection.from_pretrained(CLAP_BROWSER_MANIFEST.modelId, options),
  ]);
  return {
    async encode(text) {
      const inputs = await tokenizer(text, { padding: true, truncation: true });
      const output = await model(inputs);
      const embedding = output.text_embeds?.data ?? output.text_embeds;
      if (!embedding) throw new Error("Pinned CLAP text projection was not returned");
      return embedding;
    },
  };
};
