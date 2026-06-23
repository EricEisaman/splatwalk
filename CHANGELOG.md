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

## [Unreleased]

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
  the Playground it "hijacks" the split (tags `#pg-split` so the editor + splitter
  collapse and `#canvasZone` fills the view — pure CSS, so the overlay UI survives),
  and outside it falls back to the Fullscreen API; a `?fullscreen=true` URL param
  enters full screen on load. A runnable demo lives at `/playground/` (`public/playground/index.html`,
  linked from the homepage nav) and reproduces the Playground TS pipeline; it adds
  a **Download `playground.json`** button — a byte-compatible Babylon Playground
  **V2 snippet** (`{ payload, name, description, tags }` → V2 manifest, with the
  `unicode` base64 path for non-Latin1 source) so users can load it into the real
  Playground and edit it. Documented in `README.md` and `docs/INTEGRATION.md`.

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
