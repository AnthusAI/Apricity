import {
  MAX_SEMANTIC_LIMIT,
  SEMANTIC_EMBEDDING_SPACE,
  validateSemanticVector,
  type SemanticKind,
  type SemanticSearchHit,
  type SemanticSearchRequest,
} from "./contracts";
import type { TextEncoderClient, TextEncoderProgress, TextEncoderResult } from "./text-client";
import type { SemanticSearchResponse } from "./contracts";

export type HybridSearchPhase = "idle" | "debouncing" | "loading_model" | "encoding" | "searching" | "ready" | "error";
export interface HybridSearchState {
  phase: HybridSearchPhase;
  query: string;
  hits?: SemanticSearchHit[];
  progress?: TextEncoderProgress;
  error?: unknown;
}
export interface HybridSearchFilters { kind?: SemanticKind; sampleId?: string; }
export interface HybridSearchSetOptions extends HybridSearchFilters { immediate?: boolean; }
export interface HybridTimerClock { setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void; }
export interface HybridSearchController {
  setQuery(query: string, options?: HybridSearchSetOptions): void;
  submit(query?: string, filters?: HybridSearchFilters): void;
  retry(): void;
  clear(): void;
  cancel(): void;
  dispose(): void;
}
export interface HybridSearchControllerOptions {
  /** Invoked synchronously for every setQuery/submit call, before semantic scheduling. */
  onLexical?: (query: string) => void;
  onState?: (state: HybridSearchState) => void;
  timerClock?: HybridTimerClock;
  /** Test/integration seam; production creates the pinned browser text client lazily. */
  createEncoderClient?: () => TextEncoderClient | Promise<TextEncoderClient>;
  /** Test/integration seam; production dynamically imports the configured semantic endpoint. */
  searchAudio?: SemanticSearchFunction;
}
type SemanticSearchFunction = (request: SemanticSearchRequest, options: { signal?: AbortSignal }) => Promise<SemanticSearchResponse>;

const DEBOUNCE_MS = 600;
const clock: HybridTimerClock = { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (handle) => clearTimeout(handle) };
const abortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError" || (error instanceof Error && error.name === "AbortError");

/**
 * Coordinates optional semantic results without changing lexical search.  It intentionally owns
 * no cache: the bounded shared query-vector cache belongs to the text encoder worker service.
 */
export function createHybridSearchController(options: HybridSearchControllerOptions): HybridSearchController {
  const timerClock = options.timerClock ?? clock;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let encoder: TextEncoderClient | undefined;
  let encoderLoading: Promise<TextEncoderClient> | undefined;
  let searchLoading: Promise<SemanticSearchFunction> | undefined;
  let query = "";
  let filters: HybridSearchFilters = {};
  let disposed = false;
  let failed: { query: string; filters: HybridSearchFilters } | undefined;

  const emit = (state: HybridSearchState) => { try { options.onState?.(state); } catch { /* A vanished UI callback must not create an unhandled async failure. */ } };
  const lexical = (text: string) => { try { options.onLexical?.(text); } catch { /* Semantic lifecycle remains isolated from lexical UI callback failures. */ } };
  const idle = () => emit({ phase: "idle", query });
  const current = (value: number) => !disposed && value === generation;
  const invalidate = () => {
    generation++;
    if (timer !== undefined) { timerClock.clearTimeout(timer); timer = undefined; }
    abort?.abort(); abort = undefined;
    return generation;
  };
  const loadEncoder = async () => {
    if (encoder) return encoder;
    if (!encoderLoading) {
      const loading = options.createEncoderClient
        ? Promise.resolve().then(options.createEncoderClient)
        : import("./text-client").then(({ createTextEncoderClient }) => createTextEncoderClient());
      encoderLoading = loading;
      void loading.catch(() => { if (encoderLoading === loading) encoderLoading = undefined; });
    }
    const loaded = await encoderLoading;
    if (disposed) { loaded.dispose(); throw new DOMException("The operation was aborted", "AbortError"); }
    encoder = loaded;
    return encoder;
  };
  const loadSearch = async () => {
    if (options.searchAudio) return options.searchAudio;
    if (!searchLoading) {
      const loading = import("../data/semantic").then(({ searchAudio }) => searchAudio);
      searchLoading = loading;
      void loading.catch(() => { if (searchLoading === loading) searchLoading = undefined; });
    }
    return searchLoading;
  };

  const run = async (value: number, text: string, requestFilters: HybridSearchFilters) => {
    if (!current(value) || !text.trim()) return;
    const controller = new AbortController(); abort = controller;
    emit({ phase: "loading_model", query: text });
    try {
      const client = await loadEncoder();
      if (!current(value)) return;
      emit({ phase: "encoding", query: text });
      const result: TextEncoderResult = await client.encode(text.trim(), {
        signal: controller.signal,
        onProgress: (progress) => { if (current(value)) emit({ phase: "encoding", query: text, progress }); },
      });
      if (!current(value)) return;
      if (result.embeddingSpace !== SEMANTIC_EMBEDDING_SPACE) throw new TypeError("Text encoder embedding space does not match the semantic contract");
      // validate rather than normalize: a malformed producer must never reach the endpoint.
      const queryVector = validateSemanticVector(result.vector);
      if (!current(value)) return;
      emit({ phase: "searching", query: text });
      const searchAudio = await loadSearch();
      if (!current(value)) return;
      const resultSet = await searchAudio({ queryVector, embeddingSpace: SEMANTIC_EMBEDDING_SPACE, ...requestFilters, limit: MAX_SEMANTIC_LIMIT }, { signal: controller.signal });
      if (!current(value)) return;
      emit({ phase: "ready", query: text, hits: resultSet.hits });
      failed = undefined;
    } catch (error) {
      if (!current(value) || controller.signal.aborted || abortError(error)) return;
      failed = { query: text, filters: requestFilters };
      emit({ phase: "error", query: text, error });
    } finally {
      if (current(value) && abort === controller) abort = undefined;
    }
  };
  const schedule = (text: string, requestFilters: HybridSearchFilters, immediate: boolean) => {
    const value = invalidate();
    failed = undefined;
    if (!text.trim()) { idle(); return; }
    if (immediate) { void run(value, text, requestFilters); return; }
    emit({ phase: "debouncing", query: text });
    timer = timerClock.setTimeout(() => { timer = undefined; void run(value, text, requestFilters); }, DEBOUNCE_MS);
  };
  const assertLive = () => { if (disposed) throw new Error("Hybrid search controller is disposed"); };

  const setQuery = (text: string, setOptions: HybridSearchSetOptions = {}) => {
    assertLive();
    query = text;
    filters = { ...(setOptions.kind === undefined ? {} : { kind: setOptions.kind }), ...(setOptions.sampleId === undefined ? {} : { sampleId: setOptions.sampleId }) };
    lexical(text);
    schedule(text, filters, setOptions.immediate === true);
  };
  return {
    setQuery,
    submit(text, nextFilters) {
      assertLive();
      const submitted = text ?? query;
      const applied = nextFilters ?? filters;
      setQuery(submitted, { ...applied, immediate: true });
    },
    retry() {
      assertLive();
      if (!failed) return;
      query = failed.query; filters = failed.filters;
      schedule(query, filters, true);
    },
    clear() { assertLive(); query = ""; filters = {}; failed = undefined; invalidate(); idle(); },
    cancel() { assertLive(); failed = undefined; invalidate(); idle(); },
    dispose() {
      if (disposed) return;
      invalidate(); disposed = true; failed = undefined;
      encoder?.dispose();
      // There is deliberately no terminal "disposed" phase; disposal is not a UI result.
      emit({ phase: "idle", query });
    },
  };
}
