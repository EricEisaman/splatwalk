/**
 * Pack / unpack Recast debug navmesh overlay as `walkable_floors.glb`.
 * Used so NavKit / minimal packs remain click-to-move without a volume trio.
 */

import {
  getNavMeshPositionsAndIndices,
  importNavMesh,
  init as initRecast,
} from 'recast-navigation';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BufferGeometry, Mesh } from 'three';

import { splatwalk } from '@/wasm/bridge';

export interface WalkableFloorMesh {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
}

const meshHasGeometry = (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>
): boolean => positions.length >= 3 && indices.length >= 3;

/**
 * Encode oriented-space navmesh triangles as a GLB for artifact packs.
 */
export const walkableFloorsMeshToGlb = async (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>
): Promise<Uint8Array | null> => {
  if (!meshHasGeometry(positions, indices)) {
    return null;
  }
  return splatwalk.meshToGlb(
    positions instanceof Float32Array ? positions : Float32Array.from(positions),
    indices instanceof Uint32Array ? indices : Uint32Array.from(indices)
  );
};

const geometryToMesh = (geometry: BufferGeometry): WalkableFloorMesh | null => {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 3) {
    return null;
  }
  const positions = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    positions[i * 3] = posAttr.getX(i);
    positions[i * 3 + 1] = posAttr.getY(i);
    positions[i * 3 + 2] = posAttr.getZ(i);
  }
  const index = geometry.getIndex();
  if (!index || index.count < 3) {
    // Non-indexed triangle list
    const triCount = Math.floor(posAttr.count / 3) * 3;
    if (triCount < 3) {
      return null;
    }
    const indices = new Uint32Array(triCount);
    for (let i = 0; i < triCount; i++) {
      indices[i] = i;
    }
    return { positions, indices };
  }
  const indices = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) {
    indices[i] = index.getX(i);
  }
  return { positions, indices };
};

/**
 * Decode `walkable_floors.glb` bytes back to oriented-space positions/indices.
 */
export const walkableFloorsGlbToMesh = async (
  glb: Uint8Array
): Promise<WalkableFloorMesh> => {
  const loader = new GLTFLoader();
  const copy = glb.slice();
  const ab = copy.buffer.slice(
    copy.byteOffset,
    copy.byteOffset + copy.byteLength
  );
  const gltf = await loader.parseAsync(ab, '');
  let found: WalkableFloorMesh | null = null;
  gltf.scene.traverse((obj) => {
    if (found) {
      return;
    }
    const mesh = obj as Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }
    found = geometryToMesh(mesh.geometry);
  });
  if (!found) {
    throw new Error('walkable_floors.glb has no usable mesh geometry.');
  }
  return found;
};

/**
 * Rebuild clickable overlay triangles from a serialized Recast navmesh binary.
 * Used when older NavKits omit `walkable_floors.glb`.
 */
export const recastNavmeshBinToOverlayMesh = async (
  navMeshData: Uint8Array
): Promise<WalkableFloorMesh | null> => {
  if (!navMeshData.byteLength) {
    return null;
  }
  await initRecast();
  const tight = navMeshData.slice();
  const { navMesh } = importNavMesh(tight);
  const [rawPositions, rawIndices] = getNavMeshPositionsAndIndices(navMesh);
  if (!meshHasGeometry(rawPositions, rawIndices)) {
    return null;
  }
  return {
    positions: new Float32Array(rawPositions),
    indices: new Uint32Array(rawIndices),
  };
};
