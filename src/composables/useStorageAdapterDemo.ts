import { computed, onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

import type { ArcRotateCamera, FreeCamera } from '@babylonjs/core';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ArcRotateCamera as ArcRotateCameraCtor } from '@babylonjs/core/Cameras/arcRotateCamera';
import { FreeCamera as FreeCameraCtor } from '@babylonjs/core/Cameras/freeCamera';
import { Color3, Vector3 } from '@babylonjs/core/Maths/math';
import { Scene as BabylonScene } from '@babylonjs/core/scene';
import type { GaussianSplattingStream, ISOGLODMetadata } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';
import '@babylonjs/loaders/SPLAT';
import {
  createBabylonEngine,
  parseRendererPreference,
  type BabylonRendererActual,
  type BabylonRendererPreference,
} from '@/scene/createBabylonEngine';

import {
  buildCollisionBoundarySettings,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
} from '@/collision/voxelBoundary';
import {
  clampRegionToDenseBudget,
  fitsDenseVoxelBudgetAtMaxCoarseness,
  MAX_AUTO_REGION_FOOTPRINT_METERS,
  regionFitsDenseBudget,
} from '@/navigation/collisionGridBudget';
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
  buildMinimalNavArtifactBundle,
  downloadNavArtifactZip,
  navArtifactSlugFromSource,
  parseNavArtifactFiles,
  type NavArtifactBundle,
} from '@/navigation/navArtifactBundle';
import {
  activateNavBackend,
  activeModeFromCapabilities,
  activeModeUnavailableReason,
  activeNavigationModeLabel,
  DEFAULT_ACTIVE_NAVIGATION_MODE,
  isActiveModeAvailable,
  liveNavBackendLabel,
  navCapabilitiesFromBundle,
  volumeFromNavArtifactBundle,
  type ActiveNavigationMode,
  type LiveNavBackend,
  type NavCapabilities,
} from '@/navigation/activeNavigation';
import { applyNavArtifactsToViewer } from '@/navigation/applyNavArtifacts';
import { NAV_ARTIFACT_UPLOAD_HINT } from '@/navigation/navArtifactContract';
import {
  DEFAULT_STREAMED_NAV_SETTINGS,
  demoNavSettingsToFastNavTuning,
  type StreamedNavSettings,
} from '@/navigation/navSettings';
import {
  DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  regionBoundsFromCameraSelect,
  type CameraSelectRegionInput,
  type CameraSelectRegionOffsets,
} from '@/navigation/cameraSelectRegion';
import {
  expandRegionForVoxelStairs,
  REGION_STAIR_FOOTROOM_METERS,
  REGION_STAIR_HEADROOM_METERS,
} from '@/navigation/regionSelection';
import {
  formatVoxelNavSettingsLog,
  resolveVoxelCollisionSeed,
  runNavFromVoxelCollider,
} from '@/navigation/runNavFromVoxelCollider';
import {
  DEFAULT_VOXEL_NAV_SETTINGS,
  type NavGenerationMode,
  type VoxelCollisionNavSettings,
  type VoxelLocomotionMode,
  voxelNavSettingsToCollisionBase,
} from '@/navigation/voxelNavSettings';
import type { CollisionVoxelVolume } from '@/wasm/bridge';
import { Viewer } from '@/scene/Viewer';
import {
  captureActiveCameraView,
  configureFlyCamera,
  configureOrbitCamera,
  createFlyCameraFromView,
  createOrbitCameraFromView,
  demoCameraModeLabel,
  frameFlyCameraToScene,
  frameOrbitCameraToScene,
  type DemoCameraMode,
} from '@/scene/demoCameraControls';
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
  applyStreamPerformanceMode,
  applyStreamQualityPreset,
  DEFAULT_STREAM_SETTINGS,
  formatStreamBudgetLog,
  streamQualityPresetResidentSplats,
  type StreamQualityPreset,
  type StreamSettings,
} from '@/storage/streamMemoryBudget';
import { installBudgetedTargetLevels } from '@/storage/installBudgetedTargetLevels';
import {
  assertStreamBufferBounded,
  UnboundedStreamBufferError,
} from '@/storage/streamBufferGuard';
import {
  assertStreamEnvironmentLoaded,
  awaitStreamResidencyReport,
  ensureActiveCameraForStream,
  formatStreamResidencyStatus,
  installBudgetSkipLogger,
  type StreamResidencyStats,
} from '@/storage/streamResidency';
import {
  applySafeStreamRuntimeTuning,
  installMotionDecodePause,
  installSortPostBackpressure,
  SORT_POST_MIN_INTERVAL_MS,
} from '@/storage/streamRuntimeParity';
import { splatwalk } from '@/wasm/bridge';

export type StorageDemoSource = 'cdn' | 'local';
export type StorageDemoCameraType = DemoCameraMode;
export type { StreamQualityPreset, StreamSettings };

export type StorageDemoNavPhase = FastNavPhase | 'idle' | 'materialize' | 'error';

export type { StreamedNavSettings };
export { DEFAULT_STREAMED_NAV_SETTINGS };

export type { NavGenerationMode, VoxelCollisionNavSettings, VoxelLocomotionMode };
export { DEFAULT_VOXEL_NAV_SETTINGS };
export type { ActiveNavigationMode, LiveNavBackend, NavCapabilities };
export {
  DEFAULT_ACTIVE_NAVIGATION_MODE,
  activeNavigationModeLabel,
  liveNavBackendLabel,
};

export type EulerAxes = { x: number; y: number; z: number };
type RotationAxis = 'x' | 'y' | 'z';

/** Live camera pose readout for the Storage Adapter Camera Information panel. */
export interface StorageDemoCameraInfo {
  readonly eulerDegrees: EulerAxes;
  readonly mode: StorageDemoCameraType;
  readonly orbit: { alpha: number; beta: number; radius: number } | null;
  readonly position: EulerAxes;
}

/** Absolute fly pose armed for the next CDN/zip settle (e.g. Oval stairs). */
export interface StorageDemoInitialFlyPose {
  readonly eulerDegrees: EulerAxes;
  readonly position: EulerAxes;
}

const emptyCameraInfo = (): StorageDemoCameraInfo => ({
  eulerDegrees: { x: 0, y: 0, z: 0 },
  mode: 'fly',
  orbit: null,
  position: { x: 0, y: 0, z: 0 },
});

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const PLAYCANVAS_CDN_HOST = 'code.playcanvas.com';
const PLAYCANVAS_STREAM_ORIENTATION: EulerAxes = { x: -Math.PI / 2, y: 0, z: 0 };
const IDENTITY_STREAM_ORIENTATION: EulerAxes = { x: 0, y: 0, z: 0 };

/** PlayCanvas CDN → −90° X; every other source → identity. */
const defaultStreamOrientationForUrl = (url: string | null): EulerAxes => {
  if (!url) {
    return { ...IDENTITY_STREAM_ORIENTATION };
  }
  try {
    return new URL(url).hostname === PLAYCANVAS_CDN_HOST
      ? { ...PLAYCANVAS_STREAM_ORIENTATION }
      : { ...IDENTITY_STREAM_ORIENTATION };
  } catch {
    return { ...IDENTITY_STREAM_ORIENTATION };
  }
};

export interface UseStorageAdapterDemo {
  readonly busy: Ref<boolean>;
  readonly cameraInfo: Ref<StorageDemoCameraInfo>;
  readonly cameraInfoCopyText: Ref<string>;
  readonly cameraType: Ref<StorageDemoCameraType>;
  readonly clear: () => void;
  readonly clearNavArtifacts: () => void;
  readonly debugShowingNavPly: Ref<boolean>;
  readonly downloadNavArtifacts: () => void;
  /** Parse zip or multi-select loose members and restore nav on the active Viewer. */
  readonly uploadNavArtifacts: (files: File[] | FileList) => Promise<void>;
  readonly errorMessage: Ref<string | null>;
  readonly fileCount: Ref<number | null>;
  readonly generateCollision: () => Promise<void>;
  /** Frame top-down on the live player agent when one exists. */
  readonly goToPlayer: () => void;
  readonly hasColliderMesh: Ref<boolean>;
  readonly hasNavArtifactBundle: Ref<boolean>;
  readonly hasNavMesh: Ref<boolean>;
  readonly hasNavSession: Ref<boolean>;
  readonly hasStream: Ref<boolean>;
  readonly activeRenderer: Ref<BabylonRendererActual | null>;
  readonly initScene: () => Promise<void>;
  readonly rendererPreference: Ref<BabylonRendererPreference>;
  readonly setRendererPreference: (preference: BabylonRendererPreference) => Promise<void>;
  readonly loadCdn: (url: string) => Promise<void>;
  readonly loadZip: (file: File) => Promise<void>;
  readonly logs: Ref<readonly string[]>;
  readonly colliderVisible: Ref<boolean>;
  readonly navArtifactUploadHint: string;
  readonly navMeshVisible: Ref<boolean>;
  readonly activeNavigationMode: Ref<ActiveNavigationMode>;
  readonly liveBackend: Ref<LiveNavBackend>;
  readonly navCapabilities: Ref<NavCapabilities>;
  readonly navMode: Ref<NavGenerationMode>;
  readonly navPhase: Ref<StorageDemoNavPhase>;
  readonly navSettings: Ref<StreamedNavSettings>;
  readonly resetNavSettings: () => void;
  readonly resetVoxelNavSettings: () => void;
  readonly resize: () => void;
  readonly restoreStreamVisual: () => void;
  readonly runFastNavFromStream: () => Promise<void>;
  readonly runNavFromStream: () => Promise<void>;
  readonly selectionRegionVisible: Ref<boolean>;
  readonly setActiveNavigationMode: (mode: ActiveNavigationMode) => Promise<void>;
  readonly setColliderVisible: (visible: boolean) => void;
  readonly setNavGenerationMode: (mode: NavGenerationMode) => void;
  readonly setNavMeshVisible: (visible: boolean) => void;
  /** Whether an Active mode can be selected (intent or hot-swap). */
  readonly isActiveNavigationModeEnabled: (mode: ActiveNavigationMode) => boolean;
  readonly activeNavigationModeDisabledReason: (mode: ActiveNavigationMode) => string | null;
  readonly setSelectionRegionVisible: (visible: boolean) => Promise<void>;
  readonly setCameraInfoPanelOpen: (open: boolean) => void;
  readonly setCameraType: (type: StorageDemoCameraType) => void;
  /**
   * Arm an absolute fly pose (position + euler°) applied on the next stream settle
   * instead of world-extents auto-frame. Pass `null` to clear.
   */
  readonly setPendingInitialFlyPose: (pose: StorageDemoInitialFlyPose | null) => void;
  /**
   * Arm a camera view + AABB offsets for the next settle (yellow box) and for
   * subsequent Fast Nav / voxel nav (pin + restore view). Pass `null` to clear.
   * Oval-only in the showcase; Church / Skatepark leave this unset.
   */
  readonly setPendingCameraSelect: (input: CameraSelectRegionInput | null) => void;
  /**
   * AABB offsets (meters) used by {@link applySelectRegionFromCamera} and Oval settle.
   * Editing fields alone does not move the yellow box until Apply.
   */
  readonly cameraSelectOffsets: Ref<CameraSelectRegionOffsets>;
  /** Replace camera-select AABB offsets (partial merge). */
  readonly setCameraSelectOffsets: (offsets: Partial<CameraSelectRegionOffsets>) => void;
  /** Reset camera-select AABB offsets to defaults (10/10/15/5/5/15). */
  readonly resetCameraSelectOffsets: () => void;
  /**
   * Rebuild the yellow select region from the live fly camera + current offsets,
   * and store as pending `cameraSelect` for Fast Nav / voxel view restore.
   */
  readonly applySelectRegionFromCamera: () => Promise<void>;
  /**
   * Arm an absolute Stream + Nav PLY euler (radians) applied after the next CDN/zip
   * stream load settles (overrides capture of the stream's default mesh rotation).
   * Pass `null` to clear (Church / Skatepark keep captured defaults).
   */
  readonly setPendingStreamOrientation: (euler: EulerAxes | null) => void;
  readonly setStreamPerformanceMode: (enabled: boolean) => void;
  readonly setStreamQualityPreset: (preset: StreamQualityPreset) => void;
  readonly showDebugNavPly: () => Promise<void>;
  readonly statusMessage: Ref<string>;
  readonly streamPerformanceMode: Ref<boolean>;
  readonly streamQualityPreset: Ref<StreamQualityPreset>;
  readonly streamSettings: Ref<StreamSettings>;
  readonly streamResidency: Ref<StreamResidencyStats | null>;
  readonly resetStreamSettings: () => void;
  readonly rotateNavPly: (axis: 'x' | 'y' | 'z') => void;
  readonly rotateStreamVisual: (axis: 'x' | 'y' | 'z') => void;
  readonly streamVisualRotationLabel: Ref<string>;
  readonly navPlyRotationLabel: Ref<string>;
  readonly summary: ShallowRef<SogLodManifestSummary | null>;
  readonly voxelNavSettings: Ref<VoxelCollisionNavSettings>;
}

const eulerDegreesLabel = (euler: EulerAxes): string =>
  `X ${((euler.x * 180) / Math.PI).toFixed(0)}° · Y ${((euler.y * 180) / Math.PI).toFixed(0)}° · Z ${((euler.z * 180) / Math.PI).toFixed(0)}°`;

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

/** Voxel collision needs denser nav PLY than floor-field (filter-cluster requires connectivity). */
const VOXEL_NAV_MIN_SPLATS = 100_000;
const VOXEL_NAV_MAX_SPLATS = 500_000;
/** Full-density region materialization — fewer total splats but locally complete like PC / SS. */
const VOXEL_REGION_MIN_SPLATS = 10_000;
/** KNN floater prune above this count can take many minutes on region materialize. */
const VOXEL_PRUNE_MAX_SPLATS = 350_000;
const RAW_SOG_REGION_PAD_METERS = 1;

const padWasmRegionBounds = (bounds: {
  min: readonly number[];
  max: readonly number[];
}): { min: number[]; max: number[] } => {
  const pad = RAW_SOG_REGION_PAD_METERS;
  return {
    min: [bounds.min[0]! - pad, bounds.min[1]! - pad, bounds.min[2]! - pad],
    max: [bounds.max[0]! + pad, bounds.max[1]! + pad, bounds.max[2]! + pad],
  };
};

const regionFootprintMeters = (bounds: {
  min: readonly number[];
  max: readonly number[];
}): number => {
  const dx = bounds.max[0]! - bounds.min[0]!;
  const dz = bounds.max[2]! - bounds.min[2]!;
  return Math.max(dx, dz);
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
  const hasColliderMesh = ref(false);
  const hasNavMesh = ref(false);
  const hasNavSession = ref(false);
  const hasStream = ref(false);
  const logs = ref<string[]>([]);
  const colliderVisible = ref(true);
  const navMeshVisible = ref(true);
  const navMode = ref<NavGenerationMode>('floor_field');
  const cameraType = ref<StorageDemoCameraType>('fly');
  const cameraInfo = ref<StorageDemoCameraInfo>(emptyCameraInfo());
  const cameraInfoCopyText = computed(() => {
    const info = cameraInfo.value;
    const p = info.position;
    const e = info.eulerDegrees;
    let text =
      `pos=[${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}] ` +
      `eulerDeg=[${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)}] ` +
      `mode=${info.mode}`;
    if (info.orbit) {
      text +=
        ` orbit=[alpha=${info.orbit.alpha.toFixed(4)},beta=${info.orbit.beta.toFixed(4)},` +
        `radius=${info.orbit.radius.toFixed(3)}]`;
    }
    return text;
  });
  const navPhase = ref<StorageDemoNavPhase>('idle');
  const navSettings = ref<StreamedNavSettings>({ ...DEFAULT_STREAMED_NAV_SETTINGS });
  const voxelNavSettings = ref<VoxelCollisionNavSettings>({ ...DEFAULT_VOXEL_NAV_SETTINGS });
  const selectionRegionVisible = ref(false);
  const navArtifactBundle = shallowRef<NavArtifactBundle | null>(null);
  const hasNavArtifactBundle = computed(() => navArtifactBundle.value !== null);
  const activeNavigationMode = ref<ActiveNavigationMode>(DEFAULT_ACTIVE_NAVIGATION_MODE);
  const liveBackend = ref<LiveNavBackend>('none');
  const navCapabilities = computed<NavCapabilities>(() =>
    navCapabilitiesFromBundle(navArtifactBundle.value)
  );
  /** In-memory hot-swap cache (mirrors last pack / run). */
  let sessionVolume: CollisionVoxelVolume | null = null;
  let sessionRecastBin: Uint8Array | null = null;
  let sessionSeed: number[] | null = null;
  let sessionSpawn: [number, number, number] | null = null;
  const streamVisualRotation = ref<EulerAxes>({ x: 0, y: 0, z: 0 });
  const navPlyRotation = ref<EulerAxes>({ x: 0, y: 0, z: 0 });
  const streamVisualRotationLabel = computed(() => eulerDegreesLabel(streamVisualRotation.value));
  const navPlyRotationLabel = computed(() => eulerDegreesLabel(navPlyRotation.value));
  /** Absolute euler applied after the next stream load (overrides mesh capture). */
  let pendingStreamOrientation: EulerAxes | null = null;
  /** Absolute fly pose applied on next settle instead of auto-frame. */
  let pendingInitialFlyPose: StorageDemoInitialFlyPose | null = null;
  /** Persists across settle for Fast Nav pin + view restore (Oval / Apply from camera). */
  let pendingCameraSelect: CameraSelectRegionInput | null = null;
  const cameraSelectOffsets = ref<CameraSelectRegionOffsets>({
    ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  });
  let cameraInfoPanelOpen = false;
  let cameraInfoRafId = 0;
  const statusMessage = ref('Ready — load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.');
  let lastSourceLabel: string | null = null;
  const streamSettings = ref<StreamSettings>({ ...DEFAULT_STREAM_SETTINGS });
  const streamResidency = ref<StreamResidencyStats | null>(null);
  const streamPerformanceMode = computed({
    get: () => streamSettings.value.performanceMode,
    set: (enabled: boolean) => {
      streamSettings.value = applyStreamPerformanceMode(enabled, streamSettings.value);
    },
  });
  const streamQualityPreset = computed({
    get: () => streamSettings.value.preset,
    set: (preset: StreamQualityPreset) => {
      streamSettings.value = applyStreamQualityPreset(preset, streamSettings.value);
    },
  });
  const summary = shallowRef<SogLodManifestSummary | null>(null);

  /** Last selection-region AABB so hide→show can restore the user's box. */
  let cachedSelectionRegion: { min: number[]; max: number[] } | null = null;

  const rendererPreference = ref<BabylonRendererPreference>(parseRendererPreference());
  const activeRenderer = ref<BabylonRendererActual | null>(null);
  let engine: AbstractEngine | null = null;
  let scene: BabylonScene | null = null;
  let initSceneInFlight: Promise<void> | null = null;
  let camera: FreeCamera | ArcRotateCamera | null = null;
  let flyCameraDispose: (() => void) | null = null;
  let orbitCameraDispose: (() => void) | null = null;
  let gaussianStream: GaussianSplattingStream | null = null;
  let streamDispose: (() => void) | null = null;
  let skipLoggerDispose: (() => void) | null = null;
  let motionDecodeDispose: (() => void) | null = null;
  let viewer: Viewer | null = null;
  let streamManifest: ISOGLODMetadata | null = null;
  let streamAccess: StreamedBundleAccess | null = null;
  let cachedPly: Uint8Array | null = null;
  let cachedPlySplatCount = 0;
  let cachedMaterializeKey: string | null = null;
  /** True when region materialize was empty/sparse and we rematerialized globally. */
  let regionMaterializeFellBackToGlobal = false;
  /** When true, empty/sparse region materialize throws instead of global fallback. */
  let requireRegionCoverageForMaterialize = false;

  const stopCameraInfoSampling = (): void => {
    if (cameraInfoRafId !== 0) {
      cancelAnimationFrame(cameraInfoRafId);
      cameraInfoRafId = 0;
    }
  };

  const resolveActiveDemoCamera = (): FreeCamera | ArcRotateCamera | null => {
    const active = viewer?.getScene().activeCamera ?? camera ?? scene?.activeCamera ?? null;
    if (active instanceof FreeCameraCtor || active instanceof ArcRotateCameraCtor) {
      return active;
    }
    return null;
  };

  const sampleCameraInfoOnce = (): void => {
    const active = resolveActiveDemoCamera();
    if (!active) {
      cameraInfo.value = emptyCameraInfo();
      return;
    }
    const isOrbit = active instanceof ArcRotateCameraCtor;
    cameraInfo.value = {
      eulerDegrees: {
        x: active.rotation.x * RAD_TO_DEG,
        y: active.rotation.y * RAD_TO_DEG,
        z: active.rotation.z * RAD_TO_DEG,
      },
      mode: isOrbit ? 'orbit' : 'fly',
      orbit: isOrbit
        ? {
            alpha: active.alpha,
            beta: active.beta,
            radius: active.radius,
          }
        : null,
      position: {
        x: active.position.x,
        y: active.position.y,
        z: active.position.z,
      },
    };
  };

  const tickCameraInfoSampling = (): void => {
    if (!cameraInfoPanelOpen) {
      cameraInfoRafId = 0;
      return;
    }
    sampleCameraInfoOnce();
    cameraInfoRafId = requestAnimationFrame(tickCameraInfoSampling);
  };

  const setCameraInfoPanelOpen = (open: boolean): void => {
    cameraInfoPanelOpen = open;
    if (!open) {
      stopCameraInfoSampling();
      return;
    }
    if (cameraInfoRafId !== 0) {
      return;
    }
    sampleCameraInfoOnce();
    cameraInfoRafId = requestAnimationFrame(tickCameraInfoSampling);
  };

  const addLog = (message: string): void => {
    logs.value = [...logs.value, message].slice(-80);
  };

  const clearStreamResources = (): void => {
    if (motionDecodeDispose) {
      motionDecodeDispose();
      motionDecodeDispose = null;
    }
    if (skipLoggerDispose) {
      skipLoggerDispose();
      skipLoggerDispose = null;
    }
    if (streamDispose) {
      streamDispose();
      streamDispose = null;
    }
    gaussianStream = null;
  };

  const setStreamQualityPreset = (preset: StreamQualityPreset): void => {
    streamSettings.value = applyStreamQualityPreset(preset, streamSettings.value);
    addLog(
      `Stream quality preset → ${preset} (${streamQualityPresetResidentSplats(preset).toLocaleString()} budget). Re-load stream to apply.`
    );
  };

  const setStreamPerformanceMode = (enabled: boolean): void => {
    streamSettings.value = applyStreamPerformanceMode(enabled, streamSettings.value);
    addLog(
      `Performance Mode → ${enabled ? 'on' : 'off'} ` +
        `(${streamSettings.value.maxResidentSplats.toLocaleString()} budget / ` +
        `${streamSettings.value.memoryBudgetMb} MB). Re-load stream to apply.`
    );
  };

  const resetStreamSettings = (): void => {
    streamSettings.value = { ...DEFAULT_STREAM_SETTINGS };
    addLog(
      'Stream settings reset to Performance Mode on defaults (2M/192). Re-load stream to apply.'
    );
  };

  const disposeViewer = (): void => {
    if (!viewer) {
      return;
    }
    viewer.getScene().getEngine().stopRenderLoop();
    viewer.getScene().getEngine().dispose();
    viewer = null;
    hasColliderMesh.value = false;
    hasNavMesh.value = false;
    hasNavSession.value = false;
    colliderVisible.value = false;
    navMeshVisible.value = true;
  };

  const disposeEngineAndScene = (): void => {
    disposeViewer();
    clearSceneStreams();
    if (flyCameraDispose) {
      flyCameraDispose();
      flyCameraDispose = null;
    }
    if (orbitCameraDispose) {
      orbitCameraDispose();
      orbitCameraDispose = null;
    }
    window.removeEventListener('resize', resize);
    engine?.stopRenderLoop();
    engine?.dispose();
    engine = null;
    scene = null;
    camera = null;
    activeRenderer.value = null;
  };

  const initScene = async (): Promise<void> => {
    if (engine || viewer || !canvasRef.value) {
      return;
    }
    if (initSceneInFlight) {
      await initSceneInFlight;
      return;
    }
    const canvas = canvasRef.value;
    initSceneInFlight = (async () => {
      const created = await createBabylonEngine({
        canvas,
        preference: rendererPreference.value,
      });
      engine = created.engine;
      activeRenderer.value = created.renderer;
      scene = new BabylonScene(engine);
      scene.clearColor = new Color3(0.05, 0.05, 0.05).toColor4();

      applyStreamSceneCamera(canvas);

      const light = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
      light.intensity = 0.7;

      engine.runRenderLoop(() => {
        scene?.render();
      });
      window.addEventListener('resize', resize);
      if (created.fallbackFromWebgpu) {
        addLog('[INFO] Renderer: webgl (WebGPU unavailable — fell back)');
      } else {
        addLog(`[INFO] Renderer: ${created.renderer}`);
      }
      addLog(
        `Scene ready (${demoCameraModeLabel(cameraType.value)} · SHIFT = 10× speed)`
      );
    })();
    try {
      await initSceneInFlight;
    } finally {
      initSceneInFlight = null;
    }
  };

  const setRendererPreference = async (
    preference: BabylonRendererPreference
  ): Promise<void> => {
    if (rendererPreference.value === preference && engine) {
      return;
    }
    rendererPreference.value = preference;
    resetStreamState();
    disposeEngineAndScene();
    await initScene();
    addLog(
      `[INFO] Renderer preference → ${preference}` +
        (preference === 'webgpu' ? ' (falls back to WebGL if unsupported)' : '')
    );
  };

  const applyPendingInitialFlyPoseIfNeeded = (): boolean => {
    if (!pendingInitialFlyPose || !camera) {
      return false;
    }
    if (!(camera instanceof FreeCameraCtor)) {
      // Fly-only preset — drop so orbit settle still auto-frames.
      pendingInitialFlyPose = null;
      return false;
    }
    const pose = pendingInitialFlyPose;
    pendingInitialFlyPose = null;
    const { position, eulerDegrees } = pose;
    camera.position.set(position.x, position.y, position.z);
    camera.rotation.x = eulerDegrees.x * DEG_TO_RAD;
    camera.rotation.y = eulerDegrees.y * DEG_TO_RAD;
    camera.rotation.z = eulerDegrees.z * DEG_TO_RAD;
    addLog(
      `[INFO] Initial fly pose applied: ` +
        `pos=[${position.x.toFixed(3)},${position.y.toFixed(3)},${position.z.toFixed(3)}] ` +
        `eulerDeg=[${eulerDegrees.x.toFixed(1)},${eulerDegrees.y.toFixed(1)},${eulerDegrees.z.toFixed(1)}]`
    );
    return true;
  };

  const frameActiveStreamCamera = (): boolean => {
    if (!scene || !camera) {
      return false;
    }
    if (applyPendingInitialFlyPoseIfNeeded()) {
      return true;
    }
    if (cameraType.value === 'fly') {
      frameFlyCameraToScene(scene, camera as FreeCamera);
      return false;
    }
    frameOrbitCameraToScene(scene, camera as ArcRotateCamera);
    return false;
  };

  const setPendingInitialFlyPose = (pose: StorageDemoInitialFlyPose | null): void => {
    pendingInitialFlyPose = pose
      ? {
          position: { ...pose.position },
          eulerDegrees: { ...pose.eulerDegrees },
        }
      : null;
  };

  const setPendingCameraSelect = (input: CameraSelectRegionInput | null): void => {
    pendingCameraSelect = input
      ? {
          view: {
            position: { ...input.view.position },
            eulerDegrees: { ...input.view.eulerDegrees },
          },
          offsets: input.offsets
            ? { ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS, ...input.offsets }
            : { ...cameraSelectOffsets.value },
        }
      : null;
  };

  const setCameraSelectOffsets = (offsets: Partial<CameraSelectRegionOffsets>): void => {
    cameraSelectOffsets.value = {
      ...cameraSelectOffsets.value,
      ...offsets,
    };
  };

  const resetCameraSelectOffsets = (): void => {
    cameraSelectOffsets.value = { ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS };
  };

  const formatCameraSelectOffsetsLog = (offsets: CameraSelectRegionOffsets): string =>
    `L/R ${offsets.left}/${offsets.right}m · forward ${offsets.forward}m · behind ${offsets.behind}m · ` +
    `below ${offsets.below}m · above ${offsets.above}m`;

  const applySelectRegionFromCamera = async (): Promise<void> => {
    const activeCam = resolveActiveDemoCamera();
    if (!(activeCam instanceof FreeCameraCtor)) {
      addLog('[WARN] Apply select region from camera requires Fly camera mode.');
      return;
    }
    if (!hasStream.value && !viewer) {
      addLog('[WARN] Load a stream before applying a camera select region.');
      return;
    }
    const offsets = { ...cameraSelectOffsets.value };
    const input: CameraSelectRegionInput = {
      view: {
        position: {
          x: activeCam.position.x,
          y: activeCam.position.y,
          z: activeCam.position.z,
        },
        eulerDegrees: {
          x: activeCam.rotation.x * RAD_TO_DEG,
          y: activeCam.rotation.y * RAD_TO_DEG,
          z: activeCam.rotation.z * RAD_TO_DEG,
        },
      },
      offsets,
    };
    setPendingCameraSelect(input);
    let region = regionBoundsFromCameraSelect(input);
    if (navMode.value === 'voxel_collision') {
      const carveHeight = voxelNavSettings.value.collisionCarveHeight;
      const minStairHeight =
        carveHeight + REGION_STAIR_HEADROOM_METERS + REGION_STAIR_FOOTROOM_METERS;
      const currentHeight = region.max[1]! - region.min[1]!;
      if (currentHeight < minStairHeight - 0.05) {
        region = expandRegionForVoxelStairs(region, carveHeight);
        addLog(
          `[INFO] Voxel region Y expanded for stairs/landing: ` +
            `Y [${region.min[1]!.toFixed(2)}, ${region.max[1]!.toFixed(2)}]`
        );
      }
    }
    cachedSelectionRegion = {
      min: [...region.min],
      max: [...region.max],
    };
    addLog(
      `[INFO] Camera select region from live view: ` +
        `${region.min.map((v) => v.toFixed(2)).join(', ')} → ` +
        `${region.max.map((v) => v.toFixed(2)).join(', ')} ` +
        `(${formatCameraSelectOffsetsLog(offsets)})`
    );
    if (viewer) {
      viewer.enableRegionSelection({ min: region.min, max: region.max });
      selectionRegionVisible.value = true;
      return;
    }
    try {
      await setSelectionRegionVisible(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog(`[WARN] Camera select region apply failed: ${message}`);
    }
  };

  const armCameraSelectRegionAfterFlyPose = async (): Promise<void> => {
    if (!pendingCameraSelect) {
      return;
    }
    if (!camera || !(camera instanceof FreeCameraCtor)) {
      addLog(
        '[WARN] Camera select region skipped — fly pose was not applied (need Fly camera).'
      );
      return;
    }
    const input: CameraSelectRegionInput = {
      view: pendingCameraSelect.view,
      offsets: pendingCameraSelect.offsets ?? { ...cameraSelectOffsets.value },
    };
    pendingCameraSelect = input;
    const bounds = regionBoundsFromCameraSelect(input);
    cachedSelectionRegion = {
      min: [...bounds.min],
      max: [...bounds.max],
    };
    addLog(
      `[INFO] Camera select region from view+offsets: ` +
        `${bounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
        `${bounds.max.map((v) => v.toFixed(2)).join(', ')} ` +
        `(${formatCameraSelectOffsetsLog({
          ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
          ...input.offsets,
        })})`
    );
    try {
      await setSelectionRegionVisible(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog(`[WARN] Camera select region arm failed: ${message}`);
    }
  };

  const applyStreamSceneCamera = (canvas: HTMLCanvasElement, preserveView = false): void => {
    if (!scene) {
      return;
    }

    const preservedView =
      preserveView && camera ? captureActiveCameraView(camera) : null;

    flyCameraDispose?.();
    flyCameraDispose = null;
    orbitCameraDispose?.();
    orbitCameraDispose = null;

    if (camera) {
      camera.detachControl();
      camera.dispose();
      camera = null;
    }

    if (preservedView) {
      if (cameraType.value === 'fly') {
        camera = createFlyCameraFromView(scene, 'flyCamera', preservedView);
        flyCameraDispose = configureFlyCamera(camera, canvas);
      } else {
        camera = createOrbitCameraFromView(scene, 'orbitCamera', preservedView);
        orbitCameraDispose = configureOrbitCamera(camera, canvas);
      }
    } else if (cameraType.value === 'fly') {
      camera = new FreeCameraCtor('flyCamera', new Vector3(0, 5, -10), scene);
      camera.setTarget(Vector3.Zero());
      flyCameraDispose = configureFlyCamera(camera, canvas);
    } else {
      camera = new ArcRotateCameraCtor(
        'orbitCamera',
        -Math.PI / 2,
        Math.PI / 2.5,
        10,
        Vector3.Zero(),
        scene
      );
      orbitCameraDispose = configureOrbitCamera(camera, canvas);
    }

    scene.activeCamera = camera;
    if (!preservedView && scene.meshes.length > 0) {
      frameActiveStreamCamera();
    }
    ensureActiveCameraForStream(scene, camera);
  };

  const setCameraType = (type: StorageDemoCameraType): void => {
    if (type !== 'fly' && type !== 'orbit') {
      return;
    }
    if (cameraType.value === type) {
      return;
    }
    cameraType.value = type;
    const canvas = canvasRef.value;
    if (!canvas) {
      return;
    }

    if (viewer) {
      flyCameraDispose?.();
      flyCameraDispose = null;
      orbitCameraDispose?.();
      orbitCameraDispose = null;
      viewer.setCameraMode(type, { preserveView: true });
      if (type === 'fly') {
        const fly = viewer.getScene().activeCamera as FreeCamera | null;
        if (fly) {
          flyCameraDispose = configureFlyCamera(fly, canvas);
        }
      }
      addLog(`[INFO] Camera → ${demoCameraModeLabel(type)}`);
      return;
    }

    if (scene) {
      applyStreamSceneCamera(canvas, true);
      addLog(`[INFO] Camera → ${demoCameraModeLabel(type)}`);
    }
  };

  const setPendingStreamOrientation = (euler: EulerAxes | null): void => {
    pendingStreamOrientation = euler ? { x: euler.x, y: euler.y, z: euler.z } : null;
  };

  const applyStreamAndNavOrientation = (euler: EulerAxes, logSuffix: string): void => {
    streamVisualRotation.value = { ...euler };
    navPlyRotation.value = { ...euler };
    if (viewer) {
      viewer.setStreamVisualRotation(euler);
      viewer.setNavPlyRotation(euler);
    } else {
      applyStreamVisualToSceneMeshes();
    }
    addLog(
      `[INFO] Stream/Nav PLY orientation ${eulerDegreesLabel(euler)} ${logSuffix}`
    );
  };

  /** If an example armed a pending euler, force Stream + Nav PLY to it. */
  const applyPendingStreamOrientationIfNeeded = (): boolean => {
    if (!pendingStreamOrientation) {
      return false;
    }
    const euler = { ...pendingStreamOrientation };
    pendingStreamOrientation = null;
    applyStreamAndNavOrientation(
      euler,
      '(example preset; overrides host default)'
    );
    return true;
  };

  const applyDefaultStreamOrientationForSource = (url: string | null): void => {
    const euler = defaultStreamOrientationForUrl(url);
    let logSuffix = '(local zip default 0,0,0)';
    if (url) {
      try {
        logSuffix =
          new URL(url).hostname === PLAYCANVAS_CDN_HOST
            ? '(PlayCanvas CDN default −90° X)'
            : '(non-PlayCanvas default 0,0,0)';
      } catch {
        logSuffix = '(default 0,0,0)';
      }
    }
    applyStreamAndNavOrientation(euler, logSuffix);
  };

  /**
   * Apply pending or host-based stream orientation, then settle residency / framing.
   * @returns Whether an example pending orientation was applied.
   */
  const settleStreamResidency = async (
    stream: Parameters<typeof awaitStreamResidencyReport>[0]['stream'],
    catalogFiles: number,
    getSkipCount: () => number,
    sourceUrl: string | null
  ): Promise<boolean> => {
    if (!scene || !camera) {
      return false;
    }
    const usedPending = applyPendingStreamOrientationIfNeeded();
    if (!usedPending) {
      applyDefaultStreamOrientationForSource(sourceUrl);
    }
    const flyPoseApplied = frameActiveStreamCamera();
    const shouldArmCameraSelectRegion = pendingCameraSelect !== null;
    if (shouldArmCameraSelectRegion && !flyPoseApplied) {
      addLog(
        '[WARN] Camera select region skipped — initial fly pose was not applied.'
      );
    }
    ensureActiveCameraForStream(scene, camera);
    const tuning = applySafeStreamRuntimeTuning(stream);
    installSortPostBackpressure({
      minIntervalMs: SORT_POST_MIN_INTERVAL_MS,
      stream,
    });
    installBudgetedTargetLevels(stream);
    if (motionDecodeDispose) {
      motionDecodeDispose();
      motionDecodeDispose = null;
    }
    motionDecodeDispose = installMotionDecodePause({
      getMaxConcurrentDownloads: () => streamSettings.value.maxConcurrentDownloads,
      getMaxDecodesPerFrame: () => streamSettings.value.maxDecodesPerFrame,
      onLog: addLog,
      stream,
    });
    addLog(
      `[INFO] Safe runtime tuning: viewUpdateThreshold=${tuning.viewUpdateThreshold} ` +
        `shDegree=${tuning.shDegree} disableDepthSort=${tuning.disableDepthSort}; ` +
        `sort backpressure ≥${SORT_POST_MIN_INTERVAL_MS}ms; motion decode pause on; ` +
        `budgeted LOD targets on.`
    );
    statusMessage.value = 'Settling stream residency (camera-framed LOD)…';
    streamResidency.value = await awaitStreamResidencyReport({
      catalogFiles,
      getSkipCount,
      log: addLog,
      stream,
    });
    try {
      assertStreamBufferBounded(stream, catalogFiles, getSkipCount());
      addLog('[SUCCESS] Work buffer bounded (eviction on, capacity ≤ budget).');
    } catch (error) {
      if (error instanceof UnboundedStreamBufferError) {
        addLog(`[ERROR] ${error.message}`);
        clearStreamResources();
        resetStreamState();
        throw error;
      }
      throw error;
    }
    if (shouldArmCameraSelectRegion && flyPoseApplied) {
      await armCameraSelectRegionAfterFlyPose();
    }
    return usedPending;
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

  const resetStreamState = (): void => {
    streamManifest = null;
    streamAccess = null;
    gaussianStream = null;
    cachedPly = null;
    cachedPlySplatCount = 0;
    cachedMaterializeKey = null;
    regionMaterializeFellBackToGlobal = false;
    requireRegionCoverageForMaterialize = false;
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

  const goToPlayer = (): void => {
    if (!viewer || liveBackend.value === 'none') {
      addLog('[WARN] Go to Player: no live player agent.');
      return;
    }
    const framing = viewer.focusOnPlayer();
    if (framing) {
      addLog(
        `[SUCCESS] Go to Player — top-down at ` +
          `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
      );
      return;
    }
    addLog('[WARN] Go to Player: focusOnPlayer returned null.');
  };

  const clear = (): void => {
    setCameraInfoPanelOpen(false);
    cameraInfo.value = emptyCameraInfo();
    disposeViewer();
    clearSceneStreams();
    resetStreamState();
    pendingStreamOrientation = null;
    pendingInitialFlyPose = null;
    pendingCameraSelect = null;
    cameraSelectOffsets.value = { ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS };
    cachedSelectionRegion = null;
    selectionRegionVisible.value = false;
    regionMaterializeFellBackToGlobal = false;
    navArtifactBundle.value = null;
    clearSessionNavCache();
    lastSourceLabel = null;
    errorMessage.value = null;
    if (!engine && canvasRef.value) {
      void initScene();
    }
    statusMessage.value = 'Cleared. Load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.';
    addLog('Scene cleared');
  };

  const clearSessionNavCache = (): void => {
    sessionVolume = null;
    sessionRecastBin = null;
    sessionSeed = null;
    sessionSpawn = null;
    liveBackend.value = 'none';
  };

  const syncSessionCacheFromBundle = (
    bundle: NavArtifactBundle,
    live: Exclude<LiveNavBackend, 'none'>,
    seed?: readonly number[] | null,
    spawn?: readonly [number, number, number] | null
  ): void => {
    navArtifactBundle.value = bundle;
    sessionVolume = volumeFromNavArtifactBundle(bundle);
    sessionRecastBin =
      bundle.recastNavmeshBin && bundle.recastNavmeshBin.byteLength > 0
        ? bundle.recastNavmeshBin
        : null;
    if (seed && seed.length >= 3) {
      sessionSeed = [seed[0]!, seed[1]!, seed[2]!];
    }
    if (spawn && spawn.length >= 3) {
      sessionSpawn = [spawn[0], spawn[1], spawn[2]];
    }
    liveBackend.value = live;
    voxelNavSettings.value = {
      ...voxelNavSettings.value,
      locomotionMode: live === 'recast_crowd' ? 'recast_crowd' : 'voxel_walk',
    };
  };

  const isActiveNavigationModeEnabled = (mode: ActiveNavigationMode): boolean => {
    if (busy.value) {
      return false;
    }
    if (navMode.value === 'floor_field') {
      return mode === 'recast';
    }
    // Voxel collision: all three are selectable as Run Nav intent; hot-swap gated inside setter.
    return true;
  };

  const activeNavigationModeDisabledReason = (mode: ActiveNavigationMode): string | null => {
    if (busy.value) {
      return 'Wait for the current job to finish.';
    }
    if (navMode.value === 'floor_field' && mode !== 'recast') {
      return 'Floor field generation only produces Recast. Switch Nav generation to voxel collision for Voxel mesh / dual-ready.';
    }
    if (liveBackend.value !== 'none' && !isActiveModeAvailable(mode, navCapabilities.value)) {
      if (mode === 'recast_and_voxel_mesh') {
        return activeModeUnavailableReason(mode, navCapabilities.value);
      }
      // Still selectable as next-run intent under voxel_collision.
      return null;
    }
    return null;
  };

  const setActiveNavigationMode = async (mode: ActiveNavigationMode): Promise<void> => {
    if (busy.value) {
      addLog('[WARN] Active navigation mode ignored — busy.');
      return;
    }
    if (!isActiveNavigationModeEnabled(mode)) {
      addLog(
        `[WARN] Active ${activeNavigationModeLabel(mode)} unavailable: ` +
          `${activeNavigationModeDisabledReason(mode) ?? 'not available'}`
      );
      return;
    }

    const previous = activeNavigationMode.value;
    activeNavigationMode.value = mode;
    addLog(
      `[INFO] Active navigation mode → ${activeNavigationModeLabel(mode)}` +
        (previous !== mode ? ` (was ${activeNavigationModeLabel(previous)})` : '') +
        '.'
    );

    // Desired-only before a live session (no hot-swap target yet).
    if (!viewer || liveBackend.value === 'none') {
      addLog('[INFO] Applies on next Run Nav / upload.');
      return;
    }

    const caps = navCapabilities.value;

    // Dual-ready confirmation: keep current live backend.
    if (mode === 'recast_and_voxel_mesh') {
      if (caps.hasVolume && caps.hasRecast) {
        addLog(
          `[INFO] Dual-ready confirmed (live ${liveNavBackendLabel(liveBackend.value)}). ` +
            'Switch to Recast or Voxel mesh to hot-swap.'
        );
        return;
      }
      addLog(
        '[INFO] Dual-ready not in session yet — re-run Nav under voxel collision to bake volume + Recast.'
      );
      return;
    }

    const targetLive: Exclude<LiveNavBackend, 'none'> =
      mode === 'recast' ? 'recast_crowd' : 'voxel_walk';

    if (liveBackend.value === targetLive) {
      addLog(`[INFO] Already live on ${liveNavBackendLabel(targetLive)}.`);
      return;
    }

    if (targetLive === 'recast_crowd' && !sessionRecastBin) {
      addLog('[WARN] No Recast bin cached — re-run Nav with Recast (or Recast + voxel mesh).');
      return;
    }
    if (targetLive === 'voxel_walk' && !sessionVolume) {
      addLog('[WARN] No volume cached — re-run Nav with Voxel mesh (or Recast + voxel mesh).');
      return;
    }

    if (navPhase.value !== 'done') {
      addLog('[WARN] Hot-swap ignored — nav session not ready (phase=' + navPhase.value + ').');
      return;
    }

    busy.value = true;
    try {
      const feetWorld = viewer.getPlayerFeetWorld();
      const seedFromPlayer =
        feetWorld != null
          ? ([
              viewer.worldNavPointToOriented(feetWorld).x,
              viewer.worldNavPointToOriented(feetWorld).y,
              viewer.worldNavPointToOriented(feetWorld).z,
            ] as [number, number, number])
          : null;
      const seed = seedFromPlayer ?? sessionSeed;
      const spawnHint =
        sessionSpawn ??
        (feetWorld
          ? ([feetWorld.x, feetWorld.y, feetWorld.z] as [number, number, number])
          : null);

      statusMessage.value = `Switching Active → ${activeNavigationModeLabel(mode)}…`;
      const activated = await activateNavBackend({
        backend: targetLive,
        onLog: addLog,
        recastBin: sessionRecastBin,
        seed,
        spawnHint,
        viewer,
        volume: sessionVolume,
      });
      liveBackend.value = activated.liveBackend;
      voxelNavSettings.value = {
        ...voxelNavSettings.value,
        locomotionMode:
          activated.liveBackend === 'recast_crowd' ? 'recast_crowd' : 'voxel_walk',
      };
      hasNavMesh.value = true;
      hasNavSession.value = true;
      viewer.setNavMeshVisible(navMeshVisible.value);
      viewer.setColliderVisible(colliderVisible.value);
      viewer.startNavSessionRuntime(gaussianStream);
      const framing = viewer.focusOnPlayer();
      if (framing) {
        addLog(
          `[SUCCESS] Top-down view above player at ` +
            `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      }
      statusMessage.value =
        activated.liveBackend === 'recast_crowd'
          ? 'Live: Recast crowd. Click the green navmesh to move.'
          : 'Live: Voxel walk. Click splats, walls, or ceilings to move.';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      addLog(`[ERROR] Active hot-swap failed: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  const clearNavArtifacts = (): void => {
    navArtifactBundle.value = null;
    clearSessionNavCache();
    hasNavMesh.value = false;
    hasNavSession.value = false;
    hasColliderMesh.value = false;
    cachedSelectionRegion = null;
    selectionRegionVisible.value = false;
    navPhase.value = 'idle';
    if (viewer) {
      viewer.clearNavArtifacts();
    }
    statusMessage.value =
      'Nav artifacts cleared. Upload a pack or re-run Fast Nav — stream stays loaded.';
    addLog(
      `Nav artifacts cleared (stream kept; Active desired=${activeNavigationModeLabel(activeNavigationMode.value)})`
    );
  };

  const downloadNavArtifacts = (): void => {
    const bundle = navArtifactBundle.value;
    if (!bundle) {
      addLog('[WARN] No nav artifact pack — run voxel collision nav first.');
      return;
    }
    const slug = navArtifactSlugFromSource(lastSourceLabel);
    downloadNavArtifactZip({ bundle, slug });
    addLog(`[SUCCESS] Downloaded nav-artifacts-${slug}.zip`);
  };

  const uploadNavArtifacts = async (files: File[] | FileList): Promise<void> => {
    const list = Array.from(files);
    addLog(
      `[INFO] Uploading nav artifacts (${list.length} file${list.length === 1 ? '' : 's'}: ` +
        `${list.map((f) => f.name).join(', ') || '(none)'})…`
    );
    if (!hasStream.value && !viewer) {
      const message = 'Load a CDN lod-meta or zip stream before uploading nav artifacts.';
      errorMessage.value = message;
      addLog(`[ERROR] ${message}`);
      throw new Error(message);
    }
    busy.value = true;
    errorMessage.value = null;
    try {
      const parsed = await parseNavArtifactFiles(list);
      addLog(
        `[INFO] Parsed pack: locomotion=${parsed.session.locomotionMode}` +
          (parsed.bundle.recastNavmeshBin ? ', recast.navmesh.bin' : '') +
          (parsed.volume ? ', volume trio' : '') +
          (parsed.bundle.collisionGlb ? ', collision.glb' : '')
      );
      const { activeViewer } = await ensureViewerWithPly({ trackMaterializePhase: false });
      activeViewer.clearNavArtifacts();
      const showRegion = selectionRegionVisible.value;
      const applied = await applyNavArtifactsToViewer({
        onLog: addLog,
        parsed,
        showSelectionRegion: showRegion,
        viewer: activeViewer,
      });
      if (applied.restoredRegion) {
        cachedSelectionRegion = {
          min: [...applied.restoredRegion.min],
          max: [...applied.restoredRegion.max],
        };
      }
      // Keep UI toggle authoritative — never leave a yellow box when toggle is off.
      if (!showRegion) {
        activeViewer.disableRegionSelection();
        selectionRegionVisible.value = false;
      } else if (applied.restoredRegion) {
        selectionRegionVisible.value = true;
      }
      const live: Exclude<LiveNavBackend, 'none'> =
        applied.locomotionMode === 'recast_crowd' ? 'recast_crowd' : 'voxel_walk';
      syncSessionCacheFromBundle(
        parsed.bundle,
        live,
        parsed.session.collisionSeed ?? null,
        parsed.session.playerSpawn ??
          (applied.playerSpawn
            ? [applied.playerSpawn.x, applied.playerSpawn.y, applied.playerSpawn.z]
            : null)
      );
      const caps = navCapabilitiesFromBundle(parsed.bundle);
      activeNavigationMode.value =
        parsed.session.activeNavigationMode ??
        activeModeFromCapabilities(caps, parsed.session.locomotionMode);
      hasNavMesh.value = true;
      hasNavSession.value = true;
      navMeshVisible.value = true;
      activeViewer.setNavMeshVisible(true);
      activeViewer.setColliderVisible(colliderVisible.value);
      activeViewer.startNavSessionRuntime(gaussianStream);
      hasColliderMesh.value = Boolean(
        parsed.bundle.collisionGlb && parsed.bundle.collisionGlb.byteLength > 0
      );
      navPhase.value = 'done';
      statusMessage.value =
        live === 'recast_crowd'
          ? `Nav artifacts restored (Active ${activeNavigationModeLabel(activeNavigationMode.value)} · live Recast). Click green navmesh.`
          : `Nav artifacts restored (Active ${activeNavigationModeLabel(activeNavigationMode.value)} · live Voxel walk). Click to move.`;
      addLog(
        `[SUCCESS] Uploaded nav artifacts — Active ${activeNavigationModeLabel(activeNavigationMode.value)}, ` +
          `live ${liveNavBackendLabel(live)}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      addLog(`[ERROR] Upload nav artifacts failed: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  const loadCdn = async (url: string): Promise<void> => {
    disposeViewer();
    if (!scene || !camera) {
      await initScene();
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
      gaussianStream = result.stream;
      summary.value = result.summary;
      fileCount.value = result.summary.filenameCount;
      hasStream.value = true;
      lastSourceLabel = url;
      navArtifactBundle.value = null;
      clearSessionNavCache();
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
        skipLogger.getSkipCount,
        url
      );
      assertStreamEnvironmentLoaded({
        environmentPath: result.summary.environment,
        stream: result.stream,
      });
      const residency = streamResidency.value;
      statusMessage.value =
        `CDN stream ready · ${result.summary.lodLevels} LOD levels · ` +
        (residency
          ? formatStreamResidencyStatus(residency)
          : `budget ${(result.streamOptions.maxResidentSplats ?? 0).toLocaleString()}`) +
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
      await initScene();
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
      gaussianStream = result.stream;
      summary.value = result.summary;
      fileCount.value = result.fileCount;
      lastSourceLabel = file.name;
      navArtifactBundle.value = null;
      clearSessionNavCache();
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
      await settleStreamResidency(
        result.stream,
        result.summary.filenameCount,
        skipLogger.getSkipCount,
        null
      );
      assertStreamEnvironmentLoaded({
        environmentPath: result.summary.environment,
        stream: result.stream,
      });
      const residency = streamResidency.value;
      statusMessage.value =
        `Local zip stream ready · ${result.summary.lodLevels} LOD levels · ` +
        (residency
          ? formatStreamResidencyStatus(residency)
          : `budget ${(result.streamOptions.maxResidentSplats ?? 0).toLocaleString()}`) +
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

  const padRawSogRegion = (raw: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }): { min: [number, number, number]; max: [number, number, number] } => {
    const pad = RAW_SOG_REGION_PAD_METERS;
    return {
      min: [raw.min[0] - pad, raw.min[1] - pad, raw.min[2] - pad],
      max: [raw.max[0] + pad, raw.max[1] + pad, raw.max[2] + pad],
    };
  };

  /** Live yellow-box only — never clip from cachedSelectionRegion while region is OFF. */
  const resolveRawSogRegionForMaterialize = (): {
    min: [number, number, number];
    max: [number, number, number];
  } | null => {
    const fromViewer = viewer?.getRawSogRegionBounds();
    if (!fromViewer) {
      return null;
    }
    return padRawSogRegion({
      min: fromViewer.min as [number, number, number],
      max: fromViewer.max as [number, number, number],
    });
  };

  const buildMaterializeCacheKey = (forVoxelCollision: boolean): string => {
    const raw = forVoxelCollision ? resolveRawSogRegionForMaterialize() : null;
    if (forVoxelCollision && raw) {
      return `voxel_region:${raw.min.join(',')}:${raw.max.join(',')}`;
    }
    if (forVoxelCollision) {
      return 'voxel_global';
    }
    return 'floor_field';
  };

  const ensureMaterializedPly = async (options?: {
    requireRegionCoverage?: boolean;
  }): Promise<Uint8Array> => {
    const requireRegion =
      options?.requireRegionCoverage === true || requireRegionCoverageForMaterialize;
    const forVoxelCollision = navMode.value === 'voxel_collision';
    const rawRegion = forVoxelCollision ? resolveRawSogRegionForMaterialize() : null;
    const useRegionCoverage = forVoxelCollision && rawRegion !== null;
    const minSplats = useRegionCoverage
      ? VOXEL_REGION_MIN_SPLATS
      : forVoxelCollision
        ? VOXEL_NAV_MIN_SPLATS
        : DEFAULT_NAV_MIN_SPLATS;
    const maxSplats = forVoxelCollision ? VOXEL_NAV_MAX_SPLATS : DEFAULT_NAV_MAX_SPLATS;
    const cacheKey = buildMaterializeCacheKey(forVoxelCollision);

    if (cachedPly && cachedMaterializeKey === cacheKey && cachedPlySplatCount >= minSplats) {
      if (useRegionCoverage) {
        regionMaterializeFellBackToGlobal = false;
      }
      return cachedPly;
    }
    if (cachedPly && (cachedMaterializeKey !== cacheKey || cachedPlySplatCount < minSplats)) {
      addLog(
        `[INFO] Rematerializing nav PLY` +
          (cachedMaterializeKey !== cacheKey ? ' (selection region or nav mode changed)' : '') +
          (cachedPlySplatCount < minSplats ? ` (need ≥ ${minSplats.toLocaleString()} splats)` : '') +
          '.'
      );
      cachedPly = null;
      cachedPlySplatCount = 0;
      cachedMaterializeKey = null;
    }
    if (!streamManifest || !streamAccess) {
      throw new Error('Load a streamed SOG (CDN or zip) before generating collision / navmesh.');
    }
    const decodeScene = scene ?? viewer?.getScene() ?? null;
    if (!decodeScene) {
      throw new Error('Scene is not initialized for SOG decode.');
    }

    const materializeGlobal = async (): Promise<Uint8Array> => {
      statusMessage.value = 'Materializing nav PLY (intermediary for WASM; stream visual kept)…';
      const globalMin = forVoxelCollision ? VOXEL_NAV_MIN_SPLATS : DEFAULT_NAV_MIN_SPLATS;
      const globalMax = forVoxelCollision ? VOXEL_NAV_MAX_SPLATS : DEFAULT_NAV_MAX_SPLATS;
      const result = await materializeNavSourceFromStreamedSog({
        access: streamAccess!,
        metadata: streamManifest!,
        options: {
          lodIndex: 'nav',
          maxSplats: globalMax,
          minSplats: globalMin,
          onProgress: addLog,
        },
        scene: decodeScene,
      });
      cachedPly = result.plyBytes;
      cachedPlySplatCount = result.splatCount;
      cachedMaterializeKey = forVoxelCollision ? 'voxel_global' : 'floor_field';
      addLog(
        `Materialized LOD ${result.lodIndexUsed}: ${result.splatCount.toLocaleString()} splats → PLY (nav intermediary)`
      );
      if (result.splatCount < DEFAULT_NAV_MIN_SPLATS) {
        addLog(
          `[WARN] Only ${result.splatCount} splats after finest LOD (target ${DEFAULT_NAV_MIN_SPLATS}). Floor extraction may still fail on sparse outdoor scans.`
        );
      }
      return cachedPly;
    };

    const isEmptyRegionMaterializeError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('No splats decoded');
    };

    statusMessage.value = 'Materializing nav PLY (intermediary for WASM; stream visual kept)…';

    if (useRegionCoverage && rawRegion) {
      try {
        const result = await materializeNavSourceFromStreamedSog({
          access: streamAccess,
          metadata: streamManifest,
          options: {
            fullRegionCoverage: true,
            lodIndex: 'finest',
            onProgress: addLog,
            regionCoverage: rawRegion,
          },
          scene: decodeScene,
        });
        if (result.splatCount >= VOXEL_REGION_MIN_SPLATS) {
          regionMaterializeFellBackToGlobal = false;
          cachedPly = result.plyBytes;
          cachedPlySplatCount = result.splatCount;
          cachedMaterializeKey = cacheKey;
          addLog(
            `Materialized LOD ${result.lodIndexUsed}: ${result.splatCount.toLocaleString()} splats → PLY (full density in pinned region)`
          );
          return cachedPly;
        }
        if (requireRegion) {
          throw new Error(
            `Selection region kept ${result.splatCount.toLocaleString()} splats ` +
              `(need ≥ ${VOXEL_REGION_MIN_SPLATS.toLocaleString()}). ` +
              'Move the yellow box onto walkable floor splats and re-run Nav.'
          );
        }
        addLog(
          `[WARN] Selection region kept ${result.splatCount.toLocaleString()} splats ` +
            `(< ${VOXEL_REGION_MIN_SPLATS.toLocaleString()}) — falling back to full-scene materialize; ` +
            'WASM region pin omitted for this run.'
        );
      } catch (error) {
        if (requireRegion) {
          if (error instanceof Error && error.message.includes('Move the yellow box')) {
            throw error;
          }
          if (isEmptyRegionMaterializeError(error)) {
            throw new Error(
              'Selection region yielded no splats. Move the yellow box onto walkable floor splats and re-run Nav.'
            );
          }
          throw error;
        }
        if (!isEmptyRegionMaterializeError(error)) {
          throw error;
        }
        addLog(
          '[WARN] Selection region yielded no splats — falling back to full-scene materialize; ' +
            'WASM region pin omitted for this run.'
        );
      }
      regionMaterializeFellBackToGlobal = true;
      return materializeGlobal();
    }

    if (requireRegion) {
      throw new Error(
        'Selection region is required for this scene size, but no live yellow box was found. ' +
          'Enable Selection region and place the box on walkable floor.'
      );
    }

    regionMaterializeFellBackToGlobal = false;
    return materializeGlobal();
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

    const adoptedCamera = camera;
    const preserveFlyCamera =
      cameraType.value === 'fly' && adoptedCamera instanceof FreeCameraCtor
        ? adoptedCamera
        : undefined;
    if (adoptedCamera) {
      flyCameraDispose?.();
      flyCameraDispose = null;
      orbitCameraDispose?.();
      orbitCameraDispose = null;
      adoptedCamera.detachControl();
    }

    const adoptedEngine = engine;
    const adoptedScene = scene;
    engine = null;
    scene = null;
    camera = null;

    await splatwalk.init();
    viewer = new Viewer(canvas, {
      existing: {
        engine: adoptedEngine,
        preserveFlyCamera,
        preserveVisual: true,
        scene: adoptedScene,
      },
    });
    if (preserveFlyCamera) {
      flyCameraDispose = configureFlyCamera(preserveFlyCamera, canvas);
    }
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
        await initScene();
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

  const ensureViewerWithPly = async (options?: {
    trackMaterializePhase?: boolean;
  }): Promise<{ plyBytes: Uint8Array; activeViewer: Viewer }> => {
    const needsMaterialize = !(cachedPly && cachedPlySplatCount >= DEFAULT_NAV_MIN_SPLATS);
    if (options?.trackMaterializePhase && needsMaterialize) {
      navPhase.value = 'materialize';
      statusMessage.value = 'Materializing nav PLY (intermediary for WASM; stream visual kept)…';
    }
    const plyBytes = await ensureMaterializedPly();
    if (viewer) {
      viewer.assertGroundLooksYUp();
      return { plyBytes, activeViewer: viewer };
    }
    const activeViewer = await handoffStreamToViewer();
    return { plyBytes, activeViewer };
  };

  const clearNavPlyCache = (): void => {
    cachedPly = null;
    cachedPlySplatCount = 0;
    cachedMaterializeKey = null;
  };

  /** Apply a budget-safe yellow box (clamp XZ), enable gizmo, invalidate PLY cache. */
  const applyBudgetSafeSelectionRegion = ({
    activeViewer,
    reason,
    region,
  }: {
    activeViewer: Viewer;
    reason: string;
    region: { max: number[]; min: number[] };
  }): { max: number[]; min: number[] } => {
    const fillSize = voxelNavSettings.value.collisionFillSize;
    const sceneType = voxelNavSettings.value.collisionSceneType;
    const maxVoxels = 1_200_000;
    const carveHeight = voxelNavSettings.value.collisionCarveHeight;
    const expanded = expandRegionForVoxelStairs(region, carveHeight);
    const clamped = clampRegionToDenseBudget({
      fillSize,
      maxVoxels,
      region: expanded,
      sceneType,
    });
    if (!clamped.fits) {
      throw new Error(
        `${reason} Selection region still exceeds dense voxel budget after clamping to ` +
          `${MAX_AUTO_REGION_FOOTPRINT_METERS}m / fallback footprint. ` +
          'Place a tighter yellow box on walkable floor (≲ 18–25 m).'
      );
    }
    if (clamped.clamped) {
      addLog(
        `[INFO] Clamped selection region XZ to ~${clamped.footprintMeters.toFixed(1)}m ` +
          `(max ${MAX_AUTO_REGION_FOOTPRINT_METERS}m) so the dense voxel grid can fit.`
      );
    }
    const next = { max: [...clamped.max], min: [...clamped.min] };
    cachedSelectionRegion = { max: [...next.max], min: [...next.min] };
    activeViewer.enableRegionSelection({ max: next.max, min: next.min });
    selectionRegionVisible.value = true;
    regionMaterializeFellBackToGlobal = false;
    clearNavPlyCache();
    addLog(
      `[INFO] ${reason} region ` +
        `${next.min.map((v) => v.toFixed(2)).join(', ')} → ` +
        `${next.max.map((v) => v.toFixed(2)).join(', ')} ` +
        `(footprint ~${regionFootprintMeters(next).toFixed(1)}m).`
    );
    return next;
  };

  /**
   * When regionless (or oversized) AABB cannot fit the dense voxel cap,
   * auto-pin/clamp a yellow box, rematerialize region PLY (required), return it.
   */
  const ensureVoxelRegionFitsBudget = async ({
    activeViewer,
    plyBytes,
  }: {
    activeViewer: Viewer;
    plyBytes: Uint8Array;
  }): Promise<Uint8Array> => {
    if (navMode.value !== 'voxel_collision') {
      return plyBytes;
    }

    const fillSize = voxelNavSettings.value.collisionFillSize;
    const sceneType = voxelNavSettings.value.collisionSceneType;
    const rotation = activeViewer.getSplatRotation();
    const liveRegion = activeViewer.getWasmRegionBounds();

    if (liveRegion) {
      const footprint = regionFootprintMeters(liveRegion);
      const maxVoxels = footprint <= 18 ? 2_000_000 : 1_200_000;
      const budget = regionFitsDenseBudget({
        fillSize,
        maxVoxels,
        region: { max: liveRegion.max, min: liveRegion.min },
        sceneType,
      });
      if (budget.fits) {
        return plyBytes;
      }
      addLog(
        `[WARN] Selection region ~${budget.footprintMeters.toFixed(1)}m exceeds dense voxel budget — clamping.`
      );
      applyBudgetSafeSelectionRegion({
        activeViewer,
        reason: 'Clamped',
        region: { max: [...liveRegion.max], min: [...liveRegion.min] },
      });
      requireRegionCoverageForMaterialize = true;
      try {
        statusMessage.value = 'Rematerializing nav PLY inside clamped Selection region…';
        navPhase.value = 'materialize';
        return await ensureMaterializedPly({ requireRegionCoverage: true });
      } finally {
        requireRegionCoverageForMaterialize = false;
      }
    }

    const regionlessMaxVoxels = 1_200_000;
    const splatBounds = await splatwalk.getSplatBounds(plyBytes, {
      mode: 2,
      flip_y: activeViewer.getWasmFlipY(),
      prune_floaters: false,
      rotation: [rotation.x, rotation.y, rotation.z],
    });
    const budget = fitsDenseVoxelBudgetAtMaxCoarseness({
      bounds: { max: splatBounds.oriented_max, min: splatBounds.oriented_min },
      fillSize,
      maxVoxels: regionlessMaxVoxels,
      sceneType,
    });
    if (budget.fits) {
      return plyBytes;
    }

    addLog(
      `[WARN] Full-scene AABB exceeds dense voxel budget ` +
        `(~${budget.footprintMeters.toFixed(1)}m footprint, ` +
        `~${budget.estimatedVoxels.toLocaleString()} voxels at 0.5m > ` +
        `${regionlessMaxVoxels.toLocaleString()}) — auto-enabled Selection region ` +
        `(clamped to ≲ ${MAX_AUTO_REGION_FOOTPRINT_METERS}m). Move/resize if needed.`
    );

    let suggested;
    try {
      suggested = await splatwalk.suggestRegion(plyBytes, {
        ...FAST_NAV_PRESET,
        mode: 2,
        flip_y: activeViewer.getWasmFlipY(),
        prune_floaters: navSettings.value.pruneFloaters,
        rotation: [rotation.x, rotation.y, rotation.z],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        'Full-scene AABB exceeds dense voxel budget and suggestRegion failed. ' +
          'Enable Selection region manually and place the yellow box on walkable floor. ' +
          `(${detail})`
      );
    }

    applyBudgetSafeSelectionRegion({
      activeViewer,
      reason: 'Auto',
      region: {
        max: [...suggested.region_max],
        min: [...suggested.region_min],
      },
    });
    requireRegionCoverageForMaterialize = true;
    try {
      statusMessage.value = 'Rematerializing nav PLY inside auto Selection region…';
      navPhase.value = 'materialize';
      return await ensureMaterializedPly({ requireRegionCoverage: true });
    } finally {
      requireRegionCoverageForMaterialize = false;
    }
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

  const setColliderVisible = (visible: boolean): void => {
    colliderVisible.value = visible;
    viewer?.setColliderVisible(visible);
  };

  const setNavMeshVisible = (visible: boolean): void => {
    navMeshVisible.value = visible;
    viewer?.setNavMeshVisible(visible);
  };

  /** Set nav mode and clear selection region / region-clipped PLY (CDN example switches). */
  const setNavGenerationMode = (mode: NavGenerationMode): void => {
    if (navMode.value !== mode) {
      addLog(`[INFO] Nav generation mode → ${mode}.`);
    }
    navMode.value = mode;
    if (viewer) {
      viewer.disableRegionSelection();
    }
    selectionRegionVisible.value = false;
    cachedSelectionRegion = null;
    clearNavPlyCache();
    regionMaterializeFellBackToGlobal = false;
    requireRegionCoverageForMaterialize = false;
    if (mode === 'floor_field' && activeNavigationMode.value !== 'recast') {
      activeNavigationMode.value = 'recast';
      addLog('[INFO] Active navigation mode → Recast (floor field cannot produce voxel volume).');
    }
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
      // Drop region-clipped PLY so the next nav run rematerializes voxel_global.
      cachedPly = null;
      cachedPlySplatCount = 0;
      cachedMaterializeKey = null;
      regionMaterializeFellBackToGlobal = false;
      if (navMode.value === 'voxel_collision') {
        addLog(
          '[WARN] Selection region OFF — full splat AABB may coarsen voxels under the max-voxel ' +
            'cap and break stairs. Re-enable Selection region for indoor fidelity.'
        );
        addLog('[INFO] Cleared region-clipped nav PLY cache; next Run Nav rematerializes globally.');
      } else {
        addLog('[INFO] Selection region hidden — Fast Nav will auto-select a region.');
      }
      return;
    }

    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly({ trackMaterializePhase: true });
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
        addLog(
          `[INFO] Selection region suggested: ` +
            `${region.min.map((v) => v.toFixed(2)).join(', ')} → ` +
            `${region.max.map((v) => v.toFixed(2)).join(', ')}`
        );
      }
      if (navMode.value === 'voxel_collision') {
        const carveHeight = voxelNavSettings.value.collisionCarveHeight;
        const minStairHeight =
          carveHeight + REGION_STAIR_HEADROOM_METERS + REGION_STAIR_FOOTROOM_METERS;
        const currentHeight = region.max[1]! - region.min[1]!;
        if (currentHeight < minStairHeight - 0.05) {
          region = expandRegionForVoxelStairs(region, carveHeight);
          addLog(
            `[INFO] Voxel region Y expanded (−${REGION_STAIR_FOOTROOM_METERS}m / ` +
              `+${carveHeight + REGION_STAIR_HEADROOM_METERS}m from floor) for stairs/landing: ` +
              `Y [${region.min[1]!.toFixed(2)}, ${region.max[1]!.toFixed(2)}]`
          );
        }
        cachedSelectionRegion = { min: [...region.min], max: [...region.max] };
      } else {
        cachedSelectionRegion = { min: [...region.min], max: [...region.max] };
      }
      activeViewer.enableRegionSelection({ min: region.min, max: region.max });
      selectionRegionVisible.value = true;
      addLog('[INFO] Selection region shown — nav / collision will pin this yellow box.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      selectionRegionVisible.value = false;
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      if (navPhase.value === 'materialize') {
        navPhase.value = 'idle';
      }
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

  const resetVoxelNavSettings = (): void => {
    voxelNavSettings.value = { ...DEFAULT_VOXEL_NAV_SETTINGS };
    addLog('[INFO] Voxel collision nav settings reset to indoor defaults.');
  };

  const buildStreamCollisionSettings = async (
    activeViewer: Viewer,
    plyBytes: Uint8Array,
    options?: { emitGlb?: boolean }
  ) => {
    const rotation = activeViewer.getSplatRotation();
    const omitRegionPin = regionMaterializeFellBackToGlobal;
    const regionBounds = omitRegionPin ? null : activeViewer.getWasmRegionBounds();
    const paddedRegion = regionBounds ? padWasmRegionBounds(regionBounds) : null;
    if (omitRegionPin) {
      addLog(
        '[INFO] Omitting WASM region pin (selection region materialize fell back to full scene).'
      );
    }
    if (paddedRegion) {
      const footprint = regionFootprintMeters(paddedRegion);
      addLog(
        `[INFO] WASM region padded +${RAW_SOG_REGION_PAD_METERS}m (footprint ${footprint.toFixed(1)}m).`
      );
      if (footprint > 25) {
        addLog(
          `[WARN] Large selection (${footprint.toFixed(1)}m) — voxel grid may coarsen and fragment stairs. Tighten the yellow box.`
        );
      }
    }

    // Fail before WASM carve if the effective AABB still cannot fit the dense budget.
    if (navMode.value === 'voxel_collision') {
      const fillSize = voxelNavSettings.value.collisionFillSize;
      const sceneType = voxelNavSettings.value.collisionSceneType;
      const maxVoxels =
        paddedRegion && regionFootprintMeters(paddedRegion) <= 18 ? 2_000_000 : 1_200_000;
      let gateBounds: { max: number[]; min: number[] } | null = paddedRegion
        ? { max: paddedRegion.max, min: paddedRegion.min }
        : null;
      if (!gateBounds) {
        const splatBounds = await splatwalk.getSplatBounds(plyBytes, {
          mode: 2,
          flip_y: activeViewer.getWasmFlipY(),
          prune_floaters: false,
          rotation: [rotation.x, rotation.y, rotation.z],
        });
        gateBounds = {
          max: [...splatBounds.oriented_max],
          min: [...splatBounds.oriented_min],
        };
      }
      const gate = regionFitsDenseBudget({
        fillSize,
        maxVoxels,
        region: gateBounds,
        sceneType,
      });
      if (!gate.fits) {
        throw new Error(
          `Dense voxel budget exceeded before carve (~${gate.footprintMeters.toFixed(1)}m footprint, ` +
            `~${gate.estimatedVoxels.toLocaleString()} voxels at 0.5m > ${maxVoxels.toLocaleString()}). ` +
            `Shrink the yellow Selection region (target ≲ ${MAX_AUTO_REGION_FOOTPRINT_METERS}m). ` +
            'Full-scene dense collision is not supported at this size.'
        );
      }
    }
    const splatEstimate =
      cachedPlySplatCount > 0
        ? cachedPlySplatCount
        : Math.floor(plyBytes.byteLength / 70);
    const useVoxelPrune =
      navSettings.value.pruneFloaters && splatEstimate <= VOXEL_PRUNE_MAX_SPLATS;
    if (
      navMode.value === 'voxel_collision' &&
      navSettings.value.pruneFloaters &&
      !useVoxelPrune
    ) {
      addLog(
        `[WARN] Skipping KNN floater prune for ${splatEstimate.toLocaleString()} splats ` +
          `(>${VOXEL_PRUNE_MAX_SPLATS.toLocaleString()}). Tighten selection region or enable prune on smaller clips.`
      );
    }
    const voxelOpacityBoost =
      navMode.value === 'voxel_collision' && !useVoxelPrune
        ? Math.max(voxelNavSettings.value.collisionOpacityThreshold, 0.12)
        : voxelNavSettings.value.collisionOpacityThreshold;
    const voxelBase =
      navMode.value === 'voxel_collision'
        ? {
            ...voxelNavSettingsToCollisionBase({
              ...voxelNavSettings.value,
              collisionOpacityThreshold: voxelOpacityBoost,
            }),
            prune_floaters: useVoxelPrune,
          }
        : { prune_floaters: navSettings.value.pruneFloaters };
    const carveHeight =
      navMode.value === 'voxel_collision'
        ? voxelNavSettings.value.collisionCarveHeight
        : 1.6;
    const meshSettingsBase = {
      ...FAST_NAV_PRESET,
      mode: 2 as const,
      environment_scale: activeViewer.getEnvironmentScale(),
      flip_y: activeViewer.getWasmFlipY(),
      rotation: [rotation.x, rotation.y, rotation.z] as [number, number, number],
      ...voxelBase,
      ...(paddedRegion
        ? { region_min: paddedRegion.min, region_max: paddedRegion.max }
        : {}),
    };
    const seed = await resolveVoxelCollisionSeed({
      bytes: plyBytes,
      carveHeight,
      ignorePinnedRegion: omitRegionPin,
      meshSettingsBase,
      viewer: activeViewer,
    });
    activeViewer.displaySeedMarker(seed);
    addLog(`[INFO] Collision seed: ${seed.map((v) => v.toFixed(3)).join(', ')}`);

    const regionFootprint = paddedRegion ? regionFootprintMeters(paddedRegion) : 0;
    const useFilterCluster = !paddedRegion || regionFootprint <= 25;

    return buildCollisionBoundarySettings({
      base: {
        ...voxelBase,
        collision_filter_cluster: useFilterCluster,
        collision_max_voxels: regionFootprint > 0 && regionFootprint <= 18 ? 2_000_000 : 1_200_000,
        collision_seed: seed,
        environment_scale: activeViewer.getEnvironmentScale(),
        ...(paddedRegion
          ? { region_min: paddedRegion.min, region_max: paddedRegion.max }
          : {}),
      },
      emitGlb: options?.emitGlb ?? false,
      flipY: activeViewer.getWasmFlipY(),
      rotation: [rotation.x, rotation.y, rotation.z],
      seed,
    });
  };

  const generateCollision = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const ensured = await ensureViewerWithPly({ trackMaterializePhase: true });
      const plyBytes = await ensureVoxelRegionFitsBudget(ensured);
      const activeViewer = ensured.activeViewer;
      statusMessage.value = 'Generating voxel collision boundary…';
      navPhase.value = 'floor';
      const settings = await buildStreamCollisionSettings(activeViewer, plyBytes, { emitGlb: true });
      if (navMode.value === 'voxel_collision') {
        addLog(`[INFO] Collision preview: ${formatVoxelNavSettingsLog(voxelNavSettings.value)}`);
      }
      const artifact = await generateCollisionBoundaryArtifact({ bytes: plyBytes, settings });
      activeViewer.displayColliderMesh(
        artifact.result.mesh.vertices,
        artifact.result.mesh.indices,
        0.35
      );
      activeViewer.setColliderVisible(colliderVisible.value);
      hasColliderMesh.value = true;
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

  const finishNavSession = (
    activeViewer: Viewer,
    navMeshData: Uint8Array,
    successLabel: string,
    options?: { readonly skipFocusOnPlayer?: boolean }
  ): void => {
    if (options?.skipFocusOnPlayer) {
      if (pendingCameraSelect) {
        activeViewer.applyCameraSelectView(pendingCameraSelect.view);
        addLog('[INFO] Restored camera select view after nav (skipped top-down focus).');
      }
    } else {
      statusMessage.value = 'Framing the player (top-down)…';
      const framing = activeViewer.focusOnPlayer();
      if (framing) {
        addLog(
          `[SUCCESS] Top-down view above player at ${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      } else {
        addLog('[WARN] focusOnPlayer returned null; leaving splat framing.');
      }
    }
    activeViewer.resize();
    hasNavMesh.value = true;
    hasNavSession.value = true;
    navMeshVisible.value = true;
    activeViewer.setNavMeshVisible(true);
    activeViewer.setColliderVisible(colliderVisible.value);
    activeViewer.startNavSessionRuntime(gaussianStream);
    navPhase.value = 'done';
    const liveHint =
      liveBackend.value === 'voxel_walk'
        ? 'Click splats, walls, or ceilings to move.'
        : liveBackend.value === 'recast_crowd'
          ? 'Click the green navmesh to move.'
          : 'Click to move.';
    statusMessage.value = `${successLabel} Live: ${liveNavBackendLabel(liveBackend.value)}. ${liveHint}`;
    if (navMeshData.byteLength > 0) {
      addLog(`[SUCCESS] Navmesh ready (${(navMeshData.byteLength / 1024).toFixed(1)} KB).`);
    } else {
      addLog('[SUCCESS] Nav session ready (voxel walk; Recast bin absent or dual-ready pending).');
    }
  };

  const runFastNavFromStream = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly({ trackMaterializePhase: true });
      const settings = navSettings.value;
      statusMessage.value = 'Running Fast Nav…';
      navPhase.value = 'prune';
      addLog(
        `[INFO] Nav settings: prune=${settings.pruneFloaters ? 'on' : 'off'} ` +
          `region=${activeViewer.getWasmRegionBounds() ? 'pinned' : 'auto'} ` +
          `slope=${settings.walkableSlopeAngle}° radius=${settings.walkableRadius}m ` +
          `climb=${settings.walkableClimb}m band=±${settings.sameLevelBelow}/${settings.sameLevelAbove}m ` +
          `sdf=${settings.sdfCellSize}/${settings.sdfDensityThreshold}`
      );
      const tuning = demoNavSettingsToFastNavTuning(settings);
      const cameraSelect = pendingCameraSelect ?? undefined;
      activeNavigationMode.value = 'recast';
      const fastNav = await runFastNav({
        viewer: activeViewer,
        bytes: plyBytes,
        cameraSelect,
        onLog: addLog,
        onPhase: (next) => {
          navPhase.value = next;
        },
        recovery: STREAMED_FAST_NAV_RECOVERY,
        recastAttempts: STREAMED_FAST_NAV_RECAST_ATTEMPTS,
        ...tuning,
        seedCenteredOutdoor: true,
      });
      const spawnTuple: [number, number, number] | null = fastNav.playerSpawn
        ? [fastNav.playerSpawn.x, fastNav.playerSpawn.y, fastNav.playerSpawn.z]
        : null;
      const minimal = buildMinimalNavArtifactBundle({
        navMeshData: fastNav.navMeshData,
        playerSpawn: spawnTuple,
        seed: spawnTuple,
      });
      syncSessionCacheFromBundle(minimal, 'recast_crowd', spawnTuple, spawnTuple);
      finishNavSession(activeViewer, fastNav.navMeshData, 'Fast Nav complete.', {
        skipFocusOnPlayer: fastNav.keptCameraSelectView,
      });
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

  const runVoxelCollisionNavFromStream = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const ensured = await ensureViewerWithPly({ trackMaterializePhase: true });
      const plyBytes = await ensureVoxelRegionFitsBudget(ensured);
      const activeViewer = ensured.activeViewer;
      const settings = navSettings.value;
      const voxel = voxelNavSettings.value;
      const activeMode = activeNavigationMode.value;
      statusMessage.value = 'Running voxel collision nav…';
      navPhase.value = 'floor';
      addLog('[INFO] Nav generation mode: voxel_collision.');
      addLog(
        `[INFO] Active ${activeNavigationModeLabel(activeMode)} — ` +
          `volume → ${
            activeMode === 'recast' ? 'Recast crowd (live)' : 'voxel walk (live)'
          }` +
          (activeMode === 'recast_and_voxel_mesh' ? ' + Recast bake for hot-swap' : '') +
          '.'
      );
      addLog(`[INFO] Voxel settings: ${formatVoxelNavSettingsLog(voxel)}`);
      const pinnedRegion = activeViewer.getWasmRegionBounds();
      if (!pinnedRegion) {
        addLog(
          '[WARN] No selection region — full splat AABB may coarsen voxels under the max-voxel ' +
            'cap and break stairs. Enable Selection region to keep ~0.05 m fidelity indoors.'
        );
      }
      addLog(
        `[INFO] Recast agent: slope=${settings.walkableSlopeAngle}° radius=${settings.walkableRadius}m ` +
          `climb=${settings.walkableClimb}m region=${pinnedRegion ? 'pinned' : 'auto (full AABB)'}`
      );
      const tuning = demoNavSettingsToFastNavTuning(settings);
      // GLBs are synthesized in TS from mesh/volume after carve (WASM emit_glb
      // hard-failed on empty surface meshes for regionless full-AABB builds).
      const collisionSettings = await buildStreamCollisionSettings(activeViewer, plyBytes, {
        emitGlb: false,
      });
      const navResult = await runNavFromVoxelCollider({
        activeNavigationMode: activeMode,
        bytes: plyBytes,
        collisionSettings,
        onLog: addLog,
        onPhase: (next) => {
          navPhase.value = next;
        },
        recastOverrides: {
          walkableClimb: tuning.recastOverrides.walkableClimb,
          walkableSlopeAngle: tuning.recastOverrides.walkableSlopeAngle,
          minRegionArea: tuning.recastOverrides.minRegionArea,
        },
        showColliderOverlay: true,
        colliderVisible: colliderVisible.value,
        viewer: activeViewer,
        voxelSettingsSnapshot: { ...voxel },
      });
      const live: Exclude<LiveNavBackend, 'none'> =
        activeMode === 'recast' ? 'recast_crowd' : 'voxel_walk';
      const spawnTuple: [number, number, number] | null = navResult.playerSpawn
        ? [navResult.playerSpawn.x, navResult.playerSpawn.y, navResult.playerSpawn.z]
        : null;
      syncSessionCacheFromBundle(
        navResult.artifactBundle,
        live,
        spawnTuple,
        spawnTuple
      );
      addLog(
        '[INFO] Nav artifact pack ready — Download nav artifacts for volume + GLB + session JSON.'
      );
      const successLabel = navResult.carveReachTip
        ? `Voxel collision nav complete. Tip: ${navResult.carveReachTip}`
        : 'Voxel collision nav complete.';
      // Voxel path does not go through runFastNav; finishNavSession restores view.
      finishNavSession(activeViewer, navResult.navMeshData, successLabel, {
        skipFocusOnPlayer: pendingCameraSelect !== null,
      });
      hasColliderMesh.value = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      navPhase.value = 'error';
      statusMessage.value = 'Voxel collision nav failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  const runNavFromStream = async (): Promise<void> => {
    if (navMode.value === 'voxel_collision') {
      await runVoxelCollisionNavFromStream();
    } else {
      await runFastNavFromStream();
    }
  };

  onBeforeUnmount(() => {
    setCameraInfoPanelOpen(false);
    window.removeEventListener('resize', resize);
    flyCameraDispose?.();
    flyCameraDispose = null;
    orbitCameraDispose?.();
    orbitCameraDispose = null;
    disposeEngineAndScene();
  });

  return {
    activeNavigationMode,
    activeNavigationModeDisabledReason,
    activeRenderer,
    applySelectRegionFromCamera,
    busy,
    cameraInfo,
    cameraInfoCopyText,
    cameraSelectOffsets,
    cameraType,
    clear,
    clearNavArtifacts,
    debugShowingNavPly,
    downloadNavArtifacts,
    errorMessage,
    fileCount,
    generateCollision,
    goToPlayer,
    colliderVisible,
    hasColliderMesh,
    hasNavArtifactBundle,
    hasNavMesh,
    hasNavSession,
    hasStream,
    initScene,
    isActiveNavigationModeEnabled,
    liveBackend,
    loadCdn,
    loadZip,
    logs,
    navArtifactUploadHint: NAV_ARTIFACT_UPLOAD_HINT,
    navCapabilities,
    navMeshVisible,
    navMode,
    navPhase,
    navPlyRotationLabel,
    navSettings,
    rendererPreference,
    resetNavSettings,
    resetVoxelNavSettings,
    resize,
    restoreStreamVisual,
    rotateNavPly,
    rotateStreamVisual,
    runFastNavFromStream,
    runNavFromStream,
    selectionRegionVisible,
    setActiveNavigationMode,
    setColliderVisible,
    setNavGenerationMode,
    setNavMeshVisible,
    setSelectionRegionVisible,
    setCameraInfoPanelOpen,
    setCameraType,
    setCameraSelectOffsets,
    setPendingInitialFlyPose,
    setPendingCameraSelect,
    setPendingStreamOrientation,
    resetCameraSelectOffsets,
    setRendererPreference,
    setStreamPerformanceMode,
    setStreamQualityPreset,
    showDebugNavPly,
    statusMessage,
    streamPerformanceMode,
    streamQualityPreset,
    streamResidency,
    streamSettings,
    streamVisualRotationLabel,
    resetStreamSettings,
    summary,
    uploadNavArtifacts,
    voxelNavSettings,
  };
};
