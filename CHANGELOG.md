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

## [0.2.0] - Unreleased

### Added

- **Versioned distribution.** First tagged release with prebuilt artifacts and a
  publishable `splatwalk-core` npm package (binary + glue + hand-authored types +
  framework-agnostic floor module). See `scripts/build-package.sh` and
  `.github/workflows/release.yml`.
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

### Notes

- Adding `semver`/`capabilities` is additive; `api_version` stays `2`, so existing
  binary consumers that only check `api_version` keep working.
