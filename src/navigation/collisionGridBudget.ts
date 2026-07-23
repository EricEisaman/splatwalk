/**
 * Dense collision grid budget preflight — mirrors WASM coarsen loop in mesh.rs
 * (pad → dims → cap; coarsen to max 0.5 m; else region_too_large).
 */

/** WASM stops coarsening at this voxel size (meters). */
export const COLLISION_MAX_VOXEL_SIZE_METERS = 0.5;

/** Default cap when settings omit collision_max_voxels. */
export const DEFAULT_COLLISION_MAX_VOXELS = 1_500_000;

/** Max X/Z footprint for auto-pin / budget clamp (meters). */
export const MAX_AUTO_REGION_FOOTPRINT_METERS = 20;

/** Secondary shrink if 20 m still fails the dense budget. */
export const FALLBACK_AUTO_REGION_FOOTPRINT_METERS = 12;

export interface MutableRegionAabb {
  max: number[];
  min: number[];
}

export interface ClampRegionFootprintResult extends MutableRegionAabb {
  readonly clamped: boolean;
  readonly footprintMeters: number;
}

export interface OrientedAabb {
  readonly max: readonly [number, number, number] | readonly number[];
  readonly min: readonly [number, number, number] | readonly number[];
}

export interface CollisionGridBudgetInput {
  readonly bounds: OrientedAabb;
  readonly fillSize?: number;
  readonly maxVoxels?: number;
  /** Evaluate at this voxel size (default: max coarseness 0.5 m). */
  readonly voxelSize?: number;
  readonly sceneType?: string;
}

export interface CollisionGridBudgetResult {
  readonly dims: readonly [number, number, number];
  readonly estimatedVoxels: number;
  readonly fits: boolean;
  readonly footprintMeters: number;
  readonly maxVoxels: number;
  readonly padMeters: number;
  readonly voxelSize: number;
}

/**
 * Indoor/outdoor pad matching WASM `build_collision_mesh` before voxelize.
 */
export const collisionGridPadMeters = ({
  fillSize = 1.6,
  sceneType = 'indoor',
  voxelSize,
}: {
  readonly fillSize?: number;
  readonly sceneType?: string;
  readonly voxelSize: number;
}): number => {
  if (sceneType === 'indoor' || sceneType === 'outdoor') {
    const cells = Math.max(1, Math.ceil(fillSize / voxelSize));
    return cells * voxelSize + voxelSize;
  }
  return Math.max(fillSize, 0.3);
};

/** Axis-aligned footprint (max of X/Z extent) for logging. */
export const aabbFootprintMeters = (bounds: OrientedAabb): number => {
  const dx = bounds.max[0]! - bounds.min[0]!;
  const dz = bounds.max[2]! - bounds.min[2]!;
  return Math.max(dx, dz);
};

/**
 * Estimate padded grid voxel count at a given voxel size (no coarsen loop).
 */
export const estimateCollisionGridVoxels = (
  input: CollisionGridBudgetInput
): CollisionGridBudgetResult => {
  const voxelSize = Math.min(
    COLLISION_MAX_VOXEL_SIZE_METERS,
    Math.max(0.025, input.voxelSize ?? COLLISION_MAX_VOXEL_SIZE_METERS)
  );
  const maxVoxels = input.maxVoxels ?? DEFAULT_COLLISION_MAX_VOXELS;
  const fillSize = input.fillSize ?? 1.6;
  const sceneType = input.sceneType ?? 'indoor';
  const pad = collisionGridPadMeters({ fillSize, sceneType, voxelSize });

  const extentX = input.bounds.max[0]! - input.bounds.min[0]! + 2 * pad;
  const extentY = input.bounds.max[1]! - input.bounds.min[1]! + 2 * pad;
  const extentZ = input.bounds.max[2]! - input.bounds.min[2]! + 2 * pad;
  // Match WASM: (extent / voxel_size).ceil().max(1) as usize + 1
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil(extentX / voxelSize)) + 1,
    Math.max(1, Math.ceil(extentY / voxelSize)) + 1,
    Math.max(1, Math.ceil(extentZ / voxelSize)) + 1,
  ];

  const estimatedVoxels = dims[0] * dims[1] * dims[2];
  return {
    dims,
    estimatedVoxels,
    fits: estimatedVoxels <= maxVoxels,
    footprintMeters: aabbFootprintMeters(input.bounds),
    maxVoxels,
    padMeters: pad,
    voxelSize,
  };
};

/**
 * True when the AABB can fit under max_voxels even at max coarseness (0.5 m).
 * If false, WASM will return region_too_large.
 */
export const fitsDenseVoxelBudgetAtMaxCoarseness = (
  input: Omit<CollisionGridBudgetInput, 'voxelSize'>
): CollisionGridBudgetResult =>
  estimateCollisionGridVoxels({
    ...input,
    voxelSize: COLLISION_MAX_VOXEL_SIZE_METERS,
  });

/**
 * Clamp X/Z extent about the region center; preserve Y (stair headroom).
 */
export const clampRegionFootprint = (
  region: OrientedAabb,
  maxFootprintMeters: number = MAX_AUTO_REGION_FOOTPRINT_METERS
): ClampRegionFootprintResult => {
  const minX0 = region.min[0]!;
  const maxX0 = region.max[0]!;
  const minY = region.min[1]!;
  const maxY = region.max[1]!;
  const minZ0 = region.min[2]!;
  const maxZ0 = region.max[2]!;
  const sizeX = maxX0 - minX0;
  const sizeZ = maxZ0 - minZ0;
  const cx = (minX0 + maxX0) * 0.5;
  const cz = (minZ0 + maxZ0) * 0.5;
  const half = maxFootprintMeters * 0.5;
  let clamped = false;
  let minX = minX0;
  let maxX = maxX0;
  let minZ = minZ0;
  let maxZ = maxZ0;
  if (sizeX > maxFootprintMeters) {
    minX = cx - half;
    maxX = cx + half;
    clamped = true;
  }
  if (sizeZ > maxFootprintMeters) {
    minZ = cz - half;
    maxZ = cz + half;
    clamped = true;
  }
  const min = [minX, minY, minZ];
  const max = [maxX, maxY, maxZ];
  return {
    clamped,
    footprintMeters: aabbFootprintMeters({ min, max }),
    max,
    min,
  };
};

/** Budget check for a selection / WASM region AABB. */
export const regionFitsDenseBudget = ({
  fillSize,
  maxVoxels,
  region,
  sceneType,
}: {
  readonly fillSize?: number;
  readonly maxVoxels?: number;
  readonly region: OrientedAabb;
  readonly sceneType?: string;
}): CollisionGridBudgetResult =>
  fitsDenseVoxelBudgetAtMaxCoarseness({
    bounds: region,
    fillSize,
    maxVoxels,
    sceneType,
  });

/**
 * Clamp to maxFootprint, then if still over budget clamp to fallback footprint.
 */
export const clampRegionToDenseBudget = ({
  fillSize,
  fallbackFootprintMeters = FALLBACK_AUTO_REGION_FOOTPRINT_METERS,
  maxFootprintMeters = MAX_AUTO_REGION_FOOTPRINT_METERS,
  maxVoxels = DEFAULT_COLLISION_MAX_VOXELS,
  region,
  sceneType,
}: {
  readonly fillSize?: number;
  readonly fallbackFootprintMeters?: number;
  readonly maxFootprintMeters?: number;
  readonly maxVoxels?: number;
  readonly region: OrientedAabb;
  readonly sceneType?: string;
}): ClampRegionFootprintResult & { readonly fits: boolean } => {
  let next = clampRegionFootprint(region, maxFootprintMeters);
  let budget = regionFitsDenseBudget({
    fillSize,
    maxVoxels,
    region: next,
    sceneType,
  });
  if (budget.fits) {
    return { ...next, fits: true };
  }
  next = clampRegionFootprint(next, fallbackFootprintMeters);
  budget = regionFitsDenseBudget({
    fillSize,
    maxVoxels,
    region: next,
    sceneType,
  });
  return { ...next, fits: budget.fits };
};
