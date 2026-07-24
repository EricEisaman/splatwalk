/**
 * Boundary-loop hole detection and ear-clip fill for navmesh debug meshes.
 */

import {
  cross,
  dot,
  readVertex,
  sub,
  vec3,
} from './selection';
import type { NavMeshEditorVec3 } from './types';

export interface BoundaryLoop {
  /** Ordered vertex indices around the hole (CCW preferred). */
  readonly vertices: number[];
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Collect boundary edges (appear once) and build closed loops.
 */
export const findBoundaryLoops = (
  _positions: Float32Array,
  indices: Uint32Array
): BoundaryLoop[] => {
  const edgeCount = new Map<string, number>();
  const directed = new Map<string, [number, number]>();
  const faceCount = Math.floor(indices.length / 3);
  for (let f = 0; f < faceCount; f++) {
    const base = f * 3;
    const tri = [indices[base]!, indices[base + 1]!, indices[base + 2]!];
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      const key = edgeKey(a, b);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!directed.has(key)) {
        directed.set(key, [a, b]);
      }
    }
  }

  const adj = new Map<number, number[]>();
  for (const [key, count] of edgeCount) {
    if (count !== 1) {
      continue;
    }
    const pair = directed.get(key);
    if (!pair) {
      continue;
    }
    const [a, b] = pair;
    if (!adj.has(a)) {
      adj.set(a, []);
    }
    if (!adj.has(b)) {
      adj.set(b, []);
    }
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  const visited = new Set<string>();
  const loops: BoundaryLoop[] = [];

  for (const start of adj.keys()) {
    for (const next0 of adj.get(start) ?? []) {
      const startKey = edgeKey(start, next0);
      if (visited.has(startKey)) {
        continue;
      }
      const loop: number[] = [start];
      let prev = start;
      let cur = next0;
      visited.add(startKey);
      let guard = 0;
      while (cur !== start && guard++ < 100000) {
        loop.push(cur);
        const neighbors = adj.get(cur) ?? [];
        let advanced = false;
        for (const n of neighbors) {
          if (n === prev) {
            continue;
          }
          const k = edgeKey(cur, n);
          if (visited.has(k)) {
            continue;
          }
          visited.add(k);
          prev = cur;
          cur = n;
          advanced = true;
          break;
        }
        if (!advanced) {
          break;
        }
      }
      if (loop.length >= 3 && cur === start) {
        loops.push({ vertices: loop });
      }
    }
  }
  return loops;
};

const pointInBrush = (
  p: NavMeshEditorVec3,
  center: NavMeshEditorVec3,
  normal: NavMeshEditorVec3,
  radius: number
): boolean => {
  const d = sub(p, center);
  const along = vec3(
    normal.x * dot(d, normal),
    normal.y * dot(d, normal),
    normal.z * dot(d, normal)
  );
  const px = d.x - along.x;
  const py = d.y - along.y;
  const pz = d.z - along.z;
  return px * px + py * py + pz * pz <= radius * radius;
};

const planeDist2 = (
  a: NavMeshEditorVec3,
  b: NavMeshEditorVec3,
  normal: NavMeshEditorVec3
): number => {
  const d = sub(a, b);
  const along = dot(d, normal);
  const px = d.x - normal.x * along;
  const py = d.y - normal.y * along;
  const pz = d.z - normal.z * along;
  return px * px + py * py + pz * pz;
};

const loopPerimeter = (
  positions: Float32Array,
  loop: BoundaryLoop
): number => {
  let len = 0;
  const verts = loop.vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = readVertex(positions, verts[i]!);
    const b = readVertex(positions, verts[(i + 1) % verts.length]!);
    len += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  return len;
};

/**
 * Longest contiguous run of loop verts inside an expanded brush (circular).
 * Handles wrap-around on closed loops.
 */
const longestBrushRun = (
  positions: Float32Array,
  loop: BoundaryLoop,
  center: NavMeshEditorVec3,
  normal: NavMeshEditorVec3,
  radius: number
): number[] => {
  const verts = loop.vertices;
  const n = verts.length;
  if (n === 0) {
    return [];
  }
  const inside = verts.map((vi) =>
    pointInBrush(readVertex(positions, vi), center, normal, radius)
  );
  // Duplicate once so wrap-around runs are contiguous.
  const flags = inside.concat(inside);
  let bestStart = 0;
  let bestLen = 0;
  let runStart = 0;
  let runLen = 0;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (runLen === 0) {
        runStart = i;
      }
      runLen++;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runLen = 0;
    }
  }
  // Cap at one full loop.
  bestLen = Math.min(bestLen, n);
  if (bestLen < 3) {
    return [];
  }
  const run: number[] = [];
  for (let i = 0; i < bestLen; i++) {
    run.push(verts[(bestStart + i) % n]!);
  }
  return run;
};

/**
 * Pick a fillable rim under the brush:
 * 1) Closed interior holes (exclude the longest outer boundary when multiple loops exist)
 * 2) Open coverage "bays": contiguous outer-boundary verts under the brush whose
 *    endpoints are close enough to close with a chord (typical Recast coverage gaps)
 */
export const findHoleUnderBrush = (
  positions: Float32Array,
  indices: Uint32Array,
  center: NavMeshEditorVec3,
  normal: NavMeshEditorVec3,
  radius: number
): BoundaryLoop | null => {
  const loops = findBoundaryLoops(positions, indices);
  if (loops.length === 0) {
    return null;
  }

  const ranked = [...loops].sort(
    (a, b) => loopPerimeter(positions, a) - loopPerimeter(positions, b)
  );
  const outer = ranked[ranked.length - 1]!;
  // True interior holes only exist when there is more than one boundary loop.
  // Never treat the sole/outer perimeter as a fillable "hole".
  const interior = ranked.length > 1 ? ranked.slice(0, ranked.length - 1) : [];

  let best: BoundaryLoop | null = null;
  let bestScore = 0;
  for (const loop of interior) {
    if (loop.vertices.length < 3) {
      continue;
    }
    let inside = 0;
    for (const vi of loop.vertices) {
      if (pointInBrush(readVertex(positions, vi), center, normal, radius)) {
        inside++;
      }
    }
    const score = inside / loop.vertices.length;
    if (inside >= 3 && score >= 0.45 && score > bestScore) {
      bestScore = score;
      best = loop;
    }
  }
  if (best) {
    return best;
  }

  // Coverage-gap / bay fill: contiguous outer-boundary verts under the brush
  // whose endpoints are close enough to close with a chord.
  const expand = radius * 1.25;
  const run = longestBrushRun(positions, outer, center, normal, expand);
  if (run.length < 3) {
    return null;
  }
  // Don't try to fill almost the entire outer perimeter.
  if (run.length > Math.max(20, Math.floor(outer.vertices.length * 0.4))) {
    return null;
  }
  const a = readVertex(positions, run[0]!);
  const b = readVertex(positions, run[run.length - 1]!);
  const closeDist = Math.max(radius * 1.6, 1.0);
  if (planeDist2(a, b, normal) > closeDist * closeDist) {
    return null;
  }
  return { vertices: run };
};

const area2 = (
  a: NavMeshEditorVec3,
  b: NavMeshEditorVec3,
  c: NavMeshEditorVec3,
  normal: NavMeshEditorVec3
): number => dot(cross(sub(b, a), sub(c, a)), normal);

const pointInTriangle = (
  p: NavMeshEditorVec3,
  a: NavMeshEditorVec3,
  b: NavMeshEditorVec3,
  c: NavMeshEditorVec3,
  normal: NavMeshEditorVec3
): boolean => {
  const a1 = area2(p, a, b, normal);
  const a2 = area2(p, b, c, normal);
  const a3 = area2(p, c, a, normal);
  const hasNeg = a1 < 0 || a2 < 0 || a3 < 0;
  const hasPos = a1 > 0 || a2 > 0 || a3 > 0;
  return !(hasNeg && hasPos);
};

/**
 * Ear-clip a simple hole loop into triangles. Returns new index triplets
 * (vertex indices into existing `positions`). Empty on failure.
 */
export const earClipFill = (
  positions: Float32Array,
  loop: BoundaryLoop
): number[] => {
  const verts = [...loop.vertices];
  if (verts.length < 3) {
    return [];
  }
  // Average normal from consecutive edges for 2D orientation.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = readVertex(positions, verts[i]!);
    const b = readVertex(positions, verts[(i + 1) % verts.length]!);
    const c = readVertex(positions, verts[(i + 2) % verts.length]!);
    const n = cross(sub(b, a), sub(c, a));
    nx += n.x;
    ny += n.y;
    nz += n.z;
  }
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-10) {
    return [];
  }
  const normal = vec3(nx / nlen, ny / nlen, nz / nlen);

  // Ensure CCW relative to normal.
  let signed = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = readVertex(positions, verts[i]!);
    const b = readVertex(positions, verts[(i + 1) % verts.length]!);
    signed += area2(a, b, readVertex(positions, verts[(i + 2) % verts.length]!), normal);
  }
  if (signed < 0) {
    verts.reverse();
  }

  const out: number[] = [];
  const active = [...verts];
  let guard = 0;
  while (active.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < active.length; i++) {
      const i0 = active[(i + active.length - 1) % active.length]!;
      const i1 = active[i]!;
      const i2 = active[(i + 1) % active.length]!;
      const a = readVertex(positions, i0);
      const b = readVertex(positions, i1);
      const c = readVertex(positions, i2);
      if (area2(a, b, c, normal) <= 1e-10) {
        continue;
      }
      let ear = true;
      for (let j = 0; j < active.length; j++) {
        const ij = active[j]!;
        if (ij === i0 || ij === i1 || ij === i2) {
          continue;
        }
        if (pointInTriangle(readVertex(positions, ij), a, b, c, normal)) {
          ear = false;
          break;
        }
      }
      if (!ear) {
        continue;
      }
      out.push(i0, i1, i2);
      active.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      return [];
    }
  }
  if (active.length === 3) {
    out.push(active[0]!, active[1]!, active[2]!);
  }
  return out;
};

/**
 * Append fill triangles to indices. Returns the new indices buffer.
 */
export const appendFillTriangles = (
  indices: Uint32Array,
  newTris: readonly number[]
): Uint32Array => {
  if (newTris.length < 3) {
    return indices;
  }
  const next = new Uint32Array(indices.length + newTris.length);
  next.set(indices, 0);
  next.set(newTris, indices.length);
  return next;
};

interface BoundaryEdge {
  readonly a: number;
  readonly b: number;
  readonly mid: NavMeshEditorVec3;
  readonly dir: NavMeshEditorVec3;
  readonly len: number;
}

const collectBoundaryEdges = (
  positions: Float32Array,
  indices: Uint32Array
): BoundaryEdge[] => {
  const edgeCount = new Map<string, number>();
  const directed = new Map<string, [number, number]>();
  const faceCount = Math.floor(indices.length / 3);
  for (let f = 0; f < faceCount; f++) {
    const base = f * 3;
    const tri = [indices[base]!, indices[base + 1]!, indices[base + 2]!];
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      const key = edgeKey(a, b);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!directed.has(key)) {
        directed.set(key, [a, b]);
      }
    }
  }
  const edges: BoundaryEdge[] = [];
  for (const [key, count] of edgeCount) {
    if (count !== 1) {
      continue;
    }
    const pair = directed.get(key);
    if (!pair) {
      continue;
    }
    const [a, b] = pair;
    const pa = readVertex(positions, a);
    const pb = readVertex(positions, b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dz = pb.z - pa.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) {
      continue;
    }
    edges.push({
      a,
      b,
      mid: vec3((pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5, (pa.z + pb.z) * 0.5),
      dir: vec3(dx / len, dy / len, dz / len),
      len,
    });
  }
  return edges;
};

/**
 * Pair facing boundary edges under the brush and emit bridge quads (2 tris each).
 * Targets deck/slat gaps where strips leave open corridors, not closed holes.
 */
/** True if any triangle already joins a vertex from edge A with one from edge B. */
const edgesAlreadyConnected = (
  indices: Uint32Array,
  e0: BoundaryEdge,
  e1: BoundaryEdge
): boolean => {
  const aSet = new Set([e0.a, e0.b]);
  const bSet = new Set([e1.a, e1.b]);
  const faceCount = Math.floor(indices.length / 3);
  for (let f = 0; f < faceCount; f++) {
    const base = f * 3;
    const t0 = indices[base]!;
    const t1 = indices[base + 1]!;
    const t2 = indices[base + 2]!;
    const inA = aSet.has(t0) || aSet.has(t1) || aSet.has(t2);
    const inB = bSet.has(t0) || bSet.has(t1) || bSet.has(t2);
    if (inA && inB) {
      return true;
    }
  }
  return false;
};

/**
 * Pair facing boundary edges under the brush and emit bridge quads (2 tris each).
 * Targets deck/slat gaps where strips leave open corridors, not closed holes.
 */
export const bridgeGapsUnderBrush = (
  positions: Float32Array,
  indices: Uint32Array,
  center: NavMeshEditorVec3,
  normal: NavMeshEditorVec3,
  radius: number
): number[] => {
  const expand = radius * 1.2;
  const edges = collectBoundaryEdges(positions, indices).filter((e) =>
    pointInBrush(e.mid, center, normal, expand)
  );
  if (edges.length < 2) {
    return [];
  }

  const used = new Set<number>();
  const tris: number[] = [];
  const maxGap = Math.max(radius * 1.1, 0.35);
  const maxGap2 = maxGap * maxGap;
  const minAlign = 0.55; // |dot| of edge dirs — roughly parallel

  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) {
      continue;
    }
    const e0 = edges[i]!;
    let bestJ = -1;
    let bestDist2 = maxGap2;
    for (let j = i + 1; j < edges.length; j++) {
      if (used.has(j)) {
        continue;
      }
      const e1 = edges[j]!;
      // Skip shared vertices (same edge chain).
      if (e0.a === e1.a || e0.a === e1.b || e0.b === e1.a || e0.b === e1.b) {
        continue;
      }
      // Skip opposite edges of an existing face / same strip interior.
      if (edgesAlreadyConnected(indices, e0, e1)) {
        continue;
      }
      const align = Math.abs(dot(e0.dir, e1.dir));
      if (align < minAlign) {
        continue;
      }
      const d2 = planeDist2(e0.mid, e1.mid, normal);
      if (d2 >= bestDist2 || d2 < 1e-6) {
        continue;
      }
      // Gap should be mostly perpendicular to the edge direction.
      const midDelta = sub(e1.mid, e0.mid);
      const along0 = Math.abs(dot(midDelta, e0.dir));
      const sep = Math.sqrt(d2);
      if (along0 > sep * 0.55) {
        continue;
      }
      bestDist2 = d2;
      bestJ = j;
    }
    if (bestJ < 0) {
      continue;
    }
    const e1 = edges[bestJ]!;
    used.add(i);
    used.add(bestJ);

    let a0 = e0.a;
    let b0 = e0.b;
    let a1 = e1.a;
    let b1 = e1.b;
    const pa0 = readVertex(positions, a0);
    const pb0 = readVertex(positions, b0);
    const pa1 = readVertex(positions, a1);
    const pb1 = readVertex(positions, b1);
    const dAA =
      planeDist2(pa0, pa1, normal) + planeDist2(pb0, pb1, normal);
    const dAB =
      planeDist2(pa0, pb1, normal) + planeDist2(pb0, pa1, normal);
    if (dAB < dAA) {
      a1 = e1.b;
      b1 = e1.a;
    }
    const nCheck = cross(
      sub(readVertex(positions, b0), readVertex(positions, a0)),
      sub(readVertex(positions, a1), readVertex(positions, a0))
    );
    if (dot(nCheck, normal) < 0) {
      tris.push(a0, a1, b0, b0, a1, b1);
    } else {
      tris.push(a0, b0, a1, b0, b1, a1);
    }
  }
  return tris;
};
