#!/usr/bin/env node
/**
 * Assemble community FastNav / Storage integration kits into public/integration-kits/*.zip
 * Uses fflate (already a project dependency). Run via `npm run build:kits`.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'public', 'integration-kits');

const readText = (relPath) => readFileSync(join(root, relPath), 'utf8');
const readBin = (relPath) => new Uint8Array(readFileSync(join(root, relPath)));

const addFile = (files, zipPath, content) => {
  files[zipPath] = typeof content === 'string' ? strToU8(content) : content;
};

const copyRepoFile = (files, repoRel, zipPath = null) => {
  const dest = zipPath ?? repoRel.replace(/^src\//, 'src/').replace(/^public\//, '');
  addFile(files, dest, readBin(repoRel));
};

const writeZip = (filename, files) => {
  mkdirSync(outDir, { recursive: true });
  const zipped = zipSync(files, { level: 6 });
  const outPath = join(outDir, filename);
  writeFileSync(outPath, zipped);
  const names = Object.keys(files);
  console.log(`[build-kits] ${filename} (${names.length} files, ${zipped.byteLength} bytes)`);
};

const VUETIFY_INTEGRATE = `# SplatWalk FastNav — Vuetify + Babylon kit

Drop-in reference for the Vue / Vuetify Fast Nav showcase.

## Install

\`\`\`bash
npm install @splatwalk/core @babylonjs/core vue vuetify
\`\`\`

Peer UI: Vuetify 3+, Vue 3+, Babylon.js 9+.

## Files in this kit

- \`src/components/vuetify/SplatFastNavShowcase.vue\` — showcase card UI
- \`src/composables/useSplatFastNav.ts\` — Fast Nav orchestration
- \`src/composables/useBabylonViewer.ts\` — canvas / engine lifecycle
- \`src/scene/createBabylonEngine.ts\` — WebGPU (with GS MRT limits) + WebGL fallback

You still need the shared pipeline modules from the SplatWalk repo (or publish path):
\`src/navigation/fastNav.ts\`, \`src/navigation/floor.ts\`, \`src/scene/Viewer.ts\`, WASM bridge.
Prefer \`npm install @splatwalk/core\` for the WASM/floor contract and copy or vendor the showcase glue.

## Renderer

Babylon demos prefer WebGPU with WebGL fallback. Use \`?renderer=webgl|webgpu\` or the in-demo toggle.
WebGPU requests \`setMaximumLimits\` so \`maxColorAttachmentBytesPerSample\` can host the GS work-buffer MRT.

## Docs

- https://github.com/EricEisaman/splatwalk/blob/main/docs/INTEGRATION.md
- Live demo: \`/vuetify\`
`;

const R3F_INTEGRATE = `# SplatWalk FastNav — React Three Fiber kit

Reference R3F / three.js Fast Nav showcase (mirrors the Vuetify demo).

## Install

\`\`\`bash
npm install @splatwalk/core three @react-three/fiber @react-three/drei @mkkellogg/gaussian-splats-3d recast-navigation react react-dom @mui/material @emotion/react @emotion/styled
\`\`\`

## Files in this kit

- \`src/react/SplatFastNavShowcase.tsx\`
- \`src/react/useSplatFastNavR3F.ts\`
- \`src/react/SceneCanvas.tsx\`
- \`src/react/three/SplatNavController.ts\`
- \`src/react/exampleScenes.ts\`

Wire WASM via \`@splatwalk/core\` / \`@splatwalk/core/floor\` as described in \`examples/r3f/README.md\`.

## Renderer

This path uses **Three.js WebGL** (\`WebGLRenderer\` + gaussian-splats-3d). There is no WebGPU splat path in this kit; demos show a WebGPU control disabled for clarity.

## Docs

- https://github.com/EricEisaman/splatwalk/blob/main/examples/r3f/README.md
- Live demo: \`/react\`
`;

const STORAGE_INTEGRATE = `# SplatWalk Storage Adapter kit

Babylon Playground paste + quick ref for streamed SOG (\`lod-meta.json\`) via the Storage Adapter pattern.

## Contents

- \`storage-adapter.ts\` — Playground TypeScript paste (host owns Engine)
- \`STORAGE_ADAPTER_QUICK_REF.ts\`
- \`STORAGE_ADAPTER_README.md\`

## Vue demo

Full UI with WebGPU/WebGL toggle: \`/storage-adapter\` in the SplatWalk site.

## Renderer

The Playground **host** creates WebGL or WebGPU. Enable WebGPU in Playground settings when available.
For the Vue demo, use Stream settings → WebGPU / WebGL or \`?renderer=\`.
WebGPU needs raised \`maxColorAttachmentBytesPerSample\` (SplatWalk uses \`setMaximumLimits\`).
`;

const WORKBENCH_INTEGRATE = `# SplatWalk FastNav — Babylon workbench host kit

Minimal host wiring for \`Viewer.create\` + \`runFastNav\` (not the full homepage \`splatwalk.ts\`).

## Install

\`\`\`bash
npm install @splatwalk/core @babylonjs/core
\`\`\`

## Files

- \`fastNavHost.snippet.ts\` — sketch of engine create, load splat, run Fast Nav
- \`createBabylonEngine.ts\` — WebGPU/WebGL helper (copy into your host)

See \`docs/INTEGRATION.md\` for the full contract. Live advanced UI: \`/\` (3D Workbench).

## Renderer

Pass \`renderer: 'webgpu' | 'webgl'\` into \`Viewer.create\` / \`createBabylonEngine\`. Prefer WebGPU with \`setMaximumLimits: true\`.
`;

const WORKBENCH_SNIPPET = `/**
 * Minimal Babylon host sketch for SplatWalk Fast Nav.
 * Copy patterns into your app; resolve imports against @splatwalk/core + your Viewer.
 */
import { createBabylonEngine, parseRendererPreference } from './createBabylonEngine';
// import { Viewer } from '...';
// import { runFastNav } from '...';

export async function bootFastNavHost(canvas: HTMLCanvasElement): Promise<void> {
  const preference = parseRendererPreference();
  const { engine, renderer, fallbackFromWebgpu } = await createBabylonEngine({
    canvas,
    preference,
  });
  console.info('[SplatWalk] Renderer:', renderer, fallbackFromWebgpu ? '(fallback)' : '');

  // const viewer = await Viewer.create(canvas, { renderer: preference, existing: { engine, scene } });
  // await viewer.loadSplat(bytes);
  // await runFastNav({ viewer, bytes, onLog: console.log });

  engine.runRenderLoop(() => {
    /* scene.render() */
  });
}
`;

const peersVuetify = {
  name: 'splatwalk-fastnav-vuetify-kit',
  private: true,
  peerDependencies: {
    '@babylonjs/core': '^9.18.0',
    '@splatwalk/core': '^0.6.4',
    vue: '^3.5.0',
    vuetify: '^3.0.0 || ^4.0.0',
  },
};

const peersR3f = {
  name: 'splatwalk-fastnav-r3f-kit',
  private: true,
  peerDependencies: {
    '@mkkellogg/gaussian-splats-3d': '^0.4.7',
    '@react-three/drei': '^9.0.0',
    '@react-three/fiber': '^8.0.0',
    '@splatwalk/core': '^0.6.4',
    react: '^18.0.0',
    'react-dom': '^18.0.0',
    'recast-navigation': '^0.43.0',
    three: '^0.169.0',
  },
};

const peersStorage = {
  name: 'splatwalk-storage-adapter-kit',
  private: true,
  peerDependencies: {
    '@babylonjs/core': '^9.18.0',
    '@splatwalk/core': '^0.6.4',
  },
};

const peersWorkbench = {
  name: 'splatwalk-fastnav-babylon-workbench-kit',
  private: true,
  peerDependencies: {
    '@babylonjs/core': '^9.18.0',
    '@splatwalk/core': '^0.6.4',
  },
};

const required = [
  'src/components/vuetify/SplatFastNavShowcase.vue',
  'src/composables/useSplatFastNav.ts',
  'src/composables/useBabylonViewer.ts',
  'src/scene/createBabylonEngine.ts',
  'src/react/SplatFastNavShowcase.tsx',
  'src/react/useSplatFastNavR3F.ts',
  'src/react/SceneCanvas.tsx',
  'src/react/three/SplatNavController.ts',
  'src/react/exampleScenes.ts',
  'public/playground/storage-adapter.ts',
  'public/playground/STORAGE_ADAPTER_QUICK_REF.ts',
  'public/playground/STORAGE_ADAPTER_README.md',
];

for (const rel of required) {
  if (!existsSync(join(root, rel))) {
    console.error(`[build-kits] missing required file: ${rel}`);
    process.exit(1);
  }
}

// Vuetify
{
  const files = {};
  addFile(files, 'INTEGRATE.md', VUETIFY_INTEGRATE);
  addFile(files, 'package.peers.json', JSON.stringify(peersVuetify, null, 2) + '\n');
  copyRepoFile(files, 'src/components/vuetify/SplatFastNavShowcase.vue');
  copyRepoFile(files, 'src/composables/useSplatFastNav.ts');
  copyRepoFile(files, 'src/composables/useBabylonViewer.ts');
  copyRepoFile(files, 'src/scene/createBabylonEngine.ts');
  writeZip('splatwalk-fastnav-vuetify.zip', files);
}

// R3F
{
  const files = {};
  addFile(files, 'INTEGRATE.md', R3F_INTEGRATE);
  addFile(files, 'package.peers.json', JSON.stringify(peersR3f, null, 2) + '\n');
  copyRepoFile(files, 'src/react/SplatFastNavShowcase.tsx');
  copyRepoFile(files, 'src/react/useSplatFastNavR3F.ts');
  copyRepoFile(files, 'src/react/SceneCanvas.tsx');
  copyRepoFile(files, 'src/react/three/SplatNavController.ts');
  copyRepoFile(files, 'src/react/exampleScenes.ts');
  writeZip('splatwalk-fastnav-r3f.zip', files);
}

// Storage
{
  const files = {};
  addFile(files, 'INTEGRATE.md', STORAGE_INTEGRATE);
  addFile(files, 'package.peers.json', JSON.stringify(peersStorage, null, 2) + '\n');
  copyRepoFile(files, 'public/playground/storage-adapter.ts', 'storage-adapter.ts');
  copyRepoFile(files, 'public/playground/STORAGE_ADAPTER_QUICK_REF.ts', 'STORAGE_ADAPTER_QUICK_REF.ts');
  copyRepoFile(files, 'public/playground/STORAGE_ADAPTER_README.md', 'STORAGE_ADAPTER_README.md');
  writeZip('splatwalk-storage-adapter.zip', files);
}

// Workbench
{
  const files = {};
  addFile(files, 'INTEGRATE.md', WORKBENCH_INTEGRATE);
  addFile(files, 'package.peers.json', JSON.stringify(peersWorkbench, null, 2) + '\n');
  addFile(files, 'fastNavHost.snippet.ts', WORKBENCH_SNIPPET);
  copyRepoFile(files, 'src/scene/createBabylonEngine.ts', 'createBabylonEngine.ts');
  writeZip('splatwalk-fastnav-babylon-workbench.zip', files);
}

console.log(`[build-kits] wrote kits to ${relative(root, outDir)}`);
