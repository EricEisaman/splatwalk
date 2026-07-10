# SplatWalk Integration Guide

A task-oriented guide to integrating the SplatWalk WASM core (`@splatwalk/core`)
into any engine or framework. For the exhaustive per-entry-point reference (units,
ranges, cell states, coordinate contract), see [`wasm-api.md`](wasm-api.md). This
guide shows the common paths end to end.

**SplatWalk is rendering-engine-agnostic.** The core is a Rust/WASM library with
**no dependency on any 3D engine, renderer, or UI framework** - it takes splat
bytes in and returns meshes, navmesh-ready geometry, bounds, and SOG/GLB out, in
a documented coordinate space you control via `flip_y` / `output_space`. The same
core drives every reference integration in this repo: the **Babylon.js** showcase
(section 9) and the **React Three Fiber / three.js** demo (section 10) call the
identical WASM entry points and the shared, engine-free floor module - only the
rendering and the `recast-navigation` crowd glue differ per engine.

`@splatwalk/core` is **MIT-licensed and free forever**, including for commercial
and proprietary use - see [`../LICENSING.md`](../LICENSING.md).

## Contents

1. [Install and initialize](#1-install-and-initialize)
2. [Preflight: version and capabilities](#2-preflight-version-and-capabilities)
3. [One-call room floor](#3-one-call-room-floor)
4. [The coordinate / `flip_y` contract (read this first)](#4-the-coordinate--flip_y-contract-read-this-first)
5. [Feeding Recast without the voxel-truncation bug](#5-feeding-recast-without-the-voxel-truncation-bug)
6. [Progress reporting](#6-progress-reporting)
7. [Handling failures](#7-handling-failures)
8. [Framework-agnostic floor module](#8-framework-agnostic-floor-module)
9. [Babylon.js integration](#9-babylonjs-integration)
10. [React Three Fiber (three.js) integration](#10-react-three-fiber-threejs-integration)
11. [Integrator ask status](#11-integrator-ask-status)

## 1. Install and initialize

```bash
npm install @splatwalk/core
```

The default export loads and instantiates the wasm. Always `await` it (or
`initSync`) before calling any named export, then call `init_splatwalk()` once to
install the panic hook.

```ts
import init, { init_splatwalk, splatwalk_api_version } from '@splatwalk/core';

await init();            // load + instantiate the .wasm
init_splatwalk();        // one-time setup
```

## 2. Preflight: version and capabilities

These three exports are cheap - no parse or field build - so you can fail fast on
a stale binary and feature-detect before doing any work. The integer
`api_version` is the hard data contract; `capabilities` advertises additive
features so you can tolerate change without hard-failing on a version bump.

```ts
import {
  splatwalk_version,
  splatwalk_api_version,
  splatwalk_capabilities,
} from '@splatwalk/core';

if (splatwalk_api_version() !== 2) throw new Error('Unsupported SplatWalk binary');

const caps = splatwalk_capabilities();        // e.g. ['room_floor_mesh', 'recast_config', ...]
const version = splatwalk_version();          // tracks the crate version, e.g. '0.3.6'

if (!caps.includes('room_floor_mesh')) {
  // Fall back to the multi-step field path instead of the one-call entry point.
}
if (!caps.includes('collision_voxel_boundary')) {
  // Hide collision/physics export UI or fall back to an imported .collision.glb.
}
```

## 3. One-call room floor

`build_room_floor_mesh` is the binary-side equivalent of the FAST NAV floor path.
It bakes the canonical FAST NAV preset automatically (your settings override it),
runs an internal recovery ladder, and can emit a GLB directly.

```ts
import init, { init_splatwalk, build_room_floor_mesh, mesh_to_glb } from '@splatwalk/core';

await init();
init_splatwalk();

const splatBytes: Uint8Array = /* your .ply (or .spz converted via spz_to_ply) */;

const floor = build_room_floor_mesh(splatBytes, {
  mode: 2,
  flip_y: true,            // match your renderer (see section 4)
  rotation: [0, 0, 0],     // user orientation in radians, applied in WASM
  emit_glb: true,          // optional: also return GLB bytes
});

const glb = floor.glb ?? mesh_to_glb(floor.mesh.vertices, floor.mesh.indices);
console.log(`floor area=${floor.selected_area} m^2, step=${floor.step_label}`);
```

If you need the lower-level field (per-cell states for your own meshing), use
`build_walkable_ground_field` instead and merge `fast_nav_preset()` into your
settings as the base layer.

## 4. Collision voxel boundary mode

Collision export is a second runtime mode, not the default FAST NAV navmesh mode:

```ts
import {
  build_collision_voxel_boundary,
  mesh_to_glb,
} from '@splatwalk/core';

const collision = build_collision_voxel_boundary(splatBytes, {
  mode: 2,
  flip_y: true,
  rotation: [0, 0, 0],
  collision_mesh_mode: 'faces',
  collision_scene_type: 'outdoor',
  collision_seed: [0, 1, 0],
  emit_glb: true,
});

const collisionGlb =
  collision.glb ?? mesh_to_glb(collision.mesh.vertices, collision.mesh.indices);
```

Use this path for a collision/physics overlay or `.collision.glb` export. It follows the PlayCanvas-inspired voxel occupancy/fill/carve pipeline and emits exact voxel-boundary faces today. `collision_mesh_mode: 'smooth'` is reserved and rejected until smoothing is implemented. For walking/crowd simulation, keep using the FAST NAV floor-field path; do not feed the collision mesh into the one-button room navigation workflow unless you are intentionally running an advanced/manual collider bake.

## 5. The coordinate / `flip_y` contract (read this first)

> For the condensed, cross-engine summary of this section and sections 10-11, see
> the one-page [Canonical GS Alignment Recipe](coordinate-alignment.md).

The single most common integration bug is a navmesh mirrored or offset from the
rendered splat. SplatWalk parses raw PLY/SPZ coordinates, but most renderers flip
Y on import. Resolve it once, at the boundary:

- Set `flip_y` from your renderer's actual splat transform (the sign of its world
  Y scale), not a guess. When set, WASM negates parsed Y so its `+Y = up`
  heuristics are valid in the space you render.
- Pass user orientation via `settings.rotation` (radians); WASM bakes it into
  every result.
- Do **not** patch alignment with visual Y offsets on the output. Fix
  `flip_y` / `rotation` instead.

Default output is `splatwalk_oriented` space (right-handed, `+Y` up, CCW winding).
To have the core emit directly in your engine's convention, set
`settings.output_space`:

```ts
const result = build_room_floor_mesh(splatBytes, {
  mode: 2,
  flip_y: true,
  output_space: { up_axis: 'y', handedness: 'left', winding: 'auto' },
});
// result.space.space === 'engine_output'
```

## 6. Feeding Recast without the voxel-truncation bug

Recast stores agent dimensions as **integer voxel counts**, so passing sub-metre
metre values silently truncates them to `0` (a slab or a fragmented navmesh).
Use `recast_config()` to convert metres to voxels correctly and to get the
suggested vertical-bounds padding.

```ts
import { recast_agent_defaults, recast_config } from '@splatwalk/core';

const agent = recast_agent_defaults();   // reference metres: cs, ch, walkableHeight/Radius/Climb...

const cfg = recast_config({
  ...agent,
  maxFloorY: highestFloorCellY,          // metres; enables suggestedBmaxY
});

// cfg.walkableHeight / walkableClimb / walkableRadius are now voxel counts.
// cfg.suggestedBmaxY pads headroom above the floor so open-sky scenes connect.
```

See [Recast parameter units (metres vs voxels)](wasm-api.md#recast-parameter-units-metres-vs-voxels)
for the exact conversion.

## 7. Progress reporting

Register an opt-in callback invoked as `(stage, fraction)` at documented stage
boundaries - no need to intercept the global console. The
`@progress <stage> [<fraction>]` line protocol is still emitted as a fallback.

```ts
import { set_progress_callback } from '@splatwalk/core';

set_progress_callback((stage, fraction) => {
  onProgress(stage, fraction ?? 0);
});

// ...run build_room_floor_mesh / slice_splat...

set_progress_callback(undefined);   // clear when done
```

## 8. Handling failures

`build_room_floor_mesh` throws a structured `RoomFloorFailure` object (not a
string) when no recovery step yields a usable floor. Branch on the stable
`reason` code for control flow and telemetry rather than parsing prose.

```ts
import type { RoomFloorFailure } from '@splatwalk/core';

try {
  const floor = build_room_floor_mesh(splatBytes, { mode: 2, flip_y: true });
} catch (e) {
  const err = e as RoomFloorFailure;
  switch (err.reason) {
    case 'too_small':     // floor found but below min_room_floor_area
    case 'no_component':  // no connected floor component
    case 'empty_mesh':
      report(err.reason, err.selected_area, err.component_count, err.attempted);
      break;
    default:
      throw e;
  }
}
```

## 9. Framework-agnostic floor module

The `@splatwalk/core/floor` subpath ships the FAST NAV floor logic with no
Babylon or bundler dependency. Inject the binary's field builder so the module
stays engine-agnostic:

```ts
import init, { init_splatwalk, build_walkable_ground_field } from '@splatwalk/core';
import {
  FAST_NAV_PRESET,
  extractFloorFieldWithRecovery,
  resolveRecovery,
} from '@splatwalk/core/floor';

await init();
init_splatwalk();

const result = await extractFloorFieldWithRecovery({
  bytes: splatBytes,
  buildField: async (b, s) => build_walkable_ground_field(b, s),
  baseSettings: { ...FAST_NAV_PRESET, rotation, flip_y, collision_seed },
  seed: collision_seed,
  recovery: resolveRecovery(),
  log: (m) => console.log(m),
});
```

For a complete, non-Babylon reference that renders the splat, extracts the floor,
builds a Recast navmesh, and runs a click-to-move crowd, see the
[React Three Fiber demo](../examples/r3f/README.md) (route `/react`, source under
`src/react/`). It uses the same engine-agnostic floor module and
`recast-navigation` crowd on a three.js scene.

## 10. Babylon.js integration

Babylon.js is the reference renderer for the SplatWalk showcase. The complete,
working integration is `src/scene/Viewer.ts` (UI in `src/vuetify/`, route
`/vuetify`); this section distills the engine-specific contract.

**Live demo:** <a href="https://splatwalk.onrender.com/vuetify" target="_blank" rel="noopener noreferrer">splatwalk.onrender.com/vuetify</a>

### Navigation from streamed SOG

For CDN or zip **streamed SOG** (`lod-meta.json`), use the Storage Adapter
playground (`/storage-adapter`, source under `src/components/vuetify/` and
`src/storage/`):

1. Load a CDN `…/lod-meta.json` URL or a SplatWalk store-only SOD LOD zip
   (Babylon `AppendSceneAsync` / `GaussianSplattingStream`).
2. Open **Navigation from stream**.
3. **Generate collision** and/or **Run Fast Nav** — the demo materializes a
   coarsest-LOD PLY, then reuses the same WASM + `Viewer` end flow as `/vuetify`
   (nav overlay, crowd, NPC, `focusOnPlayer`).

Streamed SOG is not a direct WASM input; see `docs/wasm-api.md` (“Navigation from
streamed SOG”). Format switching via
[splat-transform](https://github.com/playcanvas/splat-transform) is supported as
a fallback when in-app SOG→PLY decode is insufficient.

**Handedness.** Babylon is **left-handed** by default. The WASM core emits
`splatwalk_oriented` space (right-handed, `+Y` up), and Recast/`recast-navigation`
is right-handed — but because Babylon's splat loader flips the splat on import
(below), the navmesh, crowd and rendered splat all coincide without any extra
handedness conversion. Render directly; do **not** add a Z mirror.

**The splat Y-flip → `flip_y: true`.** `SceneLoader.ImportMeshAsync` imports
Gaussian splats with a **negative Y scale** (the Y-down source convention), so
the rendered splat lives in a Y-flipped world relative to the raw PLY/SPZ bytes
that WASM parses. Detect it from the mesh and feed it straight into every WASM
call — never guess:

```ts
// src/scene/Viewer.ts — isSplatYFlipped()
mesh.computeWorldMatrix(true);
const flip_y = (mesh.scaling?.y ?? 1) < 0;   // true for a standard splat import

const floor = build_room_floor_mesh(splatBytes, { mode: 2, flip_y, rotation });
```

**One loader path: normalize non-PLY formats to PLY at ingest.** The showcase
converts `.spz` (Niantic) and `.splat` (antimatter15) to a full-fidelity PLY in
WASM *before* visualization (`src/wasm/normalize.ts` → `splatwalk.spzToPly` /
`splatToPly`), then hands those PLY bytes to `SceneLoader.ImportMeshAsync`. This
keeps Babylon on its **PLY loader only** (so `.spz` does not pull a CDN-hosted
decoder, which a strict CSP blocks), and — because every format now goes through
the same loader — splat orientation is a single, stable loader decision. That is
why `isSplatYFlipped()` (the `mesh.scaling.y` sign above) is the correct single
source of truth for `flip_y`: the core cannot report it, since a 3DGS PLY header
carries no chirality/up-axis and the Y-flip is applied by Babylon, not by parsing.

**Crowd + click-to-move.** Build the navmesh with `recast-navigation`
`importNavMesh`, then a `Crowd` with `CrowdAgent`s (player radius `0.5`,
height `2.0`). Render the navmesh as a debug mesh and pick against it; the agent
mesh (a `0.5` box) is offset up by half its height so it rests *on* the navmesh:

```ts
const { navMesh } = importNavMesh(navMeshData);
this.crowd = new Crowd(navMesh, { maxAgents: 100, maxAgentRadius: 1.0 });
this.userAgent = this.crowd.addAgent(spawn, { radius: 0.5, height: 2.0, maxAcceleration: 20, maxSpeed: 5 });

// Pointer tap → pick the navmesh debug mesh → steer the agent.
const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === navMeshDebugMesh);
if (pick?.hit && pick.pickedPoint) this.userAgent.requestMoveTarget(pick.pickedPoint.subtract(navMeshVisualOffset));
```

**Top-down framing.** `focusOnPlayer()` puts the `ArcRotateCamera` straight
above the player (`beta ≈ 0`), targets the player, and sets
`radius = cameraHeight - player.y`, where `cameraHeight` sits just below the
splat ceiling, clamped between one player-height and 4 m above the player's head
so the player stays framed in rooms of any height.

**Right-handed regression scene (`?rh=1`).** The Vuetify showcase can build the
viewer with `scene.useRightHandedSystem = true` via a hidden `?rh=1` URL flag
(`ViewerOptions.rightHanded` in `src/scene/Viewer.ts`). This is a
conformance/regression path — left-handed stays the default — that proves the
`splatwalk_oriented` output (right-handed, `+Y` up) lands in a right-handed
Babylon scene with **no** boundary mirror (the geometry counterpart to Babylon
PR [#18606](https://github.com/BabylonJS/Babylon.js/pull/18606)'s right-handed
splat sort). Measured coincidence is in
[`coordinate-alignment.md`](coordinate-alignment.md) ("Babylon.js (right-handed)").

**Zero-install Playground (CDN) — interactive demo.** A self-contained Babylon.js
Playground snippet that mirrors the homepage workbench with its own in-scene UI
(in the spirit of babylon-game-starter): it loads `@splatwalk/core` + recast.js
from CDNs, renders a real splat, extracts the FAST NAV floor, builds a Recast
navmesh from it, spawns a crowd agent, and supports **click-to-move**. It also
ships a **Full screen** toggle that hijacks the Playground split (drops
`#pg-split`'s fixed-pixel grid via `display:block` so `#canvasZone` fills the
view, then `engine.resize()`; outside the Playground it uses the Fullscreen API,
and `?fullscreen=true` enters full screen on load). The core SplatWalk call is
unchanged from the rest of this guide:

```ts
// Babylon Playground (TypeScript). Full file: public/playground/babylon-fast-nav.ts
const sw: any = await import('https://cdn.jsdelivr.net/npm/@splatwalk/core@0.3.7/wasm_splatwalk.js');
await sw.default();        // wasm-bindgen --target web init (fetches the .wasm from the same CDN dir)
sw.init_splatwalk();       // register the PLY/SPZ parsers (once)

const bytes = new Uint8Array(await (await fetch(SPLAT_URL)).arrayBuffer());
const flip_y = (splat.scaling?.y ?? 1) < 0;  // detect from the loaded splat, as above
const floor = sw.build_room_floor_mesh(bytes, { ...sw.fast_nav_preset(), mode: 2, flip_y });
// → floor.mesh.vertices / floor.mesh.indices, in splatwalk_oriented space (renders directly)

// The floor mesh feeds Babylon's Recast navmesh + crowd directly (same chirality):
await BABYLON.Tools.LoadScriptAsync('https://cdn.babylonjs.com/recast.js');
const nav = new BABYLON.RecastJSPlugin(await Recast());
nav.createNavMesh([floorMesh], recastParams);    // floorMesh = the rendered floor above
const crowd = nav.createCrowd(8, 0.5, scene);
const agentIndex = crowd.addAgent(nav.getClosestPoint(center), agentParams, agentTransformNode);
// pointer-tap → crowd.agentGoto(agentIndex, nav.getClosestPoint(pickedPoint))
```

> Give each crowd agent a `TransformNode` in `addAgent` — `crowd.update()` writes
> the agent pose onto it and throws if it is missing. Make the splat mesh
> `isPickable = false` so click-to-move picks the floor/navmesh, not the splat.

- **Snippet:** [`public/playground/babylon-fast-nav.ts`](../public/playground/babylon-fast-nav.ts)
  (paste into the Playground's TS editor). It is an ES module that
  `export`s `class Playground` with a static async `CreateScene(engine, canvas)`;
  the Playground **V2** runner resolves the scene factory from the entry module's
  exports (`Playground.CreateScene` / `default.CreateScene` / `createScene` /
  `default`) and awaits it. The snippet builds its own DOM UI on the canvas parent,
  so the demo is identical in the real Playground.
- **Runnable demo + `playground.json` export:** open **`/playground/`** on the dev
  server (`npm run dev` → `http://localhost:5173/playground/index.html`); source
  [`public/playground/index.html`](../public/playground/index.html). It reproduces
  the Playground TS pipeline and offers a **Download `playground.json`** button.
  The file is a Babylon Playground **V2 snippet** (`{ payload, name, description,
  tags }` → V2 manifest), so it loads straight into the Playground for editing. An
  **Open Playground ↗** button opens the published snippet
  ([`#VXTB9K`](https://playground.babylonjs.com/#VXTB9K)), and a home icon links
  back to the SplatWalk homepage. It lives under `public/` so the bundler serves
  the **raw** source the in-browser transpile and `playground.json` export depend
  on (do not put it on a path your bundler rewrites, e.g. `/examples/...` under Vite).
- **CDN caveats:** jsDelivr/unpkg serve the `.wasm` as `application/wasm` with
  `access-control-allow-origin: *` (streaming instantiation works; wasm-bindgen
  falls back to non-streaming `instantiate` on a wrong MIME type). Fetch the splat
  from a CORS-enabled host — `raw.githubusercontent.com` sends
  `access-control-allow-origin: *`. `.spz` examples are gunzipped in-browser
  (`DecompressionStream('gzip')`) before `spz_to_ply`.

## 11. React Three Fiber (three.js) integration

A first-class three.js / React reference ships in-repo: route `/react`, source
under `src/react/` (engine logic in `src/react/three/SplatNavController.ts`),
documented in [`../examples/r3f/README.md`](../examples/r3f/README.md). It renders
the splat with [`@mkkellogg/gaussian-splats-3d`](https://github.com/mkkellogg/GaussianSplats3D)
and drives the same WASM floor module + `recast-navigation` crowd as Babylon.

**Live demo:** <a href="https://splatwalk.onrender.com/react" target="_blank" rel="noopener noreferrer">splatwalk.onrender.com/react</a>

**Handedness — the one extra step vs. Babylon.** three.js is **right-handed**
while the Babylon reference is left-handed. If you render the splat naively in
three.js, the scene comes out **mirrored** (text/signs read backwards). Fix it
once at the scene root: parent everything in a group with `scale.z = -1`, and
flip the splat itself on Y (matching Babylon's loader):

```ts
// root world — emulate Babylon's left-handed chirality
const world = new THREE.Group();
world.scale.z = -1;
scene.add(world);

// the splat — Y-flip the raw (Y-down) splat into +Y-up space
const splatGroup = new THREE.Group();
splatGroup.scale.set(1, -1, 1);
world.add(splatGroup);
```

The net splat transform (`z = -1` ∘ `y = -1`) is a **proper 180° rotation about
X** (determinant `+1`), so the splat is upright **and un-mirrored** — identical
chirality to Babylon. Floor, navmesh overlay and agents are all children of
`world`, so they share that space.

**`flip_y: true`.** As with Babylon, build the WASM floor/navmesh with
`flip_y: true` so the core's `+Y = up` heuristics match the rendered (Y-flipped)
splat. No per-output Y offsets.

**Click-to-move across the Z mirror.** A raycast hit is in **world** space (after
the `scale.z = -1`), but Recast expects the navmesh's own coordinates. Convert
back with `worldToLocal` before steering:

```ts
raycaster.setFromCamera(ndc, camera);
const hit = raycaster.intersectObject(navMeshOverlay, false)[0];
if (hit) {
  const local = navMeshOverlay.worldToLocal(hit.point.clone());   // undo the Z mirror
  playerAgent.requestMoveTarget({ x: local.x, y: local.y, z: local.z });
}
```

Lift agent meshes by half their height (`userData.yOffset`) so they rest on the
navmesh rather than sinking into it.

**Top-down framing.** Place the perspective camera straight above the player at
`cameraHeight = playerTopY + clamp(ceilingY - margin - playerTopY, playerHeight, 4)`,
target the player, and use a vertical FOV of `~0.8 rad (45.84°)` to match
Babylon's `ArcRotateCamera`. Use a ceiling `margin` of ~`0.65 m` so the camera
keeps headroom below the ceiling instead of hugging it.

## 12. Integrator ask status

The community integration wishlist gathered against the pre-release core is fully
addressed as of v0.3.0:

| Ask | Status |
| --- | --- |
| Consumable FAST NAV preset | Met - `fast_nav_preset()`, baked into `build_room_floor_mesh` |
| Version / capability introspection | Met - `splatwalk_version()` / `_api_version()` / `_capabilities()` |
| Precise TypeScript types | Met - hand-authored `.d.ts` shipped in the package |
| Structured `build_room_floor_mesh` failures | Met - `RoomFloorFailure` with stable `reason` |
| Output handedness / up-axis / winding | Met - `settings.output_space` |
| Recast-ready agent params / helper | Met - `recast_agent_defaults()` + `recast_config()` |
| Structured progress callback | Met - `set_progress_callback()` |
| Published, versioned package | Resolved in v0.3.0 - `@splatwalk/core` on npm |
| Non-AGPL embedding path | Resolved in v0.3.0 - MIT core, free forever (see `../LICENSING.md`) |
| `.spz` / `.splat` input without a CDN | Met - normalized to PLY in WASM at ingest (`spz_to_ply` / `splat_to_ply`, capability `splat_ingest`) |
| Report the parsed splat orientation on the result (derive `flip_y` from the core instead of `mesh.scaling.y`) | Not applicable by design - a 3DGS PLY header carries no chirality/up-axis to report, and the render-space Y-flip is the renderer's loader decision, not a parse result. The core would only echo the `flip_y` you pass in. Detect it once from your renderer's splat transform (Babylon: `mesh.scaling.y < 0`); normalizing every format to one PLY loader path keeps that read stable. |
