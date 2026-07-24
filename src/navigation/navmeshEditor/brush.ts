/**
 * Circle brush helpers for the NavMesh Editor.
 */

import {
  NAVMESH_EDITOR_DEFAULT_BRUSH_RADIUS_M,
  NAVMESH_EDITOR_MAX_BRUSH_RADIUS_M,
  NAVMESH_EDITOR_MIN_BRUSH_RADIUS_M,
  type NavMeshEditorBrush,
  type NavMeshEditorVec3,
} from './types';

export const clampBrushRadius = (radius: number): number =>
  Math.min(
    NAVMESH_EDITOR_MAX_BRUSH_RADIUS_M,
    Math.max(NAVMESH_EDITOR_MIN_BRUSH_RADIUS_M, radius)
  );

export const createDefaultBrush = (): NavMeshEditorBrush => ({
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  radius: NAVMESH_EDITOR_DEFAULT_BRUSH_RADIUS_M,
  holeDetected: false,
});

export const updateBrushPose = (
  brush: NavMeshEditorBrush,
  center: NavMeshEditorVec3,
  normal: NavMeshEditorVec3
): NavMeshEditorBrush => ({
  ...brush,
  center,
  normal,
});
