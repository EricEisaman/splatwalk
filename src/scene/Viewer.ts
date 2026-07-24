import {
    ArcRotateCamera,
    AbstractMesh,
    Color3,
    DynamicTexture,
    FreeCamera,
    GizmoManager,
    HemisphericLight,
    Material,
    Matrix,
    Mesh,
    PointerEventTypes,
    Scene,
    SceneLoader,
    StandardMaterial,
    Vector3,
    VertexBuffer,
    VertexData,
} from '@babylonjs/core';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import {
    createBabylonEngine,
    type BabylonRendererPreference,
} from './createBabylonEngine';
import '@babylonjs/loaders'; // Import loaders (OBJ, GLTF, STL)
import { GLTF2Export } from '@babylonjs/serializers/glTF';
import { Crowd, NavMesh as RecastNavMesh, NavMeshQuery, init as initRecast, importNavMesh, CrowdAgent } from 'recast-navigation';
import type { GroundFieldCellState, WalkableGroundFieldResult } from '../wasm/bridge';
import {
    ensureRegionSelectionVolume,
    MIN_REGION_HEIGHT_METERS,
    regionSelectionSize,
} from '../navigation/regionSelection';
import { SplatPerfHud, installSplatWalkPerfProbe } from './splatPerfHud';
import {
    captureActiveCameraView,
    configureOrbitCamera,
    createFlyCameraFromView,
    createOrbitCameraFromView,
    freeCameraEulerDegreesFromLookDirection,
    syncFreeCameraTargetFromRotation,
    type DemoCameraMode,
    frameFlyCameraToScene,
    frameOrbitCameraToScene,
} from './demoCameraControls';
import { worldRegionToRawSogBounds } from '../storage/materializeNavSourceFromStreamedSog';
import {
    findGaussianStreamInScene,
    NavSessionRuntimeController,
} from '../navigation/navSessionRuntime';
import {
    pickNavDebugMeshPoint,
    pickNavSurfacePoint,
} from '../navigation/navClickTarget';
import {
    VoxelWalkController,
    VoxelWalkRuntime,
} from '../navigation/voxelWalkRuntime';
import type { NavKitControlsMode } from '../navigation/navKitContract';
import { resolveNavKitCameraLook } from '../navigation/navKitPoseInfo';
import {
    controlsModeAllowsClick,
    controlsModeAllowsWasd,
    integratePlayerWasdMove,
    isPlayerWasdSampleActive,
    PLAYER_WASD_LOOKAHEAD_METERS,
    PlayerWasdKeyTracker,
    type PlayerWasdSample,
} from '../navigation/playerWasdControls';
import {
    travelFacingYawFromAgent,
    yawTowardPoint,
} from '../navigation/playerTravelFacing';
import {
    PLAYER_MARKER_HALF_HEIGHT_M,
    playerMarkerWedgeBuffers,
} from '../navigation/playerMarkerGeometry';
import type { NavMeshEditorRebakeResult, NavMeshEditorStatus } from '../navigation/navmeshEditor';
import { NavMeshEditorBabylon } from './navMeshEditorBabylon';
import type { CollisionVoxelVolume } from '../wasm/bridge';

const AGENT_HALF_HEIGHT = PLAYER_MARKER_HALF_HEIGHT_M;
const VOXEL_WALK_CLICK_RAY_MAX = 200;
import type { GaussianSplattingStream } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

/** Existing Babylon engine/scene to adopt (e.g. stream → nav handoff). */
export interface ViewerExistingContext {
    readonly engine: AbstractEngine;
    /**
     * Keep streamed SOG / existing visual meshes and only install nav camera +
     * overlays. PLY materialize stays an off-canvas intermediary for WASM.
     */
    readonly preserveVisual?: boolean;
    /**
     * Keep the storage-adapter fly camera (WASD + mouse look) instead of replacing
     * it with an orbit camera on stream → nav handoff.
     */
    readonly preserveFlyCamera?: FreeCamera;
    readonly scene: Scene;
}

/** Construction options for {@link Viewer}. */
export interface ViewerOptions {
    /**
     * Adopt an existing engine+scene instead of creating a new GPU context.
     * Used by the Storage Adapter stream → Fast Nav handoff so the canvas does
     * not flicker/black-out from dispose+recreate on the same canvas element.
     */
    readonly existing?: ViewerExistingContext;
    /**
     * Preferred renderer when creating a new engine. WebGPU falls back to WebGL
     * when unsupported. Ignored when {@link existing} is set.
     */
    readonly renderer?: BabylonRendererPreference;
    /**
     * Render in a right-handed scene (`scene.useRightHandedSystem = true`) instead
     * of Babylon's default left-handed one. Off by default; this is a
     * conformance/regression path (gated behind the showcase's hidden `?rh=1`)
     * that validates SplatWalk's `splatwalk_oriented` output (right-handed, +Y up)
     * lands correctly in a right-handed Babylon scene, mirroring Babylon PR #18606.
     * See `docs/coordinate-alignment.md`.
     */
    readonly rightHanded?: boolean;
}

export class Viewer {
  private engine: AbstractEngine;
  private scene: Scene;
    private camera!: ArcRotateCamera | FreeCamera;
    private readonly rightHanded: boolean;
    private _isFlyCamera = false;
    private _orbitShiftDispose: (() => void) | null = null;

    /**
     * Prefer {@link Viewer.create} for a new canvas (supports WebGPU). Sync
     * construction is for adopting an existing engine (`options.existing`).
     */
    constructor(_canvas: HTMLCanvasElement, options: ViewerOptions = {}) {
        this.rightHanded = options.rightHanded ?? false;

        if (!options.existing) {
            throw new Error(
                'Viewer requires options.existing for sync construction. Use await Viewer.create(canvas, options) for a new engine.'
            );
        }

        this.engine = options.existing.engine;
        this.scene = options.existing.scene;
        this.engine.stopRenderLoop();
        this.prepareAdoptedScene(
            options.existing.preserveVisual === true,
            options.existing.preserveFlyCamera
        );

        installSplatWalkPerfProbe(this._perfHud);
        this.engine.runRenderLoop(() => {
            this._perfHud.recordFrame();
            this.scene.render();
        });

        window.addEventListener('resize', () => {
            this.engine.resize();
        });
    }

    /**
     * Create a Viewer with a new engine (WebGPU preferred, WebGL fallback).
     */
    static async create(
        canvas: HTMLCanvasElement,
        options: ViewerOptions = {}
    ): Promise<Viewer> {
        if (options.existing) {
            return new Viewer(canvas, options);
        }
        const created = await createBabylonEngine({
            canvas,
            preference: options.renderer ?? 'webgpu',
        });
        return new Viewer(canvas, {
            ...options,
            existing: {
                engine: created.engine,
                scene: new Scene(created.engine),
            },
        });
    }

    /**
     * Install Viewer camera + lighting on an adopted scene. When
     * `preserveVisual` is set, keep streamed SOG meshes and bind them as the
     * splat target for bounds / flip / rotation (nav overlays only).
     */
    private prepareAdoptedScene(preserveVisual: boolean, preserveFlyCamera?: FreeCamera): void {
        this.scene.useRightHandedSystem = this.rightHanded;
        this.scene.clearColor = new Color3(0.1, 0.1, 0.1).toColor4();

        for (const cam of [...this.scene.cameras]) {
            if (preserveFlyCamera && cam === preserveFlyCamera) {
                cam.detachControl();
                continue;
            }
            cam.detachControl();
            cam.dispose();
        }

        if (!preserveVisual) {
            while (this.scene.meshes.length > 0) {
                this.scene.meshes[0].dispose();
            }
        }

        if (preserveFlyCamera) {
            this._isFlyCamera = true;
            this.camera = preserveFlyCamera;
        } else {
            this._isFlyCamera = false;
            this.camera = this.createCamera();
        }
        this.scene.activeCamera = this.camera;

        if (this.scene.lights.length === 0) {
            this.createLights();
        }

        if (preserveVisual) {
            this.bindStreamVisualMeshes();
            // Keep the adopted fly camera pose (e.g. Oval stairs default / user framing).
            if (!preserveFlyCamera) {
                this.frameCameraToSplat();
            }
        }
    }

    private isStreamVisualMesh(mesh: AbstractMesh): boolean {
        const className = mesh.getClassName();
        const name = mesh.name || '';
        return (
            className.includes('Gaussian') ||
            className.includes('Splatting') ||
            name.includes('Gaussian') ||
            name.includes('Sog') ||
            name.includes('SOG') ||
            name === 'storageAdapterSogStream' ||
            name === 'GaussianSplattingStream'
        );
    }

    /**
     * Bind existing streamed SOG meshes as the Viewer splat target.
     * Preserves {@link GaussianSplattingStream}'s mesh orientation (Z-up→Y-up).
     * WASM {@link getSplatRotation} matches the live stream by default (378ec846).
     * SuperSplat-style assets can decouple nav-PLY via {@link setNavPlyRotation}.
     */
    public bindStreamVisualMeshes(): void {
        const candidates = this.scene.meshes.filter((mesh) => this.isStreamVisualMesh(mesh));
        const meshes = candidates.length > 0 ? candidates : [...this.scene.meshes];
        if (meshes.length === 0) {
            this.splatMesh = null;
            this.splatMeshes = [];
            return;
        }
        this.splatMeshes = meshes;
        this.splatMesh = meshes[0]!;
        this.splatMesh.isPickable = true;
        this.splatMesh.computeWorldMatrix(true);
        this._streamVisualRotation = {
            x: this.splatMesh.rotation.x,
            y: this.splatMesh.rotation.y,
            z: this.splatMesh.rotation.z,
        };
        this.rotation = { ...this._streamVisualRotation };
        this._navRotationDecoupledFromVisual = false;
        this._usesMaterializedStreamNavSource = true;
    }

    private applyStreamVisualRotationToMeshes(): void {
        const targets =
            this.splatMeshes.length > 0
                ? this.splatMeshes
                : this.scene.meshes.filter((mesh) => this.isStreamVisualMesh(mesh));
        for (const mesh of targets) {
            if (mesh.isDisposed()) {
                continue;
            }
            mesh.isPickable = true;
            mesh.rotation.x = this._streamVisualRotation.x;
            mesh.rotation.y = this._streamVisualRotation.y;
            mesh.rotation.z = this._streamVisualRotation.z;
            mesh.computeWorldMatrix(true);
        }
    }

    private applyNavPlyRotationToDebugMeshes(): void {
        for (const mesh of this._debugPlyMeshes) {
            if (mesh.isDisposed()) {
                continue;
            }
            mesh.rotation.x = this.rotation.x;
            mesh.rotation.y = this.rotation.y;
            mesh.rotation.z = this.rotation.z;
            mesh.computeWorldMatrix(true);
        }
    }

    private frameCameraToSplat(): void {
        if (this._isFlyCamera) {
            frameFlyCameraToScene(this.scene, this.camera as FreeCamera);
            return;
        }
        frameOrbitCameraToScene(this.scene, this.camera as ArcRotateCamera);
    }

    /**
     * Fail fast when the splat AABB looks Z-up / wall-as-floor (Y is the long axis).
     * That weird vertical skatepark view is a transform bug, not a Recast tuning issue.
     */
    public assertGroundLooksYUp(): void {
        let bounds = this.getLoadedSplatBounds();
        if (!bounds) {
            throw new Error('No splat bounds available for orientation check.');
        }
        // Stream handoff keeps the SOG visual at identity while WASM/nav PLY use
        // {@link getSplatRotation}. Validate the nav bake, not the raw stream AABB.
        if (this._navRotationDecoupledFromVisual && this._streamMeshesHiddenForDebug.length === 0) {
            const localBounds = this.getLoadedSplatLocalBounds();
            if (localBounds) {
                bounds = this.boundsAfterNavRotation(localBounds, this.rotation);
            }
        }
        const sizeX = bounds.max.x - bounds.min.x;
        const sizeY = bounds.max.y - bounds.min.y;
        const sizeZ = bounds.max.z - bounds.min.z;
        const horizontal = Math.max(sizeX, sizeZ);
        if (horizontal < 0.5) {
            return;
        }
        // Fail only when Y is strictly longer than the ground plane (true wall-as-floor).
        // Near-isotropic outdoor/sky AABBs (e.g. parish_02 environment shell) must not abort nav.
        if (sizeY > horizontal) {
            throw new Error(
                `Splat orientation looks wrong: Y extent ${sizeY.toFixed(1)}m ≥ horizontal ${horizontal.toFixed(1)}m ` +
                    `(${sizeX.toFixed(1)}×${sizeY.toFixed(1)}×${sizeZ.toFixed(1)}). ` +
                    `A vertical “floor” means a missing Z-up→Y-up bake (stream uses rotation.x = -π/2). ` +
                    `Use “Show nav PLY (debug)” to inspect the intermediary PLY transform.`
            );
        }
    }

    /**
     * Hide the live stream visual and show the materialized nav PLY oriented with
     * the current nav-PLY euler ({@link getSplatRotation}). For transform debugging
     * only — restore with {@link restoreStreamVisual}.
     */
    public async showDebugIntermediaryPly(
        plyBytes: Uint8Array,
        _options: { applySogLodOrientation?: boolean } = {}
    ): Promise<void> {
        this._streamMeshesHiddenForDebug = this.splatMeshes.filter((m) => !m.isDisposed());
        for (const mesh of this._streamMeshesHiddenForDebug) {
            mesh.setEnabled(false);
        }

        for (const mesh of this._debugPlyMeshes) {
            if (!mesh.isDisposed()) {
                mesh.dispose();
            }
        }
        this._debugPlyMeshes = [];

        const plyFile = new File([plyBytes as BlobPart], 'nav-debug.ply', {
            type: 'application/octet-stream',
        });
        const result = await SceneLoader.ImportMeshAsync('', '', plyFile, this.scene);
        this._debugPlyMeshes = result.meshes;
        if (result.meshes.length === 0) {
            this.restoreStreamVisual();
            throw new Error('Debug nav PLY produced no meshes.');
        }

        const root = result.meshes[0]!;
        root.rotation.x = this.rotation.x;
        root.rotation.y = this.rotation.y;
        root.rotation.z = this.rotation.z;
        root.computeWorldMatrix(true);
        this.splatMesh = root;
        this.splatMeshes = result.meshes;
        this.frameCameraToSplat();
        this.scene.render();
    }

    /** Undo {@link showDebugIntermediaryPly} and show the streamed SOG again. */
    public restoreStreamVisual(): void {
        for (const mesh of this._debugPlyMeshes) {
            if (!mesh.isDisposed()) {
                mesh.dispose();
            }
        }
        this._debugPlyMeshes = [];
        for (const mesh of this._streamMeshesHiddenForDebug) {
            if (!mesh.isDisposed()) {
                mesh.setEnabled(true);
            }
        }
        const restored = this._streamMeshesHiddenForDebug.filter((m) => !m.isDisposed());
        this._streamMeshesHiddenForDebug = [];
        if (restored.length > 0) {
            this.splatMeshes = restored;
            this.splatMesh = restored[0]!;
            this.applyStreamVisualRotationToMeshes();
        }
        this.frameCameraToSplat();
        this.scene.render();
    }

    public resize(): void {
        this.engine.resize();
    }

    /** Whether this viewer renders in a right-handed scene (`?rh=1`). */
    public isRightHanded(): boolean {
        return this.rightHanded;
    }

    private createCamera(): ArcRotateCamera {
        const camera = new ArcRotateCamera(
            'camera',
            -Math.PI / 2,
            Math.PI / 2.5,
            10,
            Vector3.Zero(),
            this.scene
        );
        const canvas = this.engine.getRenderingCanvas();
        if (canvas) {
            this._orbitShiftDispose = configureOrbitCamera(camera, canvas);
        }

        return camera;
    }

    public getCameraMode(): DemoCameraMode {
        return this._isFlyCamera ? 'fly' : 'orbit';
    }

    /**
     * Apply a FreeCamera-style view (position + euler degrees). Switches to fly
     * mode when currently in orbit (view is not preserved across the switch).
     */
    public applyCameraSelectView(view: {
        readonly position: { readonly x: number; readonly y: number; readonly z: number };
        readonly eulerDegrees: { readonly x: number; readonly y: number; readonly z: number };
    }): void {
        if (!this._isFlyCamera) {
            this.setCameraMode('fly');
        }
        const fly = this.camera as FreeCamera;
        const degToRad = Math.PI / 180;
        fly.position.set(view.position.x, view.position.y, view.position.z);
        fly.rotation.x = view.eulerDegrees.x * degToRad;
        fly.rotation.y = view.eulerDegrees.y * degToRad;
        fly.rotation.z = view.eulerDegrees.z * degToRad;
        syncFreeCameraTargetFromRotation(fly);
        this.syncFlyKeysForControlsMode();
    }

    /**
     * Apply NavKit camera pose (oriented eye + look-at or euler °) into the demo camera.
     * Prefers explicit `target`; otherwise derives look from oriented Y-up euler.
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
        const look = resolveNavKitCameraLook({
            eulerDegrees: view.eulerDegrees,
            position: view.position,
            target: view.target,
        });
        const preserved = {
            position: new Vector3(look.position.x, look.position.y, look.position.z),
            target: new Vector3(look.target.x, look.target.y, look.target.z),
        };

        this._orbitShiftDispose?.();
        this._orbitShiftDispose = null;
        this.camera.detachControl();
        this.camera.dispose();
        this._isFlyCamera = false;
        this.camera = createOrbitCameraFromView(this.scene, 'camera', preserved);
        const canvas = this.engine.getRenderingCanvas();
        if (canvas) {
            this._orbitShiftDispose = configureOrbitCamera(
                this.camera as ArcRotateCamera,
                canvas
            );
        }
        this.scene.activeCamera = this.camera;
    }

    /** Active player input mode (click / WASDQE / both). */
    public getControlsMode(): NavKitControlsMode {
        return this._controlsMode;
    }

    /**
     * Gate click-to-move vs player WASDQE. When WASD is on, prefer orbit and
     * clear FreeCamera key bindings so agent keys win — unless
     * `syncCameraForWasd` is false.
     */
    public setControlsMode(
        mode: NavKitControlsMode,
        options?: { readonly syncCameraForWasd?: boolean }
    ): void {
        this._controlsMode = mode;
        const syncCameraForWasd = options?.syncCameraForWasd !== false;
        if (controlsModeAllowsWasd(mode)) {
            this._wasdKeys.attach();
            if (syncCameraForWasd && this._isFlyCamera) {
                this.setCameraMode('orbit', { preserveView: true });
                console.log(
                    '[INFO] Controls WASDQE: switched camera to orbit so W/A/S/D/Q/E drive the player.'
                );
            }
            this.syncFlyKeysForControlsMode();
        } else {
            this._wasdKeys.detach();
        }
    }

    /** Camera pose in world space for NavKit meta capture (pos + target + euler). */
    public getCameraPoseNavKit(): {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
        eulerDegrees: { x: number; y: number; z: number };
    } | null {
        const cam = this.camera;
        if (!cam) {
            return null;
        }
        const radToDeg = 180 / Math.PI;
        if (cam instanceof FreeCamera) {
            syncFreeCameraTargetFromRotation(cam);
            const t = cam.getTarget();
            return {
                position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
                target: { x: t.x, y: t.y, z: t.z },
                eulerDegrees: {
                    x: cam.rotation.x * radToDeg,
                    y: cam.rotation.y * radToDeg,
                    z: cam.rotation.z * radToDeg,
                },
            };
        }
        if (cam instanceof ArcRotateCamera) {
            const t = cam.getTarget();
            const look = t.subtract(cam.position);
            return {
                position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
                target: { x: t.x, y: t.y, z: t.z },
                eulerDegrees: freeCameraEulerDegreesFromLookDirection(look),
            };
        }
        return {
            position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
            target: { x: cam.position.x, y: cam.position.y, z: cam.position.z + 1 },
            eulerDegrees: { x: 0, y: 0, z: 0 },
        };
    }

    /** Player feet + yaw in oriented/nav space for NavKit meta capture. */
    public getPlayerPoseNavKit(): {
        position: { x: number; y: number; z: number };
        eulerDegrees: { x: number; y: number; z: number };
    } | null {
        if (!this.userAgent) {
            return null;
        }
        const p = this.userAgent.position();
        return {
            position: { x: p.x, y: p.y, z: p.z },
            eulerDegrees: {
                x: 0,
                y: (this._playerYawRadians * 180) / Math.PI,
                z: 0,
            },
        };
    }

    /**
     * Snap / teleport Recast player (oriented/nav space) and set facing yaw (degrees).
     */
    public teleportPlayerTo(options: {
        readonly position: { x: number; y: number; z: number };
        readonly yawDegrees?: number;
    }): void {
        if (!this.userAgent) {
            return;
        }
        const oriented = new Vector3(
            options.position.x,
            options.position.y,
            options.position.z
        );
        const snapped = this.resolveValidatedOrientedSpawn(oriented);
        this.userAgent.teleport(snapped);
        // Clear residual pathing so travel-facing does not overwrite NavKit yaw.
        this.userAgent.resetMoveTarget();
        this._pendingClickFaceYaw = null;
        this._pendingClickMoveTarget = null;
        this._playerYawRadians =
            ((options.yawDegrees ?? 0) * Math.PI) / 180;
        this._suppressTravelFacingUntilInput = true;
        if (this.userMesh) {
            this.syncPlayerMeshYaw();
            this.syncAgentMesh(this.userMesh, this.userAgent);
        }
    }

    private syncFlyKeysForControlsMode(): void {
        if (!(this.camera instanceof FreeCamera)) {
            return;
        }
        if (controlsModeAllowsWasd(this._controlsMode)) {
            this.camera.keysUp = [];
            this.camera.keysDown = [];
            this.camera.keysLeft = [];
            this.camera.keysRight = [];
            this.camera.keysUpward = [];
            this.camera.keysDownward = [];
            if (!this._clearedFlyKeysForWasd) {
                this._clearedFlyKeysForWasd = true;
                console.log('[INFO] Cleared FreeCamera WASD keys for player Controls.');
            }
        }
    }

    /**
     * Switch between WASD fly and orbit inspect cameras.
     * Fly controls are attached by the caller (storage adapter demo) via {@link configureFlyCamera}.
     */
    public setCameraMode(mode: DemoCameraMode, options?: { preserveView?: boolean }): void {
        if (this.getCameraMode() === mode) {
            return;
        }

        const preservedView =
            options?.preserveView === true ? captureActiveCameraView(this.camera) : null;

        this._orbitShiftDispose?.();
        this._orbitShiftDispose = null;
        this.camera.detachControl();
        this.camera.dispose();

        if (preservedView) {
            if (mode === 'fly') {
                this._isFlyCamera = true;
                this.camera = createFlyCameraFromView(this.scene, 'flyCamera', preservedView);
            } else {
                this._isFlyCamera = false;
                this.camera = createOrbitCameraFromView(this.scene, 'camera', preservedView);
                const canvas = this.engine.getRenderingCanvas();
                if (canvas) {
                    this._orbitShiftDispose = configureOrbitCamera(this.camera as ArcRotateCamera, canvas);
                }
            }
        } else {
            const worldExtends = this.scene.getWorldExtends();
            const center = worldExtends.min.add(worldExtends.max).scale(0.5);
            const radius = worldExtends.max.subtract(worldExtends.min).length() / 2;

            if (mode === 'fly') {
                const distance = Math.max(6, radius * 1.3);
                const fly = new FreeCamera(
                    'flyCamera',
                    center.add(new Vector3(0, distance * 0.25, -distance)),
                    this.scene
                );
                fly.setTarget(center);
                this._isFlyCamera = true;
                this.camera = fly;
            } else {
                const orbit = new ArcRotateCamera(
                    'camera',
                    -Math.PI / 2,
                    Math.PI / 2.5,
                    Math.max(2, radius * 2),
                    center,
                    this.scene
                );
                this._isFlyCamera = false;
                this.camera = orbit;
                const canvas = this.engine.getRenderingCanvas();
                if (canvas) {
                    this._orbitShiftDispose = configureOrbitCamera(orbit, canvas);
                }
            }
        }

        this.scene.activeCamera = this.camera;
    }

    private createLights(): void {
        const light = new HemisphericLight('light', new Vector3(0, 1, 0), this.scene);
        light.intensity = 0.7;
    }


    private splatMesh: AbstractMesh | null = null;
    private splatMeshes: AbstractMesh[] = [];
    private _debugPlyMeshes: AbstractMesh[] = [];
    private _streamMeshesHiddenForDebug: AbstractMesh[] = [];
    /** Nav-PLY / WASM orientation (what {@link getSplatRotation} returns). */
    private rotation: { x: number, y: number, z: number } = { x: 0, y: 0, z: 0 };
    /** Stream-visual-only orientation; does not affect WASM MeshSettings.rotation. */
    private _streamVisualRotation: { x: number, y: number, z: number } = { x: 0, y: 0, z: 0 };
    /**
     * When true, the stream SOG visual euler is decoupled from nav-PLY / WASM
     * ({@link bindStreamVisualMeshes}). Orientation checks must bake {@link rotation}
     * into local bounds instead of reading the live stream mesh world AABB.
     */
    private _navRotationDecoupledFromVisual = false;
    /**
     * Stream handoff keeps live {@link GaussianSplattingStream} on canvas while WASM
     * consumes materialized SOG→PLY bytes (raw PlayCanvas coords, not Babylon PLY load).
     */
    private _usesMaterializedStreamNavSource = false;
    /** Absolute uniform environment scale (default 1). Does not scale player/NPC markers. */
    private _environmentScale = 1;
    private readonly _perfHud = new SplatPerfHud();

    /**
     * Visualize a splat from full-fidelity binary 3DGS PLY bytes. Non-PLY formats
     * (`.spz`, `.splat`) are normalized to PLY upstream (see `@/wasm/normalize`),
     * so Babylon only ever drives its PLY loader here. This avoids Babylon's `.spz`
     * loader, which fetches a third-party decoder from a CDN at runtime (blocked by
     * the app CSP), and keeps splat orientation consistent across input formats.
     */
    public async loadGaussianSplat(plyBytes: Uint8Array): Promise<void> {
        const loadStart = performance.now();
        try {
            this.disableRegionSelection();
            this.clearGroundFieldOverlay();
            this.resetDerivedSceneState();

            // Clear remaining meshes (splat and any stragglers)
            while (this.scene.meshes.length > 0) {
                this.scene.meshes[0].dispose();
            }

            // Reset rotation
            this.rotation = { x: 0, y: 0, z: 0 };
            this._navRotationDecoupledFromVisual = false;
            this._usesMaterializedStreamNavSource = false;
            this.splatMesh = null;
            this.splatMeshes = [];

            // Always load PLY: the normalized bytes are wrapped as a `.ply` File so
            // Babylon selects its PLY loader (no CDN-backed loaders involved).
            const plyFile = new File([plyBytes as BlobPart], 'scene.ply', { type: 'application/octet-stream' });
            const result = await SceneLoader.ImportMeshAsync("", "", plyFile, this.scene);

            if (result.meshes.length > 0) {
                // Usually the first mesh is the root or the splat
                this.splatMesh = result.meshes[0];
                this.splatMeshes = result.meshes;
                this.applyEnvironmentScaleToMeshes();

                // Auto-focus the camera
                const worldExtends = this.scene.getWorldExtends();
                const center = worldExtends.min.add(worldExtends.max).scale(0.5);
                const radius = worldExtends.max.subtract(worldExtends.min).length() / 2;

                if (this._isFlyCamera) {
                    const fly = this.camera as FreeCamera;
                    const distance = Math.max(6, radius * 1.3);
                    fly.position = center.add(new Vector3(0, distance * 0.25, -distance));
                    fly.setTarget(center);
                } else {
                    const orbit = this.camera as ArcRotateCamera;
                    orbit.setTarget(center);
                    orbit.radius = Math.max(2, radius * 2.0);
                }
            }

            this._perfHud.recordSplatLoad(
                performance.now() - loadStart,
                this.splatMeshes.length,
            );

        } catch (e) {
            console.error("Failed to visualize splat:", e);
            // Non-blocking for /vuetify conversion flows; callers that need a
            // visible splat should check {@link hasLoadedSplat}.
        }
    }

    /** True when {@link loadGaussianSplat} left at least one mesh in the scene. */
    public hasLoadedSplat(): boolean {
        return this.splatMeshes.length > 0 || this.splatMesh !== null;
    }

    /**
     * Match {@link GaussianSplattingStream}: PlayCanvas SOG LOD is authored Z-up
     * with a flipped Y. The PLY loader already applies `scaling.y *= -1`; this adds
     * the missing `-π/2` about X so the floor is horizontal in Babylon Y-up space.
     * Updates {@link getSplatRotation} so WASM Fast Nav / collision stay aligned.
     */
    public applyStreamedSogLodOrientation(): void {
        if (!this.splatMesh) {
            console.warn('No splat mesh to orient for streamed SOG LOD.');
            return;
        }

        const angle = -Math.PI / 2;
        this.rotation = { x: angle, y: 0, z: 0 };
        this.splatMesh.rotation.x = angle;
        this.splatMesh.computeWorldMatrix(true);

        const worldExtends = this.scene.getWorldExtends();
        const center = worldExtends.min.add(worldExtends.max).scale(0.5);
        const radius = worldExtends.max.subtract(worldExtends.min).length() / 2;
        if (this._isFlyCamera) {
            const fly = this.camera as FreeCamera;
            const distance = Math.max(6, radius * 1.3);
            fly.position = center.add(new Vector3(0, distance * 0.25, -distance));
            fly.setTarget(center);
        } else {
            const orbit = this.camera as ArcRotateCamera;
            orbit.setTarget(center);
            orbit.radius = Math.max(2, radius * 2.0);
        }
        this.engine.resize();
        this.scene.render();
    }

    /**
     * Gaussian-splat loaders import with a negative Y scale (Y-down source convention),
     * so the rendered splat lives in a Y-flipped world relative to the raw PLY/SPZ data
     * that WASM parses. Report that flip so the navmesh pipeline can match render space.
     */
    public isSplatYFlipped(): boolean {
        const mesh = this.splatMesh;
        if (!mesh) return false;
        mesh.computeWorldMatrix(true);
        return (mesh.scaling?.y ?? 1) < 0;
    }

    /**
     * True when nav WASM consumes materialized SOG→PLY bytes while the live
     * GaussianSplattingStream mesh supplies visual orientation separately.
     */
    public usesDecoupledStreamNavSource(): boolean {
        return this._navRotationDecoupledFromVisual;
    }

    /** True when WASM reads materialized SOG→PLY while the stream supplies the visual. */
    public usesMaterializedStreamNavSource(): boolean {
        return this._usesMaterializedStreamNavSource;
    }

    /**
     * `flip_y` for WASM mesh settings. Streamed nav PLY is raw PlayCanvas Z-up
     * (never through Babylon's PLY loader) but must match the stream's Y-flip
     * contract (`GaussianSplattingStream` negates mesh.scaling.y).
     */
    public getWasmFlipY(): boolean {
        if (this._usesMaterializedStreamNavSource || this._navRotationDecoupledFromVisual) {
            return true;
        }
        return this.isSplatYFlipped();
    }

    public rotateSplat(axis: 'x' | 'y' | 'z'): void {
        if (!this.splatMesh) {
            console.warn("No splat mesh to rotate");
            return;
        }

        // Workbench path: rotate nav-PLY state and the active splat mesh together.
        this.rotation[axis] += Math.PI / 2;
        this.splatMesh.rotation[axis] += Math.PI / 2;

        console.log(`Rotated ${axis} by 90deg. Current:`, this.rotation);
    }

    public getSplatRotation(): { x: number, y: number, z: number } {
        return { ...this.rotation };
    }

    /** Stream-visual-only euler (does not affect WASM {@link getSplatRotation}). */
    public getStreamVisualRotation(): { x: number, y: number, z: number } {
        return { ...this._streamVisualRotation };
    }

    /**
     * Rotate the streamed SOG visual by +90° about `axis` without changing nav-PLY /
     * WASM orientation.
     */
    public rotateStreamVisual(axis: 'x' | 'y' | 'z'): void {
        this._streamVisualRotation[axis] += Math.PI / 2;
        this.applyStreamVisualRotationToMeshes();
        console.log(
            `[INFO] Stream visual rotated ${axis} +90°. Current:`,
            this._streamVisualRotation
        );
    }

    /** Set absolute stream-visual euler (radians). */
    public setStreamVisualRotation(euler: { x: number; y: number; z: number }): void {
        this._streamVisualRotation = { x: euler.x, y: euler.y, z: euler.z };
        this.applyStreamVisualRotationToMeshes();
    }

    /**
     * Rotate nav-PLY / WASM orientation by +90° about `axis`. Updates debug PLY
     * meshes when they are visible; does not move the stream visual.
     */
    public rotateNavPly(axis: 'x' | 'y' | 'z'): void {
        this.rotation[axis] += Math.PI / 2;
        this.syncNavRotationDecoupledFlag();
        this.applyNavPlyRotationToDebugMeshes();
        console.log(`[INFO] Nav PLY rotated ${axis} +90°. Current:`, this.rotation);
    }

    /** Set absolute nav-PLY / WASM euler (radians). Decouples from stream visual when it differs. */
    public setNavPlyRotation(euler: { x: number; y: number; z: number }): void {
        this.rotation = { x: euler.x, y: euler.y, z: euler.z };
        this.syncNavRotationDecoupledFlag();
        this.applyNavPlyRotationToDebugMeshes();
    }

    private syncNavRotationDecoupledFlag(): void {
        const eps = 1e-6;
        this._navRotationDecoupledFromVisual =
            Math.abs(this.rotation.x - this._streamVisualRotation.x) > eps ||
            Math.abs(this.rotation.y - this._streamVisualRotation.y) > eps ||
            Math.abs(this.rotation.z - this._streamVisualRotation.z) > eps;
    }

    /** Absolute uniform environment scale applied to the splat and collider overlays. */
    public getEnvironmentScale(): number {
        return this._environmentScale;
    }

    /**
     * Set absolute uniform environment scale. Scales the splat mesh (preserving Y-flip
     * sign) and any collider overlay meshes. Player/NPC markers are left unchanged.
     */
    public setEnvironmentScale(scale: number): void {
        if (!Number.isFinite(scale) || scale <= 0) {
            console.warn(`[WARN] Ignoring invalid environment scale: ${scale}`);
            return;
        }
        this._environmentScale = scale;
        this.applyEnvironmentScaleToMeshes();
        console.log(`[INFO] Environment scale set to ${scale}.`);
    }

    private applyEnvironmentScaleToMeshes(): void {
        const s = this._environmentScale;
        const targets = new Set<AbstractMesh>();
        if (this.splatMesh) {
            targets.add(this.splatMesh);
        }
        for (const mesh of this.splatMeshes) {
            targets.add(mesh);
        }
        for (const mesh of targets) {
            const ySign = Math.sign(mesh.scaling.y) || 1;
            mesh.scaling.set(s, ySign * s, s);
            mesh.computeWorldMatrix(true);
        }
        // Imported GLBs are authoring-space; generated WASM colliders already bake
        // environment_scale into vertices and stay at identity scaling.
        if (this._colliderNeedsEnvironmentScale) {
            for (const mesh of this.colliderMeshes) {
                mesh.scaling.set(s, s, s);
                mesh.computeWorldMatrix(true);
            }
        }
    }

    public async loadMesh(data: Uint8Array | ArrayBuffer | string, extension: string = '.glb'): Promise<void> {
        try {
            // Clear existing meshes
            while (this.scene.meshes.length > 0) {
                this.scene.meshes[0].dispose();
            }

            if (typeof data === 'string') {
                await SceneLoader.AppendAsync('', data, this.scene);
            } else {
                await SceneLoader.AppendAsync('', data as any, this.scene, undefined, extension);
            }
        } catch (e) {
            console.error("Failed to load mesh", e);
            throw e;
        }
    }

    public async exportGLB(filename: string): Promise<void> {
        try {
            const glb = await GLTF2Export.GLBAsync(this.scene, filename, {
                shouldExportNode: (node: any) => {
                    return node.name === "custom_mesh";
                }
            });
            glb.downloadFiles();
        } catch (e) {
            console.error("Export failed", e);
            throw e;
        }
    }

    public focusOnMesh(mesh: AbstractMesh): void {
        const boundingInfo = mesh.getBoundingInfo();
        const center = boundingInfo.boundingBox.centerWorld;
        const radius = boundingInfo.boundingSphere.radiusWorld;

        if (this._isFlyCamera) {
            const fly = this.camera as FreeCamera;
            const distance = Math.max(6, radius * 3.0);
            fly.position = center.add(new Vector3(0, distance * 0.35, -distance));
            fly.setTarget(center);
            return;
        }

        const orbit = this.camera as ArcRotateCamera;
        orbit.setTarget(center);
        orbit.radius = radius * 3.0;
        orbit.alpha = Math.PI / 4;
        orbit.beta = Math.PI / 3;
    }

    // Place the camera directly above the player agent looking straight down,
    // at a vertical offset derived from the player height and the room ceiling,
    // so the player is always clearly visible on the navmesh floor without the
    // surrounding splat walls occluding the view. The camera sits just below the
    // ceiling (clamped to a sensible range) which gives definitive proof of the
    // player resting on the ground. Returns details, or null if no player exists.
    public focusOnPlayer(): {
        player: [number, number, number];
        cameraHeight: number;
        ceilingY: number;
        floorY: number;
    } | null {
        if (!this.userMesh) {
            return null;
        }
        const position = this.userMesh.getAbsolutePosition();

        // Player vertical extent (agent box is ~0.5m; its center is `position`).
        const playerBounds = this.userMesh.getHierarchyBoundingVectors(true);
        const playerTopY = playerBounds.max.y;
        const playerBottomY = playerBounds.min.y;
        const playerHeight = Math.max(0.5, playerTopY - playerBottomY);

        // Room ceiling from the splat bounds; fall back to scene extents.
        let ceilingY = Number.NEGATIVE_INFINITY;
        const splatTargets = [this.splatMesh, ...this.splatMeshes].filter(Boolean) as AbstractMesh[];
        for (const mesh of splatTargets) {
            const b = mesh.getHierarchyBoundingVectors(true);
            ceilingY = Math.max(ceilingY, b.max.y);
        }
        if (!Number.isFinite(ceilingY)) {
            ceilingY = this.scene.getWorldExtends().max.y;
        }

        // Sit just below the ceiling, always at least one player-height above the
        // player's head, and clamp the offset so the player stays clearly framed.
        const ceilingMargin = 0.15;
        const minOffset = playerHeight; // never closer than one player height above the head
        const maxOffset = 4.0;          // avoid tiny players in very tall/outdoor scenes
        const offsetToCeiling = (ceilingY - ceilingMargin) - playerTopY;
        const offset = Math.min(maxOffset, Math.max(minOffset, offsetToCeiling));
        const cameraHeight = playerTopY + offset;

        if (this._isFlyCamera) {
            const fly = this.camera as FreeCamera;
            fly.position = new Vector3(position.x, cameraHeight, position.z);
            fly.setTarget(position);
        } else {
            const orbit = this.camera as ArcRotateCamera;
            orbit.setTarget(position.clone());
            orbit.beta = 0.0001;
            const framedRadius = cameraHeight - position.y;
            orbit.radius = Number.isFinite(framedRadius) && framedRadius > 0.5
                ? framedRadius
                : Math.max(2, orbit.radius || 8);
        }
        this.engine.resize();
        this.scene.render();

        return {
            player: [position.x, position.y, position.z],
            cameraHeight,
            ceilingY,
            floorY: playerBottomY,
        };
    }

    private crowd: Crowd | null = null;
    private recastNavMesh: RecastNavMesh | null = null;
    private navMeshQuery: NavMeshQuery | null = null;
    private npcAgents: CrowdAgent[] = [];
    private userAgent: CrowdAgent | null = null;
    private userMesh: AbstractMesh | null = null;
    private npcMeshes: AbstractMesh[] = [];
    private navMeshDebugMesh: Mesh | null = null;
    private navMeshMaterial: StandardMaterial | null = null;
    private navMeshVisualOffset: Vector3 = Vector3.Zero();
    private navMeshSpawnPoint: Vector3 | null = null;
    /** Oriented-space Recast debug mesh (editor source of truth). */
    private _orientedNavPositions: Float32Array | null = null;
    private _orientedNavIndices: Uint32Array | null = null;
    private _navMeshData: Uint8Array | null = null;
    private _navMeshEditor: NavMeshEditorBabylon | null = null;
    private readonly _editedNavMeshRebakeListeners = new Set<
        (
            result: NavMeshEditorRebakeResult
        ) => void | Promise<void>
    >();
    private _navMeshOverlayLiftY = 0.05;
    private pointerObserver: any = null;
    private crowdUpdateObserver: any = null;
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
    /** Move target held until click-face completes (oriented/nav space). */
    private _pendingClickMoveTarget: Vector3 | null = null;
    private _clearedFlyKeysForWasd = false;
    private selectionMesh: Mesh | null = null;
    private gizmoManager: GizmoManager | null = null;
    private groundFieldOverlayMeshes: Mesh[] = [];
    private colliderMeshes: AbstractMesh[] = [];
    private colliderMaterial: StandardMaterial | null = null;
    private navSessionRuntime: NavSessionRuntimeController | null = null;
    /** True when collider GLB is in authoring space and needs environment scale on the mesh. */
    private _colliderNeedsEnvironmentScale = false;
    private seedMarker: Mesh | null = null;
    private markerLabels: Mesh[] = [];
    private preferredPlayerSpawn: Vector3 | null = null;
    private preferredNpcSpawn: Vector3 | null = null;
    private voxelWalkUpdateObserver: any = null;
    private voxelWalkController: VoxelWalkController | null = null;

    private collectLoadedSplatMeshes(): Set<AbstractMesh> {
        const meshes = new Set<AbstractMesh>();

        if (this.splatMesh) {
            meshes.add(this.splatMesh);
            for (const child of this.splatMesh.getChildMeshes(false)) {
                meshes.add(child);
            }
        }

        for (const mesh of this.splatMeshes) {
            meshes.add(mesh);
            for (const child of mesh.getChildMeshes(false)) {
                meshes.add(child);
            }
        }

        return meshes;
    }

    private mergeMeshBounds(
        meshes: Iterable<AbstractMesh>,
        space: 'local' | 'world'
    ): { min: Vector3; max: Vector3 } | null {
        let min: Vector3 | null = null;
        let max: Vector3 | null = null;

        for (const mesh of meshes) {
            try {
                if (mesh.getTotalVertices() === 0) {
                    continue;
                }

                mesh.computeWorldMatrix(true);
                const boundingBox = mesh.getBoundingInfo().boundingBox;
                const meshMin = space === 'world' ? boundingBox.minimumWorld : boundingBox.minimum;
                const meshMax = space === 'world' ? boundingBox.maximumWorld : boundingBox.maximum;
                const values = [meshMin.x, meshMin.y, meshMin.z, meshMax.x, meshMax.y, meshMax.z];

                if (!values.every(Number.isFinite)) {
                    continue;
                }

                min = min ? Vector3.Minimize(min, meshMin) : meshMin.clone();
                max = max ? Vector3.Maximize(max, meshMax) : meshMax.clone();
            } catch (error) {
                console.warn(`[Viewer] Skipping mesh with unavailable bounds: ${mesh.name}`, error);
            }
        }

        if (!min || !max || max.x < min.x || max.y < min.y || max.z < min.z) {
            return null;
        }

        return { min, max };
    }

    /** Axis-aligned bounds after applying nav-PLY euler about the box center. */
    private boundsAfterNavRotation(
        bounds: { min: Vector3; max: Vector3 },
        euler: { x: number; y: number; z: number }
    ): { min: Vector3; max: Vector3 } {
        const center = bounds.min.add(bounds.max).scale(0.5);
        const matrix = Matrix.RotationYawPitchRoll(euler.y, euler.x, euler.z);
        const xs = [bounds.min.x, bounds.max.x];
        const ys = [bounds.min.y, bounds.max.y];
        const zs = [bounds.min.z, bounds.max.z];

        let minOut: Vector3 | null = null;
        let maxOut: Vector3 | null = null;

        for (const x of xs) {
            for (const y of ys) {
                for (const z of zs) {
                    const corner = new Vector3(x, y, z).subtract(center);
                    const rotated = Vector3.TransformCoordinates(corner, matrix).add(center);
                    minOut = minOut ? Vector3.Minimize(minOut, rotated) : rotated.clone();
                    maxOut = maxOut ? Vector3.Maximize(maxOut, rotated) : rotated.clone();
                }
            }
        }

        return { min: minOut!, max: maxOut! };
    }

    private getLoadedSplatLocalBounds(): { min: Vector3; max: Vector3 } | null {
        if (!this.splatMesh && this.splatMeshes.length === 0) {
            return null;
        }
        return this.mergeMeshBounds(this.collectLoadedSplatMeshes(), 'local');
    }

    private getLoadedSplatBounds(): { min: Vector3, max: Vector3 } | null {
        if (!this.splatMesh && this.splatMeshes.length === 0) {
            return null;
        }
        return this.mergeMeshBounds(this.collectLoadedSplatMeshes(), 'world');
    }

    public enableRegionSelection(region?: { min: number[], max: number[] }): void {
        const scene = this.scene;

        if (!this.selectionMesh) {
            this.selectionMesh = Mesh.CreateBox("selection_region", 1, scene);

            const mat = new StandardMaterial("selection_mat", scene);
            mat.diffuseColor = new Color3(1, 1, 0); // Yellow
            mat.alpha = 0.2;
            mat.backFaceCulling = false;
            this.selectionMesh.material = mat;
            this.selectionMesh.isPickable = true;
        }

        const rawBounds = region ? {
            min: [region.min[0], region.min[1], region.min[2]],
            max: [region.max[0], region.max[1], region.max[2]],
        } : (() => {
            const splat = this.getLoadedSplatBounds();
            if (!splat) {
                return null;
            }
            return {
                min: [splat.min.x, splat.min.y, splat.min.z],
                max: [splat.max.x, splat.max.y, splat.max.z],
            };
        })();

        if (rawBounds) {
            const volume = ensureRegionSelectionVolume(rawBounds);
            const size = regionSelectionSize(volume);

            this.selectionMesh.scaling.set(size.x, size.y, size.z);
            this.selectionMesh.position.set(
                (volume.min[0] + volume.max[0]) / 2,
                (volume.min[1] + volume.max[1]) / 2,
                (volume.min[2] + volume.max[2]) / 2
            );

            console.log(
                `[Viewer] Region selector volume ` +
                `min=${volume.min.map((v) => v.toFixed(2)).join(',')} ` +
                `max=${volume.max.map((v) => v.toFixed(2)).join(',')} ` +
                `size=${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}`
            );
        } else {
            this.selectionMesh.scaling.set(5, MIN_REGION_HEIGHT_METERS, 5);
            const fallbackTarget = this._isFlyCamera
                ? (this.camera as FreeCamera).target
                : (this.camera as ArcRotateCamera).target;
            this.selectionMesh.position.copyFrom(fallbackTarget);
            console.warn("[Viewer] Could not determine splat bounds. Region selector placed at camera target.");
        }

        // Setup Gizmos
        if (!this.gizmoManager) {
            this.gizmoManager = new GizmoManager(scene);
        }
        this.gizmoManager.positionGizmoEnabled = true;
        this.gizmoManager.scaleGizmoEnabled = true;
        this.gizmoManager.rotationGizmoEnabled = false;
        this.gizmoManager.attachableMeshes = [this.selectionMesh];
        this.gizmoManager.attachToMesh(this.selectionMesh);

        console.log("[Viewer] Region selection enabled (drag to move, scale handles for size/height)");
    }

    public disableRegionSelection(): void {
        const hadRegionSelection = Boolean(this.gizmoManager || this.selectionMesh);

        if (this.gizmoManager) {
            this.gizmoManager.dispose();
            this.gizmoManager = null;
        }
        if (this.selectionMesh) {
            this.selectionMesh.dispose();
            this.selectionMesh = null;
        }
        if (hadRegionSelection) {
            console.log("[Viewer] Region selection disabled");
        }
    }

    public getRegionBounds(): { min: number[], max: number[] } | null {
        if (!this.selectionMesh) return null;

        this.selectionMesh.computeWorldMatrix(true);
        const boundingBox = this.selectionMesh.getBoundingInfo().boundingBox;
        const min = boundingBox.minimumWorld;
        const max = boundingBox.maximumWorld;

        return {
            min: [min.x, min.y, min.z],
            max: [max.x, max.y, max.z]
        };
    }

    /**
     * When nav PLY rotation matches the stream visual, WASM `splatwalk_oriented` vertices
     * already coincide with Babylon world space (`streamWorld * raw = env * R * flip(raw)`).
     */
    private usesOrientedWorldIdentity(): boolean {
        return !this._navRotationDecoupledFromVisual;
    }

    /**
     * Maps nav-PLY / WASM oriented coords into Babylon world when stream visual rotation
     * is decoupled. Returns null when oriented == world (identity).
     */
    private buildNavOrientedToWorldMatrix(): Matrix | null {
        if (this.usesOrientedWorldIdentity()) {
            return null;
        }
        const visual = Matrix.RotationYawPitchRoll(
            this._streamVisualRotation.y,
            this._streamVisualRotation.x,
            this._streamVisualRotation.z
        );
        const nav = Matrix.RotationYawPitchRoll(
            this.rotation.y,
            this.rotation.x,
            this.rotation.z
        );
        const navInv = Matrix.Invert(nav);
        if (!navInv) {
            return null;
        }
        return visual.multiply(navInv);
    }

    /**
     * Selection-region AABB in `splatwalk_oriented` space for WASM `region_min` / `region_max`.
     * When nav rotation matches the stream, oriented == world and the yellow box passes through.
     */
    public getWasmRegionBounds(): { min: number[]; max: number[] } | null {
        const world = this.getRegionBounds();
        if (!world) {
            return null;
        }

        if (this.usesOrientedWorldIdentity()) {
            return {
                min: [...world.min],
                max: [...world.max],
            };
        }

        const worldToOriented = this.buildWorldToWasmOrientedMatrix();
        if (!worldToOriented) {
            return {
                min: [...world.min],
                max: [...world.max],
            };
        }

        return Viewer.transformAabbByMatrix(world, worldToOriented);
    }

    /** Maps Babylon world → WASM oriented (inverse of {@link buildNavOrientedToWorldMatrix}). */
    private buildWorldToWasmOrientedMatrix(): Matrix | null {
        const orientedToWorld = this.buildNavOrientedToWorldMatrix();
        if (!orientedToWorld) {
            return Matrix.Identity();
        }
        return Matrix.Invert(orientedToWorld);
    }

    public orientedNavPointToWorld(point: Vector3): Vector3 {
        const matrix = this.buildNavOrientedToWorldMatrix();
        if (!matrix) {
            return point.clone();
        }
        return Vector3.TransformCoordinates(point, matrix);
    }

    public worldNavPointToOriented(point: Vector3): Vector3 {
        if (this.usesOrientedWorldIdentity()) {
            return point.clone();
        }
        const matrix = this.buildWorldToWasmOrientedMatrix();
        if (!matrix) {
            return point.clone();
        }
        return Vector3.TransformCoordinates(point, matrix);
    }

    /** True when a Babylon world point lies inside the loaded splat AABB (with padding). */
    private isWorldPointInsideSplatBounds(world: Vector3, paddingMeters = 0.25): boolean {
        const bounds = this.getLoadedSplatBounds();
        if (!bounds) {
            return true;
        }
        return (
            world.x >= bounds.min.x - paddingMeters
            && world.x <= bounds.max.x + paddingMeters
            && world.y >= bounds.min.y - paddingMeters
            && world.y <= bounds.max.y + paddingMeters
            && world.z >= bounds.min.z - paddingMeters
            && world.z <= bounds.max.z + paddingMeters
        );
    }

    /**
     * Ensures crowd spawn sits inside the splat volume in world space. Falls back to the
     * nearest Recast point when oriented spawn drifts outside (coordinate mismatch guard).
     */
    private resolveValidatedOrientedSpawn(orientedSpawn: Vector3): Vector3 {
        const world = this.orientedNavPointToWorld(orientedSpawn);
        if (this.isWorldPointInsideSplatBounds(world)) {
            return orientedSpawn;
        }

        if (this.navMeshQuery) {
            const snapped = this.navMeshQuery.findClosestPoint(
                { x: orientedSpawn.x, y: orientedSpawn.y, z: orientedSpawn.z },
                { halfExtents: { x: 5, y: 8, z: 5 } }
            );
            if (snapped.success && snapped.point) {
                const snappedOriented = new Vector3(snapped.point.x, snapped.point.y, snapped.point.z);
                const snappedWorld = this.orientedNavPointToWorld(snappedOriented);
                if (this.isWorldPointInsideSplatBounds(snappedWorld)) {
                    console.warn(
                        `[WARN] Spawn outside splat bounds at world ${world.toString()} — ` +
                        `snapped to navmesh at ${snappedWorld.toString()}.`
                    );
                    return snappedOriented;
                }
            }
        }

        console.warn(
            `[WARN] Spawn outside splat bounds at world ${world.toString()} — using oriented point anyway.`
        );
        return orientedSpawn;
    }

    private transformOrientedPositionsToWorld(positions: Float32Array | readonly number[]): Float32Array {
        const src = positions instanceof Float32Array ? positions : Float32Array.from(positions);
        const matrix = this.buildNavOrientedToWorldMatrix();
        if (!matrix) {
            return src;
        }
        const out = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
            const world = Vector3.TransformCoordinates(new Vector3(src[i]!, src[i + 1]!, src[i + 2]!), matrix);
            out[i] = world.x;
            out[i + 1] = world.y;
            out[i + 2] = world.z;
        }
        return out;
    }

    private closestOrientedPointOnNavGeometry(
        positions: Float32Array,
        indices: Uint32Array,
        target: Vector3
    ): Vector3 | null {
        if (indices.length < 3) {
            return null;
        }
        let best: Vector3 | null = null;
        let bestDistSq = Infinity;
        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i]! * 3;
            const i1 = indices[i + 1]! * 3;
            const i2 = indices[i + 2]! * 3;
            const cx = (positions[i0]! + positions[i1]! + positions[i2]!) / 3;
            const cy = (positions[i0 + 1]! + positions[i1 + 1]! + positions[i2 + 1]!) / 3;
            const cz = (positions[i0 + 2]! + positions[i1 + 2]! + positions[i2 + 2]!) / 3;
            const dx = cx - target.x;
            const dy = cy - target.y;
            const dz = cz - target.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                best = new Vector3(cx, cy, cz);
            }
        }
        return best;
    }

    private resolveOrientedNavSpawn(
        positions: Float32Array,
        indices: Uint32Array,
        seedOriented?: number[] | null
    ): Vector3 | null {
        if (seedOriented && seedOriented.length >= 3) {
            const seed = new Vector3(seedOriented[0]!, seedOriented[1]!, seedOriented[2]!);
            const snapped = this.closestOrientedPointOnNavGeometry(positions, indices, seed);
            if (snapped) {
                return snapped;
            }
        }
        return this.getMostInteriorNavMeshPoint(positions, indices)
            ?? this.getFirstNavMeshPoint(positions, indices);
    }

    /**
     * Selection-region AABB in raw PlayCanvas / SOG coordinates (lod-meta tree space).
     * Used to materialize full-density finest-LOD chunks overlapping the pinned box.
     */
    public getRawSogRegionBounds(): { min: number[]; max: number[] } | null {
        const world = this.getRegionBounds();
        if (!world) {
            return null;
        }

        const mesh = this.splatMesh ?? this.splatMeshes[0];
        if (!mesh) {
            return null;
        }

        mesh.computeWorldMatrix(true);
        const raw = worldRegionToRawSogBounds(world, mesh.getWorldMatrix());
        return {
            min: [...raw.min],
            max: [...raw.max],
        };
    }

    private static transformAabbByMatrix(
        bounds: { min: number[]; max: number[] },
        matrix: Matrix
    ): { min: number[]; max: number[] } {
        const xs = [bounds.min[0], bounds.max[0]];
        const ys = [bounds.min[1], bounds.max[1]];
        const zs = [bounds.min[2], bounds.max[2]];
        let minOut: Vector3 | null = null;
        let maxOut: Vector3 | null = null;

        for (const x of xs) {
            for (const y of ys) {
                for (const z of zs) {
                    const corner = Vector3.TransformCoordinates(new Vector3(x, y, z), matrix);
                    minOut = minOut ? Vector3.Minimize(minOut, corner) : corner.clone();
                    maxOut = maxOut ? Vector3.Maximize(maxOut, corner) : corner.clone();
                }
            }
        }

        return {
            min: [minOut!.x, minOut!.y, minOut!.z],
            max: [maxOut!.x, maxOut!.y, maxOut!.z],
        };
    }

    /**
     * Scale the region selection box about the origin by `ratio` so it stays
     * aligned when the environment scale changes.
     */
    public scaleRegionSelection(ratio: number): void {
        if (!this.selectionMesh || !Number.isFinite(ratio) || ratio === 1) {
            return;
        }
        this.selectionMesh.position.scaleInPlace(ratio);
        this.selectionMesh.scaling.scaleInPlace(ratio);
        this.selectionMesh.computeWorldMatrix(true);
    }

    public async loadColliderMesh(file: File, opacity = 0.35): Promise<{ positions: Float32Array, indices: Uint32Array }> {
        this.clearColliderMesh();
        const result = await SceneLoader.ImportMeshAsync("", "", file, this.scene);
        this.colliderMeshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
        if (this.colliderMeshes.length === 0) {
            throw new Error("Imported collider GLB has no usable mesh geometry.");
        }
        this._colliderNeedsEnvironmentScale = true;

        this.colliderMaterial = new StandardMaterial("collider_mesh_mat", this.scene);
        this.colliderMaterial.diffuseColor = new Color3(0.0, 0.85, 1.0);
        this.applyAlphaOpacity(this.colliderMaterial, opacity);
        this.colliderMaterial.backFaceCulling = false;

        for (const mesh of this.colliderMeshes) {
            mesh.material = this.colliderMaterial;
            this.prepareOverlayMesh(mesh, this.colliderMaterial, { pickable: true, liftY: 0.03 });
        }
        this.applyEnvironmentScaleToMeshes();

        const geometry = this.getColliderMeshBuffers();
        const bounds = this.getColliderBounds();
        console.log(
            `[Viewer] Collider GLB imported: ${geometry.positions.length / 3} vertices, ` +
            `${geometry.indices.length / 3} triangles` +
            (bounds ? `, bounds min=${bounds.min.toString()} max=${bounds.max.toString()}` : "")
        );
        return geometry;
    }

    public displayColliderMesh(positions: Float32Array | number[], indices: Uint32Array | number[], opacity = 0.35): void {
        this.clearColliderMesh();
        // WASM bake already includes environment_scale in vertex positions.
        this._colliderNeedsEnvironmentScale = false;
        const worldPositions = this.transformOrientedPositionsToWorld(
            positions instanceof Float32Array ? positions : Float32Array.from(positions)
        );
        const mesh = new Mesh("collider_mesh_generated", this.scene);
        const vertexData = new VertexData();
        vertexData.positions = Array.from(worldPositions);
        vertexData.indices = Array.from(indices);
        vertexData.applyToMesh(mesh);

        this.colliderMaterial = new StandardMaterial("collider_mesh_mat", this.scene);
        this.colliderMaterial.diffuseColor = new Color3(0.0, 0.85, 1.0);
        this.applyAlphaOpacity(this.colliderMaterial, opacity);
        this.colliderMaterial.backFaceCulling = false;
        this.prepareOverlayMesh(mesh, this.colliderMaterial, { pickable: true, liftY: 0.03 });
        this.colliderMeshes = [mesh];
    }

    public clearColliderMesh(): void {
        for (const mesh of this.colliderMeshes) {
            mesh.dispose();
        }
        this.colliderMeshes = [];
        this._colliderNeedsEnvironmentScale = false;
        if (this.colliderMaterial) {
            this.colliderMaterial.dispose();
            this.colliderMaterial = null;
        }
    }

    public setColliderVisible(visible: boolean): void {
        for (const mesh of this.colliderMeshes) {
            mesh.isVisible = visible;
        }
    }

    /** Freeze streamed SOG LOD for the nav session (static explore, no decode thrash). */
    public startNavSessionRuntime(stream?: GaussianSplattingStream | null): void {
        this.stopNavSessionRuntime();
        this.navSessionRuntime = new NavSessionRuntimeController({
            onLog: (message) => console.log(message),
            scene: this.scene,
        });
        this.navSessionRuntime.attach(stream ?? findGaussianStreamInScene(this.scene));
    }

    public stopNavSessionRuntime(): void {
        if (!this.navSessionRuntime) {
            return;
        }
        this.navSessionRuntime.dispose();
        this.navSessionRuntime = null;
    }

    public setColliderOpacity(opacity: number): void {
        if (this.colliderMaterial) {
            this.applyAlphaOpacity(this.colliderMaterial, opacity);
        }
    }

    public setNavMeshVisible(visible: boolean): void {
        if (!this.navMeshDebugMesh) {
            return;
        }
        this.navMeshDebugMesh.setEnabled(visible);
        this.navMeshDebugMesh.isPickable = visible;
    }

    public setNavMeshOpacity(opacity: number): void {
        if (this.navMeshMaterial) {
            this.applyAlphaOpacity(this.navMeshMaterial, opacity);
        }
    }

    /** Latest Detour binary (updated after editor rebake). */
    public getNavMeshData(): Uint8Array | null {
        return this._navMeshData;
    }

    public setNavMeshData(data: Uint8Array | null): void {
        this._navMeshData = data ? new Uint8Array(data) : null;
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
        this.ensureNavMeshEditor();
        return this._navMeshEditor!.onStatus(listener);
    }

    /**
     * Fired after an editor rebake updates Detour + overlay buffers.
     * Hosts should refresh session navMeshData / NavKit artifact bundles here.
     */
    public onEditedNavMeshRebake(
        listener: (
            result: NavMeshEditorRebakeResult
        ) => void | Promise<void>
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
            if (this.userAgent) {
                this.userAgent.resetMoveTarget();
            }
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

    private ensureNavMeshEditor(): void {
        if (this._navMeshEditor) {
            return;
        }
        this._navMeshEditor = new NavMeshEditorBabylon({
            scene: this.scene,
            getOrientedNavMeshBuffers: () => this.getOrientedNavMeshBuffers(),
            refreshNavMeshOverlayFromOriented: (positions, indices, options) => {
                void this.refreshNavMeshOverlayFromOriented(
                    positions,
                    indices,
                    options
                );
            },
            applyEditedNavMeshRebake: (result) => this.applyEditedNavMeshRebake(result),
            orientedPointToWorld: (p) =>
                this.orientedNavPointToWorld(new Vector3(p.x, p.y, p.z)),
            worldPointToOriented: (p) => {
                const o = this.worldNavPointToOriented(p);
                return { x: o.x, y: o.y, z: o.z };
            },
        });
    }

    public async refreshNavMeshOverlayFromOriented(
        positions: Float32Array,
        indices: Uint32Array,
        options?: { readonly topologyChanged?: boolean }
    ): Promise<void> {
        this._orientedNavPositions = new Float32Array(positions);
        this._orientedNavIndices = new Uint32Array(indices);
        const topologyChanged = options?.topologyChanged !== false;
        const canUpdateInPlace =
            !topologyChanged &&
            this.navMeshDebugMesh &&
            !this.navMeshDebugMesh.isDisposed() &&
            this.navMeshDebugMesh.getTotalVertices() ===
                Math.floor(positions.length / 3);
        if (canUpdateInPlace && this.navMeshDebugMesh) {
            const worldPositions = this.transformOrientedPositionsToWorld(positions);
            this.navMeshDebugMesh.updateVerticesData(
                VertexBuffer.PositionKind,
                worldPositions,
                false,
                false
            );
            this.navMeshDebugMesh.refreshBoundingInfo();
            return;
        }
        const lift = this._navMeshOverlayLiftY;
        const offsetY = this.navMeshVisualOffset.y - lift;
        await this.displayNavMesh(positions, indices, offsetY, null, lift);
    }

    public async applyEditedNavMeshRebake(
        result: NavMeshEditorRebakeResult
    ): Promise<void> {
        const pose = this.capturePlayerPose();
        this._navMeshData = new Uint8Array(result.navMeshData);
        this._orientedNavPositions = new Float32Array(result.debugPositions);
        this._orientedNavIndices = new Uint32Array(result.debugIndices);
        const lift = this._navMeshOverlayLiftY;
        const offsetY = this.navMeshVisualOffset.y - lift;
        await this.displayNavMesh(
            result.debugPositions,
            result.debugIndices,
            offsetY,
            null,
            lift
        );
        await this.initCrowd(result.navMeshData, pose?.position ?? null);
        if (pose) {
            this.teleportPlayerTo({
                position: pose.position,
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

    private capturePlayerPose(): {
        position: Vector3;
        yawDegrees: number;
    } | null {
        if (!this.userAgent) {
            return null;
        }
        const p = this.userAgent.position();
        return {
            position: new Vector3(p.x, p.y, p.z),
            yawDegrees: (this._playerYawRadians * 180) / Math.PI,
        };
    }

    private applyAlphaOpacity(material: StandardMaterial, alpha: number): void {
        material.alpha = alpha;
        material.transparencyMode = alpha < 1 ? Material.MATERIAL_ALPHABLEND : Material.MATERIAL_OPAQUE;
    }

    /**
     * Draw translucent helpers above {@link GaussianSplattingStream} / splat meshes.
     * Group 0 holds the stream; group 1 draws after without clearing depth so the
     * overlay composites on top (otherwise dense splat depth fully occludes green nav).
     */
    private prepareOverlayMesh(
        mesh: AbstractMesh,
        material: StandardMaterial,
        options: { liftY?: number; pickable: boolean }
    ): void {
        const overlayGroup = 1;
        this.scene.setRenderingAutoClearDepthStencil(overlayGroup, false, false, false);
        mesh.renderingGroupId = overlayGroup;
        mesh.isPickable = options.pickable;
        mesh.material = material;
        material.disableDepthWrite = true;
        material.zOffset = -2;
        if (options.liftY !== undefined && options.liftY !== 0) {
            mesh.position.y += options.liftY;
        }
    }

    public getColliderBounds(): { min: Vector3, max: Vector3 } | null {
        if (this.colliderMeshes.length === 0) return null;
        let min: Vector3 | null = null;
        let max: Vector3 | null = null;

        for (const mesh of this.colliderMeshes) {
            if (mesh.getTotalVertices() === 0) continue;
            mesh.computeWorldMatrix(true);
            const box = mesh.getBoundingInfo().boundingBox;
            min = min ? Vector3.Minimize(min, box.minimumWorld) : box.minimumWorld.clone();
            max = max ? Vector3.Maximize(max, box.maximumWorld) : box.maximumWorld.clone();
        }

        return min && max ? { min, max } : null;
    }

    public getSplatBoundsForDiagnostics(): { min: Vector3, max: Vector3 } | null {
        return this.getLoadedSplatBounds();
    }

    public getColliderMeshBuffers(): { positions: Float32Array, indices: Uint32Array } {
        const positions: number[] = [];
        const indices: number[] = [];

        for (const mesh of this.colliderMeshes) {
            const sourcePositions = mesh.getVerticesData("position");
            if (!sourcePositions || sourcePositions.length === 0) {
                continue;
            }

            mesh.computeWorldMatrix(true);
            const world = mesh.getWorldMatrix();
            const base = positions.length / 3;

            for (let i = 0; i < sourcePositions.length; i += 3) {
                const p = Vector3.TransformCoordinates(
                    new Vector3(sourcePositions[i], sourcePositions[i + 1], sourcePositions[i + 2]),
                    world
                );
                positions.push(p.x, p.y, p.z);
            }

            const sourceIndices = mesh.getIndices();
            if (sourceIndices && sourceIndices.length > 0) {
                for (const index of sourceIndices) {
                    indices.push(base + index);
                }
            } else {
                for (let i = 0; i + 2 < sourcePositions.length / 3; i += 3) {
                    indices.push(base + i, base + i + 1, base + i + 2);
                }
            }
        }

        if (positions.length === 0 || indices.length === 0) {
            throw new Error("Collider mesh has no triangulated geometry for Recast.");
        }

        return {
            positions: new Float32Array(positions),
            indices: new Uint32Array(indices),
        };
    }

    public displaySeedMarker(seed: [number, number, number] | number[]): void {
        const world = this.orientedNavPointToWorld(Vector3.FromArray(seed));
        this.displaySeedMarkerWorld([world.x, world.y, world.z]);
        console.log(
            `[INFO] Seed marker placed at world ${world.toString()} (oriented ${seed.map((v) => Number(v).toFixed(3)).join(', ')})`
        );
    }

    /** Place SEED marker at an already-world position (e.g. voxel-walk feet). */
    public displaySeedMarkerWorld(world: readonly [number, number, number] | number[]): void {
        if (this.seedMarker) {
            this.seedMarker.dispose();
            this.seedMarker = null;
        }

        this.seedMarker = Mesh.CreateSphere("collision_seed_marker", 16, 0.25, this.scene);
        this.seedMarker.position.set(world[0]!, world[1]!, world[2]!);
        const mat = new StandardMaterial("collision_seed_marker_mat", this.scene);
        mat.diffuseColor = new Color3(1.0, 0.0, 1.0);
        mat.emissiveColor = new Color3(0.5, 0.0, 0.5);
        this.seedMarker.material = mat;
        this.seedMarker.isPickable = false;
        this.attachMarkerLabel(this.seedMarker, "SEED", new Color3(1.0, 0.0, 1.0));
    }

    public getNavMeshSpawnOriented(): Vector3 | null {
        return this.navMeshSpawnPoint?.clone() ?? null;
    }

    public setPreferredNavSpawnPoints(player: [number, number, number] | number[] | null, npc?: [number, number, number] | number[] | null): void {
        // Stored in WASM oriented / Recast space (not Babylon world).
        this.preferredPlayerSpawn = player ? Vector3.FromArray(player) : null;
        this.preferredNpcSpawn = npc ? Vector3.FromArray(npc) : null;
    }

    private attachMarkerLabel(mesh: AbstractMesh, text: string, color: Color3): void {
        const label = Mesh.CreatePlane(`${mesh.name}_label`, 0.8, this.scene);
        // No mipmaps: with alpha testing, mipmap minification shrinks the thin
        // text's alpha below alphaCutOff when the label is small/far, making it
        // vanish at distance. Disabling mips keeps the text visible at any range.
        const texture = new DynamicTexture(`${mesh.name}_label_texture`, { width: 256, height: 96 }, this.scene, false);
        texture.hasAlpha = true;
        texture.drawText(text, null, 58, "bold 44px Arial", color.toHexString(), "transparent", true);

        const material = new StandardMaterial(`${mesh.name}_label_mat`, this.scene);
        material.diffuseTexture = texture;
        material.emissiveColor = color;
        // Render the label as ALPHA-TESTED opaque (cut out the text from a
        // transparent quad) rather than alpha-blended. Blended labels join the
        // transparent pass and get sorted against the Gaussian splat (which never
        // writes depth), so they pop in/out as the camera moves and float over
        // splat walls. Alpha test puts the label in the opaque pass: it writes
        // depth, so the splat depth-tests against it -> stable, and correctly
        // occluded when the player is behind splat geometry.
        material.useAlphaFromDiffuseTexture = true;
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
        material.alphaCutOff = 0.35;
        material.backFaceCulling = false;
        label.material = material;
        label.billboardMode = Mesh.BILLBOARDMODE_ALL;
        label.isPickable = false;
        label.parent = mesh;
        label.position.set(0, 0.9, 0);
        this.markerLabels.push(label);
    }

    public async displayNavMesh(
        positions: Float32Array,
        indices: Uint32Array,
        visualOffsetY = 0,
        seedOriented?: number[] | null,
        /** Green overlay lift; use 0 for voxel walk so feet align with solid tops. */
        overlayLiftY = 0.05
    ): Promise<Vector3 | null> {
        this.clearNavMeshOverlay();

        this._orientedNavPositions = new Float32Array(positions);
        this._orientedNavIndices = new Uint32Array(indices);
        this._navMeshOverlayLiftY = overlayLiftY;

        const orientedSpawn = this.resolveOrientedNavSpawn(positions, indices, seedOriented);
        this.navMeshSpawnPoint = orientedSpawn;
        const worldPositions = this.transformOrientedPositionsToWorld(positions);

        const mesh = new Mesh("navmesh_debug", this.scene);
        const vertexData = new VertexData();
        vertexData.positions = worldPositions;
        vertexData.indices = indices;
        vertexData.applyToMesh(mesh);
        mesh.position.y = visualOffsetY + overlayLiftY;

        const mat = new StandardMaterial("navmesh_mat", this.scene);
        mat.diffuseColor = new Color3(0, 1, 0);
        this.applyAlphaOpacity(mat, 0.55);
        mat.backFaceCulling = false;
        this.prepareOverlayMesh(mesh, mat, { pickable: true });

        this.navMeshDebugMesh = mesh;
        this.navMeshMaterial = mat;
        this.navMeshVisualOffset = new Vector3(0, visualOffsetY + overlayLiftY, 0);
        // navMeshSpawnPoint stays in oriented space for Recast crowd; callers get world coords.

        mesh.setEnabled(true);
        console.log(
            `[Viewer] Navmesh visualized${visualOffsetY !== 0 ? ` with Y offset ${visualOffsetY.toFixed(3)}` : ""} (overlay group 1)`
        );
        return orientedSpawn ? this.orientedNavPointToWorld(orientedSpawn) : null;
    }

    public displayGroundFieldOverlay(fieldResult: WalkableGroundFieldResult, visibleStates: Set<GroundFieldCellState>): void {
        this.clearGroundFieldOverlay();

        if (visibleStates.size === 0 || fieldResult.width === 0 || fieldResult.height === 0) {
            return;
        }

        const origin = Vector3.FromArray(fieldResult.basis.origin);
        const tangent = Vector3.FromArray(fieldResult.basis.tangent);
        const bitangent = Vector3.FromArray(fieldResult.basis.bitangent);
        const up = Vector3.FromArray(fieldResult.basis.up);
        const grouped = new Map<GroundFieldCellState, { positions: number[], indices: number[] }>();

        for (let row = 0; row < fieldResult.height; row++) {
            for (let col = 0; col < fieldResult.width; col++) {
                const idx = row * fieldResult.width + col;
                const cell = fieldResult.cells[idx];
                if (!cell || !visibleStates.has(cell.state)) {
                    continue;
                }

                const group = grouped.get(cell.state) ?? { positions: [], indices: [] };
                grouped.set(cell.state, group);

                const h = Number.isFinite(cell.height) ? cell.height : 0;
                const u0 = col * fieldResult.cell_size;
                const u1 = (col + 1) * fieldResult.cell_size;
                const v0 = row * fieldResult.cell_size;
                const v1 = (row + 1) * fieldResult.cell_size;
                const lift = up.scale(0.015);
                const p00 = origin.add(tangent.scale(u0)).add(bitangent.scale(v0)).add(up.scale(h)).add(lift);
                const p10 = origin.add(tangent.scale(u1)).add(bitangent.scale(v0)).add(up.scale(h)).add(lift);
                const p11 = origin.add(tangent.scale(u1)).add(bitangent.scale(v1)).add(up.scale(h)).add(lift);
                const p01 = origin.add(tangent.scale(u0)).add(bitangent.scale(v1)).add(up.scale(h)).add(lift);
                const base = group.positions.length / 3;

                for (const p of [p00, p10, p11, p01]) {
                    group.positions.push(p.x, p.y, p.z);
                }
                group.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
        }

        for (const [state, buffers] of grouped) {
            if (buffers.positions.length === 0) {
                continue;
            }

            const mesh = new Mesh(`ground_field_${state}`, this.scene);
            const vertexData = new VertexData();
            vertexData.positions = buffers.positions;
            vertexData.indices = buffers.indices;
            vertexData.applyToMesh(mesh);
            mesh.isPickable = false;

            const material = new StandardMaterial(`ground_field_${state}_mat`, this.scene);
            const { color, alpha } = this.getGroundFieldStateStyle(state);
            material.diffuseColor = color;
            material.alpha = alpha;
            material.backFaceCulling = false;
            mesh.material = material;
            this.groundFieldOverlayMeshes.push(mesh);
        }

        console.log(`[Viewer] Ground field overlay rendered for ${visibleStates.size} states.`);
    }

    public clearGroundFieldOverlay(): void {
        for (const mesh of this.groundFieldOverlayMeshes) {
            mesh.dispose();
        }
        this.groundFieldOverlayMeshes = [];
    }

    private getGroundFieldStateStyle(state: GroundFieldCellState): { color: Color3, alpha: number } {
        switch (state) {
            case 'walkable':
                return { color: new Color3(0.0, 0.9, 0.1), alpha: 0.42 };
            case 'filled':
                return { color: new Color3(1.0, 0.85, 0.0), alpha: 0.5 };
            case 'obstacle':
                return { color: new Color3(1.0, 0.0, 0.0), alpha: 0.55 };
            case 'height_variance':
                return { color: new Color3(1.0, 0.45, 0.0), alpha: 0.55 };
            case 'low_confidence':
                return { color: new Color3(0.45, 0.45, 0.45), alpha: 0.35 };
            case 'void':
                return { color: new Color3(0.02, 0.02, 0.02), alpha: 0.25 };
            case 'eroded':
                return { color: new Color3(0.0, 0.25, 1.0), alpha: 0.5 };
            case 'discarded_component':
                return { color: new Color3(0.55, 0.0, 0.9), alpha: 0.48 };
        }
    }

    public async initCrowd(navMeshData: Uint8Array, spawnPoint?: Vector3 | null): Promise<void> {
        await initRecast();

        this.destroyCrowdSimulation();
        this._navMeshData = new Uint8Array(navMeshData);

        const { navMesh } = importNavMesh(navMeshData);
        this.recastNavMesh = navMesh;
        this.navMeshQuery = new NavMeshQuery(navMesh);

        this.crowd = new Crowd(this.recastNavMesh, {
            maxAgents: 100,
            maxAgentRadius: 1.0
        });

        // Setup user agent — spawn in oriented Recast space; mesh sync maps to world.
        let orientedSpawn =
            this.preferredPlayerSpawn?.clone()
            ?? spawnPoint?.clone()
            ?? this.navMeshSpawnPoint?.clone();
        if (!orientedSpawn) {
            console.warn("[WARN] Cannot initialize crowd: no valid navmesh spawn point.");
            return;
        }

        orientedSpawn = this.resolveValidatedOrientedSpawn(orientedSpawn);

        this.userAgent = this.crowd.addAgent(orientedSpawn, {
            radius: 0.5,
            height: 2.0,
            maxAcceleration: 20.0,
            maxSpeed: 5.0,
        });

        this.userMesh = this.createPlayerMarkerMesh('user_agent');
        const userMat = new StandardMaterial("user_mat", this.scene);
        userMat.diffuseColor = new Color3(0, 0, 1);
        this.userMesh.material = userMat;
        this.syncPlayerMeshYaw();
        this.attachMarkerLabel(this.userMesh, "PLAYER", new Color3(0.1, 0.5, 1.0));
        this.syncAgentMesh(this.userMesh, this.userAgent);
        const spawnWorld = this.orientedNavPointToWorld(orientedSpawn);
        console.log(
            `[INFO] Player agent spawned at world ${spawnWorld.toString()} ` +
            `(oriented ${orientedSpawn.x.toFixed(3)}, ${orientedSpawn.y.toFixed(3)}, ${orientedSpawn.z.toFixed(3)}).`
        );

        // Click-to-move: pick green navmesh overlay (gated by Controls mode).
        this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type !== PointerEventTypes.POINTERTAP || !this.userAgent) {
                return;
            }
            if (this.isNavMeshEditorEnabled()) {
                return;
            }
            if (!controlsModeAllowsClick(this._controlsMode)) {
                return;
            }

            const pickResult = this.scene.pick(
                this.scene.pointerX,
                this.scene.pointerY,
                (mesh) => mesh === this.navMeshDebugMesh
            );
            if (!pickResult?.hit || !pickResult.pickedPoint) {
                return;
            }

            const picked = pickResult.pickedPoint.subtract(this.navMeshVisualOffset);
            const target = this.worldNavPointToOriented(picked);
            // Face toward target in place first; start pathing only after arrive.
            this.userAgent.resetMoveTarget();
            const pos = this.userAgent.position();
            const clickYaw = yawTowardPoint(pos, {
                x: target.x,
                y: target.y,
                z: target.z,
            });
            if (clickYaw === null) {
                this._pendingClickFaceYaw = null;
                this._pendingClickMoveTarget = null;
                this.userAgent.requestMoveTarget(target);
            } else {
                this._pendingClickFaceYaw = clickYaw;
                this._pendingClickMoveTarget = target.clone();
            }
            this._suppressTravelFacingUntilInput = false;
            console.log(`[Viewer] User move target: ${target.toString()}`);
        });

        this._wasdKeys.attach();
        this.setControlsMode(this._controlsMode);

        // Update loop for crowd + WASDQE + click travel facing
        this.crowdUpdateObserver = this.scene.onBeforeRenderObservable.add(() => {
            if (this.crowd) {
                if (this.navSessionRuntime?.shouldSkipCrowdUpdate()) {
                    return;
                }
                const delta = this.engine.getDeltaTime() / 1000;
                const wasdSample = this._wasdKeys.sample();
                const wasdActive = isPlayerWasdSampleActive(wasdSample);
                this.tickPlayerWasd(delta, wasdSample);
                this.crowd.update(delta);

                if (this.userMesh && this.userAgent) {
                    if (wasdActive) {
                        this._pendingClickFaceYaw = null;
                        this._pendingClickMoveTarget = null;
                        this._suppressTravelFacingUntilInput = false;
                    } else if (
                        !this._suppressTravelFacingUntilInput &&
                        controlsModeAllowsClick(this._controlsMode)
                    ) {
                        const velocity = this.userAgent.velocity();
                        const position = this.userAgent.position();
                        let nextTarget: { x: number; y: number; z: number } | null =
                            null;
                        try {
                            nextTarget = this.userAgent.nextTargetInPath();
                        } catch {
                            nextTarget = null;
                        }
                        const facing = travelFacingYawFromAgent({
                            velocity,
                            position,
                            nextTarget,
                            currentYaw: this._playerYawRadians,
                            dt: delta,
                            clickFaceYaw: this._pendingClickFaceYaw,
                        });
                        this._playerYawRadians = facing.yawRadians;
                        if (facing.clearClickFace) {
                            this._pendingClickFaceYaw = null;
                            const pending = this._pendingClickMoveTarget;
                            this._pendingClickMoveTarget = null;
                            if (pending) {
                                this.userAgent.requestMoveTarget(pending);
                            }
                        }
                    }
                    this.syncAgentMesh(this.userMesh, this.userAgent);
                    this.syncPlayerMeshYaw();
                }

                for (let i = 0; i < this.npcMeshes.length; i++) {
                    const agent = this.npcAgents[i];
                    if (agent) {
                        this.syncAgentMesh(this.npcMeshes[i], agent);
                    }
                }
            }
        });

        console.log(
            '[SUCCESS] Crowd simulation initialized. Use Controls (click / WASDQE / both) to move the player.'
        );
    }

    private tickPlayerWasd(delta: number, sample: PlayerWasdSample): void {
        if (!this.userAgent || !controlsModeAllowsWasd(this._controlsMode)) {
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
        const pos = this.userAgent.position();
        const scale = PLAYER_WASD_LOOKAHEAD_METERS / len;
        const target = new Vector3(
            pos.x + moved.moveX * scale,
            pos.y,
            pos.z + moved.moveZ * scale
        );
        const snapped = this.resolveValidatedOrientedSpawn(target);
        this.userAgent.requestMoveTarget(snapped);
    }

    /**
     * Voxel walk — solid ray pick, XZ steer, downward ground probes, capsule slide.
     * @param preferredFeetWorld - Optional saved feet (world); used when still on a walkable floor cell.
     */
    public initVoxelWalk(
        volume: CollisionVoxelVolume,
        seedOriented: readonly [number, number, number] | number[],
        preferredFeetWorld?: readonly [number, number, number] | number[] | null
    ): Vector3 {
        this.destroyCrowdSimulation();

        const runtime = new VoxelWalkRuntime({
            agentHeight: 1.6,
            agentRadius: 0.2,
            stepUpMeters: 0.75,
            volume,
        });
        this.assertVolumeAlignedWithSplat(runtime);

        const seedWorld = this.orientedNavPointToWorld(
            new Vector3(seedOriented[0]!, seedOriented[1]!, seedOriented[2]!)
        );
        const preferred =
            preferredFeetWorld && preferredFeetWorld.length >= 3
                ? runtime.tryPreferredFeet([
                      preferredFeetWorld[0]!,
                      preferredFeetWorld[1]!,
                      preferredFeetWorld[2]!,
                  ])
                : null;
        const feet =
            preferred ??
            runtime.findCylinderSpawn([seedWorld.x, seedWorld.y, seedWorld.z]) ??
            runtime.findCylinderSpawn([seedOriented[0]!, seedOriented[1]!, seedOriented[2]!]) ??
            runtime.findCylinderSpawnAtVolumeCenter();
        if (!feet) {
            const hasRegion = Boolean(this.getWasmRegionBounds());
            throw new Error(
                hasRegion
                    ? 'Voxel walk: no cylinder spawn near collision seed. Tighten the yellow box onto open floor.'
                    : 'Voxel walk: no cylinder spawn in volume. Enable Selection region for large indoor ' +
                      'scenes (region OFF uses the full AABB and may coarsen).'
            );
        }

        this.voxelWalkController = new VoxelWalkController(runtime, feet);
        // Recast crowd sync uses navMeshVisualOffset; voxel walk places the cube on solid tops.
        this.navMeshVisualOffset = Vector3.Zero();
        this.displaySeedMarkerWorld(feet);

        this.userMesh = this.createPlayerMarkerMesh('user_agent');
        const userMat = new StandardMaterial('user_mat', this.scene);
        userMat.diffuseColor = new Color3(0, 0, 1);
        this.userMesh.material = userMat;
        this.syncPlayerMeshYaw();
        this.userMesh.position.set(feet[0], feet[1] + AGENT_HALF_HEIGHT, feet[2]);
        this.attachMarkerLabel(this.userMesh, 'PLAYER', new Color3(0.1, 0.5, 1.0));

        this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type !== PointerEventTypes.POINTERTAP || !this.userMesh || !this.voxelWalkController) {
                return;
            }

            const skipMeshes = new Set<AbstractMesh>();
            skipMeshes.add(this.userMesh);
            for (const label of this.markerLabels) {
                skipMeshes.add(label);
            }
            if (this.seedMarker) {
                skipMeshes.add(this.seedMarker);
            }
            if (this.selectionMesh) {
                skipMeshes.add(this.selectionMesh);
            }

            const hit = this.pickVoxelWalkGoal(this.voxelWalkController.getRuntime(), skipMeshes);
            if (!hit) {
                return;
            }

            // XZ navigate only — do not gate on isFloorCell (stairs may lack green overlay).
            this.voxelWalkController.navigateTo(hit);
            console.log(`[Viewer] Voxel walk goal: ${hit[0].toFixed(3)}, ${hit[1].toFixed(3)}, ${hit[2].toFixed(3)}`);
        });

        this.voxelWalkUpdateObserver = this.scene.onBeforeRenderObservable.add(() => {
            if (!this.userMesh || !this.voxelWalkController) {
                return;
            }
            const delta = this.engine.getDeltaTime() / 1000;
            const next = this.voxelWalkController.update(delta);
            this.userMesh.position.set(next[0], next[1] + AGENT_HALF_HEIGHT, next[2]);
        });

        console.log(
            `[SUCCESS] Voxel walk initialized at feet (${feet[0].toFixed(3)}, ${feet[1].toFixed(3)}, ${feet[2].toFixed(3)}) — ` +
            'click surfaces to walk (stairs via ground probes).'
        );
        return new Vector3(feet[0], feet[1], feet[2]);
    }

    /** Solid volume ray from the camera, else surface / green-mesh pick. */
    private pickVoxelWalkGoal(
        runtime: VoxelWalkRuntime,
        skipMeshes: ReadonlySet<AbstractMesh>
    ): [number, number, number] | null {
        const ray = this.scene.createPickingRay(
            this.scene.pointerX,
            this.scene.pointerY,
            null,
            this.camera,
            false
        );
        if (ray) {
            const hit = runtime.queryRay(
                [ray.origin.x, ray.origin.y, ray.origin.z],
                [ray.direction.x, ray.direction.y, ray.direction.z],
                VOXEL_WALK_CLICK_RAY_MAX
            );
            if (hit) {
                return hit.position;
            }
        }

        const surface =
            pickNavSurfacePoint({
                camera: this.camera,
                colliderMeshes: this.colliderMeshes,
                isSplatVisualMesh: (mesh) => this.isStreamVisualMesh(mesh),
                scene: this.scene,
                skipMeshes,
            }) ??
            pickNavDebugMeshPoint(this.scene, this.navMeshDebugMesh);

        if (!surface) {
            return null;
        }
        return [surface.x, surface.y, surface.z];
    }

    /**
     * Fail-fast when exported volume / seed sits outside the splat world AABB
     * (classic void-spawn / floating-overlay bug).
     */
    public assertVolumeAlignedWithSplat(runtime: VoxelWalkRuntime): void {
        const splat = this.getLoadedSplatBounds();
        if (!splat) {
            return;
        }
        const vol = runtime.worldAabb();
        const overlaps =
            vol.max[0] >= splat.min.x - 1 &&
            vol.min[0] <= splat.max.x + 1 &&
            vol.max[1] >= splat.min.y - 1 &&
            vol.min[1] <= splat.max.y + 1 &&
            vol.max[2] >= splat.min.z - 1 &&
            vol.min[2] <= splat.max.z + 1;
        if (!overlaps) {
            const mesh = this.splatMesh ?? this.splatMeshes[0];
            const scaleY = mesh?.scaling?.y ?? 1;
            const rot = this.getSplatRotation();
            const visual = this.getStreamVisualRotation();
            throw new Error(
                `Voxel volume AABB misses splat world bounds — transform mismatch. ` +
                `volume=[${vol.min.map((v) => v.toFixed(2)).join(',')}]→[${vol.max.map((v) => v.toFixed(2)).join(',')}] ` +
                `splat=[${splat.min.x.toFixed(2)},${splat.min.y.toFixed(2)},${splat.min.z.toFixed(2)}]→` +
                `[${splat.max.x.toFixed(2)},${splat.max.y.toFixed(2)},${splat.max.z.toFixed(2)}] ` +
                `flip_y=${this.getWasmFlipY()} env=${this.getEnvironmentScale()} ` +
                `navRot=[${rot.x.toFixed(3)},${rot.y.toFixed(3)},${rot.z.toFixed(3)}] ` +
                `streamRot=[${visual.x.toFixed(3)},${visual.y.toFixed(3)},${visual.z.toFixed(3)}] ` +
                `streamScaleY=${scaleY.toFixed(3)}`
            );
        }
    }

    public getVoxelPcWalkPlayerPosition(): Vector3 | null {
        return this.userMesh?.position.clone() ?? null;
    }

    /** World-space feet under the player box center, or null when no agent exists. */
    public getPlayerFeetWorld(): Vector3 | null {
        if (!this.userMesh) {
            return null;
        }
        const center = this.userMesh.position;
        return new Vector3(center.x, center.y - AGENT_HALF_HEIGHT, center.z);
    }

    public addNPC(): void {
        if (!this.crowd || !this.recastNavMesh) {
            console.warn("[WARN] Crowd not initialized; generate a navmesh before adding an NPC.");
            return;
        }

        const userPosition = this.userAgent?.position();
        const pos = this.preferredNpcSpawn?.clone()
            ?? (userPosition ? new Vector3(userPosition.x + 1.0, userPosition.y, userPosition.z) : this.navMeshSpawnPoint?.clone());
        if (!pos) {
            console.warn("[WARN] No valid navmesh point available for NPC spawn.");
            return;
        }
        if (userPosition) {
            const dx = pos.x - userPosition.x;
            const dz = pos.z - userPosition.z;
            if (Math.sqrt(dx * dx + dz * dz) < 0.25) {
                console.warn("[WARN] NPC spawn would overlap the player marker, so no NPC was spawned.");
                return;
            }
        }

        const agent = this.crowd.addAgent(pos, {
            radius: 0.5,
            height: 2.0,
            maxAcceleration: 10.0,
            maxSpeed: 3.0,
        });

        const npc = Mesh.CreateSphere(`npc_${agent.agentIndex}`, 16, 0.5, this.scene);
        const mat = new StandardMaterial(`npc_mat_${agent.agentIndex}`, this.scene);
        mat.diffuseColor = new Color3(0.2, 1.0, 0.35);
        mat.emissiveColor = new Color3(0.02, 0.25, 0.05);
        npc.material = mat;
        this.attachMarkerLabel(npc, "NPC", new Color3(0.2, 1.0, 0.35));
        this.syncAgentMesh(npc, agent);

        this.npcAgents.push(agent);
        this.npcMeshes.push(npc);
        this.preferredNpcSpawn = null;

        console.log(`[INFO] NPC spawned at ${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}.`);
    }

    // Pick the navmesh point deepest inside the walkable area (farthest from any
    // boundary edge in the floor plane). This keeps the player off walls/furniture
    // fringes and out in open floor, where it is clearly visible from above.
    private getMostInteriorNavMeshPoint(positions: Float32Array, indices: Uint32Array): Vector3 | null {
        if (indices.length < 3) {
            return null;
        }

        const quant = (value: number) => Math.round(value * 1000);
        const keyOf = (vi: number) => `${quant(positions[vi * 3])},${quant(positions[vi * 3 + 2])}`;

        // Count undirected edges by quantized XZ endpoints; boundary edges occur once.
        const edgeCount = new Map<string, { count: number; ax: number; az: number; bx: number; bz: number }>();
        const addEdge = (a: number, b: number) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const existing = edgeCount.get(key);
            if (existing) {
                existing.count += 1;
            } else {
                edgeCount.set(key, {
                    count: 1,
                    ax: positions[a * 3], az: positions[a * 3 + 2],
                    bx: positions[b * 3], bz: positions[b * 3 + 2],
                });
            }
        };

        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];
            addEdge(i0, i1);
            addEdge(i1, i2);
            addEdge(i2, i0);
        }

        const boundary: { ax: number; az: number; bx: number; bz: number }[] = [];
        for (const e of edgeCount.values()) {
            if (e.count === 1) {
                boundary.push(e);
            }
        }
        if (boundary.length === 0) {
            return null;
        }

        const distToSegmentXZ = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => {
            const dx = bx - ax;
            const dz = bz - az;
            const lenSq = dx * dx + dz * dz;
            let t = lenSq < 1e-12 ? 0 : ((px - ax) * dx + (pz - az) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const cx = ax + t * dx;
            const cz = az + t * dz;
            return Math.hypot(px - cx, pz - cz);
        };

        let best: Vector3 | null = null;
        let bestClearance = -Infinity;
        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;
            const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
            const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
            const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
            if (![cx, cy, cz].every(Number.isFinite)) {
                continue;
            }

            let clearance = Infinity;
            for (const e of boundary) {
                const d = distToSegmentXZ(cx, cz, e.ax, e.az, e.bx, e.bz);
                if (d < clearance) {
                    clearance = d;
                    if (clearance <= bestClearance) {
                        break;
                    }
                }
            }

            if (clearance > bestClearance) {
                bestClearance = clearance;
                best = new Vector3(cx, cy, cz);
            }
        }

        return best;
    }

    private getFirstNavMeshPoint(positions: Float32Array, indices: Uint32Array): Vector3 | null {
        const isUsablePoint = (point: Vector3): boolean => {
            return [point.x, point.y, point.z].every(Number.isFinite) && point.lengthSquared() > 1e-8;
        };

        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;
            const point = new Vector3(
                (positions[i0] + positions[i1] + positions[i2]) / 3,
                (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3,
                (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3
            );
            if (isUsablePoint(point)) {
                return point;
            }
        }

        for (let i = 0; i + 2 < positions.length; i += 3) {
            const point = new Vector3(positions[i], positions[i + 1], positions[i + 2]);
            if (isUsablePoint(point)) {
                return point;
            }
        }

        return null;
    }

    /** Blue player solid: triangular wedge, tip = forward (+Z at yaw 0). */
    private createPlayerMarkerMesh(name: string): Mesh {
        const mesh = new Mesh(name, this.scene);
        const { positions, indices } = playerMarkerWedgeBuffers();
        const normals = new Float32Array(positions.length);
        VertexData.ComputeNormals(positions, indices, normals);
        const vertexData = new VertexData();
        vertexData.positions = Array.from(positions);
        vertexData.indices = Array.from(indices);
        vertexData.normals = Array.from(normals);
        vertexData.applyToMesh(mesh);
        return mesh;
    }

    private syncAgentMesh(mesh: AbstractMesh, agent: CrowdAgent): void {
        const pos = agent.position();
        const oriented = new Vector3(pos.x, pos.y, pos.z);
        const world = this.orientedNavPointToWorld(oriented);
        mesh.position.set(
            world.x + this.navMeshVisualOffset.x,
            world.y + this.navMeshVisualOffset.y + AGENT_HALF_HEIGHT,
            world.z + this.navMeshVisualOffset.z
        );
    }

    /**
     * Apply oriented-space yaw to the player mesh (tip +Z at yaw 0).
     * `rotation.y = +yaw` matches WASD / NavKit `playerEulerDeg.y` (no sign flip).
     */
    private syncPlayerMeshYaw(): void {
        if (!this.userMesh) {
            return;
        }
        this.userMesh.rotation.y = this._playerYawRadians;
    }

    private cleanupCrowdObservers(): void {
        if (this.pointerObserver) {
            this.scene.onPointerObservable.remove(this.pointerObserver);
            this.pointerObserver = null;
        }
        if (this.crowdUpdateObserver) {
            this.scene.onBeforeRenderObservable.remove(this.crowdUpdateObserver);
            this.crowdUpdateObserver = null;
        }
        if (this.voxelWalkUpdateObserver) {
            this.scene.onBeforeRenderObservable.remove(this.voxelWalkUpdateObserver);
            this.voxelWalkUpdateObserver = null;
        }
        this.voxelWalkController = null;
    }

    private destroyCrowdSimulation(): void {
        this.cleanupCrowdObservers();
        this._wasdKeys.detach();

        if (this.crowd) {
            this.crowd.destroy();
            this.crowd = null;
        }
        if (this.recastNavMesh) {
            this.recastNavMesh.destroy();
            this.recastNavMesh = null;
        }
        this.navMeshQuery = null;

        this.userAgent = null;
        this.npcAgents = [];

        if (this.userMesh) {
            this.userMesh.dispose();
            this.userMesh = null;
        }
        for (const mesh of this.npcMeshes) {
            mesh.dispose();
        }
        this.npcMeshes = [];

        for (const label of this.markerLabels) {
            if (!label.isDisposed()) {
                label.dispose();
            }
        }
        this.markerLabels = [];
    }

    private resetDerivedSceneState(): void {
        this.stopNavSessionRuntime();
        this.destroyCrowdSimulation();
        if (this._navMeshEditor) {
            this._navMeshEditor.dispose();
            this._navMeshEditor = null;
        }
        this._orientedNavPositions = null;
        this._orientedNavIndices = null;
        this._navMeshData = null;

        if (this.seedMarker) {
            this.seedMarker.dispose();
            this.seedMarker = null;
        }

        this.preferredPlayerSpawn = null;
        this.preferredNpcSpawn = null;
        this.clearNavMeshOverlay();
        this.clearColliderMesh();
    }

    /** Strip nav/collision overlays and agents; keep splat / stream visual loaded. */
    public clearNavArtifacts(): void {
        this.disableRegionSelection();
        this.resetDerivedSceneState();
    }

    private clearNavMeshOverlay(): void {
        if (this.navMeshDebugMesh) {
            this.navMeshDebugMesh.dispose();
            this.navMeshDebugMesh = null;
        }
        const old = this.scene.getMeshByName("navmesh_debug");
        if (old) {
            old.dispose();
        }
        if (this.navMeshMaterial) {
            this.navMeshMaterial.dispose();
            this.navMeshMaterial = null;
        }
        this.navMeshSpawnPoint = null;
        this.navMeshVisualOffset = Vector3.Zero();
    }

    public getScene(): Scene {
        return this.scene;
    }
}
