import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { requestWorkerEncoding, type RequestTimer, type WorkerLike } from "../src/semantic/encoder-evaluation-worker-request.ts";

class FakeWorker implements WorkerLike {
  readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  postMessage(_message: unknown) {}
  emit(type: "message" | "error" | "messageerror", data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ type, data, message: typeof data === "string" ? data : undefined } as unknown as Event); }
  count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

function manualTimer() {
  let callback: (() => void) | undefined;
  const timer: RequestTimer = { set: (next) => { callback = next; return 1 as unknown as ReturnType<typeof setTimeout>; }, clear: () => { callback = undefined; } };
  return { timer, fire: () => callback?.() };
}

describe("browser worker request", () => {
  it("rejects real worker startup and message deserialization errors and removes all listeners", async () => {
    for (const type of ["error", "messageerror"] as const) {
      const worker = new FakeWorker();
      const pending = requestWorkerEncoding(worker, { requestId: "one", text: "rain", bypassCache: false }, () => {}, { timer: manualTimer().timer });
      worker.emit(type, "worker startup failed");
      await assert.rejects(pending, /worker startup failed/);
      assert.equal(worker.count(), 0);
    }
  });

  it("rejects a missing result after a finite timeout and cleans up", async () => {
    const worker = new FakeWorker(); const clock = manualTimer();
    const pending = requestWorkerEncoding(worker, { requestId: "one", text: "rain", bypassCache: false }, () => {}, { timeoutMs: 9, timer: clock.timer });
    clock.fire();
    await assert.rejects(pending, /timed out after 9ms/);
    assert.equal(worker.count(), 0);
  });
});
