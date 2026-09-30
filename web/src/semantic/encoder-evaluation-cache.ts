export type CacheStorageProbe = { available: true } | { available: false; error: string };

/** Checks the actual CacheStorage API without writing a synthetic cache entry. */
export async function probeCacheStorage(cacheStorage: Pick<CacheStorage, "keys"> | undefined): Promise<CacheStorageProbe> {
  if (!cacheStorage) return { available: false, error: "CacheStorage is not exposed by this browser context" };
  try {
    await cacheStorage.keys();
    return { available: true };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
