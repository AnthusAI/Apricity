export interface Apricity {
  exports: Record<string, any> & { memory: WebAssembly.Memory };
  memory(): WebAssembly.Memory;
  withBytes<T>(s: string, f: (ptr: number, len: number) => T): T;
  withFloats<T>(a: Float32Array, f: (ptr: number) => T): T;
  result(): any;
  call(name: string, ...strings: string[]): any;
}
export function instantiate(module: WebAssembly.Module): Promise<Apricity>;
