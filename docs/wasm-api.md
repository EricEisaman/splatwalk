# SplatWalk WASM API

This document describes the v2 SplatWalk WASM API contract. The v2 API is intentionally breaking: callers should treat the WASM result shapes as structured reconstruction contracts rather than raw mesh buffers.

## Coordinate Contract

- `settings.flip_y` (optional `boolean`, default `false`) negates the Y axis of every parsed splat (both position and normal) immediately after parsing, before any other stage. Set it to match how your renderer displays the splat: Gaussian-splat loaders (e.g. Babylon.js) import with a negative Y scale, so the rendered splat lives in a Y-flipped world relative to the raw PLY/SPZ data. Passing that flip keeps the returned floor, basis, mesh, spawn points, and agents co-located with the rendered splat. It also orients gravity correctly for WASM's `+Y = up` floor/clearance heuristics. Derive it from your renderer's actual splat transform (the sign of its world Y scale), not a guess.
- `settings.rotation` is applied after `flip_y`, and before bounds, suggested regions, region filtering, mesh extraction, navmesh-basis generation, and walkable-ground-field generation. Re-running generation after a user rotation therefore re-aligns every output to the new orientation.
- `region_min` and `region_max` are expressed in `splatwalk_oriented` space (post-`flip_y`, post-`rotation`).
- `splatwalk_oriented` uses `up_axis: "y"` and `handedness: "right"`.
- `get_splat_bounds`, `suggest_region`, `convert_splat_to_mesh`, `build_collision_voxel_boundary`, `convert_splat_to_navmesh_basis`, and `build_walkable_ground_field` all report the `space` metadata they use.
- Returned mesh vertices are emitted in the same `splatwalk_oriented` space as region filtering. Integrators should not infer transforms from Babylon preview meshes.
- Every v2 result includes `api_version: 2` so integrations can fail fast on stale bindings.

### Handedness, up axis, and winding

The target convention is fixed and is part of the binary contract:

- **Up axis:** `+Y` is up. All floor/clearance heuristics assume gravity points along `-Y`, so a Y-down source must set `flip_y` (see below).
- **Handedness:** `splatwalk_oriented` is **right-handed**. Reported as `handedness: "right"` on every result that carries `space`.
- **Winding:** returned triangle indices are wound counter-clockwise (front-facing) when viewed from `+` along the face normal, consistent with a right-handed space.

Because the contract is fixed, converting to a specific engine's handedness/up-axis is the integrator's responsibility and should be done **once, at your application boundary** — not by mutating settings per call. Two concrete consequences:

- **A `flip_y` bake is a mirror (negative scale), and a mirror flips winding/orientation.** When `flip_y` is set, every parsed splat's Y (position and normal) is negated before any other stage. A single-axis negation has determinant `-1`, so the effective basis is mirrored. The returned mesh is still internally consistent in `splatwalk_oriented` space, but if your renderer applies its own additional negative-axis bake (the common Gaussian-splat import path), be aware that composing two mirrors restores a right-handed, CCW result, while composing an odd number of mirrors yields a left-handed, CW result. Track the parity of negative-scale bakes between SplatWalk space and your engine and apply a single winding/normal correction at the boundary if the parity is odd.
- **Do not bake any single engine's root transform into the core.** A specific engine's root-node transform is engine-specific and does not generalize; keep that in your integration layer. For the common, generalizable conversions, however, you can now ask the core to emit results directly (see "Output coordinate space" below) instead of mirroring/flipping at the boundary.

### Output coordinate space (`settings.output_space`)

By default every result is emitted in `splatwalk_oriented` space. As an opt-in, set `settings.output_space` to have the core convert all geometric outputs into your engine's convention (capability flag `output_space`):

```ts
output_space?: {
  up_axis?: 'y' | 'z';          // 'y' (default) or 'z' (rotate +Y-up into +Z-up about X)
  handedness?: 'right' | 'left'; // 'right' (default) or 'left' (mirror the Z axis)
  winding?: 'auto' | 'ccw' | 'cw'; // 'auto' (default) flips winding only when the basis is mirrored
}
```

When set, the core applies a single linear map (plus an optional winding flip) to the mesh vertices, the `FieldBasis` vectors, and the `FloorPlane` normal, and recomputes the top-level oriented bounds / region corners. The reported `space` becomes `engine_output` with your requested `up_axis` / `handedness`. **Per-cell ground-field scalars (`cells[]`) and the `diagnostics` bag stay in `splatwalk_oriented` space** — convert those at the boundary if you need them in engine space. Omitting `output_space` leaves all outputs byte-for-byte identical to prior releases.

The same parity rule as `flip_y` applies: requesting `handedness: 'left'` (or `winding: 'cw'`) reverses triangle winding so faces stay front-facing in the new space. If your engine also applies its own negative-axis bake, track the combined parity and apply at most one winding correction.

### Versioning and capability flags

Every v2 result carries three compatibility fields:

- `api_version` (currently `2`) — the **hard** data contract. Treat a mismatch as a fatal, fail-fast condition.
- `semver` (e.g. `"0.2.0"`) — the semantic version of the WASM core build, tracking the crate version. Use it for logging, cache keys, and human-facing diagnostics.
- `capabilities` — an additive `string[]` of supported features (`collision_voxel_boundary`, `progress_protocol_v1`, `glb_export`, `room_floor_mesh`, `sog_export`, `streamed_sog`, `fast_nav_preset`, `output_space`, `recast_config`, `progress_callback`, `splat_ingest`). Feature-detect against this list so additive changes (new entry points / fields) do not force a hard failure. Never assume a capability is present without checking; never fail solely because an unknown capability appears.

For cheap **pre-flight** feature detection (before parsing any bytes), call the standalone exports `splatwalk_version()`, `splatwalk_api_version()`, and `splatwalk_capabilities()` — they return the same values that appear on a full result, without the cost of a parse/field build.

## Entry Points

### `get_splat_bounds(bytes, settings)`

Returns authoritative oriented point-cloud bounds after rotation and validity filtering:

```ts
{
  api_version: 2;
  point_count: number;
  oriented_min: [number, number, number];
  oriented_max: [number, number, number];
  floor_y_percentile_02: number;
  space: CoordinateSpace;
}
```

### `suggest_region(bytes, settings)`

Returns the suggested bottom-band selector in the same coordinate space used by reconstruction:

```ts
{
  api_version: 2;
  region_min: [number, number, number];
  region_max: [number, number, number];
  floor_y: number;
  sample_count: number;
  clamped_height: boolean;
  space: CoordinateSpace;
}
```

The default selector spans the oriented X/Z footprint and covers the bottom 2 meters, clamped only when the splat is shorter than 2 meters.

### `convert_splat_to_mesh(bytes, settings)`

Returns a structured reconstruction result:

```ts
{
  api_version: 2;
  mesh: {
    vertices: Float32Array;
    indices: Uint32Array;
    vertex_count: number;
    face_count: number;
  };
  space: CoordinateSpace;
  diagnostics: ReconstructionDiagnostics;
}
```

`diagnostics` includes point counts, region filtering counts, RANSAC inliers, grid dimensions, accepted cell counts, face rejection counts, connected-component counts, low-confidence hole-fill counts, optional distance-field erosion counts, discarded-component counts, and the detected floor plane when available.

### `build_collision_voxel_boundary(bytes, settings)`

Builds the PlayCanvas-style runtime collision representation: splat occupancy -> voxel fill/seal -> reachable-space carve -> watertight boundary mesh. This is the primary collision/physics export path and is separate from the FAST NAV floor-field path.

```ts
{
  api_version: 2;
  mesh: MeshBuffers;
  glb?: Uint8Array; // present when settings.emit_glb === true
  space: CoordinateSpace;
  basis: FieldBasis;
  floor_plane: FloorPlane;
  diagnostics: ReconstructionDiagnostics;
}
```

Set `emit_glb: true` to receive `.collision.glb` bytes directly. Otherwise call `mesh_to_glb(result.mesh.vertices, result.mesh.indices)` with the returned mesh. `collision_mesh_mode: "faces"` emits exact exposed voxel faces, matching PlayCanvas `splat-transform -K faces` semantics. `collision_mesh_mode: "smooth"` is reserved and is rejected until a marching-cubes-style surface is implemented.

### `convert_splat_to_navmesh_basis(bytes, settings)`

Legacy/advanced compatibility wrapper that returns the generated voxel collision basis mesh and metadata for Recast or engine-specific navmesh bakes:

```ts
{
  api_version: 2;
  mesh: MeshBuffers;
  space: CoordinateSpace;
  basis: FieldBasis;
  floor_plane: FloorPlane;
  diagnostics: ReconstructionDiagnostics;
}
```

The mesh is the same generated voxel collision boundary used by the advanced/manual collider navmesh path, but new collision integrations should call `build_collision_voxel_boundary` so collision export code does not read as a navmesh-basis operation. It remains useful for old callers that already feed this mesh into Recast when no imported `.collision.glb` / Collider Mesh GLB exists. It is not the `FAST NAV` default because Recast can treat collider boundary faces as walkable surfaces in noisy indoor scans.

### `build_walkable_ground_field(bytes, settings)`

Returns the projected walkable ground field before mesh extraction:

```ts
{
  api_version: 2;
  cells: GroundFieldCell[];
  width: number;
  height: number;
  cell_size: number;
  basis: FieldBasis;
  floor_plane: FloorPlane;
  space: CoordinateSpace;
  diagnostics: ReconstructionDiagnostics;
}
```

Each `GroundFieldCell` has:

```ts
type GroundFieldCellState =
  | "walkable"
  | "low_confidence"
  | "height_variance"
  | "obstacle"
  | "void"
  | "filled"
  | "eroded"
  | "discarded_component";

interface GroundFieldCell {
  height: number;
  confidence: number;
  variance: number;
  normal_alignment: number;
  obstacle_score: number;
  primary_layer_height: number;
  layer_count: number;
  peak_density: number;
  surface_confidence: number;
  signed_distance: number;
  gradient: [number, number];
  component_id: number;
  state: GroundFieldCellState;
}
```

This is the best API for diagnosing the 2.5D SDF column field before those details are collapsed into a triangle mesh. The cells track density-derived surface height, peak density, surface confidence, layer count, local height variance, gradient, obstacle evidence, rejected cells, component-bounded low-confidence holes, optional distance-field erosion, and connected components.

Floor classification is anchored to a scene-wide dominant plane rather than to each column's lowest layer. During extraction every column's density profile is split into contiguous above-threshold layers, and each layer's density (weighted by `|normal_y|`, so horizontal surfaces dominate regardless of whether the data is Y-up or Y-down) is accumulated into a scene-wide height histogram. The heaviest histogram bin is the global floor plane. Each column then takes the layer whose centroid is closest to that plane as its floor. This is the key correction over the previous "lowest above-threshold layer is the floor" rule, which latched onto faint sub-floor splats (shadow/noise beneath the real floor slab) and sank the navmesh ~0.5–1 m below the visible floor. Picking the per-column densest layer was also wrong because furniture tops then masqueraded as floor; anchoring to the global dominant plane rejects both faint sub-floor slivers (below the plane) and furniture/shelf tops (above the plane) without any hand-tuned distance constant.

Obstacle classification is clearance-band aware. Only density inside an agent clearance band above the floor layer (`obstacle_clearance_min` to `obstacle_clearance_max`, defaulting from `floor_projection_epsilon` and `collision_carve_height`) counts as a navigation obstacle. Density at or below the floor surface is treated as part of the floor slab (rugs, thresholds), and density above the band (ceilings, high shelves, tall plant canopy, overhead beams) is ignored so open floor under a high ceiling stays walkable. This requires gravity to point along `+Y`; see `flip_y` in the Coordinate Contract for Y-down sources.

Walkable continuity is judged against neighbors, not intra-column layer spread: a cell is rejected as a discontinuity (`height_variance`) only when its floor height departs from the local 8-neighbor median by more than a step threshold derived from `obstacle_height_epsilon`. This replaces the previous intra-column variance gate, which wrongly rejected floor merely because furniture or a ceiling existed somewhere above it.

The browser `FAST NAV` workflow uses this field directly: it snaps the start seed onto the detected floor plane, keeps only `walkable` and `filled` cells (with a relaxed fallback mask for noisy scans), rejects obstacle/discontinuity/void/low-confidence/eroded/discarded cells, selects the connected floor component nearest the seed, triangulates that floor component, and sends that floor mesh to Recast. This keeps the one-button path focused on visible room floors instead of collider boundary artifacts.

### Standalone helpers and introspection

These exports take no splat bytes and do no parsing, so they are cheap to call up front.

- `splatwalk_version() -> string`, `splatwalk_api_version() -> number`, `splatwalk_capabilities() -> string[]` — pre-flight feature detection. Same values as the corresponding fields on a full result, without the parse/field-build cost.
- `fast_nav_preset() -> MeshSettings` — the canonical FAST NAV floor-field preset as a settings object (capability `fast_nav_preset`). Merge it with your per-scene `rotation` / `flip_y` / `collision_seed` / `region_*` and pass it to `build_walkable_ground_field`. `build_room_floor_mesh` already applies this preset as its base layer automatically, so you no longer need to reconstruct the values.
- `recast_agent_defaults() -> { cs, ch, walkableHeight, walkableRadius, walkableClimb, walkableSlopeAngle }` — the reference FAST NAV agent dimensions in **metres**.
- `recast_config(settings) -> { cs, ch, walkableHeight, walkableClimb, walkableRadius, walkableSlopeAngle, bmaxYPadding, suggestedBmaxY }` (capability `recast_config`) — converts metre-valued agent dimensions into Recast's integer voxel counts (`walkableHeight = ceil(h/ch)`, `walkableClimb = floor(climb/ch)`, `walkableRadius = ceil(r/cs)`) and returns the suggested vertical-bounds padding (`bmaxYPadding = walkableHeight_m + 0.5`, and `suggestedBmaxY = maxFloorY + bmaxYPadding` when you pass `maxFloorY`). Inputs default to `recast_agent_defaults()` when omitted. This removes the "navmesh collapses to a slab / fragments into islands" class of bugs described in "Recast parameter units (metres vs voxels)".

### `build_room_floor_mesh(bytes, settings)` failure shape

On success it returns a `RoomFloorMeshResult` (capability `room_floor_mesh`). On failure it throws/rejects with a **structured** object (not a string), so you branch on a stable code instead of parsing prose:

```ts
{
  api_version: 2;
  reason: 'no_component' | 'too_small' | 'empty_mesh' | 'no_steps';
  message: string;          // human-readable summary across attempts
  attempted: string[];      // each step formatted as `label(reason)`
  selected_area: number;    // largest usable floor area (m^2)
  component_count: number;
  steps: number;
}
```

## Progress Line Protocol

Long-running WASM calls report coarse progress by emitting a specially-prefixed
line through the WASM `console` log. This is SplatWalk's own mechanism (the Rust
core emits it and the reference worker scrapes it), and it is a **stable part of
the binary contract**, advertised by the `progress_protocol_v1` capability flag.

A batched log-line protocol is used deliberately: a per-iteration callback from
WASM into JS would be a measurable performance regression for no real accuracy
gain, so progress is emitted at stage boundaries only.

For integrators who prefer not to intercept the global console, register an
opt-in callback (capability flag `progress_callback`):

```ts
set_progress_callback((stage, fraction) => updateBar(stage, fraction));
// ...later, to stop receiving events:
set_progress_callback(undefined);
```

The callback fires at the same stage boundaries with `(stage: string, fraction?:
number)`, and the `@progress` console lines are still emitted as a fallback, so
both mechanisms can coexist.

### Format

```none
@progress <stage> [<fraction>]
```

- The line begins with the exact prefix `@progress ` (note the trailing space).
- `<stage>` is a single whitespace-free token naming the current stage (e.g.
  `parse`, `prune`, `field`, `mesh`). New stage names may be added over time;
  treat unknown stages as opaque labels.
- `<fraction>` is **optional**. When present it is a number in `0..1` giving
  fractional progress within the stage.
- **Indeterminate progress:** when `<fraction>` is omitted (or not a finite
  number), the stage has no meaningful percentage — show a busy/indeterminate
  indicator rather than a percentage. Do not assume `0`.

### Consuming it

Intercept console output, and for any line starting with `@progress `, split off
the prefix and parse the remainder:

```ts
function parseProgress(message: string): { stage: string; fraction: number | null } | null {
  if (!message.startsWith('@progress ')) return null;
  const parts = message.slice('@progress '.length).trim().split(/\s+/);
  const stage = parts[0] ?? 'processing';
  const fraction = parts.length > 1 ? Number(parts[1]) : NaN;
  return { stage, fraction: Number.isFinite(fraction) ? fraction : null };
}
```

The reference worker (`src/wasm/splat.worker.ts`) does exactly this and re-posts a
structured `{ stage, fraction }` message; the bridge surfaces it via an
`onProgress(stage, fraction)` hook. Progress lines must be routed to the progress
channel and kept out of the human-readable log panel.

## Streamed SOG Export And Slicing

SplatWalk can convert a `.ply`/`.spz` splat into a **SOG** (Spatially Ordered
Gaussians) bundle — the quantized, WebP-textured format decoded by Babylon's
`@babylonjs/loaders/SPLAT` (`ParseSogMeta` / `ParseSogMetaAsTextures`). Two
shapes are produced: a single SOG (`meta.json` + planes) or a streamed,
multi-chunk LOD bundle (`lod-meta.json` + per-chunk SOG datasets) intended for
the Babylon GS streaming loader (PR #18563).

All quantization **and** lossless WebP encoding happen inside the WASM call
(`image-webp`, VP8L), so the returned bytes are final. The TypeScript worker
only collates them into a path-keyed file map.

### `slice_splat(bytes, settings)`

Slice a splat into a streamed-SOG bundle. Returns a manifest:

```ts
{
  lodMetaPath: string;                 // "lod-meta.json"
  lodMetaJson: string;                 // manifest contents
  files: { path: string; contents: string }[];          // per-chunk meta.json
  binaries: { path: string; bytes: Uint8Array }[];       // lossless .webp planes
  splatCount: number;
  chunkCount: number;
}
```

Bundle layout (paths are bundle-relative, ready to host as-is):

```none
lod-meta.json
0_0/meta.json
0_0/means_l.webp        # 16-bit means, low byte
0_0/means_u.webp        # 16-bit means, high byte
0_0/scales.webp         # codebook-indexed log-scales
0_0/quats.webp          # largest-three packed rotation
0_0/sh0.webp            # codebook DC color (RGB) + opacity (A)
0_0/shN_centroids.webp  # SH palette centroids (when SH degree > 0)
0_0/shN_labels.webp     # per-splat palette index
0_1/...
1_0/...
```

`lod-meta.json` is canonical PlayCanvas Streamed SOG v1 and also satisfies
Babylon.js native `GaussianSplattingStream` metadata checks. Babylon requires the
structural subset `lodLevels`, `filenames`, and `tree`; PlayCanvas v1 additionally
requires `version: 1`, `count`, and `counts`:

```ts
{
  version: 1;
  count: number;                 // finest/full-resolution Gaussian count
  counts: number[];              // per-LOD counts; index 0 = finest
  lodLevels: number;             // number of LOD levels
  filenames: string[];           // e.g. "0_0/meta.json", "1_0/meta.json"
  tree: {
    bound: {
      min: [number, number, number];
      max: [number, number, number];
    };
    children?: unknown[];        // internal nodes
    lods?: {
      [level: string]: {
        file: number;            // index into filenames
        offset: number;          // first splat in that chunk
        count: number;           // number of splats
      };
    };                           // renderable leaves
  };
}
```

### `convert_to_sog(bytes, settings)`

Convert a splat into a single (non-LOD) SOG v2 bundle. Returns the same manifest
shape as `slice_splat`, with `lodMetaPath: "meta.json"` and all planes at the
bundle root.

### `spz_to_ply(bytes)`

Convert a `.spz` (or `.ply`) splat to a full-fidelity binary little-endian 3DGS
`.ply` (`Uint8Array`), preserving the spherical-harmonic stack. SplatWalk uses
this to normalize `.spz` input to PLY so the viewer and nav pipeline only ever
deal with PLY. `.spz` files are gzip-compressed; decompress them (e.g. via the
browser `DecompressionStream`) before calling.

### `splat_to_ply(bytes)`

Convert an antimatter15 `.splat` buffer (a flat array of fixed 32-byte records,
no header) to a full-fidelity binary little-endian 3DGS `.ply` (`Uint8Array`).
The `.splat` format carries no spherical harmonics, so the output is SH degree 0;
linear scale is converted to log space, RGBA to an SH0 DC coefficient + opacity
logit, and the packed `u8` quaternion is renormalized. Capability `splat_ingest`.
Together with `spz_to_ply`, this normalizes every supported input to PLY at one
ingest boundary (`src/wasm/normalize.ts`), so the viewer drives only Babylon's
PLY loader (no CDN-hosted `.spz` decoder) and the nav pipeline always sees PLY.

### Slice settings

All fields are optional and fall back to the defaults below:

```ts
interface SliceSettings {
  sh_degree?: number;        // exported SH degree cap, 0..3   (default 0)
  sh_cluster_count?: number; // shN k-means palette size       (default 4096)
  sh_iterations?: number;    // shN k-means refinement passes  (default 10)
  chunk_count?: number;      // target splats per LOD chunk    (default 256000)
  chunk_extent?: number;     // soft chunk extent in meters    (default 16)
  lod_levels?: number;       // LOD levels, >=1                (default 2)
}
```

Streamed SOG export is canonical PlayCanvas Streamed SOG v1:

- `lod-meta.json` contains `version: 1`, `count`, `counts`, `lodLevels`,
  `filenames`, and `tree`.
- `filenames` point to unbundled SOG v2 chunk metadata such as
  `0_0/meta.json`, `0_1/meta.json`, and `1_0/meta.json`.
- LOD `0` is finest/highest detail; higher numeric LODs are coarser.
- Each renderable tree leaf has `lods` entries whose `file` values index into
  `filenames`.
- Babylon treats the highest numeric LOD on each leaf as the permanent base
  layer, so every leaf must include that coarsest level.

`sh_degree: 0` drops higher-order SH (no `shN` planes). Larger
`sh_cluster_count` / `sh_iterations` improve SH fidelity at the cost of encode
time; the shN k-means assignment is the slowest stage on very large scenes.

Browser WASM note: the current `slice_splat(bytes, settings)` API receives the
entire source as a `Uint8Array`, which wasm-bindgen copies into WASM memory.
That API is appropriate for local demos and moderate uploads, but literal
multi-GB files (for example 8GB geospatial scans) require a native/server or
streaming ingestion path that does not copy the whole source into browser WASM
memory at once.

### TypeScript bridge and `SliceArchive`

The bridge (`src/wasm/bridge.ts`) returns a universal, path-keyed `SliceResult`
(`{ files: Map<string, Uint8Array>; lodMetaPath; splatCount; chunkCount }`):

```ts
const result = await splatwalk.sliceSplat(bytes, { sh_degree: 0, lod_levels: 2 });
const archive = new SliceArchive(result);

// 1) Download a store-only .zip (internal layout == hostable directory):
archive.download('myscene-sog');           // -> myscene-sog.zip

// 2) In-app streaming preview (no Service Worker, no network):
const dir = archive.createBlobDirectory();  // path -> blob: URL
//   dir.rootUrl          -> blob: URL of lod-meta.json
//   dir.resolve(path)    -> blob: URL of any bundle file
//   dir.dispose()        -> revoke all URLs when done

// 3) Production streaming: host the unzipped bundle on any static host/CDN and
//    stream lod-meta.json by URL (no app code).
```

`spz_to_ply` / `splat_to_ply` are exposed as `splatwalk.spzToPly(bytes)` /
`splatwalk.splatToPly(bytes)`.

### UI

Both demos expose every slice parameter and default to streamed (LOD) export
for scenes over 1,000,000 splats. Streamed LOD defaults to `lod_levels: 2` and
`sh_degree: 0` so a default export produces multi-LOD coarse→fine streaming
without higher-order SH:

- **Homepage** (plain DOM): a "Streamed SOG Export" panel in the setup section
  (`index.html`, wired in `src/pages/splatwalk.ts`).
- **Vuetify** (`SplatFastNavShowcase`): an "Streamed SOG export" expansion panel;
  override defaults via the `slice` prop and the `autoSliceThreshold` prop.

## Fast Nav And Collider NavMesh Pipelines

SplatWalk exposes two navigation workflows in the UI.

### Fast Floor Nav

`FAST NAV` is the opinionated one-button path for room-scale splats. It prioritizes a reasonable visible floor result over a full physics collider:

```none
input splat -> suggested/region seed -> 2.5D floor field -> accepted floor component -> floor mesh -> Recast -> crowd + NPC
```

The fast path:

- Uses `build_walkable_ground_field` with a clearance-band obstacle preset.
- Snaps the seed Y onto the detected floor plane height before component selection.
- Keeps `walkable` and `filled` cells only, with a relaxed metric-based mask as a fallback when the strict mask is too sparse.
- Blocks `obstacle` (density within the agent clearance band), `height_variance` (neighbor discontinuity), `void`, unfilled `low_confidence`, `eroded`, and `discarded_component`.
- Builds connected components in TypeScript from all preserved cells (`component_mode: "all"`) and prefers the largest viable component nearest the seed.
- Rejects tiny floor results and fails with an actionable message when the selected floor is below a room-floor minimum (`4 m^2`).
- Uses the same Recast result for display, exported nav data, crowd initialization, and spawn selection.

This is intentionally different from a collider-boundary bake. It avoids the failure mode where Recast finds walkable polygons on the underside or boundary faces of a generated voxel collider.

### Navigation from streamed SOG (lod-meta)

Streamed SOG (`lod-meta.json` + chunk SOGs) is a **delivery / streaming** format.
WASM collision and Fast Nav still require **PLY** (or PLY-normalized `.spz` /
`.splat`) bytes — there is no `streamed_sog → navmesh` entry point in WASM.

The Storage Adapter demo (`/storage-adapter`) bridges the gap:

```none
CDN or zip lod-meta
  -> GaussianSplattingStream (visual)
  -> materializeNavSourceFromStreamedSog (coarsest LOD → .splat decode → splat_to_ply)
  -> build_collision_voxel_boundary / runFastNav (existing PLY pipelines)
  -> Viewer crowd + NPC + focusOnPlayer
```

Helper: `src/storage/materializeNavSourceFromStreamedSog.ts`. Default `lodIndex: 'nav'`
starts at mid LOD and refines toward finest until ~50k splats (capped at 250k) so
floor extraction has enough density — coarsest-only is typically too sparse for
Fast Nav.

If in-app decode fails for an asset, convert offline with
[PlayCanvas splat-transform](https://github.com/playcanvas/splat-transform)
(streamed SOG / `.sog` → `.ply`, or voxel / collision-mesh export) and feed that
PLY into the same Fast Nav / collision APIs.

Current results are not yet reliable. On furnished indoor scans (for example `Bedroom.ply`) the field can still fragment the floor and the fast path may relocate to a small off-center island or fail the room-floor minimum. The clearance-band and neighbor-continuity classification above is the in-progress fix for that failure mode; see "Project Status, Philosophy, and Goals".

### Recast parameter units (metres vs voxels)

When you hand the triangulated floor mesh to Recast yourself (the binary-only / non-Babylon path), the single most consequential detail is the **unit of the agent dimensions**. SplatWalk states them in **metres**, but Recast's native `rcConfig.walkableHeight`, `rcConfig.walkableClimb`, and `rcConfig.walkableRadius` are **integer voxel counts**. The `@recast-navigation` `createRcConfig` helper assigns your values straight into those native `int` fields, so a sub-metre metre value is silently **truncated to an integer** before Recast ever runs.

Convert metres to voxels first, using the standard Recast convention (`ch` is the cell height, `cs` the cell size, both in metres):

```ts
const walkableHeight = Math.max(1, Math.ceil(agentHeightMeters / ch));   // round UP
const walkableClimb  = Math.max(0, Math.floor(agentClimbMeters  / ch));  // round DOWN
const walkableRadius = Math.max(0, Math.ceil(agentRadiusMeters  / cs));  // round UP
```

Failure mode if you skip this: at `cs = 0.12, ch = 0.1`, a `0.25 m` climb and a `0.2 m` radius both truncate to `0` voxels. With `walkableClimb = 0` every height step (even one voxel) becomes an impassable wall, so a single terraced level is split into disjoint islands; with `walkableRadius = 0` no erosion is applied. `1.7 m` height truncates to `1` voxel (`0.1 m` of clearance), defeating the height filter. These three values then appear completely inert to tuning — changing the metres does nothing because they all collapse to the same integer.

Headroom is the matching gotcha. The floor field is a **thin, open-sky sheet** (no real ceiling geometry), and Recast's `filterWalkableLowHeightSpans` culls any floor span lacking `walkableHeight` of clearance above it. Pad the Recast bounds so the clearance above the **highest** floor cell is at least `walkableHeight`, e.g. `bmax.y = maxY + agentHeightMeters + 0.5`. Padding only the sheet's own thickness leaves the top deck level under-cleared and silently dropped.

Reference FAST NAV agent defaults (metres) used by the browser path:

```ts
{ cs: 0.2, ch: 0.1, walkableHeight: 1.7, walkableRadius: 0.5, walkableClimb: 0.5, walkableSlopeAngle: 40 }
```

`walkableRadius` is the gaming-standard `0.5 m` agent cylinder. `walkableClimb` is
deliberately `0.5 m` to **match the floor field's same-level band**: the field
merges cells within ~`0.5 m` of each other into one continuous, median-leveled
region, so a smaller climb lets Recast re-sever that region at capture-noise
creases (the navmesh "break" that strands the player and NPC on opposite sides of
a wide, flat passage). Keep the two stages' tolerances aligned.

`cs` should not be a fixed literal. Follow the Recast guideline `cs in
[walkableRadius / 3, walkableRadius / 2]` (so `[0.167, 0.25]` for a `0.5 m`
agent), and within that window pick the finest cell size whose grid
(`width/cs * depth/cs`) still fits a total-cell budget — that keeps a large scene
covered completely instead of being limited by a single hand-picked `cs`. The
browser FAST NAV path does this automatically via `floor.autoNavCellSize(widthM,
depthM, agentRadiusM, maxCells)`; binary integrators should apply the same rule.

### Advanced Collider Nav

The manual collider workflow follows the same broad collider model used by the PlayCanvas/SuperSplat ecosystem:

```none
input splat -> cluster filter -> voxelize -> fill/seal -> carve reachable space -> collision mesh -> Recast
```

The important correction for advanced collision is that navigation should be baked from a dedicated collision representation, not from renderer bounds, visual splat geometry, a global floor plane, or a loose lower-envelope surface. SuperSplat Studio and `splat-transform` generate a coarse voxel collision asset first, then optionally emit a watertight `.collision.glb` mesh from that voxel grid. Recast consumes that collision mesh because it represents physical walkable/blocking surfaces rather than the visual splat renderer.

The preferred workflow is dual-asset:

- Import the Gaussian splat as the visual asset.
- Import a dedicated `.collision.glb` / World Labs Collider Mesh GLB when available.
- Use the imported collider mesh as the authoritative Recast input.
- Use SplatWalk's generated voxel collider only as a fallback when no collider GLB exists.

World Labs Marble follows the same separation: splats or high-quality meshes are for visuals, while Collider Mesh GLB is a coarse physics asset. Do not use the visual splat renderer or SDF debug overlay as collision.

The current WASM contract exposes a 2.5D SDF column field for diagnostics and the fast floor nav path:

1. Parse splats, apply `settings.flip_y` (Y negation to match render space), then apply `settings.rotation`.
2. Build a fixed X/Z grid with Y as up in `splatwalk_oriented` space.
3. Project each Gaussian splat into nearby X/Z cells using a clamped influence radius.
4. Accumulate a compact vertical density profile per cell.
5. Treat density above `sdf_density_threshold` as solid and find threshold-crossing layer heights.
6. Build a scene-wide, density-weighted height histogram of all layers, take the heaviest bin as the global dominant floor plane, and set each column's floor to the layer nearest that plane (record limited multi-layer diagnostics).
7. Classify cells as `obstacle` (density inside the agent clearance band above the floor), `void`, `low_confidence`, `height_variance` (neighbor-median discontinuity), or `walkable`. Ceiling/overhead density beyond the clearance band is ignored.
8. Smooth compatible SDF surface heights and compute X/Z gradients.
9. Fill only small enclosed `low_confidence` components whose boundary is accepted floor.
10. Optionally erode accepted cells using a 2D distance field to blocked cells when `agent_radius_erode > 0`.
11. Select the final connected component.
12. Let the UI triangulate accepted floor cells for the fast Recast path, or inspect the field as a debug overlay.

This column-field path is useful for quick browser-side floor extraction, but it is not equivalent to a full PlayCanvas-style collision pipeline. A full collider path adds:

- A coarse voxel occupancy grid or sparse voxel octree derived from splat density/opacity.
- Optional cluster filtering around a seed position to remove floaters and disconnected geometry.
- Scene-type fill behavior:
  - indoor/external fill to seal room shells before carving;
  - outdoor/floor fill to create solid ground volume under scanned surfaces;
  - object mode with no floor/interior assumptions.
- Capsule-aware carve/flood from a seed position so only reachable space survives.
- A watertight collision mesh generated from the voxel volume, either smoothed or exact voxel faces.
- Recast input generated from that collision mesh in the advanced/manual collider workflow.

`obstacle`, `height_variance`, `void`, unfilled `low_confidence`, `eroded`, and `discarded_component` cells are blocked. They must not be filled downstream.

### PlayCanvas/SuperSplat Reference Behavior

PlayCanvas documents two collision outputs generated from the same voxelization pass:

- `.voxel.json` / `.voxel.bin`: sparse voxel octree collision data used by the SuperSplat Viewer for runtime collision queries.
- `.collision.glb`: a triangulated collision mesh emitted from the voxel grid when collision mesh output is requested.

The documented stages are:

1. `filter-cluster`: keep the connected scene component around `seed-pos`.
2. `voxelize`: convert splat density/opacity into occupancy.
3. `fill`: seal the shell for indoor scenes or fill floor columns for outdoor scenes.
4. `carve`: flood a capsule from `seed-pos` to keep reachable walkable space.
5. `collision mesh`: emit a watertight mesh using a smooth surface or exact exposed voxel faces.

For SplatWalk, that means the advanced collider basis should be generated from voxel occupancy plus fill/carve, then passed to Recast. The one-button `FAST NAV` path deliberately uses the 2.5D floor field instead, because it is a better default for quick room-floor navigation from a raw splat.

## Navigation Markers

The browser viewer uses explicit marker labels and a result-panel legend:

- Green overlay: walkable Recast navmesh.
- Magenta sphere labeled `SEED`: seed/start probe used for fast floor selection or collision carve.
- Blue cube labeled `PLAYER`: controllable crowd agent that receives click-to-move targets.
- Green sphere labeled `NPC`: spawned crowd agent.

Spawn logs include the selected seed, player spawn, NPC spawn, and fast-floor diagnostics so users can tell whether the path landed on the intended room floor.

## Advisory For WASM-Binary-Only Integrators

Some integrators consume only the generated `pkg/wasm_splatwalk/wasm_splatwalk.js` and `pkg/wasm_splatwalk/wasm_splatwalk_bg.wasm` files, without the SplatWalk TypeScript bridge. For those integrations:

- Always call the generated default initializer before calling named exports.
- Check `api_version === 2` on every result before using returned fields.
- Set `flip_y` from your renderer's real splat transform (sign of its world Y scale), not a guess. If your navmesh appears mirrored across `Y=0` or floating above/below the floor, this is almost always a missing/incorrect `flip_y`. Do not patch it with a visual Y offset.
- Pass the user's current orientation via `settings.rotation` and re-run generation whenever it changes, so the floor, basis, and spawn points re-align to the re-oriented splat.
- Do not reconstruct region boxes from renderer bounds. Use `suggest_region(bytes, settings)` and pass the returned `region_min` / `region_max` back into conversion settings.
- Treat `space`, `up_axis`, and `handedness` as part of the binary contract. If your engine uses a different handedness or up axis, convert once at your application boundary.
- Use `get_splat_bounds` for UI framing and `build_walkable_ground_field` for 2.5D SDF column diagnostics. Avoid deriving floor height from renderer meshes, lower-envelope debug surfaces, global planes, or mesh vertices after reconstruction.
- For one-button room navigation, mirror the browser `FAST NAV` path: call `build_walkable_ground_field`, keep only `walkable` and `filled` cells, select the seed-nearest connected component, triangulate that floor component, then pass it to Recast.
- When handing that floor mesh to Recast, convert the agent dimensions from metres to **integer voxel units** (`walkableHeight = ceil(h/ch)`, `walkableClimb = floor(climb/ch)`, `walkableRadius = ceil(r/cs)`) and pad the vertical bounds above the highest floor cell by at least `walkableHeight`. Passing sub-metre metre values directly truncates them to `0` voxels, which removes erosion, turns every height step into a wall, and fragments one walkable level into disjoint islands. See "Recast parameter units (metres vs voxels)" above.
- For advanced collision workflows, treat the production target as PlayCanvas-style voxel collision: voxel occupancy, seed-based cluster/fill/carve, then a watertight collision mesh.
- Use `build_collision_voxel_boundary(bytes, { ...settings, emit_glb: true })` for generated collision/physics overlays and `.collision.glb` export when no imported collider GLB exists. Use `convert_splat_to_navmesh_basis(bytes, settings)` only for legacy callers that still name this artifact as a navmesh basis.
- Treat `GroundFieldCell.state` as part of the fast-nav contract. Preserve `obstacle`, `height_variance`, `void`, unfilled `low_confidence`, `eroded`, and `discarded_component` as blocked/rejected states.
- Treat `cells_rejected_low_confidence`, `cells_rejected_height_variance`, `cells_rejected_obstacle`, `cells_void`, `cells_eroded`, and `cells_discarded_component` as first-class navigation diagnostics. These fields explain why furniture, walls, voids, noisy regions, optional clearance erosion, or disconnected islands were excluded before Recast.
- Do not fill obstacle, height-variance, void, eroded, unfilled low-confidence, or discarded-component cells downstream. SplatWalk only closes small enclosed low-confidence floor components in the 2.5D field; downstream integrations should preserve that decision.
- Treat returned floor/collider meshes as already being in authoritative basis space. Do not apply broad visual Y offsets to Recast debug geometry to make it appear aligned; fix the field/collider/settings instead.
- Pin the JS glue and `.wasm` binary together. The generated `wasm_splatwalk.js` export signatures must match the `.wasm` binary produced in the same build.
- If your integration stores cached results, include `api_version`, `space`, `basis`, `floor_plane`, and the settings used to produce them in the cache key.

## Settings Notes

The v2 API accepts the existing reconstruction settings plus PlayCanvas-style collision settings.

Coordinate settings:

- `flip_y`: negate parsed splat Y (position and normal) to match a renderer that imports the splat Y-flipped. See the Coordinate Contract. Default `false`.
- `rotation`: `[x, y, z]` Euler radians applied after `flip_y`. Pass the user's current splat orientation so generation stays aligned across rotations.

Collision/reconstruction settings:

- `collision_voxel_size`: voxel edge length in meters. Smaller values increase fidelity and cost. The UI defaults near SuperSplat's 5-8 cm range.
- `collision_opacity_threshold`: minimum accumulated density/opacity needed to mark a voxel solid.
- `collision_scene_type`: `"indoor"`, `"outdoor"`, or `"object"`. Indoor uses external fill/sealing, outdoor uses floor fill under scanned surfaces, and object mode skips fill assumptions.
- `collision_seed`: `[x, y, z]` seed in `splatwalk_oriented` space for cluster filtering and capsule carve.
- `collision_fill_size`: fill/seal distance in meters.
- `collision_carve_height`: capsule height in meters for reachable-space carving.
- `collision_carve_radius`: capsule radius in meters for reachable-space carving.
- `collision_mesh_mode`: `"faces"` emits exact exposed voxel faces. `"smooth"` is reserved for a later marching-cubes/copanar-merge path and is rejected by the current binary.
- `emit_glb`: accepted by `build_collision_voxel_boundary`; when true, the result includes GLB bytes suitable for saving as `.collision.glb`.

The diagnostics include `collision_grid_width`, `collision_grid_height`, `collision_grid_depth`, `collision_occupied_voxels`, `collision_cluster_kept_voxels`, `collision_cluster_discarded_voxels`, `collision_filled_voxels`, `collision_carved_voxels`, `collision_surface_faces`, `collision_seed_used`, `collision_seed_state`, `collision_scene_type`, `collision_mesh_mode`, `collision_external_fill_leaked`, and `collision_failure_reason`.

UI integrations may bypass generated collision by importing a collider GLB and sending its mesh buffers directly to Recast. This is the most accurate route for PlayCanvas/SuperSplat `.collision.glb` and World Labs Collider Mesh GLB assets.

`FAST NAV` uses a separate floor-field preset in the TypeScript UI. It tightens SDF cell size, vertical binning, obstacle height, variance, confidence, and seed-nearest component selection before Recast. These settings are intentionally conservative so furniture, plants, walls, noisy vertical splats, exterior voids, and disconnected islands are not promoted into the default walkable surface.

Legacy/debug 2.5D SDF settings remain available for overlay diagnostics:

- `sdf_cell_size`: explicit 2.5D grid cell size in meters. If omitted, SplatWalk derives one from `voxel_target`.
- `sdf_vertical_cell_size`: vertical density-profile bin size in meters.
- `sdf_density_threshold`: density threshold used to extract solid surface layers from each column.
- `sdf_max_layers`: maximum accepted surface layers before a column is considered multi-layer/variant.
- `sdf_smoothing_radius`: neighbor radius used to smooth compatible accepted surface heights.
- `sdf_influence_radius_scale`: scale applied to splat radius when writing density into nearby X/Z cells.
- `floor_projection_epsilon` / `height_projection_epsilon`: floor projection tolerance around the RANSAC floor plane. `floor_projection_epsilon` is the preferred name.
- `obstacle_height_epsilon`: height above the floor plane that counts as obstacle evidence; also seeds the neighbor floor-continuity step threshold.
- `obstacle_clearance_min`: bottom of the agent clearance band, measured above the per-column floor layer. Density below this is treated as part of the floor slab (rugs, thresholds). Defaults to `floor_projection_epsilon`.
- `obstacle_clearance_max`: top of the agent clearance band. Density above this (ceilings, overhead beams, tall canopy) is ignored and does not block walking. Defaults to `collision_carve_height` (agent height).
- `max_local_height_variance`: legacy intra-column variance bound. No longer used for fast-floor rejection (replaced by neighbor-median continuity); retained for backward compatibility.
- `min_floor_confidence`: minimum accumulated floor evidence for a walkable cell.
- `hole_fill_radius`: small-hole close/fill radius in field cells. Only small enclosed `low_confidence` components may be filled.
- `agent_radius_erode`: optional upstream distance-field erosion radius in meters before connected-component selection. The UI default is `0` because Recast also applies `walkableRadius` (its metre value converted to `ceil(walkableRadius / cs)` voxels at navmesh time); setting both can double-erode and fragment valid floor. See "Recast parameter units (metres vs voxels)" for the conversion.
- `component_mode`: `"largest"` or `"nearest_region_center"` selected component mode.

Conservative defaults are intentionally used so real obstacles, exterior voids, and large missing regions are not filled as walkable floor. For Recast use, prefer leaving `agent_radius_erode` at `0` unless you intentionally want pre-Recast clearance baked into the collider.

## Service Worker and Caching

The browser app serves a service worker (`public/sw.js`) whose cache id is bound to the wasm build, so a rebuilt `wasm_splatwalk_bg.wasm` is always picked up without any manual cache clearing:

- **Build-id injection**: `npm run build` (which runs `build:wasm` then `vite build`) invokes the `inject-sw-build-id` Vite plugin. It hashes `pkg/wasm_splatwalk/wasm_splatwalk_bg.wasm` (`sha256`, first 12 hex chars) and replaces the `__SW_BUILD_ID__` placeholder in `dist/sw.js`, producing `CACHE_NAME = splatwalk-<wasmHash>`. Any change to the wasm binary changes the cache id.
- **Clear on id change**: On `activate`, the service worker deletes every cache whose name differs from the current `CACHE_NAME`, evicting all prior builds.
- **Automatic client update**: On load the client calls `registration.update()`, posts `{ type: 'SKIP_WAITING' }` to a newly installed worker, and reloads exactly once on `controllerchange`. Integrators do not need to hard-refresh or clear site data.
- **Never-stale code paths**: Requests under `/pkg/`, `/src/`, `/assets/`, `/@`, worker scripts, `*.wasm`, `*.ply`, `*.spz`, `*.mjs`, and any query-stringed URL bypass the cache entirely (direct network). Only the static shell (navigations, precached images) is cached network-first.
- **Development**: The service worker is not registered on `localhost`/`127.0.0.1`. On startup in dev, any previously registered worker and all caches are unregistered/cleared, so a developer machine that previously cached an old wasm self-heals on the next load.
- **Binary-only integrators**: If you deploy the generated JS glue and `.wasm` behind your own service worker or CDN, key/version your cache by the wasm content hash (or pin glue+binary together as noted above) so a new binary is never served from a stale cache.
