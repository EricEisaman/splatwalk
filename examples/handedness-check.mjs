// Headless regression for the `output_space` coordinate contract.
//
// Drives the locally built WASM core through several `output_space` settings and
// asserts the reported space metadata (space / handedness / up_axis) and the
// geometric outcome (face winding / up-axis) match the documented contract. This
// is the deterministic, CI-friendly counterpart of the right-handed demo scenes
// in SplatWalk issue #3 (Mutualism Track B); see docs/coordinate-alignment.md.
//
//   npm run build:wasm        # produces pkg/wasm_splatwalk/
//   npm run check:handedness  # runs this script
//
// Optionally pass a real splat to use instead of the synthetic floor:
//   node examples/handedness-check.mjs path/to/scene.ply
//
// @splatwalk/core is MIT-licensed and free forever (see ../LICENSING.md).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// The repo build targets `web` (scripts/build-wasm.sh), so in Node we must hand
// the wasm bytes to init() explicitly - there is no file:// fetch.
const corePath = here('../pkg/wasm_splatwalk/wasm_splatwalk.js');
const wasmPath = here('../pkg/wasm_splatwalk/wasm_splatwalk_bg.wasm');

let core;
try {
  core = await import(corePath);
} catch (e) {
  console.error(`Could not import the built core at ${corePath}`);
  console.error('Run `npm run build:wasm` first.');
  console.error(String(e?.message ?? e));
  process.exit(1);
}

const { default: init, init_splatwalk, splatwalk_api_version, build_room_floor_mesh } = core;

const wasmBytes = new Uint8Array(await readFile(wasmPath));
try {
  await init({ module_or_path: wasmBytes });
} catch {
  // Older wasm-bindgen accepts the bytes positionally.
  await init(wasmBytes);
}
init_splatwalk();

if (splatwalk_api_version() !== 2) {
  console.error(`Unsupported SplatWalk binary (api_version=${splatwalk_api_version()}, expected 2)`);
  process.exit(1);
}

// --- input: a real splat if provided, else a synthetic dense floor patch ------

function syntheticFloorPly() {
  // A dense, slightly noisy horizontal plane in splatwalk-oriented space
  // (+Y up, floor at y~=0). Enough area/density to extract a room floor.
  const n = 90; // 90 x 90 = 8100 points
  const span = 8; // metres
  const step = span / (n - 1);
  const half = span / 2;
  let seed = 1337;
  const rand = () => {
    // deterministic LCG so the fixture (and thus the run) is reproducible
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const lines = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -half + i * step;
      const z = -half + j * step;
      const y = (rand() - 0.5) * 0.01; // +/- 5mm jitter
      lines.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 1.0`);
    }
  }
  const header = [
    'ply',
    'format ascii 1.0',
    `element vertex ${lines.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property float opacity',
    'end_header',
    '',
  ].join('\n');
  return new TextEncoder().encode(header + lines.join('\n') + '\n');
}

const argPath = process.argv[2];
const splatBytes = argPath
  ? new Uint8Array(await readFile(argPath))
  : syntheticFloorPly();
console.log(argPath ? `Input: ${argPath}` : 'Input: synthetic floor patch (8m x 8m)');

// --- helpers ------------------------------------------------------------------

const BASE = { mode: 2, flip_y: false, rotation: [0, 0, 0], min_room_floor_area: 0.5 };

function runFloor(output_space) {
  const settings = output_space ? { ...BASE, output_space } : { ...BASE };
  return build_room_floor_mesh(splatBytes, settings);
}

/** Average normalized face normal of a triangle mesh ({vertices, indices}). */
function avgFaceNormal(mesh) {
  const p = mesh.vertices;
  const idx = mesh.indices;
  let sx = 0, sy = 0, sz = 0, count = 0;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9) {
      sx += nx / len; sy += ny / len; sz += nz / len; count++;
    }
  }
  if (count === 0) return null;
  return [sx / count, sy / count, sz / count];
}

let failures = 0;
function assert(cond, message) {
  if (cond) {
    console.log(`  ok   ${message}`);
  } else {
    console.error(`  FAIL ${message}`);
    failures++;
  }
}

// --- assertions ---------------------------------------------------------------

// 1. Default output: the fixed splatwalk_oriented contract, floor faces up.
console.log('default (no output_space):');
let r = runFloor(undefined);
let n = avgFaceNormal(r.mesh);
assert(r.space.space === 'splatwalk_oriented', `space === 'splatwalk_oriented' (got '${r.space.space}')`);
assert(r.space.handedness === 'right', `handedness === 'right' (got '${r.space.handedness}')`);
assert(r.space.up_axis === 'y', `up_axis === 'y' (got '${r.space.up_axis}')`);
assert(!!n, 'floor mesh has triangulated faces');
assert(!!n && n[1] > 0.5, `floor faces point +Y (avg n=${n?.map((v) => v.toFixed(2))})`);

// 2. Left-handed: Z mirrored; auto winding flip must keep faces front-facing.
console.log("output_space { handedness: 'left' }:");
r = runFloor({ handedness: 'left' });
n = avgFaceNormal(r.mesh);
assert(r.space.space === 'engine_output', `space === 'engine_output' (got '${r.space.space}')`);
assert(r.space.handedness === 'left', `handedness === 'left' (got '${r.space.handedness}')`);
assert(!!n && n[1] > 0.5, `floor still faces +Y after Z-mirror + winding flip (avg n=${n?.map((v) => v.toFixed(2))})`);

// 3. Z-up: +Y up rotates into +Z up (about X). Floor now faces +Z.
console.log("output_space { up_axis: 'z' }:");
r = runFloor({ up_axis: 'z' });
n = avgFaceNormal(r.mesh);
assert(r.space.space === 'engine_output', `space === 'engine_output' (got '${r.space.space}')`);
assert(r.space.up_axis === 'z', `up_axis === 'z' (got '${r.space.up_axis}')`);
assert(Math.abs(r.basis.up[2]) > 0.9, `basis up maps to Z (up=${r.basis.up.map((v) => v.toFixed(2))})`);
assert(!!n && n[2] > 0.5, `floor faces +Z (avg n=${n?.map((v) => v.toFixed(2))})`);

// 4. Explicit cw winding (identity basis): faces reverse, normals flip to -Y.
console.log("output_space { winding: 'cw' }:");
r = runFloor({ handedness: 'right', up_axis: 'y', winding: 'cw' });
n = avgFaceNormal(r.mesh);
assert(r.space.space === 'engine_output', `space === 'engine_output' (got '${r.space.space}')`);
assert(!!n && n[1] < -0.5, `explicit cw winding reverses faces to -Y (avg n=${n?.map((v) => v.toFixed(2))})`);

// --- summary ------------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.error(`output_space regression FAILED: ${failures} assertion(s).`);
  process.exit(1);
}
console.log('output_space regression passed.');
