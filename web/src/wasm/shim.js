// Load apricity_web.wasm anywhere (page, Worker, AudioWorklet, Node) with just enough WASI
// preview1 to run: no files, no environment; stdout/stderr go to the console.

const EBADF = 8, ENOSYS = 52;

function wasiImports(getMemory) {
  const view = () => new DataView(getMemory().buffer);
  // TextDecoder and crypto are missing from AudioWorkletGlobalScope in some browsers.
  const decode = (bytes) => (typeof TextDecoder !== "undefined" ? new TextDecoder().decode(bytes) : String.fromCharCode(...bytes));
  let line = "";
  let ticks = 0n;
  return {
    wasi_snapshot_preview1: {
      environ_sizes_get(countPtr, sizePtr) { view().setUint32(countPtr, 0, true); view().setUint32(sizePtr, 0, true); return 0; },
      environ_get() { return 0; },
      clock_time_get(_id, _prec, outPtr) {
        const now = typeof performance !== "undefined" ? BigInt(Math.round(performance.now() * 1e6)) : (ticks += 1000n);
        view().setBigUint64(outPtr, now, true);
        return 0;
      },
      random_get(ptr, len) {
        const bytes = new Uint8Array(getMemory().buffer, ptr, len);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
        else for (let i = 0; i < len; i++) bytes[i] = (Math.random() * 256) | 0;
        return 0;
      },
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        const v = view();
        let n = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
          line += decode(new Uint8Array(getMemory().buffer, ptr, len).slice());
          n += len;
        }
        const parts = line.split("\n");
        line = parts.pop();
        for (const p of parts) (fd === 2 ? console.error : console.log)("[apricity]", p);
        v.setUint32(nwrittenPtr, n, true);
        return 0;
      },
      fd_close: () => EBADF, fd_fdstat_get: () => EBADF, fd_prestat_get: () => EBADF,
      fd_prestat_dir_name: () => EBADF, fd_read: () => EBADF, fd_seek: () => ENOSYS,
      proc_exit(code) { throw new Error(`apricity wasm exited (${code})`); },
    },
  };
}

const utf8 = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s) : Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0)));

/** Instantiate a compiled WebAssembly.Module and wrap it with string/float helpers. */
export async function instantiate(module) {
  let instance;
  instance = await WebAssembly.instantiate(module, wasiImports(() => instance.exports.memory));
  const x = instance.exports;
  x._initialize?.();
  const memory = () => x.memory;

  /** Copy a string into wasm memory for the duration of f(ptr, len). */
  function withBytes(str, f) {
    const bytes = utf8(str);
    const p = x.rw_alloc_bytes(bytes.length || 1);
    new Uint8Array(memory().buffer, p, bytes.length).set(bytes);
    try { return f(p, bytes.length); } finally { x.rw_free_bytes(p, bytes.length || 1); }
  }

  /** Copy floats into wasm memory for the duration of f(ptr). */
  function withFloats(arr, f) {
    const p = x.rw_alloc(arr.length || 1);
    new Float32Array(memory().buffer, p, arr.length).set(arr);
    try { return f(p); } finally { x.rw_free(p, arr.length || 1); }
  }

  /** The JSON result of the last call that set one. */
  function result() {
    const bytes = new Uint8Array(memory().buffer, x.rw_result_ptr(), x.rw_result_len()).slice();
    return JSON.parse(typeof TextDecoder !== "undefined" ? new TextDecoder().decode(bytes) : decodeURIComponent(escape(String.fromCharCode(...bytes))));
  }

  /** Call an export whose arguments are all strings and which sets a JSON result. */
  function call(name, ...strings) {
    const go = (i, args) => (i === strings.length ? x[name](...args) : withBytes(strings[i], (p, n) => go(i + 1, [...args, p, n])));
    go(0, []);
    return result();
  }

  return { exports: x, memory, withBytes, withFloats, result, call };
}
