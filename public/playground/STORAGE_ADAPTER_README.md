# Storage Adapter Playground

Interactive demo for streaming PlayCanvas / Babylon SOD LOD from:

- a CDN `lod-meta.json` URL (`AppendSceneAsync`)
- a local SplatWalk store-only SOD LOD zip (`GaussianSplattingStream` + blob URL map)

## Run locally

```bash
npm run dev
```

Open:

- **UI:** http://localhost:5173/storage-adapter
- Legacy bookmark: `/playground/storage-adapter.html` redirects to `/storage-adapter`

## Babylon Playground (TypeScript)

Paste [`storage-adapter.ts`](./storage-adapter.ts) into [playground.babylonjs.com](https://playground.babylonjs.com) (TypeScript mode):

1. Switch the Playground to **TypeScript**
2. Replace the default `Playground` class with the file contents
3. Run — loads the PlayCanvas skatepark `lod-meta.json` via `AppendSceneAsync`

## Related

- Module: `src/storage/`
- Stream helpers: `src/storage/sogStreamLoader.ts`
- Vue showcase: `src/components/vuetify/StorageAdapterShowcase.vue`
