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

`@splatwalk/core` is MIT-licensed and free forever, including commercial use.
