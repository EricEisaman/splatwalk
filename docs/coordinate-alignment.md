# Canonical Gaussian-Splat Alignment Recipe

The single most common SplatWalk integration bug is a navmesh that is mirrored,
rotated, or vertically offset from the rendered splat. This page is the one-page
recipe that prevents it, across every renderer. It consolidates the per-engine
detail in [`INTEGRATION.md`](INTEGRATION.md) sections 4, 9, and 10 and the
`output_space` reference in [`wasm-api.md`](wasm-api.md#output-coordinate-space-settingsoutput_space).

It is the interop standard referenced by
[`../MUTUALISM_MILESTONES.md`](../MUTUALISM_MILESTONES.md) (Cross-cutting standards
#1) and tracks SplatWalk issue
[#3](https://github.com/EricEisaman/splatwalk/issues/3) and Babylon PR
[#18606](https://github.com/BabylonJS/Babylon.js/pull/18606).

## The rule (three steps, in order)

1. **Detect handedness once, at the renderer boundary.** Read it from the
   renderer's actual splat transform or scene convention — never guess, and never
   hard-code per scene.
2. **Pass it straight into every WASM call.** Use `flip_y` (and, when you want the
   core to emit in your engine's convention, `output_space`). The same value must
   feed *every* entry point in a run — bounds, region, field, mesh, navmesh basis.
3. **Never patch alignment on the output.** Do not add visual Y offsets, mirror
   meshes, or nudge the floor to "make it line up." If it is misaligned, step 1 or
   2 is wrong. Fix the input, not the output.

## Why this works

The WASM core parses raw PLY/SPZ coordinates and, by default, emits everything in
**`splatwalk_oriented`** space: right-handed, `+Y` up, triangle indices wound
counter-clockwise (front-facing from the `+` side of the normal). Renderers,
however, import Gaussian splats in their own convention — usually Y-down — so the
*rendered* splat lives in a different space than the *parsed* bytes. `flip_y` tells
the core to negate parsed Y so its `+Y = up` floor/clearance heuristics are valid
in the space you actually render, and the navmesh, basis, and spawn all coincide
with the splat on one plane.

## Per-engine detection

| Engine | Convention | Detection | Pass to WASM |
| --- | --- | --- | --- |
| Babylon.js (default) | Left-handed | Splat loader imports with a negative Y scale: `mesh.scaling.y < 0` | `flip_y: true` |
| Babylon.js (right-handed) | Right-handed | `scene.useRightHandedSystem === true` | `flip_y` from the splat transform; see below |
| three.js | Right-handed (native) | Fixed by convention (no per-scene guess) | `flip_y: true` |

### Babylon.js (left-handed, the showcase default)

Babylon is left-handed by default. Its splat loader imports with a negative Y
scale, so detect the flip from the mesh and feed it in — see
[`../src/scene/Viewer.ts`](../src/scene/Viewer.ts) `isSplatYFlipped()`:

```ts
mesh.computeWorldMatrix(true);
const flip_y = (mesh.scaling?.y ?? 1) < 0;   // true for a standard splat import
const floor = build_room_floor_mesh(splatBytes, { mode: 2, flip_y, rotation });
```

Because the left-handed scene and the splat's Y-flip cancel against the core's
right-handed `+Y`-up output, the navmesh and crowd render directly with **no Z
mirror**.

### Babylon.js (right-handed) — the PR #18606 counterpart

Babylon PR [#18606](https://github.com/BabylonJS/Babylon.js/pull/18606) makes the
Gaussian-splat depth sort honor `scene.useRightHandedSystem` (a `rightHanded`
flag propagated into the sort worker) so splats sort correctly in right-handed
scenes. That is the *runtime rendering* counterpart of this *geometry boundary*
recipe: the splat now renders correctly in RH, and SplatWalk emits geometry in the
matching space.

In a right-handed Babylon scene the core's default `splatwalk_oriented` output
(right-handed, `+Y` up) already matches the scene handedness, so you do **not**
mirror. Keep deriving `flip_y` from the splat transform; if you want the core to
also match a non-`+Y`-up convention, request it explicitly with `output_space`
(below) instead of baking a transform at the boundary.

This is shipped as a regression scene: the Vuetify showcase reads a hidden
`?rh=1` URL flag and constructs the viewer with `scene.useRightHandedSystem = true`
([`../src/scene/Viewer.ts`](../src/scene/Viewer.ts) `ViewerOptions.rightHanded`,
wired through [`../src/composables/useBabylonViewer.ts`](../src/composables/useBabylonViewer.ts)).
There is no user-facing toggle — left-handed is the one correct everyday setting;
`?rh=1` exists only to validate the contract. Measured on the `Bedroom` scene at
`?rh=1` (splat 499,959 verts vs `navmesh_debug`): the navmesh `X[-1.16, 5.68]` /
`Z[-0.27, 6.4]` footprint sits **inside** the splat `X[-2.99, 7.79]` /
`Z[-1.91, 8.58]` footprint (same positive-`Z` room region — not mirrored), on a
single floor plane at `Y = -1.41`, with the player and NPC agents resting exactly
on that plane. Splat, navmesh, and crowd coincide with no boundary mirror.

### three.js (right-handed, native)

three.js is right-handed. The reference R3F demo
([`../src/react/three/SplatNavController.ts`](../src/react/three/SplatNavController.ts))
currently parents the scene in a `world` group with `scale.z = -1` to *emulate*
Babylon's left-handed chirality, and flips the splat on Y (`scale.y = -1`); the
net splat transform is a proper 180-degree rotation about X (determinant `+1`), so
the splat is upright and un-mirrored. Build the WASM floor/navmesh with
`flip_y: true` as in Babylon.

It is tempting to drop the Z mirror entirely — three.js is natively right-handed,
the same handedness the core emits — and consume `splatwalk_oriented` geometry
directly. In practice the bundled splat loader
(`@mkkellogg/gaussian-splats-3d`) imports PLY/SPZ data **Y-down**, so standing the
splat upright requires a Y flip. A *bare* Y flip is improper (determinant `-1`) and
renders the splat mirrored (text/signs reversed). Making it upright **and**
un-mirrored requires a proper 180-degree rotation (e.g. about X), which itself
flips Z — so the floor/navmesh must still be Z-reflected to coincide with the
splat. The Z mirror is therefore **intrinsic to this loader**, not an arbitrary
emulation choice: the reference demo applies it once at the `world` group, yielding
a true right-handed scene whose splat, navmesh, and crowd coincide. A loader that
imported splats `+Y`-up could skip the mirror; the bundled one cannot.

## `output_space`: emit in your engine's convention

Baking a per-engine root transform into the core does not generalize, but the
common, generalizable conversions are available as an opt-in. Set
`settings.output_space` to have the core convert all geometric outputs (mesh
vertices, `FieldBasis`, `FloorPlane` normal, and the top-level oriented bounds /
region corners) into your convention. The reported `space` then becomes
`engine_output` with your requested `up_axis` / `handedness`.

```ts
const result = build_room_floor_mesh(splatBytes, {
  mode: 2,
  flip_y: true,
  output_space: {
    up_axis: 'y',        // 'y' (default) or 'z' (rotate +Y-up into +Z-up about X)
    handedness: 'left',  // 'right' (default) or 'left' (mirror the Z axis)
    winding: 'auto',     // 'auto' (default), 'ccw', or 'cw'
  },
});
// result.space.space === 'engine_output'
```

### When to use which

| Situation | Use |
| --- | --- |
| Babylon left-handed (showcase) | `flip_y` only; render `splatwalk_oriented` directly |
| three.js native right-handed | `flip_y` only; `splatwalk_oriented` already matches |
| You need geometry pre-converted to a specific up-axis/handedness | `output_space` |
| You apply your own root/axis bake in the engine | Prefer **one** of `output_space` *or* a boundary bake, not both |

### The single-winding-correction parity rule

Requesting `handedness: 'left'` (or `winding: 'cw'`) reverses triangle winding so
faces stay front-facing in the new space (`winding: 'auto'` flips only when the
resolved basis is mirrored, i.e. negative determinant — see
[`../wasm-splatwalk/src/output_space.rs`](../wasm-splatwalk/src/output_space.rs)).
If your engine *also* applies its own negative-axis bake, you now have two parity
flips that cancel. Track the combined parity and apply **at most one** winding
correction total, or front faces will cull.

Per-cell ground-field scalars (`cells[]`) and the `diagnostics` bag always stay in
`splatwalk_oriented` space; convert those at the boundary if you need them in
engine space.

## Regression check

The winding / up-axis / handedness behavior of `output_space` is asserted by a
headless script — run it after a wasm build:

```bash
npm run build:wasm
npm run check:handedness
```

See [`../examples/handedness-check.mjs`](../examples/handedness-check.mjs).
