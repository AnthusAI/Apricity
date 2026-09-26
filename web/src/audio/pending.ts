// Small pieces that keep the audio pipeline from hanging or staying broken: every wait can fail with a reason, a
// failed load can be tried again, and nothing waits forever. Pure (no Web Audio), so they are tested in
// test/pending.test.ts.

/** A failed step, in words ("the audio engine didn't start: …"). */
export class AudioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioFailure";
  }
}

/** Waiters keyed by id; `failAll` rejects every one of them (a worker died, the engine stopped). */
export class Pending<K, T> {
  private waiters = new Map<K, { resolve: (v: T) => void; reject: (e: Error) => void }>();

  wait(key: K): Promise<T> {
    return new Promise<T>((resolve, reject) => this.waiters.set(key, { resolve, reject }));
  }

  resolve(key: K, value: T) {
    const w = this.waiters.get(key);
    this.waiters.delete(key);
    w?.resolve(value);
  }

  reject(key: K, err: Error) {
    const w = this.waiters.get(key);
    this.waiters.delete(key);
    w?.reject(err);
  }

  failAll(err: Error) {
    const all = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of all) w.reject(err);
  }

  get size() {
    return this.waiters.size;
  }
}

/** A promise cached under `key` while it lasts; a rejected one is forgotten, so the next call tries again. */
export function once<K, T>(cache: Map<K, Promise<T>>, key: K, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
    p.catch(() => cache.get(key) === p && cache.delete(key));
  }
  return p;
}

/** Reject with "<what> took too long" if `p` hasn't settled in `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new AudioFailure(`${what} took too long (over ${Math.round(ms / 1000)} s)`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** An error as a short reason for a person. */
export function reasonOf(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m.trim() || "something went wrong";
}
