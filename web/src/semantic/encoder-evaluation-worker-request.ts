import type { EncoderEvent } from "./encoder";

export const WORKER_REQUEST_TIMEOUT_MS = 120_000;

export interface WorkerLike {
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  postMessage(message: unknown): void;
}

export interface RequestTimer {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
}

const browserTimer: RequestTimer = { set: (callback, delayMs) => setTimeout(callback, delayMs), clear: (timer) => clearTimeout(timer) };

export function requestWorkerEncoding(
  worker: WorkerLike,
  request: { requestId: string; text: string; bypassCache: boolean },
  onProgress: (event: Extract<EncoderEvent, { type: "progress" }>) => void,
  options: { now?: () => number; timeoutMs?: number; timer?: RequestTimer } = {},
): Promise<{ vector: number[]; ms: number }> {
  const started = (options.now ?? performance.now.bind(performance))();
  const timer = options.timer ?? browserTimer;
  const timeoutMs = options.timeoutMs ?? WORKER_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
      worker.removeEventListener("messageerror", fail);
      if (timeout !== undefined) timer.clear(timeout);
    };
    const settle = (action: () => void) => { cleanup(); action(); };
    const fail = (event: Event) => {
      const message = (event as unknown as { message?: unknown }).message;
      const detail = typeof message === "string" && message
        ? message
        : "Worker failed before returning an encoder result";
      settle(() => reject(new Error(detail)));
    };
    const receive = (event: Event) => {
      const message = (event as MessageEvent<EncoderEvent>).data;
      if (!message || message.requestId !== request.requestId) return;
      if (message.type === "progress") { onProgress(message); return; }
      if (message.type === "result") settle(() => resolve({ vector: message.vector, ms: (options.now ?? performance.now.bind(performance))() - started }));
      else settle(() => reject(new Error(message.message)));
    };
    worker.addEventListener("message", receive);
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    timeout = timer.set(() => settle(() => reject(new Error(`Worker inference timed out after ${timeoutMs}ms`))), timeoutMs);
    try { worker.postMessage({ type: "encode", ...request }); }
    catch (error) { settle(() => reject(error instanceof Error ? error : new Error(String(error)))); }
  });
}
