import type { Vector3 } from '@babylonjs/core';

import NavWorker from '@/navigation/navmesh.worker?worker';
import type { Viewer } from '@/scene/Viewer';
import { buildNavmeshKey, getNavmesh, putNavmesh } from '@/navigation/navmeshCache';
import { splatwalk, type MeshSettings } from '@/wasm/bridge';
import { normalizeSplatToPly } from '@/wasm/normalize';
import {
  extractFloorFieldWithRecovery,
  resolveRecovery,
  type FastNavLogger,
  type FastNavRecoveryConfig,
  type StrayTrimOptions,
  type DenseSeedOptions,
} from '@/navigation/floor';

// Re-export the framework-agnostic floor logic so existing imports from this
// module (and the published `src/index.ts` surface) keep working unchanged. The
// pure floor math now lives in `@/navigation/floor` so binary-only / non-Babylon
// integrators can consume it without a 3D engine.
export * from '@/navigation/floor';

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
  /** The serialized Recast navmesh binary. */
  readonly navMeshData: Uint8Array;
  /** The chosen player spawn point on the navmesh, if any. */
  readonly playerSpawn: Vector3 | null;
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
    flip_y: viewer.isSplatYFlipped(),
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

async function ensureFastCollisionSeed(
  viewer: Viewer,
  bytes: Uint8Array,
  base: MeshSettings,
  log: FastNavLogger
): Promise<number[]> {
  const regionBounds = viewer.getRegionBounds();
  const carveHeight = base.collision_carve_height ?? 1.6;

  let seed: number[];
  if (regionBounds) {
    seed = [
      (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
      regionBounds.min[1] + carveHeight * 0.5,
      (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
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

export function filterNavmeshIslandNearSeed(
  positions: Float32Array,
  indices: Uint32Array,
  seed: number[] | null,
  log: FastNavLogger = (message: string): void => console.log(message)
): { positions: Float32Array; indices: Uint32Array; metadata: NavIslandMetadata | null } {
  const triangleCount = Math.floor(indices.length / 3);
  if (!seed || triangleCount <= 1) {
    return { positions, indices, metadata: null };
  }

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
    components.push({
      triangles: component,
      area,
      centroid,
      distanceToSeed: Math.sqrt(dx * dx + dy * dy + dz * dz),
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
  viable.sort((a, b) => a.distanceToSeed - b.distanceToSeed || b.area - a.area);
  const selected = viable[0] ?? components.sort((a, b) => b.area - a.area)[0];

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

  const orderedTriangles = [...selected.triangles].sort((a, b) => {
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
    `[INFO] Fast nav island filter: kept ${selected.triangles.length}/${triangleCount} triangles ` +
      `across ${components.length} islands, area=${selected.area.toFixed(2)}, ` +
      `seedDistance=${selected.distanceToSeed.toFixed(2)}`
  );

  return {
    positions: new Float32Array(filteredPositions),
    indices: new Uint32Array(filteredIndices),
    metadata: {
      area: selected.area,
      centroid: selected.centroid,
      distanceToSeed: selected.distanceToSeed,
      triangleCount: selected.triangles.length,
      islandCount: components.length,
    },
  };
}

export function validateFastNavIsland(
  metadata: NavIslandMetadata | null,
  seed: number[] | null,
  expectedFloorY: number | null,
  log: FastNavLogger = (message: string): void => console.log(message)
): void {
  if (!metadata) {
    log('[WARN] Fast nav island validation skipped because no seed island metadata was available.');
    return;
  }

  const floorDelta = expectedFloorY !== null ? metadata.centroid[1] - expectedFloorY : 0;
  log(
    `[INFO] Fast nav selected island: triangles=${metadata.triangleCount}, area=${metadata.area.toFixed(2)}, ` +
      `seedDistance=${metadata.distanceToSeed.toFixed(2)}, ` +
      `floorDelta=${expectedFloorY !== null ? floorDelta.toFixed(2) : 'n/a'}`
  );

  if (metadata.area < 0.35 || metadata.triangleCount < 2) {
    throw new Error(
      'Fast nav rejected a tiny navmesh island. The floor field did not produce a usable room-floor region.'
    );
  }
  if (seed && metadata.distanceToSeed > 6.0) {
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

function generateNavmeshInWorker(
  geometry: { positions: Float32Array; indices: Uint32Array },
  params: RecastParams,
  sourceLabel: string,
  splatBounds: { min: number[]; max: number[] } | null
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
      payload: { positions: geometry.positions, indices: geometry.indices, params, sourceLabel, splatBounds, colliderBounds: null },
    });
  });
}

/**
 * Run the full one-click FAST NAV pipeline against an already-loaded splat:
 * splat -> walkable ground field -> floor mesh -> Recast navmesh (with a relaxed
 * retry ladder) -> crowd + NPC. Mirrors the workbench "FAST NAV" button.
 */
export async function runFastNav(options: FastNavOptions): Promise<FastNavResult> {
  const { viewer, bytes } = options;
  const log: FastNavLogger = options.onLog ?? ((message: string): void => console.log(message));
  const phase: FastNavPhaseListener = options.onPhase ?? ((): void => undefined);

  log('[WAIT] Fast path: splat -> floor field -> navmesh -> NPC...');

  const base = defaultFastMeshSettings(viewer);
  if (options.prune) {
    if (options.prune.enabled !== undefined) base.prune_floaters = options.prune.enabled;
    if (options.prune.k !== undefined) base.prune_floaters_k = options.prune.k;
    if (options.prune.stdRatio !== undefined) base.prune_floaters_std_ratio = options.prune.stdRatio;
  }
  const recovery = resolveRecovery(options.recovery);

  // Cross-visit cache: if this exact splat + settings produced a navmesh before,
  // restore it and skip parse+prune+field+floor+Recast entirely. The seed and
  // orientation are deterministic functions of the bytes plus these settings, so
  // the key omits them (computing the seed is part of the work we want to skip).
  const cacheKey = buildNavmeshKey(bytes, {
    base,
    recovery,
    strayTrim: options.strayTrim ?? null,
    denseSeed: options.denseSeed ?? null,
    recastAttempts: options.recastAttempts ?? FAST_NAV_RECAST_ATTEMPTS,
  });
  const cached = await getNavmesh(cacheKey);
  if (cached) {
    log('[INFO] FAST NAV navmesh restored from cache (skipping recompute).');
    phase('navmesh');
    return finishFastNav(viewer, cached, log);
  }

  // First touch of the splat bytes parses + prunes floaters in the worker.
  phase('prune');
  const fastSeed = await ensureFastCollisionSeed(viewer, bytes, base, log);
  const navSettings = buildFastFieldSettings(base, fastSeed);

  phase('floor');
  const extracted = await extractFloorFieldWithRecovery({
    bytes,
    buildField: (b, s) => splatwalk.buildWalkableGroundField(b, s),
    baseSettings: navSettings,
    seed: navSettings.collision_seed ?? fastSeed,
    recovery,
    strayTrim: options.strayTrim,
    denseSeed: options.denseSeed,
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

  const attempts = options.recastAttempts ?? FAST_NAV_RECAST_ATTEMPTS;

  let result: NavWorkerResult | null = null;
  let lastError: unknown = null;
  for (const attempt of attempts) {
    log(`[WAIT] Spawning NavMesh worker (${attempt.label})...`);
    try {
      result = await generateNavmeshInWorker(geometry, attempt.params, 'fast_floor_field', splatBounds);
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
  const safety = filterNavmeshIslandNearSeed(result.debugPositions, result.debugIndices, effectiveFastSeed, log);
  validateFastNavIsland(safety.metadata, effectiveFastSeed, expectedFloorY, log);

  // Persist the validated artifact so an unchanged revisit restores it instead of
  // recomputing. Best-effort: a storage failure never blocks the pipeline, and we
  // only cache results that passed validation so we never persist a bad navmesh.
  await putNavmesh(cacheKey, {
    navMeshData: result.navMeshData,
    debugPositions: result.debugPositions,
    debugIndices: result.debugIndices,
  });

  return finishFastNav(viewer, result, log);
}

/**
 * Shared post-worker tail used by both a fresh navmesh build and a cache hit:
 * render the overlay, choose spawn points, initialize the crowd, and spawn the
 * NPC. Deterministic in its inputs, so a restored artifact reproduces the same
 * player/NPC setup as the original run.
 */
async function finishFastNav(
  viewer: Viewer,
  artifact: { navMeshData: Uint8Array; debugPositions: Float32Array; debugIndices: Uint32Array },
  log: FastNavLogger
): Promise<FastNavResult> {
  log('[WAIT] Rendering NavMesh overlay...');
  const spawnPoint = await viewer.displayNavMesh(artifact.debugPositions, artifact.debugIndices, 0);
  if (spawnPoint) {
    const npcSpawn = chooseNpcSpawnPoint(artifact.debugPositions, artifact.debugIndices, spawnPoint);
    viewer.setPreferredNavSpawnPoints([spawnPoint.x, spawnPoint.y, spawnPoint.z], npcSpawn);
    log(`[INFO] Player agent spawn: ${spawnPoint.x.toFixed(3)}, ${spawnPoint.y.toFixed(3)}, ${spawnPoint.z.toFixed(3)}`);
  }

  log('[WAIT] Initializing NPC crowd simulation...');
  await viewer.initCrowd(artifact.navMeshData, spawnPoint);
  viewer.addNPC();
  log('[SUCCESS] Fast path complete: navmesh ready, NPC spawned.');

  return { navMeshData: artifact.navMeshData, playerSpawn: spawnPoint };
}
