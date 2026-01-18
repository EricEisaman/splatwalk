#!/bin/bash
set -e

echo "==========================================================="
echo "SETTING UP LOCAL DEVELOPMENT ENVIRONMENT"
echo "==========================================================="

# Check for Rust
if ! command -v rustc &> /dev/null; then
    echo "❌ Rust not found. Please install Rust: https://rustup.rs/"
    echo "   Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "✅ Rust found: $(rustc --version)"

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js found: $(node --version)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install npm."
    exit 1
fi
echo "✅ npm found: $(npm --version)"

# Add wasm32 target
echo ""
echo "Adding wasm32-unknown-unknown target..."
rustup target add wasm32-unknown-unknown

# Check for wasm-bindgen-cli
if ! command -v wasm-bindgen &> /dev/null; then
    echo ""
    echo "⚠️  wasm-bindgen-cli not found. Installing..."
    cargo install wasm-bindgen-cli --version 0.2.87
else
    echo "✅ wasm-bindgen-cli found: $(wasm-bindgen --version)"
fi

# Check for wasm-opt
if ! command -v wasm-opt &> /dev/null; then
    echo ""
    echo "⚠️  wasm-opt not found."
    echo "   Install with one of the following:"
    echo "   - npm install -g wasm-opt"
    echo "   - On macOS: brew install binaryen"
    echo "   - On Debian/Ubuntu: sudo apt-get install binaryen"
    echo "   - On Alpine: apk add binaryen"
    echo "   (WASM will still build without optimization)"
else
    echo "✅ wasm-opt found: $(wasm-opt --version)"
fi

# Install npm dependencies
echo ""
echo "Installing npm dependencies..."
npm install

echo ""
echo "==========================================================="
echo "✅ Setup complete!"
echo "==========================================================="
echo ""
echo "You can now:"
echo "  - Run 'npm run dev' for development"
echo "  - Run 'npm run build' for production build"
echo "  - Run 'npm run build:docker' to build Docker image"
echo ""

