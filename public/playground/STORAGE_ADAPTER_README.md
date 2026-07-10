# Storage Adapter Playground

Interactive demo for streaming PlayCanvas / Babylon SOD LOD from:

- a CDN `lod-meta.json` URL (`AppendSceneAsync`)
- a local SplatWalk store-only SOD LOD zip (`GaussianSplattingStream` + blob URL map)

Plus **Navigation from stream**: materialize a coarsest-LOD PLY and run voxel
collision and/or Fast Nav (crowd + player), same end flow as `/vuetify`.

## Run locally

```bash
npm run dev
```

Open:

- **UI:** http://localhost:5173/storage-adapter
- Legacy bookmark: `/playground/storage-adapter.html` redirects to `/storage-adapter`

## Stream → collision / nav

1. Load CDN lod-meta (e.g. PlayCanvas skatepark) or a SplatWalk SOD LOD zip.
2. Expand **Navigation from stream**.
3. Click **Generate collision** and/or **Run Fast Nav**.

The demo decodes the coarsest LOD into PLY via
`materializeNavSourceFromStreamedSog`, then reuses WASM
`build_collision_voxel_boundary` / `runFastNav`. If decode fails, convert with
[splat-transform](https://github.com/playcanvas/splat-transform) to PLY and use
the FastNav showcase instead.

## Babylon Playground (TypeScript)

Paste [`storage-adapter.ts`](./storage-adapter.ts) into [playground.babylonjs.com](https://playground.babylonjs.com) (TypeScript mode):

1. Switch the Playground to **TypeScript**
2. Replace the default `Playground` class with the file contents
3. Run — loads the PlayCanvas skatepark `lod-meta.json` via `AppendSceneAsync`

## Related

- Module: `src/storage/`
- Stream helpers: `src/storage/sogStreamLoader.ts`
- Nav materialize: `src/storage/materializeNavSourceFromStreamedSog.ts`
- Vue showcase: `src/components/vuetify/StorageAdapterShowcase.vue`
- Docs: `docs/wasm-api.md`, `docs/INTEGRATION.md`
