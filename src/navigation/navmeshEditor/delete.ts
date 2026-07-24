/**
 * Delete selected vertices and any triangles that reference them, then compact.
 */

export interface DeleteSelectedVerticesResult {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
  readonly removedTriangleCount: number;
  readonly removedVertexCount: number;
}

/**
 * Drop triangles that touch any selected vertex; compact unused vertices.
 * @returns null when selection is empty or the result would have no triangles
 */
export const deleteSelectedVertices = (
  positions: Float32Array,
  indices: Uint32Array,
  selected: ReadonlySet<number>
): DeleteSelectedVerticesResult | null => {
  if (selected.size === 0) {
    return null;
  }

  const keptTris: number[] = [];
  let removedTriangleCount = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    if (selected.has(a) || selected.has(b) || selected.has(c)) {
      removedTriangleCount++;
      continue;
    }
    keptTris.push(a, b, c);
  }

  if (keptTris.length < 3) {
    return null;
  }

  const used = new Set<number>();
  for (const vi of keptTris) {
    used.add(vi);
  }

  const oldCount = Math.floor(positions.length / 3);
  const remap = new Int32Array(oldCount);
  remap.fill(-1);
  const nextPositions: number[] = [];
  for (let i = 0; i < oldCount; i++) {
    if (!used.has(i)) {
      continue;
    }
    remap[i] = nextPositions.length / 3;
    nextPositions.push(
      positions[i * 3]!,
      positions[i * 3 + 1]!,
      positions[i * 3 + 2]!
    );
  }

  const nextIndices = new Uint32Array(keptTris.length);
  for (let i = 0; i < keptTris.length; i++) {
    const mapped = remap[keptTris[i]!]!;
    if (mapped < 0) {
      return null;
    }
    nextIndices[i] = mapped;
  }

  const newCount = nextPositions.length / 3;
  return {
    indices: nextIndices,
    positions: new Float32Array(nextPositions),
    removedTriangleCount,
    removedVertexCount: oldCount - newCount,
  };
};
