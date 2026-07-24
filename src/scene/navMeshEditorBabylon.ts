/**
 * Babylon visuals + input for {@link NavMeshEditorSession}.
 */

import {
  Color3,
  GizmoManager,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  StandardMaterial,
  Vector3,
  type Observer,
  type PointerInfo,
  type Scene,
} from '@babylonjs/core';

import {
  NavMeshEditorSession,
  type NavMeshEditorRebakeResult,
  type NavMeshEditorStatus,
  type NavMeshEditorVec3,
} from '@/navigation/navmeshEditor';

export interface NavMeshEditorBabylonHost {
  readonly scene: Scene;
  getOrientedNavMeshBuffers(): {
    positions: Float32Array;
    indices: Uint32Array;
  } | null;
  refreshNavMeshOverlayFromOriented(
    positions: Float32Array,
    indices: Uint32Array,
    options?: { readonly topologyChanged?: boolean }
  ): void;
  applyEditedNavMeshRebake(result: NavMeshEditorRebakeResult): Promise<void>;
  orientedPointToWorld(p: NavMeshEditorVec3): Vector3;
  worldPointToOriented(p: Vector3): NavMeshEditorVec3;
}

const PINK = new Color3(1, 0.3, 0.75);
const MAX_PINK_MARKERS = 128;

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
};

export class NavMeshEditorBabylon {
  private readonly _session = new NavMeshEditorSession();
  private _brushMesh: Mesh | null = null;
  private _pointsRoot: Mesh | null = null;
  private _gizmoAnchor: Mesh | null = null;
  private _gizmo: GizmoManager | null = null;
  private _pointerObs: Observer<PointerInfo> | null = null;
  private _lastGizmoPos: Vector3 | null = null;
  private _gizmoDragging = false;
  private _unsubBuffers: (() => void) | null = null;
  private _unsubRebake: (() => void) | null = null;
  private _pinkMat: StandardMaterial | null = null;
  private readonly _onKeyDown = (event: KeyboardEvent): void => {
    if (!this._session.enabled || isTypingTarget(event.target)) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (event.key === '1') {
      event.preventDefault();
      this._session.setMode('vertex');
      this._gizmoDragging = false;
      this.syncVisuals();
      return;
    }
    if (event.key === '2') {
      event.preventDefault();
      this._session.setMode('circle');
      this._gizmoDragging = false;
      this.syncVisuals();
      return;
    }
    if (event.key === '3') {
      event.preventDefault();
      this._session.setMode('global');
      this._gizmoDragging = false;
      this.syncVisuals();
      return;
    }

    if (event.key === 'Escape') {
      if (this._session.showGizmo) {
        event.preventDefault();
        this._session.unpinCircleTranslate();
        this.syncVisuals();
      }
      return;
    }

    if (event.key === 't' || event.key === 'T') {
      event.preventDefault();
      this._session.commitCircleTranslate();
      this._gizmoDragging = false;
      this.syncVisuals();
      return;
    }

    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      this._session.fillHolesUnderBrush();
      this.syncVisuals();
      return;
    }

    if (event.key === 'x' || event.key === 'X') {
      event.preventDefault();
      void this._session.deleteSelectedVerticesAndApply().then(() => {
        this.syncVisuals();
      });
      return;
    }

    if (this._session.mode === 'global') {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this._session.globalY(1);
        this.syncVisuals();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this._session.globalY(-1);
        this.syncVisuals();
      }
    }
  };

  public constructor(private readonly _host: NavMeshEditorBabylonHost) {}

  public get session(): NavMeshEditorSession {
    return this._session;
  }

  public onStatus(listener: (s: NavMeshEditorStatus) => void): () => void {
    return this._session.onStatus((s) => {
      this.syncVisuals();
      listener(s);
    });
  }

  public setEnabled(enabled: boolean): void {
    const buffers = this._host.getOrientedNavMeshBuffers();
    if (enabled && buffers) {
      this._session.setMesh(buffers.positions, buffers.indices);
    }
    this._session.setEnabled(enabled);
    if (enabled) {
      this.attachInput();
      window.addEventListener('keydown', this._onKeyDown);
      this.ensureBrushMesh();
      this._unsubBuffers?.();
      this._unsubBuffers = this._session.onBuffersChanged((info) => {
        const pos = this._session.positions;
        const idx = this._session.indices;
        if (pos && idx) {
          this._host.refreshNavMeshOverlayFromOriented(pos, idx, {
            topologyChanged: info.topologyChanged,
          });
        }
        this.syncVisuals();
      });
      this._unsubRebake?.();
      this._unsubRebake = this._session.onRebake(async (result) => {
        await this._host.applyEditedNavMeshRebake(result);
      });
    } else {
      this.detachInput();
      window.removeEventListener('keydown', this._onKeyDown);
      this.clearVisuals();
      this._unsubBuffers?.();
      this._unsubBuffers = null;
      this._unsubRebake?.();
      this._unsubRebake = null;
    }
    this.syncVisuals();
  }

  public dispose(): void {
    this.setEnabled(false);
    this._session.dispose();
    this._pinkMat?.dispose();
    this._pinkMat = null;
  }

  private attachInput(): void {
    if (this._pointerObs) {
      return;
    }
    this._pointerObs = this._host.scene.onPointerObservable.add((info) => {
      if (!this._session.enabled) {
        return;
      }
      if (this._gizmoDragging) {
        return;
      }
      const ray = this._host.scene.createPickingRay(
        this._host.scene.pointerX,
        this._host.scene.pointerY,
        null,
        this._host.scene.activeCamera
      );
      const originW = ray.origin;
      const dirW = ray.direction;
      const origin = this._host.worldPointToOriented(originW);
      const dirEnd = this._host.worldPointToOriented(originW.add(dirW));
      const dir = {
        x: dirEnd.x - origin.x,
        y: dirEnd.y - origin.y,
        z: dirEnd.z - origin.z,
      };

      if (info.type === PointerEventTypes.POINTERMOVE) {
        this._session.pointerMoveRay(
          origin,
          dir,
          info.event.clientX,
          info.event.clientY
        );
        this.syncVisuals();
      } else if (info.type === PointerEventTypes.POINTERUP) {
        this._session.pointerUp(
          origin,
          dir,
          info.event.clientX,
          info.event.clientY,
          { shiftKey: info.event.shiftKey }
        );
        this.syncVisuals();
      }
    });
  }

  private detachInput(): void {
    if (this._pointerObs) {
      this._host.scene.onPointerObservable.remove(this._pointerObs);
      this._pointerObs = null;
    }
  }

  private ensureBrushMesh(): void {
    if (this._brushMesh) {
      return;
    }
    const disc = MeshBuilder.CreateDisc(
      'navmesh_editor_brush',
      { radius: 1, tessellation: 48 },
      this._host.scene
    );
    const mat = new StandardMaterial('navmesh_editor_brush_mat', this._host.scene);
    mat.diffuseColor = new Color3(0.2, 0.7, 1);
    mat.alpha = 0.35;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    disc.material = mat;
    disc.isPickable = false;
    disc.renderingGroupId = 1;
    this._brushMesh = disc;
  }

  private pinkMaterial(): StandardMaterial {
    if (!this._pinkMat) {
      this._pinkMat = new StandardMaterial('navmesh_editor_sel_mat', this._host.scene);
      this._pinkMat.diffuseColor = PINK;
      this._pinkMat.emissiveColor = PINK.scale(0.45);
      this._pinkMat.disableDepthWrite = true;
    }
    return this._pinkMat;
  }

  private syncVisuals(): void {
    const brush = this._session.brush;
    if (this._brushMesh) {
      const show = this._session.enabled && this._session.mode === 'circle';
      this._brushMesh.setEnabled(show);
      if (show) {
        const world = this._host.orientedPointToWorld(brush.center);
        this._brushMesh.position.copyFrom(world);
        this._brushMesh.scaling.setAll(Math.max(brush.radius, 0.05));
        const n = new Vector3(brush.normal.x, brush.normal.y, brush.normal.z);
        this._brushMesh.lookAt(world.add(n));
        const mat = this._brushMesh.material as StandardMaterial;
        mat.diffuseColor = brush.holeDetected ? PINK : new Color3(0.2, 0.7, 1);
        mat.alpha = brush.holeDetected ? 0.45 : 0.35;
      }
    }
    this.syncPinkPoints();
    this.syncGizmo();
  }

  private syncPinkPoints(): void {
    if (this._pointsRoot) {
      this._pointsRoot.dispose(false, true);
      this._pointsRoot = null;
    }
    const selected = this._session.selectedIndices;
    const positions = this._session.positions;
    if (
      !this._session.enabled ||
      !positions ||
      selected.length === 0 ||
      this._session.mode === 'global'
    ) {
      return;
    }
    const root = new Mesh('navmesh_editor_sel_root', this._host.scene);
    root.isPickable = false;
    root.renderingGroupId = 1;
    const mat = this.pinkMaterial();
    const lim = Math.min(selected.length, MAX_PINK_MARKERS);
    for (let i = 0; i < lim; i++) {
      const vi = selected[i]!;
      const o = {
        x: positions[vi * 3]!,
        y: positions[vi * 3 + 1]!,
        z: positions[vi * 3 + 2]!,
      };
      const s = MeshBuilder.CreateSphere(
        `navmesh_editor_sel_${i}`,
        { diameter: 0.12, segments: 6 },
        this._host.scene
      );
      s.parent = root;
      s.position.copyFrom(this._host.orientedPointToWorld(o));
      s.material = mat;
      s.isPickable = false;
      s.renderingGroupId = 1;
    }
    this._pointsRoot = root;
  }

  private syncGizmo(): void {
    const anchor = this._session.gizmoAnchorPoint();
    const show =
      this._session.enabled &&
      this._session.showGizmo &&
      this._session.mode !== 'global' &&
      anchor !== null;

    if (!show) {
      this.clearGizmo();
      return;
    }
    if (!this._gizmoAnchor) {
      this._gizmoAnchor = MeshBuilder.CreateBox(
        'navmesh_editor_gizmo_anchor',
        { size: 0.05 },
        this._host.scene
      );
      this._gizmoAnchor.isVisible = false;
      this._gizmoAnchor.isPickable = false;
    }

    // Never snap the anchor while the user is dragging the gizmo.
    if (!this._gizmoDragging) {
      const world = this._host.orientedPointToWorld(anchor!);
      this._gizmoAnchor.position.copyFrom(world);
      this._lastGizmoPos = world.clone();
    }

    if (!this._gizmo) {
      this._gizmo = new GizmoManager(this._host.scene);
      this._gizmo.positionGizmoEnabled = true;
      this._gizmo.rotationGizmoEnabled = false;
      this._gizmo.scaleGizmoEnabled = false;
      this._gizmo.attachableMeshes = [this._gizmoAnchor];
      this._gizmo.attachToMesh(this._gizmoAnchor);
      const posGizmo = this._gizmo.gizmos.positionGizmo;
      posGizmo?.onDragStartObservable.add(() => {
        this._gizmoDragging = true;
      });
      posGizmo?.onDragEndObservable.add(() => {
        this._gizmoDragging = false;
        this.syncVisuals();
      });
      posGizmo?.onDragObservable.add(() => {
        if (!this._gizmoAnchor || !this._lastGizmoPos) {
          return;
        }
        const cur = this._gizmoAnchor.position.clone();
        const prev = this._lastGizmoPos.clone();
        this._lastGizmoPos = cur.clone();
        const a = this._host.worldPointToOriented(prev);
        const b = this._host.worldPointToOriented(cur);
        this._session.applyGizmoDelta({
          x: b.x - a.x,
          y: b.y - a.y,
          z: b.z - a.z,
        });
        this.syncPinkPoints();
      });
    } else if (!this._gizmo.attachedMesh) {
      this._gizmo.attachToMesh(this._gizmoAnchor);
    }
  }

  private clearGizmo(): void {
    this._gizmoDragging = false;
    if (this._gizmo) {
      this._gizmo.attachToMesh(null);
      this._gizmo.dispose();
      this._gizmo = null;
    }
    if (this._gizmoAnchor) {
      this._gizmoAnchor.dispose();
      this._gizmoAnchor = null;
    }
    this._lastGizmoPos = null;
  }

  private clearVisuals(): void {
    this.clearGizmo();
    if (this._brushMesh) {
      this._brushMesh.dispose();
      this._brushMesh = null;
    }
    if (this._pointsRoot) {
      this._pointsRoot.dispose(false, true);
      this._pointsRoot = null;
    }
  }
}
