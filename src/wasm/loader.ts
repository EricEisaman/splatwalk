import { WasmLoadError, WasmInitError, type WasmModuleBase } from './types';

/**
 * Type-safe WASM module loader
 * @param initFn - Function that initializes the WASM module
 * @param validateExports - Function that validates and returns typed exports or null
 * @returns Initialized WASM module with type safety
 */
export async function loadWasmModule<T extends WasmModuleBase>(
  initFn: () => Promise<unknown>,
  validateExports: (exports: unknown) => T | null
): Promise<T> {
  try {
    const initResult = await initFn();
    const validated = validateExports(initResult);
    
    if (!validated) {
      throw new WasmInitError('WASM module does not have expected exports');
    }
    
    return validated;
  } catch (error) {
    if (error instanceof WasmInitError) {
      throw error;
    }
    const errorMessage = error instanceof Error 
      ? error.message 
      : String(error);
    throw new WasmLoadError(`Failed to load WASM module: ${errorMessage}`, error);
  }
}

/**
 * Helper to validate WASM module has memory
 */
export function validateWasmModule(exports: unknown): boolean {
  return (
    typeof exports === 'object' &&
    exports !== null &&
    'memory' in exports &&
    exports.memory instanceof WebAssembly.Memory
  );
}

