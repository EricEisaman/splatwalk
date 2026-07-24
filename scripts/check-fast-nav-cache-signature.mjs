/**
 * Unit checks for Fast Nav IndexedDB cache key sensitivity.
 *
 * Runs without Vite/Jest: inlines the same hashing + signature builders as
 * src/navigation/navmeshCache.ts and src/navigation/fastNavCacheSignature.ts.
 *
 *   node scripts/check-fast-nav-cache-signature.mjs
 */

const FAST_NAV_CACHE_SCHEMA_VERSION = 1;
const FAST_NAV_FLOOR_PIPELINE = 'ts-extract-v1';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

function contentHash(bytes) {
  let hash = (FNV_OFFSET ^ BigInt(bytes.length)) & U64_MASK;
  const stride = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += stride) {
    hash = ((hash ^ BigInt(bytes[i])) * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16);
}

function stringHash(input) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i) & 0xff)) * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16);
}

function buildNavmeshKey(bytes, signature) {
  return `${contentHash(bytes)}:${stringHash(JSON.stringify(signature))}`;
}

function meshSettingsForCacheSignature(settings) {
  const { camera_position: _c, collision_seed: _s, ...rest } = settings;
  return { ...rest };
}

function buildFastNavCacheSignature(input) {
  const signature = {
    schemaVersion: FAST_NAV_CACHE_SCHEMA_VERSION,
    algo: input.algo,
    floorPipeline: input.floorPipeline ?? null,
    base: meshSettingsForCacheSignature(input.base),
    recovery: input.recovery ?? null,
    strayTrim: input.strayTrim ?? null,
    denseSeed: input.denseSeed ?? null,
    floorMesh: input.floorMesh ?? null,
    seedCenteredOutdoor: input.seedCenteredOutdoor === true,
    islandValidation: input.islandValidation ?? null,
    recastAttempts: input.recastAttempts ?? null,
  };
  if (input.extras && Object.keys(input.extras).length > 0) {
    signature.extras = input.extras;
  }
  return signature;
}

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const baseSettings = {
  environment_scale: 1,
  prune_floaters: true,
  region_min: [0, 0, 0],
  region_max: [10, 3, 10],
  sdf_cell_size: 0.2,
  camera_position: [1, 2, 3],
  collision_seed: [0, 1, 0],
};

const baseSigInput = {
  algo: 'floor_field',
  base: baseSettings,
  recovery: null,
  recastAttempts: [{ label: 'strict', params: { walkableRadius: 0.35 } }],
  floorMesh: { sameLevelBelow: 1.5, sameLevelAbove: 2.0, seedCenteredOutdoor: false },
  floorPipeline: FAST_NAV_FLOOR_PIPELINE,
  seedCenteredOutdoor: false,
  islandValidation: { maxSeedDistance: 80, mergeNearbyIslands: true },
};

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`OK: ${msg}`);
  }
};

const keyA = buildNavmeshKey(bytes, buildFastNavCacheSignature(baseSigInput));
const keyA2 = buildNavmeshKey(bytes, buildFastNavCacheSignature(baseSigInput));
assert(keyA === keyA2, 'same bytes + settings → same key');

const keyScale = buildNavmeshKey(
  bytes,
  buildFastNavCacheSignature({
    ...baseSigInput,
    base: { ...baseSettings, environment_scale: 2 },
  })
);
assert(keyScale !== keyA, 'environment_scale change → different key');

const keyIsland = buildNavmeshKey(
  bytes,
  buildFastNavCacheSignature({
    ...baseSigInput,
    islandValidation: { maxSeedDistance: 20, mergeNearbyIslands: false },
  })
);
assert(keyIsland !== keyA, 'islandValidation.maxSeedDistance change → different key');

const keyOutdoor = buildNavmeshKey(
  bytes,
  buildFastNavCacheSignature({
    ...baseSigInput,
    seedCenteredOutdoor: true,
    floorMesh: { ...baseSigInput.floorMesh, seedCenteredOutdoor: true },
  })
);
assert(keyOutdoor !== keyA, 'seedCenteredOutdoor change → different key');

const keyPrune = buildNavmeshKey(
  bytes,
  buildFastNavCacheSignature({
    ...baseSigInput,
    base: { ...baseSettings, prune_floaters: false },
  })
);
assert(keyPrune !== keyA, 'prune_floaters change → different key');

const keyRegion = buildNavmeshKey(
  bytes,
  buildFastNavCacheSignature({
    ...baseSigInput,
    base: { ...baseSettings, region_max: [20, 3, 20] },
  })
);
assert(keyRegion !== keyA, 'region AABB change → different key');

const keyCamOnly = buildNavmeshKey(
  bytes,
  buildFastNavCacheSignature({
    ...baseSigInput,
    base: { ...baseSettings, camera_position: [9, 9, 9] },
  })
);
assert(keyCamOnly === keyA, 'camera_position alone does not change key');

const stripped = meshSettingsForCacheSignature(baseSettings);
assert(
  !('camera_position' in stripped) && !('collision_seed' in stripped),
  'signature strips camera_position and collision_seed'
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll fast-nav cache signature checks passed.');
