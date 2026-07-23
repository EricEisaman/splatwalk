import {
  splatwalk,
  type CollisionVoxelBoundaryResult,
  type CollisionVoxelBoundarySettings,
  type MeshSettings,
  type ReconstructionDiagnostics,
} from '@/wasm/bridge';

const DEFAULT_CARVE_HEIGHT = 1.6;
/** splat-transform `--voxel-carve` default radius (metres). */
const DEFAULT_CARVE_RADIUS = 0.2;
/** splat-transform `--voxel-external-fill` / `--voxel-floor-fill` default (metres). */
const DEFAULT_COLLISION_FILL_SIZE = 1.6;
const DEFAULT_COLLISION_OPACITY_THRESHOLD = 0.1;
const DEFAULT_COLLISION_VOXEL_SIZE = 0.05;
const DEFAULT_MAX_SCALE = 5.0;
const DEFAULT_MIN_ALPHA = 0.05;
const DEFAULT_PRUNE_FLOATERS_K = 16;
const DEFAULT_PRUNE_FLOATERS_STD_RATIO = 2.0;
const DEFAULT_ROTATION: [number, number, number] = [0, 0, 0];
const DEFAULT_SEED: [number, number, number] = [0, 1, 0];

export interface CollisionBoundaryArtifact {
  readonly result: CollisionVoxelBoundaryResult;
  readonly settings: CollisionVoxelBoundarySettings;
}

export interface CollisionBoundaryDefaultsOptions {
  readonly base?: Partial<CollisionVoxelBoundarySettings>;
  readonly emitGlb?: boolean;
  /** Pack solid + nav_region for voxel walk (default true for nav path). */
  readonly emitVolume?: boolean;
  readonly flipY?: boolean;
  readonly rotation?: readonly number[];
  readonly seed?: readonly number[] | null;
}

export interface CollisionBoundaryGenerationOptions {
  readonly bytes: Uint8Array;
  readonly settings: CollisionVoxelBoundarySettings;
}

export interface CollisionBoundarySeedOptions {
  readonly carveHeight?: number;
  readonly fallback?: readonly number[];
  readonly regionBounds?: CollisionRegionBounds | null;
}

export interface CollisionRegionBounds {
  readonly max: readonly number[];
  readonly min: readonly number[];
}

export const buildCollisionBoundarySettings = ({
  base = {},
  emitGlb = false,
  emitVolume = true,
  flipY = false,
  rotation = DEFAULT_ROTATION,
  seed = DEFAULT_SEED,
}: CollisionBoundaryDefaultsOptions = {}): CollisionVoxelBoundarySettings => ({
  mode: 2,
  voxel_target: 4000,
  sdf_cell_size: 0.15,
  sdf_vertical_cell_size: 0.05,
  sdf_density_threshold: 0.08,
  sdf_max_layers: 2,
  sdf_smoothing_radius: 1,
  sdf_influence_radius_scale: 2.5,
  collision_voxel_size: DEFAULT_COLLISION_VOXEL_SIZE,
  collision_opacity_threshold: DEFAULT_COLLISION_OPACITY_THRESHOLD,
  collision_scene_type: 'indoor',
  collision_seed: seed ? [...seed] : undefined,
  collision_fill_size: DEFAULT_COLLISION_FILL_SIZE,
  collision_carve_height: DEFAULT_CARVE_HEIGHT,
  collision_carve_radius: DEFAULT_CARVE_RADIUS,
  collision_mesh_mode: 'walkable_floors',
  min_alpha: DEFAULT_MIN_ALPHA,
  max_scale: DEFAULT_MAX_SCALE,
  prune_floaters: true,
  prune_floaters_k: DEFAULT_PRUNE_FLOATERS_K,
  prune_floaters_std_ratio: DEFAULT_PRUNE_FLOATERS_STD_RATIO,
  normal_align: 0.3,
  ransac_thresh: 0.16,
  floor_projection_epsilon: 0.16,
  height_projection_epsilon: 0.16,
  obstacle_height_epsilon: 0.24,
  max_local_height_variance: 0.08,
  min_floor_confidence: 0.01,
  hole_fill_radius: 1,
  agent_radius_erode: 0,
  component_mode: 'largest',
  rotation: [...rotation],
  flip_y: flipY,
  ...base,
  emit_glb: emitGlb,
  emit_volume: emitVolume,
});

export const collisionBoundaryDiagnosticsSummary = (diagnostics: ReconstructionDiagnostics): string =>
  `grid=${diagnostics.collision_grid_width}x${diagnostics.collision_grid_height}x${diagnostics.collision_grid_depth}, ` +
  `voxel=${diagnostics.collision_voxel_size.toFixed(3)}, occupied=${diagnostics.collision_occupied_voxels}, ` +
  `filled=${diagnostics.collision_filled_voxels}, carved=${diagnostics.collision_carved_voxels}, ` +
  `faces=${diagnostics.collision_surface_faces}`;

export const downloadBytes = ({ bytes, filename, type }: { bytes: Uint8Array; filename: string; type: string }): void => {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const exportCollisionBoundaryGlb = async ({
  artifact,
  filename,
}: {
  artifact: CollisionBoundaryArtifact;
  filename: string;
}): Promise<Uint8Array> => {
  const glb =
    artifact.result.glb && artifact.result.glb.byteLength > 0
      ? artifact.result.glb
      : await splatwalk.meshToGlb(
          new Float32Array(artifact.result.mesh.vertices),
          new Uint32Array(artifact.result.mesh.indices)
        );
  downloadBytes({ bytes: glb, filename, type: 'model/gltf-binary' });
  return glb;
};

export const exportNavmeshBinary = ({
  filename,
  navMeshData,
}: {
  filename: string;
  navMeshData: Uint8Array;
}): void => {
  downloadBytes({ bytes: navMeshData, filename, type: 'application/octet-stream' });
};

export const generateCollisionBoundary = async ({
  bytes,
  settings,
}: CollisionBoundaryGenerationOptions): Promise<CollisionBoundaryArtifact> => {
  const result = await splatwalk.buildCollisionVoxelBoundary(bytes, settings);
  return { result, settings };
};

export const seedFromRegionBounds = ({
  carveHeight = DEFAULT_CARVE_HEIGHT,
  fallback = DEFAULT_SEED,
  regionBounds,
}: CollisionBoundarySeedOptions): number[] => {
  if (!regionBounds) {
    return [...fallback];
  }

  return [
    (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
    regionBounds.min[1] + carveHeight * 0.5,
    (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
  ];
};

export const toCollisionBoundarySettings = (settings: MeshSettings): CollisionVoxelBoundarySettings => ({
  ...settings,
  collision_mesh_mode: settings.collision_mesh_mode ?? 'faces',
  emit_glb: true,
  mode: 2,
});
