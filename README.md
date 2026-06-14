# SplatWalk

![SplatWalk Logo](public/splatwalk.png)

**SplatWalk** is a convenient one-stop shop for generating optimized **.glb ground meshes** from **.spz** or **.ply** Gaussian splats as well as creating Recast-compatible navmesh binaries from either a fast floor-field path or a dedicated collision basis.

The primary goal of SplatWalk is to provide high-quality Gaussian Splat utilities empowering engineers and designers in their quest to create useful 3D applications.

## Fast Floor Nav In Action

One `FAST NAV` click takes a raw splat to a walkable navmesh with a spawned, click-to-move player. Here the player agent (blue cube) and seed probe (magenta sphere) are correctly placed on the room floor, on the same plane the splat renders:

![SplatWalk FAST NAV placing the player agent on the room floor](docs/images/fastnav-player-on-floor.png)

## Key Features

- **Instant Visualization**: Load and view Gaussian Splat files immediately.
- **Orientation Control**: Rotate and align splats visually before conversion (90° increments). Rotating a splat after a navmesh exists automatically re-runs the same generation path so the navmesh, spawn point, and agents stay aligned with the re-oriented splat.
- **Fast Floor Nav Path**: One button can pick a seed, extract a walkable floor field, feed that floor mesh to Recast, initialize the crowd, spawn an NPC, and enable click-to-move.
- **Advanced Collider NavMesh Basis**: Import a dedicated `.collision.glb` / World Labs Collider Mesh GLB or generate a fallback collider from the splat, then feed only that collider to Recast for manual tuning.
- **PlayCanvas/SuperSplat Workflow**: Supports scene type, seed, voxel fill/seal, carve, and collider mesh diagnostics modeled after the PlayCanvas collision pipeline.
- **Navigation Markers**: The scene labels explain the magenta seed marker, blue player agent, green NPC agent, and green walkable navmesh overlay.
- **2.5D SDF Diagnostics**: Browser-side column fields power the fast floor path and remain available under experimental debug for inspecting accepted, obstacle, variance, and rejected cells.
- **Mesh Reconstruction**: Integrated Poisson reconstruction for full geometry.
- **One-Click Export**: Download production-ready `.glb` files.
- **One-Click Export**: Download production-ready `Recast compatible navmesh binary` files.

## Technology Stack

- **Core**: Rust (compiled to WASM) for heavy geometry processing.
- **Rendering**: Babylon.js for high-performance 3D visualization.
- **Frontend**: TypeScript + Vite for a modern, responsive web experience.

## Using SplatWalk In Your Project (Early Integrators)

> SplatWalk is early software. The WASM core is the product — the browser UI is a reference harness around it. Treat the WASM result shapes as a versioned contract (every result carries `api_version`).

There are two supported integration levels:

1. **TypeScript bridge** (`src/wasm/bridge.ts`): a thin typed wrapper around the WASM exports. Easiest path if you already use a bundler.
2. **Raw WASM binary** (`pkg/wasm_splatwalk/wasm_splatwalk.js` + `wasm_splatwalk_bg.wasm`): consume the generated glue and binary directly from any engine. Always pin the glue and `.wasm` from the same build.

### Minimal one-button floor-nav flow

```ts
import { SplatWalkBridge } from "splatwalk/wasm/bridge";

const splatwalk = SplatWalkBridge.getInstance();
await splatwalk.init();

// `flip_y` must match how your renderer displays the splat. Gaussian-splat loaders
// (e.g. Babylon) import with a negative Y scale, so pass flip_y=true to keep the
// navmesh, basis, and spawn points on the SAME plane your renderer draws the splat.
const settings = {
  mode: 2,
  flip_y: true,            // set from your renderer's actual splat Y-scale sign
  rotation: [0, 0, 0],     // any user orientation, in radians (applied in WASM)
  // ...fast-floor preset values (see docs/wasm-api.md "Settings Notes")
};

// 1) Find a floor seed, 2) extract the walkable ground field.
const region = splatwalk.suggestRegion(bytes, settings);
const field = splatwalk.buildWalkableGroundField(bytes, settings);

// 3) Keep only walkable/filled cells, pick the seed-nearest connected component,
//    triangulate it, and feed that floor mesh to Recast (see src/pages/splatwalk.ts).
```

### Coordinate alignment (read this first)

The single most common integration bug is a navmesh that is mirrored or offset from the rendered splat. SplatWalk parses raw PLY/SPZ coordinates, but renderers usually flip Y on import. Resolve it once, at the boundary:

- Set `flip_y` from your renderer's actual splat transform (the sign of its world Y scale), not a guess. When set, WASM negates the Y of every parsed splat (position and normal) so it operates in the same world space you render, and its `+Y = up` floor/clearance heuristics become valid.
- Pass user orientation via `settings.rotation` (radians). WASM bakes it into bounds, regions, meshes, basis, and the ground field, so re-running after a rotation re-aligns everything.
- Do **not** derive floor height from renderer meshes or apply visual Y offsets to "fix" alignment. Fix `flip_y`/`rotation`/settings instead.

See [`docs/wasm-api.md`](docs/wasm-api.md) for the full entry-point contract, the ground-field cell states, settings reference, and binary-only integrator guidance.

## Service Worker and Caching

SplatWalk ships a service worker (`public/sw.js`) whose cache id is derived from the wasm build:

- **Auto-versioned cache**: During `npm run build`, a Vite plugin hashes `pkg/wasm_splatwalk/wasm_splatwalk_bg.wasm` and writes that hash into the service worker's `CACHE_NAME` (replacing the `__SW_BUILD_ID__` placeholder). Every new wasm build therefore produces a new cache id.
- **Clears on change**: On activation the service worker deletes every cache whose name is not the current `CACHE_NAME`, so previous builds are evicted automatically.
- **Hands-off updates**: The client checks for a new worker on load, tells it to skip waiting, and reloads once when it takes control. Integrators never have to manually discard cache to pick up a new build.
- **No stale code**: Application code, wasm binaries/glue, splat assets, workers, and any query-stringed request bypass the cache entirely (network passthrough). Only the static shell is cached network-first.
- **Dev**: The service worker is not registered on `localhost`; any previously registered worker and its caches are unregistered/cleared on startup so dev never serves stale wasm.

## License

This project is licensed under the **AGPLv3**.
