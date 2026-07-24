/**
 * Vertex / circle selection queries over Recast debug triangle meshes.
 */

import type { NavMeshEditorVec3 } from './types';

export interface TriangleHit {
  readonly faceIndex: number;
  readonly point: NavMeshEditorVec3;
  readonly normal: NavMeshEditorVec3;
  readonly distance: number;
}

const UP: NavMeshEditorVec3 = { x: 0, y: 1, z: 0 };

export const vec3 = (x: number, y: number, z: number): NavMeshEditorVec3 => ({
  x,
  y,
  z,
});

export const sub = (a: NavMeshEditorVec3, b: NavMeshEditorVec3): NavMeshEditorVec3 =>
  vec3(a.x - b.x, a.y - b.y, a.z - b.z);

export const add = (a: NavMeshEditorVec3, b: NavMeshEditorVec3): NavMeshEditorVec3 =>
  vec3(a.x + b.x, a.y + b.y, a.z + b.z);

export const scale = (a: NavMeshEditorVec3, s: number): NavMeshEditorVec3 =>
  vec3(a.x * s, a.y * s, a.z * s);

export const dot = (a: NavMeshEditorVec3, b: NavMeshEditorVec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: NavMeshEditorVec3, b: NavMeshEditorVec3): NavMeshEditorVec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const length = (a: NavMeshEditorVec3): number => Math.hypot(a.x, a.y, a.z);

export const normalize = (a: NavMeshEditorVec3): NavMeshEditorVec3 => {
  const len = length(a);
  if (len < 1e-12) {
    return UP;
  }
  return scale(a, 1 / len);
};

export const readVertex = (
  positions: Float32Array,
  index: number
): NavMeshEditorVec3 => {
  const i = index * 3;
  return vec3(positions[i]!, positions[i + 1]!, positions[i + 2]!);
};

export const writeVertex = (
  positions: Float32Array,
  index: number,
  p: NavMeshEditorVec3
): void => {
  const i = index * 3;
  positions[i] = p.x;
  positions[i + 1] = p.y;
  positions[i + 2] = p.z;
};

export const triangleNormal = (
  positions: Float32Array,
  indices: Uint32Array,
  faceIndex: number
): NavMeshEditorVec3 => {
  const base = faceIndex * 3;
  const a = readVertex(positions, indices[base]!);
  const b = readVertex(positions, indices[base + 1]!);
  const c = readVertex(positions, indices[base + 2]!);
  return normalize(cross(sub(b, a), sub(c, a)));
};

/**
 * Closest vertex index to a world/nav point (linear scan; fine for debug meshes).
 */
export const nearestVertexIndex = (
  positions: Float32Array,
  point: NavMeshEditorVec3
): number => {
  let best = 0;
  let bestD = Infinity;
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    const v = readVertex(positions, i);
    const d =
      (v.x - point.x) * (v.x - point.x) +
      (v.y - point.y) * (v.y - point.y) +
      (v.z - point.z) * (v.z - point.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
};

/**
 * Vertex indices whose projection onto the brush plane lies within `radius`.
 */
export const verticesInBrush = (
  positions: Float32Array,
  center: NavMeshEditorVec3,
  normal: NavMeshEditorVec3,
  radius: number
): number[] => {
  const n = normalize(normal);
  const r2 = radius * radius;
  const out: number[] = [];
  const count = Math.floor(positions.length / 3);
  for (let i = 0; i < count; i++) {
    const v = readVertex(positions, i);
    const d = sub(v, center);
    const along = scale(n, dot(d, n));
    const planar = sub(d, along);
    if (dot(planar, planar) <= r2) {
      out.push(i);
    }
  }
  return out;
};

export const centroidOfVertices = (
  positions: Float32Array,
  indices: readonly number[]
): NavMeshEditorVec3 => {
  if (indices.length === 0) {
    return vec3(0, 0, 0);
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of indices) {
    const v = readVertex(positions, i);
    x += v.x;
    y += v.y;
    z += v.z;
  }
  const inv = 1 / indices.length;
  return vec3(x * inv, y * inv, z * inv);
};

/**
 * Ray–triangle intersection (Möller–Trumbore). Returns null on miss.
 */
export const rayTriangle = (
  origin: NavMeshEditorVec3,
  dir: NavMeshEditorVec3,
  a: NavMeshEditorVec3,
  b: NavMeshEditorVec3,
  c: NavMeshEditorVec3
): { t: number; point: NavMeshEditorVec3 } | null => {
  const eps = 1e-8;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const pvec = cross(dir, ac);
  const det = dot(ab, pvec);
  if (Math.abs(det) < eps) {
    return null;
  }
  const invDet = 1 / det;
  const tvec = sub(origin, a);
  const u = dot(tvec, pvec) * invDet;
  if (u < 0 || u > 1) {
    return null;
  }
  const qvec = cross(tvec, ab);
  const v = dot(dir, qvec) * invDet;
  if (v < 0 || u + v > 1) {
    return null;
  }
  const t = dot(ac, qvec) * invDet;
  if (t < eps) {
    return null;
  }
  return { t, point: add(origin, scale(dir, t)) };
};

/**
 * Pick nearest triangle along a ray; returns hit with face normal.
 */
export const pickNavMeshTriangle = (
  positions: Float32Array,
  indices: Uint32Array,
  origin: NavMeshEditorVec3,
  dir: NavMeshEditorVec3
): TriangleHit | null => {
  const ndir = normalize(dir);
  let best: TriangleHit | null = null;
  const faceCount = Math.floor(indices.length / 3);
  for (let f = 0; f < faceCount; f++) {
    const base = f * 3;
    const a = readVertex(positions, indices[base]!);
    const b = readVertex(positions, indices[base + 1]!);
    const c = readVertex(positions, indices[base + 2]!);
    const hit = rayTriangle(origin, ndir, a, b, c);
    if (!hit) {
      continue;
    }
    if (!best || hit.t < best.distance) {
      best = {
        faceIndex: f,
        point: hit.point,
        normal: triangleNormal(positions, indices, f),
        distance: hit.t,
      };
    }
  }
  return best;
};
