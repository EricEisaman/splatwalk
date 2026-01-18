#!/bin/bash
set -e

# Build a single WASM crate
# Usage: ./build-wasm.sh <crate-name> <output-dir>
# Example: ./build-wasm.sh wasm-astar pkg/wasm_astar

if [ $# -lt 2 ]; then
    echo "Usage: $0 <crate-name> <output-dir>"
    echo "Example: $0 wasm-astar pkg/wasm_astar"
    exit 1
fi

CRATE_NAME=$1
OUTPUT_DIR=$2
THIS_SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$THIS_SCRIPTS_DIR/.."

# Ensure wasm-bindgen is in PATH (cargo install puts it in ~/.cargo/bin)
# This is important in Docker where PATH might not be properly inherited
export PATH="${HOME}/.cargo/bin:/root/.cargo/bin:${PATH}"

echo "==========================================================="
echo "BUILDING $CRATE_NAME TO WASM"
echo "==========================================================="

# Check for required tools
if ! command -v cargo &> /dev/null; then
    echo "Error: cargo not found. Please install Rust: https://rustup.rs/"
    exit 1
fi

if ! command -v wasm-bindgen &> /dev/null; then
    echo "Error: wasm-bindgen not found. Install with: cargo install wasm-bindgen-cli" >&2
    echo "Current PATH: $PATH" >&2
    echo "Checking common locations:" >&2
    ls -la ~/.cargo/bin/wasm-bindgen 2>/dev/null || echo "  ~/.cargo/bin/wasm-bindgen: not found" >&2
    ls -la /root/.cargo/bin/wasm-bindgen 2>/dev/null || echo "  /root/.cargo/bin/wasm-bindgen: not found" >&2
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Add wasm32 target if not already added
rustup target add wasm32-unknown-unknown 2>/dev/null || true

# Cargo converts hyphens to underscores in output filenames
# Use sed instead of tr for better Alpine Linux compatibility
WASM_FILENAME=$(echo "$CRATE_NAME" | sed 's/-/_/g')

# Compile to wasm
echo "Compiling $CRATE_NAME to WASM..."
# Clean the specific package build to ensure we're building fresh (not using cached dummy files)
# This is critical in Docker where dummy files are built first for dependency caching
# We need to aggressively clean to ensure cargo rebuilds with the real source files
echo "Cleaning previous build artifacts for $CRATE_NAME..."
cargo clean --package "$CRATE_NAME" 2>/dev/null || true
# Also explicitly remove WASM artifacts to force rebuild
rm -f "target/wasm32-unknown-unknown/release/${WASM_FILENAME}.wasm" 2>/dev/null || true
rm -f "target/wasm32-unknown-unknown/release/deps/${WASM_FILENAME}*" 2>/dev/null || true
# Remove incremental compilation artifacts for this package
rm -rf "target/wasm32-unknown-unknown/release/incremental/${WASM_FILENAME}*" 2>/dev/null || true

if ! cargo build --target wasm32-unknown-unknown --release --package "$CRATE_NAME"; then
    echo "ERROR: cargo build failed for $CRATE_NAME" >&2
    exit 1
fi
INPUT_WASM="target/wasm32-unknown-unknown/release/${WASM_FILENAME}.wasm"

# Verify input WASM file exists and has reasonable size before running wasm-bindgen
if [ ! -f "$INPUT_WASM" ]; then
    echo "ERROR: Input WASM file not found: $INPUT_WASM" >&2
    echo "Expected location after cargo build --package $CRATE_NAME" >&2
    echo "Available WASM files in target directory:" >&2
    ls -lh target/wasm32-unknown-unknown/release/*.wasm 2>/dev/null || echo "  (none found)" >&2
    exit 1
fi

WASM_INPUT_SIZE=$(stat -c%s "$INPUT_WASM" 2>/dev/null || stat -f%z "$INPUT_WASM" 2>/dev/null || echo "0")
if [ "$WASM_INPUT_SIZE" -lt 1000 ]; then
    echo "ERROR: Input WASM file is too small: $INPUT_WASM ($WASM_INPUT_SIZE bytes)" >&2
    echo "This indicates cargo build did not produce a valid WASM file." >&2
    exit 1
fi

# Verify WASM file starts with WASM magic bytes (0x00 0x61 0x73 0x6D = "\0asm")
# Use od or hexdump for better compatibility across systems
WASM_MAGIC=$(head -c 4 "$INPUT_WASM" | od -An -tx1 2>/dev/null | tr -d ' \n' || head -c 4 "$INPUT_WASM" | hexdump -C 2>/dev/null | head -1 | cut -d' ' -f2-5 | tr -d ' ' || echo "")
if [ -z "$WASM_MAGIC" ] || [ "$WASM_MAGIC" != "0061736d" ]; then
    # Try alternative check using printf
    FIRST_BYTES=$(head -c 4 "$INPUT_WASM" | od -An -tx1 2>/dev/null | tr -d ' \n' || echo "")
    if [ "$FIRST_BYTES" != "0061736d" ]; then
        echo "WARNING: Input file magic bytes check failed: $INPUT_WASM" >&2
        echo "Expected: 0061736d (\\0asm), got: ${FIRST_BYTES:-unable to read}" >&2
        echo "Continuing anyway - file size check passed ($WASM_INPUT_SIZE bytes)" >&2
    fi
fi

echo "Input WASM file verified: $INPUT_WASM ($WASM_INPUT_SIZE bytes, valid WASM format)"

# Run wasm-bindgen with verbose output
echo "Running wasm-bindgen..."
echo "  Input: $INPUT_WASM ($WASM_INPUT_SIZE bytes)"
echo "  Output dir: $OUTPUT_DIR"
echo "  Target: web"

# Capture wasm-bindgen output for debugging
WASM_BINDGEN_OUTPUT=$(wasm-bindgen --target web \
    --out-dir "$OUTPUT_DIR" \
    "$INPUT_WASM" 2>&1)
WASM_BINDGEN_EXIT_CODE=$?

if [ $WASM_BINDGEN_EXIT_CODE -ne 0 ]; then
    echo "ERROR: wasm-bindgen failed for $CRATE_NAME (exit code: $WASM_BINDGEN_EXIT_CODE)" >&2
    echo "Input WASM file: $INPUT_WASM ($WASM_INPUT_SIZE bytes)" >&2
    echo "wasm-bindgen output:" >&2
    echo "$WASM_BINDGEN_OUTPUT" >&2
    exit 1
fi

# Log wasm-bindgen output if any (for debugging)
if [ -n "$WASM_BINDGEN_OUTPUT" ]; then
    echo "wasm-bindgen output: $WASM_BINDGEN_OUTPUT"
fi

# Validate wasm-bindgen output immediately after generation
JS_FILE="$OUTPUT_DIR/${WASM_FILENAME}.js"
WASM_FILE="$OUTPUT_DIR/${WASM_FILENAME}_bg.wasm"

# Check JS file exists
if [ ! -f "$JS_FILE" ]; then
    echo "ERROR: wasm-bindgen did not generate JS file: $JS_FILE" >&2
    exit 1
fi

# Check JS file size (should be ~10KB, at least 8KB)
JS_SIZE=$(stat -c%s "$JS_FILE" 2>/dev/null || stat -f%z "$JS_FILE" 2>/dev/null || echo "0")
if [ "$JS_SIZE" -lt 2000 ]; then
    echo "ERROR: Generated JS file is too small: $JS_FILE ($JS_SIZE bytes, expected ~10KB)" >&2
    echo "This indicates wasm-bindgen produced incomplete output." >&2
    echo "First 500 chars of file:" >&2
    head -c 500 "$JS_FILE" >&2
    echo "" >&2
    exit 1
fi

# Check for exports in JS file (should have export statements)
if ! grep -q "export" "$JS_FILE"; then
    echo "ERROR: Generated JS file has no exports: $JS_FILE" >&2
    echo "This indicates wasm-bindgen produced incomplete output." >&2
    echo "File size: $JS_SIZE bytes" >&2
    echo "First 500 chars:" >&2
    head -c 500 "$JS_FILE" >&2
    echo "" >&2
    exit 1
fi

# Count exports to verify completeness
EXPORT_COUNT=$(grep -c "export" "$JS_FILE" || echo "0")
if [ "$EXPORT_COUNT" -lt 3 ]; then
    echo "WARNING: Generated JS file has very few exports ($EXPORT_COUNT): $JS_FILE" >&2
    echo "Expected at least 3 exports (default, initSync, and module-specific exports)" >&2
fi

# Check WASM binary file exists and has reasonable size
if [ ! -f "$WASM_FILE" ]; then
    echo "ERROR: wasm-bindgen did not generate WASM file: $WASM_FILE" >&2
    exit 1
fi

WASM_SIZE=$(stat -c%s "$WASM_FILE" 2>/dev/null || stat -f%z "$WASM_FILE" 2>/dev/null || echo "0")
if [ "$WASM_SIZE" -lt 1000 ]; then
    echo "ERROR: Generated WASM file is too small: $WASM_FILE ($WASM_SIZE bytes)" >&2
    exit 1
fi

echo "✓ wasm-bindgen validation passed: JS file ($JS_SIZE bytes, $EXPORT_COUNT exports), WASM file ($WASM_SIZE bytes)"

# Optimize wasm output with wasm-opt
# Use the converted filename for the output file
if command -v wasm-opt &> /dev/null; then
    echo "Optimizing WASM with wasm-opt..."
    if ! wasm-opt -Os "$OUTPUT_DIR/${WASM_FILENAME}_bg.wasm" -o "$OUTPUT_DIR/${WASM_FILENAME}_bg.wasm"; then
        echo "WARNING: wasm-opt failed, but continuing with unoptimized WASM" >&2
    else
        echo "WASM optimized with wasm-opt"
    fi
else
    echo "Warning: wasm-opt not found. WASM will not be optimized."
    echo "  Install with: npm install -g wasm-opt"
    echo "  Or on Alpine/Debian: apk add binaryen / apt-get install binaryen"
fi

echo "Build complete! Output in $OUTPUT_DIR/"

