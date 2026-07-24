/**
 * Strip/normalize MeshSettings fields before postMessage → WASM.
 * Explicit `undefined` / `null` region keys survive structured clone and fail
 * WASM validate_region_json ("must be a length-3 [x,y,z] number array").
 */

const VEC3_KEYS = ['camera_position', 'collision_seed'] as const;
const REGION_MIN = 'region_min';
const REGION_MAX = 'region_max';

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

const asPlainVec3 = (value: unknown): number[] | null => {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'object') {
    return null;
  }
  const arr = value as ArrayLike<unknown> & { length?: number };
  if (typeof arr.length !== 'number' || arr.length < 3) {
    return null;
  }
  const x = Number(arr[0]);
  const y = Number(arr[1]);
  const z = Number(arr[2]);
  if (![x, y, z].every((n) => Number.isFinite(n))) {
    return null;
  }
  return [x, y, z];
};

/**
 * Plain-object copy of settings safe for the WASM worker.
 * @param settings - Host MeshSettings / FastNavSettings (may include undefined keys)
 * @returns Sanitized plain object (never mutates input)
 */
export const sanitizeMeshSettingsForWasm = <T extends object>(settings: T): T => {
  const out = { ...(settings as Record<string, unknown>) } as Record<string, unknown>;

  for (const key of VEC3_KEYS) {
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

  const hasMinKey = REGION_MIN in out && isPresent(out[REGION_MIN]);
  const hasMaxKey = REGION_MAX in out && isPresent(out[REGION_MAX]);
  if (!hasMinKey && !hasMaxKey) {
    delete out[REGION_MIN];
    delete out[REGION_MAX];
    return out as T;
  }

  const min = hasMinKey ? asPlainVec3(out[REGION_MIN]) : null;
  const max = hasMaxKey ? asPlainVec3(out[REGION_MAX]) : null;
  if (!min || !max) {
    delete out[REGION_MIN];
    delete out[REGION_MAX];
    return out as T;
  }

  out[REGION_MIN] = min;
  out[REGION_MAX] = max;
  return out as T;
};
