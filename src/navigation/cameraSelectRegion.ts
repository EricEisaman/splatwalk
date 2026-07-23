/**
 * Build an axis-aligned select region (AABB) from a camera pose / view.
 *
 * Horizontal footprint follows camera yaw (forward / left on XZ). Vertical extent
 * is world-Y relative to the camera (default 5 m below, 15 m above). The oriented
 * box corners are converted to a world AABB for Viewer `enableRegionSelection` /
 * WASM `region_min`·`region_max` (no oriented-box wire format; `api_version` stays 2).
 *
 * Babylon FreeCamera convention (left-handed): at `yawRadians === 0` the camera
 * looks along **+Z**. Forward / right on XZ:
 * `forward = (sin(yaw), 0, cos(yaw))`, `right = (cos(yaw), 0, -sin(yaw))`.
 */

const DEG_TO_RAD = Math.PI / 180;

export interface CameraSelectRegionPose {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** Yaw about world +Y, radians (Babylon FreeCamera `rotation.y`). */
  readonly yawRadians: number;
}

/** Full FreeCamera-style view (degrees) for apply + region derivation. */
export interface CameraSelectView {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly eulerDegrees: { readonly x: number; readonly y: number; readonly z: number };
}

export interface CameraSelectRegionOffsets {
  /** Meters to the camera left (−right). Default 10. */
  readonly left: number;
  /** Meters to the camera right. Default 10. */
  readonly right: number;
  /** Meters in front of the camera. Default 15. */
  readonly forward: number;
  /** Meters behind the camera. Default 5. */
  readonly behind: number;
  /** Meters below the camera (world −Y). Default 5. */
  readonly below: number;
  /** Meters above the camera (world +Y). Default 15. */
  readonly above: number;
}

/** Camera view + optional AABB offsets for Fast Nav / region selection. */
export interface CameraSelectRegionInput {
  readonly view: CameraSelectView;
  readonly offsets?: Partial<CameraSelectRegionOffsets>;
}

export const DEFAULT_CAMERA_SELECT_REGION_OFFSETS: CameraSelectRegionOffsets = {
  left: 10,
  right: 10,
  forward: 15,
  behind: 5,
  below: 5,
  above: 15,
};

export interface RegionBoundsAabb {
  readonly min: number[];
  readonly max: number[];
}

/** Yaw-only pose from a full camera view (degrees → radians on Y). */
export const poseFromCameraSelectView = (view: CameraSelectView): CameraSelectRegionPose => ({
  position: {
    x: view.position.x,
    y: view.position.y,
    z: view.position.z,
  },
  yawRadians: view.eulerDegrees.y * DEG_TO_RAD,
});

/**
 * World AABB matching Viewer region gizmos / WASM `region_min`·`region_max`.
 *
 * At yaw 0 (look +Z): X ∈ [px−left, px+right], Z ∈ [pz−behind, pz+forward],
 * Y ∈ [py−below, py+above].
 */
export const regionBoundsFromCameraPose = (params: {
  readonly pose: CameraSelectRegionPose;
  readonly offsets?: Partial<CameraSelectRegionOffsets>;
}): RegionBoundsAabb => {
  const offsets: CameraSelectRegionOffsets = {
    ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
    ...params.offsets,
  };
  const { position, yawRadians } = params.pose;
  const sinY = Math.sin(yawRadians);
  const cosY = Math.cos(yawRadians);
  const forwardX = sinY;
  const forwardZ = cosY;
  const rightX = cosY;
  const rightZ = -sinY;

  const localXs = [-offsets.left, offsets.right] as const;
  const localZs = [-offsets.behind, offsets.forward] as const;
  const localYs = [position.y - offsets.below, position.y + offsets.above] as const;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const lx of localXs) {
    for (const lz of localZs) {
      const wx = position.x + rightX * lx + forwardX * lz;
      const wz = position.z + rightZ * lx + forwardZ * lz;
      for (const wy of localYs) {
        if (wx < minX) {
          minX = wx;
        }
        if (wy < minY) {
          minY = wy;
        }
        if (wz < minZ) {
          minZ = wz;
        }
        if (wx > maxX) {
          maxX = wx;
        }
        if (wy > maxY) {
          maxY = wy;
        }
        if (wz > maxZ) {
          maxZ = wz;
        }
      }
    }
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
};

/** Derive a world AABB from a camera view + optional offsets. */
export const regionBoundsFromCameraSelect = (
  input: CameraSelectRegionInput
): RegionBoundsAabb =>
  regionBoundsFromCameraPose({
    pose: poseFromCameraSelectView(input.view),
    offsets: input.offsets,
  });
