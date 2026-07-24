import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  init as initRecast,
  importNavMesh,
  Crowd,
  NavMeshQuery,
  type CrowdAgent,
} from 'recast-navigation';

import type { NavKitControlsMode } from '@/navigation/navKitContract';
import { resolveNavKitCameraLook } from '@/navigation/navKitPoseInfo';
import {
  controlsModeAllowsClick,
  controlsModeAllowsWasd,
  integratePlayerWasdMove,
  isPlayerWasdSampleActive,
  PLAYER_WASD_LOOKAHEAD_METERS,
  PlayerWasdKeyTracker,
  type PlayerWasdSample,
} from '@/navigation/playerWasdControls';
import {
  travelFacingYawFromAgent,
  yawTowardPoint,
} from '@/navigation/playerTravelFacing';
import {
  PLAYER_MARKER_HALF_HEIGHT_M,
  playerMarkerWedgeBuffers,
} from '@/navigation/playerMarkerGeometry';
import type {
  NavMeshEditorRebakeResult,
  NavMeshEditorStatus,
} from '@/navigation/navmeshEditor';
import {
  ensureRegionSelectionVolume,
  MIN_REGION_HEIGHT_METERS,
  regionSelectionSize,
} from '@/navigation/regionSelection';
import { NavMeshEditorThree } from '@/react/three/navMeshEditorThree';

/** Minimal OrbitControls surface used by the controller (drei's controls). */
export interface OrbitControlsLike {
  target: THREE.Vector3;
  object: THREE.Camera;
  enabled?: boolean;
  panSpeed?: number;
  zoomSpeed?: number;
  update(): void;
}

/** Three.js context handed to the controller by the R3F canvas. */
export interface SceneHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  gl: THREE.WebGLRenderer;
  controls: OrbitControlsLike | null;
}

const AGENT_PARAMS = {
  player: { radius: 0.5, height: 2.0, maxAcceleration: 20.0, maxSpeed: 5.0 },
  npc: { radius: 0.5, height: 2.0, maxAcceleration: 10.0, maxSpeed: 3.0 },
} as const;

const NAVMESH_OVERLAY_OPACITY = 0.45;

/**
 * Engine-side controller for the R3F FAST NAV demo. It owns the Gaussian splat
 * renderer, the floor/navmesh overlays, and the `recast-navigation` crowd
 * (player + NPC) with click-to-move - the three.js equivalent of the crowd
 * parts of the Babylon `Viewer` (`src/scene/Viewer.ts`).
 *
 * Coordinate contract: the WASM floor/navmesh are built with `flip_y: true`, so
 * they live in SplatWalk-oriented space (+Y up). Raw PLY splats are Y-down, so
 * the splat is mirrored on Y (`splatGroup.scale.y = -1`) to land in the exact
 * same +Y-up space as the floor - no per-output Y offsets (see docs/INTEGRATION.md
 * section 4).
 */
export class SplatNavController {
  private handles: SceneHandles | null = null;

  /**
   * Root container with `scale.z = -1`. three.js is right-handed while Babylon
   * (the reference demo) is left-handed; rendering in a Z-mirrored world makes
   * the scene match Babylon's chirality. Combined with the splat's own
   * `scale.y = -1`, the net splat transform is a proper 180-degree rotation about
   * X (determinant +1) - so the splat is NOT mirrored and text/signs read the
   * right way round, exactly like the Babylon viewer.
   */
  private world: THREE.Group | null = null;

  private splatGroup: THREE.Group | null = null;
  private splatViewer: GaussianSplats3D.DropInViewer | null = null;

  private collisionBoundaryMesh: THREE.Mesh | null = null;
  private floorMesh: THREE.Mesh | null = null;
  private navMeshOverlay: THREE.Mesh | null = null;
  private readonly _editedNavMeshRebakeListeners = new Set<
    (result: NavMeshEditorRebakeResult) => void | Promise<void>
  >();
  private _orientedNavPositions: Float32Array | null = null;
  private _orientedNavIndices: Uint32Array | null = null;
  private _navMeshData: Uint8Array | null = null;
  private _navMeshEditor: NavMeshEditorThree | null = null;
  /** Status listeners registered before the Three scene is attached. */
  private readonly _navMeshEditorStatusListeners = new Set<
    (status: NavMeshEditorStatus) => void
  >();
  private _navMeshEditorStatusFanoutUnsub: (() => void) | null = null;
  private selectionMesh: THREE.Mesh | null = null;
  /** Move gizmo — always on with {@link scaleControls} (Babylon GizmoManager parity). */
  private translateControls: TransformControls | null = null;
  /** Scale gizmo — always on with {@link translateControls}. */
  private scaleControls: TransformControls | null = null;

  private navMeshQuery: NavMeshQuery | null = null;
  private crowd: Crowd | null = null;
  private playerAgent: CrowdAgent | null = null;
  private playerMesh: THREE.Mesh | null = null;
  private playerLabel: THREE.Sprite | null = null;
  private readonly npcAgents: CrowdAgent[] = [];
  private readonly npcMeshes: THREE.Mesh[] = [];
  private readonly npcLabels: THREE.Sprite[] = [];
  private readonly labelTmp = new THREE.Vector3();

  /** Splat extent in render/oriented space, used to frame the top-down view. */
  private sceneBounds: { min: number[]; max: number[] } | null = null;

  private raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number } | null = null;
  /** Visual toggle only — overlay stays raycastable for click-to-move when hidden. */
  private navMeshOverlayShown = true;
  /** Absolute uniform environment scale (default 1). Does not scale player/NPC markers. */
  private _environmentScale = 1;
  private _controlsMode: NavKitControlsMode = 'both';
  private readonly _wasdKeys = new PlayerWasdKeyTracker();
  private _playerYawRadians = 0;
  /**
   * After teleport / NavKit restore, skip path/velocity travel-facing until
   * the user clicks or uses WASD so saved yaw is not overwritten.
   */
  private _suppressTravelFacingUntilInput = false;
  /** Swift click-face goal; pathing waits until this arrives. */
  private _pendingClickFaceYaw: number | null = null;
  /** Move target held until click-face completes (nav/local space). */
  private _pendingClickMoveTarget: [number, number, number] | null = null;
  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };
  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointerDown) return;
    const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
    this.pointerDown = null;
    if (moved > 6) return; // a drag/orbit, not a tap
    this.handleTap(e);
  };
  private onTranslateDraggingChanged = (event: { value: boolean }): void => {
    if (this.scaleControls) {
      this.scaleControls.enabled = !event.value;
    }
    if (this.handles?.controls && this.handles.controls.enabled !== undefined) {
      this.handles.controls.enabled = !event.value;
    }
  };

  private onScaleDraggingChanged = (event: { value: boolean }): void => {
    if (this.translateControls) {
      this.translateControls.enabled = !event.value;
    }
    if (this.handles?.controls && this.handles.controls.enabled !== undefined) {
      this.handles.controls.enabled = !event.value;
    }
  };

  private createRegionGizmo(mode: 'translate' | 'scale'): TransformControls {
    if (!this.handles) {
      throw new Error('Controller not attached to a scene.');
    }
    const controls = new TransformControls(this.handles.camera, this.handles.gl.domElement);
    controls.setMode(mode);
    const onDragging =
      mode === 'translate' ? this.onTranslateDraggingChanged : this.onScaleDraggingChanged;
    controls.addEventListener(
      'dragging-changed',
      onDragging as unknown as (event: THREE.Event) => void
    );
    this.handles.scene.add(controls.getHelper());
    return controls;
  }

  private disposeRegionGizmo(
    controls: TransformControls | null,
    mode: 'translate' | 'scale'
  ): void {
    if (!controls) {
      return;
    }
    const onDragging =
      mode === 'translate' ? this.onTranslateDraggingChanged : this.onScaleDraggingChanged;
    try {
      controls.removeEventListener(
        'dragging-changed',
        onDragging as unknown as (event: THREE.Event) => void
      );
    } catch {
      // Already detached / disposed.
    }
    try {
      controls.detach();
    } catch {
      // Object already cleared.
    }
    const helper = controls.getHelper();
    this.handles?.scene.remove(helper);
    helper.traverse((child) => {
      const mesh = child as THREE.Mesh | THREE.Line;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const entry of material) {
          entry.dispose();
        }
      } else if (material) {
        material.dispose();
      }
    });
    // three@0.169 TransformControls.dispose() calls this.traverse, but the class
    // extends Controls (not Object3D) — that throws and used to leave the React
    // selection-region toggle stuck on. Disconnect manually instead.
    try {
      controls.disconnect();
    } catch {
      // Dom listeners already removed.
    }
  }

  /** Wire the controller to the live three.js context from the R3F canvas. */
  public attach(handles: SceneHandles): void {
    this.handles = handles;
    if (!this.world) {
      this.world = new THREE.Group();
      this.world.scale.z = -1; // emulate Babylon's left-handed chirality
    }
    handles.scene.add(this.world);
    handles.gl.domElement.addEventListener('pointerdown', this.onPointerDown);
    handles.gl.domElement.addEventListener('pointerup', this.onPointerUp);
  }

  /** Update the (drei) controls reference without re-attaching the scene. */
  public setControls(controls: OrbitControlsLike | null): void {
    if (this.handles) this.handles.controls = controls;
  }

  /** Splat bounds (oriented/render space) used to clamp the top-down framing. */
  public setSceneBounds(min: number[], max: number[]): void {
    this.sceneBounds = { min: [...min], max: [...max] };
  }

  /** Last known oriented splat AABB, or null before bounds are captured. */
  /** Active camera world position (for camera-select AABB), or null if unattached. */
  public getCameraPosition(): { x: number; y: number; z: number } | null {
    if (!this.handles) {
      return null;
    }
    const p = this.handles.camera.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  /**
   * Camera pose in splatwalk-oriented / world-local space (undoes `world.scale.z = -1`).
   * Yaw follows look direction on local XZ: yaw 0 looks +Z (`atan2(fx, fz)`).
   * Pitch is oriented Y-up (`-asin(fy)`).
   */
  public getCameraPoseOriented(): {
    position: { x: number; y: number; z: number };
    pitchRadians: number;
    yawRadians: number;
  } | null {
    if (!this.handles || !this.world) {
      return null;
    }
    this.world.updateWorldMatrix(true, false);
    const worldPos = this.handles.camera.getWorldPosition(new THREE.Vector3());
    const localPos = this.world.worldToLocal(worldPos.clone());
    const worldDir = this.handles.camera.getWorldDirection(new THREE.Vector3());
    const invWorld = new THREE.Matrix4().copy(this.world.matrixWorld).invert();
    const localDir = worldDir.clone().transformDirection(invWorld).normalize();
    const yawRadians = Math.atan2(localDir.x, localDir.z);
    const pitchRadians = -Math.asin(Math.max(-1, Math.min(1, localDir.y)));
    return {
      position: { x: localPos.x, y: localPos.y, z: localPos.z },
      pitchRadians,
      yawRadians,
    };
  }

  public getSceneBounds(): { min: number[]; max: number[] } | null {
    return this.sceneBounds
      ? { min: [...this.sceneBounds.min], max: [...this.sceneBounds.max] }
      : null;
  }

  /**
   * Synchronously detach from the scene (R3F canvas unmount). Resource teardown
   * runs immediately so a later effect re-run cannot null a fresh attachment -
   * splat `dispose()` is fired-and-forgotten against a captured scene ref.
   */
  public detach(): void {
    const handles = this.handles;
    if (handles) {
      handles.gl.domElement.removeEventListener('pointerdown', this.onPointerDown);
      handles.gl.domElement.removeEventListener('pointerup', this.onPointerUp);
    }
    this._navMeshEditorStatusFanoutUnsub?.();
    this._navMeshEditorStatusFanoutUnsub = null;
    this._navMeshEditor?.dispose();
    this._navMeshEditor = null;
    this.disableRegionSelection();
    this.destroyCrowd();
    const world = this.world;
    if (world) {
      if (this.floorMesh) {
        world.remove(this.floorMesh);
        this.disposeMesh(this.floorMesh);
        this.floorMesh = null;
      }
      if (this.collisionBoundaryMesh) {
        world.remove(this.collisionBoundaryMesh);
        this.disposeMesh(this.collisionBoundaryMesh);
        this.collisionBoundaryMesh = null;
      }
      if (this.navMeshOverlay) {
        world.remove(this.navMeshOverlay);
        this.disposeMesh(this.navMeshOverlay);
        this.navMeshOverlay = null;
      }
      const group = this.splatGroup;
      const viewer = this.splatViewer;
      this.splatGroup = null;
      this.splatViewer = null;
      if (viewer) void viewer.dispose();
      if (group) world.remove(group);
    }
    if (handles && this.world) handles.scene.remove(this.world);
    this.handles = null;
  }

  /** Per-frame tick driven by R3F's `useFrame`. */
  public update(dt: number): void {
    if (this.crowd) {
      const step = Math.min(dt, 0.1);
      const wasdSample = this._wasdKeys.sample();
      const wasdActive = isPlayerWasdSampleActive(wasdSample);
      this.tickPlayerWasd(step, wasdSample);
      this.crowd.update(step);
      if (this.playerAgent && this.playerMesh) {
        if (wasdActive) {
          this._pendingClickFaceYaw = null;
          this._pendingClickMoveTarget = null;
          this._suppressTravelFacingUntilInput = false;
        } else if (
          !this._suppressTravelFacingUntilInput &&
          controlsModeAllowsClick(this._controlsMode)
        ) {
          const velocity = this.playerAgent.velocity();
          const position = this.playerAgent.position();
          let nextTarget: { x: number; y: number; z: number } | null = null;
          try {
            nextTarget = this.playerAgent.nextTargetInPath();
          } catch {
            nextTarget = null;
          }
          const facing = travelFacingYawFromAgent({
            velocity,
            position,
            nextTarget,
            currentYaw: this._playerYawRadians,
            dt: step,
            clickFaceYaw: this._pendingClickFaceYaw,
          });
          this._playerYawRadians = facing.yawRadians;
          if (facing.clearClickFace) {
            this._pendingClickFaceYaw = null;
            const pending = this._pendingClickMoveTarget;
            this._pendingClickMoveTarget = null;
            if (pending) {
              this.playerAgent.requestMoveTarget({
                x: pending[0],
                y: pending[1],
                z: pending[2],
              });
            }
          }
        }
        this.syncMesh(this.playerMesh, this.playerAgent);
        this.syncPlayerMeshYaw();
        if (this.playerLabel) this.updateLabel(this.playerLabel, this.playerMesh);
      }
      for (let i = 0; i < this.npcAgents.length; i++) {
        const mesh = this.npcMeshes[i];
        const agent = this.npcAgents[i];
        if (mesh && agent) this.syncMesh(mesh, agent);
        const label = this.npcLabels[i];
        if (label && mesh) this.updateLabel(label, mesh);
      }
    }
  }

  public getControlsMode(): NavKitControlsMode {
    return this._controlsMode;
  }

  public setControlsMode(mode: NavKitControlsMode): void {
    this._controlsMode = mode;
    if (controlsModeAllowsWasd(mode)) {
      this._wasdKeys.attach();
    } else {
      this._wasdKeys.detach();
    }
  }

  public getPlayerPoseNavKit(): {
    position: { x: number; y: number; z: number };
    eulerDegrees: { x: number; y: number; z: number };
  } | null {
    if (!this.playerAgent) {
      return null;
    }
    const p = this.playerAgent.position();
    return {
      position: { x: p.x, y: p.y, z: p.z },
      eulerDegrees: {
        x: 0,
        y: (this._playerYawRadians * 180) / Math.PI,
        z: 0,
      },
    };
  }

  public getCameraPoseNavKit(): {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    eulerDegrees: { x: number; y: number; z: number };
  } | null {
    const pose = this.getCameraPoseOriented();
    if (!pose || !this.handles || !this.world) {
      return null;
    }
    const radToDeg = 180 / Math.PI;
    const eulerDegrees = {
      x: pose.pitchRadians * radToDeg,
      y: pose.yawRadians * radToDeg,
      z: 0,
    };
    let target = resolveNavKitCameraLook({
      eulerDegrees,
      position: pose.position,
    }).target;
    if (this.handles.controls) {
      this.world.updateWorldMatrix(true, false);
      const localTarget = this.world.worldToLocal(this.handles.controls.target.clone());
      target = { x: localTarget.x, y: localTarget.y, z: localTarget.z };
    }
    return {
      position: pose.position,
      target,
      eulerDegrees,
    };
  }

  public teleportPlayerTo(options: {
    readonly position: [number, number, number] | { x: number; y: number; z: number };
    readonly yawDegrees?: number;
  }): void {
    if (!this.playerAgent) {
      return;
    }
    const raw = Array.isArray(options.position)
      ? options.position
      : [options.position.x, options.position.y, options.position.z];
    const snapped = this.snapToNavMesh([raw[0]!, raw[1]!, raw[2]!]) ?? raw;
    this.playerAgent.teleport({ x: snapped[0]!, y: snapped[1]!, z: snapped[2]! });
    // Clear residual pathing so travel-facing does not overwrite NavKit yaw.
    this.playerAgent.resetMoveTarget();
    this._pendingClickFaceYaw = null;
    this._pendingClickMoveTarget = null;
    this._playerYawRadians = ((options.yawDegrees ?? 0) * Math.PI) / 180;
    this._suppressTravelFacingUntilInput = true;
    if (this.playerMesh) {
      this.syncMesh(this.playerMesh, this.playerAgent);
      this.syncPlayerMeshYaw();
    }
  }

  /** Absolute uniform environment scale applied to the splat group. */
  public getEnvironmentScale(): number {
    return this._environmentScale;
  }

  /**
   * Set absolute uniform environment scale on the splat group (preserving Y-flip).
   * Floor / collision / navmesh overlays are rebuilt from WASM with matching
   * `environment_scale` and are not transform-scaled here.
   */
  public setEnvironmentScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) {
      console.warn(`[WARN] Ignoring invalid environment scale: ${scale}`);
      return;
    }
    this._environmentScale = scale;
    if (this.splatGroup) {
      this.splatGroup.scale.set(scale, -scale, scale);
    }
    console.log(`[INFO] Environment scale set to ${scale}.`);
  }

  /** Render a splat from raw bytes (PLY). Replaces any previously loaded splat. */
  public async loadSplat(bytes: Uint8Array): Promise<void> {
    if (!this.handles || !this.world) {
      throw new Error('Controller not attached to a scene.');
    }
    // Never await prior dispose() — DropInViewer can hang on in-flight sort/download
    // promises and block NavKit restore forever. Fire-and-forget like detach().
    void this.disposeSplat();

    const group = new THREE.Group();
    // Y-flip the raw splat (matches Babylon's loader). Under the Z-mirrored
    // `world`, the net transform is a proper rotation, so the splat is upright
    // AND un-mirrored (chirality matches Babylon).
    const s = this._environmentScale;
    group.scale.set(s, -s, s);
    this.world.add(group);
    this.splatGroup = group;

    const viewer = new GaussianSplats3D.DropInViewer({
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false,
    });
    group.add(viewer);
    this.splatViewer = viewer;

    // Tight copy — avoid ArrayBuffer views that may be larger than the PLY payload.
    const plyCopy = bytes.slice();
    const blob = new Blob([plyCopy], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const LOAD_SPLAT_TIMEOUT_MS = 45_000;
    try {
      console.log(
        `[WAIT] DropInViewer.addSplatScene (${(plyCopy.byteLength / (1024 * 1024)).toFixed(2)} MB)…`
      );
      await Promise.race([
        viewer.addSplatScene(url, {
          format: GaussianSplats3D.SceneFormat.Ply,
          showLoadingUI: false,
          progressiveLoad: false,
        }),
        new Promise<never>((_resolve, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                `Splat load timed out after ${LOAD_SPLAT_TIMEOUT_MS / 1000}s ` +
                  `(DropInViewer.addSplatScene). Try WebGL or reload.`
              )
            );
          }, LOAD_SPLAT_TIMEOUT_MS);
        }),
      ]);
      console.log('[INFO] Splat scene added to DropInViewer.');
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
    }
  }

  /** Show the extracted walkable floor mesh (faint, for context). */
  public showFloor(positions: Float32Array, indices: Uint32Array): void {
    if (!this.world) return;
    if (this.floorMesh) {
      this.world.remove(this.floorMesh);
      this.disposeMesh(this.floorMesh);
    }
    const geometry = this.buildGeometry(positions, indices);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.floorMesh = new THREE.Mesh(geometry, material);
    this.world.add(this.floorMesh);
  }

  /** Show the collision voxel boundary overlay (cyan), independent of the navmesh. */
  public showCollisionBoundary(positions: Float32Array, indices: Uint32Array): void {
    if (!this.world) return;
    if (this.collisionBoundaryMesh) {
      this.world.remove(this.collisionBoundaryMesh);
      this.disposeMesh(this.collisionBoundaryMesh);
    }
    const geometry = this.buildGeometry(positions, indices);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00d9ff,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.collisionBoundaryMesh = new THREE.Mesh(geometry, material);
    this.collisionBoundaryMesh.renderOrder = 1;
    this.world.add(this.collisionBoundaryMesh);
  }

  /** Remove the cyan collision / MC shell overlay. */
  public clearCollisionBoundary(): void {
    if (!this.world || !this.collisionBoundaryMesh) {
      return;
    }
    this.world.remove(this.collisionBoundaryMesh);
    this.disposeMesh(this.collisionBoundaryMesh);
    this.collisionBoundaryMesh = null;
  }

  /** Toggle the collision voxel boundary overlay. */
  public setCollisionBoundaryVisible(visible: boolean): void {
    if (this.collisionBoundaryMesh) {
      this.collisionBoundaryMesh.visible = visible;
    }
  }

  /**
   * Clear nav overlays + yellow region (call on every new splat load).
   * Pass `{ keepRegion: true }` on Fast Nav recompute so a user-moved pin survives.
   */
  public clearNavSessionOverlays(options?: { readonly keepRegion?: boolean }): void {
    this.clearCollisionBoundary();
    if (!options?.keepRegion) {
      this.disableRegionSelection();
    }
    this.clearFloorMesh();
    if (this.world && this.navMeshOverlay) {
      this.world.remove(this.navMeshOverlay);
      this.disposeMesh(this.navMeshOverlay);
      this.navMeshOverlay = null;
    }
    this.destroyCrowd();
  }

  /** Toggle the green walkable navmesh overlay (click-to-move still works when hidden). */
  public setNavMeshVisible(visible: boolean): void {
    this.navMeshOverlayShown = visible;
    this.applyNavMeshOverlayVisibility();
    if (!visible) {
      this.clearFloorMesh();
    }
  }

  /**
   * Show a yellow selection-region box (WASM AABB pin). Move and scale gizmos
   * are both active (same as Babylon GizmoManager). Thin floor-band suggestions
   * are expanded to a minimum height so the box is a volume, not a plane.
   */
  public enableRegionSelection(region?: { min: number[]; max: number[] }): void {
    if (!this.handles || !this.world) {
      throw new Error('Controller not attached to a scene.');
    }

    if (!this.selectionMesh) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.selectionMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      this.selectionMesh.renderOrder = 3;
      this.world.add(this.selectionMesh);
    }

    const rawBounds = region
      ? { min: region.min, max: region.max }
      : this.sceneBounds;

    if (rawBounds) {
      const volume = ensureRegionSelectionVolume(rawBounds);
      const size = regionSelectionSize(volume);
      this.selectionMesh.scale.set(size.x, size.y, size.z);
      this.selectionMesh.position.set(
        (volume.min[0] + volume.max[0]) * 0.5,
        (volume.min[1] + volume.max[1]) * 0.5,
        (volume.min[2] + volume.max[2]) * 0.5
      );
    } else {
      this.selectionMesh.scale.set(5, MIN_REGION_HEIGHT_METERS, 5);
      const target = this.handles.controls?.target ?? new THREE.Vector3();
      this.selectionMesh.position.copy(target);
    }

    if (!this.translateControls) {
      this.translateControls = this.createRegionGizmo('translate');
    }
    if (!this.scaleControls) {
      this.scaleControls = this.createRegionGizmo('scale');
    }
    this.translateControls.attach(this.selectionMesh);
    this.scaleControls.attach(this.selectionMesh);
    console.log('[INFO] Region selection enabled (move + scale gizmos).');
  }

  /** Hide and dispose the selection-region box / gizmos. */
  public disableRegionSelection(): void {
    const hadRegion = Boolean(this.translateControls || this.scaleControls || this.selectionMesh);
    this.disposeRegionGizmo(this.translateControls, 'translate');
    this.translateControls = null;
    this.disposeRegionGizmo(this.scaleControls, 'scale');
    this.scaleControls = null;
    if (this.handles?.controls && this.handles.controls.enabled !== undefined) {
      this.handles.controls.enabled = true;
    }
    if (this.selectionMesh && this.world) {
      this.world.remove(this.selectionMesh);
      this.disposeMesh(this.selectionMesh);
      this.selectionMesh = null;
    }
    if (hadRegion) {
      console.log('[INFO] Region selection disabled');
    }
  }

  /** Current selection-region AABB in oriented / world-local space, or null. */
  public getRegionBounds(): { min: number[]; max: number[] } | null {
    if (!this.selectionMesh) {
      return null;
    }
    const { position, scale } = this.selectionMesh;
    const halfX = Math.abs(scale.x) * 0.5;
    const halfY = Math.abs(scale.y) * 0.5;
    const halfZ = Math.abs(scale.z) * 0.5;
    return {
      min: [position.x - halfX, position.y - halfY, position.z - halfZ],
      max: [position.x + halfX, position.y + halfY, position.z + halfZ],
    };
  }

  public getNavMeshData(): Uint8Array | null {
    return this._navMeshData;
  }

  public getOrientedNavMeshBuffers(): {
    positions: Float32Array;
    indices: Uint32Array;
  } | null {
    if (!this._orientedNavPositions || !this._orientedNavIndices) {
      return null;
    }
    return {
      positions: this._orientedNavPositions,
      indices: this._orientedNavIndices,
    };
  }

  public isNavMeshEditorEnabled(): boolean {
    return this._navMeshEditor?.session.enabled === true;
  }

  public getNavMeshEditorStatus(): NavMeshEditorStatus | null {
    return this._navMeshEditor?.session.status() ?? null;
  }

  public onNavMeshEditorStatus(
    listener: (status: NavMeshEditorStatus) => void
  ): () => void {
    this._navMeshEditorStatusListeners.add(listener);
    // Safe before Canvas attach — editor is created lazily on first enable/ensure.
    if (this._navMeshEditor && !this._navMeshEditorStatusFanoutUnsub) {
      this.wireNavMeshEditorStatusFanout();
    }
    return () => {
      this._navMeshEditorStatusListeners.delete(listener);
    };
  }

  /**
   * Fired after an editor rebake updates Detour + overlay buffers.
   * Hosts should refresh session navMeshData / NavKit artifact bundles here.
   */
  public onEditedNavMeshRebake(
    listener: (result: NavMeshEditorRebakeResult) => void | Promise<void>
  ): () => void {
    this._editedNavMeshRebakeListeners.add(listener);
    return () => {
      this._editedNavMeshRebakeListeners.delete(listener);
    };
  }

  public async applyNavMeshEditorToLive(): Promise<boolean> {
    this.ensureNavMeshEditor();
    return this._navMeshEditor!.session.applyToLiveNavMesh();
  }

  public setNavMeshEditorEnabled(enabled: boolean): void {
    this.ensureNavMeshEditor();
    this._navMeshEditor!.setEnabled(enabled);
    if (enabled) {
      this._pendingClickFaceYaw = null;
      this._pendingClickMoveTarget = null;
      this.playerAgent?.resetMoveTarget();
    }
  }

  public setNavMeshEditorMode(mode: 'vertex' | 'circle' | 'global'): void {
    this.ensureNavMeshEditor();
    this._navMeshEditor!.session.setMode(mode);
  }

  public navMeshEditorGlobalY(steps: number): void {
    this.ensureNavMeshEditor();
    this._navMeshEditor!.session.globalY(steps);
  }

  public navMeshEditorFillHole(): boolean {
    this.ensureNavMeshEditor();
    return this._navMeshEditor!.session.fillHolesUnderBrush() > 0;
  }

  public async navMeshEditorDeleteVertices(): Promise<boolean> {
    this.ensureNavMeshEditor();
    return this._navMeshEditor!.session.deleteSelectedVerticesAndApply();
  }

  private wireNavMeshEditorStatusFanout(): void {
    if (!this._navMeshEditor || this._navMeshEditorStatusFanoutUnsub) {
      return;
    }
    this._navMeshEditorStatusFanoutUnsub = this._navMeshEditor.onStatus((status) => {
      for (const listener of this._navMeshEditorStatusListeners) {
        listener(status);
      }
    });
  }

  private ensureNavMeshEditor(): void {
    if (this._navMeshEditor) {
      return;
    }
    if (!this.handles) {
      throw new Error('NavMesh editor requires an attached Three.js scene.');
    }
    this._navMeshEditor = new NavMeshEditorThree({
      scene: this.handles.scene,
      camera: this.handles.camera,
      domElement: this.handles.gl.domElement,
      getOrientedNavMeshBuffers: () => this.getOrientedNavMeshBuffers(),
      refreshNavMeshOverlayFromOriented: (positions, indices, options) => {
        this.refreshNavMeshOverlayFromOriented(positions, indices, options);
      },
      applyEditedNavMeshRebake: async (result) => {
        await this.applyEditedNavMeshRebake(result);
      },
    });
    this.wireNavMeshEditorStatusFanout();
  }

  public async applyEditedNavMeshRebake(
    result: NavMeshEditorRebakeResult
  ): Promise<void> {
    const pose = this.playerAgent
      ? {
          position: this.playerAgent.position(),
          yawDegrees: (this._playerYawRadians * 180) / Math.PI,
        }
      : null;
    this._navMeshData = new Uint8Array(result.navMeshData);
    this.showNavMesh(result.debugPositions, result.debugIndices);
    const spawn: [number, number, number] | null = pose
      ? [pose.position.x, pose.position.y, pose.position.z]
      : null;
    await this.initCrowd(result.navMeshData, spawn);
    if (pose) {
      this.teleportPlayerTo({
        position: [pose.position.x, pose.position.y, pose.position.z],
        yawDegrees: pose.yawDegrees,
      });
    }
    // Session buffers already updated by applyToLiveNavMesh / runRebake.
    for (const listener of this._editedNavMeshRebakeListeners) {
      try {
        await listener(result);
      } catch (err) {
        console.warn('[WARN] onEditedNavMeshRebake listener failed:', err);
      }
    }
  }

  /**
   * Update green overlay from oriented editor buffers.
   * Positions-only edits reuse the existing mesh; topology changes rebuild.
   */
  public refreshNavMeshOverlayFromOriented(
    positions: Float32Array,
    indices: Uint32Array,
    options?: { readonly topologyChanged?: boolean }
  ): void {
    const topologyChanged = options?.topologyChanged !== false;
    if (
      !topologyChanged &&
      this.navMeshOverlay &&
      this._orientedNavPositions &&
      this._orientedNavPositions.length === positions.length
    ) {
      this._orientedNavPositions = new Float32Array(positions);
      this._orientedNavIndices = new Uint32Array(indices);
      const attr = this.navMeshOverlay.geometry.getAttribute('position');
      if (attr && attr.count === Math.floor(positions.length / 3)) {
        const arr = attr.array as Float32Array;
        arr.set(positions);
        attr.needsUpdate = true;
        this.navMeshOverlay.geometry.computeBoundingSphere();
        return;
      }
    }
    this.showNavMesh(positions, indices);
  }

  /** Show the walkable navmesh overlay (green) and use it as the click target. */
  public showNavMesh(positions: Float32Array, indices: Uint32Array): void {
    if (!this.world) return;
    this._orientedNavPositions = new Float32Array(positions);
    this._orientedNavIndices = new Uint32Array(indices);
    this.clearFloorMesh();
    if (this.navMeshOverlay) {
      this.world.remove(this.navMeshOverlay);
      this.disposeMesh(this.navMeshOverlay);
    }
    const geometry = this.buildGeometry(positions, indices);
    const material = new THREE.MeshBasicMaterial({
      color: 0x39ff14,
      transparent: true,
      opacity: NAVMESH_OVERLAY_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.navMeshOverlay = new THREE.Mesh(geometry, material);
    this.navMeshOverlay.renderOrder = 2;
    // Keep visible=true always so raycasts still hit when the overlay is visually off.
    this.navMeshOverlay.visible = true;
    this.world.add(this.navMeshOverlay);
    this.applyNavMeshOverlayVisibility();
  }

  /** Initialize the recast crowd and spawn the (blue) player agent. */
  public async initCrowd(navMeshData: Uint8Array, spawn: [number, number, number] | null): Promise<void> {
    this._navMeshData = new Uint8Array(navMeshData);
    if (!this.handles) return;
    await initRecast();
    this.destroyCrowd();

    const { navMesh } = importNavMesh(navMeshData);
    this.navMeshQuery = new NavMeshQuery(navMesh);

    this.crowd = new Crowd(navMesh, { maxAgents: 100, maxAgentRadius: 1.0 });

    const start = this.snapToNavMesh(spawn) ?? spawn;
    if (!start) {
      console.warn('[WARN] No valid navmesh spawn point for the player.');
      return;
    }

    this.playerAgent = this.crowd.addAgent(
      { x: start[0], y: start[1], z: start[2] },
      AGENT_PARAMS.player
    );

    const playerMesh = new THREE.Mesh(
      SplatNavController.createPlayerMarkerGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x1144ff, emissive: 0x0a1c4d })
    );
    // Lift so the centered wedge rests ON the navmesh (feet at agent Y).
    playerMesh.userData.yOffset = PLAYER_MARKER_HALF_HEIGHT_M;
    this.playerMesh = playerMesh;
    this.world?.add(playerMesh);
    this.syncMesh(playerMesh, this.playerAgent);
    this.syncPlayerMeshYaw();
    this.setControlsMode(this._controlsMode);

    // PLAYER billboard label, matching the Babylon demos (blue "PLAYER" text).
    const label = SplatNavController.makeLabelSprite('PLAYER', '#1a80ff');
    this.handles.scene.add(label);
    this.playerLabel = label;
    this.updateLabel(label, playerMesh);
  }

  /** Spawn a single (green) NPC crowd agent near the given point or the player. */
  public addNPC(spawn: [number, number, number] | null): void {
    if (!this.handles || !this.crowd) return;
    const player = this.playerAgent?.position();
    const target =
      this.snapToNavMesh(spawn) ??
      (player ? [player.x + 1.0, player.y, player.z] : null);
    if (!target) return;
    if (player && Math.hypot(target[0] - player.x, target[2] - player.z) < 0.25) return;

    const agent = this.crowd.addAgent({ x: target[0], y: target[1], z: target[2] }, AGENT_PARAMS.npc);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0x33ff59, emissive: 0x064012 })
    );
    mesh.userData.yOffset = 0.3; // rest the sphere ON the navmesh
    this.world?.add(mesh);
    this.npcAgents.push(agent);
    this.npcMeshes.push(mesh);
    this.syncMesh(mesh, agent);

    // NPC billboard label, matching the Babylon demos (green "NPC" text).
    const label = SplatNavController.makeLabelSprite('NPC', '#33ff59');
    this.handles.scene.add(label);
    this.npcLabels.push(label);
    this.updateLabel(label, mesh);
  }

  /**
   * Apply oriented camera-select view (degrees) after Fast Nav when `cameraSelect`
   * is set — R3F OrbitControls approximate of Babylon {@link Viewer.applyCameraSelectView}.
   * Position/euler are oriented-local (same space as {@link getCameraPoseOriented}).
   */
  public applyCameraSelectView(view: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly eulerDegrees: { readonly x: number; readonly y: number; readonly z: number };
  }): void {
    this.applyCameraPoseNavKit(view);
  }

  /**
   * Apply NavKit camera pose (oriented-local position + target or euler °).
   * Converts through `world.localToWorld` so capture/apply match Z-mirror space.
   */
  public applyCameraPoseNavKit(view: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly eulerDegrees?: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly target?: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
  }): void {
    if (!this.handles || !this.world) {
      return;
    }
    this.world.updateWorldMatrix(true, false);
    const look = resolveNavKitCameraLook({
      eulerDegrees: view.eulerDegrees,
      position: view.position,
      target: view.target,
    });
    const localPos = new THREE.Vector3(look.position.x, look.position.y, look.position.z);
    const localTarget = new THREE.Vector3(look.target.x, look.target.y, look.target.z);
    const worldPos = this.world.localToWorld(localPos.clone());
    const worldTarget = this.world.localToWorld(localTarget.clone());
    this.handles.camera.position.copy(worldPos);
    this.handles.camera.up.set(0, 1, 0);
    this.handles.camera.near = 0.05;
    this.handles.camera.far = Math.max(
      1000,
      worldPos.distanceTo(worldTarget) * 20
    );
    this.handles.camera.updateProjectionMatrix();
    if (this.handles.controls) {
      if (this.handles.controls.enabled !== undefined) {
        this.handles.controls.enabled = true;
      }
      this.handles.controls.target.copy(worldTarget);
      this.handles.controls.update();
    } else {
      this.handles.camera.lookAt(worldTarget);
    }
  }

  /**
   * Frame the player from straight above (the "Top-down view" step). Mirrors the
   * Babylon `Viewer.focusOnPlayer`: the camera sits just below the splat ceiling,
   * always between one player-height and 4m above the player's head, so the view
   * is bounded by the actual scene extents instead of an arbitrary fixed height.
   */
  public focusOnPlayer(): void {
    if (!this.handles || !this.playerMesh) return;
    // World-space player position (the Z-mirror is baked in here).
    const p = this.playerMesh.getWorldPosition(new THREE.Vector3());
    const playerHeight = 0.5;
    const playerTopY = p.y + playerHeight / 2;

    let ceilingY = this.sceneBounds ? this.sceneBounds.max[1] : Number.NaN;
    if (!Number.isFinite(ceilingY) && this.world) {
      const box = new THREE.Box3().setFromObject(this.world);
      if (Number.isFinite(box.max.y)) ceilingY = box.max.y;
    }
    if (!Number.isFinite(ceilingY)) ceilingY = playerTopY + 4;

    const ceilingMargin = 0.65;
    const minOffset = playerHeight;
    const maxOffset = 4.0;
    const offsetToCeiling = ceilingY - ceilingMargin - playerTopY;
    const offset = Math.min(maxOffset, Math.max(minOffset, offsetToCeiling));
    const cameraHeight = playerTopY + offset;

    this.handles.camera.position.set(p.x, cameraHeight, p.z + 1e-3);
    this.handles.camera.near = 0.05;
    this.handles.camera.far = Math.max(1000, (cameraHeight - p.y) * 8);
    this.handles.camera.updateProjectionMatrix();
    if (this.handles.controls) {
      this.handles.controls.target.set(p.x, p.y, p.z);
      this.handles.controls.update();
    } else {
      this.handles.camera.lookAt(p.x, p.y, p.z);
    }
  }

  /** Tear down splat, overlays and crowd back to an empty scene. */
  public async reset(): Promise<void> {
    this.disableRegionSelection();
    this.destroyCrowd();
    this._environmentScale = 1;
    if (this.world) {
      if (this.floorMesh) {
        this.world.remove(this.floorMesh);
        this.disposeMesh(this.floorMesh);
        this.floorMesh = null;
      }
      if (this.collisionBoundaryMesh) {
        this.world.remove(this.collisionBoundaryMesh);
        this.disposeMesh(this.collisionBoundaryMesh);
        this.collisionBoundaryMesh = null;
      }
      if (this.navMeshOverlay) {
        this.world.remove(this.navMeshOverlay);
        this.disposeMesh(this.navMeshOverlay);
        this.navMeshOverlay = null;
      }
    }
    await this.disposeSplat();
  }

  // --- internals ---------------------------------------------------------

  private handleTap(e: PointerEvent): void {
    if (!this.handles || !this.navMeshOverlay || !this.playerAgent) return;
    if (this.isNavMeshEditorEnabled()) return;
    if (!controlsModeAllowsClick(this._controlsMode)) return;
    const rect = this.handles.gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.handles.camera);
    const hit = this.raycaster.intersectObject(this.navMeshOverlay, false)[0];
    if (!hit) return;
    // The hit is in world space; convert it back to the overlay's local (recast
    // navmesh) coordinates, undoing the world Z-mirror, before steering the agent.
    this.navMeshOverlay.updateWorldMatrix(true, false);
    const local = this.navMeshOverlay.worldToLocal(hit.point.clone());
    const snapped = this.snapToNavMesh([local.x, local.y, local.z]) ?? [local.x, local.y, local.z];
    // Face toward target in place first; start pathing only after arrive.
    this.playerAgent.resetMoveTarget();
    const pos = this.playerAgent.position();
    const clickYaw = yawTowardPoint(pos, {
      x: snapped[0],
      y: snapped[1],
      z: snapped[2],
    });
    if (clickYaw === null) {
      this._pendingClickFaceYaw = null;
      this._pendingClickMoveTarget = null;
      this.playerAgent.requestMoveTarget({
        x: snapped[0],
        y: snapped[1],
        z: snapped[2],
      });
    } else {
      this._pendingClickFaceYaw = clickYaw;
      this._pendingClickMoveTarget = [snapped[0], snapped[1], snapped[2]];
    }
    this._suppressTravelFacingUntilInput = false;
  }

  private tickPlayerWasd(delta: number, sample: PlayerWasdSample): void {
    if (!this.playerAgent || !controlsModeAllowsWasd(this._controlsMode)) {
      return;
    }
    if (!isPlayerWasdSampleActive(sample)) {
      return;
    }
    const moved = integratePlayerWasdMove({
      dt: delta,
      sample,
      yawRadians: this._playerYawRadians,
    });
    this._playerYawRadians = moved.yawRadians;
    const len = Math.hypot(moved.moveX, moved.moveZ);
    if (len < 1e-6) {
      return;
    }
    const pos = this.playerAgent.position();
    const scale = PLAYER_WASD_LOOKAHEAD_METERS / len;
    const target: [number, number, number] = [
      pos.x + moved.moveX * scale,
      pos.y,
      pos.z + moved.moveZ * scale,
    ];
    const snapped = this.snapToNavMesh(target) ?? target;
    this.playerAgent.requestMoveTarget({
      x: snapped[0],
      y: snapped[1],
      z: snapped[2],
    });
  }

  private clearFloorMesh(): void {
    if (!this.floorMesh || !this.world) {
      return;
    }
    this.world.remove(this.floorMesh);
    this.disposeMesh(this.floorMesh);
    this.floorMesh = null;
  }

  private applyNavMeshOverlayVisibility(): void {
    if (!this.navMeshOverlay) {
      return;
    }
    const material = this.navMeshOverlay.material;
    if (Array.isArray(material)) {
      return;
    }
    if (!(material instanceof THREE.MeshBasicMaterial)) {
      return;
    }
    material.opacity = this.navMeshOverlayShown ? NAVMESH_OVERLAY_OPACITY : 0;
    material.transparent = true;
    // Mesh stays visible so Three.js raycasts still intersect the walkable surface.
    this.navMeshOverlay.visible = true;
  }

  private snapToNavMesh(point: [number, number, number] | null): [number, number, number] | null {
    if (!point || !this.navMeshQuery) return point;
    try {
      const result = this.navMeshQuery.findClosestPoint({ x: point[0], y: point[1], z: point[2] });
      const p = (result as { point?: { x: number; y: number; z: number } }).point;
      if (p && Number.isFinite(p.x)) return [p.x, p.y, p.z];
    } catch {
      // fall through to the raw point
    }
    return point;
  }

  /** Triangular wedge; tip along +Z (forward at yaw 0). */
  private static createPlayerMarkerGeometry(): THREE.BufferGeometry {
    const { positions, indices } = playerMarkerWedgeBuffers();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return geometry;
  }

  private syncMesh(mesh: THREE.Mesh, agent: CrowdAgent): void {
    const p = agent.position();
    const yOffset = (mesh.userData.yOffset as number | undefined) ?? 0;
    mesh.position.set(p.x, p.y + yOffset, p.z);
  }

  /**
   * Apply oriented-space yaw to the player mesh (tip +Z at yaw 0).
   * Parent `world.scale.z = -1` aligns positions with Babylon LH; do not negate
   * Y rotation — `rotation.y = +yaw` keeps tip parallel to WASD / NavKit meta.
   */
  private syncPlayerMeshYaw(): void {
    if (!this.playerMesh) {
      return;
    }
    this.playerMesh.rotation.y = this._playerYawRadians;
  }

  /**
   * Build a billboard text label that matches the Babylon demos' marker labels.
   * Rendered as ALPHA-TESTED opaque (transparent: false + alphaTest) so it writes
   * depth and the Gaussian splat depth-tests against it: stable at every camera
   * angle/distance and correctly occluded when the agent is behind splat geometry
   * - the same approach as `Viewer.attachMarkerLabel` (src/scene/Viewer.ts). Mips
   * are disabled so the thin text's alpha is not minified below the alphaTest
   * cutoff at distance (which would make it vanish when far away).
   */
  private static makeLabelSprite(text: string, colorHex: string): THREE.Sprite {
    const w = 256;
    const h = 96;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, w, h);
    ctx.font = 'bold 44px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorHex;
    ctx.fillText(text, w / 2, h / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: false,
      alphaTest: 0.35,
      depthTest: true,
      depthWrite: true,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.9, 0.9 * (h / w), 1); // ~0.9m wide, preserve text aspect
    return sprite;
  }

  /** Park a label just above its agent mesh (in world space). */
  private updateLabel(label: THREE.Sprite, mesh: THREE.Mesh): void {
    mesh.getWorldPosition(this.labelTmp);
    label.position.set(this.labelTmp.x, this.labelTmp.y + 0.9, this.labelTmp.z);
  }

  private disposeSprite(sprite: THREE.Sprite): void {
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.dispose();
  }

  private buildGeometry(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(indices.slice(), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private disposeMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
  }

  private destroyCrowd(): void {
    if (this._navMeshEditor) {
      this._navMeshEditor.dispose();
      this._navMeshEditor = null;
    }
    this._wasdKeys.detach();
    if (this.world) {
      if (this.playerMesh) {
        this.world.remove(this.playerMesh);
        this.disposeMesh(this.playerMesh);
      }
      for (const mesh of this.npcMeshes) {
        this.world.remove(mesh);
        this.disposeMesh(mesh);
      }
    }
    // Labels live on the scene root (not the Z-mirrored world) so their
    // billboard text reads the right way round; tear them down here.
    const scene = this.handles?.scene;
    if (this.playerLabel) {
      scene?.remove(this.playerLabel);
      this.disposeSprite(this.playerLabel);
    }
    for (const label of this.npcLabels) {
      scene?.remove(label);
      this.disposeSprite(label);
    }
    this.playerLabel = null;
    this.npcLabels.length = 0;
    this.playerMesh = null;
    this.npcMeshes.length = 0;
    this.npcAgents.length = 0;
    this.playerAgent = null;
    if (this.crowd) {
      this.crowd.destroy();
      this.crowd = null;
    }
    this.navMeshQuery = null;
  }

  private async disposeSplat(): Promise<void> {
    const viewer = this.splatViewer;
    const group = this.splatGroup;
    this.splatViewer = null;
    this.splatGroup = null;
    if (group && this.world) {
      this.world.remove(group);
    }
    if (!viewer) {
      return;
    }
    try {
      await viewer.dispose();
    } catch {
      // best effort — never block a subsequent loadSplat on dispose failures
    }
  }
}
