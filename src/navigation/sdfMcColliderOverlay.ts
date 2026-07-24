/**
 * Hard invariant: SDF-MC cyan overlay is the volumetric interior MC shell
 * (`collider_mesh`), never the projected Recast floor (`mesh`).
 */

export interface MeshLike {
  readonly vertices: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly vertex_count: number;
  readonly face_count: number;
}

export const SDF_MC_MISSING_COLLIDER_ERROR =
  'SDF-MC missing collider_mesh (interior MC shell). Hard-refresh after npm run build:wasm, then clear nav cache and reload the splat.';

/**
 * Require a non-empty MC shell for cyan overlay. Never falls back to `mesh`.
 * @throws when collider_mesh is missing or empty
 */
export function requireSdfMcColliderMesh(params: {
  readonly colliderMesh: MeshLike | null | undefined;
  readonly recastMesh?: MeshLike | null;
}): MeshLike {
  const { colliderMesh, recastMesh } = params;
  if (
    !colliderMesh ||
    colliderMesh.vertex_count <= 0 ||
    colliderMesh.face_count <= 0 ||
    colliderMesh.indices.length < 3
  ) {
    throw new Error(SDF_MC_MISSING_COLLIDER_ERROR);
  }

  if (recastMesh && recastMesh.vertex_count > 0) {
    const colliderH = meshHeight(colliderMesh);
    const recastH = meshHeight(recastMesh);
    const volumetric =
      colliderMesh.vertex_count > recastMesh.vertex_count || colliderH > recastH * 2.5 + 0.25;
    if (!volumetric) {
      console.error(
        '[ERROR] SDF-MC collider_mesh failed volumetric sanity check vs Recast floor sheet ' +
          `(collider ${colliderMesh.vertex_count} verts h=${colliderH.toFixed(2)}, ` +
          `mesh ${recastMesh.vertex_count} verts h=${recastH.toFixed(2)}). ` +
          'Still showing collider_mesh only — never the projected floor as cyan.'
      );
    }
  }

  return colliderMesh;
}

function meshHeight(mesh: MeshLike): number {
  const v = mesh.vertices;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < v.length; i += 3) {
    const y = Number(v[i]);
    if (y < minY) {
      minY = y;
    }
    if (y > maxY) {
      maxY = y;
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return 0;
  }
  return maxY - minY;
}
