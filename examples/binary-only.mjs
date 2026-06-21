// Minimal binary-only SplatWalk example: load the wasm, extract a room floor
// from a splat, and write a GLB. No 3D engine required.
//
//   npm install @splatwalk/core
//   node binary-only.mjs path/to/scene.ply
//
// @splatwalk/core is MIT-licensed and free forever (see ../LICENSING.md).

import { readFile, writeFile } from 'node:fs/promises';
import init, {
  init_splatwalk,
  splatwalk_api_version,
  splatwalk_version,
  build_room_floor_mesh,
  mesh_to_glb,
} from '@splatwalk/core';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node binary-only.mjs <scene.ply>');
  process.exit(1);
}

await init();
init_splatwalk();

if (splatwalk_api_version() !== 2) {
  throw new Error('Unsupported SplatWalk binary (api_version != 2)');
}
console.log(`SplatWalk core ${splatwalk_version()}`);

const splatBytes = new Uint8Array(await readFile(inputPath));

try {
  const floor = build_room_floor_mesh(splatBytes, {
    mode: 2,
    flip_y: true, // match your renderer's splat Y-scale sign; see the guide
    rotation: [0, 0, 0],
    emit_glb: true,
  });

  const glb = floor.glb ?? mesh_to_glb(floor.mesh.vertices, floor.mesh.indices);
  await writeFile('floor.glb', Buffer.from(glb));

  console.log(
    `Floor: area=${floor.selected_area.toFixed(2)} m^2, ` +
      `components=${floor.component_count}, step=${floor.step_label} -> floor.glb`
  );
} catch (e) {
  // Structured failure: branch on the stable reason code.
  console.error(`Room floor failed: reason=${e.reason} (${e.message})`);
  console.error(`Attempted steps: ${(e.attempted ?? []).join(', ')}`);
  process.exit(2);
}
