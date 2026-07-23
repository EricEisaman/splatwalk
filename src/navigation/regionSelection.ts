/**
 * Selection-region boxes must be editable volumes, not floor-band planes.
 * WASM `suggestRegion` often returns a thin Y slab around the floor; expand it
 * upward so gizmos can change height.
 */

/** Minimum horizontal footprint (meters) for a selection region axis. */
export const MIN_REGION_FOOTPRINT_METERS = 0.5;

/** Minimum vertical extent (meters) — person-scale volume, not a plane. */
export const MIN_REGION_HEIGHT_METERS = 2.0;

/** Extra height above floor for voxel-collision regions (stairs / upper landing). */
export const REGION_STAIR_HEADROOM_METERS = 4.0;

/** Drop below suggested floor so treads / basement lip stay inside the box. */
export const REGION_STAIR_FOOTROOM_METERS = 1.0;

export interface RegionAabb {
  readonly min: readonly [number, number, number] | readonly number[];
  readonly max: readonly [number, number, number] | readonly number[];
}

export interface MutableRegionAabb {
  min: number[];
  max: number[];
}

/**
 * Expand a region AABB so X/Z meet a footprint floor and Y has usable height
 * (grown upward from the floor / min Y).
 */
export const ensureRegionSelectionVolume = (region: RegionAabb): MutableRegionAabb => {
  const min = [region.min[0], region.min[1], region.min[2]];
  const max = [region.max[0], region.max[1], region.max[2]];

  const sizeX = Math.max(max[0] - min[0], MIN_REGION_FOOTPRINT_METERS);
  const sizeZ = Math.max(max[2] - min[2], MIN_REGION_FOOTPRINT_METERS);
  let sizeY = max[1] - min[1];

  const centerX = (min[0] + max[0]) * 0.5;
  const centerZ = (min[2] + max[2]) * 0.5;
  const halfX = sizeX * 0.5;
  const halfZ = sizeZ * 0.5;

  min[0] = centerX - halfX;
  max[0] = centerX + halfX;
  min[2] = centerZ - halfZ;
  max[2] = centerZ + halfZ;

  if (!(sizeY >= MIN_REGION_HEIGHT_METERS)) {
    // Keep the floor (min Y); grow the ceiling so the box is a volume.
    max[1] = min[1] + MIN_REGION_HEIGHT_METERS;
    sizeY = MIN_REGION_HEIGHT_METERS;
  }

  return { min, max };
};

/** Axis-aligned size of a region after {@link ensureRegionSelectionVolume}. */
export const regionSelectionSize = (
  region: MutableRegionAabb
): { x: number; y: number; z: number } => ({
  x: region.max[0] - region.min[0],
  y: region.max[1] - region.min[1],
  z: region.max[2] - region.min[2],
});

/**
 * Expand a selection region vertically so voxel carve can reach stair runs and
 * landings (suggestRegion often returns a thin floor slab).
 */
export const expandRegionForVoxelStairs = (
  region: RegionAabb,
  carveHeight = 1.6
): MutableRegionAabb => {
  const base = ensureRegionSelectionVolume(region);
  const floorY = base.min[1]!;
  base.min[1] = floorY - REGION_STAIR_FOOTROOM_METERS;
  const minCeiling = floorY + carveHeight + REGION_STAIR_HEADROOM_METERS;
  base.max[1] = Math.max(base.max[1]!, minCeiling);
  return base;
};
