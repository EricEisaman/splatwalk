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
const version = splatwalk_version();          // tracks the crate version, e.g. '0.3.2'

if (!caps.includes('room_floor_mesh')) {
  // Fall back to the multi-step field path instead of the one-call entry point.
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

## 4. The coordinate / `flip_y` contract (read this first)

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

## 5. Feeding Recast without the voxel-truncation bug

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

## 6. Progress reporting

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

## 7. Handling failures

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

## 8. Framework-agnostic floor module

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

## 9. Babylon.js integration

Babylon.js is the reference renderer for the SplatWalk showcase. The complete,
working integration is `src/scene/Viewer.ts` (UI in `src/vuetify/`, route
`/vuetify`); this section distills the engine-specific contract.

**Live demo:** <a href="https://splatwalk.onrender.com/vuetify" target="_blank" rel="noopener noreferrer">splatwalk.onrender.com/vuetify</a>

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

## 10. React Three Fiber (three.js) integration

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

## 11. Integrator ask status

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
