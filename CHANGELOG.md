# Changelog

All notable changes to SplatWalk are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The integer `api_version` on every WASM result remains the hard data contract
(currently `2`). The new `semver` and `capabilities` fields are additive: a
consumer can read them to tolerate additive change instead of hard-failing on a
version bump.

## Capability flags

Every v2 result advertises a `capabilities` string array. Current flags:

| flag | meaning |
| --- | --- |
| `collision_voxel_boundary` | exposes `build_collision_voxel_boundary` |
| `collision_voxel_volume` | `emit_volume` returns packed `solid` + `nav_region` for voxel walk |
| `progress_protocol_v1` | emits the documented `@progress <stage> [<fraction>]` line protocol |
| `glb_export` | exposes `mesh_to_glb` for engine-free GLB serialization |
| `room_floor_mesh` | exposes `build_room_floor_mesh` (WASM-side FAST NAV floor) |
| `sog_export` | exposes `convert_to_sog` |
| `streamed_sog` | exposes `slice_splat` (streamed LOD SOG) |
| `fast_nav_preset` | exposes `fast_nav_preset()` and bakes the preset into `build_room_floor_mesh` |
| `output_space` | honours `settings.output_space` (opt-in handedness / up-axis / winding) |
| `recast_config` | exposes `recast_agent_defaults()` and `recast_config()` |
| `progress_callback` | exposes `set_progress_callback()` (opt-in structured progress) |
| `splat_ingest` | exposes `splat_to_ply` (antimatter15 `.splat` -> PLY normalization) alongside `spz_to_ply` |

## [0.6.4] - 2026-07-23

### Added

- **Nav artifacts upload** (zip or multi-select contract files) across Storage Adapter,
  3D Workbench, Vuetify Fast Nav, and R3F — `parseNavArtifactFiles` /
  `applyNavArtifactsToViewer` / `applyNavArtifactsToR3F`.
- **Download nav artifacts** on Workbench / Vuetify / R3F (minimal pack:
  `nav_session.json` + `recast.navmesh.bin`; full volume packs unchanged on Storage).
- **3D Workbench**: Upload Nav Artifacts button beside Choose local file; Region/prune
  camera-select AABB offsets + Apply from camera.
- Vuetify / R3F Region and prune: same camera-select offset controls + Apply.

### Notes

- WASM **`api_version` stays `2`**. Package **0.6.4**.

## [0.6.3] - 2026-07-23

### Added

- **Storage Adapter Region/prune UI**: editable camera-select AABB offsets (L/R,
  forward, behind, below, above) and **Apply select region from camera** to rebuild
  the yellow box from the live fly view + offsets (`applySelectRegionFromCamera`).
- **Oval fly pose** updated to the stairs framing used with that camera-select path.

### Notes

- WASM **`api_version` stays `2`**. Host UI only; package **0.6.3**.

## [0.6.2] - 2026-07-23

### Added

- **`FastNavOptions.cameraSelect`** (host API): pass a FreeCamera-style `view`
  (position + euler°) plus optional AABB offsets; Fast Nav derives the select-region
  AABB via `regionBoundsFromCameraSelect`, pins the yellow box / `region_min`·`region_max`,
  and restores that view after nav (skips top-down `focusOnPlayer` when
  `keepCameraSelectView` is not false). Helpers: `CameraSelectView`,
  `CameraSelectRegionInput`, `poseFromCameraSelectView`, `regionBoundsFromCameraSelect`.
- **Oval Storage Adapter**: stores pending `cameraSelect` (same stairs fly view +
  default offsets); settle arms the region; Fast Nav / voxel nav restore the fly view.
  Church / Skatepark leave `cameraSelect` unset.
- **R3F**: `useSplatFastNavR3F({ cameraSelect })` pins
  `SplatNavController.enableRegionSelection` and restores the view when set.

### Notes

- WASM **`api_version` stays `2`** (AABB wire unchanged; no OBB).

## [0.6.1] - 2026-07-23

### Added

- **Camera-based select region** (host toolset): `regionBoundsFromCameraPose` in
  `src/navigation/cameraSelectRegion.ts` builds a world AABB from camera position +
  yaw (defaults: 10 m left/right, 15 m forward, 5 m behind, 5 m below / 15 m above). Wire format
  remains WASM `region_min` / `region_max` AABB; `api_version` stays **2**.
- **Oval Storage Adapter**: after the preset fly pose applies, auto-arms that camera
  AABB as the yellow selection region. Church / Skatepark unchanged.

## [0.6.0] - 2026-07-23

### Added

- **WebGPU / WebGL renderer toggle** (Babylon host): Storage Adapter, Vuetify Fast Nav,
  and homepage 3D Workbench, plus `?renderer=webgpu|webgl`. Preference **WebGPU** uses
  `WebGPUEngine` when supported and **falls back to WebGL** if unsupported or init fails.
  Preference **WebGL** always uses `Engine`. Shared helper `src/scene/createBabylonEngine.ts`;
  `Viewer.create` for new canvases. WASM `api_version` remains **2** (renderer is host-side
  only). WebGPU requests `setMaximumLimits` so `maxColorAttachmentBytesPerSample` is high
  enough for Babylon’s GS `gsWorkBuffer` MRT (40 bytes/sample); adapters below that fall
  back to WebGL. R3F demo shows the same control with WebGPU disabled (Three splat path is
  WebGL-only).
- **Download FastNav / Storage integration kits**: each demo ships a zip under
  `/integration-kits/` (`npm run build:kits`) with `INTEGRATE.md` + peer deps fragment —
  Vuetify, R3F, Storage Adapter, Babylon workbench host. Playground button retitled
  **Download FastNav playground** (`playground.json`).

## [0.5.20] - 2026-07-23

### Fixed

- **Oval interior orientation:** Selecting **Oval interior (stairs)** in Storage Adapter arms
  Stream + Nav PLY orientation **0°/0°/0°**, applied after the next CDN/zip load (overrides
  capture of the stream’s default Z-up→Y-up euler). Church / Skatepark still use captured defaults.

## [0.5.19] - 2026-07-23

### Fixed

- **Click-to-move (Recast crowd):** Restored HEAD **0.4.2** path — pick the green `navmesh_debug`
  mesh, subtract `navMeshVisualOffset`, then `requestMoveTarget` (with `worldNavPointToOriented`
  when stream visual is decoupled; identity for Vuetify Bedroom / PurplePad). Removed the
  surface-pick + snap path that sent agents to the wrong axis-mirrored location.

## [0.5.18] - 2026-07-23

### Fixed

- **Bedroom / PurplePad indoor Fast Nav (0.5.16–0.5.17 regression):** Restored HEAD **0.4.2**
  region behavior for default Fast Nav — yellow Selection box only; `suggestRegion` for seed;
  no auto 100 m outdoor pin. Church outdoor seed-centered pin is opt-in via
  `FastNavOptions.seedCenteredOutdoor` (enabled from Storage Adapter streamed Fast Nav only).

## [0.5.17] - 2026-07-22

### Fixed

- **Church moth-eaten navmesh (0.5.16 regression):** Seed-centered 100 m pin kept fine outdoor
  cells over sparse ground. Under that pin Fast Nav now forces `sdf_cell_size=0.4` and
  `hole_fill_radius=8`, widens the Y band, closes seams up to 2 m, and re-pins region Y from
  the dense floor band (XZ extent unchanged). No full-AABB auto-coarsen (avoids floating facades).

## [0.5.16] - 2026-07-22

### Fixed

- **Church outdoor courtyard coverage:** When no yellow Selection box is set, Fast Nav pins a
  seed-centered **100 m × 100 m** working volume (`±50 m` XZ, `floor_y` Y band) instead of the
  full `suggestRegion` AABB or an unbounded field. Streamed Fast Nav merges same-level Recast
  islands within `maxSeedDistance` (~80 m) for validation metadata (display/walk still use the
  Recast floor sheet).

## [0.5.15] - 2026-07-22

### Fixed

- **Church floating navmesh (regression):** Restored original ground-field `sdf_cell_size` clamp
  `[0.03, 2.0]` and removed the 250k-cell auto-coarsen. Coarsening on the full outdoor AABB made
  meter-scale cells that treated building facades as floor (mid-air green strip). `checked_mul`
  still fails cleanly on true grid overflow instead of panicking.

## [0.5.14] - 2026-07-22

### Fixed

- **Church navmesh wrong place (regression):** Reverted Fast Nav auto-pin of `suggestRegion` into
  `region_min`/`region_max`. That locked the field onto the trees/stairs patch instead of the
  courtyard/entrance. Original behavior restored: yellow box pins only; `suggestRegion` is seed-only;
  dense-floor recovery adapts the working volume.

## [0.5.13] - 2026-07-22

### Fixed

- **Ground-field cell budget ceil overrun:** WASM coarsen used `sqrt(area/MAX)` then hard-failed when
  `ceil(w/cs)*ceil(d/cs)` landed just over 250k (church ~122×187 m). Now loops bumping `cell_size`
  until the integer grid fits — no false `cell count overflow` abort.

## [0.5.12] - 2026-07-22

### Fixed

- **Church Fast Nav capacity overflow (regression):** `runFastNav` restores `region=auto` — when no
  yellow-box pin is present, `suggestRegion` sets `region_min`/`region_max` before the ground
  field so multi‑km parish/sky AABBs no longer allocate a Wasm grid that panics with
  `capacity overflow`. WASM `build_field` also caps ~250k cells (coarsens `sdf_cell_size` or
  returns a clear error) as a last-resort guard.

## [0.5.11] - 2026-07-22

### Fixed

- **Church Fast Nav after Oval:** CDN example buttons call `setNavGenerationMode` — Church/Skatepark
  restore `floor_field` and clear selection-region / region-clipped PLY cache; Oval sets
  `voxel_collision`. Stops Oval mode from leaking into Church Run Nav.

## [0.5.10] - 2026-07-22

### Fixed

- **region_too_large (clamp):** Auto/suggested selection regions are clamped to ≲20 m XZ (fallback
  12 m) so Oval-scale `suggestRegion` footprints cannot doom the carve. Oversized live boxes are
  clamped too. Budget-required rematerialize refuses empty-region→global fallback (no omit-pin).
  Preflight throws before WASM if the effective AABB still exceeds the dense voxel cap.

## [0.5.9] - 2026-07-22

### Fixed

- **region_too_large:** Regionless full-AABB carves that cannot fit the dense voxel budget even at
  0.5 m now auto-enable Selection region (`suggestRegion` + stair Y expand), rematerialize a
  region-clipped PLY, and pin WASM. Error copy for pinned-but-still-too-large tells the user to
  shrink the yellow box (not “lower opacity”).

## [0.5.8] - 2026-07-22

### Fixed

- **mesh_to_glb empty crash:** Root cause was WASM `emit_glb` hard-failing the whole collision
  build on an empty surface mesh (regionless full AABB). `emit_glb` now skips empty meshes
  (`glb=None` + warning). Voxel Run Nav uses `emitGlb: false` and synthesizes `collision.glb` /
  `walkable_floors.glb` in TS from boundary mesh or solid exterior / solid tops after volume.

## [0.5.7] - 2026-07-22

### Fixed

- **Regionless nav artifacts:** When nav floor cells are empty (common on full-AABB volumes),
  emit walkable_floors from solid tops with air above. When WASM collision mesh/GLB is empty,
  emit collision.glb from solid exterior faces. Full artifact pack required — no partial zip.

## [0.5.6] - 2026-07-22

### Added

- **Empty-region fallback:** If the live yellow box keeps fewer than the region min splat count
  (or yields “No splats decoded”), rematerialize the full scene, omit the WASM region pin for
  that run, and seed via `suggestRegion` — gizmo stays visible so the box can be moved and re-run.

## [0.5.5] - 2026-07-22

### Fixed

- **Region ON→OFF spawn:** Selection region OFF no longer materializes from the cached yellow
  box while omitting the WASM pin. Hide clears the region-clipped nav PLY cache (`voxel_global`
  on next run). Cylinder spawn falls back to volume-center / deck when seed-near search fails;
  regionless errors tell the user to re-enable Selection region.

## [0.5.4] - 2026-07-22

### Added

- **Region stair headroom:** Enabling Selection region in voxel-collision mode expands Y
  (−1 m footroom / +carve+4 m headroom) so stairs and upper landings fit the yellow box.
- **Nav artifact zip:** After voxel nav, **Download nav artifacts** packs `collision.glb`,
  `volume.meta.json`, `volume.solid.bin`, `volume.nav_region.bin`, `walkable_floors.glb`,
  `nav_session.json`, and optional `recast.navmesh.bin` (see `navArtifactContract.ts`).
- **Upload artifacts stub:** Disabled control documents the ingest filenames for a follow-on demo.

### Changed

- **Region OFF warning:** Voxel nav without a pinned region logs a coarsen/stairs warning;
  carve-reach tip surfaces in status when `navMaxY` is well below the selection box top.

## [0.5.3] - 2026-07-22

### Fixed

- **SS-parity spawn:** Chebyshev `findCylinderSpawn` (`isFreeAt` + solid footprint down-rays) with
  dominant deck-Y band so SEED/PLAYER land on the main floor plate ([Oval Interior](https://superspl.at/scene/b7c8d8c5) reference).
- **SS-parity stairs:** Solid `queryRay` ground probes (`groundProbeRange` 1 m) + capsule; click
  navigate is XZ-only (no `isFloorCell` gate). Green overlay is debug-only.
- **Carve reachability log:** Reports `nav_region` / floor-cell / region max Y after volume build.

## [0.5.2] - 2026-07-22

### Fixed

- **Floor-cell walk surfaces:** Feet and ground probes use carved `isFloorCell` tops only (ignores
  floating solid debris). Green overlay and feet share a one-voxel surface bias toward the painted
  floor; capsule clearance still uses unbiased tops.
- **Largest-floor spawn:** Player + SEED marker land on the largest same-level floor component in
  the seed height band (not nearest free cell to box-center mid-capsule).
- **Stair climb:** Step-up via floor-cell `groundYUnder`; capsule reject skipped while climbing;
  blocked cancel softened and ignored while Y is rising.

## [0.5.1] - 2026-07-22

### Changed

- **Voxel walk locomotion:** Replaced BFS floor-cell pathfinding with solid DDA `queryRay`, XZ
  `navigateTo`, five-ray ground probes, and capsule slide (stairs via successive solid tops).
- **Locomotion id:** `pc_voxel_walk` → `voxel_walk`; nav UI/logs no longer advertise third-party
  product names for walk mode.
- WASM collision summary log: `Collision carve:` (was product-branded).

### Fixed

- Player cube sits on probed solid tops (no cosmetic hover / green overlay lift on voxel walk).
- Cylinder-style spawn near the collision seed (footprint down-rays → floor Y).

## [0.5.0] - 2026-07-22

### Added

- **`collision_voxel_volume` capability:** `build_collision_voxel_boundary` accepts `emit_volume: true`
  and returns packed dense `solid` + `nav_region` bitmasks (LSB-first) with `origin` / `dims` /
  `voxel_size` for runtime walk.
- **Voxel walk runtime:** Capsule walk on exported carve volume (default locomotion for voxel
  collision). Recast crowd remains an either/or alternate that bakes from voxel spans.
- **Recast-from-voxels:** When Recast crowd is selected, heightfield spans are built from carved
  `nav_region` columns instead of re-rasterizing fragmented tread triangles.

### Fixed

- Stair connectivity no longer depends on triangle mesh → Recast double-voxelization.
- Spawn fail-fast when seed/volume AABB misses the splat world bounds.

## [0.4.15] - 2026-07-22

### Fixed

- **Transform alignment (critical):** WASM `splatwalk_oriented` vertices already coincide with
  Babylon world when nav-PLY rotation matches the stream (`streamWorld * raw = env * R * flip(raw)`).
  Removed the erroneous `env · inv(streamWorld)` overlay transform that was lifting green navmesh
  and the player above the splat floor.
- **Collider overlay default:** Cyan voxel collider is **shown by default** after nav (toggle still
  available). Removed the incorrect “hidden while orbiting” copy.

### Added

- **Locomotion mode (voxel collision):** Choose **Recast crowd** (default) or **PC voxel walk**
  (PlayCanvas / SuperSplat-style surface raycast without Recast crowd) — either/or, not a replacement.

## [0.4.14] - 2026-07-22

### Fixed

- **Stairs (PC-style walk surfaces):** WASM `collision_mesh_mode` defaults to `walkable_floors` —
  upward-facing floor + stair tread tops only (solid voxels bordering carved nav volume above).
  Skips wall/ceiling obstacle shells that fragmented Recast into thin green shards.
- **Post-nav freeze:** Nav session fully freezes streamed SOG LOD decode/downloads for the whole
  session (like PC/SS walk mode). Removed per-frame camera observer and collider hide/show toggling.
- **Spawn guard:** Player spawn is validated against splat world bounds; falls back to nearest
  Recast point when oriented spawn drifts outside the scene.
- **Coordinate transform:** Simplified world ↔ oriented mapping to `env · inv(streamWorld)` only
  (no double-applied rotation/flip).

## [0.4.13] - 2026-07-22

### Fixed

- **Spawn/nav aligned with splat (critical):** WASM outputs live in `splatwalk_oriented`
  space but streamed SOG renders with mesh rotation in Babylon world space. Nav overlays,
  seed marker, player agent, and click targets now transform oriented ↔ world via the
  stream matrix. Selection region is always mapped world → oriented for WASM (fixes
  player at bottom of yellow box while splat sits at top).
- **Spawn at collision seed:** Player spawns at the collision seed snapped to navmesh
  (PlayCanvas `findCylinderSpawn` parity), not at a random “most interior” triangle that
  could land outside the scene.
- **Stairs:** Removed voxel-path island filter that discarded stair Recast regions;
  raised `walkableClimb` to 0.75 m on first Recast attempt.

## [0.4.12] - 2026-07-22

### Fixed

- **Voxel nav quality:** Voxel collider Recast now uses the floor-sheet bake (skips ledge
  filter that was shredding stairs into green shards). Tighter first-pass agent radius,
  island filter near seed, indoor WASM defaults (fill 1.6, scene indoor), larger crop
  margin on small regions, and expanded indoor recovery ladder (`bridge gaps`, smaller capsule).
- **Large selection regions:** WASM region is padded to match materialize, filter-cluster
  disables above 25 m footprint, and UI warns when the yellow box is too large.
- **PC/SS click-to-move:** Clicks on splats, cyan collider shell, walls, and ceilings
  raycast to a surface hit then snap to the nearest navmesh point (XZ projection like
  SuperSplat walk mode) — no longer requires hitting fragile green debug triangles.
- **Post-nav freeze:** Stream LOD decodes pause (`maxDecodesPerFrame = 0`) while the
  camera orbits; crowd updates skip entirely during motion; lower resident budget floor.

## [0.4.11] - 2026-07-22

### Fixed

- **Post-nav orbit stutter (streamed SOG):** After nav completes, camera motion no longer
  competes as hard with `GaussianSplattingStream` LOD decode/eviction. A nav-session
  runtime lowers resident budget, widens LOD distance, and hides the cyan collider overlay
  while orbiting; crowd updates throttle under frame pressure.

## [0.4.10] - 2026-07-21

### fix

- **Stair nav (Recast)**: Mesh obstacle solids facing PC-carved `nav_region` (upward floor normals for Recast) instead of the inverted nav-volume shell (downward normals, no walkable spans). Disables floor-sheet Recast shortcut for voxel colliders — pinned regions with small footprint were flattened to a single floor.
- **PlayCanvas `--filter-cluster` parity**: Coarse 1 m splat connected-component filter before fine voxelize removes disconnected floater clusters that block stair carve BFS.
- **Performance / UX**: Carve dilation emits progress; indoor collision recovery capped at two WASM retries; default collision voxel 0.05 m and scene type indoor.

## [0.4.9] - 2026-07-21

### fix

- **WASM voxel collider mesh**: Crop navigable region to occupied bounds (+ 4-voxel margin) before boundary extraction. Meshes the full padded grid with exterior faces exposed at grid edges, producing a giant translucent box filled with voxel faces.
- **Storage Adapter UI**: Voxel collider overlay toggle (cyan boundary), matching the navmesh overlay switch.

## [0.4.8] - 2026-07-21

### fix

- **WASM voxel collision carve (PlayCanvas parity)**: Replace per-step `capsule_fits` BFS with PlayCanvas `carve.ts` pipeline — dilate solid obstacles, flood empty through dilated grid, dilate reachable empty, mesh navigable-volume boundary (`voxelFaces` style). Default voxel size 0.05 m; default carve radius 0.2 m. Removes post-voxel solid cluster trim (PC uses optional pre-voxel splat `--filter-cluster` instead).

## [0.4.7] - 2026-07-21

### fix

- **WASM voxel collision (indoor/object)**: Re-enable seed-connected solid cluster filtering after voxelize. Without KNN splat prune, airborne floater voxels blocked capsule carve to stairs; cluster trim removes disconnected solid specks in O(voxels) instead of O(splats).

## [0.4.6] - 2026-07-21

### fix

- **Storage Adapter voxel nav**: Floor-field Recast overrides (`walkableRadius` 0.35 m, etc.) no longer overwrite the voxel-collider Recast ladder — stairs were over-eroded. Region clip trims chunk overlap splats before PLY materialize; KNN prune auto-skips above 350k splats with a logged warning.
- **Camera mode**: Fly ↔ Orbit switches preserve the current view instead of reframing to world bounds.
- **Voxel collision clarity**: Logs and collider overlay text explain that click-to-move uses a green Recast mesh baked from the cyan voxel collider (not the floor-field path).

## [0.4.5] - 2026-07-21

### fix

- **Voxel collision nav diagnostics**: Storage Adapter / `runNavFromVoxelCollider` now wires WASM worker progress and key parse/grid logs into the UI log panel (`parse`, `prune`, `collision_voxelize`, `collision_fill`, `collision_carve`, `collision_mesh`). Preflight `[INFO]` lines summarize PLY size, prune, region, and collision params before `build_collision_voxel_boundary` runs.

`api_version` remains **2**.

## [0.4.4] - 2026-07-21

### fix

- **WASM collision (`build_collision_voxel_boundary`)**: When `region_min` / `region_max` are pinned, indoor exterior fill no longer treats open grid faces as "real" exterior — fill is applied inside the selection volume instead of aborting with a false seed leak. Dense-grid coarsening no longer breaks early at `voxel_size >= 0.5` with an oversized grid; returns `region_too_large` when the capped region still exceeds 1.5M voxels at max coarseness.
- **Voxel collision nav (TS)**: Exterior fill leak matches PlayCanvas / splat-transform — warn and continue to carve instead of throwing. Recovery ladder retries with object mode (no fill) when fill leak or seed blockage yields an empty collider.

`api_version` remains **2** (no result-shape change).

## [0.4.3] - 2026-07-21

### fix

- **WASM collision (`build_collision_voxel_boundary`)**: PlayCanvas / splat-transform parity fixes for large pinned regions — voxel grid is sized from `region_min` / `region_max` (plus exterior-fill pad) instead of the full materialized splat AABB, which previously forced coarse `collision_voxel_size` under the dense-grid cap and collapsed indoor stairs. Indoor / object scenes no longer run post-voxel filter-cluster (PC `writeVoxel` only filters splats at coarse resolution via CLI `--filter-cluster`, not after fine voxelize). Carve nearest-empty search radius matches PC capsule dilation. Collision grid diagnostics are populated on failure paths.
- **Storage Adapter**: materialized-stream `getWasmRegionBounds()` passes gizmo coords directly (workbench parity). Voxel collision seed uses selection-box floor + half agent height when a region is pinned.

`api_version` remains **2** (no result-shape change).

## [0.4.2] - 2026-07-10

### fix

- navmesh build for streams fix

## [0.4.1] - 2026-07-10

### fix

- build artifacts

## [0.4.0] - 2026-07-10

### UI and streaming updates

- uniformity ensured

## [0.3.7] - 2026-07-07

### Version Bump

- Bumped to BABYLON 9.15.

### Aligned

- The streaming specification was aligned with the schema as per BABYLON 9.15.

## [0.3.6] - 2026-06-23

### Fixed

- **Playground broke in production with `BABYLON is not defined`.** The deployed
  nginx Content-Security-Policy (`nginx.conf.template`) restricted `script-src` to
  `'self'`, so the standalone `/playground/` page could not load Babylon.js, the
  Babylon loaders, the in-browser TypeScript transpiler, the `@splatwalk/core`
  WASM module, or `recast.js` from their CDNs, and its transpiled blob-module
  import was blocked too. `script-src` now also allows `blob:`,
  `https://cdn.babylonjs.com`, and `https://cdn.jsdelivr.net`. Verified by serving
  the real nginx config locally and loading the page in a real browser: the splat
  scene, navmesh, and agent come up with zero CSP violations.

## [0.3.5] - 2026-06-22

### Added

- **R3F demo agent labels.** The React Three Fiber demo now renders billboard
  `PLAYER` (blue) and `NPC` (green) labels above its crowd agents, matching the
  Babylon demos. They use the same depth-correct technique as below.

### Fixed

- **Agent markers no longer pop in/out or float over splat geometry.** The agent
  marker labels in the Babylon demos (`PLAYER` / `NPC` / `SEED`, via
  `Viewer.attachMarkerLabel`) and the Playground demo's agent ring were
  alpha-blended, so they joined the transparent render pass and were sorted
  against the Gaussian splat (which never writes depth). That made them flicker
  in and out with the camera angle/distance and draw on top of splat walls and
  furniture. They are now rendered as **alpha-tested opaque** (the Playground
  ring is simply opaque, like the player capsule), so they write depth and the
  splat depth-tests against them: stable at every angle/distance and correctly
  occluded when the agent is behind splat geometry. Label textures also disable
  mipmaps so the thin text does not minify below the alpha-test cutoff and vanish
  at distance.

## [0.3.4] - 2026-06-22

### Added

- **`.splat` (antimatter15) input support.** A new WASM `splat_to_ply` entry point
  (capability `splat_ingest`) decodes the fixed 32-byte `.splat` record into a
  full-fidelity 3DGS PLY (positions, log-space scale, SH0 DC color, opacity logit,
  renormalized rotation; SH degree 0). `.splat` joins `.ply` and `.spz` everywhere
  in the app and pipeline.
- **Right-handed Babylon regression scene (Mutualism Track B / issues #3, #6).**
  The Babylon `Viewer` accepts a `rightHanded` option (`scene.useRightHandedSystem
  = true`), wired through `useBabylonViewer` and gated behind a hidden `?rh=1` URL
  flag on the Vuetify showcase (no user-facing toggle — left-handed stays the
  default). It validates that SplatWalk's `splatwalk_oriented` output (right-handed,
  +Y up) lands in a right-handed Babylon scene with no boundary mirror; measured
  coincidence is documented in `docs/coordinate-alignment.md`. This is the geometry
  counterpart to Babylon's right-handed Gaussian-splat sort (PR #18606).
- **"Stairs" example scene.** A `.spz` example splat added to all three demos
  (homepage workbench, Vuetify showcase, R3F demo), exercising the `.spz` ingest
  path end-to-end from the example menus.
- **Babylon.js Playground interactive demo (Mutualism Track A / issue #2).** A
  zero-install, copy-paste Playground snippet (`public/playground/babylon-fast-nav.ts`,
  TypeScript ES-module `export class Playground` with a static async
  `CreateScene`, matching the Playground V2 runner's entry-export resolution) that
  is a full workbench-style
  experience with its own in-scene UI (in the spirit of babylon-game-starter):
  it loads `@splatwalk/core` + recast.js from CDNs, renders a real Gaussian splat,
  runs `build_room_floor_mesh` (FAST NAV floor, honoring the `flip_y` contract),
  builds a **Babylon Recast navmesh** from the floor, spawns a crowd agent, and
  supports **click-to-move**. Includes a scene picker (`.ply` + gunzipped `.spz`),
  splat/floor/navmesh toggles, a live HUD, and a top-down "focus on player"
  camera. A **Full screen** toggle borrows the babylon-game-starter idiom: inside
  the Playground it "hijacks" the split — the snippet tags `#pg-split` to drop its
  fixed-pixel CSS grid (`display:block`), hides the editor + splitter, and lets
  `#canvasZone` fill 100% before calling `engine.resize()` (pure CSS, no browser
  Fullscreen API, so the overlay UI survives and tracks the full render area).
  Outside the Playground it falls back to the Fullscreen API; a `?fullscreen=true`
  URL param enters full screen on load. A **home icon link** overlays the demo
  (matching the Home affordance on the Vuetify/React pages). A runnable demo lives
  at `/playground/` (`public/playground/index.html`, linked from the homepage nav)
  and reproduces the Playground TS pipeline; it adds a **Download `playground.json`**
  button — a byte-compatible Babylon Playground **V2 snippet** (`{ payload, name,
  description, tags }` → V2 manifest, with the `unicode` base64 path for non-Latin1
  source) so users can load it into the real Playground and edit it — and an
  **Open Playground ↗** button that opens the published snippet
  ([`#VUGYNW`](https://playground.babylonjs.com/#VUGYNW)). Documented in
  `README.md` and `docs/INTEGRATION.md`.

### Changed

- **Single splat ingest seam: everything is normalized to PLY first.** `.spz` and
  `.splat` are now converted to PLY at one boundary (`src/wasm/normalize.ts`,
  `normalizeSplatToPly`), and the Babylon viewer is fed those PLY bytes. The viewer
  only ever drives Babylon's PLY loader, so a dropped splat no longer depends on the
  source format's loader path.

### Fixed

- **`.spz` load no longer violates the Content Security Policy.** Babylon's `.spz`
  loader fetches a third-party decoder from a CDN at runtime, which the app CSP
  (`script-src 'self' ...`) blocks. Normalizing `.spz` to PLY in WASM before
  visualization removes the CDN dependency entirely, so `.spz` files load and render.
- **Removed the `.spz`-only 180°-X visual rotation hack.** Because `.spz` is now
  loaded as a normalized PLY (same convention as a native PLY), the special-case
  rotation is gone and splat orientation is consistent across `.ply` / `.spz` /
  `.splat`.
- **Non-PLY example scenes now load.** Every demo's example loader hard-coded a
  `.ply` filename when fetching, so `.spz` / `.splat` example URLs were handed to
  the PLY path unnormalized (and the R3F loader normalized before the WASM core was
  initialized). Example loaders now derive the filename from the URL's real
  extension and ensure the core is initialized first, so `.spz` example scenes
  (e.g. "Stairs") normalize to PLY and render like dropped files.
- **Playground Full screen toggle now actually fills the canvas.** The Playground's
  `#pg-split` is a CSS grid with **fixed-pixel** tracks (e.g. `597px 6px 597px`), so
  hiding the editor left its column reserved and the canvas never grew (the overlay
  appeared to "do nothing"). The toggle now drops the grid (`display:block`) so
  `#canvasZone` fills the full width; verified live in the Babylon Playground
  (597px → 1200px), with the overlay UI staying visible and repositioning over the
  full render area.
- **Playground snippet compiles under TypeScript 5.7+.** TS 5.7 made typed arrays
  generic over their backing buffer (`Uint8Array<ArrayBufferLike>`) and `BlobPart`
  now requires an `ArrayBuffer`-backed view (not a possible `SharedArrayBuffer`).
  The snippet keeps the PLY bytes `ArrayBuffer`-backed (copying `spz_to_ply`'s
  output) so `new Blob([ply])` type-checks — without a version-specific generic
  annotation that the Playground's own TS would reject.

## [0.3.2] - 2026-06-22

### Added

- **React Three Fiber (three.js) reference integration.** A first-class R3F demo
  (route `/react`, source under `src/react/`) renders real Gaussian splats and
  runs the full FAST NAV pipeline (floor field -> navmesh -> crowd -> click-to-move)
  on the same engine-agnostic WASM core and `recast-navigation` crowd as the
  Babylon showcase, proving the core is rendering-engine-agnostic.
- **Engine-specific integration guide sections.** `docs/INTEGRATION.md` now has
  dedicated Babylon.js and React Three Fiber sections (handedness / `flip_y`
  contract, crowd + click-to-move, top-down framing) with links to the live demos.

### Changed

- **R3F demo reuses the persistent navmesh cache.** The React pipeline now uses
  the same IndexedDB navmesh artifact cache (`src/navigation/navmeshCache.ts`) as
  the Babylon workbench and Vuetify demo, so revisiting a splat with unchanged
  settings skips parse -> prune -> field -> Recast.

## [0.3.1] - 2026-06-21

### Fixed

- **Local/non-OIDC publish no longer fails on provenance.** The generated package
  no longer bakes `provenance: true` into `publishConfig` (which aborted any
  publish outside a supported OIDC CI provider with `EUSAGE: Automatic provenance
  generation not supported`). Provenance is now enabled only in CI via
  `NPM_CONFIG_PROVENANCE=true` in `.github/workflows/release.yml`, so tagged CI
  releases still publish with provenance while a manual publish works too.

### Added

- **Reserved `@splatwalk/core-pro`.** Published a placeholder for the commercial
  Pro tier (README only), releasing in conjunction with SplatWalk v1.0.0. The free
  `@splatwalk/core` remains MIT and never depends on Pro.

## [0.3.0] - 2026-06-21

First publicly consumable release: the integrator wishlist is fully addressed and
the core is published for community adoption.

### Added

- **Published, scoped npm package.** The core ships as `@splatwalk/core` (binary +
  wasm-bindgen glue + hand-authored types + framework-agnostic `floor` module),
  versioned in lockstep with the crate. Reserves `@splatwalk/core-pro` for a future
  commercial tier. See `scripts/build-package.sh` and
  `.github/workflows/release.yml`.
- **Integration guide.** `docs/INTEGRATION.md` is a task-oriented walkthrough
  (install, preflight, one-call room floor, the `flip_y` contract, Recast voxel
  conversion, progress, structured failures, the `floor` subpath) alongside the
  exhaustive `docs/wasm-api.md` reference.
- **Runnable examples.** `examples/` adds a binary-only room-floor-to-GLB script
  and a Recast metres-to-voxels conversion script.

### Changed

- **Open-core licensing (MIT, free forever).** SplatWalk adopts the MUI X
  open-core model: the published core is relicensed from AGPL-3.0 to **MIT**, free
  for everyone including commercial and proprietary embedding, while advanced
  capabilities are reserved for a future commercial Pro tier. Resolves the
  integrator ask for a non-AGPL embedding path. New `LICENSING.md` (package ->
  license map and stewardship commitment) and `CONTRIBUTING.md` (DCO sign-off);
  `docs/LICENSING-DECISION.md` records the decision.

## [0.2.0] - Unreleased

### Added

- **Versioned distribution.** First prebuilt artifacts and a publishable npm
  package (binary + glue + hand-authored types + framework-agnostic floor
  module). See `scripts/build-package.sh` and `.github/workflows/release.yml`.
- **Semantic version + capability flags.** Every WASM result now carries `semver`
  (tracks the crate version) and `capabilities` alongside `api_version`.
- **Hand-authored published types.** `package/wasm_splatwalk.d.ts` replaces the
  generated all-`any` declarations with the real settings and result shapes.
- **Canonical FAST NAV preset.** `FAST_NAV_PRESET` is exported so integrators no
  longer reverse-engineer the floor-field settings.
- **Framework-agnostic floor module.** `src/navigation/floor.ts` extracts the
  Babylon-free FAST NAV floor math so binary-only / non-Babylon integrators can
  reuse it; `fastNav.ts` keeps re-exporting it.
- **Minimal Rust GLB writer.** `mesh_to_glb(positions, indices)` serializes a mesh
  to binary glTF without a 3D engine on the hot path.
- **WASM-side room-floor entry point.** `build_room_floor_mesh(data, settings)`
  ports the FAST NAV floor extraction (with an optional recovery ladder and the
  same diagnostic reasons) into the core, with optional GLB output.
- **Documented contracts.** The `@progress` line protocol and a tightened
  coordinate/winding convention are now part of `docs/wasm-api.md`.
- **Binary-reachable introspection.** `splatwalk_version()`,
  `splatwalk_api_version()`, and `splatwalk_capabilities()` are now
  `#[wasm_bindgen]` exports for cheap pre-flight feature detection before any
  parse/field build.
- **Baked + exported FAST NAV preset.** `fast_nav_preset()` returns the canonical
  floor-field settings, and `build_room_floor_mesh` now applies that preset as a
  base layer automatically (caller settings and recovery patches still override).
- **Structured room-floor failures.** `build_room_floor_mesh` now rejects with a
  structured object (`reason` / `message` / `attempted` / `selected_area` /
  `component_count` / `steps`) instead of a bare string, so integrators branch on
  a stable `reason` code.
- **Opt-in output coordinate space.** `settings.output_space`
  (`up_axis` / `handedness` / `winding`) converts mesh, basis, floor-plane, and
  bounds results into an engine's convention; absent, output is byte-identical to
  prior releases.
- **Recast helpers.** `recast_agent_defaults()` and `recast_config(settings)`
  expose the reference agent dimensions and the metres-to-voxels conversion
  (plus suggested vertical-bounds padding) so downstream Recast users avoid the
  silent sub-metre voxel-truncation bug.
- **Opt-in progress callback.** `set_progress_callback(cb)` delivers
  `(stage, fraction)` at the same boundaries as the `@progress` line protocol,
  which remains as a fallback, so integrators no longer monkey-patch the global
  console.
- **Cross-visit navmesh cache.** `src/navigation/navmeshCache.ts` adds an
  IndexedDB-backed, LRU, device-memory-budgeted cache
  (`navigator.deviceMemory`, clamped 50-500 MB) of the validated FAST NAV
  artifact. The FAST NAV path (both `runFastNav` and the workbench
  `runNavmeshFromCollider`) keys it on the splat content hash plus the steering
  settings, so revisiting the same splat with unchanged parameters restores the
  navmesh and skips the whole parse/prune/field/Recast pipeline. The derived
  collision seed is excluded from the key (it is a deterministic output, not an
  input). Any storage failure degrades silently to recompute.
- **Auto navmesh cell sizing.** `floor.autoNavCellSize(widthM, depthM,
  agentRadiusM, maxCells)` picks the Recast `cs` inside the standard
  `[agentRadius/3, agentRadius/2]` window, choosing the finest cell size whose grid
  stays under a total-cell budget (`DEFAULT_MAX_NAV_CELLS`). The FAST NAV worker
  uses it by default (`RecastParams.autoCellSize`, `maxNavCells`) so large scenes
  (e.g. a full warehouse floor) are covered completely instead of being limited by
  a fixed hand-picked `cs`; the manual GENERATE NAVMESH path opts out and honours
  the operator's literal cell size.

### Changed

- **Single-sourced crate version (SemVer 2.0.0).** The Cargo workspace root
  (`Cargo.toml` `[workspace.package].version`) is now the one source of truth for
  the Rust crate version, and `wasm-splatwalk` inherits it via
  `version.workspace = true`. This keeps the WASM `semver`/`splatwalk_version()`
  field (from `CARGO_PKG_VERSION`) and the published `splatwalk-core` npm package
  (synced from `package.json` by `scripts/build-package.sh`) in lockstep at
  `0.2.0`, removing the stale `0.1.0` the workspace previously declared. Bumps
  follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html): MINOR for additive
  changes, PATCH for fixes, MAJOR for breaking changes - documented per release in
  this changelog.

### Fixed

- **FAST NAV navmesh no longer breaks on a wide, flat passage.** `walkableClimb`
  was `0.25 m` while the floor field merges cells within a ~`0.5 m` same-level
  band into one continuous region, so Recast re-severed a floor the field already
  treated as continuous wherever capture noise left a `0.3-0.5 m` crease between
  two scan patches - splitting the navmesh so the player and NPC could never
  meet. `walkableClimb` is now aligned to the field's same-level band (`0.5 m`,
  within the Unity/Recast step-height standard) across every attempt in the
  `FAST_NAV_RECAST_ATTEMPTS` ladder, and `walkableRadius` is the gaming-standard
  `0.5 m`.

- **Recast agent dimensions are metres, converted to voxels at the hand-off.**
  `walkableHeight`/`walkableClimb`/`walkableRadius` were passed to Recast in metres,
  but Recast's `rcConfig` stores them as integer voxel counts, so sub-metre values
  truncated to `0` (climb `0.25 m` -> `0`, radius `0.2 m` -> `0`, height `1.7 m` -> `1`).
  That made climb/radius inert and split multi-level floors (e.g. terraced pool decks)
  into disjoint navmesh islands. The floor hand-off now converts metres to voxels
  (`ceil(h/ch)`, `floor(climb/ch)`, `ceil(r/cs)`) and pads vertical headroom above the
  highest floor cell by at least `walkableHeight`, so terraced levels connect into one
  navmesh while box tops and pools stay excluded. Integrators who run Recast themselves
  must apply the same conversion; see "Recast parameter units (metres vs voxels)" in
  `docs/wasm-api.md`.

### Notes

- Adding `semver`/`capabilities` is additive; `api_version` stays `2`, so existing
  binary consumers that only check `api_version` keep working.
