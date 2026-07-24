/**
 * Weld coincident vertices so boundary-edge detection sees shared topology.
 * Recast debug draws sometimes emit near-duplicate verts at poly corners.
 */

const QUANTIZE = 1e4; // ~0.1 mm bins

const quantKey = (x: number, y: number, z: number): string =>
  `${Math.round(x * QUANTIZE)}:${Math.round(y * QUANTIZE)}:${Math.round(z * QUANTIZE)}`;

export interface WeldedMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Maps old vertex index → welded vertex index. */
  readonly remap: Uint32Array;
}

/**
 * Merge vertices that share the same quantized position; rewrite indices.
 */
export const weldNavMeshVertices = (
  positions: Float32Array,
  indices: Uint32Array
): WeldedMesh => {
  const vertCount = Math.floor(positions.length / 3);
  const remap = new Uint32Array(vertCount);
  const keyToNew = new Map<string, number>();
  const welded: number[] = [];

  for (let i = 0; i < vertCount; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    const key = quantKey(x, y, z);
    let ni = keyToNew.get(key);
    if (ni === undefined) {
      ni = welded.length / 3;
      keyToNew.set(key, ni);
      welded.push(x, y, z);
    }
    remap[i] = ni;
  }

  const nextIndices = new Uint32Array(indices.length);
  let write = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t]!]!;
    const b = remap[indices[t + 1]!]!;
    const c = remap[indices[t + 2]!]!;
    if (a === b || b === c || c === a) {
      continue;
    }
    nextIndices[write++] = a;
    nextIndices[write++] = b;
    nextIndices[write++] = c;
  }

  return {
    positions: new Float32Array(welded),
    indices: nextIndices.subarray(0, write),
    remap,
  };
};
