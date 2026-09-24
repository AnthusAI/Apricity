// Cargo runner for wasm32-wasip1: runs a .wasm under Node's built-in WASI (V8, same engine as Chrome).
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";
import { argv, env, exit } from "node:process";

const [file, ...args] = argv.slice(2);
const wasi = new WASI({ version: "preview1", args: [file, ...args], env, preopens: { "/": "/" }, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(file));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
exit(wasi.start(instance));
