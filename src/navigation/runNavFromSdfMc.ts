/**
 * SDF Marching Cubes nav: WASM `collision_mesh_mode: "smooth"` → Recast (and optional voxel walk).
 * All SDF/MC computation stays in the WASM core; this file only orchestrates.
 */

import {
  runNavFromVoxelCollider,
  type RunNavFromVoxelColliderOptions,
  type VoxelNavResult,
} from '@/navigation/runNavFromVoxelCollider';
import type { CollisionVoxelBoundarySettings } from '@/wasm/bridge';

export interface RunNavFromSdfMcOptions extends Omit<
  RunNavFromVoxelColliderOptions,
  'recastGeometrySource' | 'recastSourceLabel'
> {
  /** SDF truncation half-width in voxels (default 3). */
  readonly sdfBandVoxels?: number;
  /** Marching Cubes iso level (default 0). */
  readonly mcIsoLevel?: number;
  /** Laplacian smooth iterations in WASM after MC (default 1). */
  readonly mcSmoothIterations?: number;
}

/**
 * Run nav from WASM SDF + Marching Cubes: projected floor → Recast; MC shell overlay.
 * Forces `collision_mesh_mode: "smooth"`.
 */
export async function runNavFromSdfMc(options: RunNavFromSdfMcOptions): Promise<VoxelNavResult> {
  const collisionSettings: CollisionVoxelBoundarySettings = {
    ...options.collisionSettings,
    collision_mesh_mode: 'smooth',
    sdf_band_voxels: options.sdfBandVoxels ?? options.collisionSettings.sdf_band_voxels ?? 3,
    mc_iso_level: options.mcIsoLevel ?? options.collisionSettings.mc_iso_level ?? 0,
    mc_smooth_iterations:
      options.mcSmoothIterations ?? options.collisionSettings.mc_smooth_iterations ?? 1,
  };

  options.onLog?.(
    '[INFO] SDF Marching Cubes path: WASM floor project → Recast (MC shell overlay)' +
      ` (scene=${collisionSettings.collision_scene_type ?? 'indoor'}` +
      `, band=${collisionSettings.sdf_band_voxels}, iso=${collisionSettings.mc_iso_level},` +
      ` smooth=${collisionSettings.mc_smooth_iterations}).`
  );

  return runNavFromVoxelCollider({
    ...options,
    collisionSettings,
    recastGeometrySource: 'collision_mesh',
    recastSourceLabel: 'generated_sdf_mc_floor_project',
  });
}

export type { VoxelNavResult };
