/**
 * In-memory NavKit zip contract checks (no browser).
 *
 *   node scripts/check-navkit-contract.mjs
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const NAV_KIT_META_FILE = 'meta-nav.json';
const NAV_KIT_FORMAT = 'splatwalk_navkit_v1';
const NAV_KIT_NAV_PREFIX = 'nav/';
const NAV_KIT_MODEL_PREFIX = 'model/';

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`OK: ${msg}`);
  }
};

const modelFilename = 'scene.ply';
const modelBytes = new Uint8Array([1, 2, 3, 4, 5]);
const navSession = {
  version: 1,
  locomotionMode: 'recast_crowd',
  activeNavigationMode: 'recast_and_voxel_mesh',
  playerSpawn: [0, 1, 0],
  collisionSeed: [0, 1, 0],
};
const meta = {
  format: NAV_KIT_FORMAT,
  version: 1,
  title: 'scene',
  slug: 'scene',
  createdAt: new Date().toISOString(),
  model: {
    path: `${NAV_KIT_MODEL_PREFIX}${modelFilename}`,
    filename: modelFilename,
    extension: 'ply',
  },
  defaultNavTechnique: 'sdf_marching_cubes',
  defaultActiveNavigationMode: 'recast_and_voxel_mesh',
  defaultLocomotionMode: 'recast_crowd',
  navPrefix: NAV_KIT_NAV_PREFIX,
  controls: { mode: 'both' },
  region: { min: [-2, 0, -2], max: [2, 3, 2] },
  camPos: { x: 0, y: 5, z: 8 },
  camTarget: { x: 0, y: 1, z: 0 },
  camEulerDeg: { x: -35, y: 0, z: 0 },
  playerPos: { x: 0.5, y: 0.1, z: -0.25 },
  playerEulerDeg: { x: 0, y: 45, z: 0 },
};

const entries = {
  [NAV_KIT_META_FILE]: strToU8(`${JSON.stringify(meta, null, 2)}\n`),
  [meta.model.path]: modelBytes,
  [`${NAV_KIT_NAV_PREFIX}nav_session.json`]: strToU8(`${JSON.stringify(navSession, null, 2)}\n`),
  [`${NAV_KIT_NAV_PREFIX}recast.navmesh.bin`]: new Uint8Array([9, 8, 7]),
  [`${NAV_KIT_NAV_PREFIX}walkable_floors.glb`]: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
};

const zipBytes = zipSync(entries, { level: 6 });
assert(zipBytes.byteLength > 0, 'zip builds');

const unzipped = unzipSync(zipBytes);
assert(Boolean(unzipped[NAV_KIT_META_FILE]), 'meta-nav.json present');
assert(Boolean(unzipped[meta.model.path]), 'model member present');
assert(
  Boolean(unzipped[`${NAV_KIT_NAV_PREFIX}nav_session.json`]),
  'nav/nav_session.json present'
);
assert(
  Boolean(unzipped[`${NAV_KIT_NAV_PREFIX}recast.navmesh.bin`]),
  'nav/recast.navmesh.bin present'
);
assert(
  Boolean(unzipped[`${NAV_KIT_NAV_PREFIX}walkable_floors.glb`]),
  'nav/walkable_floors.glb present'
);

const parsedMeta = JSON.parse(strFromU8(unzipped[NAV_KIT_META_FILE]));
assert(parsedMeta.format === NAV_KIT_FORMAT, 'format splatwalk_navkit_v1');
assert(parsedMeta.defaultNavTechnique === 'sdf_marching_cubes', 'defaultNavTechnique preserved');
assert(parsedMeta.model.extension === 'ply', 'model extension ply');
assert(parsedMeta.controls?.mode === 'both', 'controls.mode both');
assert(parsedMeta.cameraMode === undefined, 'no cameraMode in meta (engine-agnostic)');
assert(
  Array.isArray(parsedMeta.region?.min) && parsedMeta.region.min[0] === -2,
  'region.min round-trip'
);
assert(parsedMeta.camPos?.y === 5, 'camPos round-trip');
assert(parsedMeta.camTarget?.y === 1, 'camTarget round-trip');
assert(parsedMeta.camEulerDeg?.x === -35, 'camEulerDeg round-trip');
assert(parsedMeta.playerPos?.x === 0.5, 'playerPos round-trip');
assert(parsedMeta.playerEulerDeg?.y === 45, 'playerEulerDeg round-trip');

const modelOut = unzipped[meta.model.path];
assert(
  modelOut && modelOut.length === modelBytes.length && modelOut[0] === 1,
  'model bytes round-trip'
);

const legacy = zipSync(
  {
    'nav_session.json': strToU8('{"version":1,"locomotionMode":"recast_crowd"}'),
    'recast.navmesh.bin': new Uint8Array([1]),
  },
  { level: 6 }
);
const legacyEntries = unzipSync(legacy);
assert(!legacyEntries[NAV_KIT_META_FILE], 'legacy nav-artifacts zip has no meta-nav.json');

/** Oriented Y-up euler ↔ look direction (engine-neutral). */
const lookFromEulerDeg = (eulerDeg, dist = 10) => {
  const pitch = (eulerDeg.x * Math.PI) / 180;
  const yaw = (eulerDeg.y * Math.PI) / 180;
  return {
    x: Math.sin(yaw) * Math.cos(pitch) * dist,
    y: -Math.sin(pitch) * dist,
    z: Math.cos(yaw) * Math.cos(pitch) * dist,
  };
};
const eulerDegFromLook = (dir) => {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  const fx = dir.x / len;
  const fy = dir.y / len;
  const fz = dir.z / len;
  const yaw = Math.atan2(fx, fz);
  const pitch = -Math.asin(Math.max(-1, Math.min(1, fy)));
  return { x: (pitch * 180) / Math.PI, y: (yaw * 180) / Math.PI, z: 0 };
};
const sampleEuler = { x: -35, y: 40, z: 0 };
const roundTrip = eulerDegFromLook(lookFromEulerDeg(sampleEuler));
assert(Math.abs(roundTrip.x - sampleEuler.x) < 1e-6, 'camEuler look-dir pitch round-trip');
assert(Math.abs(roundTrip.y - sampleEuler.y) < 1e-6, 'camEuler look-dir yaw round-trip');

/**
 * tropical_compound camera: Babylon ArcRotate offset is
 * (r·cosα·sinβ, r·cosβ, r·sinα·sinβ) → α = atan2(z, x). Swapped atan2(x, z)
 * reproduced the known bad restore pose. New kits store camTarget explicitly.
 */
const tropicalCamPos = { x: 2.3040615796959574, y: 0.16013837173965118, z: 3.485497893107648 };
const tropicalCamEuler = { x: 12.022756865348105, y: -42.62202695312602, z: 0 };
const tropicalLookDist = 10;
const tropicalLook = lookFromEulerDeg(tropicalCamEuler, tropicalLookDist);
const tropicalTarget = {
  x: tropicalCamPos.x + tropicalLook.x,
  y: tropicalCamPos.y + tropicalLook.y,
  z: tropicalCamPos.z + tropicalLook.z,
};
assert(
  Math.abs(tropicalTarget.x - -4.318992309193364) < 1e-6,
  'tropical_compound camTarget from oriented euler'
);
const tropOx = tropicalCamPos.x - tropicalTarget.x;
const tropOy = tropicalCamPos.y - tropicalTarget.y;
const tropOz = tropicalCamPos.z - tropicalTarget.z;
const tropRadius = Math.hypot(tropOx, tropOy, tropOz);
const tropBeta = Math.acos(Math.max(-1, Math.min(1, tropOy / tropRadius)));
const babylonPlace = (alpha) => ({
  x: tropicalTarget.x + tropRadius * Math.cos(alpha) * Math.sin(tropBeta),
  y: tropicalTarget.y + tropRadius * Math.cos(tropBeta),
  z: tropicalTarget.z + tropRadius * Math.sin(alpha) * Math.sin(tropBeta),
});
const alphaCorrect = Math.atan2(tropOz, tropOx);
const alphaWrong = Math.atan2(tropOx, tropOz);
const rebuilt = babylonPlace(alphaCorrect);
const broken = babylonPlace(alphaWrong);
const rebuiltErr = Math.hypot(
  rebuilt.x - tropicalCamPos.x,
  rebuilt.y - tropicalCamPos.y,
  rebuilt.z - tropicalCamPos.z
);
assert(rebuiltErr < 1e-6, 'tropical_compound Babylon α=atan2(z,x) rebuilds saved camPos');
assert(
  Math.abs(broken.x - -11.515954223819389) < 1e-6 &&
    Math.abs(broken.z - 17.305513696622995) < 1e-6,
  'tropical_compound wrong α=atan2(x,z) documents opposite-orbit regression'
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll NavKit contract checks passed.');
