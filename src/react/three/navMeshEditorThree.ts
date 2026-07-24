/**
 * Three.js visuals + input for {@link NavMeshEditorSession}.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import {
  NavMeshEditorSession,
  type NavMeshEditorRebakeResult,
  type NavMeshEditorStatus,
  type NavMeshEditorVec3,
} from '@/navigation/navmeshEditor';

export interface NavMeshEditorThreeHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly domElement: HTMLElement;
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
}

const PINK = 0xff4dc0;
const MAX_MARKERS = 128;

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

export class NavMeshEditorThree {
  private readonly _session = new NavMeshEditorSession();
  private _brush: THREE.Mesh | null = null;
  private _points: THREE.Group | null = null;
  private _gizmo: TransformControls | null = null;
  private _gizmoAnchor: THREE.Object3D | null = null;
  private _lastGizmo = new THREE.Vector3();
  private _gizmoDragging = false;
  private _raycaster = new THREE.Raycaster();
  private _ndc = new THREE.Vector2();
  private _unsubBuffers: (() => void) | null = null;
  private _unsubRebake: (() => void) | null = null;
  private readonly _onPointerMove = (e: PointerEvent): void => this.handleMove(e);
  private readonly _onPointerDown = (e: PointerEvent): void => this.handleDown(e);
  private readonly _onPointerUp = (e: PointerEvent): void => this.handleUp(e);
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

  public constructor(private readonly _host: NavMeshEditorThreeHost) {}

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
      this._host.domElement.addEventListener('pointermove', this._onPointerMove);
      this._host.domElement.addEventListener('pointerdown', this._onPointerDown);
      this._host.domElement.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('keydown', this._onKeyDown);
      this.ensureBrush();
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
      this._unsubRebake = this._session.onRebake(async (r) => {
        await this._host.applyEditedNavMeshRebake(r);
      });
    } else {
      this._host.domElement.removeEventListener('pointermove', this._onPointerMove);
      this._host.domElement.removeEventListener('pointerdown', this._onPointerDown);
      this._host.domElement.removeEventListener('pointerup', this._onPointerUp);
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
  }

  private rayFromEvent(e: PointerEvent): {
    origin: NavMeshEditorVec3;
    dir: NavMeshEditorVec3;
  } {
    const rect = this._host.domElement.getBoundingClientRect();
    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._host.camera);
    const o = this._raycaster.ray.origin;
    const d = this._raycaster.ray.direction;
    return {
      origin: { x: o.x, y: o.y, z: o.z },
      dir: { x: d.x, y: d.y, z: d.z },
    };
  }

  private handleMove(e: PointerEvent): void {
    if (!this._session.enabled || this._gizmoDragging) {
      return;
    }
    const { origin, dir } = this.rayFromEvent(e);
    this._session.pointerMoveRay(origin, dir, e.clientX, e.clientY);
    this.syncVisuals();
  }

  private handleDown(_e: PointerEvent): void {
    // Click handling is on pointerup (no drag-resize).
  }

  private handleUp(e: PointerEvent): void {
    if (!this._session.enabled || this._gizmoDragging) {
      return;
    }
    const { origin, dir } = this.rayFromEvent(e);
    this._session.pointerUp(origin, dir, e.clientX, e.clientY, {
      shiftKey: e.shiftKey,
    });
    this.syncVisuals();
  }

  private ensureBrush(): void {
    if (this._brush) {
      return;
    }
    const geo = new THREE.CircleGeometry(1, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x33b3ff,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._brush = new THREE.Mesh(geo, mat);
    this._brush.renderOrder = 2;
    this._host.scene.add(this._brush);
  }

  private syncVisuals(): void {
    const brush = this._session.brush;
    if (this._brush) {
      const show = this._session.enabled && this._session.mode === 'circle';
      this._brush.visible = show;
      if (show) {
        this._brush.position.set(brush.center.x, brush.center.y, brush.center.z);
        this._brush.scale.setScalar(Math.max(brush.radius, 0.05));
        const n = new THREE.Vector3(brush.normal.x, brush.normal.y, brush.normal.z);
        this._brush.lookAt(this._brush.position.clone().add(n));
        const mat = this._brush.material as THREE.MeshBasicMaterial;
        mat.color.setHex(brush.holeDetected ? PINK : 0x33b3ff);
        mat.opacity = brush.holeDetected ? 0.45 : 0.35;
      }
    }
    this.syncPoints();
    this.syncGizmo();
  }

  private syncPoints(): void {
    if (this._points) {
      this._host.scene.remove(this._points);
      this._points.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
        }
      });
      this._points = null;
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
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: PINK });
    const lim = Math.min(selected.length, MAX_MARKERS);
    for (let i = 0; i < lim; i++) {
      const vi = selected[i]!;
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), mat);
      s.position.set(
        positions[vi * 3]!,
        positions[vi * 3 + 1]!,
        positions[vi * 3 + 2]!
      );
      group.add(s);
    }
    this._host.scene.add(group);
    this._points = group;
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
      this._gizmoAnchor = new THREE.Object3D();
      this._host.scene.add(this._gizmoAnchor);
    }
    if (!this._gizmoDragging) {
      this._gizmoAnchor.position.set(anchor!.x, anchor!.y, anchor!.z);
      this._lastGizmo.copy(this._gizmoAnchor.position);
    }
    if (!this._gizmo) {
      this._gizmo = new TransformControls(this._host.camera, this._host.domElement);
      this._gizmo.setMode('translate');
      this._gizmo.attach(this._gizmoAnchor);
      this._host.scene.add(this._gizmo.getHelper());
      this._gizmo.addEventListener('dragging-changed', (event) => {
        this._gizmoDragging = Boolean((event as { value?: boolean }).value);
        if (!this._gizmoDragging) {
          this.syncVisuals();
        }
      });
      this._gizmo.addEventListener('objectChange', () => {
        if (!this._gizmoAnchor) {
          return;
        }
        const cur = this._gizmoAnchor.position;
        const dx = cur.x - this._lastGizmo.x;
        const dy = cur.y - this._lastGizmo.y;
        const dz = cur.z - this._lastGizmo.z;
        this._lastGizmo.copy(cur);
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-9) {
          return;
        }
        this._session.applyGizmoDelta({ x: dx, y: dy, z: dz });
        this.syncPoints();
      });
    } else {
      this._gizmo.attach(this._gizmoAnchor);
    }
  }

  private clearGizmo(): void {
    this._gizmoDragging = false;
    if (this._gizmo) {
      this._gizmo.detach();
      this._host.scene.remove(this._gizmo.getHelper());
      this._gizmo.dispose();
      this._gizmo = null;
    }
    if (this._gizmoAnchor) {
      this._host.scene.remove(this._gizmoAnchor);
      this._gizmoAnchor = null;
    }
  }

  private clearVisuals(): void {
    this.clearGizmo();
    if (this._brush) {
      this._host.scene.remove(this._brush);
      this._brush.geometry.dispose();
      (this._brush.material as THREE.Material).dispose();
      this._brush = null;
    }
    if (this._points) {
      this._host.scene.remove(this._points);
      this._points = null;
    }
  }
}
