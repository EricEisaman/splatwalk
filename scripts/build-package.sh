#!/bin/bash
set -e

# Assemble the publishable `@splatwalk/core` package into `dist-pkg/`.
#
# The package bundles, as a single versioned, binary-friendly artifact:
#   - the wasm-bindgen glue + `_bg.wasm` binary (from `pkg/`, build it first),
#   - the hand-authored `wasm_splatwalk.d.ts` (real types, not the generated
#     all-`any` declarations),
#   - the framework-agnostic floor module (`floor.js` + `floor.d.ts`), compiled
#     from `src/navigation/floor.ts` with its type import rewired to the shipped
#     declarations so it carries no Babylon / bundler dependency,
#   - a generated `package.json` and the package README.
#
# Run `./scripts/build.sh` (or `npm run build:wasm`) first so `pkg/` is current.

THIS_SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$THIS_SCRIPTS_DIR/.."

OUT="dist-pkg"
PKG_DIR="pkg/wasm_splatwalk"

echo "==========================================================="
echo "ASSEMBLING @splatwalk/core PACKAGE -> $OUT/"
echo "==========================================================="

if [ ! -f "$PKG_DIR/wasm_splatwalk.js" ] || [ ! -f "$PKG_DIR/wasm_splatwalk_bg.wasm" ]; then
    echo "ERROR: $PKG_DIR is missing the built wasm glue/binary." >&2
    echo "Run ./scripts/build.sh (npm run build:wasm) first." >&2
    exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# 1) Binary + glue.
cp "$PKG_DIR/wasm_splatwalk.js" "$OUT/wasm_splatwalk.js"
cp "$PKG_DIR/wasm_splatwalk_bg.wasm" "$OUT/wasm_splatwalk_bg.wasm"

# 2) Hand-authored types (replace the generated all-`any` declarations).
cp "package/wasm_splatwalk.d.ts" "$OUT/wasm_splatwalk.d.ts"

# 3) Framework-agnostic floor module: stage, rewire the type-only import to the
#    shipped declarations, then compile to JS + d.ts.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "src/navigation/floor.ts" "$STAGE/floor.ts"
cp "package/wasm_splatwalk.d.ts" "$STAGE/wasm_splatwalk.d.ts"
# `@/wasm/bridge` -> `./wasm_splatwalk` (the shipped, framework-free types).
sed -i.bak "s#@/wasm/bridge#./wasm_splatwalk#g" "$STAGE/floor.ts"
rm -f "$STAGE/floor.ts.bak"

echo "Compiling floor module..."
npx --no-install tsc "$STAGE/floor.ts" \
    --declaration \
    --target ES2020 \
    --module ES2020 \
    --moduleResolution bundler \
    --skipLibCheck \
    --strict \
    --outDir "$OUT"

# 4) License (MIT; open-core core is free forever - see LICENSING.md).
cp "LICENSE" "$OUT/LICENSE"

# 5) Generated package.json (version synced from the root package.json).
VERSION="$(node -p "require('./package.json').version")"
node -e "
const fs = require('fs');
const pkg = {
  name: '@splatwalk/core',
  version: '$VERSION',
  description: 'SplatWalk WASM core: binary, hand-authored types, canonical FAST NAV preset, and a framework-agnostic floor module.',
  type: 'module',
  license: 'MIT',
  author: 'Eric Eisaman',
  homepage: 'https://github.com/EricEisaman/splatwalk#readme',
  repository: { type: 'git', url: 'git+https://github.com/EricEisaman/splatwalk.git' },
  bugs: { url: 'https://github.com/EricEisaman/splatwalk/issues' },
  keywords: [
    'gaussian-splatting', 'splat', 'wasm', 'webassembly', 'navmesh', 'navigation',
    'recast', 'ply', 'spz', 'sog', 'glb', 'mesh', '3d', 'babylonjs', 'webgl', 'webgpu',
  ],
  main: './wasm_splatwalk.js',
  types: './wasm_splatwalk.d.ts',
  exports: {
    '.': { types: './wasm_splatwalk.d.ts', import: './wasm_splatwalk.js' },
    './floor': { types: './floor.d.ts', import: './floor.js' },
    './wasm': './wasm_splatwalk_bg.wasm',
  },
  files: [
    'wasm_splatwalk.js',
    'wasm_splatwalk.d.ts',
    'wasm_splatwalk_bg.wasm',
    'floor.js',
    'floor.d.ts',
    'README.md',
    'LICENSE',
  ],
  sideEffects: false,
  // Provenance is enabled in CI via NPM_CONFIG_PROVENANCE=true (see release.yml),
  // not here: baking it into publishConfig breaks a local/non-OIDC npm publish.
  publishConfig: { access: 'public' },
};
fs.writeFileSync('$OUT/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 6) README.
cp "package/README.md" "$OUT/README.md"

echo "==========================================================="
echo "PACKAGE ASSEMBLED ($VERSION):"
ls -la "$OUT"
echo "==========================================================="
