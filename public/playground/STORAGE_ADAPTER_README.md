# Storage Adapter Playground

Interactive demo for streaming PlayCanvas / Babylon SOD LOD from:

- a CDN `lod-meta.json` URL (budgeted `GaussianSplattingStream` — fixed resident GPU budget)
- a local SplatWalk store-only SOD LOD zip (same budgeted stream; full zip in RAM — small demos only)

City-scale catalogs (35M–200M+ splats) must use CDN + a resident budget (default Medium = 4M).
Never rely on `AppendSceneAsync` alone — it cannot pass `maxResidentSplats`.

Plus **Navigation from stream**: materialize a capped PLY and run voxel
collision and/or Fast Nav (crowd + player), same end flow as `/vuetify`.

## Run locally

```bash
npm run dev
```

Open:

- **UI:** http://localhost:5173/storage-adapter
- Legacy bookmark: `/playground/storage-adapter.html` redirects to `/storage-adapter`

## Stream → collision / nav

1. Load CDN lod-meta (e.g. PlayCanvas skatepark or church) or a SplatWalk SOD LOD zip.
2. Expand **Navigation from stream**.
3. Click **Generate collision** and/or **Run Fast Nav**.

The demo decodes a spatially fair LOD subset into PLY via
`materializeNavSourceFromStreamedSog`, then reuses WASM
`build_collision_voxel_boundary` / `runFastNav`. If decode fails, convert with
[splat-transform](https://github.com/playcanvas/splat-transform) to PLY and use
the FastNav showcase instead.

## Renderer (local UI)

On http://localhost:5173/storage-adapter use **Stream settings → WebGPU / WebGL**,
or `?renderer=webgpu|webgl`. WebGPU falls back to WebGL when unsupported.

## Babylon Playground (TypeScript)

Paste [`storage-adapter.ts`](./storage-adapter.ts) into [playground.babylonjs.com](https://playground.babylonjs.com) (TypeScript mode):

1. Switch the Playground to **TypeScript**
2. Replace the default `Playground` class with the file contents
3. Run — loads the PlayCanvas church `lod-meta.json` with a 4M resident budget

The Playground **host** owns the `Engine` (WebGL or WebGPU per Playground settings).
The paste demo does not create or toggle the renderer.

## Related

- Module: `src/storage/`
- Stream helpers: `src/storage/sogStreamLoader.ts`
- Memory budget: `src/storage/streamMemoryBudget.ts`
- Nav materialize: `src/storage/materializeNavSourceFromStreamedSog.ts`
- Vue showcase: `src/components/vuetify/StorageAdapterShowcase.vue`
- Docs: `docs/wasm-api.md`, `docs/INTEGRATION.md`
