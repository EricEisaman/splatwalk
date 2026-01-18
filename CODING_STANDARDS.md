# Coding Standards

This document outlines the coding standards and rules enforced in this project.

## TypeScript Rules

### Type Safety
- **NO `any` types** - Always use proper types. If you need a truly unknown type, use `unknown` with proper type guards.
- **NO type casts** - Avoid `as` assertions. Use type guards, discriminated unions, or proper type narrowing instead.
- **NO non-null assertions (`!`)** - Use proper null checks and type guards. Never use the `!` operator.
- **NO user-defined type guards** - TypeScript doesn't verify that your narrowing logic is correct, making them dangerous. Use built-in type guards like `instanceof`, `typeof`, or discriminated unions.

### Timing & Async
- **NO `setTimeout` or `setInterval`** - Use `requestAnimationFrame` or event-driven patterns instead.
- Prefer event-driven architecture over polling.

### Type Design
- **Prefer discriminated unions** over simple union types where appropriate.
- Use proper type narrowing instead of type assertions.

### Code Quality
- **NO unused variables** - All declared variables must be used.
- **NO custom CSS files** - Use existing CSS or utility classes.
- **NO inline CSS** - Keep all styles in separate stylesheet files.
- **NO dynamic imports** - Use static imports only.

## Enforcement

These rules are automatically enforced through:

1. **TypeScript Compiler** - Strict mode with all strict flags enabled
2. **ESLint** - Custom rules in `.eslintrc.json`
3. **Code Review** - Manual review for compliance
4. **CI/CD** - Automated linting in build pipeline

## Examples

### Type Casts

❌ **Bad:**
```typescript
const element = document.getElementById('foo') as HTMLElement;
```

✅ **Good:**
```typescript
const element = document.getElementById('foo');
if (element instanceof HTMLElement) {
  // use element safely
}
```

### Timeouts

❌ **Bad:**
```typescript
setTimeout(() => doSomething(), 100);
```

✅ **Good:**
```typescript
requestAnimationFrame(() => doSomething());
```

### Non-null Assertions

❌ **Bad:**
```typescript
const value = obj!.property;
```

✅ **Good:**
```typescript
if (obj) {
  const value = obj.property;
}
```

### Discriminated Unions

❌ **Bad: Simple union**
```typescript
type Result = string | number;
```

✅ **Good: Discriminated union**
```typescript
type Result = 
  | { type: 'success'; value: string }
  | { type: 'error'; message: string };
```

## Agent Decision Framework

Before implementing any change, plan, or action, agents MUST consider:

1. **Can this be simplified?**
   - Is there a simpler approach?
   - Can we reduce complexity?

2. **Should these changes be generalized?**
   - Is this logic reusable?
   - Should this be a utility function?
   - Will other parts benefit from this?

3. **Does it follow current patterns?**
   - Is this consistent with existing code?
   - Should refactoring be separate from bug fixes?

4. **Is it using existing dependencies?**
   - Are we duplicating functionality?
   - Can we use existing utilities?

5. **Can we use proven libraries?**
   - Should we use lodash or similar?
   - Is there a well-maintained dependency?
   - Will it reduce maintenance burden?

See `.cursorrules` for the complete agent framework.

---

## WASM Integration Patterns

This project uses a consistent pattern for integrating Rust WASM modules with TypeScript. All route handlers follow this pattern.

### WASM Module Loading Pattern

**Standard Pattern** (from `src/routes/babylon-wfc.ts`):

```typescript
// 1. Store module as Record after validation
let wasmModuleRecord: Record<string, unknown> | null = null;

// 2. Dynamic import with validation
const getInitWasm = async (): Promise<unknown> => {
  if (!wasmModuleRecord) {
    const moduleUnknown: unknown = await import('../../pkg/wasm_babylon_wfc/wasm_babylon_wfc.js');
    
    // 3. Runtime validation - check module is object
    if (typeof moduleUnknown !== 'object' || moduleUnknown === null) {
      throw new Error('Imported module is not an object');
    }
    
    // 4. Validate required exports exist and are functions
    if (!('generate_layout' in moduleUnknown) || typeof moduleUnknown.generate_layout !== 'function') {
      throw new Error('Module missing required export');
    }
    
    // 5. Store as Record after validation
    wasmModuleRecord = moduleUnknown as Record<string, unknown>;
  }
  
  // 6. Call default export (validated above)
  const defaultFunc = wasmModuleRecord.default;
  if (typeof defaultFunc !== 'function') {
    throw new Error('default export is not a function');
  }
  
  return defaultFunc();
};

// 7. Load and validate module
const wasmModule = await loadWasmModule<WasmModuleBabylonWfc>(
  getInitWasm,
  validateBabylonWfcModule
);
```

**Key Learning Points**:
- Never trust dynamic imports - always validate at runtime
- Check types before using (typeof, instanceof)
- Store validated modules to avoid re-validation
- Use TypeScript interfaces to define expected exports
- Runtime validation ensures type safety without type assertions

### Type-Safe WASM Interop

**Validation Function Pattern** (from `src/routes/babylon-wfc.ts`):

```typescript
function validateBabylonWfcModule(exports: unknown): WasmModuleBabylonWfc | null {
  // 1. Validate base WASM module
  if (!validateWasmModule(exports)) {
    return null;
  }
  
  // 2. Check exports is object
  if (typeof exports !== 'object' || exports === null) {
    return null;
  }
  
  // 3. Validate memory
  const memoryValue = getProperty(exports, 'memory');
  if (!memoryValue || !(memoryValue instanceof WebAssembly.Memory)) {
    return null;
  }
  
  // 4. Validate functions from wasmModuleRecord
  if (!wasmModuleRecord) {
    return null;
  }
  
  const generateLayoutFunc = wasmModuleRecord.generate_layout;
  if (typeof generateLayoutFunc !== 'function') {
    return null;
  }
  
  // 5. Construct typed module object
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    memory,
    generate_layout: generateLayoutFunc as () => void,
    // ... other functions
  };
}
```

**Key Learning Points**:
- Validate all exports before use
- Use `getProperty` helper for safe property access
- Check types with `typeof` and `instanceof`
- Only use type assertions after runtime validation
- Return `null` on validation failure, let caller handle it

### Error Handling for WASM Modules

**Pattern** (from `src/routes/babylon-wfc.ts`):

```typescript
try {
  const wasmModule = await loadWasmModule<WasmModuleBabylonWfc>(
    getInitWasm,
    validateBabylonWfcModule
  );
  
  if (!wasmModule) {
    throw new WasmInitError('WASM module failed validation');
  }
  
  // Use module...
} catch (error) {
  if (errorEl) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (error instanceof WasmLoadError) {
      errorEl.textContent = `Failed to load WASM module: ${errorMsg}`;
    } else if (error instanceof WasmInitError) {
      errorEl.textContent = `WASM module initialization failed: ${errorMsg}`;
    } else {
      errorEl.textContent = `Error: ${errorMsg}`;
    }
  }
  throw error;
}
```

**Key Learning Points**:
- Always handle WASM loading errors gracefully
- Provide user-friendly error messages
- Use specific error types (WasmLoadError, WasmInitError)
- Check error types with `instanceof` (not type assertions)
- Display errors in UI, don't just log them

---

## Route Handler Patterns

All route handlers in this project follow a consistent structure.

### Standard Route Handler Structure

**Pattern** (from `src/routes/babylon-wfc.ts`):

```typescript
// 1. Imports
import type { WasmModuleBabylonWfc } from '../types';
import { loadWasmModule, validateWasmModule } from '../wasm/loader';

// 2. WASM module loading function
let wasmModuleRecord: Record<string, unknown> | null = null;

const getInitWasm = async (): Promise<unknown> => {
  // ... module loading logic
};

// 3. Validation function
function validateBabylonWfcModule(exports: unknown): WasmModuleBabylonWfc | null {
  // ... validation logic
}

// 4. Global state
const WASM_BABYLON_WFC: WasmBabylonWfc = {
  wasmModule: null,
  wasmModulePath: '../pkg/wasm_babylon_wfc',
};

// 5. Helper functions
function tileTypeFromNumber(tileNum: number): TileType | null {
  // ... conversion logic
}

// 6. Main init function
export const init = async (): Promise<void> => {
  // Get UI elements
  const errorEl = document.getElementById('error');
  const canvasEl = document.getElementById('renderCanvas');
  
  // Validate UI elements
  if (!canvasEl || !(canvasEl instanceof HTMLCanvasElement)) {
    throw new Error('Required UI elements not found');
  }
  
  // Load WASM module
  try {
    const wasmModule = await loadWasmModule<WasmModuleBabylonWfc>(
      getInitWasm,
      validateBabylonWfcModule
    );
    // ... initialization
  } catch (error) {
    // ... error handling
  }
  
  // Set up rendering/UI
  // ...
};
```

**Key Learning Points**:
- Always validate UI elements before use
- Use `instanceof` checks for DOM elements
- Load WASM modules in try-catch blocks
- Provide user-friendly error messages
- Separate concerns: loading, validation, initialization, rendering

### UI Element Handling Pattern

**Pattern** (from `src/routes/babylon-wfc.ts`):

```typescript
// 1. Get elements with validation
const promptInputEl = document.getElementById('layoutPromptInput');
const generateFromTextBtn = document.getElementById('generateFromTextBtn');

// 2. Validate elements exist
if (generateFromTextBtn && promptInputEl) {
  // 3. Add event listeners
  generateFromTextBtn.addEventListener('click', () => {
    // 4. Validate element types before use
    const prompt = promptInputEl instanceof HTMLInputElement 
      ? promptInputEl.value.trim() 
      : '';
    
    if (prompt) {
      // 5. Handle async operations
      generateLayoutFromText(prompt, renderGrid, errorEl, modelStatusEl)
        .catch((error) => {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          if (errorEl) {
            errorEl.textContent = `Error: ${errorMsg}`;
          }
        });
    }
  });
}
```

**Key Learning Points**:
- Always check elements exist before using
- Use `instanceof` to narrow element types
- Handle async operations with `.catch()`
- Provide error feedback to users
- Validate input before processing

---

## Type Safety Examples from Project

### Discriminated Union Usage

**Example** (from `src/types.ts`):

```typescript
// Tile type discriminated union
export type TileType =
  | { type: 'grass' }
  | { type: 'building' }
  | { type: 'road' }
  | { type: 'forest' }
  | { type: 'water' };

// Usage with type narrowing
function getTileColor(tileType: TileType): Color3 {
  switch (tileType.type) {
    case 'grass':
      return new Color3(0.2, 0.8, 0.2); // Green
    case 'building':
      return new Color3(0.5, 0.5, 0.5); // Gray
    case 'road':
      return new Color3(0.3, 0.3, 0.3); // Dark gray
    case 'forest':
      return new Color3(0.1, 0.5, 0.1); // Dark green
    case 'water':
      return new Color3(0.2, 0.4, 0.8); // Blue
  }
}
```

**Key Learning Points**:
- Discriminated unions enable exhaustive type checking
- Switch statements with discriminated unions are type-safe
- TypeScript ensures all cases are handled
- No type assertions needed

### Proper Type Narrowing

**Example** (from `src/routes/babylon-wfc.ts`):

```typescript
// Parse layout constraints with proper narrowing
function parseLayoutConstraints(output: string): LayoutConstraints {
  // Try JSON parsing first
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      
      // Narrow to object type
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const entries: Array<[string, unknown]> = Object.entries(parsed);
        
        // Find and validate each field
        const densityEntry = entries.find(([key]) => key === 'buildingDensity');
        const density = densityEntry && typeof densityEntry[1] === 'string' 
          ? densityEntry[1] 
          : null;
        
        // Validate value is one of allowed values
        if (density && (density === 'sparse' || density === 'medium' || density === 'dense')) {
          // Type is now narrowed to 'sparse' | 'medium' | 'dense'
          return {
            buildingDensity: density, // Type-safe!
            // ... other fields
          };
        }
      }
    }
  } catch {
    // Fall back to regex parsing
  }
  
  // Regex fallback with defaults
  // ...
}
```

**Key Learning Points**:
- Use `typeof` and `instanceof` for type narrowing
- Check array vs object with `!Array.isArray()`
- Validate enum-like values with explicit checks
- Narrow types progressively, not all at once
- Provide fallbacks when parsing fails

### Runtime Validation Before Type Assertion

**Example** (from `src/routes/babylon-wfc.ts`):

```typescript
// Validate before storing
if (!('generate_layout' in moduleUnknown) || typeof moduleUnknown.generate_layout !== 'function') {
  throw new Error('Module missing required export');
}

// Only after validation, store with type assertion
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
wasmModuleRecord = moduleUnknown as Record<string, unknown>;

// Later, validate again before use
const generateLayoutFunc = wasmModuleRecord.generate_layout;
if (typeof generateLayoutFunc !== 'function') {
  return null;
}

// Only after second validation, use with type assertion
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
generate_layout: generateLayoutFunc as () => void,
```

**Key Learning Points**:
- Always validate before type assertion
- Validate multiple times if needed
- Use `eslint-disable` comments only after thorough validation
- Document why assertion is safe (validation ensures it)
- Prefer runtime checks over type assertions

---

## Project-Specific Patterns

### State Management Pattern (Rust)

**Pattern** (from `wasm-babylon-wfc/src/lib.rs`):

```rust
use std::sync::{LazyLock, Mutex};
use std::collections::HashMap;

struct WfcState {
    grid: HashMap<(i32, i32), TileType>,
    pre_constraints: HashMap<(i32, i32), TileType>,
}

static WFC_STATE: LazyLock<Mutex<WfcState>> = LazyLock::new(|| Mutex::new(WfcState::new()));
```

**Key Learning Points**:
- `LazyLock` provides thread-safe lazy initialization
- `Mutex` ensures safe concurrent access
- Global state pattern for WASM modules
- Used consistently across all WASM modules

### Error Handling Pattern

**Pattern** (from `src/routes/babylon-wfc.ts`):

```typescript
try {
  // Operation that might fail
  await someAsyncOperation();
} catch (error) {
  // Always check error type
  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
  
  // Display to user
  if (errorEl) {
    errorEl.textContent = `Error: ${errorMsg}`;
  }
  
  // Re-throw if needed
  throw error;
}
```

**Key Learning Points**:
- Always handle errors gracefully
- Check error types with `instanceof`
- Provide user-friendly messages
- Re-throw if error should propagate
- Never use `any` for error types
