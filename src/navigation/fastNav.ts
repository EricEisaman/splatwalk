import type { Vector3 } from '@babylonjs/core';

import NavWorker from '@/navigation/navmesh.worker?worker';
import type { Viewer } from '@/scene/Viewer';
import { splatwalk, type MeshSettings, type WalkableGroundFieldResult } from '@/wasm/bridge';

/** A single human-readable progress line, optionally tagged with `[INFO]`, `[WAIT]`, `[WARN]`, `[SUCCESS]`. */
export type FastNavLogger = (message: string) => void;

/** Options for {@link runFastNav}. */
export interface FastNavOptions {
  /** The Babylon viewer that already has the splat loaded. */
  readonly viewer: Viewer;
  /** Raw, already-decompressed splat bytes (see {@link readSplatBytes}). */
  readonly bytes: Uint8Array;
  /** Optional progress sink; defaults to the console. */
  readonly onLog?: FastNavLogger;
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

interface RecastParams {
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
}

interface NavIslandMetadata {
  readonly area: number;
  readonly centroid: [number, number, number];
  readonly distanceToSeed: number;
  readonly triangleCount: number;
  readonly islandCount: number;
}

/**
 * Read splat bytes from a `.ply` or `.spz` file. `.spz` files are gzip-compressed
 * and decompressed in-browser via `DecompressionStream`.
 */
export async function readSplatBytes(file: File): Promise<Uint8Array> {
  let buffer: ArrayBuffer;

  if (file.name.toLowerCase().endsWith('.spz')) {
    if (!('DecompressionStream' in window)) {
      throw new Error('Browser does not support DecompressionStream. Cannot read .spz files.');
    }
    const ds = new DecompressionStream('gzip');
    const decompressedStream = file.stream().pipeThrough(ds);
    buffer = await new Response(decompressedStream).arrayBuffer();
  } else {
    buffer = await file.arrayBuffer();
  }

  return new Uint8Array(buffer);
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

function ensureFastCollisionSeed(
  viewer: Viewer,
  bytes: Uint8Array,
  base: MeshSettings,
  log: FastNavLogger
): number[] {
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
    const suggested = splatwalk.suggestRegion(bytes, base);
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

interface FastFloorMesh {
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
}

function buildFastFloorMesh(
  field: WalkableGroundFieldResult,
  seed: number[] | null,
  log: FastNavLogger
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

  const MIN_ROOM_FLOOR_AREA = 4.0;
  const areaOfSelection = (sel: { selected: { cells: number[] } }): number =>
    sel.selected.cells.length * field.cell_size * field.cell_size;

  const strictMask = buildMask(false);
  const acceptedCellCount = strictMask.filter(Boolean).length;
  const rejectedCellCount = field.cells.length - acceptedCellCount;
  const strictComponents = collectComponents(strictMask);
  let selection = selectComponent(strictComponents);
  let selectedMask = strictMask;
  let components = strictComponents;
  let fallbackUsed = false;

  if (!selection || areaOfSelection(selection) < MIN_ROOM_FLOOR_AREA) {
    const relaxedMask = buildMask(true);
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
    throw new Error(
      `Fast nav could not find a viable floor component. ` +
        `Components=${components.length}, largest=${largest?.cells.length ?? 0} cells ` +
        `(${largestArea.toFixed(2)} m^2), states=${JSON.stringify(stateCounts)}. ` +
        `Try a different splat with a clearer room floor.`
    );
  }

  const selected = selection.selected;
  const selectedArea = selected.cells.length * field.cell_size * field.cell_size;
  if (selectedArea < MIN_ROOM_FLOOR_AREA) {
    throw new Error(
      `Fast nav floor is too small to be a room (${selectedArea.toFixed(2)} m^2 < ` +
        `${MIN_ROOM_FLOOR_AREA.toFixed(1)} m^2). components=${components.length}, ` +
        `accepted=${acceptedCellCount}, states=${JSON.stringify(stateCounts)}.`
    );
  }
  if (selection.usedLargestFallback) {
    fallbackUsed = true;
    log(
      `[WARN] Fast floor used largest viable island because no viable component was close to the seed: ` +
        `${selected.cells.length} cells, ${selectedArea.toFixed(2)} m^2, ` +
        `seedDistance=${selected.distanceToSeed.toFixed(2)}`
    );
  } else if (components[0] !== selected) {
    log(
      `[WARN] Fast floor ignored tiny or weak seed-near fragments and selected a viable floor island: ` +
        `${selected.cells.length} cells, ${selectedArea.toFixed(2)} m^2, ` +
        `seedDistance=${selected.distanceToSeed.toFixed(2)}`
    );
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (const idx of selected.cells) {
    const row = Math.floor(idx / width);
    const col = idx % width;
    const cell = field.cells[idx];
    const h = Number.isFinite(cell.height) ? cell.height : 0;
    const base = positions.length / 3;
    const p00 = pointAt(col, row, h);
    const p01 = pointAt(col, row + 1, h);
    const p11 = pointAt(col + 1, row + 1, h);
    const p10 = pointAt(col + 1, row, h);
    positions.push(...p00, ...p01, ...p11, ...p10);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  log(
    `[INFO] Fast floor field: accepted=${acceptedCellCount}, obstacles=${obstacleCellCount}, ` +
      `rejected=${rejectedCellCount}, components=${components.length}, ` +
      `selectedCells=${selected.cells.length}, selectedArea=${selectedArea.toFixed(2)}, ` +
      `maskCells=${selectedMask.filter(Boolean).length}`
  );

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    selectedCellCount: selected.cells.length,
    acceptedCellCount,
    obstacleCellCount,
    rejectedCellCount,
    selectedArea,
    centroid: selected.centroid,
    componentCount: components.length,
    fallbackUsed,
    seedDistance: selected.distanceToSeed,
  };
}

function triangleArea(positions: Float32Array, i0: number, i1: number, i2: number): number {
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

function filterNavmeshIslandNearSeed(
  positions: Float32Array,
  indices: Uint32Array,
  seed: number[] | null,
  log: FastNavLogger
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
    });
  }

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

function validateFastNavIsland(
  metadata: NavIslandMetadata | null,
  seed: number[] | null,
  expectedFloorY: number | null,
  log: FastNavLogger
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

function chooseNpcSpawnPoint(
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
 * retry ladder) -> crowd + player + NPC. Mirrors the workbench "FAST NAV" button.
 */
export async function runFastNav(options: FastNavOptions): Promise<FastNavResult> {
  const { viewer, bytes } = options;
  const log: FastNavLogger = options.onLog ?? ((message: string): void => console.log(message));

  log('[WAIT] Fast path: splat -> floor field -> navmesh -> NPC...');

  const base = defaultFastMeshSettings(viewer);
  const fastSeed = ensureFastCollisionSeed(viewer, bytes, base, log);
  const navSettings = buildFastFieldSettings(base, fastSeed);
  let effectiveFastSeed: number[] = navSettings.collision_seed ?? fastSeed;

  const field = splatwalk.buildWalkableGroundField(bytes, navSettings);
  const floorPlaneY = field.diagnostics.floor_plane_height;
  if (Number.isFinite(floorPlaneY)) {
    effectiveFastSeed = [effectiveFastSeed[0], floorPlaneY, effectiveFastSeed[2]];
    log(`[INFO] Snapped fast seed to floor plane y=${floorPlaneY.toFixed(3)}`);
  }

  const floorMesh = buildFastFloorMesh(field, effectiveFastSeed, log);
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

  const baseParams: RecastParams = {
    cs: 0.12,
    ch: 0.1,
    walkableHeight: 1.7,
    walkableRadius: 0.45,
    walkableClimb: 0.25,
    walkableSlopeAngle: 28,
    maxEdgeLen: 12,
    maxSimplificationError: 0.5,
    minRegionArea: 24,
    mergeRegionArea: 36,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  };

  const attempts: ReadonlyArray<{ label: string; params: RecastParams }> = [
    { label: 'strict', params: baseParams },
    {
      label: 'balanced',
      params: {
        ...baseParams,
        cs: 0.15,
        ch: 0.12,
        walkableHeight: 1.4,
        walkableRadius: 0.32,
        walkableClimb: 0.4,
        walkableSlopeAngle: 38,
        maxSimplificationError: 0.8,
        minRegionArea: 8,
        mergeRegionArea: 16,
      },
    },
    {
      label: 'recovery',
      params: {
        ...baseParams,
        cs: 0.18,
        ch: 0.14,
        walkableHeight: 1.2,
        walkableRadius: 0.25,
        walkableClimb: 0.55,
        walkableSlopeAngle: 45,
        maxSimplificationError: 1.0,
        minRegionArea: 2,
        mergeRegionArea: 8,
      },
    },
  ];

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

  log('[WAIT] Rendering NavMesh overlay...');
  const spawnPoint = await viewer.displayNavMesh(result.debugPositions, result.debugIndices, 0);
  if (spawnPoint) {
    const npcSpawn = chooseNpcSpawnPoint(result.debugPositions, result.debugIndices, spawnPoint);
    viewer.setPreferredNavSpawnPoints([spawnPoint.x, spawnPoint.y, spawnPoint.z], npcSpawn);
    log(`[INFO] Player agent spawn: ${spawnPoint.x.toFixed(3)}, ${spawnPoint.y.toFixed(3)}, ${spawnPoint.z.toFixed(3)}`);
  }

  log('[WAIT] Initializing NPC crowd simulation...');
  await viewer.initCrowd(result.navMeshData, spawnPoint);
  viewer.addNPC();
  log('[SUCCESS] Fast path complete: navmesh ready, NPC spawned.');

  return { navMeshData: result.navMeshData, playerSpawn: spawnPoint };
}
