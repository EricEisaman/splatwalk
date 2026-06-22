# React Three Fiber (R3F) FAST NAV demo

A React Three Fiber integration of the SplatWalk FAST NAV pipeline, mirroring the
Vuetify showcase but rendering with three.js instead of Babylon. It loads a
`.ply` / `.spz` Gaussian splat, renders it with
[`@mkkellogg/gaussian-splats-3d`](https://github.com/mkkellogg/GaussianSplats3D),
extracts the walkable floor with the SplatWalk WASM core, builds a Recast
navmesh, and runs a click-to-move crowd (player + NPC) via
[`recast-navigation`](https://github.com/isaac-mason/recast-navigation-js).

This demo lives **inside the SplatWalk repo** as a Vite MPA route (it imports the
in-repo `src/` modules), exactly like the Vuetify showcase. It is not a
standalone npm project; the goal is a first-class, runnable reference for the
React/three.js audience.

## Run it

From the repository root:

```bash
npm install
npm run dev
```

Then open the demo route:

- http://localhost:5173/react

Drop a `.ply` / `.spz` splat (or pick an example scene). FAST NAV runs
automatically: floor field -> floor mesh -> Recast navmesh -> crowd + NPC. Click
the green navmesh overlay to move the blue player agent; the green NPC shares the
crowd.

## How it maps to `@splatwalk/core`

The pipeline uses only engine-agnostic pieces, so the same flow works against the
published `@splatwalk/core` package:

| Step | Repo module | `@splatwalk/core` equivalent |
| --- | --- | --- |
| Init WASM | `splatwalk.init()` (`src/wasm/bridge.ts`) | `await init()` + `init_splatwalk()` |
| Floor field | `build_walkable_ground_field` + `src/navigation/floor.ts` | `build_walkable_ground_field` + `@splatwalk/core/floor` |
| (or one-call floor) | n/a | `build_room_floor_mesh` |
| Navmesh | `src/navigation/navmesh.worker.ts` (Recast) | `recast-navigation` + `recast_config()` |
| Crowd | `src/react/three/SplatNavController.ts` | `recast-navigation` `Crowd` / `CrowdAgent` |

## Key files

- `react.html` - MPA entry.
- `src/react/main.tsx`, `src/react/App.tsx` - React bootstrap + app shell.
- `src/react/SplatFastNavShowcase.tsx` - the MUI showcase UI (mirrors the Vuetify page).
- `src/react/SceneCanvas.tsx` - the R3F `<Canvas>` and per-frame crowd tick.
- `src/react/three/SplatNavController.ts` - splat rendering, floor/navmesh overlays, and the recast crowd.
- `src/react/useSplatFastNavR3F.ts` - the FAST NAV orchestration hook.

## Coordinate / `flip_y` note

The WASM floor/navmesh are built with `flip_y: true` (SplatWalk-oriented, +Y up).
Raw PLY splats are Y-down, so the splat group is mirrored on Y
(`splatGroup.scale.y = -1`) to land in the same +Y-up space as the floor - no
per-output Y offset hacks (see [`../../docs/INTEGRATION.md`](../../docs/INTEGRATION.md)
section 4).
