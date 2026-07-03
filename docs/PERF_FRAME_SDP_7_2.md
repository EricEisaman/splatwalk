# SplatWalk perf isolation (Frame sdp-7-2 baseline branch)

Branch: `perf/frame-sdp-7-2-baseline` (from `storage-adapter-01`)

## Purpose

Isolate Babylon splat **load + render FPS** without Frame's full app stack (Vue, XR, sidecar bridge, Firestore). Complements Frame's `?splatDebug=verbose` stage timers.

## Usage

1. `npm run dev` from splatwalk root
2. Open `https://localhost:5173/?perf=1` (or your Vite port)
3. Load a `.ply` / `.spz` / `.splat` example
4. HUD (top-right): rolling FPS, splat load ms, mesh count

## Automated probe

```javascript
// In browser console after load:
__splatWalkPerf()
// => { fps, frameMs, splatLoadMs, splatMeshCount }
```

## Related Frame tooling

- Frame benchmark: `node ../splat-benchmark.cjs --frame byte-range-streaming`
- Frame stats API: `__frameSplatPerf()` when splat environment is active

## Scope (this branch)

- Babylon showcase perf HUD only
- Storage adapter streaming demo (`/playground/storage-adapter.html`) unchanged
- Navmesh / WASM ingest timing documented separately in `TROUBLESHOOTING_SOG_EXPORT.md`
