/**
 * Sanity-check sanitizeMeshSettingsForWasm (no Vite — inline twin of the TS helper).
 */
const isPresent = (value) => value !== undefined && value !== null;

const asPlainVec3 = (value) => {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  if (typeof value.length !== 'number' || value.length < 3) {
    return null;
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (![x, y, z].every((n) => Number.isFinite(n))) {
    return null;
  }
  return [x, y, z];
};

const sanitizeMeshSettingsForWasm = (settings) => {
  const out = { ...settings };
  for (const key of ['camera_position', 'collision_seed']) {
    if (!(key in out) || !isPresent(out[key])) {
      delete out[key];
      continue;
    }
    const vec = asPlainVec3(out[key]);
    if (!vec) {
      delete out[key];
      continue;
    }
    out[key] = vec;
  }
  const hasMin = 'region_min' in out && isPresent(out.region_min);
  const hasMax = 'region_max' in out && isPresent(out.region_max);
  if (!hasMin && !hasMax) {
    delete out.region_min;
    delete out.region_max;
    return out;
  }
  const min = hasMin ? asPlainVec3(out.region_min) : null;
  const max = hasMax ? asPlainVec3(out.region_max) : null;
  if (!min || !max) {
    delete out.region_min;
    delete out.region_max;
    return out;
  }
  out.region_min = min;
  out.region_max = max;
  return out;
};

const assert = (cond, msg) => {
  if (!cond) {
    throw new Error(msg);
  }
};

const stripped = sanitizeMeshSettingsForWasm({
  mode: 2,
  region_min: undefined,
  region_max: undefined,
  collision_seed: null,
  camera_position: undefined,
});
assert(!('region_min' in stripped), 'undefined region_min must be removed');
assert(!('region_max' in stripped), 'undefined region_max must be removed');
assert(!('collision_seed' in stripped), 'null collision_seed must be removed');
assert(!('camera_position' in stripped), 'undefined camera_position must be removed');

const kept = sanitizeMeshSettingsForWasm({
  mode: 2,
  region_min: [1, 2, 3],
  region_max: [4, 5, 6],
  collision_seed: new Float64Array([0.5, 1.5, 2.5]),
});
assert(Array.isArray(kept.region_min) && kept.region_min.length === 3, 'region_min kept');
assert(kept.region_min[0] === 1 && kept.region_min[2] === 3, 'region_min values');
assert(Array.isArray(kept.collision_seed), 'typed array seed → plain array');
assert(kept.collision_seed[1] === 1.5, 'seed y');

const half = sanitizeMeshSettingsForWasm({
  region_min: [0, 0, 0],
  region_max: null,
});
assert(!('region_min' in half) && !('region_max' in half), 'pair incomplete → drop both');

const cloned = structuredClone({ region_min: undefined, region_max: undefined, mode: 2 });
const afterClone = sanitizeMeshSettingsForWasm(cloned);
assert(!('region_min' in afterClone), 'post-structuredClone undefined keys stripped');

console.log('check-region-sanitize: ok');
