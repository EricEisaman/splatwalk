/**
 * Debounced Detour rebake of an edited navmesh debug triangle mesh.
 */

import NavWorker from '@/navigation/navmesh.worker?worker';
import { FAST_NAV_BASE_PARAMS } from '@/navigation/fastNav';
import type { NavMeshEditorRebakeResult } from './types';

const EDITOR_SOURCE_LABEL = 'fast_floor_field_editor';

/**
 * Rebake edited overlay triangles into a Detour navmesh via the Recast worker.
 */
export const rebakeEditedNavMesh = (options: {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}): Promise<NavMeshEditorRebakeResult> => {
  const positions = new Float32Array(options.positions);
  const indices = new Uint32Array(options.indices);
  const worker = new NavWorker();
  return new Promise<NavMeshEditorRebakeResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent): void => {
      const { type, payload } = e.data;
      if (type === 'done') {
        worker.terminate();
        resolve({
          navMeshData: payload.navMeshData as Uint8Array,
          debugPositions: payload.debugPositions as Float32Array,
          debugIndices: payload.debugIndices as Uint32Array,
        });
      } else if (type === 'error') {
        worker.terminate();
        reject(new Error(String(payload)));
      }
    };
    worker.onerror = (event): void => {
      worker.terminate();
      reject(new Error(event.message || 'NavMesh editor rebake worker crashed.'));
    };
    worker.postMessage(
      {
        type: 'generate',
        payload: {
          positions,
          indices,
          params: { ...FAST_NAV_BASE_PARAMS },
          sourceLabel: EDITOR_SOURCE_LABEL,
          splatBounds: null,
          colliderBounds: null,
        },
      },
      [positions.buffer, indices.buffer]
    );
  });
};
