#!/bin/bash
set -e

echo "==========================================================="
echo "STARTING LOCAL DEVELOPMENT SERVER"
echo "==========================================================="

# Check for required tools
if ! command -v cargo &> /dev/null; then
    echo "❌ Rust/cargo not found. Run ./scripts/setup-local.sh first"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Run ./scripts/setup-local.sh first"
    exit 1
fi

if ! command -v wasm-bindgen &> /dev/null; then
    echo "❌ wasm-bindgen not found. Run ./scripts/setup-local.sh first"
    exit 1
fi

# Build WASM if pkg directory doesn't exist or is empty
if [ ! -d "pkg" ] || [ -z "$(ls -A pkg)" ]; then
    echo "Building WASM module..."
    npm run build:wasm
fi

# Start Vite dev server
echo "Starting Vite development server..."
npm run dev

