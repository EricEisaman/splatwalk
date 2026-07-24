/**
 * Engine-agnostic NavMesh Editor session: Blender-like modes, brush, edits, rebake.
 */

import { deleteSelectedVertices } from './delete';
import { shiftAllVerticesYByStep } from './globalY';
import {
  appendFillTriangles,
  bridgeGapsUnderBrush,
  earClipFill,
  findHoleUnderBrush,
  type BoundaryLoop,
} from './holes';
import { rebakeEditedNavMesh } from './rebake';
import {
  centroidOfVertices,
  nearestVertexIndex,
  pickNavMeshTriangle,
  readVertex,
  verticesInBrush,
} from './selection';
import { translateVertices } from './translate';
import {
  NAVMESH_EDITOR_BRUSH_RADIUS_STEP_M,
  NAVMESH_EDITOR_DEFAULT_BRUSH_RADIUS_M,
  NAVMESH_EDITOR_GLOBAL_Y_STEP_M,
  NAVMESH_EDITOR_MAX_BRUSH_RADIUS_M,
  NAVMESH_EDITOR_MIN_BRUSH_RADIUS_M,
  type NavMeshEditorBrush,
  type NavMeshEditorMode,
  type NavMeshEditorRebakeResult,
  type NavMeshEditorStatus,
  type NavMeshEditorVec3,
} from './types';
import { weldNavMeshVertices } from './weld';

export type NavMeshEditorChangeListener = (status: NavMeshEditorStatus) => void;
export type NavMeshEditorBuffersListener = (info: {
  readonly topologyChanged: boolean;
}) => void;
export type NavMeshEditorRebakeListener = (
  result: NavMeshEditorRebakeResult
) => void | Promise<void>;

export class NavMeshEditorSession {
  private _enabled = false;
  private _mode: NavMeshEditorMode = 'circle';
  private _positions: Float32Array | null = null;
  private _indices: Uint32Array | null = null;
  private _selected = new Set<number>();
  private _brush: NavMeshEditorBrush = {
    center: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    radius: NAVMESH_EDITOR_DEFAULT_BRUSH_RADIUS_M,
    holeDetected: false,
  };
  private _holeLoop: BoundaryLoop | null = null;
  private _bridgeReady = false;
  private _showGizmo = false;
  /** When false (circle pinned by click), brush stops following the cursor. */
  private _brushFollow = true;
  /** Gizmo placement: brush center when circle-pinned; else selection centroid. */
  private _gizmoAnchor: NavMeshEditorVec3 | null = null;
  private _dirty = false;
  private _rebaking = false;
  private _message = '';
  private readonly _onStatus = new Set<NavMeshEditorChangeListener>();
  private readonly _onBuffers = new Set<NavMeshEditorBuffersListener>();
  private readonly _onRebake = new Set<NavMeshEditorRebakeListener>();

  public get enabled(): boolean {
    return this._enabled;
  }

  public get mode(): NavMeshEditorMode {
    return this._mode;
  }

  public get positions(): Float32Array | null {
    return this._positions;
  }

  public get indices(): Uint32Array | null {
    return this._indices;
  }

  public get selectedIndices(): readonly number[] {
    return [...this._selected];
  }

  public get brush(): NavMeshEditorBrush {
    return this._brush;
  }

  public get showGizmo(): boolean {
    return this._showGizmo;
  }

  public get brushFollow(): boolean {
    return this._brushFollow;
  }

  public get brushPinned(): boolean {
    return !this._brushFollow && this._mode === 'circle';
  }

  public get holeDetected(): boolean {
    return (
      this._brush.holeDetected &&
      (this._holeLoop !== null || this._bridgeReady)
    );
  }

  public get hasPendingLiveApply(): boolean {
    return this._dirty;
  }

  /**
   * World/oriented point for the translate gizmo (brush center when pinned).
   */
  public gizmoAnchorPoint(): NavMeshEditorVec3 | null {
    if (!this._showGizmo) {
      return null;
    }
    if (this._gizmoAnchor) {
      return this._gizmoAnchor;
    }
    return this.selectionCentroid();
  }

  public status(): NavMeshEditorStatus {
    return {
      enabled: this._enabled,
      mode: this._mode,
      selectedCount: this._selected.size,
      brushRadius: this._brush.radius,
      brushFollow: this._brushFollow,
      holeDetected: this.holeDetected,
      hasPendingLiveApply: this._dirty,
      rebaking: this._rebaking,
      message: this._message,
    };
  }

  public onStatus(listener: NavMeshEditorChangeListener): () => void {
    this._onStatus.add(listener);
    return () => {
      this._onStatus.delete(listener);
    };
  }

  public onBuffersChanged(listener: NavMeshEditorBuffersListener): () => void {
    this._onBuffers.add(listener);
    return () => {
      this._onBuffers.delete(listener);
    };
  }

  public onRebake(listener: NavMeshEditorRebakeListener): () => void {
    this._onRebake.add(listener);
    return () => {
      this._onRebake.delete(listener);
    };
  }

  public setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) {
      this.resetInteractionState();
      this._dirty = false;
      this._message = '';
    } else {
      this._message = this.modeHint(this._mode);
    }
    this.emitStatus();
  }

  /**
   * Switch mode (keys 1/2/3). Pressing 2 while already in circle restarts follow.
   */
  public setMode(mode: NavMeshEditorMode): void {
    const wasCircle = this._mode === 'circle';
    this._mode = mode;
    if (mode === 'global') {
      this._selected.clear();
      this._showGizmo = false;
      this._gizmoAnchor = null;
      this._brushFollow = false;
      this._holeLoop = null;
      this._bridgeReady = false;
      this._brush = { ...this._brush, holeDetected: false };
      this._message = this.modeHint('global');
    } else if (mode === 'vertex') {
      this._showGizmo = false;
      this._gizmoAnchor = null;
      this._brushFollow = false;
      this._holeLoop = null;
      this._bridgeReady = false;
      this._brush = { ...this._brush, holeDetected: false };
      this._message = this.modeHint('vertex');
    } else {
      // Circle: enter or re-press 2 → follow mouse again.
      this._showGizmo = false;
      this._gizmoAnchor = null;
      this._brushFollow = true;
      this._holeLoop = null;
      this._bridgeReady = false;
      this._brush = { ...this._brush, holeDetected: false };
      this._message = wasCircle
        ? 'Circle following — click to pin. Press 2 again to resume follow anytime.'
        : this.modeHint('circle');
    }
    this.emitStatus();
  }

  /**
   * Load / replace editable buffers (copies). Call after Fast Nav / NavKit.
   * Vertices are welded so boundary topology is reliable for hole fill.
   */
  public setMesh(positions: Float32Array, indices: Uint32Array): void {
    const welded = weldNavMeshVertices(positions, indices);
    this._positions = welded.positions;
    this._indices = welded.indices;
    this.resetInteractionState();
    this._dirty = false;
    this._message = `Loaded ${Math.floor(welded.positions.length / 3)} verts.`;
    this.emitStatus();
    this.emitBuffers(true);
  }

  public clearMesh(): void {
    this._positions = null;
    this._indices = null;
    this.resetInteractionState();
    this._dirty = false;
    this._enabled = false;
    this.emitStatus();
    this.emitBuffers(true);
  }

  public selectionCentroid(): NavMeshEditorVec3 | null {
    if (!this._positions || this._selected.size === 0) {
      return null;
    }
    return centroidOfVertices(this._positions, [...this._selected]);
  }

  /**
   * Show/hide translate gizmo on current circle selection (key T).
   * Does not change brush follow — click pins brush; 2 resumes follow.
   */
  public commitCircleTranslate(): boolean {
    if (!this._enabled || !this._positions) {
      this._message = 'NavMesh Editor is off.';
      this.emitStatus();
      return false;
    }
    if (this._mode !== 'circle') {
      this._message = 'T shows translate gizmo in circle mode (2).';
      this.emitStatus();
      return false;
    }
    if (this._showGizmo) {
      this.unpinCircleTranslate();
      return true;
    }
    if (this._brushFollow) {
      this._message = 'Click to pin the circle first, then press T for gizmo.';
      this.emitStatus();
      return false;
    }
    const verts = verticesInBrush(
      this._positions,
      this._brush.center,
      this._brush.normal,
      this._brush.radius
    );
    if (verts.length === 0) {
      this._message =
        'No verts in circle — click to grow radius (+0.1 m), then press T.';
      this.emitStatus();
      return false;
    }
    this._selected = new Set(verts);
    this._showGizmo = true;
    this._gizmoAnchor = { ...this._brush.center };
    this._message = `Gizmo on ${this._selected.size} verts — drag. Esc hides gizmo.`;
    this.emitStatus();
    return true;
  }

  /** Hide translate gizmo only; brush stays pinned until 2 resumes follow. */
  public unpinCircleTranslate(): void {
    this._showGizmo = false;
    this._gizmoAnchor = null;
    this._message = this.brushPinned
      ? `Pinned · r=${this._brush.radius.toFixed(2)} m · click +0.1 / Shift+click −0.1 · press 2 to follow.`
      : this.modeHint(this._mode);
    this.emitStatus();
  }

  /**
   * Hover / brush follow: ray against mesh. Updates circle selection preview.
   */
  public pointerMoveRay(
    origin: NavMeshEditorVec3,
    dir: NavMeshEditorVec3,
    _clientX: number,
    _clientY: number
  ): void {
    if (!this._enabled || !this._positions || !this._indices) {
      return;
    }
    if (this._mode !== 'circle' || !this._brushFollow) {
      return;
    }

    const hit = pickNavMeshTriangle(this._positions, this._indices, origin, dir);
    if (!hit) {
      return;
    }
    this._brush = {
      ...this._brush,
      center: hit.point,
      normal: hit.normal,
    };
    const verts = verticesInBrush(
      this._positions,
      this._brush.center,
      this._brush.normal,
      this._brush.radius
    );
    this._selected = new Set(verts);
    this.refreshHoleDetection();
    this.emitStatus();
  }

  public pointerDown(_clientX: number, _clientY: number): void {
    // Click handling is on pointerUp; no drag-resize.
  }

  public pointerDrag(_clientX: number, _clientY: number): void {
    // Drag-resize removed (camera conflict).
  }

  /**
   * Mouse up: vertex pick, or circle pin / ± step.
   */
  public pointerUp(
    origin: NavMeshEditorVec3,
    dir: NavMeshEditorVec3,
    _clientX: number,
    _clientY: number,
    options: { readonly shiftKey?: boolean } = {}
  ): void {
    if (!this._enabled || !this._positions || !this._indices) {
      return;
    }

    if (this._mode === 'global') {
      return;
    }

    // While translate gizmo is shown, ignore mesh clicks (gizmo owns drag).
    if (this._showGizmo && this._mode === 'circle') {
      return;
    }

    if (this._mode === 'vertex') {
      const hit = pickNavMeshTriangle(
        this._positions,
        this._indices,
        origin,
        dir
      );
      if (!hit) {
        this.emitStatus();
        return;
      }
      const vi = nearestVertexIndex(this._positions, hit.point);
      this._selected = new Set([vi]);
      this._showGizmo = true;
      this._gizmoAnchor = readVertex(this._positions, vi);
      this._message = `Vertex ${vi} selected — drag gizmo or press X to delete.`;
      this.emitStatus();
      return;
    }

    // Circle mode
    if (this._brushFollow) {
      const hit = pickNavMeshTriangle(
        this._positions,
        this._indices,
        origin,
        dir
      );
      if (!hit) {
        this.emitStatus();
        return;
      }
      this._brush = {
        ...this._brush,
        center: hit.point,
        normal: hit.normal,
      };
      this._brushFollow = false;
      this.refreshCircleSelection();
      this._message =
        `Pinned · r=${this._brush.radius.toFixed(2)} m · ${this._selected.size} verts` +
        ` · click +0.1 / Shift+click −0.1 · press 2 to follow.`;
      this.emitStatus();
      return;
    }

    // Pinned: click grows, Shift+click shrinks.
    const step = NAVMESH_EDITOR_BRUSH_RADIUS_STEP_M;
    const delta = options.shiftKey ? -step : step;
    const next = Math.min(
      NAVMESH_EDITOR_MAX_BRUSH_RADIUS_M,
      Math.max(NAVMESH_EDITOR_MIN_BRUSH_RADIUS_M, this._brush.radius + delta)
    );
    this._brush = { ...this._brush, radius: next };
    this.refreshCircleSelection();
    this._message =
      `Pinned · r=${this._brush.radius.toFixed(2)} m · ${this._selected.size} verts` +
      ` · click +0.1 / Shift+click −0.1 · press 2 to follow.`;
    this.emitStatus();
  }

  /**
   * Delete selected verts (+ incident tris), then Apply to live Detour/artifacts.
   */
  public async deleteSelectedVerticesAndApply(): Promise<boolean> {
    if (!this._enabled || !this._positions || !this._indices) {
      this._message = 'NavMesh Editor is off.';
      this.emitStatus();
      return false;
    }
    if (this._mode !== 'vertex' && this._mode !== 'circle') {
      this._message = 'X deletes in vertex (1) or circle (2) mode.';
      this.emitStatus();
      return false;
    }
    if (this._selected.size === 0) {
      this._message = 'No verts selected — pick/pin, then press X.';
      this.emitStatus();
      return false;
    }
    if (this._rebaking) {
      return false;
    }
    const result = deleteSelectedVertices(
      this._positions,
      this._indices,
      this._selected
    );
    if (!result) {
      this._message =
        'Delete aborted — would remove the entire navmesh (need ≥1 triangle).';
      this.emitStatus();
      return false;
    }
    this._positions = result.positions;
    this._indices = result.indices;
    this.resetInteractionState();
    this.emitBuffers(true);
    this.markDirty(
      `Deleted ${result.removedVertexCount} verts / ${result.removedTriangleCount} tris — applying…`
    );
    return this.applyToLiveNavMesh();
  }

  public applyGizmoDelta(delta: NavMeshEditorVec3): void {
    if (!this._positions || this._selected.size === 0) {
      return;
    }
    translateVertices(this._positions, [...this._selected], delta);
    if (this._gizmoAnchor) {
      this._gizmoAnchor = {
        x: this._gizmoAnchor.x + delta.x,
        y: this._gizmoAnchor.y + delta.y,
        z: this._gizmoAnchor.z + delta.z,
      };
      if (this._mode === 'circle') {
        this._brush = {
          ...this._brush,
          center: { ...this._gizmoAnchor },
        };
      }
    }
    this.emitBuffers(false);
    this.markDirty('Overlay edited — Apply to Live Navmesh when ready.');
  }

  public globalY(steps: number): void {
    if (!this._positions) {
      return;
    }
    if (this._mode !== 'global') {
      this._message = 'Global Y: press 3, then ↑ / ↓.';
      this.emitStatus();
      return;
    }
    shiftAllVerticesYByStep(
      this._positions,
      steps,
      NAVMESH_EDITOR_GLOBAL_Y_STEP_M
    );
    this.emitBuffers(false);
    this.markDirty(
      `Global Y ${steps > 0 ? '+' : ''}${(steps * NAVMESH_EDITOR_GLOBAL_Y_STEP_M).toFixed(2)} m — Apply to Live Navmesh.`
    );
  }

  public fillDetectedHole(): boolean {
    return this.fillHolesUnderBrush({ maxHoles: 1 }) > 0;
  }

  /**
   * Fill closable gap(s) under the current brush (loops, bays, edge bridges).
   * @returns number of holes / bridge batches successfully filled
   */
  public fillHolesUnderBrush(
    options: { readonly maxHoles?: number } = {}
  ): number {
    const maxHoles = options.maxHoles ?? 16;
    if (!this._enabled || !this._positions || !this._indices) {
      this._message = 'NavMesh Editor is off.';
      this.emitStatus();
      return 0;
    }
    if (this._mode !== 'circle') {
      this._message = 'Press 2 for circle mode, then F to fill.';
      this.emitStatus();
      return 0;
    }

    let filled = 0;
    let totalTris = 0;

    for (let i = 0; i < maxHoles; i++) {
      this.refreshHoleDetection();
      if (this._holeLoop) {
        const tris = earClipFill(this._positions, this._holeLoop);
        if (tris.length < 3) {
          this._message =
            filled > 0
              ? `Filled ${filled} gap(s); next loop failed (non-simple).`
              : 'Hole fill failed (non-simple loop).';
          this._holeLoop = null;
          this._brush = { ...this._brush, holeDetected: false };
          this.emitStatus();
          break;
        }
        this._indices = appendFillTriangles(this._indices, tris);
        totalTris += tris.length / 3;
        filled++;
        this._holeLoop = null;
        this._brush = { ...this._brush, holeDetected: false };
        continue;
      }

      const bridge = bridgeGapsUnderBrush(
        this._positions,
        this._indices,
        this._brush.center,
        this._brush.normal,
        this._brush.radius
      );
      if (bridge.length < 3) {
        break;
      }
      this._indices = appendFillTriangles(this._indices, bridge);
      totalTris += bridge.length / 3;
      filled++;
      this._bridgeReady = false;
      this._brush = { ...this._brush, holeDetected: false };
    }

    if (filled === 0) {
      this._message =
        'No closable gap under brush — pin and grow the circle over facing edges, then F.';
      this.emitStatus();
      return 0;
    }

    this.emitBuffers(true);
    this.markDirty(
      filled === 1
        ? `Filled gap (+${totalTris} tris) — Apply to Live Navmesh.`
        : `Filled ${filled} gaps (+${totalTris} tris) — Apply to Live Navmesh.`
    );
    return filled;
  }

  /**
   * Rebake Detour + notify hosts (crowd / artifacts). Clears dirty on success.
   */
  public async applyToLiveNavMesh(): Promise<boolean> {
    if (!this._enabled || !this._positions || !this._indices) {
      this._message = 'NavMesh Editor is off.';
      this.emitStatus();
      return false;
    }
    if (!this._dirty) {
      this._message = 'No pending edits to apply.';
      this.emitStatus();
      return false;
    }
    if (this._rebaking) {
      return false;
    }
    const ok = await this.runRebake();
    if (ok) {
      this._dirty = false;
      this._message = 'Applied to live navmesh + artifacts.';
      this.emitStatus();
    }
    return ok;
  }

  public dispose(): void {
    this.clearMesh();
    this._onStatus.clear();
    this._onBuffers.clear();
    this._onRebake.clear();
  }

  private modeHint(mode: NavMeshEditorMode): string {
    if (mode === 'vertex') {
      return 'Mode: Vertex (1) — click vert, drag gizmo, X delete.';
    }
    if (mode === 'global') {
      return 'Mode: Global Y (3) — ↑ / ↓ by 0.1 m, then Apply.';
    }
    return 'Mode: Circle (2) — follow mouse, click pin, click/+Shift radius, T/F/X.';
  }

  private refreshCircleSelection(): void {
    if (!this._positions || !this._indices) {
      return;
    }
    const verts = verticesInBrush(
      this._positions,
      this._brush.center,
      this._brush.normal,
      this._brush.radius
    );
    this._selected = new Set(verts);
    this.refreshHoleDetection();
  }

  private resetInteractionState(): void {
    this._selected.clear();
    this._showGizmo = false;
    this._gizmoAnchor = null;
    this._brushFollow = this._mode === 'circle';
    this._holeLoop = null;
    this._bridgeReady = false;
    this._brush = { ...this._brush, holeDetected: false };
  }

  private refreshHoleDetection(): void {
    if (!this._positions || !this._indices || this._mode !== 'circle') {
      this._holeLoop = null;
      this._bridgeReady = false;
      this._brush = { ...this._brush, holeDetected: false };
      return;
    }
    this._holeLoop = findHoleUnderBrush(
      this._positions,
      this._indices,
      this._brush.center,
      this._brush.normal,
      this._brush.radius
    );
    if (this._holeLoop) {
      this._bridgeReady = false;
      this._brush = { ...this._brush, holeDetected: true };
      return;
    }
    const bridge = bridgeGapsUnderBrush(
      this._positions,
      this._indices,
      this._brush.center,
      this._brush.normal,
      this._brush.radius
    );
    this._bridgeReady = bridge.length >= 3;
    this._brush = { ...this._brush, holeDetected: this._bridgeReady };
  }

  private markDirty(message: string): void {
    this._dirty = true;
    this._message = message;
    this.emitStatus();
  }

  private async runRebake(): Promise<boolean> {
    if (!this._positions || !this._indices) {
      return false;
    }
    const editedPositions = new Float32Array(this._positions);
    const editedIndices = new Uint32Array(this._indices);
    this._rebaking = true;
    this._message = 'Applying to live navmesh…';
    this.emitStatus();
    try {
      const result = await rebakeEditedNavMesh({
        positions: editedPositions,
        indices: editedIndices,
      });
      // Prefer keeping user-edited topology if Recast debug shrinks after a fill.
      const keepEdited =
        result.debugIndices.length < editedIndices.length &&
        editedIndices.length >= 3;
      if (keepEdited) {
        console.warn(
          '[WARN] NavMesh Editor: rebake debug mesh shrank; keeping edited overlay buffers.'
        );
        this._positions = editedPositions;
        this._indices = editedIndices;
        this.emitBuffers(true);
        for (const listener of this._onRebake) {
          await listener({
            navMeshData: result.navMeshData,
            debugPositions: editedPositions,
            debugIndices: editedIndices,
          });
        }
      } else if (
        result.debugPositions.length >= 9 &&
        result.debugIndices.length >= 3
      ) {
        this._positions = new Float32Array(result.debugPositions);
        this._indices = new Uint32Array(result.debugIndices);
        this.emitBuffers(true);
        for (const listener of this._onRebake) {
          await listener(result);
        }
      } else {
        for (const listener of this._onRebake) {
          await listener(result);
        }
      }
      this._message = 'Rebake complete.';
      return true;
    } catch (error) {
      this._message =
        error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this._rebaking = false;
      this.emitStatus();
    }
  }

  private emitStatus(): void {
    const s = this.status();
    for (const listener of this._onStatus) {
      listener(s);
    }
  }

  private emitBuffers(topologyChanged: boolean): void {
    for (const listener of this._onBuffers) {
      listener({ topologyChanged });
    }
  }
}

/** Convenience re-export for hosts that only need a point. */
export { readVertex };
