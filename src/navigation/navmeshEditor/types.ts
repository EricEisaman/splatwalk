/**
 * Shared types for the NavMesh Editor (Blender-like modes over Recast debug mesh).
 */

/** Edit mode: 1 vertex · 2 circle · 3 global Y. */
export type NavMeshEditorMode = 'vertex' | 'circle' | 'global';

export interface NavMeshEditorBuffers {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface NavMeshEditorVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface NavMeshEditorBrush {
  center: NavMeshEditorVec3;
  /** Unit normal of the nearest cell (brush plane). */
  normal: NavMeshEditorVec3;
  radius: number;
  /** True when a fillable hole/bridge intersects the brush (circle mode). */
  holeDetected: boolean;
}

export interface NavMeshEditorRebakeResult {
  readonly navMeshData: Uint8Array;
  readonly debugPositions: Float32Array;
  readonly debugIndices: Uint32Array;
}

export interface NavMeshEditorStatus {
  readonly enabled: boolean;
  readonly mode: NavMeshEditorMode;
  readonly selectedCount: number;
  readonly brushRadius: number;
  /** True when circle tracks the cursor; false when pinned. */
  readonly brushFollow: boolean;
  readonly holeDetected: boolean;
  /** True when overlay edits are not yet applied to Detour / artifacts. */
  readonly hasPendingLiveApply: boolean;
  readonly rebaking: boolean;
  readonly message: string;
}

/** Default circle brush radius (m). */
export const NAVMESH_EDITOR_DEFAULT_BRUSH_RADIUS_M = 1.25;

/** Min / max brush radius (m). */
export const NAVMESH_EDITOR_MIN_BRUSH_RADIUS_M = 0.15;
export const NAVMESH_EDITOR_MAX_BRUSH_RADIUS_M = 25;

/** Circle radius step on click / Shift+click (m). */
export const NAVMESH_EDITOR_BRUSH_RADIUS_STEP_M = 0.1;

/** Global Y step (m). */
export const NAVMESH_EDITOR_GLOBAL_Y_STEP_M = 0.1;

/** Debounce before Detour rebake (ms). */
export const NAVMESH_EDITOR_REBAKE_DEBOUNCE_MS = 200;
