/**
 * Voxel collision nav settings (fill/carve collision pipeline).
 */

import type { CollisionVoxelBoundarySettings, FastNavAlgo } from '@/wasm/bridge';

/**
 * How walkable nav geometry is generated from the splat.
 * Alias of WASM/host {@link FastNavAlgo} so Storage Adapter and FastNav demos share one enum.
 */
export type NavGenerationMode = FastNavAlgo;

/** Locomotion backend after voxel collision is built. */
export type VoxelLocomotionMode = 'recast_crowd' | 'voxel_walk';

export type CollisionSceneType = 'indoor' | 'outdoor' | 'object';

/** User-tunable voxel collision overrides for {@link runNavFromVoxelCollider}. */
export interface VoxelCollisionNavSettings {
  /** Capsule carve height (m) — agent standing height. */
  collisionCarveHeight: number;
  /** Capsule carve radius (m). */
  collisionCarveRadius: number;
  /** External / floor fill size (m). */
  collisionFillSize: number;
  /** Collision mesh emission mode for Recast / overlays. */
  collisionMeshMode: 'faces' | 'obstacle_shell' | 'walkable_floors' | 'smooth';
  /** Minimum splat opacity to mark a voxel solid. */
  collisionOpacityThreshold: number;
  /** Indoor fill/seal vs outdoor floor fill. */
  collisionSceneType: CollisionSceneType;
  /** Voxel edge length (m); typical indoor default 0.05 m. */
  collisionVoxelSize: number;
  /**
   * `voxel_walk` — XZ steer + ground probe on exported carve volume (default).
   * `recast_crowd` — Recast navmesh + crowd baked from voxel floor spans.
   */
  locomotionMode: VoxelLocomotionMode;
  /** SDF truncation half-width (voxels) for `sdf_marching_cubes` / `smooth`. */
  sdfBandVoxels: number;
  /** Marching Cubes iso level for `smooth`. */
  mcIsoLevel: number;
  /** Laplacian iterations after Marching Cubes in WASM. */
  mcSmoothIterations: number;
}

/**
 * Defaults aligned with typical collision export: voxel 0.05 m, opacity 0.1,
 * external fill 1.6 m, carve capsule 1.6 m × 0.2 m. Default locomotion is voxel walk
 * (stairs via ground probes on the carved volume).
 */
export const DEFAULT_VOXEL_NAV_SETTINGS: VoxelCollisionNavSettings = {
  collisionCarveHeight: 1.6,
  collisionCarveRadius: 0.2,
  collisionFillSize: 1.6,
  collisionMeshMode: 'walkable_floors',
  collisionOpacityThreshold: 0.1,
  collisionSceneType: 'indoor',
  collisionVoxelSize: 0.05,
  locomotionMode: 'voxel_walk',
  sdfBandVoxels: 3,
  mcIsoLevel: 0,
  mcSmoothIterations: 1,
};

/** Map UI voxel settings into {@link buildCollisionBoundarySettings} `base` overrides. */
export const voxelNavSettingsToCollisionBase = (
  settings: VoxelCollisionNavSettings
): Partial<CollisionVoxelBoundarySettings> => ({
  collision_carve_height: settings.collisionCarveHeight,
  collision_carve_radius: settings.collisionCarveRadius,
  collision_fill_size: settings.collisionFillSize,
  collision_mesh_mode: settings.collisionMeshMode,
  collision_opacity_threshold: settings.collisionOpacityThreshold,
  collision_scene_type: settings.collisionSceneType,
  collision_voxel_size: settings.collisionVoxelSize,
  sdf_band_voxels: settings.sdfBandVoxels,
  mc_iso_level: settings.mcIsoLevel,
  mc_smooth_iterations: settings.mcSmoothIterations,
});
