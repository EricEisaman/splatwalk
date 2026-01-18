// Shared type definitions for WASM modules

export interface WasmModuleBase {
  memory: WebAssembly.Memory;
}

// Generic WASM module type
export type WasmModule<T extends WasmModuleBase> = T;

// Type guard helper
export function hasMemory(obj: unknown): obj is { memory: WebAssembly.Memory } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'memory' in obj &&
    obj.memory instanceof WebAssembly.Memory
  );
}

// Error types for WASM operations
export class WasmLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WasmLoadError';
  }
}

export class WasmInitError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WasmInitError';
  }
}

