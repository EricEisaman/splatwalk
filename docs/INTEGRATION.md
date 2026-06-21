# SplatWalk Integration Guide

A task-oriented guide to integrating the SplatWalk WASM core (`@splatwalk/core`)
into any engine or framework. For the exhaustive per-entry-point reference (units,
ranges, cell states, coordinate contract), see [`wasm-api.md`](wasm-api.md). This
guide shows the common paths end to end.

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
9. [Integrator ask status](#9-integrator-ask-status)

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
const version = splatwalk_version();          // tracks the crate version, e.g. '0.3.0'

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

## 9. Integrator ask status

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
