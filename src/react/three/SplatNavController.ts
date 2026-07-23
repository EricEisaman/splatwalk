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

import {
  ensureRegionSelectionVolume,
  MIN_REGION_HEIGHT_METERS,
  regionSelectionSize,
} from '@/navigation/regionSelection';

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
      this.crowd.update(Math.min(dt, 0.1));
      if (this.playerAgent && this.playerMesh) {
        this.syncMesh(this.playerMesh, this.playerAgent);
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
    if (!this.handles || !this.world) throw new Error('Controller not attached to a scene.');
    await this.disposeSplat();

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

    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    try {
      await viewer.addSplatScene(url, {
        format: GaussianSplats3D.SceneFormat.Ply,
        showLoadingUI: false,
        progressiveLoad: false,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
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

  /** Toggle the collision voxel boundary overlay. */
  public setCollisionBoundaryVisible(visible: boolean): void {
    if (this.collisionBoundaryMesh) {
      this.collisionBoundaryMesh.visible = visible;
    }
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

  /** Show the walkable navmesh overlay (green) and use it as the click target. */
  public showNavMesh(positions: Float32Array, indices: Uint32Array): void {
    if (!this.world) return;
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
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x1144ff, emissive: 0x0a1c4d })
    );
    playerMesh.userData.yOffset = 0.25; // lift the 0.5m box so it rests ON the navmesh
    this.playerMesh = playerMesh;
    this.world?.add(playerMesh);
    this.syncMesh(playerMesh, this.playerAgent);

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
   * Apply a FreeCamera-style view (degrees) after Fast Nav when `cameraSelect` is
   * set — R3F OrbitControls approximate of Babylon {@link Viewer.applyCameraSelectView}.
   */
  public applyCameraSelectView(view: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly eulerDegrees: { readonly x: number; readonly y: number; readonly z: number };
  }): void {
    if (!this.handles) {
      return;
    }
    const degToRad = Math.PI / 180;
    const pitch = view.eulerDegrees.x * degToRad;
    const yaw = view.eulerDegrees.y * degToRad;
    const lookDist = 10;
    // Babylon LH: yaw 0 looks +Z. Aim OrbitControls target along that forward.
    const fx = Math.sin(yaw) * Math.cos(pitch);
    const fy = -Math.sin(pitch);
    const fz = Math.cos(yaw) * Math.cos(pitch);
    const { x, y, z } = view.position;
    this.handles.camera.position.set(x, y, z);
    const tx = x + fx * lookDist;
    const ty = y + fy * lookDist;
    const tz = z + fz * lookDist;
    if (this.handles.controls) {
      this.handles.controls.target.set(tx, ty, tz);
      this.handles.controls.update();
    } else {
      this.handles.camera.lookAt(tx, ty, tz);
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
    this.playerAgent.requestMoveTarget({ x: snapped[0], y: snapped[1], z: snapped[2] });
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

  private syncMesh(mesh: THREE.Mesh, agent: CrowdAgent): void {
    const p = agent.position();
    const yOffset = (mesh.userData.yOffset as number | undefined) ?? 0;
    mesh.position.set(p.x, p.y + yOffset, p.z);
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
    if (this.splatViewer) {
      try {
        await this.splatViewer.dispose();
      } catch {
        // best effort
      }
      this.splatViewer = null;
    }
    if (this.splatGroup && this.world) {
      this.world.remove(this.splatGroup);
    }
    this.splatGroup = null;
  }
}
