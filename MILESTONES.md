# SplatWalk Milestones

This document tracks the streaming-oriented roadmap for SplatWalk: what shipped
now (splat slicing / SOG export), and the work queued for when Babylon's
Gaussian-splat streaming lands in production.

> For the ecosystem-facing roadmap — mutually-beneficial integrations with the
> Babylon.js Playground, the GS runtime, babylon-game-starter, and three.js —
> see [`MUTUALISM_MILESTONES.md`](MUTUALISM_MILESTONES.md).

## Now — `splatSlice` / SOG export (shipped)

Goal: let integrators turn a `.ply`/`.spz` splat into a streamable, hostable
SOG bundle directly from the WASM API, with UI controls in both demos.

- **SOG v2 encoder** (`wasm-splatwalk/src/sog.rs`): quantizes a full-fidelity
  splat cloud into the exact RGBA8 plane + `meta.json` layout Babylon's
  `ParseSogMeta` / `ParseSogMetaAsTextures` decode (means split 16-bit
  symmetric-log, scales/sh0 codebooks, largest-three quaternion packing,
  configurable-degree shN k-means palette). Planes are encoded to **lossless**
  WebP in Rust (`image-webp`, VP8L) so quantized indices survive byte-exact.
- **Streamed slicer** (`wasm-splatwalk/src/slice.rs`): Morton (Z-order) reorders
  the cloud, splits it into spatially-local LOD chunks (by target splat count
  and world extent), and emits a `lod-meta.json` manifest plus a per-chunk SOG
  dataset. Modeled on PlayCanvas `splat-transform`'s streamed-SOG idea.
- **Full-fidelity ingest** (`wasm-splatwalk/src/splat.rs`): `FullSplatCloud`
  preserves every Gaussian attribute incl. spherical harmonics up to degree 3,
  parsed from both PLY and SPZ. (The nav/mesh path keeps its lightweight
  `PointNormal` parse for performance.)
- **WASM API**: `slice_splat`, `convert_to_sog`, and `spz_to_ply` (see
  `docs/wasm-api.md`).
- **Inline `.spz` support**: `.spz` is decompressed in-browser and normalized to
  a full-fidelity `.ply` via `spz_to_ply`, so the viewer and nav pipeline only
  deal with PLY.
- **TypeScript surface**: first-rate types in `src/wasm/sogTypes.ts`; bridge
  methods `sliceSplat` / `convertToSog` / `spzToPly` (`src/wasm/bridge.ts`); a
  `SliceArchive` wrapper (`src/wasm/sliceArchive.ts`) exposing download
  (store-only zip) and an in-memory object-URL directory for streaming preview.
- **UI**: a "Streamed SOG Export" panel on the homepage (plain DOM) and an
  expansion panel in the Vuetify `SplatFastNavShowcase` component, both exposing
  all slice parameters and defaulting to streamed (LOD) export for scenes over
  1,000,000 splats.

## Next month — Babylon GS streaming integration

When Babylon's GS streaming loader (PR
[#18563](https://github.com/BabylonJS/Babylon.js/pull/18563)) ships in
production:

- Wire the SplatWalk viewer to stream a sliced bundle via `lod-meta.json`,
  loading chunks on demand by camera proximity / LOD.
- Use `SliceArchive.createBlobDirectory()` as the in-app streaming seam (resolve
  chunk paths to `blob:` URLs) for slice-then-preview without a round-trip to a
  host.
- Reconcile our interim `lod-meta.json` schema (`slice.rs`, version 1) with the
  final loader contract; add LOD-selection metadata the loader expects.
- Run the nav pipeline against the streamed scene (slice → stream → FAST NAV).

## Next month — VR support for demos

- Add WebXR sessions to the demos (immersive-vr) with controller-based
  teleport/locomotion constrained to the generated navmesh.
- Frame the streamed-SOG scene for room-scale viewing; validate performance with
  on-demand chunk streaming inside an XR frame loop.

## Later / nice-to-have

- GPU-assisted shN palette clustering (the CPU k-means is the slowest stage on
  very large scenes).
- `smooth` collision-mesh mode (marching cubes / coplanar merge).
- Optional in-Rust `.zip` assembly if integrators want a single-call bundle.
