/**
 * Framework-agnostic FAST NAV floor logic.
 *
 * This module contains the room-floor extraction math that does NOT depend on
 * Babylon.js, the viewer, or any web-worker glue. It operates purely on the
 * {@link WalkableGroundFieldResult} returned by the WASM core plus plain
 * {@link MeshSettings}, so binary-only and non-Babylon integrators can reuse it
 * without pulling in a 3D engine. The Babylon orchestration (the viewer, the nav
 * worker, spawn handling) lives in {@link "@/navigation/fastNav"}, which
 * re-exports everything here for backwards compatibility.
 *
 * The only imports are type-only, so nothing in this module ties a consumer to a
 * specific runtime or bundler.
 */
import type { MeshSettings, WalkableGroundFieldResult } from '@/wasm/bridge';

/** A single human-readable progress line, optionally tagged with `[INFO]`, `[WAIT]`, `[WARN]`, `[SUCCESS]`. */
export type FastNavLogger = (message: string) => void;

/**
 * Canonical FAST NAV floor-field preset.
 *
 * These are the conservative reconstruction + 2.5D floor-field settings the
 * reference FAST NAV path uses to extract a room floor. Binary-only integrators
 * can pass this straight to `build_walkable_ground_field` / `build_room_floor_mesh`
 * (merged with their own per-scene `rotation`, `flip_y`, `collision_seed`, and
 * optional `region_min`/`region_max`) instead of reverse-engineering the values.
 *
 * It intentionally omits per-scene fields (`rotation`, `flip_y`, `collision_seed`,
 * `region_*`) so callers supply those for their own splat orientation and seed.
 */
export const FAST_NAV_PRESET: Readonly<MeshSettings> = {
  mode: 2,
  voxel_target: 9000,
  min_alpha: 0.08,
  max_scale: 3.5,
  sdf_cell_size: 0.14,
  sdf_vertical_cell_size: 0.05,
  sdf_density_threshold: 0.06,
  sdf_max_layers: 2,
  sdf_smoothing_radius: 2,
  sdf_influence_radius_scale: 2.6,
  prune_floaters: true,
  prune_floaters_k: 16,
  prune_floaters_std_ratio: 2.0,
  normal_align: 0.3,
  ransac_thresh: 0.16,
  floor_projection_epsilon: 0.2,
  height_projection_epsilon: 0.16,
  obstacle_height_epsilon: 0.34,
  obstacle_clearance_min: 0.18,
  obstacle_clearance_max: 1.7,
  max_local_height_variance: 0.14,
  min_floor_confidence: 0.005,
  hole_fill_radius: 2,
  agent_radius_erode: 0,
  component_mode: 'all',
  collision_carve_height: 1.7,
  collision_carve_radius: 0.35,
};

/**
 * Default vertical tolerance (meters) within which a floor corner height is snapped
 * to the dominant floor plane, so a flat floor triangulates as a single flat surface
 * instead of a noisy set of stepped quads that Recast fragments into islands.
 */
export const DEFAULT_FLOOR_FLATTEN_TOLERANCE = 0.12;

/**
 * Largest enclosed gap (in cells) that {@link buildFastFloorMesh} will bridge across
 * when a void / low-confidence pocket is fully surrounded by accepted floor (seams,
 * painted lines, reflective patches). Larger holes are treated as real openings.
 */
const MAX_BRIDGE_GAP_CELLS = 12;

/** Why floor-field extraction failed (used to drive adaptive recovery). */
export type FastNavFloorReason = 'no_component' | 'too_small' | 'empty_mesh';

/** Diagnostic payload attached to a {@link FastNavFloorError}. */
export interface FastNavFloorDiagnostics {
  /** Largest usable floor area found, in square meters (if known). */
  readonly area?: number;
  /** Number of connected floor components considered. */
  readonly components?: number;
  /** Per-state cell counts from the walkable ground field. */
  readonly stateCounts?: Record<string, number>;
}

/**
 * Typed error thrown by {@link buildFastFloorMesh} when the floor field does not
 * yield a usable room floor. The {@link reason} lets the recovery loop decide
 * whether to escalate extraction parameters and retry.
 */
export class FastNavFloorError extends Error {
  readonly reason: FastNavFloorReason;
  readonly area?: number;
  readonly components?: number;
  readonly stateCounts?: Record<string, number>;

  constructor(reason: FastNavFloorReason, message: string, diagnostics: FastNavFloorDiagnostics = {}) {
    super(message);
    this.name = 'FastNavFloorError';
    this.reason = reason;
    this.area = diagnostics.area;
    this.components = diagnostics.components;
    this.stateCounts = diagnostics.stateCounts;
    // Restore the prototype chain so `instanceof` works after transpilation.
    Object.setPrototypeOf(this, FastNavFloorError.prototype);
  }
}

/** A single attempt in the adaptive floor-field recovery ladder. */
export interface FastNavRecoveryStep {
  /** Human-readable label surfaced in the logs (e.g. `relaxed`, `coarse`). */
  readonly label: string;
  /** Partial {@link MeshSettings} merged over the base fast-field settings for this attempt. */
  readonly settings: Partial<MeshSettings>;
  /** Minimum accepted floor area (m^2) for this attempt to count as success. */
  readonly minRoomFloorArea: number;
  /** Optional per-step override for stray-floater trimming (see {@link trimStrayFloorCells}). */
  readonly strayTrim?: StrayTrimOptions;
}

/** Configurable, ordered floor-field recovery ladder. */
export interface FastNavRecoveryConfig {
  /** Attempts tried in order; the first one that yields a usable floor wins. */
  readonly steps: readonly FastNavRecoveryStep[];
}

/**
 * Default, built-in recovery ladder. It first escalates extraction parameters
 * (coarser cells, lower density threshold, higher variance tolerance, higher
 * voxel target, lower confidence) and only relaxes the room-area gate on later
 * steps as a last resort. Integrators can override any/all of this.
 */
export const DEFAULT_FAST_NAV_RECOVERY: FastNavRecoveryConfig = {
  steps: [
    { label: 'default', settings: {}, minRoomFloorArea: 4.0 },
    {
      label: 'relaxed',
      settings: {
        sdf_density_threshold: 0.04,
        max_local_height_variance: 0.2,
        obstacle_height_epsilon: 0.42,
        min_floor_confidence: 0.003,
        hole_fill_radius: 3,
        voxel_target: 12000,
      },
      minRoomFloorArea: 4.0,
    },
    {
      label: 'coarse',
      settings: {
        sdf_cell_size: 0.2,
        sdf_density_threshold: 0.03,
        max_local_height_variance: 0.28,
        min_floor_confidence: 0.002,
        voxel_target: 14000,
        hole_fill_radius: 3,
      },
      minRoomFloorArea: 2.5,
    },
    {
      label: 'coarse-last-resort',
      settings: {
        sdf_cell_size: 0.26,
        sdf_density_threshold: 0.022,
        max_local_height_variance: 0.36,
        min_floor_confidence: 0.0015,
        voxel_target: 16000,
        hole_fill_radius: 4,
      },
      minRoomFloorArea: 1.5,
    },
  ],
};

/**
 * Resolve a (possibly partial/omitted) recovery config to a concrete one,
 * falling back to {@link DEFAULT_FAST_NAV_RECOVERY} when no steps are supplied.
 * This is what makes adaptive recovery on-by-default for every caller.
 */
export function resolveRecovery(partial?: Partial<FastNavRecoveryConfig>): FastNavRecoveryConfig {
  if (!partial || !partial.steps || partial.steps.length === 0) {
    return DEFAULT_FAST_NAV_RECOVERY;
  }
  return { steps: partial.steps };
}

/**
 * Tuning for {@link trimStrayFloorCells}. All optional; sensible defaults make it
 * a no-op on clean scenes and only trim a small number of peripheral strays.
 */
export interface StrayTrimOptions {
  /** Master switch. Defaults to `true` (built-in, on by default). */
  readonly enabled?: boolean;
  /**
   * Max vertical distance (meters) a cell may sit from the median floor height to
   * still count as real floor. Cells beyond this are treated as stray floaters.
   * Defaults to `0.5`.
   */
  readonly heightTolerance?: number;
  /**
   * Safety cap: if trimming would drop more than this fraction of the floor, the
   * spread is considered structural (e.g. a genuine multi-level floor) and nothing
   * is trimmed. Defaults to `0.3` ("small numbers" of strays only).
   */
  readonly maxStrayFraction?: number;
  /** Never trim the floor below this many cells. Defaults to `16`. */
  readonly minKeepCells?: number;
}

/** Result of {@link trimStrayFloorCells}. */
export interface StrayTrimResult {
  /** The retained floor cell indices (the dense, contiguous core). */
  readonly cells: number[];
  /** Cells dropped because their height was a floater-like outlier. */
  readonly droppedHeightOutliers: number;
  /** Cells dropped because they were spatially-isolated peripheral specks. */
  readonly droppedPeripheral: number;
  /** Median floor height used as the reference plane. */
  readonly medianHeight: number;
  /** Whether any cells were dropped. */
  readonly changed: boolean;
}

/**
 * Ignore a small number of stray peripheral splats/cells in a detected floor.
 *
 * Large, floater-heavy scans leave scattered cells at outlier heights inside an
 * otherwise-flat floor component; triangulating them creates vertical cliffs that
 * Recast splits into tiny fragments. This helper drops height outliers (relative
 * to the median floor plane) and any spatially-isolated specks, keeping the
 * largest contiguous core. It is deliberately conservative: if the would-be
 * removals exceed `maxStrayFraction`, the spread is treated as structural and the
 * input is returned unchanged, so clean and legitimately multi-level floors are
 * untouched.
 */
export function trimStrayFloorCells(
  field: WalkableGroundFieldResult,
  cells: number[],
  options: StrayTrimOptions = {}
): StrayTrimResult {
  const enabled = options.enabled ?? true;
  const heightTolerance = options.heightTolerance ?? 0.5;
  const maxStrayFraction = options.maxStrayFraction ?? 0.3;
  const minKeepCells = options.minKeepCells ?? 16;

  const noop: StrayTrimResult = {
    cells,
    droppedHeightOutliers: 0,
    droppedPeripheral: 0,
    medianHeight: Number.NaN,
    changed: false,
  };
  if (!enabled || cells.length <= minKeepCells) return noop;

  const heights = cells
    .map((idx) => field.cells[idx]?.height)
    .filter((h): h is number => Number.isFinite(h))
    .sort((a, b) => a - b);
  if (heights.length === 0) return noop;
  const medianHeight = heights[Math.floor(heights.length / 2)];

  const withinBand = cells.filter((idx) => {
    const h = field.cells[idx]?.height;
    return Number.isFinite(h) && Math.abs((h as number) - medianHeight) <= heightTolerance;
  });
  const droppedHeightOutliers = cells.length - withinBand.length;
  if (droppedHeightOutliers > maxStrayFraction * cells.length || withinBand.length < minKeepCells) {
    return noop;
  }

  const width = field.width;
  const height = field.height;
  const inBand = new Set(withinBand);
  const visited = new Set<number>();
  let best: number[] = [];
  for (const startIdx of withinBand) {
    if (visited.has(startIdx)) continue;
    const queue = [startIdx];
    visited.add(startIdx);
    const cluster: number[] = [];
    while (queue.length > 0) {
      const idx = queue.shift()!;
      cluster.push(idx);
      const row = Math.floor(idx / width);
      const col = idx % width;
      const neighbors = [
        row > 0 ? idx - width : -1,
        row + 1 < height ? idx + width : -1,
        col > 0 ? idx - 1 : -1,
        col + 1 < width ? idx + 1 : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && inBand.has(next) && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    if (cluster.length > best.length) best = cluster;
  }

  const droppedPeripheral = withinBand.length - best.length;
  const totalDropped = droppedHeightOutliers + droppedPeripheral;
  if (best.length < minKeepCells || totalDropped > maxStrayFraction * cells.length) {
    return noop;
  }

  return {
    cells: best,
    droppedHeightOutliers,
    droppedPeripheral,
    medianHeight,
    changed: totalDropped > 0,
  };
}

/** Tuning for {@link estimateDenseFloorSeed}. */
export interface DenseSeedOptions {
  /** Master switch. Defaults to `true` (built-in, on by default). */
  readonly enabled?: boolean;
  /** Height histogram bin size (meters) used to find the dense floor band. Defaults to `0.25`. */
  readonly heightBin?: number;
  /**
   * Keep only cells at/above this density percentile when locating the dense
   * floor (0..1). Higher = stricter, ignores more sparse strays. Defaults to `0.6`.
   */
  readonly densityPercentile?: number;
  /**
   * Minimum horizontal/vertical move (meters) from the current seed before a
   * re-seed + field rebuild is worthwhile. Defaults to `2.0`.
   */
  readonly reseedThreshold?: number;
}

function cellCenterWorld(field: WalkableGroundFieldResult, idx: number): [number, number, number] {
  const width = field.width;
  const row = Math.floor(idx / width);
  const col = idx % width;
  const cell = field.cells[idx];
  const h = Number.isFinite(cell.height) ? cell.height : 0;
  const o = field.basis.origin;
  const t = field.basis.tangent;
  const b = field.basis.bitangent;
  const u = field.basis.up;
  const c = col + 0.5;
  const r = row + 0.5;
  return [
    o[0] + t[0] * c * field.cell_size + b[0] * r * field.cell_size + u[0] * h,
    o[1] + t[1] * c * field.cell_size + b[1] * r * field.cell_size + u[1] * h,
    o[2] + t[2] * c * field.cell_size + b[2] * r * field.cell_size + u[2] * h,
  ];
}

interface DenseFloorCore {
  /** Indices of the dense floor-band cells. */
  readonly cells: number[];
  /** Density-weighted modal floor height (oriented Y). */
  readonly modalHeight: number;
  /** Density-weighted centroid of the dense floor band. */
  readonly centroid: [number, number, number];
}

/**
 * Find the dense floor band: among cells carrying real surface density, keep the
 * densest fraction, take the density-weighted modal height (where most splats
 * actually sit), and return that band's cells + density-weighted centroid. Sparse
 * peripheral/under-floor floaters contribute little weight and fall outside the
 * modal band, so they are effectively ignored.
 */
function computeDenseFloorCore(
  field: WalkableGroundFieldResult,
  heightBin: number,
  densityPercentile: number
): DenseFloorCore | null {
  const candidates: Array<{ idx: number; height: number; density: number }> = [];
  for (let i = 0; i < field.cells.length; i++) {
    const cell = field.cells[i];
    if (!Number.isFinite(cell.height)) continue;
    const density = Math.max(cell.peak_density ?? 0, cell.surface_confidence ?? 0);
    if (density <= 0) continue;
    candidates.push({ idx: i, height: cell.height, density });
  }
  if (candidates.length < 8) return null;

  const sortedDensity = candidates.map((c) => c.density).sort((a, b) => a - b);
  const threshold = sortedDensity[Math.min(sortedDensity.length - 1, Math.floor(sortedDensity.length * densityPercentile))];
  const dense = candidates.filter((c) => c.density >= threshold);
  if (dense.length === 0) return null;

  const bins = new Map<number, number>();
  for (const c of dense) {
    const bin = Math.round(c.height / heightBin);
    bins.set(bin, (bins.get(bin) ?? 0) + c.density);
  }
  let modalBin = 0;
  let modalWeight = -1;
  for (const [bin, weight] of bins) {
    if (weight > modalWeight) {
      modalWeight = weight;
      modalBin = bin;
    }
  }
  const modalHeight = modalBin * heightBin;

  const core = dense.filter((c) => Math.abs(c.height - modalHeight) <= heightBin);
  if (core.length === 0) return null;

  let wx = 0;
  let wy = 0;
  let wz = 0;
  let ws = 0;
  for (const c of core) {
    const center = cellCenterWorld(field, c.idx);
    wx += center[0] * c.density;
    wy += center[1] * c.density;
    wz += center[2] * c.density;
    ws += c.density;
  }
  if (ws <= 0) return null;
  return {
    cells: core.map((c) => c.idx),
    modalHeight,
    centroid: [wx / ws, wy / ws, wz / ws],
  };
}

/**
 * Estimate a collision seed located in the DENSE floor area of the scene, so the
 * pipeline anchors on the real room floor instead of a sparse floater plane below
 * it (the common failure on large, floater-heavy scans). Returns `fallbackSeed`
 * when there isn't enough signal to be confident.
 */
export function estimateDenseFloorSeed(
  field: WalkableGroundFieldResult,
  fallbackSeed: number[],
  options: DenseSeedOptions = {}
): number[] {
  if (!(options.enabled ?? true)) return fallbackSeed;
  const core = computeDenseFloorCore(field, options.heightBin ?? 0.25, options.densityPercentile ?? 0.6);
  return core ? core.centroid : fallbackSeed;
}

/**
 * Estimate an adapted default region (oriented-space AABB) around the dense floor:
 * generous in XZ (covers the whole floor band) but tightly clamped in Y to the
 * floor plus walkable headroom. This excludes deep stray floaters below/above the
 * real floor so floor detection is no longer dragged off the dense area. Returns
 * `null` when there isn't enough signal.
 */
export function estimateDenseFloorRegion(
  field: WalkableGroundFieldResult,
  options: DenseSeedOptions = {}
): { min: number[]; max: number[] } | null {
  if (!(options.enabled ?? true)) return null;
  const core = computeDenseFloorCore(field, options.heightBin ?? 0.25, options.densityPercentile ?? 0.6);
  if (!core) return null;

  const yMin = core.modalHeight - 0.6;
  const yMax = core.modalHeight + 3.0;

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (let i = 0; i < field.cells.length; i++) {
    const cell = field.cells[i];
    if (!Number.isFinite(cell.height)) continue;
    if (cell.height < yMin || cell.height > yMax) continue;
    const center = cellCenterWorld(field, i);
    if (center[0] < minX) minX = center[0];
    if (center[0] > maxX) maxX = center[0];
    if (center[2] < minZ) minZ = center[2];
    if (center[2] > maxZ) maxZ = center[2];
    any = true;
  }
  if (!any) return null;

  const margin = field.cell_size * 2;
  return {
    min: [minX - margin, yMin, minZ - margin],
    max: [maxX + margin, yMax, maxZ + margin],
  };
}

export interface FastFloorMesh {
  positions: Float32Array;
  indices: Uint32Array;
  selectedCellCount: number;
  acceptedCellCount: number;
  obstacleCellCount: number;
  rejectedCellCount: number;
  selectedArea: number;
  centroid: [number, number, number];
  componentCount: number;
  fallbackUsed: boolean;
  seedDistance: number;
  /** Number of enclosed void/low-confidence cells bridged back into the floor. */
  bridgedCellCount: number;
}

/**
 * Build a planar floor mesh from a walkable ground field by selecting the best
 * connected floor component near the seed. Throws a typed {@link FastNavFloorError}
 * when no usable floor of at least `minRoomFloorArea` square meters is found, so
 * callers can escalate extraction parameters and retry. A small number of stray
 * peripheral cells are ignored via {@link trimStrayFloorCells} (configurable).
 */
export function buildFastFloorMesh(
  field: WalkableGroundFieldResult,
  seed: number[] | null,
  minRoomFloorArea: number,
  log: FastNavLogger,
  strayTrim?: StrayTrimOptions,
  floorFlattenTolerance: number = DEFAULT_FLOOR_FLATTEN_TOLERANCE
): FastFloorMesh {
  const width = field.width;
  const height = field.height;
  const stateCounts = field.cells.reduce<Record<string, number>>((counts, cell) => {
    counts[cell.state] = (counts[cell.state] ?? 0) + 1;
    return counts;
  }, {});
  const obstacleCellCount = (stateCounts.obstacle ?? 0) + (stateCounts.height_variance ?? 0);

  const origin = field.basis.origin;
  const tangent = field.basis.tangent;
  const bitangent = field.basis.bitangent;
  const up = field.basis.up;
  const pointAt = (col: number, row: number, cellHeight: number): [number, number, number] => [
    origin[0] + tangent[0] * col * field.cell_size + bitangent[0] * row * field.cell_size + up[0] * cellHeight,
    origin[1] + tangent[1] * col * field.cell_size + bitangent[1] * row * field.cell_size + up[1] * cellHeight,
    origin[2] + tangent[2] * col * field.cell_size + bitangent[2] * row * field.cell_size + up[2] * cellHeight,
  ];
  const cellCenter = (idx: number): [number, number, number] => {
    const row = Math.floor(idx / width);
    const col = idx % width;
    const cell = field.cells[idx];
    return pointAt(col + 0.5, row + 0.5, Number.isFinite(cell.height) ? cell.height : 0);
  };

  const buildMask = (relaxed: boolean): boolean[] =>
    field.cells.map((cell) => {
      if (cell.state === 'walkable' || cell.state === 'filled') return true;
      if (!relaxed) return false;
      if (!Number.isFinite(cell.height)) return false;
      if (cell.state === 'discarded_component') return true;
      if (cell.state === 'low_confidence') {
        return cell.variance <= 0.18 && cell.obstacle_score <= 0.42;
      }
      if (cell.state === 'height_variance') {
        return cell.confidence >= 0.01 && cell.variance <= 0.08 && cell.obstacle_score <= 0.35;
      }
      if (cell.state === 'obstacle') {
        return cell.confidence >= 0.02 && cell.variance <= 0.05 && cell.obstacle_score <= 0.52;
      }
      return false;
    });

  interface Component {
    cells: number[];
    centroid: [number, number, number];
    distanceToSeed: number;
  }

  const collectComponents = (mask: boolean[]): Component[] => {
    const visited = new Uint8Array(field.cells.length);
    const components: Component[] = [];
    for (let start = 0; start < field.cells.length; start++) {
      if (!mask[start] || visited[start]) continue;
      const queue = [start];
      const cells: number[] = [];
      visited[start] = 1;
      let sx = 0;
      let sy = 0;
      let sz = 0;

      while (queue.length > 0) {
        const idx = queue.shift()!;
        cells.push(idx);
        const center = cellCenter(idx);
        sx += center[0];
        sy += center[1];
        sz += center[2];
        const row = Math.floor(idx / width);
        const col = idx % width;
        const neighbors = [
          row > 0 ? idx - width : -1,
          row + 1 < height ? idx + width : -1,
          col > 0 ? idx - 1 : -1,
          col + 1 < width ? idx + 1 : -1,
        ];
        for (const next of neighbors) {
          if (next >= 0 && mask[next] && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }

      const inv = 1 / cells.length;
      const centroid: [number, number, number] = [sx * inv, sy * inv, sz * inv];
      const distanceToSeed = seed
        ? Math.hypot(centroid[0] - seed[0], centroid[1] - seed[1], centroid[2] - seed[2])
        : 0;
      components.push({ cells, centroid, distanceToSeed });
    }
    return components;
  };

  const selectComponent = (
    components: Component[]
  ): { selected: Component; usedLargestFallback: boolean } | null => {
    const minCells = 20;
    const minArea = 1.2;
    const maxSeedDistance = 3.25;
    const viableComponents = components.filter((component) => {
      const area = component.cells.length * field.cell_size * field.cell_size;
      return component.cells.length >= minCells && area >= minArea;
    });
    if (viableComponents.length === 0) return null;
    const seedNear = seed
      ? viableComponents.filter((component) => component.distanceToSeed <= maxSeedDistance)
      : viableComponents;
    const candidates = seedNear.length > 0 ? seedNear : viableComponents;
    candidates.sort((a, b) => {
      if (!seed || seedNear.length === 0) return b.cells.length - a.cells.length;
      const score = (component: Component): number => {
        const area = component.cells.length * field.cell_size * field.cell_size;
        return component.distanceToSeed - Math.sqrt(area) * 0.45;
      };
      return score(a) - score(b) || b.cells.length - a.cells.length;
    });
    const selected = candidates[0];
    return {
      selected,
      usedLargestFallback: seedNear.length === 0 && !!seed,
    };
  };

  const areaOfSelection = (sel: { selected: { cells: number[] } }): number =>
    sel.selected.cells.length * field.cell_size * field.cell_size;

  // Bridge small enclosed gaps (seams, painted lines, reflective patches that read
  // as void / low_confidence) that are fully surrounded by accepted floor, so they
  // do not split an otherwise-continuous flat floor into separate fragments. Gaps
  // touching the grid border or adjacent to a real obstacle/discontinuity are left
  // alone, as are holes larger than MAX_BRIDGE_GAP_CELLS (treated as real openings).
  const bridgeEnclosedGaps = (mask: boolean[]): number => {
    const isBridgeable = (state: string): boolean =>
      state === 'void' || state === 'low_confidence';
    const visited = new Uint8Array(field.cells.length);
    let bridged = 0;
    for (let start = 0; start < field.cells.length; start++) {
      if (mask[start] || visited[start]) continue;
      visited[start] = 1;
      if (!isBridgeable(field.cells[start].state)) continue;

      const queue = [start];
      const run: number[] = [];
      let enclosedByFloor = true;
      let touchesBorder = false;
      while (queue.length > 0) {
        const idx = queue.shift()!;
        run.push(idx);
        const row = Math.floor(idx / width);
        const col = idx % width;
        if (row === 0 || col === 0 || row + 1 === height || col + 1 === width) {
          touchesBorder = true;
        }
        const neighbors = [
          row > 0 ? idx - width : -1,
          row + 1 < height ? idx + width : -1,
          col > 0 ? idx - 1 : -1,
          col + 1 < width ? idx + 1 : -1,
        ];
        for (const next of neighbors) {
          if (next < 0) continue;
          if (mask[next]) continue; // accepted floor: a valid hole boundary
          if (isBridgeable(field.cells[next].state)) {
            if (!visited[next]) {
              visited[next] = 1;
              queue.push(next);
            }
          } else {
            // adjacent to a real obstacle/discontinuity: not a floor-enclosed hole
            enclosedByFloor = false;
          }
        }
      }

      if (enclosedByFloor && !touchesBorder && run.length <= MAX_BRIDGE_GAP_CELLS) {
        for (const idx of run) {
          mask[idx] = true;
        }
        bridged += run.length;
      }
    }
    return bridged;
  };

  const strictMask = buildMask(false);
  const bridgedCellCount = bridgeEnclosedGaps(strictMask);
  const acceptedCellCount = strictMask.filter(Boolean).length;
  const rejectedCellCount = field.cells.length - acceptedCellCount;
  const strictComponents = collectComponents(strictMask);
  let selection = selectComponent(strictComponents);
  let selectedMask = strictMask;
  let components = strictComponents;
  let fallbackUsed = false;

  if (!selection || areaOfSelection(selection) < minRoomFloorArea) {
    const relaxedMask = buildMask(true);
    bridgeEnclosedGaps(relaxedMask);
    const relaxedComponents = collectComponents(relaxedMask);
    const relaxedSelection = selectComponent(relaxedComponents);
    if (relaxedSelection && (!selection || areaOfSelection(relaxedSelection) > areaOfSelection(selection))) {
      selection = relaxedSelection;
      selectedMask = relaxedMask;
      components = relaxedComponents;
      fallbackUsed = true;
      log(
        `[WARN] Fast floor relaxed mask used: strictComponents=${strictComponents.length}, ` +
          `relaxedComponents=${relaxedComponents.length}, states=${JSON.stringify(stateCounts)}`
      );
    }
  }

  if (!selection) {
    const largest = [...components].sort((a, b) => b.cells.length - a.cells.length)[0];
    const largestArea = largest ? largest.cells.length * field.cell_size * field.cell_size : 0;
    throw new FastNavFloorError(
      'no_component',
      `Fast nav could not find a viable floor component. ` +
        `Components=${components.length}, largest=${largest?.cells.length ?? 0} cells ` +
        `(${largestArea.toFixed(2)} m^2), states=${JSON.stringify(stateCounts)}. ` +
        `Try a different splat with a clearer room floor.`,
      { area: largestArea, components: components.length, stateCounts }
    );
  }

  const selected = selection.selected;

  // Ignore a small number of stray peripheral cells/floaters so the floor stays a
  // clean, contiguous plane that Recast won't shatter into tiny islands.
  const trimmed = trimStrayFloorCells(field, selected.cells, strayTrim);
  const floorCells = trimmed.cells;
  if (trimmed.changed) {
    log(
      `[INFO] Fast floor stray trim: dropped ${trimmed.droppedHeightOutliers} height-outlier + ` +
        `${trimmed.droppedPeripheral} peripheral cell(s), kept ${floorCells.length} ` +
        `(median floor y=${trimmed.medianHeight.toFixed(3)}).`
    );
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const idx of floorCells) {
    const center = cellCenter(idx);
    cx += center[0];
    cy += center[1];
    cz += center[2];
  }
  const invFloor = floorCells.length > 0 ? 1 / floorCells.length : 0;
  const floorCentroid: [number, number, number] = [cx * invFloor, cy * invFloor, cz * invFloor];

  const selectedArea = floorCells.length * field.cell_size * field.cell_size;
  if (selectedArea < minRoomFloorArea) {
    throw new FastNavFloorError(
      'too_small',
      `Fast nav floor is too small to be a room (${selectedArea.toFixed(2)} m^2 < ` +
        `${minRoomFloorArea.toFixed(1)} m^2). components=${components.length}, ` +
        `accepted=${acceptedCellCount}, states=${JSON.stringify(stateCounts)}.`,
      { area: selectedArea, components: components.length, stateCounts }
    );
  }
  if (selection.usedLargestFallback) {
    fallbackUsed = true;
    log(
      `[WARN] Fast floor used largest viable island because no viable component was close to the seed: ` +
        `${floorCells.length} cells, ${selectedArea.toFixed(2)} m^2, ` +
        `seedDistance=${selected.distanceToSeed.toFixed(2)}`
    );
  } else if (components[0] !== selected) {
    log(
      `[WARN] Fast floor ignored tiny or weak seed-near fragments and selected a viable floor island: ` +
        `${floorCells.length} cells, ${selectedArea.toFixed(2)} m^2, ` +
        `seedDistance=${selected.distanceToSeed.toFixed(2)}`
    );
  }

  // Emit a single connected, shared-vertex surface instead of one independent quad
  // per cell. Each grid corner gets ONE vertex whose height is the average of the
  // accepted cells touching it, then snapped to the dominant floor plane when within
  // `floorFlattenTolerance`. This keeps neighbouring cells C0-continuous so Recast
  // does not shatter a flat floor on per-cell height noise / vertical cracks.
  const floorSet = new Set(floorCells);
  const floorPlaneHeight = field.diagnostics.floor_plane_height;
  const planeUsable = Number.isFinite(floorPlaneHeight);
  const cornerCols = width + 1;
  const cornerKey = (cc: number, rr: number): number => rr * cornerCols + cc;
  const cornerHeights = new Map<number, number>();
  const cornerHeightAt = (cc: number, rr: number): number => {
    const key = cornerKey(cc, rr);
    const cached = cornerHeights.get(key);
    if (cached !== undefined) return cached;
    let sum = 0;
    let count = 0;
    for (let dr = -1; dr <= 0; dr++) {
      for (let dc = -1; dc <= 0; dc++) {
        const col = cc + dc;
        const row = rr + dr;
        if (col < 0 || row < 0 || col >= width || row >= height) continue;
        const cidx = row * width + col;
        if (!floorSet.has(cidx)) continue;
        const ch = field.cells[cidx]?.height;
        if (Number.isFinite(ch)) {
          sum += ch as number;
          count += 1;
        }
      }
    }
    let h = count > 0 ? sum / count : planeUsable ? (floorPlaneHeight as number) : 0;
    if (planeUsable && Math.abs(h - (floorPlaneHeight as number)) <= floorFlattenTolerance) {
      h = floorPlaneHeight as number;
    }
    cornerHeights.set(key, h);
    return h;
  };

  const positions: number[] = [];
  const indices: number[] = [];
  const cornerVertices = new Map<number, number>();
  const cornerVertex = (cc: number, rr: number): number => {
    const key = cornerKey(cc, rr);
    const existing = cornerVertices.get(key);
    if (existing !== undefined) return existing;
    const p = pointAt(cc, rr, cornerHeightAt(cc, rr));
    const vi = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    cornerVertices.set(key, vi);
    return vi;
  };
  for (const idx of floorCells) {
    const row = Math.floor(idx / width);
    const col = idx % width;
    const v00 = cornerVertex(col, row);
    const v01 = cornerVertex(col, row + 1);
    const v11 = cornerVertex(col + 1, row + 1);
    const v10 = cornerVertex(col + 1, row);
    indices.push(v00, v01, v11, v00, v11, v10);
  }

  log(
    `[INFO] Fast floor field: accepted=${acceptedCellCount}, obstacles=${obstacleCellCount}, ` +
      `rejected=${rejectedCellCount}, bridged=${bridgedCellCount}, components=${components.length}, ` +
      `selectedCells=${floorCells.length}, selectedArea=${selectedArea.toFixed(2)}, ` +
      `vertices=${positions.length / 3}, maskCells=${selectedMask.filter(Boolean).length}`
  );

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    selectedCellCount: floorCells.length,
    acceptedCellCount,
    obstacleCellCount,
    rejectedCellCount,
    selectedArea,
    centroid: floorCentroid,
    componentCount: components.length,
    fallbackUsed,
    seedDistance: selected.distanceToSeed,
    bridgedCellCount,
  };
}

/** Builds a walkable ground field from splat bytes + settings (the WASM core call). */
export type WalkableGroundFieldBuilder = (
  bytes: Uint8Array,
  settings: MeshSettings
) => Promise<WalkableGroundFieldResult>;

/** Arguments for {@link extractFloorFieldWithRecovery}. */
export interface ExtractFloorFieldArgs {
  /** Raw, already-decompressed splat bytes. */
  readonly bytes: Uint8Array;
  /**
   * Field builder used for each attempt. Inject the WASM core's
   * `build_walkable_ground_field` (via the bridge) so this module stays
   * framework-agnostic and does not import the bridge/worker itself.
   */
  readonly buildField: WalkableGroundFieldBuilder;
  /** Base fast-field {@link MeshSettings} that each recovery step is merged over. */
  readonly baseSettings: MeshSettings;
  /** Carve seed in oriented space; snapped to the detected floor plane per attempt. */
  readonly seed: number[];
  /** Resolved recovery ladder (use {@link resolveRecovery} to fill defaults). */
  readonly recovery: FastNavRecoveryConfig;
  /** Default stray-floater trimming for steps that don't specify their own. */
  readonly strayTrim?: StrayTrimOptions;
  /** Density-aware re-seeding to anchor on the dense floor (on by default). */
  readonly denseSeed?: DenseSeedOptions;
  /** Progress sink. */
  readonly log: FastNavLogger;
}

/** Successful result of {@link extractFloorFieldWithRecovery}. */
export interface ExtractFloorFieldResult {
  readonly field: WalkableGroundFieldResult;
  readonly floorMesh: FastFloorMesh;
  /** Seed snapped to the floor plane of the winning attempt. */
  readonly effectiveSeed: number[];
  /** Label of the recovery step that produced the floor. */
  readonly stepLabel: string;
}

/**
 * Run floor-field extraction with the built-in adaptive recovery ladder: for each
 * step, merge its settings over `baseSettings`, build the walkable ground field,
 * snap the seed to the detected floor plane, then build the floor mesh with that
 * step's `minRoomFloorArea`. On a {@link FastNavFloorError} (including an empty
 * mesh) it logs and escalates to the next step. The first success wins; if every
 * step fails it throws an aggregated {@link FastNavFloorError}.
 */
export async function extractFloorFieldWithRecovery(args: ExtractFloorFieldArgs): Promise<ExtractFloorFieldResult> {
  const { bytes, buildField, baseSettings, seed, recovery, strayTrim, denseSeed, log } = args;
  const steps = recovery.steps;
  const reseedThreshold = denseSeed?.reseedThreshold ?? 2.0;
  const denseSeedEnabled = denseSeed?.enabled ?? true;
  let lastError: FastNavFloorError | null = null;
  const attempted: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const hasMore = i < steps.length - 1;
    const settings: MeshSettings = { ...baseSettings, ...step.settings };

    try {
      let field = await buildField(bytes, settings);
      let effectiveSeed = seed;
      const floorPlaneY = field.diagnostics.floor_plane_height;
      if (Number.isFinite(floorPlaneY)) {
        effectiveSeed = [seed[0], floorPlaneY, seed[2]];
        log(`[INFO] Snapped fast seed to floor plane y=${floorPlaneY.toFixed(3)} (step "${step.label}")`);
      }

      // Anchor on the dense floor area (where most splats actually sit) instead of
      // a sparse floater plane below it; rebuild the field around the dense seed
      // AND with a default region adapted to the dense floor band, so deep stray
      // floaters below/above the real floor no longer drag floor detection off.
      if (denseSeedEnabled) {
        const dense = estimateDenseFloorSeed(field, effectiveSeed, denseSeed);
        const movedXZ = Math.hypot(dense[0] - effectiveSeed[0], dense[2] - effectiveSeed[2]);
        const movedY = Math.abs(dense[1] - effectiveSeed[1]);
        if (movedXZ > reseedThreshold || movedY > reseedThreshold) {
          const rebuild: MeshSettings = { ...settings, collision_seed: dense };
          // Only adapt the default region when the caller hasn't pinned one.
          if (!settings.region_min || !settings.region_max) {
            const region = estimateDenseFloorRegion(field, denseSeed);
            if (region) {
              rebuild.region_min = region.min;
              rebuild.region_max = region.max;
              log(
                `[INFO] FAST NAV adapting default region to dense floor band ` +
                  `(y ${region.min[1].toFixed(2)}..${region.max[1].toFixed(2)}) (step "${step.label}").`
              );
            }
          }
          log(
            `[INFO] FAST NAV re-seeding to dense floor area ` +
              `(${dense.map((v) => v.toFixed(2)).join(', ')}; moved ${movedXZ.toFixed(1)}m XZ, ${movedY.toFixed(1)}m Y) (step "${step.label}").`
          );
          field = await buildField(bytes, rebuild);
          const reFloorY = field.diagnostics.floor_plane_height;
          effectiveSeed = Number.isFinite(reFloorY) ? [dense[0], reFloorY, dense[2]] : dense;
        }
      }

      const floorMesh = buildFastFloorMesh(
        field,
        effectiveSeed,
        step.minRoomFloorArea,
        log,
        step.strayTrim ?? strayTrim
      );
      if (floorMesh.positions.length === 0 || floorMesh.indices.length === 0) {
        throw new FastNavFloorError('empty_mesh', 'Fast nav produced an empty floor mesh.', {
          components: floorMesh.componentCount,
        });
      }

      if (i > 0) {
        log(
          `[SUCCESS] FAST NAV recovery succeeded on step "${step.label}" ` +
            `after ${i} escalation(s): area=${floorMesh.selectedArea.toFixed(2)} m^2.`
        );
      }
      return { field, floorMesh, effectiveSeed, stepLabel: step.label };
    } catch (error) {
      if (!(error instanceof FastNavFloorError)) {
        throw error;
      }
      lastError = error;
      const areaStr = error.area !== undefined ? `${error.area.toFixed(2)} m^2` : 'n/a';
      attempted.push(`${step.label}(${error.reason})`);
      log(
        `[WARN] FAST NAV recovery: step "${step.label}" failed (${error.reason}, ${areaStr})` +
          (hasMore ? '; escalating extraction parameters...' : '.')
      );
    }
  }

  const summary = attempted.join(' -> ');
  if (lastError) {
    throw new FastNavFloorError(
      lastError.reason,
      `FAST NAV floor extraction failed after ${steps.length} recovery step(s): ${summary}. ${lastError.message}`,
      { area: lastError.area, components: lastError.components, stateCounts: lastError.stateCounts }
    );
  }
  throw new FastNavFloorError('no_component', 'FAST NAV recovery had no configured steps.');
}
