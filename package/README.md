# @splatwalk/core

The SplatWalk WASM core as a single, versioned, binary-friendly package. It bundles:

- `wasm_splatwalk.js` + `wasm_splatwalk_bg.wasm` — the wasm-bindgen glue and binary.
- `wasm_splatwalk.d.ts` — hand-authored TypeScript declarations with the real
  settings and result shapes (the generated wasm-bindgen `.d.ts` types every
  argument and result as `any`).
- `floor` subpath — a framework-agnostic FAST NAV floor module (`buildFastFloorMesh`,
  `extractFloorFieldWithRecovery`, `trimStrayFloorCells`, the dense-floor seed/region
  estimators, the recovery ladder, and the canonical `FAST_NAV_PRESET`). No Babylon
  or bundler dependency.

This package targets binary-only and non-Babylon integrators. The reference
TypeScript bridge and Babylon UI live in the main SplatWalk repository.

## Install

```bash
npm install @splatwalk/core
```

MIT-licensed and free forever, including for commercial and proprietary use.
See [`LICENSING.md`](https://github.com/EricEisaman/splatwalk/blob/main/LICENSING.md).

## Use the binary directly

```ts
import init, {
  build_collision_voxel_boundary,
  init_splatwalk,
  build_walkable_ground_field,
  build_room_floor_mesh,
  mesh_to_glb,
} from '@splatwalk/core';

await init();          // always init before calling named exports
init_splatwalk();

const field = build_walkable_ground_field(splatBytes, settings);
if (field.api_version !== 2) throw new Error('stale SplatWalk binary');

// One-call room floor (binary-side equivalent of the FAST NAV floor path):
const floor = build_room_floor_mesh(splatBytes, { ...settings, emit_glb: true });
const glb = floor.glb ?? mesh_to_glb(floor.mesh.vertices, floor.mesh.indices);

// Collision voxel boundary mode (runtime physics / .collision.glb export):
const collision = build_collision_voxel_boundary(splatBytes, {
  ...settings,
  collision_mesh_mode: 'faces',
  emit_glb: true,
});
const collisionGlb =
  collision.glb ?? mesh_to_glb(collision.mesh.vertices, collision.mesh.indices);
```

`semver` and `capabilities` on every result let you tolerate additive change
instead of hard-failing on a version bump; `api_version` stays the hard gate.
Check for `collision_voxel_boundary` before showing collision export UI in apps
that may run against older published binaries.

## Use the framework-agnostic floor module

```ts
import {
  FAST_NAV_PRESET,
  extractFloorFieldWithRecovery,
  resolveRecovery,
} from '@splatwalk/core/floor';

const result = await extractFloorFieldWithRecovery({
  bytes: splatBytes,
  // Inject the binary's field builder so the module stays engine-agnostic:
  buildField: async (b, s) => build_walkable_ground_field(b, s),
  baseSettings: { ...FAST_NAV_PRESET, rotation, flip_y, collision_seed },
  seed: collision_seed,
  recovery: resolveRecovery(),
  log: (m) => console.log(m),
});
```

See the [Integration Guide](https://github.com/EricEisaman/splatwalk/blob/main/docs/INTEGRATION.md)
for a task-oriented walkthrough, and `docs/wasm-api.md` in the main repository for
the full settings reference, the coordinate + winding contract, and the progress
line protocol.
