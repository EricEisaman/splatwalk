# SplatWalk examples

Minimal, runnable snippets for the `@splatwalk/core` package. See
[`../docs/INTEGRATION.md`](../docs/INTEGRATION.md) for the full guide.

```bash
npm install @splatwalk/core
node binary-only.mjs path/to/scene.ply
node recast-config.mjs
```

- [`binary-only.mjs`](binary-only.mjs) - load the wasm, run the one-call room
  floor, write a GLB. No 3D engine required.
- [`recast-config.mjs`](recast-config.mjs) - convert reference agent dimensions
  from metres to Recast's integer voxel counts (avoids the silent truncation bug).
- [`handedness-check.mjs`](handedness-check.mjs) - headless regression for the
  `output_space` coordinate contract (space / handedness / up-axis / winding). It
  runs against the **locally built** core, so build the wasm first:

  ```bash
  npm run build:wasm
  npm run check:handedness
  ```

  Pass a `.ply` path to use a real splat instead of the synthetic floor fixture.
  See [`../docs/coordinate-alignment.md`](../docs/coordinate-alignment.md).

`@splatwalk/core` is MIT-licensed and free forever, including commercial use.
