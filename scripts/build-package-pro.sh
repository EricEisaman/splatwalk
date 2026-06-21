#!/bin/bash
set -e

# Assemble the (reserved) `@splatwalk/core-pro` commercial package into
# `dist-pkg-pro/`. SCAFFOLD: the Pro features are not implemented yet, so this is
# provided so the first Pro feature can be built and published cleanly. It is NOT
# wired into `.github/workflows/release.yml`.
#
# `@splatwalk/core-pro` depends on the MIT `@splatwalk/core` at runtime; it never
# vendors the core.

THIS_SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$THIS_SCRIPTS_DIR/.."

OUT="dist-pkg-pro"
SRC="package-pro/src"

echo "==========================================================="
echo "ASSEMBLING @splatwalk/core-pro PACKAGE (scaffold) -> $OUT/"
echo "==========================================================="

rm -rf "$OUT"
mkdir -p "$OUT"

echo "Compiling Pro modules..."
npx --no-install tsc "$SRC"/*.ts \
    --declaration \
    --target ES2020 \
    --module ES2020 \
    --moduleResolution bundler \
    --skipLibCheck \
    --strict \
    --outDir "$OUT"

cp "package-pro/README.md" "$OUT/README.md"
cp "package-pro/COMMERCIAL-LICENSE.md" "$OUT/COMMERCIAL-LICENSE.md"

VERSION="$(node -p "require('./package.json').version")"
node -e "
const fs = require('fs');
const pkg = {
  name: '@splatwalk/core-pro',
  version: '$VERSION',
  description: 'SplatWalk Pro: commercial, opt-in advanced capabilities (license key required). The free @splatwalk/core covers everyone\\'s free start.',
  type: 'module',
  license: 'SEE LICENSE IN COMMERCIAL-LICENSE.md',
  author: 'Eric Eisaman',
  homepage: 'https://github.com/EricEisaman/splatwalk#readme',
  repository: { type: 'git', url: 'git+https://github.com/EricEisaman/splatwalk.git' },
  bugs: { url: 'https://github.com/EricEisaman/splatwalk/issues' },
  keywords: ['gaussian-splatting', 'splat', 'streaming', 'storage', 'wasm', 'splatwalk', 'pro'],
  peerDependencies: { '@splatwalk/core': '^$VERSION' },
  main: './index.js',
  types: './index.d.ts',
  exports: {
    '.': { types: './index.d.ts', import: './index.js' },
    './streaming': { types: './streaming.d.ts', import: './streaming.js' },
  },
  files: ['*.js', '*.d.ts', 'README.md', 'COMMERCIAL-LICENSE.md'],
  sideEffects: false,
  publishConfig: { access: 'public' },
};
fs.writeFileSync('$OUT/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "==========================================================="
echo "PRO PACKAGE ASSEMBLED ($VERSION) - scaffold, not for publish yet:"
ls -la "$OUT"
echo "==========================================================="
