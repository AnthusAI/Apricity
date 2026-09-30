/** Cache API-compatible wrapper for Transformers.js model assets.
 *
 * Storage is an optimization only: every failure is converted to a cache miss
 * so a blocked CacheStorage/IndexedDB implementation cannot block inference.
 */
export type CacheProgress = { phase: "cache_unavailable"; loaded: 0; detail: string };

type ModelCache = Pick<Cache, "match" | "put">;
type CacheStorageLike = { open(name: string): Promise<ModelCache> };
type IndexedDbLike = Pick<IDBFactory, "open">;
type Timer = (callback: () => void, delay: number) => unknown;

export function createModelCache(options: {
  cacheStorage?: CacheStorageLike;
  indexedDB?: IndexedDbLike;
  onProgress?: (event: CacheProgress) => void;
  /** Bound storage work so a browser privacy prompt cannot stall inference. */
  timeoutMs?: number;
  setTimeout?: Timer;
  clearTimeout?: (timer: unknown) => void;
} = {}): ModelCache {
  const cacheStorage = options.cacheStorage ?? (typeof caches === "undefined" ? undefined : caches);
  const indexedDB = options.indexedDB ?? (typeof globalThis.indexedDB === "undefined" ? undefined : globalThis.indexedDB);
  let unavailable = false;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const setTimer = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const bounded = <T>(operation: Promise<T>, label: string): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: unknown;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        callback();
      };
      timer = setTimer(() => finish(() => reject(new Error(`${label} timed out`))), timeoutMs);
      operation.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
  };
  const reportUnavailable = (error: unknown) => {
    if (unavailable) return;
    unavailable = true;
    options.onProgress?.({ phase: "cache_unavailable", loaded: 0, detail: error instanceof Error ? error.message : String(error) });
  };
  let backend: Promise<ModelCache | undefined> | undefined;
  const getBackend = () => backend ??= (async () => {
    try {
      if (cacheStorage) return await bounded(cacheStorage.open("apricity-clap-text-v1"), "CacheStorage open");
      throw new Error("CacheStorage is not exposed by this browser context");
    } catch (cacheError) {
      try {
        if (indexedDB) return await bounded(createIndexedDbCache(indexedDB, bounded), "IndexedDB open");
        throw cacheError;
      } catch (databaseError) {
        reportUnavailable(databaseError);
        return undefined;
      }
    }
  })();

  return {
    async match(request) {
      try { return await bounded((await getBackend())?.match(request) ?? Promise.resolve(undefined), "Model cache read"); }
      catch (error) { backend = Promise.resolve(undefined); reportUnavailable(error); return undefined; }
    },
    async put(request, response) {
      try { await bounded((await getBackend())?.put(request, response) ?? Promise.resolve(), "Model cache write"); }
      catch (error) { backend = Promise.resolve(undefined); reportUnavailable(error); }
    },
  };
}

/** Minimal IndexedDB fallback for browsers which expose it but block CacheStorage. */
function createIndexedDbCache(indexedDB: IndexedDbLike, bounded: <T>(operation: Promise<T>, label: string) => Promise<T>): Promise<ModelCache> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("apricity-clap-text-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("assets");
    request.onblocked = () => reject(new Error("IndexedDB model cache opening is blocked"));
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB model cache"));
    request.onsuccess = () => {
      const database = request.result;
      let closed = false;
      database.onversionchange = () => { closed = true; database.close(); };
      const keyOf = (input: RequestInfo | URL) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const requireOpen = () => {
        if (closed) throw new Error("IndexedDB model cache was closed for a version change");
      };
      resolve({
        match: (input) => bounded(new Promise<Response | undefined>((done, fail) => {
          try {
            requireOpen();
            const transaction = database.transaction("assets", "readonly");
            transaction.onerror = () => fail(transaction.error ?? new Error("Unable to read IndexedDB model cache"));
            transaction.onabort = () => fail(transaction.error ?? new Error("IndexedDB model cache read was aborted"));
            const read = transaction.objectStore("assets").get(keyOf(input));
            read.onerror = () => fail(read.error ?? new Error("Unable to read IndexedDB model cache"));
            read.onsuccess = () => {
              try {
                const value = read.result as { body: ArrayBuffer; headers: [string, string][] } | undefined;
                done(value ? new Response(value.body, { headers: value.headers }) : undefined);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        }), "IndexedDB model cache read"),
        put: async (input, response) => {
          await bounded((async () => {
            const body = await response.clone().arrayBuffer();
            await new Promise<void>((done, fail) => {
              try {
                requireOpen();
                const transaction = database.transaction("assets", "readwrite");
                transaction.onerror = () => fail(transaction.error ?? new Error("Unable to write IndexedDB model cache"));
                transaction.onabort = () => fail(transaction.error ?? new Error("IndexedDB model cache write was aborted"));
                transaction.oncomplete = () => done();
                transaction.objectStore("assets").put({ body, headers: [...response.headers.entries()] }, keyOf(input));
              } catch (error) { fail(error); }
            });
          })(), "IndexedDB model cache write");
        },
      });
    };
  });
}
