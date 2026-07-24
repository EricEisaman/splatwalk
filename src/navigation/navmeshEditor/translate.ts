/**
 * Apply translation deltas to selected navmesh vertices.
 */

import { readVertex, writeVertex } from './selection';
import type { NavMeshEditorVec3 } from './types';

export const translateVertices = (
  positions: Float32Array,
  vertexIndices: readonly number[],
  delta: NavMeshEditorVec3
): void => {
  const seen = new Set<number>();
  for (const index of vertexIndices) {
    if (seen.has(index)) {
      continue;
    }
    seen.add(index);
    const v = readVertex(positions, index);
    writeVertex(positions, index, {
      x: v.x + delta.x,
      y: v.y + delta.y,
      z: v.z + delta.z,
    });
  }
};
