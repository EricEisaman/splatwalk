/**
 * Voxel walk on an exported collision volume: solid DDA raycasts, XZ steer toward
 * click goals, solid ground probes, and capsule clearance — SuperSplat Viewer parity
 * (not BFS / not floor-cell graphs for locomotion).
 */

import type { CollisionVoxelVolume } from '@/wasm/bridge';

const DEFAULT_AGENT_RADIUS = 0.2;
const DEFAULT_AGENT_HEIGHT = 1.6;
const DEFAULT_STEP_UP = 0.75;
const MOVE_SPEED_METERS_PER_SEC = 4;
const ARRIVAL_DIST_XZ = 0.5;
const BLOCKED_SPEED = 0.6;
const BLOCKED_DURATION_SEC = 0.6;
/** Matches supersplat-viewer WalkController.groundProbeRange. */
const GROUND_PROBE_RANGE = 1.0;
/** Matches supersplat-viewer WalkController.eyeHeight (probe origin above floor). */
const GROUND_PROBE_EYE_HEIGHT = 1.3;
/** Matches supersplat-viewer find-spawn.ts SEARCH_RADIUS. */
const SPAWN_SEARCH_RADIUS = 5;
const SPAWN_RAY_MAX_DIST = 1000;
/** Accept cylinder floors near the modal deck Y (main floor plate). */
const DECK_Y_BAND = 0.35;

export interface VoxelWalkCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VoxelRayHit {
  readonly distance: number;
  readonly normal: [number, number, number];
  readonly position: [number, number, number];
}

export interface VoxelWalkRuntimeOptions {
  readonly agentHeight?: number;
  readonly agentRadius?: number;
  readonly stepUpMeters?: number;
  readonly volume: CollisionVoxelVolume;
}

/** Decoded volume with solid/nav occupancy queries for walk + debug meshes. */
export class VoxelWalkRuntime {
  readonly agentHeight: number;
  readonly agentRadius: number;
  readonly dims: readonly [number, number, number];
  readonly origin: readonly [number, number, number];
  readonly stepUpMeters: number;
  readonly voxelSize: number;

  private readonly navBits: Uint8Array;
  private readonly solidBits: Uint8Array;

  constructor(options: VoxelWalkRuntimeOptions) {
    const { volume } = options;
    this.origin = volume.origin;
    this.dims = volume.dims;
    this.voxelSize = volume.voxel_size;
    this.agentRadius = options.agentRadius ?? DEFAULT_AGENT_RADIUS;
    this.agentHeight = options.agentHeight ?? DEFAULT_AGENT_HEIGHT;
    this.stepUpMeters = options.stepUpMeters ?? DEFAULT_STEP_UP;
    this.solidBits = ensureUint8(volume.solid);
    this.navBits = ensureUint8(volume.nav_region);
  }

  /** Drop feet/green by one voxel so occupancy tops sit nearer the painted surface. */
  surfaceBiasY(): number {
    return -this.voxelSize;
  }

  /** Biased feet Y from an unbiased floor-cell top. */
  applySurfaceBias(floorTopY: number): number {
    return floorTopY + this.surfaceBiasY();
  }

  /** Unbiased floor top from biased feet Y (inverse of {@link applySurfaceBias}). */
  floorTopFromFeet(feetY: number): number {
    return feetY - this.surfaceBiasY();
  }

  worldAabb(): { min: [number, number, number]; max: [number, number, number] } {
    return {
      min: [this.origin[0], this.origin[1], this.origin[2]],
      max: [
        this.origin[0] + this.dims[0] * this.voxelSize,
        this.origin[1] + this.dims[1] * this.voxelSize,
        this.origin[2] + this.dims[2] * this.voxelSize,
      ],
    };
  }

  idx(x: number, y: number, z: number): number {
    return (y * this.dims[2] + z) * this.dims[0] + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return (
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < this.dims[0] &&
      y < this.dims[1] &&
      z < this.dims[2]
    );
  }

  isSolid(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) {
      return true;
    }
    return readBit(this.solidBits, this.idx(x, y, z));
  }

  isNav(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) {
      return false;
    }
    return readBit(this.navBits, this.idx(x, y, z));
  }

  /** Free = carved nav cell that is not solid (walkable air). */
  isFree(x: number, y: number, z: number): boolean {
    return this.isNav(x, y, z) && !this.isSolid(x, y, z);
  }

  /** True when solid has nav empty immediately above (walkable tread/floor cell). */
  isFloorCell(x: number, y: number, z: number): boolean {
    if (!this.isSolid(x, y, z)) {
      return false;
    }
    return this.isNav(x, y + 1, z);
  }

  /** Unbiased solid-top Y of a floor cell (before surface bias). */
  floorCellTopY(cell: VoxelWalkCell): number {
    return this.origin[1] + (cell.y + 1) * this.voxelSize;
  }

  cellCenter(cell: VoxelWalkCell): [number, number, number] {
    return [
      this.origin[0] + (cell.x + 0.5) * this.voxelSize,
      this.floorCellTopY(cell),
      this.origin[2] + (cell.z + 0.5) * this.voxelSize,
    ];
  }

  worldToVoxel(wx: number, wy: number, wz: number): VoxelWalkCell | null {
    const x = Math.floor((wx - this.origin[0]) / this.voxelSize);
    const y = Math.floor((wy - this.origin[1]) / this.voxelSize);
    const z = Math.floor((wz - this.origin[2]) / this.voxelSize);
    if (!this.inBounds(x, y, z)) {
      return null;
    }
    return { x, y, z };
  }

  /**
   * Amanatides–Woo DDA raycast against solid voxels (click pick / diagnostics).
   * Walk locomotion uses floor-cell tops — not raw solid hits — to avoid floaters.
   */
  queryRay(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maxDistance: number
  ): VoxelRayHit | null {
    const len = Math.hypot(direction[0], direction[1], direction[2]);
    if (len < 1e-12 || maxDistance <= 0) {
      return null;
    }
    const dx = direction[0] / len;
    const dy = direction[1] / len;
    const dz = direction[2] / len;

    const vs = this.voxelSize;
    let x = Math.floor((origin[0] - this.origin[0]) / vs);
    let y = Math.floor((origin[1] - this.origin[1]) / vs);
    let z = Math.floor((origin[2] - this.origin[2]) / vs);

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaX = stepX === 0 ? Infinity : Math.abs(vs / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(vs / dy);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(vs / dz);

    const nextBoundary = (axis: 0 | 1 | 2, step: number, o: number): number => {
      if (step === 0) {
        return Infinity;
      }
      const local = o - this.origin[axis];
      const voxel = axis === 0 ? x : axis === 1 ? y : z;
      const edge = step > 0 ? (voxel + 1) * vs : voxel * vs;
      const d = axis === 0 ? dx : axis === 1 ? dy : dz;
      return (edge - local) / d;
    };

    let tMaxX = nextBoundary(0, stepX, origin[0]);
    let tMaxY = nextBoundary(1, stepY, origin[1]);
    let tMaxZ = nextBoundary(2, stepZ, origin[2]);
    let t = 0;
    let enterNx = 0;
    let enterNy = 1;
    let enterNz = 0;

    const maxSteps = (this.dims[0] + 2) * (this.dims[1] + 2) * (this.dims[2] + 2);
    for (let i = 0; i < maxSteps; i++) {
      if (t > maxDistance) {
        return null;
      }
      if (
        this.inBounds(x, y, z) &&
        readBit(this.solidBits, this.idx(x, y, z)) &&
        t > 1e-6
      ) {
        return {
          distance: t,
          normal: [enterNx, enterNy, enterNz],
          position: [origin[0] + dx * t, origin[1] + dy * t, origin[2] + dz * t],
        };
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          t = tMaxX;
          tMaxX += tDeltaX;
          x += stepX;
          enterNx = -stepX;
          enterNy = 0;
          enterNz = 0;
        } else {
          t = tMaxZ;
          tMaxZ += tDeltaZ;
          z += stepZ;
          enterNx = 0;
          enterNy = 0;
          enterNz = -stepZ;
        }
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
        enterNx = 0;
        enterNy = -stepY;
        enterNz = 0;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
        enterNx = 0;
        enterNy = 0;
        enterNz = -stepZ;
      }

      if (
        x < -1 ||
        y < -1 ||
        z < -1 ||
        x > this.dims[0] ||
        y > this.dims[1] ||
        z > this.dims[2]
      ) {
        return null;
      }
    }
    return null;
  }

  /** World-space free cell (carved nav ∧ ¬solid) — SS `isFreeAt`. */
  isFreeAt(wx: number, wy: number, wz: number): boolean {
    const cell = this.worldToVoxel(wx, wy, wz);
    if (!cell) {
      return false;
    }
    return this.isFree(cell.x, cell.y, cell.z);
  }

  /**
   * SS WalkController `_probeGround`: 5× solid down-rays; biased feet Y for the cube.
   * @param preferredY - Current biased feet Y.
   */
  probeGroundY(wx: number, wz: number, preferredY: number): number | null {
    const floorHint = this.floorTopFromFeet(preferredY);
    const probeY = floorHint + GROUND_PROBE_EYE_HEIGHT;
    const range = GROUND_PROBE_EYE_HEIGHT + GROUND_PROBE_RANGE;
    const r = this.agentRadius;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [-r, 0],
      [r, 0],
      [0, r],
      [0, -r],
    ];
    let sum = 0;
    let count = 0;
    for (const [ox, oz] of offsets) {
      const hit = this.queryRay([wx + ox, probeY, wz + oz], [0, -1, 0], range);
      if (!hit) {
        continue;
      }
      if (Math.abs(hit.position[1] - floorHint) > GROUND_PROBE_RANGE + 1e-3) {
        continue;
      }
      sum += hit.position[1];
      count += 1;
    }
    if (count === 0) {
      return null;
    }
    return this.applySurfaceBias(sum / count);
  }

  /**
   * Unbiased solid top under (wx, wz) via down-ray (not floor-cell gated).
   * Optional preferredY keeps the hit within groundProbeRange of current feet.
   */
  solidGroundYUnder(wx: number, wz: number, preferredY?: number): number | null {
    const startY =
      preferredY !== undefined
        ? preferredY + GROUND_PROBE_EYE_HEIGHT
        : this.origin[1] + this.dims[1] * this.voxelSize;
    const maxDist =
      preferredY !== undefined
        ? GROUND_PROBE_EYE_HEIGHT + GROUND_PROBE_RANGE
        : SPAWN_RAY_MAX_DIST;
    const hit = this.queryRay([wx, startY, wz], [0, -1, 0], maxDist);
    if (!hit) {
      return null;
    }
    if (
      preferredY !== undefined &&
      Math.abs(hit.position[1] - preferredY) > GROUND_PROBE_RANGE + 1e-3
    ) {
      return null;
    }
    return hit.position[1];
  }

  /** Capsule clearance against solid using unbiased floor top as feet. */
  capsuleFitsAtFeet(feetX: number, floorTopY: number, feetZ: number): boolean {
    const rVox = Math.max(0, Math.ceil(this.agentRadius / this.voxelSize) - 1);
    const hVox = Math.max(1, Math.ceil(this.agentHeight / this.voxelSize));
    const base = this.worldToVoxel(feetX, floorTopY + this.voxelSize * 0.25, feetZ);
    if (!base) {
      return false;
    }

    for (let dy = 0; dy < hVox; dy++) {
      for (let dz = -rVox; dz <= rVox; dz++) {
        for (let dx = -rVox; dx <= rVox; dx++) {
          if (dx * dx + dz * dz > rVox * rVox + 1) {
            continue;
          }
          const x = base.x + dx;
          const y = base.y + dy;
          const z = base.z + dz;
          if (this.isSolid(x, y, z)) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * Validate preferred biased feet on a walkable floor cell with capsule clearance.
   * Returns the (possibly re-biased) feet, or null if invalid.
   */
  tryPreferredFeet(
    feet: readonly [number, number, number]
  ): [number, number, number] | null {
    const floorTop = this.floorTopFromFeet(feet[1]);
    const cell = this.worldToVoxel(feet[0], floorTop - this.voxelSize * 0.01, feet[2]);
    if (!cell || !this.isFloorCell(cell.x, cell.y, cell.z)) {
      return null;
    }
    const top = this.floorCellTopY(cell);
    if (!this.capsuleFitsAtFeet(feet[0], top, feet[2])) {
      return null;
    }
    return [feet[0], this.applySurfaceBias(top), feet[2]];
  }

  /**
   * Unbiased walkable floor-cell top under a solid ray hit, or null for floaters/non-floors.
   */
  private resolveWalkableFloorTop(
    hitPos: readonly [number, number, number]
  ): number | null {
    const cell = this.worldToVoxel(
      hitPos[0],
      hitPos[1] - this.voxelSize * 0.01,
      hitPos[2]
    );
    if (!cell || !this.isFloorCell(cell.x, cell.y, cell.z)) {
      return null;
    }
    return this.floorCellTopY(cell);
  }

  /**
   * SS `findCylinderSpawn` + dominant deck Y band.
   * Returns biased feet on a walkable floor cell (`isFloorCell`) near the seed.
   * When the seed is far above/below the modal deck (stairs), search unconstrained first.
   */
  findCylinderSpawn(seed: readonly [number, number, number]): [number, number, number] | null {
    const deckY = this.estimateDominantDeckY();
    const seedFarFromDeck =
      deckY !== null && Math.abs(seed[1] - deckY) > DECK_Y_BAND * 3;
    if (seedFarFromDeck) {
      return (
        this.findCylinderSpawnInternal(seed, null) ??
        this.findCylinderSpawnInternal(seed, deckY)
      );
    }
    return (
      this.findCylinderSpawnInternal(seed, deckY) ??
      this.findCylinderSpawnInternal(seed, null)
    );
  }

  /**
   * Fallback when seed-near search fails (e.g. regionless coarsened volumes):
   * cylinder spawn from volume center at dominant deck Y.
   */
  findCylinderSpawnAtVolumeCenter(): [number, number, number] | null {
    const [dx, dy, dz] = this.dims;
    const deckY = this.estimateDominantDeckY();
    const centerX = this.origin[0] + dx * this.voxelSize * 0.5;
    const centerZ = this.origin[2] + dz * this.voxelSize * 0.5;
    const centerY =
      deckY ?? this.origin[1] + dy * this.voxelSize * 0.5;
    return this.findCylinderSpawn([centerX, centerY, centerZ]);
  }

  /** @deprecated Use {@link findCylinderSpawn}. */
  findBestFloorSpawn(seed: readonly [number, number, number]): [number, number, number] | null {
    return this.findCylinderSpawn(seed);
  }

  spawnFeetNear(seed: readonly [number, number, number]): [number, number, number] | null {
    return this.findCylinderSpawn(seed);
  }

  /**
   * Nav/floor Y extents for carve reachability diagnostics.
   */
  navExtentDiagnostics(): {
    floorCellMaxY: number | null;
    navMaxY: number | null;
    navMinY: number | null;
    volumeMaxY: number;
    volumeMinY: number;
  } {
    let navMaxY: number | null = null;
    let navMinY: number | null = null;
    let floorCellMaxY: number | null = null;
    const [dx, dy, dz] = this.dims;
    for (let y = 0; y < dy; y++) {
      for (let z = 0; z < dz; z++) {
        for (let x = 0; x < dx; x++) {
          if (this.isNav(x, y, z)) {
            const cy = this.origin[1] + (y + 0.5) * this.voxelSize;
            navMaxY = navMaxY === null ? cy : Math.max(navMaxY, cy);
            navMinY = navMinY === null ? cy : Math.min(navMinY, cy);
          }
          if (y < dy - 1 && this.isFloorCell(x, y, z)) {
            const top = this.floorCellTopY({ x, y, z });
            floorCellMaxY = floorCellMaxY === null ? top : Math.max(floorCellMaxY, top);
          }
        }
      }
    }
    return {
      floorCellMaxY,
      navMaxY,
      navMinY,
      volumeMaxY: this.origin[1] + dy * this.voxelSize,
      volumeMinY: this.origin[1],
    };
  }

  private estimateDominantDeckY(): number | null {
    const step = this.voxelSize;
    const bins = new Map<number, number>();
    const [dx, dy, dz] = this.dims;
    const stride = Math.max(1, Math.floor(Math.min(dx, dz) / 32));
    for (let y = 0; y < dy; y += stride) {
      for (let z = 0; z < dz; z += stride) {
        for (let x = 0; x < dx; x += stride) {
          if (!this.isFree(x, y, z)) {
            continue;
          }
          const wx = this.origin[0] + (x + 0.5) * step;
          const wy = this.origin[1] + (y + 0.5) * step;
          const wz = this.origin[2] + (z + 0.5) * step;
          const hit = this.queryRay([wx, wy, wz], [0, -1, 0], SPAWN_RAY_MAX_DIST);
          if (!hit) {
            continue;
          }
          const bin = Math.round(hit.position[1] / step) * step;
          bins.set(bin, (bins.get(bin) ?? 0) + 1);
        }
      }
    }
    let bestBin: number | null = null;
    let bestCount = 0;
    for (const [bin, count] of bins) {
      if (count > bestCount) {
        bestCount = count;
        bestBin = bin;
      }
    }
    return bestBin;
  }

  private findCylinderSpawnInternal(
    seed: readonly [number, number, number],
    deckY: number | null
  ): [number, number, number] | null {
    const step = this.voxelSize;
    const maxCells = Math.ceil(SPAWN_SEARCH_RADIUS / step);
    const searchRadiusSq = SPAWN_SEARCH_RADIUS * SPAWN_SEARCH_RADIUS;
    const footCells = Math.ceil(this.agentRadius / step);
    const radiusSq = this.agentRadius * this.agentRadius;
    const halfHeight = this.agentHeight * 0.5;

    let bestDistSq = Infinity;
    let best: [number, number, number] | null = null;

    for (let r = 0; r <= maxCells; r++) {
      const shellMinDistSq = r * step * (r * step);
      if (shellMinDistSq >= bestDistSq) {
        break;
      }

      for (let dy = -r; dy <= r; dy++) {
        const absDy = Math.abs(dy);
        for (let dz = -r; dz <= r; dz++) {
          const absDz = Math.abs(dz);
          for (let dx = -r; dx <= r; dx++) {
            const absDx = Math.abs(dx);
            if (absDx < r && absDy < r && absDz < r) {
              continue;
            }

            const distSq = (dx * dx + dy * dy + dz * dz) * step * step;
            if (distSq >= bestDistSq || distSq > searchRadiusSq) {
              continue;
            }

            const cx = seed[0] + dx * step;
            const cy = seed[1] + dy * step;
            const cz = seed[2] + dz * step;
            if (!this.isFreeAt(cx, cy, cz)) {
              continue;
            }

            let floor = -Infinity;
            let ceiling = Infinity;
            let supported = true;

            for (let i = -footCells; i <= footCells && supported; i++) {
              const fxOff = i * step;
              const fxOffSq = fxOff * fxOff;
              for (let j = -footCells; j <= footCells; j++) {
                const fzOff = j * step;
                if (fxOffSq + fzOff * fzOff > radiusSq) {
                  continue;
                }
                const fx = cx + fxOff;
                const fz = cz + fzOff;
                const down = this.queryRay([fx, cy, fz], [0, -1, 0], SPAWN_RAY_MAX_DIST);
                if (!down) {
                  supported = false;
                  break;
                }
                const floorTop = this.resolveWalkableFloorTop(down.position);
                if (floorTop === null) {
                  supported = false;
                  break;
                }
                if (floorTop > floor) {
                  floor = floorTop;
                }
                const up = this.queryRay([fx, cy, fz], [0, 1, 0], SPAWN_RAY_MAX_DIST);
                if (up && up.position[1] < ceiling) {
                  ceiling = up.position[1];
                }
              }
            }

            if (!supported || !Number.isFinite(floor)) {
              continue;
            }
            if (floor + 2 * halfHeight > ceiling) {
              continue;
            }
            if (deckY !== null && Math.abs(floor - deckY) > DECK_Y_BAND) {
              continue;
            }
            if (!this.capsuleFitsAtFeet(cx, floor, cz)) {
              continue;
            }

            bestDistSq = distSq;
            best = [cx, this.applySurfaceBias(floor), cz];
          }
        }
      }
    }

    return best;
  }
}

/**
 * XZ steer toward click goals; solid ground probes climb stairs (SS WalkController).
 */
export class VoxelWalkController {
  private feet: [number, number, number];
  private goalXZ: [number, number] | null = null;
  private prevDistXZ = Infinity;
  private blockedTime = 0;

  constructor(
    private readonly runtime: VoxelWalkRuntime,
    feet: readonly [number, number, number]
  ) {
    this.feet = [feet[0], feet[1], feet[2]];
  }

  getFeet(): [number, number, number] {
    return [...this.feet];
  }

  getRuntime(): VoxelWalkRuntime {
    return this.runtime;
  }

  /** Begin auto-walk toward world target (XZ only — no isFloorCell snap). */
  navigateTo(world: readonly [number, number, number]): void {
    this.goalXZ = [world[0], world[2]];
    this.prevDistXZ = Infinity;
    this.blockedTime = 0;
  }

  clearGoal(): void {
    this.goalXZ = null;
    this.prevDistXZ = Infinity;
    this.blockedTime = 0;
  }

  update(deltaSec: number): [number, number, number] {
    if (!this.goalXZ || deltaSec <= 0) {
      const gy = this.runtime.probeGroundY(this.feet[0], this.feet[2], this.feet[1]);
      if (gy !== null) {
        this.feet[1] = gy;
      }
      return this.getFeet();
    }

    const [gx, gz] = this.goalXZ;
    const dx = gx - this.feet[0];
    const dz = gz - this.feet[2];
    const distXZ = Math.hypot(dx, dz);
    const prevY = this.feet[1];

    if (distXZ < ARRIVAL_DIST_XZ) {
      this.clearGoal();
      const gy = this.runtime.probeGroundY(this.feet[0], this.feet[2], this.feet[1]);
      if (gy !== null) {
        this.feet[1] = gy;
      }
      return this.getFeet();
    }

    const step = Math.min(distXZ, MOVE_SPEED_METERS_PER_SEC * deltaSec);
    const nx = this.feet[0] + (dx / distXZ) * step;
    const nz = this.feet[2] + (dz / distXZ) * step;
    this.feet = this.resolveMove(this.feet[0], this.feet[1], this.feet[2], nx, nz);

    const climbing = this.feet[1] > prevY + 1e-4;
    if (this.prevDistXZ !== Infinity && !climbing) {
      const speed = (this.prevDistXZ - distXZ) / deltaSec;
      if (speed < BLOCKED_SPEED) {
        this.blockedTime += deltaSec;
        if (this.blockedTime >= BLOCKED_DURATION_SEC) {
          this.clearGoal();
          return this.getFeet();
        }
      } else {
        this.blockedTime = 0;
      }
    } else if (climbing) {
      this.blockedTime = 0;
    }
    this.prevDistXZ = distXZ;

    return this.getFeet();
  }

  private resolveMove(
    fx: number,
    fy: number,
    fz: number,
    nx: number,
    nz: number
  ): [number, number, number] {
    const preferredUnbiased = this.runtime.floorTopFromFeet(fy);

    const tryAt = (x: number, z: number): [number, number, number] | null => {
      const gyBiased = this.runtime.probeGroundY(x, z, fy);
      if (gyBiased === null) {
        return null;
      }
      const floorTop = this.runtime.floorTopFromFeet(gyBiased);
      const climbing =
        floorTop > preferredUnbiased + 1e-4 &&
        floorTop <= preferredUnbiased + GROUND_PROBE_RANGE + 1e-6;
      if (!climbing && !this.runtime.capsuleFitsAtFeet(x, floorTop, z)) {
        return null;
      }
      return [x, gyBiased, z];
    };

    const full = tryAt(nx, nz);
    if (full) {
      return full;
    }
    const slideX = tryAt(nx, fz);
    if (slideX) {
      return slideX;
    }
    const slideZ = tryAt(fx, nz);
    if (slideZ) {
      return slideZ;
    }
    const stayGy = this.runtime.probeGroundY(fx, fz, fy) ?? fy;
    return [fx, stayGy, fz];
  }
}

export interface VolumeMeshBuffers {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
  /** True when mesh used solid tops because nav floor cells were empty. */
  readonly usedSolidTopFallback?: boolean;
}

type PushQuad = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx_: number,
  dy_: number,
  dz_: number
) => void;

const createQuadPusher = (
  positions: number[],
  indices: number[]
): PushQuad => {
  return (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx_: number,
    dy_: number,
    dz_: number
  ): void => {
    const base = positions.length / 3;
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx_, dy_, dz_);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
};

/**
 * Emit walkable tread quads from volume for green debug overlay (surface-biased).
 * Prefers nav floor cells; if none, emits solid tops with free air above (regionless).
 */
export const volumeToWalkableFloorMesh = (
  volume: CollisionVoxelVolume
): VolumeMeshBuffers => {
  const runtime = new VoxelWalkRuntime({ volume });
  const positions: number[] = [];
  const indices: number[] = [];
  const pushQuad = createQuadPusher(positions, indices);
  const [dx, dy, dz] = runtime.dims;
  const vs = runtime.voxelSize;
  const bias = runtime.surfaceBiasY();
  const [ox, oy, oz] = runtime.origin;

  for (let y = 0; y < dy - 1; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        if (!runtime.isFloorCell(x, y, z)) {
          continue;
        }
        const topY = oy + (y + 1) * vs + bias;
        const x0 = ox + x * vs;
        const x1 = ox + (x + 1) * vs;
        const z0 = oz + z * vs;
        const z1 = oz + (z + 1) * vs;
        pushQuad(x0, topY, z0, x1, topY, z0, x1, topY, z1, x0, topY, z1);
      }
    }
  }

  if (positions.length > 0) {
    return {
      indices: new Uint32Array(indices),
      positions: new Float32Array(positions),
      usedSolidTopFallback: false,
    };
  }

  // Regionless / sparse carve: solid tops with air above (matches walk ground probes).
  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        if (!runtime.isSolid(x, y, z)) {
          continue;
        }
        const openAbove = y + 1 >= dy || !runtime.isSolid(x, y + 1, z);
        if (!openAbove) {
          continue;
        }
        const topY = oy + (y + 1) * vs + bias;
        const x0 = ox + x * vs;
        const x1 = ox + (x + 1) * vs;
        const z0 = oz + z * vs;
        const z1 = oz + (z + 1) * vs;
        pushQuad(x0, topY, z0, x1, topY, z0, x1, topY, z1, x0, topY, z1);
      }
    }
  }

  return {
    indices: new Uint32Array(indices),
    positions: new Float32Array(positions),
    usedSolidTopFallback: positions.length > 0,
  };
};

/**
 * Axis-aligned exterior faces of solid voxels (for collision.glb when WASM mesh is empty).
 */
export const volumeToSolidExteriorMesh = (
  volume: CollisionVoxelVolume
): VolumeMeshBuffers => {
  const runtime = new VoxelWalkRuntime({ volume });
  const positions: number[] = [];
  const indices: number[] = [];
  const pushQuad = createQuadPusher(positions, indices);
  const [dx, dy, dz] = runtime.dims;
  const vs = runtime.voxelSize;
  const [ox, oy, oz] = runtime.origin;

  const solidAt = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) {
      return false;
    }
    return runtime.isSolid(x, y, z);
  };

  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        if (!runtime.isSolid(x, y, z)) {
          continue;
        }
        const x0 = ox + x * vs;
        const x1 = ox + (x + 1) * vs;
        const y0 = oy + y * vs;
        const y1 = oy + (y + 1) * vs;
        const z0 = oz + z * vs;
        const z1 = oz + (z + 1) * vs;

        // -X
        if (!solidAt(x - 1, y, z)) {
          pushQuad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
        }
        // +X
        if (!solidAt(x + 1, y, z)) {
          pushQuad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1);
        }
        // -Y
        if (!solidAt(x, y - 1, z)) {
          pushQuad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
        }
        // +Y
        if (!solidAt(x, y + 1, z)) {
          pushQuad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0);
        }
        // -Z
        if (!solidAt(x, y, z - 1)) {
          pushQuad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0);
        }
        // +Z
        if (!solidAt(x, y, z + 1)) {
          pushQuad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
        }
      }
    }
  }

  return {
    indices: new Uint32Array(indices),
    positions: new Float32Array(positions),
  };
};

/**
 * Walkable treads plus connecting ramps between neighboring floor cells within
 * step-up — gives Recast continuous spans without re-losing stair connectivity.
 */
export const volumeToConnectedWalkableMesh = (
  volume: CollisionVoxelVolume,
  stepUpMeters = DEFAULT_STEP_UP
): { positions: Float32Array; indices: Uint32Array } => {
  const runtime = new VoxelWalkRuntime({ volume, stepUpMeters });
  const floor = volumeToWalkableFloorMesh(volume);
  const positions = Array.from(floor.positions);
  const indices = Array.from(floor.indices);
  const [dx, dy, dz] = runtime.dims;
  const vs = runtime.voxelSize;
  const bias = runtime.surfaceBiasY();
  const [ox, oy, oz] = runtime.origin;

  for (let y = 0; y < dy - 1; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        if (!runtime.isFloorCell(x, y, z)) {
          continue;
        }
        const yHere = oy + (y + 1) * vs + bias;
        const yWindow = Math.ceil(stepUpMeters / vs);
        if (x + 1 < dx) {
          for (let ny = Math.max(0, y - yWindow); ny <= Math.min(dy - 2, y + yWindow); ny++) {
            if (ny === y || !runtime.isFloorCell(x + 1, ny, z)) {
              continue;
            }
            const yRight = oy + (ny + 1) * vs + bias;
            if (Math.abs(yRight - yHere) > stepUpMeters + 1e-6) {
              continue;
            }
            const edgeX = ox + (x + 1) * vs;
            const z0 = oz + z * vs;
            const z1 = oz + (z + 1) * vs;
            const base = positions.length / 3;
            positions.push(
              edgeX,
              yHere,
              z0,
              edgeX,
              yHere,
              z1,
              edgeX,
              yRight,
              z1,
              edgeX,
              yRight,
              z0
            );
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
        if (z + 1 < dz) {
          for (let ny = Math.max(0, y - yWindow); ny <= Math.min(dy - 2, y + yWindow); ny++) {
            if (ny === y || !runtime.isFloorCell(x, ny, z + 1)) {
              continue;
            }
            const yFwd = oy + (ny + 1) * vs + bias;
            if (Math.abs(yFwd - yHere) > stepUpMeters + 1e-6) {
              continue;
            }
            const edgeZ = oz + (z + 1) * vs;
            const x0 = ox + x * vs;
            const x1 = ox + (x + 1) * vs;
            const base = positions.length / 3;
            positions.push(x0, yHere, edgeZ, x1, yHere, edgeZ, x1, yFwd, edgeZ, x0, yFwd, edgeZ);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
};

/**
 * Column spans for Recast heightfield bake: each (x,z) lists walkable top Y in meters
 * (absolute) where solid borders nav above.
 */
export const volumeToWalkableSpans = (
  volume: CollisionVoxelVolume
): {
  origin: [number, number, number];
  dims: [number, number, number];
  voxelSize: number;
  /** Packed as [x, z, topY_m, ...] for each floor cell */
  spans: Float32Array;
} => {
  const runtime = new VoxelWalkRuntime({ volume });
  const spans: number[] = [];
  const [dx, dy, dz] = runtime.dims;
  for (let z = 0; z < dz; z++) {
    for (let x = 0; x < dx; x++) {
      for (let y = 0; y < dy - 1; y++) {
        if (!runtime.isFloorCell(x, y, z)) {
          continue;
        }
        const topY = runtime.origin[1] + (y + 1) * runtime.voxelSize;
        spans.push(x, z, topY);
      }
    }
  }
  return {
    origin: [...runtime.origin] as [number, number, number],
    dims: [...runtime.dims] as [number, number, number],
    voxelSize: runtime.voxelSize,
    spans: new Float32Array(spans),
  };
};

const ensureUint8 = (data: Uint8Array | ArrayBuffer | number[]): Uint8Array => {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data);
};

const readBit = (bits: Uint8Array, index: number): boolean => {
  const byte = bits[index >> 3];
  if (byte === undefined) {
    return false;
  }
  return (byte & (1 << (index & 7))) !== 0;
};

export { MOVE_SPEED_METERS_PER_SEC };
