import { computed, onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

import type { FreeCamera, Scene } from '@babylonjs/core';
import { Engine } from '@babylonjs/core/Engines/engine';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { FreeCamera as FreeCameraCtor } from '@babylonjs/core/Cameras/freeCamera';
import { Color3, Vector3 } from '@babylonjs/core/Maths/math';
import { Scene as BabylonScene } from '@babylonjs/core/scene';
import type { ISOGLODMetadata } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';
import '@babylonjs/loaders/SPLAT';

import {
  buildCollisionBoundarySettings,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
  seedFromRegionBounds,
} from '@/collision/voxelBoundary';
import {
  runFastNav,
  STREAMED_FAST_NAV_RECAST_ATTEMPTS,
  type FastNavPhase,
} from '@/navigation/fastNav';
import {
  DEFAULT_FAST_NAV_RECOVERY,
  FAST_NAV_PRESET,
  type FastNavRecoveryConfig,
} from '@/navigation/floor';
import {
  DEFAULT_STREAMED_NAV_SETTINGS,
  demoNavSettingsToFastNavTuning,
  type StreamedNavSettings,
} from '@/navigation/navSettings';
import { Viewer } from '@/scene/Viewer';
import {
  DEFAULT_NAV_MAX_SPLATS,
  DEFAULT_NAV_MIN_SPLATS,
  deriveLodMetaRootUrl,
  materializeNavSourceFromStreamedSog,
  type StreamedBundleAccess,
} from '@/storage/materializeNavSourceFromStreamedSog';
import {
  loadCdnLodMeta,
  loadLocalSogZip,
  type SogLodManifestSummary,
} from '@/storage/sogStreamLoader';
import {
  applyStreamQualityPreset,
  DEFAULT_STREAM_SETTINGS,
  formatStreamBudgetLog,
  streamQualityPresetResidentSplats,
  type StreamQualityPreset,
  type StreamSettings,
} from '@/storage/streamMemoryBudget';
import {
  assertStreamEnvironmentLoaded,
  awaitStreamResidencyReport,
  ensureActiveCameraForStream,
  installBudgetSkipLogger,
  type StreamResidencyStats,
} from '@/storage/streamResidency';
import { splatwalk } from '@/wasm/bridge';

export type StorageDemoSource = 'cdn' | 'local';
export type { StreamQualityPreset, StreamSettings };

export type StorageDemoNavPhase = FastNavPhase | 'idle' | 'materialize' | 'error';

export type { StreamedNavSettings };
export { DEFAULT_STREAMED_NAV_SETTINGS };

export interface UseStorageAdapterDemo {
  readonly busy: Ref<boolean>;
  readonly clear: () => void;
  readonly clearNavArtifacts: () => void;
  readonly debugShowingNavPly: Ref<boolean>;
  readonly errorMessage: Ref<string | null>;
  readonly fileCount: Ref<number | null>;
  readonly generateCollision: () => Promise<void>;
  readonly hasNavMesh: Ref<boolean>;
  readonly hasNavSession: Ref<boolean>;
  readonly hasStream: Ref<boolean>;
  readonly initScene: () => void;
  readonly loadCdn: (url: string) => Promise<void>;
  readonly loadZip: (file: File) => Promise<void>;
  readonly logs: Ref<readonly string[]>;
  readonly navMeshVisible: Ref<boolean>;
  readonly navPhase: Ref<StorageDemoNavPhase>;
  readonly navSettings: Ref<StreamedNavSettings>;
  readonly resetNavSettings: () => void;
  readonly resize: () => void;
  readonly restoreStreamVisual: () => void;
  readonly runFastNavFromStream: () => Promise<void>;
  readonly selectionRegionVisible: Ref<boolean>;
  readonly setNavMeshVisible: (visible: boolean) => void;
  readonly setSelectionRegionVisible: (visible: boolean) => Promise<void>;
  readonly setStreamQualityPreset: (preset: StreamQualityPreset) => void;
  readonly showDebugNavPly: () => Promise<void>;
  readonly statusMessage: Ref<string>;
  readonly streamQualityPreset: Ref<StreamQualityPreset>;
  readonly streamSettings: Ref<StreamSettings>;
  readonly streamResidency: Ref<StreamResidencyStats | null>;
  readonly resetStreamSettings: () => void;
  readonly rotateNavPly: (axis: 'x' | 'y' | 'z') => void;
  readonly rotateStreamVisual: (axis: 'x' | 'y' | 'z') => void;
  readonly streamVisualRotationLabel: Ref<string>;
  readonly navPlyRotationLabel: Ref<string>;
  readonly summary: ShallowRef<SogLodManifestSummary | null>;
}

const KEY_W = 87;
const KEY_A = 65;
const KEY_S = 83;
const KEY_D = 68;
const KEY_E = 69;
const KEY_Q = 81;

const DEFAULT_FLY_SPEED = 2.5;
const DEFAULT_ANGULAR_SENSIBILITY = 2000;
const SHIFT_SPEED_MULTIPLIER = 10;

type EulerAxes = { x: number; y: number; z: number };
type RotationAxis = 'x' | 'y' | 'z';
type FlyCameraExtras = FreeCamera & {
  __splatwalkSetBaseFlySpeed?: (speed: number) => void;
};

const eulerDegreesLabel = (euler: EulerAxes): string =>
  `X ${((euler.x * 180) / Math.PI).toFixed(0)}° · Y ${((euler.y * 180) / Math.PI).toFixed(0)}° · Z ${((euler.z * 180) / Math.PI).toFixed(0)}°`;

const configureFlyCamera = (camera: FreeCamera, canvas: HTMLCanvasElement): (() => void) => {
  camera.attachControl(canvas, true);
  camera.speed = DEFAULT_FLY_SPEED;
  camera.angularSensibility = DEFAULT_ANGULAR_SENSIBILITY;
  camera.minZ = 0.1;
  camera.keysUp = [KEY_W];
  camera.keysDown = [KEY_S];
  camera.keysLeft = [KEY_A];
  camera.keysRight = [KEY_D];
  camera.keysUpward = [KEY_E];
  camera.keysDownward = [KEY_Q];
  canvas.tabIndex = 0;

  let baseFlySpeed = DEFAULT_FLY_SPEED;
  let shiftHeld = false;

  const syncSpeed = (): void => {
    camera.speed = baseFlySpeed * (shiftHeld ? SHIFT_SPEED_MULTIPLIER : 1);
  };

  const onPointerDown = (): void => {
    canvas.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
      return;
    }
    if (shiftHeld) {
      return;
    }
    shiftHeld = true;
    syncSpeed();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
      return;
    }
    shiftHeld = false;
    syncSpeed();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  (camera as FlyCameraExtras).__splatwalkSetBaseFlySpeed = (speed: number): void => {
    baseFlySpeed = speed;
    syncSpeed();
  };

  return (): void => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    delete (camera as FlyCameraExtras).__splatwalkSetBaseFlySpeed;
  };
};

const frameCameraToScene = (scene: Scene, camera: FreeCamera): void => {
  const worldExtends = scene.getWorldExtends();
  const center = worldExtends.min.add(worldExtends.max).scale(0.5);
  const size = worldExtends.max.subtract(worldExtends.min).length();
  const distance = Math.max(6, size * 0.65);
  camera.position = center.add(new Vector3(0, distance * 0.25, -distance));
  camera.setTarget(center);
  const baseSpeed = Math.max(0.5, distance * 0.04);
  const setBase = (camera as FlyCameraExtras).__splatwalkSetBaseFlySpeed;
  if (setBase) {
    setBase(baseSpeed);
  } else {
    camera.speed = baseSpeed;
  }
};

/** Outdoor / large-scene recovery: lower room-floor area floors than indoor Fast Nav. */
const STREAMED_FAST_NAV_RECOVERY: FastNavRecoveryConfig = {
  steps: [
    ...DEFAULT_FAST_NAV_RECOVERY.steps.map((step) => ({
      ...step,
      minRoomFloorArea: Math.min(step.minRoomFloorArea ?? 4, 2.0),
      settings: {
        ...step.settings,
        sdf_density_threshold: Math.min(
          (step.settings?.sdf_density_threshold as number | undefined) ?? 0.08,
          0.04
        ),
      },
    })),
    {
      label: 'streamed-outdoor-last-resort',
      settings: {
        sdf_cell_size: 0.32,
        sdf_density_threshold: 0.015,
        max_local_height_variance: 0.45,
        min_floor_confidence: 0.001,
        voxel_target: 18000,
        hole_fill_radius: 5,
      },
      minRoomFloorArea: 0.75,
    },
  ],
};

/**
 * Babylon scene + CDN / local-zip streamed SOG loading, with optional
 * materialize → collision / FastNav handoff onto {@link Viewer}.
 */
export const useStorageAdapterDemo = (
  canvasRef: Readonly<Ref<HTMLCanvasElement | null>>
): UseStorageAdapterDemo => {
  const busy = ref(false);
  const debugShowingNavPly = ref(false);
  const errorMessage = ref<string | null>(null);
  const fileCount = ref<number | null>(null);
  const hasNavMesh = ref(false);
  const hasNavSession = ref(false);
  const hasStream = ref(false);
  const logs = ref<string[]>([]);
  const navMeshVisible = ref(true);
  const navPhase = ref<StorageDemoNavPhase>('idle');
  const navSettings = ref<StreamedNavSettings>({ ...DEFAULT_STREAMED_NAV_SETTINGS });
  const selectionRegionVisible = ref(false);
  const streamVisualRotation = ref<EulerAxes>({ x: 0, y: 0, z: 0 });
  const navPlyRotation = ref<EulerAxes>({ x: 0, y: 0, z: 0 });
  const streamVisualRotationLabel = computed(() => eulerDegreesLabel(streamVisualRotation.value));
  const navPlyRotationLabel = computed(() => eulerDegreesLabel(navPlyRotation.value));
  const statusMessage = ref('Ready — load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.');
  const streamSettings = ref<StreamSettings>({ ...DEFAULT_STREAM_SETTINGS });
  const streamResidency = ref<StreamResidencyStats | null>(null);
  const streamQualityPreset = computed({
    get: () => streamSettings.value.preset,
    set: (preset: StreamQualityPreset) => {
      streamSettings.value = applyStreamQualityPreset(preset, streamSettings.value);
    },
  });
  const summary = shallowRef<SogLodManifestSummary | null>(null);

  /** Last selection-region AABB so hide→show can restore the user's box. */
  let cachedSelectionRegion: { min: number[]; max: number[] } | null = null;

  let engine: Engine | null = null;
  let scene: BabylonScene | null = null;
  let camera: FreeCamera | null = null;
  let flyCameraDispose: (() => void) | null = null;
  let streamDispose: (() => void) | null = null;
  let skipLoggerDispose: (() => void) | null = null;
  let viewer: Viewer | null = null;
  let streamManifest: ISOGLODMetadata | null = null;
  let streamAccess: StreamedBundleAccess | null = null;
  let cachedPly: Uint8Array | null = null;
  let cachedPlySplatCount = 0;

  const addLog = (message: string): void => {
    logs.value = [...logs.value, message].slice(-80);
  };

  const clearStreamResources = (): void => {
    if (skipLoggerDispose) {
      skipLoggerDispose();
      skipLoggerDispose = null;
    }
    if (streamDispose) {
      streamDispose();
      streamDispose = null;
    }
  };

  const setStreamQualityPreset = (preset: StreamQualityPreset): void => {
    streamSettings.value = applyStreamQualityPreset(preset, streamSettings.value);
    addLog(
      `Stream quality preset → ${preset} (${streamQualityPresetResidentSplats(preset).toLocaleString()} resident). Re-load stream to apply.`
    );
  };

  const resetStreamSettings = (): void => {
    streamSettings.value = { ...DEFAULT_STREAM_SETTINGS };
    addLog('Stream settings reset to Medium defaults. Re-load stream to apply.');
  };

  const disposeViewer = (): void => {
    if (!viewer) {
      return;
    }
    viewer.getScene().getEngine().stopRenderLoop();
    viewer.getScene().getEngine().dispose();
    viewer = null;
    hasNavMesh.value = false;
    hasNavSession.value = false;
    navMeshVisible.value = true;
  };

  const initScene = (): void => {
    if (engine || viewer || !canvasRef.value) {
      return;
    }
    const canvas = canvasRef.value;
    engine = new Engine(canvas, true);
    scene = new BabylonScene(engine);
    // Dark clear — missing environment/sky must not be masked by a sky-like clear color.
    scene.clearColor = new Color3(0.05, 0.05, 0.05).toColor4();

    camera = new FreeCameraCtor('flyCamera', new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());
    flyCameraDispose?.();
    flyCameraDispose = configureFlyCamera(camera, canvas);

    const light = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    engine.runRenderLoop(() => {
      scene?.render();
    });
    window.addEventListener('resize', resize);
    addLog('Babylon scene ready (WASD fly · E/Q up/down · SHIFT 10× · mouse look)');
  };

  const settleStreamResidency = async (
    stream: Parameters<typeof awaitStreamResidencyReport>[0]['stream'],
    catalogFiles: number,
    getSkipCount: () => number
  ): Promise<void> => {
    if (!scene || !camera) {
      return;
    }
    frameCameraToScene(scene, camera);
    ensureActiveCameraForStream(scene, camera);
    statusMessage.value = 'Settling stream residency (camera-framed LOD)…';
    streamResidency.value = await awaitStreamResidencyReport({
      catalogFiles,
      getSkipCount,
      log: addLog,
      stream,
    });
  };

  const resize = (): void => {
    if (viewer) {
      viewer.resize();
      return;
    }
    engine?.resize();
  };

  const clearSceneStreams = (): void => {
    clearStreamResources();
    if (!scene) {
      return;
    }
    for (const mesh of [...scene.meshes]) {
      const className = mesh.getClassName();
      if (
        className.includes('Gaussian') ||
        className.includes('Splatting') ||
        mesh.name === 'storageAdapterSogStream' ||
        mesh.name === 'GaussianSplattingStream'
      ) {
        mesh.dispose(false, true);
      }
    }
  };

  /** Capture GaussianSplattingStream's default mesh euler (Z-up→Y-up) for fly-cam UI. */
  const captureStreamVisualRotationFromScene = (): void => {
    if (!scene) {
      return;
    }
    for (const mesh of scene.meshes) {
      const className = mesh.getClassName();
      if (
        className.includes('Gaussian') ||
        className.includes('Splatting') ||
        mesh.name === 'storageAdapterSogStream' ||
        mesh.name === 'GaussianSplattingStream'
      ) {
        mesh.computeWorldMatrix(true);
        streamVisualRotation.value = {
          x: mesh.rotation.x,
          y: mesh.rotation.y,
          z: mesh.rotation.z,
        };
        navPlyRotation.value = { ...streamVisualRotation.value };
        addLog(
          `[INFO] Stream visual rotation: ${streamVisualRotationLabel.value} ` +
            `(nav PLY matches stream; use Nav PLY rotate for SuperSplat-style offsets)`
        );
        return;
      }
    }
  };

  const resetStreamState = (): void => {
    streamManifest = null;
    streamAccess = null;
    cachedPly = null;
    cachedPlySplatCount = 0;
    hasStream.value = false;
    hasNavMesh.value = false;
    hasNavSession.value = false;
    navMeshVisible.value = true;
    summary.value = null;
    fileCount.value = null;
    streamResidency.value = null;
    navPhase.value = 'idle';
    streamVisualRotation.value = { x: 0, y: 0, z: 0 };
    navPlyRotation.value = { x: 0, y: 0, z: 0 };
  };

  const clear = (): void => {
    disposeViewer();
    clearSceneStreams();
    resetStreamState();
    cachedSelectionRegion = null;
    selectionRegionVisible.value = false;
    errorMessage.value = null;
    if (!engine && canvasRef.value) {
      initScene();
    }
    statusMessage.value = 'Cleared. Load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.';
    addLog('Scene cleared');
  };

  const clearNavArtifacts = (): void => {
    if (viewer) {
      disposeViewer();
      cachedPly = null;
      cachedPlySplatCount = 0;
      cachedSelectionRegion = null;
      selectionRegionVisible.value = false;
      navPhase.value = 'idle';
      if (canvasRef.value) {
        initScene();
      }
      hasStream.value = false;
      statusMessage.value =
        'Nav artifacts cleared. Reload a CDN lod-meta or zip to stream again, then re-run Fast Nav.';
      addLog('Nav artifacts cleared (reload stream to continue)');
      return;
    }
    navPhase.value = 'idle';
    statusMessage.value = 'Nav artifacts cleared.';
    addLog('Nav artifacts cleared');
  };

  const loadCdn = async (url: string): Promise<void> => {
    disposeViewer();
    if (!scene || !camera) {
      initScene();
    }
    if (!scene || !camera) {
      throw new Error('Scene is not initialized.');
    }
    busy.value = true;
    errorMessage.value = null;
    statusMessage.value = 'Loading CDN lod-meta.json…';
    try {
      clearSceneStreams();
      resetStreamState();
      const skipLogger = installBudgetSkipLogger();
      skipLoggerDispose = skipLogger.dispose;
      const result = await loadCdnLodMeta({
        lodMetaUrl: url,
        settings: streamSettings.value,
        scene,
      });
      streamDispose = result.dispose;
      streamManifest = result.manifest;
      streamAccess = { kind: 'cdn', rootUrl: deriveLodMetaRootUrl(result.lodMetaUrl) };
      summary.value = result.summary;
      fileCount.value = result.summary.filenameCount;
      hasStream.value = true;
      addLog(`Loaded CDN: ${url}`);
      addLog(
        `Manifest: lodLevels=${result.summary.lodLevels}, filenames=${result.summary.filenameCount}` +
          (result.summary.environment ? `, environment=${result.summary.environment}` : ', environment=(none)')
      );
      addLog(
        formatStreamBudgetLog({
          chunkCount: result.summary.filenameCount,
          settings: streamSettings.value,
        })
      );
      await settleStreamResidency(
        result.stream,
        result.summary.filenameCount,
        skipLogger.getSkipCount
      );
      assertStreamEnvironmentLoaded({
        environmentPath: result.summary.environment,
        stream: result.stream,
      });
      captureStreamVisualRotationFromScene();
      const residency = streamResidency.value;
      const resident = result.streamOptions.maxResidentSplats ?? 0;
      statusMessage.value =
        `CDN stream ready · ${result.summary.lodLevels} LOD levels · ` +
        `decoded ${residency?.decodedFiles ?? '?'}/${result.summary.filenameCount} chunks · ` +
        `${resident.toLocaleString()} resident` +
        (residency && residency.environmentSplats > 0
          ? ` · env ${residency.environmentSplats.toLocaleString()}`
          : '') +
        (residency && residency.skippedBudgetWarnings > 0
          ? ` · ${residency.skippedBudgetWarnings} budget skips`
          : '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      statusMessage.value = 'CDN load failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const loadZip = async (file: File): Promise<void> => {
    disposeViewer();
    if (!scene || !camera) {
      initScene();
    }
    if (!scene || !camera) {
      throw new Error('Scene is not initialized.');
    }
    busy.value = true;
    errorMessage.value = null;
    statusMessage.value = `Extracting ${file.name}…`;
    try {
      clearSceneStreams();
      resetStreamState();
      const skipLogger = installBudgetSkipLogger();
      skipLoggerDispose = skipLogger.dispose;
      const result = await loadLocalSogZip({
        file,
        settings: streamSettings.value,
        scene,
      });
      streamDispose = result.dispose;
      streamManifest = result.manifest;
      streamAccess = { kind: 'memory', files: result.files };
      summary.value = result.summary;
      fileCount.value = result.fileCount;
      hasStream.value = true;
      addLog(`Loaded zip: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);
      addLog(
        `Manifest: lodLevels=${result.summary.lodLevels}, filenames=${result.summary.filenameCount}`
      );
      addLog(
        formatStreamBudgetLog({
          chunkCount: result.summary.filenameCount,
          settings: streamSettings.value,
        })
      );
      addLog(
        'Note: local zip materializes the full bundle in memory — use CDN lod-meta for city-scale scenes.'
      );
      await settleStreamResidency(result.stream, result.summary.filenameCount, skipLogger.getSkipCount);
      assertStreamEnvironmentLoaded({
        environmentPath: result.summary.environment,
        stream: result.stream,
      });
      captureStreamVisualRotationFromScene();
      const residency = streamResidency.value;
      const resident = result.streamOptions.maxResidentSplats ?? 0;
      statusMessage.value =
        `Local zip stream ready · ${result.summary.lodLevels} LOD levels · ` +
        `decoded ${residency?.decodedFiles ?? '?'}/${result.fileCount} files · ` +
        `${resident.toLocaleString()} resident` +
        (residency && residency.environmentSplats > 0
          ? ` · env ${residency.environmentSplats.toLocaleString()}`
          : '') +
        (residency && residency.skippedBudgetWarnings > 0
          ? ` · ${residency.skippedBudgetWarnings} budget skips`
          : '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      statusMessage.value = 'Zip load failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const ensureMaterializedPly = async (): Promise<Uint8Array> => {
    if (cachedPly && cachedPlySplatCount >= DEFAULT_NAV_MIN_SPLATS) {
      return cachedPly;
    }
    if (!streamManifest || !streamAccess) {
      throw new Error('Load a streamed SOG (CDN or zip) before generating collision / navmesh.');
    }
    const decodeScene = scene ?? viewer?.getScene() ?? null;
    if (!decodeScene) {
      throw new Error('Scene is not initialized for SOG decode.');
    }
    navPhase.value = 'materialize';
    statusMessage.value = 'Materializing nav PLY (intermediary for WASM; stream visual kept)…';
    const result = await materializeNavSourceFromStreamedSog({
      access: streamAccess,
      metadata: streamManifest,
      options: {
        lodIndex: 'nav',
        maxSplats: DEFAULT_NAV_MAX_SPLATS,
        minSplats: DEFAULT_NAV_MIN_SPLATS,
        onProgress: addLog,
      },
      scene: decodeScene,
    });
    cachedPly = result.plyBytes;
    cachedPlySplatCount = result.splatCount;
    addLog(
      `Materialized LOD ${result.lodIndexUsed}: ${result.splatCount} splats → PLY (nav intermediary)`
    );
    if (result.splatCount < DEFAULT_NAV_MIN_SPLATS) {
      addLog(
        `[WARN] Only ${result.splatCount} splats after finest LOD (target ${DEFAULT_NAV_MIN_SPLATS}). Floor extraction may still fail on sparse outdoor scans.`
      );
    }
    return cachedPly;
  };

  /**
   * Adopt the live stream scene into Viewer for nav overlays.
   * Materialized PLY is WASM-only — the streamed SOG visual stays on canvas.
   */
  const handoffStreamToViewer = async (): Promise<Viewer> => {
    const canvas = canvasRef.value;
    if (!canvas || !engine || !scene) {
      throw new Error('Stream scene is not ready for Viewer handoff.');
    }

    engine.stopRenderLoop();
    window.removeEventListener('resize', resize);

    if (camera) {
      flyCameraDispose?.();
      flyCameraDispose = null;
      camera.detachControl();
      camera.dispose();
      camera = null;
    }

    const adoptedEngine = engine;
    const adoptedScene = scene;
    engine = null;
    scene = null;

    await splatwalk.init();
    viewer = new Viewer(canvas, {
      existing: {
        engine: adoptedEngine,
        preserveVisual: true,
        scene: adoptedScene,
      },
    });
    window.addEventListener('resize', resize);
    streamVisualRotation.value = viewer.getStreamVisualRotation();
    const navFromStream = viewer.getSplatRotation();
    const navDiffersFromStream =
      Math.abs(navPlyRotation.value.x - streamVisualRotation.value.x) > 1e-6 ||
      Math.abs(navPlyRotation.value.y - streamVisualRotation.value.y) > 1e-6 ||
      Math.abs(navPlyRotation.value.z - streamVisualRotation.value.z) > 1e-6;
    if (navDiffersFromStream) {
      viewer.setNavPlyRotation(navPlyRotation.value);
    } else {
      navPlyRotation.value = { ...navFromStream };
    }

    if (!viewer.hasLoadedSplat()) {
      disposeViewer();
      if (canvasRef.value) {
        initScene();
      }
      throw new Error(
        'Viewer handoff failed: no streamed SOG meshes on the canvas. Reload the stream and try again.'
      );
    }
    viewer.assertGroundLooksYUp();
    viewer.resize();
    hasStream.value = true;
    hasNavSession.value = true;
    debugShowingNavPly.value = false;
    addLog(
      'Viewer handoff complete — streamed SOG kept on canvas; PLY used only for WASM nav.'
    );
    return viewer;
  };

  const ensureViewerWithPly = async (): Promise<{ plyBytes: Uint8Array; activeViewer: Viewer }> => {
    const plyBytes = await ensureMaterializedPly();
    if (viewer) {
      viewer.assertGroundLooksYUp();
      return { plyBytes, activeViewer: viewer };
    }
    const activeViewer = await handoffStreamToViewer();
    return { plyBytes, activeViewer };
  };

  const showDebugNavPly = async (): Promise<void> => {
    if (!viewer) {
      throw new Error('Run Fast Nav or collision first so the stream is adopted into the Viewer.');
    }
    const plyBytes = await ensureMaterializedPly();
    busy.value = true;
    errorMessage.value = null;
    try {
      statusMessage.value = 'Showing intermediary nav PLY (debug)…';
      await viewer.showDebugIntermediaryPly(plyBytes, { applySogLodOrientation: true });
      try {
        viewer.assertGroundLooksYUp();
      } catch (orientError) {
        const message = orientError instanceof Error ? orientError.message : String(orientError);
        addLog(`[WARN] ${message}`);
        errorMessage.value = message;
      }
      debugShowingNavPly.value = true;
      statusMessage.value =
        'Debug: intermediary nav PLY visible. Use Restore stream to return to the live SOG.';
      addLog('[DEBUG] Intermediary nav PLY shown (stream hidden).');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const restoreStreamVisual = (): void => {
    if (!viewer) {
      return;
    }
    viewer.restoreStreamVisual();
    debugShowingNavPly.value = false;
    statusMessage.value = 'Restored streamed SOG visual.';
    addLog('[DEBUG] Streamed SOG visual restored.');
  };

  const applyStreamVisualToSceneMeshes = (): void => {
    if (!scene) {
      return;
    }
    const euler = streamVisualRotation.value;
    for (const mesh of scene.meshes) {
      const className = mesh.getClassName();
      if (
        !(
          className.includes('Gaussian') ||
          className.includes('Splatting') ||
          mesh.name === 'storageAdapterSogStream' ||
          mesh.name === 'GaussianSplattingStream'
        )
      ) {
        continue;
      }
      mesh.rotation.x = euler.x;
      mesh.rotation.y = euler.y;
      mesh.rotation.z = euler.z;
      mesh.computeWorldMatrix(true);
    }
  };

  const rotateStreamVisual = (axis: RotationAxis): void => {
    streamVisualRotation.value = {
      ...streamVisualRotation.value,
      [axis]: streamVisualRotation.value[axis] + Math.PI / 2,
    };
    if (viewer) {
      viewer.setStreamVisualRotation(streamVisualRotation.value);
    } else {
      applyStreamVisualToSceneMeshes();
    }
    addLog(`[INFO] Stream visual ${axis}+90° (${streamVisualRotationLabel.value}). Re-run Fast Nav after adjusting Nav PLY if needed.`);
  };

  const rotateNavPly = (axis: RotationAxis): void => {
    navPlyRotation.value = {
      ...navPlyRotation.value,
      [axis]: navPlyRotation.value[axis] + Math.PI / 2,
    };
    if (viewer) {
      viewer.setNavPlyRotation(navPlyRotation.value);
    }
    addLog(
      `[INFO] Nav PLY ${axis}+90° (${navPlyRotationLabel.value}). Re-run Fast Nav / collision to bake the new orientation.`
    );
  };

  const setNavMeshVisible = (visible: boolean): void => {
    navMeshVisible.value = visible;
    viewer?.setNavMeshVisible(visible);
  };

  const setSelectionRegionVisible = async (visible: boolean): Promise<void> => {
    if (!visible) {
      if (viewer) {
        const bounds = viewer.getRegionBounds();
        if (bounds) {
          cachedSelectionRegion = {
            min: [...bounds.min],
            max: [...bounds.max],
          };
        }
        viewer.disableRegionSelection();
      }
      selectionRegionVisible.value = false;
      addLog('[INFO] Selection region hidden — Fast Nav will auto-select a region.');
      return;
    }

    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly();
      let region = cachedSelectionRegion;
      if (!region) {
        const rotation = activeViewer.getSplatRotation();
        const suggested = await splatwalk.suggestRegion(plyBytes, {
          ...FAST_NAV_PRESET,
          mode: 2,
          flip_y: activeViewer.getWasmFlipY(),
          rotation: [rotation.x, rotation.y, rotation.z],
          prune_floaters: navSettings.value.pruneFloaters,
        });
        region = {
          min: [...suggested.region_min],
          max: [...suggested.region_max],
        };
        cachedSelectionRegion = region;
        addLog(
          `[INFO] Selection region suggested: ` +
            `${region.min.map((v) => v.toFixed(2)).join(', ')} → ` +
            `${region.max.map((v) => v.toFixed(2)).join(', ')}`
        );
      }
      activeViewer.enableRegionSelection({ min: region.min, max: region.max });
      selectionRegionVisible.value = true;
      addLog('[INFO] Selection region shown — Fast Nav / collision will pin this box.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      selectionRegionVisible.value = false;
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const resetNavSettings = (): void => {
    navSettings.value = { ...DEFAULT_STREAMED_NAV_SETTINGS };
    cachedSelectionRegion = null;
    if (viewer) {
      viewer.disableRegionSelection();
    }
    selectionRegionVisible.value = false;
    addLog('[INFO] Navmesh settings reset to outdoor defaults.');
  };

  const generateCollision = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly();
      statusMessage.value = 'Generating voxel collision boundary…';
      const rotation = activeViewer.getSplatRotation();
      const regionBounds = activeViewer.getRegionBounds();
      const settings = buildCollisionBoundarySettings({
        base: {
          prune_floaters: navSettings.value.pruneFloaters,
          ...(regionBounds
            ? { region_min: [...regionBounds.min], region_max: [...regionBounds.max] }
            : {}),
        },
        emitGlb: true,
        flipY: activeViewer.getWasmFlipY(),
        rotation: [rotation.x, rotation.y, rotation.z],
        seed: seedFromRegionBounds({ regionBounds }),
      });
      const artifact = await generateCollisionBoundaryArtifact({ bytes: plyBytes, settings });
      activeViewer.displayColliderMesh(
        artifact.result.mesh.vertices,
        artifact.result.mesh.indices,
        0.35
      );
      activeViewer.setColliderVisible(true);
      statusMessage.value = `Collision ready · ${artifact.result.mesh.vertex_count} verts · ${artifact.result.mesh.face_count} faces`;
      addLog(
        `[SUCCESS] Collision boundary: ${artifact.result.mesh.vertex_count} vertices, ${artifact.result.mesh.face_count} faces.`
      );
      navPhase.value = 'done';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      navPhase.value = 'error';
      statusMessage.value = 'Collision generation failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  const runFastNavFromStream = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly();
      const settings = navSettings.value;
      statusMessage.value = 'Running Fast Nav…';
      navPhase.value = 'prune';
      addLog(
        `[INFO] Nav settings: prune=${settings.pruneFloaters ? 'on' : 'off'} ` +
          `region=${activeViewer.getRegionBounds() ? 'pinned' : 'auto'} ` +
          `slope=${settings.walkableSlopeAngle}° radius=${settings.walkableRadius}m ` +
          `climb=${settings.walkableClimb}m band=±${settings.sameLevelBelow}/${settings.sameLevelAbove}m ` +
          `sdf=${settings.sdfCellSize}/${settings.sdfDensityThreshold}`
      );
      const tuning = demoNavSettingsToFastNavTuning(settings);
      const fastNav = await runFastNav({
        viewer: activeViewer,
        bytes: plyBytes,
        onLog: addLog,
        onPhase: (next) => {
          navPhase.value = next;
        },
        recovery: STREAMED_FAST_NAV_RECOVERY,
        recastAttempts: STREAMED_FAST_NAV_RECAST_ATTEMPTS,
        ...tuning,
      });
      statusMessage.value = 'Framing the player (top-down)…';
      const framing = activeViewer.focusOnPlayer();
      if (framing) {
        addLog(
          `[SUCCESS] Top-down view above player at ${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      } else {
        addLog('[WARN] focusOnPlayer returned null; leaving splat framing.');
      }
      activeViewer.resize();
      hasNavMesh.value = true;
      navMeshVisible.value = true;
      activeViewer.setNavMeshVisible(true);
      navPhase.value = 'done';
      statusMessage.value =
        'Fast Nav complete. Click the navmesh to move the player.';
      addLog(
        `[SUCCESS] Navmesh ready (${(fastNav.navMeshData.byteLength / 1024).toFixed(1)} KB).`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      navPhase.value = 'error';
      statusMessage.value = 'Fast Nav failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize);
    flyCameraDispose?.();
    flyCameraDispose = null;
    clearStreamResources();
    disposeViewer();
    engine?.dispose();
    engine = null;
    scene = null;
    camera = null;
  });

  return {
    busy,
    clear,
    clearNavArtifacts,
    debugShowingNavPly,
    errorMessage,
    fileCount,
    generateCollision,
    hasNavMesh,
    hasNavSession,
    hasStream,
    initScene,
    loadCdn,
    loadZip,
    logs,
    navMeshVisible,
    navPhase,
    navPlyRotationLabel,
    navSettings,
    resetNavSettings,
    resize,
    restoreStreamVisual,
    rotateNavPly,
    rotateStreamVisual,
    runFastNavFromStream,
    selectionRegionVisible,
    setNavMeshVisible,
    setSelectionRegionVisible,
    setStreamQualityPreset,
    showDebugNavPly,
    statusMessage,
    streamQualityPreset,
    streamResidency,
    streamSettings,
    streamVisualRotationLabel,
    resetStreamSettings,
    summary,
  };
};
