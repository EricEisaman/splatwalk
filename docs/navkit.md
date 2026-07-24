# NavKit (`navkit-<slug>.zip`)

NavKit is a **core Splatwalk product pack**: a single zip that carries the original
Gaussian splat model, baked navigation artifacts, and a `meta-nav.json` envelope
so demos (and integrators) can restore a walkable scene without re-running Fast Nav.

**Engine-agnostic:** pose fields are oriented / nav-world Y-up. Hosts map
`camPos`+`camTarget` (and player pose) to their own camera and avatar — the pack
does not name engine camera types. Apply `playerEulerDeg.y` as mesh `rotation.y`
(tip +Z at yaw 0); do not add an extra sign flip for a host Z-mirror or LH scene.

Do not confuse NavKit with the **FastNav Component Pack** (integrator docs + peer-deps
zip under `/integration-kits/`, UI label **Download FastNav Component Pack**).

## Layout

```
navkit-<slug>.zip
  meta-nav.json
  model/<originalFileName>     # .ply | .spz | .splat (extension must match payload magic)
  nav/
    nav_session.json
    recast.navmesh.bin         # and/or volume trio
    walkable_floors.glb        # Recast debug overlay (click-to-move)
    collision.glb              # optional
    volume.meta.json           # optional
    volume.solid.bin
    volume.nav_region.bin
```

**Detection marker:** root `meta-nav.json` with `format: "splatwalk_navkit_v1"`.

Pose / region / controls live in **`meta-nav.json`** (oriented / nav-world space —
same as `nav_session` spawn/region and camera-select views).

## `meta-nav.json` (`NavKitMetaV1`)

| Field | Meaning |
| --- | --- |
| `format` | `"splatwalk_navkit_v1"` |
| `version` | `1` |
| `title` / `slug` | Display name and download slug |
| `createdAt` | ISO timestamp |
| `model` | `{ path, filename, extension }` under `model/` |
| `defaultNavTechnique` | `floor_field` \| `voxel_collision` \| `sdf_marching_cubes` |
| `defaultActiveNavigationMode` | `recast` \| `voxel_mesh` \| `recast_and_voxel_mesh` |
| `defaultLocomotionMode` | `recast_crowd` \| `voxel_walk` |
| `navPrefix` | `"nav/"` (fixed for v1) |
| `controls` | `{ mode: "click_to_move" \| "wasdqe" \| "both" }` — initial + Download UI |
| `region` | `{ min: [x,y,z], max: [x,y,z] }` selection AABB (optional) |
| `camPos` / `camTarget` | Camera eye + look-at in oriented space (preferred restore) |
| `camEulerDeg` | Optional oriented Y-up pitch/yaw/roll (°); fallback if `camTarget` missing |
| `playerPos` / `playerEulerDeg` | Player feet + oriented euler degrees (optional) |

Demos expose **Camera Information** / **Player Information** panels to preview and copy these values; Download NavKit embeds the live pose sampled at click time.

### Controls modes

| Mode | Behavior |
| --- | --- |
| `click_to_move` | Click green navmesh overlay |
| `wasdqe` | W/S move, A/D turn, Q/E strafe (player agent) |
| `both` | Click + WASDQE (default for new packs / Downloads) |

Workbench, Vuetify, and R3F demos expose a **Controls** UI that applies live and is
written into `meta.controls.mode` on Download NavKit.

### Restore fallbacks

| Meta field | Fallback |
| --- | --- |
| `controls.mode` | `both` |
| `region` | `nav_session` `regionMin`/`regionMax` |
| `playerPos` | `nav_session` `playerSpawn` / `collisionSeed` |
| `playerEulerDeg` | `{0,0,0}` |
| `camPos` + (`camTarget` \| `camEulerDeg`) | `focusOnPlayer` if no usable camera pair |

Nested `nav/` members reuse the nav-artifact contract
([`navArtifactContract.ts`](../src/navigation/navArtifactContract.ts)).

## Host APIs

| Module | Role |
| --- | --- |
| [`src/navigation/navKitContract.ts`](../src/navigation/navKitContract.ts) | Schema + constants |
| [`src/navigation/navKitBundle.ts`](../src/navigation/navKitBundle.ts) | `build` / `parse` / `peek` / `download` |
| [`src/navigation/applyNavKitMeta.ts`](../src/navigation/applyNavKitMeta.ts) | Pose / controls ingest after nav restore |
| [`src/navigation/playerWasdControls.ts`](../src/navigation/playerWasdControls.ts) | Shared WASDQE key tracker + integrate |
| [`src/navigation/walkableFloorsGlb.ts`](../src/navigation/walkableFloorsGlb.ts) | Pack / unpack Recast debug mesh |

## Demo support

| Demo | Download | Restore | Controls UI |
| --- | --- | --- | --- |
| Vuetify Fast Nav (`/vuetify`) | **Download NavKit** | Drop `navkit.zip` | Click / WASDQE / Both |
| R3F Fast Nav (`/react`) | **Download NavKit** | Drop `navkit.zip` | Click / WASDQE / Both |
| 3D Workbench (`/`) | **Download NavKit** (toolbar) | Drop / choose local file | Controls `<select>` |

## Load behavior

1. Peek for valid `meta-nav.json`.
2. Load `model/*` (normalize to PLY for the viewer).
3. Apply `nav/*` via `applyNavArtifacts*` (overlay → crowd).
4. Apply meta pose / controls via `applyNavKitMeta*`.
5. Sync UI technique / Active / Controls from meta.

Restore holds `playerEulerDeg.y` until the user clicks the navmesh or uses WASDQE
(so Recast path/velocity travel-facing cannot overwrite the saved tip).

**Do not** re-run Fast Nav when restoring a NavKit.

## Checks

```bash
npm run check:navkit
```
