/**
 * Click-to-move for Recast crowd: raycast any visible surface (splats, collider
 * shell, walls, ceilings) then snap to the nearest navmesh point. Wall/ceiling
 * hits project toward walkable XZ near the agent.
 */

import type { AbstractMesh, Camera, Scene } from '@babylonjs/core';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { NavMeshQuery } from 'recast-navigation';

const NAV_QUERY_HALF_EXTENTS = { x: 3, y: 6, z: 3 };

export interface NavSurfacePickOptions {
  readonly camera: Camera;
  readonly colliderMeshes: readonly AbstractMesh[];
  readonly isSplatVisualMesh: (mesh: AbstractMesh) => boolean;
  readonly scene: Scene;
  readonly skipMeshes: ReadonlySet<AbstractMesh>;
}

/** Ray pick the first visible scene surface suitable for nav targeting (not the green debug mesh). */
export const pickNavSurfacePoint = (options: NavSurfacePickOptions): Vector3 | null => {
  const { camera, scene } = options;
  const ray = scene.createPickingRay(
    scene.pointerX,
    scene.pointerY,
    null,
    camera,
    false
  );
  if (!ray) {
    return null;
  }

  const predicate = (mesh: AbstractMesh): boolean => {
    if (!mesh.isEnabled() || mesh.isDisposed()) {
      return false;
    }
    if (options.skipMeshes.has(mesh)) {
      return false;
    }
    if (mesh.name === 'navmesh_debug') {
      return false;
    }
    if (options.colliderMeshes.includes(mesh)) {
      return true;
    }
    if (options.isSplatVisualMesh(mesh)) {
      return true;
    }
    return mesh.isPickable && mesh.isVisible;
  };

  const pick = scene.pickWithRay(ray, predicate);
  if (pick?.hit && pick.pickedPoint) {
    return pick.pickedPoint.clone();
  }
  return null;
};

/** Snap a surface hit to the nearest walkable navmesh point (PC walk-mode XZ projection). */
export const resolveNavMoveTarget = (
  navMeshQuery: NavMeshQuery,
  surfaceHit: Vector3,
  agentPosition: { readonly x: number; readonly y: number; readonly z: number }
): Vector3 | null => {
  const queryPoint = {
    x: surfaceHit.x,
    y: agentPosition.y,
    z: surfaceHit.z,
  };
  const snapped = navMeshQuery.findClosestPoint(queryPoint, {
    halfExtents: NAV_QUERY_HALF_EXTENTS,
  });
  if (snapped.success && snapped.point) {
    return new Vector3(snapped.point.x, snapped.point.y, snapped.point.z);
  }

  const direct = navMeshQuery.findClosestPoint(
    { x: surfaceHit.x, y: surfaceHit.y, z: surfaceHit.z },
    { halfExtents: NAV_QUERY_HALF_EXTENTS }
  );
  if (direct.success && direct.point) {
    return new Vector3(direct.point.x, direct.point.y, direct.point.z);
  }
  return null;
};

/** Fallback: pick the green navmesh debug overlay directly. */
export const pickNavDebugMeshPoint = (
  scene: Scene,
  navMeshDebugMesh: AbstractMesh | null
): Vector3 | null => {
  if (!navMeshDebugMesh) {
    return null;
  }
  const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => mesh === navMeshDebugMesh);
  if (pick?.hit && pick.pickedPoint) {
    return pick.pickedPoint.clone();
  }
  return null;
};
