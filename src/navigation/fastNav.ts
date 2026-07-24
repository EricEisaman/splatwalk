import type { Vector3 } from '@babylonjs/core';

import NavWorker from '@/navigation/navmesh.worker?worker';
import type { Viewer } from '@/scene/Viewer';
import {
  buildFastNavCacheSignature,
  FAST_NAV_FLOOR_PIPELINE,
} from '@/navigation/fastNavCacheSignature';
import { buildNavmeshKey, getNavmesh, putNavmesh } from '@/navigation/navmeshCache';
import {
  splatwalk,
  type FastNavAlgo,
  type MeshSettings,
} from '@/wasm/bridge';
import { normalizeSplatToPly } from '@/wasm/normalize';
import {
  DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  clampPointToAabb,
  groundAnchoredCameraRegion,
  regionBoundsFromCameraPose,
  regionBoundsFromCameraSelect,
  type CameraSelectRegionInput,
} from '@/navigation/cameraSelectRegion';
import { ensureSdfMcRegionForDenseBudget } from '@/navigation/collisionGridBudget';
import {
  extractFloorFieldWithRecovery,
  resolveRecovery,
  type DenseSeedOptions,
  type FastFloorMeshOptions,
  type FastNavLogger,
  type FastNavRecoveryConfig,
  type StrayTrimOptions,
} from '@/navigation/floor';
import type { CollisionVoxelBoundarySettings, CollisionVoxelVolume } from '@/wasm/bridge';

// Re-export the framework-agnostic floor logic so existing imports from this
// module (and the published `src/index.ts` surface) keep working unchanged. The
// pure floor math now lives in `@/navigation/floor` so binary-only / non-Babylon
// integrators can consume it without a 3D engine.
export * from '@/navigation/floor';

/** FastNav compute algorithms (matches WASM `fast_nav` `algo`). */
export type { FastNavAlgo };

/**
 * Coarse phases of {@link runFastNav}, emitted via {@link FastNavOptions.onPhase}
 * so UIs can show a step indicator. `prune` covers the WASM ingest (parse +
 * statistical outlier removal) that runs on first touch of the splat bytes.
 */
export type FastNavPhase = 'prune' | 'floor' | 'navmesh' | 'done';

/** Callback for {@link runFastNav} phase transitions. */
export type FastNavPhaseListener = (phase: FastNavPhase) => void;

/** Options for {@link runFastNav}. */
export interface FastNavOptions {
  /** The Babylon viewer that already has the splat loaded. */
  readonly viewer: Viewer;
  /** Raw, already-decompressed splat bytes (see {@link readSplatBytes}). */
  readonly bytes: Uint8Array;
  /**
   * WASM FastNav algorithm (default `floor_field`). Voxel/SDF paths call the same
   * star export via the collision host orchestrators.
   */
  readonly algo?: FastNavAlgo;
  /** When true (voxel/SDF), request packed volume bitmasks from WASM. Default true for those algos. */
  readonly emitVolume?: boolean;
  /** When true, request GLB bytes from WASM `fast_nav`. Default false. */
  readonly emitGlb?: boolean;
  /**
   * Collision MeshSettings overrides when `algo` is `voxel_collision` or
   * `sdf_marching_cubes`. Ignored for `floor_field`.
   */
  readonly collisionSettings?: CollisionVoxelBoundarySettings;
  /** Optional progress sink; defaults to the console. */
  readonly onLog?: FastNavLogger;
  /** Optional phase sink for step indicators (prune -> floor -> navmesh -> done). */
  readonly onPhase?: FastNavPhaseListener;
  /**
   * Optional override for the adaptive floor-field recovery ladder. When omitted,
   * {@link DEFAULT_FAST_NAV_RECOVERY} is used so recovery is always on by default.
   */
  readonly recovery?: Partial<FastNavRecoveryConfig>;
  /**
   * Optional override for stray-floater trimming applied to the detected floor
   * (see {@link trimStrayFloorCells}). On by default; pass `{ enabled: false }` to disable.
   */
  readonly strayTrim?: StrayTrimOptions;
  /**
   * Optional override for density-aware re-seeding (see {@link estimateDenseFloorSeed}).
   * On by default; anchors the seed on the dense floor instead of a floater plane.
   */
  readonly denseSeed?: DenseSeedOptions;
  /**
   * Optional override for WASM-side statistical outlier removal ("prune floaters").
   * On by default; stray sparse splats are removed before any geometry/region/seed
   * computation. Pass `{ enabled: false }` to keep every splat.
   */
  readonly prune?: PruneFloatersOptions;
  /**
   * Optional Recast attempt ladder. Defaults to {@link FAST_NAV_RECAST_ATTEMPTS}.
   * Streamed / outdoor demos can pass {@link STREAMED_FAST_NAV_RECAST_ATTEMPTS}.
   */
  readonly recastAttempts?: ReadonlyArray<{ label: string; params: RecastParams }>;
  /**
   * Merged into every Recast attempt (after the ladder entry). Use for UI knobs
   * like slope / agent radius without replacing the whole recovery ladder.
   */
  readonly recastOverrides?: Partial<RecastParams>;
  /**
   * Merged into the base fast-field {@link MeshSettings} before recovery steps.
   */
  readonly meshSettings?: Partial<MeshSettings>;
  /**
   * Same-level / cell height-band overrides for outdoor bowls and ramps.
   */
  readonly floorMesh?: FastFloorMeshOptions;
  /**
   * Island safety checks after Recast. Outdoor / streamed scenes often need a
   * larger {@link maxSeedDistance} than the indoor 6 m default. When
   * {@link mergeNearbyIslands} is set (or implied by a large maxSeedDistance),
   * all same-level islands within that radius are kept instead of one nearest.
   */
  readonly islandValidation?: {
    readonly floorYBand?: number;
    readonly maxSeedDistance?: number;
    readonly mergeNearbyIslands?: boolean;
  };
  /**
   * Active navigation mode for voxel / SDF-MC (Recast / Voxel mesh / dual).
   * Ignored for `floor_field` (always Recast).
   */
  readonly activeNavigationMode?: import('@/navigation/activeNavigation').ActiveNavigationMode;
  /**
   * When true (Storage Adapter streamed / Church outdoor), pin a seed-centered
   * ~100 m working volume and outdoor field knobs. Default false restores HEAD
   * indoor Fast Nav (yellow box only; suggestRegion for seed) so Bedroom / PurplePad
   * need no extra intervention.
   */
  readonly seedCenteredOutdoor?: boolean;
  /**
   * Camera view + AABB offsets. Replaces any prior selection region for this run,
   * pins WASM `region_min`/`region_max` via the yellow box, and (unless
   * {@link keepCameraSelectView} is false) restores the view after nav instead of
   * top-down framing.
   */
  readonly cameraSelect?: CameraSelectRegionInput;
  /**
   * When `cameraSelect` is set, restore that view after nav (default true).
   * Callers should skip {@link Viewer.focusOnPlayer} when the result reports
   * {@link FastNavResult.keptCameraSelectView}.
   */
  readonly keepCameraSelectView?: boolean;
}

/** Override for the WASM-side floater prune (statistical outlier removal). */
export interface PruneFloatersOptions {
  /** Whether to prune stray floater splats. Defaults to `true`. */
  readonly enabled?: boolean;
  /** Neighbours sampled per splat for outlier removal. Defaults to `16`. */
  readonly k?: number;
  /** Removal strength (mean + stdRatio*stddev). Lower = more aggressive. Defaults to `2.0`. */
  readonly stdRatio?: number;
}

/** Result of a successful {@link runFastNav}. */
export interface FastNavResult {
  /** Algorithm used for this run. */
  readonly algo: FastNavAlgo;
  /** Recast debug overlay indices (oriented space) for NavKit walkable_floors.glb. */
  readonly debugIndices: Uint32Array;
  /** Recast debug overlay positions (oriented space) for NavKit walkable_floors.glb. */
  readonly debugPositions: Float32Array;
  /** The serialized Recast navmesh binary. */
  readonly navMeshData: Uint8Array;
  /** The chosen player spawn point on the navmesh, if any. */
  readonly playerSpawn: Vector3 | null;
  /**
   * True when {@link FastNavOptions.cameraSelect} restored the camera view;
   * callers should not call {@link Viewer.focusOnPlayer}.
   */
  readonly keptCameraSelectView: boolean;
  /** Dense voxel volume when a collision algo requested `emit_volume`. */
  readonly volume?: CollisionVoxelVolume;
}

interface NavReport {
  readonly isOverride?: boolean;
  readonly activeCS?: number;
  readonly wasFlipped?: boolean;
  readonly headroomPadding?: number;
  readonly avgUpDot?: number;
  readonly gridDim?: readonly [number, number, number];
  readonly sourceLabel?: string;
}

interface NavWorkerResult {
  readonly navMeshData: Uint8Array;
  readonly debugPositions: Float32Array;
  readonly debugIndices: Uint32Array;
  readonly report: NavReport;
}

export interface RecastParams {
  cs: number;
  ch: number;
  walkableHeight: number;
  walkableRadius: number;
  walkableClimb: number;
  walkableSlopeAngle: number;
  maxEdgeLen: number;
  maxSimplificationError: number;
  minRegionArea: number;
  mergeRegionArea: number;
  maxVertsPerPoly: number;
  detailSampleDist: number;
  detailSampleMaxError: number;
  /**
   * When true (the default), the Recast worker auto-sizes `cs` from the mesh
   * extent + agent radius (Recast guideline `cs in [radius/3, radius/2]`) and the
   * `maxNavCells` budget, instead of using the literal `cs` above. Set false to
   * force the literal `cs`.
   */
  autoCellSize?: boolean;
  /** Ceiling on total navmesh voxel columns when `autoCellSize` is on. */
  maxNavCells?: number;
}

/**
 * Single source of truth for the FAST NAV Recast parameters and the adaptive
 * relaxation ladder (strict -> balanced -> recovery). Both the library entry
 * point ({@link runFastNav}) and the workbench page consume this so the fast-nav
 * navmesh behaviour is defined in exactly one place.
 */
export const FAST_NAV_BASE_PARAMS: RecastParams = {
  // `cs` here is only a fallback: with `autoCellSize` on (default), the worker
  // derives cs from the mesh extent + agent radius (cs in [radius/3, radius/2])
  // bounded by `maxNavCells`, so a large warehouse is covered completely instead
  // of being limited by a fixed cell size.
  cs: 0.2,
  ch: 0.1,
  walkableHeight: 1.7,
  // Agent bounding-cylinder radius, in metres. 0.5m is the Recast/Unity gaming
  // standard; cell size is auto-derived from it (cs in [radius/3, radius/2]).
  walkableRadius: 0.5,
  autoCellSize: true,
  maxNavCells: 1_000_000,
  // Max climbable step, in metres. Must MATCH the floor field's same-level band
  // (~0.5m): the field accepts cells within that band into one continuous region
  // and median-levels them, so any smaller value lets Recast re-sever a floor the
  // field already treats as continuous wherever capture noise leaves a crease
  // between two scan patches - that is the navmesh "break" on a wide, flat passage.
  // 0.5m is also within the Unity (0.4m) / Recast-demo (0.9m) step-height standard.
  walkableClimb: 0.5,
  walkableSlopeAngle: 40,
  maxEdgeLen: 12,
  maxSimplificationError: 0.5,
  minRegionArea: 24,
  mergeRegionArea: 36,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

export const FAST_NAV_RECAST_ATTEMPTS: ReadonlyArray<{ label: string; params: RecastParams }> = [
  { label: 'strict', params: FAST_NAV_BASE_PARAMS },
  {
    label: 'balanced',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      cs: 0.15,
      ch: 0.12,
      walkableHeight: 1.4,
      walkableSlopeAngle: 42,
      maxSimplificationError: 0.8,
      minRegionArea: 8,
      mergeRegionArea: 16,
    },
  },
  {
    label: 'recovery',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      cs: 0.18,
      ch: 0.14,
      walkableHeight: 1.2,
      walkableSlopeAngle: 48,
      maxSimplificationError: 1.0,
      minRegionArea: 2,
      mergeRegionArea: 8,
    },
  },
];

/**
 * Recast ladder for voxel collision meshes: smaller agent radius and floor-sheet-friendly
 * params so tiny pinned-region colliders are not eroded away entirely.
 */
export const VOXEL_COLLIDER_RECAST_ATTEMPTS: ReadonlyArray<{
  label: string;
  params: RecastParams;
}> = [
  {
    label: 'voxel-collider',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      autoCellSize: false,
      cs: 0.1,
      ch: 0.08,
      walkableHeight: 1.4,
      walkableRadius: 0.08,
      walkableClimb: 0.75,
      walkableSlopeAngle: 50,
      minRegionArea: 2,
      mergeRegionArea: 8,
    },
  },
  {
    label: 'voxel-collider-small',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      autoCellSize: false,
      cs: 0.08,
      ch: 0.06,
      walkableHeight: 1.2,
      walkableRadius: 0.1,
      walkableClimb: 0.6,
      walkableSlopeAngle: 55,
      minRegionArea: 0,
      mergeRegionArea: 1,
    },
  },
  {
    label: 'voxel-collider-tiny',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      autoCellSize: false,
      cs: 0.05,
      ch: 0.05,
      walkableHeight: 1.0,
      walkableRadius: 0.06,
      walkableClimb: 0.65,
      walkableSlopeAngle: 60,
      minRegionArea: 0,
      mergeRegionArea: 0,
    },
  },
];

/**
 * Outdoor / streamed SOG Recast ladder: smaller agent radius (less erosion on
 * sparse floors), steeper slopes (ramps), and tinier region floors.
 */
export const STREAMED_FAST_NAV_RECAST_ATTEMPTS: ReadonlyArray<{
  label: string;
  params: RecastParams;
}> = [
  ...FAST_NAV_RECAST_ATTEMPTS,
  {
    label: 'streamed-outdoor',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      cs: 0.22,
      ch: 0.15,
      walkableHeight: 1.2,
      walkableRadius: 0.3,
      walkableClimb: 0.6,
      walkableSlopeAngle: 55,
      maxSimplificationError: 1.2,
      minRegionArea: 1,
      mergeRegionArea: 4,
    },
  },
  {
    label: 'streamed-last-resort',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      autoCellSize: false,
      cs: 0.28,
      ch: 0.16,
      walkableHeight: 1.0,
      walkableRadius: 0.15,
      walkableClimb: 0.75,
      walkableSlopeAngle: 60,
      maxSimplificationError: 1.5,
      minRegionArea: 0,
      mergeRegionArea: 2,
    },
  },
];

export interface NavIslandMetadata {
  readonly area: number;
  readonly centroid: [number, number, number];
  readonly distanceToSeed: number;
  readonly triangleCount: number;
  readonly islandCount: number;
}

/**
 * Read splat bytes from a `.ply`, `.spz`, or `.splat` file, normalized to a
 * full-fidelity `.ply` via the WASM ingest seam so the rest of the pipeline only
 * ever deals with PLY. Requires the WASM to be initialized for non-PLY input.
 */
export async function readSplatBytes(file: File): Promise<Uint8Array> {
  return normalizeSplatToPly(file);
}

/** True when seed is missing or the placeholder origin used by mesh defaults. */
const isDefaultOriginCollisionSeed = (seed: readonly number[] | undefined): boolean => {
  if (!seed || seed.length < 3) {
    return true;
  }
  return seed[0] === 0 && seed[1] === 1 && seed[2] === 0;
};

/**
 * Conservative base reconstruction settings mirroring the defaults of the main
 * workbench UI, with the current splat orientation baked in.
 */
export function defaultFastMeshSettings(viewer: Viewer): MeshSettings {
  const rot = viewer.getSplatRotation();
  return {
    mode: 2,
    voxel_target: 4000,
    sdf_cell_size: 0.15,
    sdf_vertical_cell_size: 0.05,
    sdf_density_threshold: 0.08,
    sdf_max_layers: 2,
    sdf_smoothing_radius: 1,
    sdf_influence_radius_scale: 2.5,
    collision_voxel_size: 0.08,
    collision_opacity_threshold: 0.1,
    collision_scene_type: 'outdoor',
    collision_seed: [0, 1, 0],
    collision_fill_size: 1.2,
    collision_carve_height: 1.6,
    collision_carve_radius: 0.25,
    collision_mesh_mode: 'faces',
    min_alpha: 0.05,
    max_scale: 5.0,
    prune_floaters: true,
    prune_floaters_k: 16,
    prune_floaters_std_ratio: 2.0,
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
    rotation: [rot.x, rot.y, rot.z],
    flip_y: viewer.getWasmFlipY(),
    environment_scale: viewer.getEnvironmentScale(),
  };
}

function buildFastFieldSettings(base: MeshSettings, seed: number[] | null): MeshSettings {
  return {
    ...base,
    mode: 2,
    voxel_target: Math.max(base.voxel_target ?? 4000, 9000),
    min_alpha: Math.max(base.min_alpha ?? 0.05, 0.08),
    max_scale: Math.min(base.max_scale ?? 5.0, 3.5),
    sdf_cell_size: 0.14,
    sdf_vertical_cell_size: 0.05,
    sdf_density_threshold: 0.06,
    sdf_max_layers: 2,
    sdf_smoothing_radius: 2,
    sdf_influence_radius_scale: 2.6,
    floor_projection_epsilon: 0.2,
    obstacle_height_epsilon: 0.34,
    obstacle_clearance_min: 0.18,
    obstacle_clearance_max: 1.7,
    max_local_height_variance: 0.14,
    min_floor_confidence: 0.005,
    hole_fill_radius: 2,
    agent_radius_erode: 0,
    component_mode: 'all',
    collision_seed: seed ?? base.collision_seed,
    collision_carve_height: 1.7,
    collision_carve_radius: 0.35,
  };
}

/** Half-extent (m) of the seed-centered outdoor working volume (±50 → 100 m XZ). */
export const SEED_CENTERED_HALF_EXTENT_M = 50;

/** Y band below seed floor for the seed-centered region (m). */
const SEED_CENTERED_Y_BELOW_M = 2;

/** Y band above seed floor for the seed-centered region (m). */
const SEED_CENTERED_Y_ABOVE_M = 6;

/** Outdoor ground-field cell size (m) under a seed-centered pin — avoids moth-eaten fine grids. */
export const SEED_CENTERED_SDF_CELL_SIZE_M = 0.4;

/** Outdoor WASM hole-fill radius (cells) under a seed-centered pin. */
export const SEED_CENTERED_HOLE_FILL_RADIUS = 8;

/** Apply outdoor field knobs that survive later meshSettings / fast-field merges. */
export const applySeedCenteredOutdoorFieldKnobs = (settings: MeshSettings): void => {
  settings.sdf_cell_size = SEED_CENTERED_SDF_CELL_SIZE_M;
  settings.hole_fill_radius = SEED_CENTERED_HOLE_FILL_RADIUS;
};

/**
 * Write a seed-centered ~100 m outdoor pin onto `settings` (XZ ±50 m, Y band).
 * Used by Storage Adapter / outdoor demos so Recast heightfields stay bounded.
 * @returns Collision seed at floor + half carve height.
 */
export const applySeedCenteredOutdoorPin = (params: {
  readonly settings: MeshSettings;
  readonly seedX: number;
  readonly seedZ: number;
  readonly floorY: number;
  readonly carveHeight?: number;
  readonly log?: FastNavLogger;
}): number[] => {
  const { settings, seedX, seedZ, floorY } = params;
  const carveHeight = params.carveHeight ?? settings.collision_carve_height ?? 1.6;
  const half = SEED_CENTERED_HALF_EXTENT_M;
  settings.region_min = [seedX - half, floorY - SEED_CENTERED_Y_BELOW_M, seedZ - half];
  settings.region_max = [seedX + half, floorY + SEED_CENTERED_Y_ABOVE_M, seedZ + half];
  applySeedCenteredOutdoorFieldKnobs(settings);
  const seed = [seedX, floorY + carveHeight * 0.5, seedZ];
  params.log?.(
    `[INFO] Fast Nav region=seed-centered (100m) ` +
      `sdf_cell_size=${SEED_CENTERED_SDF_CELL_SIZE_M} hole_fill_radius=${SEED_CENTERED_HOLE_FILL_RADIUS} ` +
      `seed=[${seedX.toFixed(2)}, ${floorY.toFixed(2)}, ${seedZ.toFixed(2)}] ` +
      `min=[${settings.region_min.map((v) => v.toFixed(2)).join(', ')}] ` +
      `max=[${settings.region_max.map((v) => v.toFixed(2)).join(', ')}]`
  );
  return seed;
};

/**
 * Pin WASM region before field build.
 * - Yellow Selection box always wins.
 * - Outdoor seed-centered ~100 m pin only when `seedCenteredOutdoor` is true
 *   (streamed Church path). Indoor default matches HEAD: no auto region pin.
 */
export async function pinFastNavRegionIfNeeded(
  viewer: Viewer,
  bytes: Uint8Array,
  base: MeshSettings,
  log: FastNavLogger,
  seedCenteredOutdoor: boolean
): Promise<number[] | null> {
  const yellowBox = viewer.getWasmRegionBounds();
  if (yellowBox) {
    base.region_min = [...yellowBox.min];
    base.region_max = [...yellowBox.max];
    log(
      `[INFO] Fast Nav region=yellow-box ` +
        `min=[${yellowBox.min.map((v) => v.toFixed(2)).join(', ')}] ` +
        `max=[${yellowBox.max.map((v) => v.toFixed(2)).join(', ')}]`
    );
    return null;
  }

  if (!seedCenteredOutdoor) {
    log('[INFO] Fast Nav region=indoor-unpinned (HEAD: suggestRegion seed only)');
    return null;
  }

  const carveHeight = base.collision_carve_height ?? 1.6;
  const suggested = await splatwalk.suggestRegion(bytes, base);
  const seedX = (suggested.region_min[0] + suggested.region_max[0]) * 0.5;
  const seedZ = (suggested.region_min[2] + suggested.region_max[2]) * 0.5;
  return applySeedCenteredOutdoorPin({
    settings: base,
    seedX,
    seedZ,
    floorY: suggested.floor_y,
    carveHeight,
    log,
  });
}

async function ensureFastCollisionSeed(
  viewer: Viewer,
  bytes: Uint8Array,
  base: MeshSettings,
  log: FastNavLogger,
  precomputedSeed?: number[] | null
): Promise<number[]> {
  const carveHeight = base.collision_carve_height ?? 1.6;
  const wasmRegionBounds = viewer.getWasmRegionBounds();

  let seed: number[];
  if (precomputedSeed) {
    seed = precomputedSeed;
  } else if (wasmRegionBounds) {
    seed = [
      (wasmRegionBounds.min[0] + wasmRegionBounds.max[0]) * 0.5,
      wasmRegionBounds.min[1] + carveHeight * 0.5,
      (wasmRegionBounds.min[2] + wasmRegionBounds.max[2]) * 0.5,
    ];
  } else if (base.region_min && base.region_max) {
    // Seed-centered pin: region Y is floor±band; seed Y uses floor + carve/2.
    const floorY = base.region_min[1] + SEED_CENTERED_Y_BELOW_M;
    seed = [
      (base.region_min[0] + base.region_max[0]) * 0.5,
      floorY + carveHeight * 0.5,
      (base.region_min[2] + base.region_max[2]) * 0.5,
    ];
  } else {
    const suggested = await splatwalk.suggestRegion(bytes, base);
    seed = [
      (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
      suggested.floor_y + carveHeight * 0.5,
      (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
    ];
  }

  viewer.displaySeedMarker(seed);
  log(`[INFO] Fast path seed: ${seed.map((v) => v.toFixed(3)).join(', ')}`);
  return seed;
}

export function triangleArea(positions: Float32Array, i0: number, i1: number, i2: number): number {
  const ax = positions[i1] - positions[i0];
  const ay = positions[i1 + 1] - positions[i0 + 1];
  const az = positions[i1 + 2] - positions[i0 + 2];
  const bx = positions[i2] - positions[i0];
  const by = positions[i2 + 1] - positions[i0 + 1];
  const bz = positions[i2 + 2] - positions[i0 + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

export interface FilterNavmeshIslandOptions {
  /**
   * Max |centroid.y − refY| for same-level island selection (m).
   * Outdoor merge uses this vs seed Y when {@link refFloorY} is omitted.
   */
  readonly floorYBand?: number;
  /** Max horizontal distance (m) from seed when merging outdoor islands. */
  readonly maxSeedDistance?: number;
  /**
   * When true, union all viable same-level islands within maxSeedDistance.
   * Indoor default keeps a single nearest island.
   */
  readonly mergeNearbyIslands?: boolean;
  /**
   * Floor-plane Y for indoor same-level checks (seed is carve mid-height).
   * When set, indoor pick uses this instead of `seed[1]`.
   */
  readonly refFloorY?: number;
}

/** Indoor default: reject islands whose centroid is farther than this from the seed. */
export const DEFAULT_MAX_ISLAND_SEED_DISTANCE = 6.0;

/** Outdoor / streamed default — church courtyards and parks exceed 6 m easily. */
export const STREAMED_MAX_ISLAND_SEED_DISTANCE = 80.0;

/** Default Y band (m) for merging same-level outdoor Recast islands. */
export const DEFAULT_MERGE_ISLAND_FLOOR_Y_BAND = 2.5;

export function filterNavmeshIslandNearSeed(
  positions: Float32Array,
  indices: Uint32Array,
  seed: number[] | null,
  log: FastNavLogger = (message: string): void => console.log(message),
  options?: FilterNavmeshIslandOptions
): { positions: Float32Array; indices: Uint32Array; metadata: NavIslandMetadata | null } {
  const triangleCount = Math.floor(indices.length / 3);
  if (!seed || triangleCount <= 1) {
    return { positions, indices, metadata: null };
  }

  const maxSeedDistance = options?.maxSeedDistance ?? DEFAULT_MAX_ISLAND_SEED_DISTANCE;
  const mergeNearbyIslands =
    options?.mergeNearbyIslands ?? maxSeedDistance >= STREAMED_MAX_ISLAND_SEED_DISTANCE;
  const floorYBand = options?.floorYBand ?? DEFAULT_MERGE_ISLAND_FLOOR_Y_BAND;

  const vertexToTriangles = new Map<string, number[]>();
  const vertexKey = (vertexIndex: number): string => {
    const p = vertexIndex * 3;
    return `${positions[p].toFixed(3)},${positions[p + 1].toFixed(3)},${positions[p + 2].toFixed(3)}`;
  };

  for (let tri = 0; tri < triangleCount; tri++) {
    for (let corner = 0; corner < 3; corner++) {
      const key = vertexKey(indices[tri * 3 + corner]);
      const triangles = vertexToTriangles.get(key);
      if (triangles) {
        triangles.push(tri);
      } else {
        vertexToTriangles.set(key, [tri]);
      }
    }
  }

  const visited = new Uint8Array(triangleCount);
  const components: Array<{
    triangles: number[];
    area: number;
    centroid: [number, number, number];
    distanceToSeed: number;
    horizontalDistanceToSeed: number;
    ymin: number;
    ymax: number;
  }> = [];
  for (let startTri = 0; startTri < triangleCount; startTri++) {
    if (visited[startTri]) continue;

    const stack = [startTri];
    const component: number[] = [];
    visited[startTri] = 1;
    let area = 0;
    let weightedX = 0;
    let weightedY = 0;
    let weightedZ = 0;
    let ymin = Infinity;
    let ymax = -Infinity;

    while (stack.length > 0) {
      const tri = stack.pop()!;
      component.push(tri);
      const i0 = indices[tri * 3] * 3;
      const i1 = indices[tri * 3 + 1] * 3;
      const i2 = indices[tri * 3 + 2] * 3;
      const triArea = triangleArea(positions, i0, i1, i2);
      area += triArea;
      const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
      const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
      const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
      weightedX += cx * triArea;
      weightedY += cy * triArea;
      weightedZ += cz * triArea;
      for (const vy of [positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]]) {
        if (vy < ymin) ymin = vy;
        if (vy > ymax) ymax = vy;
      }

      for (let corner = 0; corner < 3; corner++) {
        const neighbors = vertexToTriangles.get(vertexKey(indices[tri * 3 + corner])) ?? [];
        for (const nextTri of neighbors) {
          if (!visited[nextTri]) {
            visited[nextTri] = 1;
            stack.push(nextTri);
          }
        }
      }
    }

    const invArea = area > 0 ? 1 / area : 0;
    const centroid: [number, number, number] = [weightedX * invArea, weightedY * invArea, weightedZ * invArea];
    const dx = centroid[0] - seed[0];
    const dy = centroid[1] - seed[1];
    const dz = centroid[2] - seed[2];
    const horizontalDistanceToSeed = Math.sqrt(dx * dx + dz * dz);
    components.push({
      triangles: component,
      area,
      centroid,
      distanceToSeed: Math.sqrt(dx * dx + dy * dy + dz * dz),
      horizontalDistanceToSeed,
      ymin,
      ymax,
    });
  }

  // Honest, single-place per-island summary of the FULL navmesh that actually gets
  // displayed/walked (not just the seed island), so connectivity can be verified by
  // island count + each island's area and Y-range instead of one aggregate line.
  const islandSummary = [...components]
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .map((c) => `{a=${c.area.toFixed(1)} y=[${c.ymin.toFixed(2)},${c.ymax.toFixed(2)}]}`)
    .join(' ');
  log(`[INFO] Fast nav navmesh islands=${components.length}: ${islandSummary}`);

  if (components.length <= 1) {
    const only = components[0];
    return {
      positions,
      indices,
      metadata: only
        ? {
            area: only.area,
            centroid: only.centroid,
            distanceToSeed: only.distanceToSeed,
            triangleCount,
            islandCount: 1,
          }
        : null,
    };
  }

  const largestArea = Math.max(...components.map((component) => component.area));
  const viable = components.filter((component) => component.area >= largestArea * 0.08);

  let selectedComponents: typeof components;
  if (mergeNearbyIslands) {
    selectedComponents = viable.filter(
      (component) =>
        component.horizontalDistanceToSeed <= maxSeedDistance &&
        Math.abs(component.centroid[1] - seed[1]) <= floorYBand
    );
    if (selectedComponents.length === 0) {
      selectedComponents = [
        [...viable].sort((a, b) => a.horizontalDistanceToSeed - b.horizontalDistanceToSeed || b.area - a.area)[0] ??
          [...components].sort((a, b) => b.area - a.area)[0],
      ].filter(Boolean);
    }
  } else {
    // Indoor: prefer the largest same-level island near the seed. Compare Y to
    // floor plane (refFloorY), not carve mid-height seed — |floor − seed| ≈ 0.85 m.
    const refY = options?.refFloorY ?? seed[1];
    const indoorFloorYBand = Math.max(floorYBand, 0.75);
    const nearSeedSameLevel = viable.filter(
      (component) =>
        component.horizontalDistanceToSeed <= maxSeedDistance &&
        Math.abs(component.centroid[1] - refY) <= indoorFloorYBand
    );
    const nearSeed = viable.filter(
      (component) => component.horizontalDistanceToSeed <= maxSeedDistance
    );
    const pool =
      nearSeedSameLevel.length > 0
        ? nearSeedSameLevel
        : nearSeed.length > 0
          ? nearSeed
          : viable;
    const ranked = [...pool].sort(
      (a, b) => b.area - a.area || a.distanceToSeed - b.distanceToSeed
    );
    selectedComponents = [ranked[0] ?? [...components].sort((a, b) => b.area - a.area)[0]];
  }

  const selectedTriangles = selectedComponents.flatMap((component) => component.triangles);
  const totalArea = selectedComponents.reduce((sum, component) => sum + component.area, 0);
  const nearest = [...selectedComponents].sort(
    (a, b) => a.horizontalDistanceToSeed - b.horizontalDistanceToSeed || b.area - a.area
  )[0];
  const weightedCentroid: [number, number, number] = (() => {
    let wx = 0;
    let wy = 0;
    let wz = 0;
    for (const component of selectedComponents) {
      wx += component.centroid[0] * component.area;
      wy += component.centroid[1] * component.area;
      wz += component.centroid[2] * component.area;
    }
    const inv = totalArea > 0 ? 1 / totalArea : 0;
    return [wx * inv, wy * inv, wz * inv];
  })();

  const remap = new Map<number, number>();
  const filteredPositions: number[] = [];
  const filteredIndices: number[] = [];
  const addVertex = (oldIndex: number): number => {
    const existing = remap.get(oldIndex);
    if (existing !== undefined) return existing;
    const next = filteredPositions.length / 3;
    const p = oldIndex * 3;
    filteredPositions.push(positions[p], positions[p + 1], positions[p + 2]);
    remap.set(oldIndex, next);
    return next;
  };

  const orderedTriangles = [...selectedTriangles].sort((a, b) => {
    const centroidDistance = (tri: number): number => {
      const i0 = indices[tri * 3] * 3;
      const i1 = indices[tri * 3 + 1] * 3;
      const i2 = indices[tri * 3 + 2] * 3;
      const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
      const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
      const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
      const dx = cx - seed[0];
      const dy = cy - seed[1];
      const dz = cz - seed[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    return centroidDistance(a) - centroidDistance(b);
  });

  for (const tri of orderedTriangles) {
    filteredIndices.push(
      addVertex(indices[tri * 3]),
      addVertex(indices[tri * 3 + 1]),
      addVertex(indices[tri * 3 + 2])
    );
  }

  log(
    `[INFO] Fast nav island filter: kept ${selectedTriangles.length}/${triangleCount} triangles ` +
      `from ${selectedComponents.length}/${components.length} islands` +
      (mergeNearbyIslands ? ' (merged same-level)' : '') +
      `, area=${totalArea.toFixed(2)}, ` +
      `seedDistance=${(nearest?.distanceToSeed ?? 0).toFixed(2)}`
  );

  return {
    positions: new Float32Array(filteredPositions),
    indices: new Uint32Array(filteredIndices),
    metadata: {
      area: totalArea,
      centroid: weightedCentroid,
      distanceToSeed: nearest?.distanceToSeed ?? 0,
      triangleCount: selectedTriangles.length,
      islandCount: components.length,
    },
  };
}

export function validateFastNavIsland(
  metadata: NavIslandMetadata | null,
  seed: number[] | null,
  expectedFloorY: number | null,
  log: FastNavLogger = (message: string): void => console.log(message),
  options?: FilterNavmeshIslandOptions
): void {
  if (!metadata) {
    log('[WARN] Fast nav island validation skipped because no seed island metadata was available.');
    return;
  }

  const maxSeedDistance = options?.maxSeedDistance ?? DEFAULT_MAX_ISLAND_SEED_DISTANCE;
  const floorDelta = expectedFloorY !== null ? metadata.centroid[1] - expectedFloorY : 0;
  log(
    `[INFO] Fast nav selected island: triangles=${metadata.triangleCount}, area=${metadata.area.toFixed(2)}, ` +
      `seedDistance=${metadata.distanceToSeed.toFixed(2)}, ` +
      `floorDelta=${expectedFloorY !== null ? floorDelta.toFixed(2) : 'n/a'}, ` +
      `maxSeedDistance=${maxSeedDistance.toFixed(1)}`
  );

  if (metadata.area < 0.35 || metadata.triangleCount < 2) {
    throw new Error(
      'Fast nav rejected a tiny navmesh island. The floor field did not produce a usable room-floor region.'
    );
  }
  if (seed && metadata.distanceToSeed > maxSeedDistance) {
    throw new Error('Fast nav rejected an island too far from the seed.');
  }
  if (expectedFloorY !== null && floorDelta < -0.7) {
    throw new Error('Fast nav rejected a navmesh below the expected floor.');
  }
}

export function chooseNpcSpawnPoint(
  positions: Float32Array,
  indices: Uint32Array,
  playerSpawn: { x: number; y: number; z: number } | null
): [number, number, number] | null {
  if (!playerSpawn || indices.length < 3) return null;

  let best: [number, number, number] | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    const candidate: [number, number, number] = [
      (positions[i0] + positions[i1] + positions[i2]) / 3,
      (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3,
      (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3,
    ];
    const dx = candidate[0] - playerSpawn.x;
    const dz = candidate[2] - playerSpawn.z;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
    const yPenalty = Math.abs(candidate[1] - playerSpawn.y);
    const score = horizontalDistance - yPenalty * 2;
    if (horizontalDistance >= 0.75 && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export function generateNavmeshInWorker(
  geometry: { positions: Float32Array; indices: Uint32Array },
  params: RecastParams,
  sourceLabel: string,
  splatBounds: { min: number[]; max: number[] } | null,
  colliderBounds: { min: number[]; max: number[] } | null = null
): Promise<NavWorkerResult> {
  const worker = new NavWorker();
  return new Promise<NavWorkerResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const { type, payload } = e.data;
      if (type === 'done') {
        worker.terminate();
        resolve(payload as NavWorkerResult);
      } else if (type === 'error') {
        worker.terminate();
        reject(new Error(String(payload)));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'NavMesh worker crashed.'));
    };
    worker.postMessage({
      type: 'generate',
      payload: { positions: geometry.positions, indices: geometry.indices, params, sourceLabel, splatBounds, colliderBounds },
    });
  });
}

/**
 * Run the one-click FAST NAV pipeline against an already-loaded splat.
 * Compute is WASM {@link splatwalk.fastNav} (`algo`); host runs Recast/crowd.
 */
export async function runFastNav(options: FastNavOptions): Promise<FastNavResult> {
  const { viewer, bytes } = options;
  const algo: FastNavAlgo = options.algo ?? 'floor_field';
  const log: FastNavLogger = options.onLog ?? ((message: string): void => console.log(message));
  const phase: FastNavPhaseListener = options.onPhase ?? ((): void => undefined);
  const cameraSelect = options.cameraSelect;
  const keepCameraSelectView =
    cameraSelect !== undefined && options.keepCameraSelectView !== false;

  const caps = await splatwalk.capabilities();
  if (!caps.includes('fast_nav')) {
    throw new Error(
      'WASM capability fast_nav missing — rebuild @splatwalk/core (npm run build:wasm) or upgrade the package.'
    );
  }
  if (algo === 'sdf_marching_cubes' && !caps.includes('sdf_marching_cubes')) {
    throw new Error(
      'SDF Marching Cubes requires WASM capability sdf_marching_cubes. Rebuild or upgrade @splatwalk/core.'
    );
  }

  // Collision algos: thin host wrappers that call WASM fast_nav internally
  // (generateCollisionBoundary → splatwalk.fastNav). Dynamic import avoids cycles.
  if (algo === 'voxel_collision' || algo === 'sdf_marching_cubes') {
    log(`[WAIT] Fast Nav (${algo}): splat -> WASM fast_nav -> Recast -> NPC...`);
    const collisionSettings =
      options.collisionSettings ??
      ({
        ...defaultFastMeshSettings(viewer),
        ...(options.meshSettings ?? {}),
        mode: 2,
        collision_mesh_mode: algo === 'sdf_marching_cubes' ? 'smooth' : 'faces',
        emit_glb: options.emitGlb ?? false,
        emit_volume: options.emitVolume ?? true,
      } as CollisionVoxelBoundarySettings);
    // Always bake at the viewer session scale (callers may omit environment_scale).
    collisionSettings.environment_scale = viewer.getEnvironmentScale();
    log(`[INFO] Environment scale for this run: ${collisionSettings.environment_scale}`);
    // Apply prune before any WASM ingest (suggestRegion / fast_nav) so OFF is honored.
    if (options.prune) {
      if (options.prune.enabled !== undefined) {
        collisionSettings.prune_floaters = options.prune.enabled;
      }
      if (options.prune.k !== undefined) {
        collisionSettings.prune_floaters_k = options.prune.k;
      }
      if (options.prune.stdRatio !== undefined) {
        collisionSettings.prune_floaters_std_ratio = options.prune.stdRatio;
      }
    }
    log(
      `[INFO] Fast Nav floater prune: ${collisionSettings.prune_floaters === false ? 'off' : 'on'}` +
        (collisionSettings.prune_floaters === false
          ? ''
          : ` (k=${collisionSettings.prune_floaters_k}, std=${collisionSettings.prune_floaters_std_ratio})`) +
        ` · scene=${collisionSettings.collision_scene_type ?? 'outdoor'}`
    );

    if (cameraSelect) {
      const bounds = regionBoundsFromCameraSelect(cameraSelect);
      viewer.enableRegionSelection({ min: bounds.min, max: bounds.max });
      collisionSettings.region_min = [...bounds.min];
      collisionSettings.region_max = [...bounds.max];
      collisionSettings.camera_position = clampPointToAabb({
        point: cameraSelect.view.position,
        regionMax: bounds.max,
        regionMin: bounds.min,
      });
    } else {
      const yellow = viewer.getRegionBounds();
      if (yellow && algo === 'sdf_marching_cubes') {
        const splatDiag = viewer.getSplatBoundsForDiagnostics();
        const decision = ensureSdfMcRegionForDenseBudget({
          candidateRegion: yellow,
          existingRegion: yellow,
          fillSize: collisionSettings.collision_fill_size,
          sceneType: collisionSettings.collision_scene_type,
          splatBounds: splatDiag
            ? {
                min: [splatDiag.min.x, splatDiag.min.y, splatDiag.min.z],
                max: [splatDiag.max.x, splatDiag.max.y, splatDiag.max.z],
              }
            : yellow,
        });
        const region = decision.region ?? yellow;
        viewer.enableRegionSelection({ min: region.min, max: region.max });
        collisionSettings.region_min = [...region.min];
        collisionSettings.region_max = [...region.max];
        log(`[INFO] SDF-MC: ${decision.reason}`);
        const cam = viewer.getScene().activeCamera;
        if (cam) {
          collisionSettings.camera_position = clampPointToAabb({
            point: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
            regionMax: region.max,
            regionMin: region.min,
          });
        }
      } else if (yellow) {
        collisionSettings.region_min = [...yellow.min];
        collisionSettings.region_max = [...yellow.max];
        const cam = viewer.getScene().activeCamera;
        if (cam) {
          collisionSettings.camera_position = clampPointToAabb({
            point: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
            regionMax: yellow.max,
            regionMin: yellow.min,
          });
        }
      } else if (algo === 'voxel_collision') {
        // Voxel on unpinned outdoor streams → camera box (not full AABB).
        const cam = viewer.getScene().activeCamera;
        if (cam) {
          const pos = cam.position;
          const yawRadians =
            'rotation' in cam && cam.rotation
              ? (cam.rotation as { y: number }).y
              : 0;
          const bounds = regionBoundsFromCameraPose({
            pose: {
              position: { x: pos.x, y: pos.y, z: pos.z },
              yawRadians,
            },
            offsets: DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
          });
          viewer.enableRegionSelection({ min: bounds.min, max: bounds.max });
          collisionSettings.region_min = [...bounds.min];
          collisionSettings.region_max = [...bounds.max];
          collisionSettings.camera_position = clampPointToAabb({
            point: { x: pos.x, y: pos.y, z: pos.z },
            regionMax: bounds.max,
            regionMin: bounds.min,
          });
          log(
            `[INFO] No selection region — pinned camera-centered box for ${algo}: ` +
              `${bounds.min.map((v) => v.toFixed(1)).join(', ')} → ` +
              `${bounds.max.map((v) => v.toFixed(1)).join(', ')}`
          );
        }
      } else if (algo === 'sdf_marching_cubes') {
        // Budget-aware: full AABB when it fits; else auto-pin a camera/ground box.
        const carveHeight = collisionSettings.collision_carve_height ?? 1.6;
        const rotation = viewer.getSplatRotation();
        const splatBoundsResult = await splatwalk.getSplatBounds(bytes, {
          ...collisionSettings,
          mode: 2,
          prune_floaters: false,
          flip_y: viewer.isSplatYFlipped(),
          rotation: [rotation.x, rotation.y, rotation.z],
          environment_scale: viewer.getEnvironmentScale(),
        });
        const splatBounds = {
          min: splatBoundsResult.oriented_min,
          max: splatBoundsResult.oriented_max,
        };
        const cam = viewer.getScene().activeCamera;
        const pose = cam
          ? {
              position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
              yawRadians:
                'rotation' in cam && cam.rotation
                  ? (cam.rotation as { y: number }).y
                  : 0,
            }
          : {
              position: {
                x: (splatBounds.min[0]! + splatBounds.max[0]!) * 0.5,
                y: splatBoundsResult.floor_y_percentile_02,
                z: (splatBounds.min[2]! + splatBounds.max[2]!) * 0.5,
              },
              yawRadians: 0,
            };
        const candidateRegion = groundAnchoredCameraRegion({
          carveHeight,
          floorY: splatBoundsResult.floor_y_percentile_02,
          offsets: DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
          pose,
        });
        const decision = ensureSdfMcRegionForDenseBudget({
          candidateRegion,
          existingRegion: null,
          fillSize: collisionSettings.collision_fill_size,
          sceneType: collisionSettings.collision_scene_type,
          splatBounds,
        });
        log(`[INFO] SDF-MC: ${decision.reason}`);
        if (decision.pinned && decision.region) {
          viewer.enableRegionSelection({
            min: decision.region.min,
            max: decision.region.max,
          });
          collisionSettings.region_min = [...decision.region.min];
          collisionSettings.region_max = [...decision.region.max];
          collisionSettings.camera_position = clampPointToAabb({
            point: pose.position,
            regionMax: decision.region.max,
            regionMin: decision.region.min,
          });
          collisionSettings.collision_seed = [
            (decision.region.min[0]! + decision.region.max[0]!) * 0.5,
            decision.region.min[1]! + carveHeight * 0.5,
            (decision.region.min[2]! + decision.region.max[2]!) * 0.5,
          ];
        } else {
          delete collisionSettings.region_min;
          delete collisionSettings.region_max;
          const callerSeed = options.collisionSettings?.collision_seed;
          const keepCallerSeed =
            Array.isArray(callerSeed) &&
            callerSeed.length >= 3 &&
            !isDefaultOriginCollisionSeed(callerSeed);
          if (!keepCallerSeed) {
            const suggested = await splatwalk.suggestRegion(bytes, collisionSettings);
            collisionSettings.collision_seed = [
              (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
              suggested.floor_y + carveHeight * 0.5,
              (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
            ];
            log(
              `[INFO] SDF-MC seed from suggestRegion: ` +
                `${collisionSettings.collision_seed.map((v) => v.toFixed(3)).join(', ')}`
            );
          }
          if (cam && !collisionSettings.camera_position) {
            collisionSettings.camera_position = [
              cam.position.x,
              cam.position.y,
              cam.position.z,
            ];
          }
        }
      }
    }
    if (
      collisionSettings.region_min &&
      collisionSettings.region_max &&
      collisionSettings.collision_seed &&
      collisionSettings.collision_seed.length >= 3
    ) {
      collisionSettings.collision_seed = clampPointToAabb({
        point: collisionSettings.collision_seed,
        regionMax: collisionSettings.region_max,
        regionMin: collisionSettings.region_min,
      });
    } else if (
      collisionSettings.region_min &&
      collisionSettings.region_max &&
      isDefaultOriginCollisionSeed(collisionSettings.collision_seed)
    ) {
      const carveHeight = collisionSettings.collision_carve_height ?? 1.6;
      const regionMin = collisionSettings.region_min;
      const regionMax = collisionSettings.region_max;
      collisionSettings.collision_seed = [
        (regionMin[0] + regionMax[0]) * 0.5,
        regionMin[1] + carveHeight * 0.5,
        (regionMin[2] + regionMax[2]) * 0.5,
      ];
    }
    if (
      (collisionSettings.collision_scene_type ?? 'outdoor') === 'outdoor' &&
      algo === 'sdf_marching_cubes' &&
      collisionSettings.floor_project_flatten_m === undefined
    ) {
      collisionSettings.floor_project_flatten_m = 0.35;
    }
    const shared = {
      activeNavigationMode: options.activeNavigationMode ?? ('recast' as const),
      bytes,
      collisionSettings,
      onLog: log,
      onPhase: phase,
      recastAttempts: options.recastAttempts,
      recastOverrides: options.recastOverrides,
      showColliderOverlay: true,
      viewer,
    };
    const navResult =
      algo === 'sdf_marching_cubes'
        ? await (await import('@/navigation/runNavFromSdfMc')).runNavFromSdfMc(shared)
        : await (await import('@/navigation/runNavFromVoxelCollider')).runNavFromVoxelCollider(
            shared
          );
    return finalizeFastNavWithCameraSelect(
      viewer,
      {
        algo,
        debugIndices: navResult.debugIndices,
        debugPositions: navResult.debugPositions,
        navMeshData: navResult.navMeshData,
        playerSpawn: navResult.playerSpawn,
        keptCameraSelectView: navResult.keptCameraSelectView,
        volume: navResult.volume,
      },
      cameraSelect,
      keepCameraSelectView,
      log
    );
  }

  // HEAD / prod path: TS ground field → buildFastFloorMesh → Recast (not WASM floor_field).
  log('[WAIT] Fast Nav (floor_field): splat -> floor field -> navmesh -> NPC...');

  const base: MeshSettings = {
    ...defaultFastMeshSettings(viewer),
    ...(options.meshSettings ?? {}),
  };
  if (options.prune) {
    if (options.prune.enabled !== undefined) base.prune_floaters = options.prune.enabled;
    if (options.prune.k !== undefined) base.prune_floaters_k = options.prune.k;
    if (options.prune.stdRatio !== undefined) base.prune_floaters_std_ratio = options.prune.stdRatio;
  }
  log(
    `[INFO] Fast Nav floater prune: ${base.prune_floaters === false ? 'off' : 'on'}` +
      (base.prune_floaters === false ? '' : ` (k=${base.prune_floaters_k}, std=${base.prune_floaters_std_ratio})`)
  );

  if (cameraSelect) {
    const bounds = regionBoundsFromCameraSelect(cameraSelect);
    viewer.enableRegionSelection({ min: bounds.min, max: bounds.max });
    base.region_min = [...bounds.min];
    base.region_max = [...bounds.max];
    base.camera_position = [
      cameraSelect.view.position.x,
      cameraSelect.view.position.y,
      cameraSelect.view.position.z,
    ];
    log(
      `[INFO] Camera select region pinned: ` +
        `${bounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
        `${bounds.max.map((v) => v.toFixed(2)).join(', ')}`
    );
  }

  const seedCenteredOutdoor = options.seedCenteredOutdoor === true;
  const precomputedSeed = await pinFastNavRegionIfNeeded(
    viewer,
    bytes,
    base,
    log,
    seedCenteredOutdoor
  );
  // Yellow-box pin skips outdoor knobs inside pinFastNavRegionIfNeeded; apply
  // before cache key so signature `base` matches extract settings.
  if (seedCenteredOutdoor) {
    applySeedCenteredOutdoorFieldKnobs(base);
  }
  const recovery = resolveRecovery(options.recovery);

  const baseAttempts = options.recastAttempts ?? FAST_NAV_RECAST_ATTEMPTS;
  const attempts = options.recastOverrides
    ? baseAttempts.map((attempt) => ({
        label: attempt.label,
        params: { ...attempt.params, ...options.recastOverrides },
      }))
    : baseAttempts;

  const floorMeshOptions: FastFloorMeshOptions = {
    ...(options.floorMesh ?? {}),
    seedCenteredOutdoor,
  };
  const envScale = base.environment_scale ?? 1;
  log(`[INFO] Environment scale for this run: ${envScale}`);
  const cacheSignature = buildFastNavCacheSignature({
    algo: 'floor_field',
    base,
    recovery,
    strayTrim: options.strayTrim ?? null,
    denseSeed: options.denseSeed ?? null,
    floorMesh: floorMeshOptions,
    floorPipeline: FAST_NAV_FLOOR_PIPELINE,
    seedCenteredOutdoor,
    islandValidation: options.islandValidation ?? null,
    recastAttempts: attempts,
  });
  const cacheKey = buildNavmeshKey(bytes, cacheSignature);
  const cached = await getNavmesh(cacheKey);
  if (cached) {
    log(
      `[INFO] FAST NAV navmesh restored from cache (skipping recompute; ` +
        `environment_scale=${envScale}).`
    );
    phase('navmesh');
    return finalizeFastNavWithCameraSelect(
      viewer,
      await finishFastNav(viewer, cached, log, 'Fast Nav', null, 'floor_field'),
      cameraSelect,
      keepCameraSelectView,
      log
    );
  }

  phase('prune');
  const fastSeed = await ensureFastCollisionSeed(viewer, bytes, base, log, precomputedSeed);
  const builtField = buildFastFieldSettings(base, fastSeed);
  const navSettings: MeshSettings = {
    ...builtField,
    ...(options.meshSettings ?? {}),
    collision_seed: options.meshSettings?.collision_seed ?? builtField.collision_seed,
    region_max: base.region_max ?? builtField.region_max,
    region_min: base.region_min ?? builtField.region_min,
  };
  if (navSettings.region_min && navSettings.region_max) {
    navSettings.region_min = [...navSettings.region_min];
    navSettings.region_max = [...navSettings.region_max];
  } else {
    delete navSettings.region_min;
    delete navSettings.region_max;
  }
  if (seedCenteredOutdoor) {
    applySeedCenteredOutdoorFieldKnobs(navSettings);
  }

  phase('floor');
  const extracted = await extractFloorFieldWithRecovery({
    bytes,
    buildField: (b, s) => splatwalk.buildWalkableGroundField(b, s),
    baseSettings: navSettings,
    seed: navSettings.collision_seed ?? fastSeed,
    recovery,
    strayTrim: options.strayTrim,
    denseSeed: options.denseSeed,
    floorMesh: floorMeshOptions,
    seedCenteredOutdoor,
    log,
  });
  const floorMesh = extracted.floorMesh;
  let effectiveFastSeed: number[] = extracted.effectiveSeed;
  const geometry = { positions: floorMesh.positions, indices: floorMesh.indices };
  if (floorMesh.fallbackUsed) {
    effectiveFastSeed = floorMesh.centroid;
    viewer.displaySeedMarker(floorMesh.centroid);
    log(`[WARN] Fast nav relocated the seed marker to the accepted floor island centroid.`);
  }

  if (geometry.positions.length === 0 || geometry.indices.length === 0) {
    throw new Error('Fast nav produced an empty floor mesh. Try a different splat.');
  }

  log(
    `[INFO] Fast floor Recast source: vertices=${geometry.positions.length / 3}, ` +
      `triangles=${geometry.indices.length / 3}, area=${floorMesh.selectedArea.toFixed(2)}`
  );

  const splatBoundsVec = viewer.getSplatBoundsForDiagnostics();
  const splatBounds = splatBoundsVec
    ? { min: splatBoundsVec.min.asArray(), max: splatBoundsVec.max.asArray() }
    : null;

  let result: NavWorkerResult | null = null;
  let lastError: unknown = null;
  phase('navmesh');
  for (const attempt of attempts) {
    log(`[WAIT] Spawning NavMesh worker (${attempt.label})...`);
    try {
      result = await generateNavmeshInWorker(
        geometry,
        attempt.params,
        'fast_floor_field',
        splatBounds
      );
      if (attempt.label !== 'strict') {
        log(`[WARN] Fast nav recovered with ${attempt.label} Recast settings.`);
      }
      break;
    } catch (error) {
      lastError = error;
      if (attempt === attempts[attempts.length - 1]) break;
      log(`[WARN] Fast nav ${attempt.label} attempt failed; retrying with relaxed Recast settings.`);
    }
  }

  if (!result) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  log('[SUCCESS] NavMesh generated successfully.');

  const expectedFloorY = navSettings.collision_carve_height
    ? effectiveFastSeed[1] - navSettings.collision_carve_height * 0.5
    : null;
  const islandOptions: FilterNavmeshIslandOptions = {
    floorYBand: options.islandValidation?.floorYBand,
    maxSeedDistance: options.islandValidation?.maxSeedDistance,
    mergeNearbyIslands: options.islandValidation?.mergeNearbyIslands,
    refFloorY: expectedFloorY ?? undefined,
  };
  const safety = filterNavmeshIslandNearSeed(
    result.debugPositions,
    result.debugIndices,
    effectiveFastSeed,
    log,
    islandOptions
  );
  validateFastNavIsland(safety.metadata, effectiveFastSeed, expectedFloorY, log, islandOptions);

  await putNavmesh(cacheKey, {
    navMeshData: result.navMeshData,
    debugPositions: result.debugPositions,
    debugIndices: result.debugIndices,
  });

  return finalizeFastNavWithCameraSelect(
    viewer,
    await finishFastNav(viewer, result, log, 'Fast Nav', null, 'floor_field'),
    cameraSelect,
    keepCameraSelectView,
    log
  );
}

const finalizeFastNavWithCameraSelect = (
  viewer: Viewer,
  result: FastNavResult,
  cameraSelect: CameraSelectRegionInput | undefined,
  keepCameraSelectView: boolean,
  log: FastNavLogger
): FastNavResult => {
  if (!cameraSelect || !keepCameraSelectView) {
    return { ...result, keptCameraSelectView: false };
  }
  viewer.applyCameraSelectView(cameraSelect.view);
  log(
    `[INFO] Restored camera select view at ` +
      `[${cameraSelect.view.position.x.toFixed(2)}, ` +
      `${cameraSelect.view.position.y.toFixed(2)}, ` +
      `${cameraSelect.view.position.z.toFixed(2)}]`
  );
  return { ...result, keptCameraSelectView: true };
};

/**
 * Shared post-worker tail used by both a fresh navmesh build and a cache hit:
 * render the overlay, choose spawn points, initialize the crowd, and spawn the
 * NPC. Deterministic in its inputs, so a restored artifact reproduces the same
 * player/NPC setup as the original run.
 */
export async function finishFastNav(
  viewer: Viewer,
  artifact: { navMeshData: Uint8Array; debugPositions: Float32Array; debugIndices: Uint32Array },
  log: FastNavLogger,
  pathLabel = 'Fast Nav',
  seedOriented?: number[] | null,
  algo: FastNavAlgo = 'floor_field',
  volume?: CollisionVoxelVolume
): Promise<FastNavResult> {
  log('[WAIT] Rendering NavMesh overlay...');
  const spawnWorld = await viewer.displayNavMesh(
    artifact.debugPositions,
    artifact.debugIndices,
    0,
    seedOriented ?? null
  );
  const orientedSpawn = viewer.getNavMeshSpawnOriented();
  if (orientedSpawn) {
    const npcSpawn = chooseNpcSpawnPoint(artifact.debugPositions, artifact.debugIndices, orientedSpawn);
    viewer.setPreferredNavSpawnPoints(
      [orientedSpawn.x, orientedSpawn.y, orientedSpawn.z],
      npcSpawn
    );
    const world = viewer.orientedNavPointToWorld(orientedSpawn);
    log(
      `[INFO] Player agent spawn: world ${world.x.toFixed(3)}, ${world.y.toFixed(3)}, ${world.z.toFixed(3)} ` +
        `(oriented ${orientedSpawn.x.toFixed(3)}, ${orientedSpawn.y.toFixed(3)}, ${orientedSpawn.z.toFixed(3)})`
    );
  } else if (spawnWorld) {
    log(`[WARN] Navmesh overlay rendered but no spawn point resolved near seed.`);
  }

  log('[WAIT] Initializing NPC crowd simulation...');
  await viewer.initCrowd(artifact.navMeshData);
  viewer.addNPC();
  log(`[SUCCESS] ${pathLabel} complete: navmesh ready, NPC spawned. Click splats, walls, or ceilings to move.`);

  return {
    algo,
    debugIndices: artifact.debugIndices,
    debugPositions: artifact.debugPositions,
    navMeshData: artifact.navMeshData,
    playerSpawn: spawnWorld,
    keptCameraSelectView: false,
    volume,
  };
}
