#!/bin/bash
set -e # If any command fails, script exits immediately

echo "==========================================================="
echo "BUILDING ALL WASM MODULES"
echo "==========================================================="

THIS_SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$THIS_SCRIPTS_DIR/.."

# Clean previous build
if [ -d "pkg" ]; then
    rm -rf "pkg"
fi

# Build the SplatWalk WASM module
echo "Building wasm-splatwalk..."
./scripts/build-wasm.sh wasm-splatwalk pkg/wasm_splatwalk

echo "==========================================================="
echo "VERIFYING WASM MODULES"
echo "==========================================================="

# Verify all modules were built successfully
MODULES=("wasm_splatwalk")
FAILED_MODULES=()

for module in "${MODULES[@]}"; do
    JS_FILE="pkg/$module/$module.js"
    WASM_FILE="pkg/$module/${module}_bg.wasm"
    
    # Check JS file exists and has reasonable size
    if [ ! -f "$JS_FILE" ]; then
        echo "ERROR: JS file not found: $JS_FILE" >&2
        FAILED_MODULES+=("$module (missing JS file)")
        continue
    fi
    
    JS_SIZE=$(stat -c%s "$JS_FILE" 2>/dev/null || stat -f%z "$JS_FILE" 2>/dev/null || echo "0")
    if [ "$JS_SIZE" -lt 100 ]; then
        echo "ERROR: JS file too small: $JS_FILE ($JS_SIZE bytes)" >&2
        FAILED_MODULES+=("$module (JS file too small: $JS_SIZE bytes)")
        continue
    fi
    
    # Check for exports
    if ! grep -q "export" "$JS_FILE"; then
        echo "ERROR: JS file has no exports: $JS_FILE" >&2
        FAILED_MODULES+=("$module (no exports)")
        continue
    fi
    
    # Check WASM file exists
    if [ ! -f "$WASM_FILE" ]; then
        echo "ERROR: WASM file not found: $WASM_FILE" >&2
        FAILED_MODULES+=("$module (missing WASM file)")
        continue
    fi
    
    WASM_SIZE=$(stat -c%s "$WASM_FILE" 2>/dev/null || stat -f%z "$WASM_FILE" 2>/dev/null || echo "0")
    
    EXPORT_COUNT=$(grep -c "export" "$JS_FILE" || echo "0")
    echo "✓ $module: JS ($JS_SIZE bytes, $EXPORT_COUNT exports), WASM ($WASM_SIZE bytes)"
done

if [ ${#FAILED_MODULES[@]} -gt 0 ]; then
    echo "" >&2
    echo "===========================================================" >&2
    echo "BUILD FAILED: The following modules are incomplete:" >&2
    echo "===========================================================" >&2
    for failed in "${FAILED_MODULES[@]}"; do
        echo "  - $failed" >&2
    done
    echo "" >&2
    echo "This indicates the rust-builder stage produced incomplete files." >&2
    echo "Check wasm-bindgen output and Docker build logs for errors." >&2
    exit 1
fi

echo "==========================================================="
echo "ALL WASM MODULES BUILT AND VERIFIED SUCCESSFULLY"
echo "==========================================================="
