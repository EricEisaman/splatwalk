import {
  computed,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';

import { Tools } from '@babylonjs/core';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';

import {
  buildCollisionBoundarySettings,
  exportCollisionBoundaryGlb,
  exportNavmeshBinary,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
  seedFromRegionBounds,
  type CollisionBoundaryArtifact,
} from '@/collision/voxelBoundary';
import type { UseBabylonViewer } from '@/composables/useBabylonViewer';
import {
  DEFAULT_ACTIVE_NAVIGATION_MODE,
  activeNavigationModeDisabledReason as sharedActiveNavigationModeDisabledReason,
  initialLiveBackendForActiveMode,
  liveNavBackendLabel,
  navCapabilitiesFromParts,
  shouldKeepVolumeForActiveMode,
  type ActiveNavigationMode,
  type LiveNavBackend,
  type NavCapabilities,
} from '@/navigation/activeNavigation';
import { applyNavArtifactsToViewer } from '@/navigation/applyNavArtifacts';
import { applyNavKitMetaToViewer } from '@/navigation/applyNavKitMeta';
import {
  DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  regionBoundsFromCameraSelect,
  type CameraSelectRegionInput,
  type CameraSelectRegionOffsets,
} from '@/navigation/cameraSelectRegion';
import { resolveActiveNavigationChange } from '@/navigation/demoActiveNavigation';
import {
  collisionSceneTypeForAlgo,
  type ExampleCollisionSceneType,
} from '@/navigation/exampleSceneCollision';
import {
  readSplatBytes,
  runFastNav,
  type FastNavPhase,
  type FastNavRecoveryConfig,
  type PruneFloatersOptions,
  type StrayTrimOptions,
} from '@/navigation/fastNav';
import {
  buildMinimalNavArtifactBundle,
  downloadNavArtifactZip,
  parseNavArtifactFiles,
  rebuildNavArtifactBundleFromLiveMesh,
  type NavArtifactBundle,
} from '@/navigation/navArtifactBundle';
import { NAV_ARTIFACT_UPLOAD_HINT } from '@/navigation/navArtifactContract';
import {
  DEFAULT_NAV_KIT_CONTROLS_MODE_NEW,
  NAV_KIT_UPLOAD_HINT,
  NAV_KIT_WASDQE_LEGEND,
  type NavKitControlsMode,
} from '@/navigation/navKitContract';
import {
  emptyNavKitCameraPoseInfo,
  emptyNavKitPlayerPoseInfo,
  formatNavKitCameraCopyText,
  formatNavKitPlayerCopyText,
  type NavKitCameraPoseInfo,
  type NavKitPlayerPoseInfo,
} from '@/navigation/navKitPoseInfo';
import {
  downloadNavKitZip,
  parseNavKitFile,
  peekNavKitMeta,
} from '@/navigation/navKitBundle';
import {
  DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
  demoNavSettingsForSceneType,
  demoNavSettingsToFastNavTuning,
  type DemoNavSettings,
} from '@/navigation/navSettings';
import { requireSdfMcColliderMesh } from '@/navigation/sdfMcColliderOverlay';
import {
  DEFAULT_VOXEL_NAV_SETTINGS,
  type NavGenerationMode,
  voxelNavSettingsToCollisionBase,
} from '@/navigation/voxelNavSettings';
import { splatwalk, type CollisionVoxelVolume, type MeshSettings } from '@/wasm/bridge';
import {
  reconcileSplatModelFilename,
  SUPPORTED_SPLAT_EXTENSIONS,
} from '@/wasm/normalize';
import { SliceArchive } from '@/wasm/sliceArchive';
import {
  clampSliceSettingsForScene,
  DEFAULT_SLICE_SETTINGS,
  inferPlyShDegree,
  maxChunkExtentFromBounds,
  type SliceSettings,
} from '@/wasm/sogTypes';

const OUTDOOR_SDF_MC_FLOOR_PROJECT_FLATTEN_M = 0.35;

/** Which SOG export to produce. */
export type SogExportMode = 'streamed' | 'single';

/** High-level state of the FAST NAV showcase flow. */
export type FastNavStatus = 'idle' | 'loading' | 'processing' | 'done' | 'error';

/** Severity tag parsed from a pipeline log line. */
export type LogTag = 'info' | 'wait' | 'warn' | 'error' | 'success' | 'worker';

/** A single rendered log line. */
export interface LogEntry {
  readonly id: number;
  readonly tag: LogTag;
  readonly message: string;
}

/** Coarse pipeline phase for step indicators (`idle` before any run). */
export type FastNavUiPhase = FastNavPhase | 'idle';

/** Throttled progress from the WASM worker (fraction is null when indeterminate). */
export interface FastNavProgress {
  readonly stage: string;
  readonly fraction: number | null;
}

/** Options for {@link useSplatFastNav}. */
export interface UseSplatFastNavOptions {
  /**
   * Optional camera view + AABB offsets. Pins the yellow select region for the
   * run and restores that view after nav (skips top-down {@link Viewer.focusOnPlayer}).
   */
  readonly cameraSelect?: CameraSelectRegionInput;
  /**
   * When `cameraSelect` is set, restore that view after nav (default true).
   */
  readonly keepCameraSelectView?: boolean;
  /**
   * Optional override for the adaptive FAST NAV floor-field recovery ladder.
   * When omitted, the built-in default ladder is used (recovery is always on).
   */
  readonly recovery?: Partial<FastNavRecoveryConfig>;
  /**
   * Optional override for stray-floater trimming of the detected floor. On by
   * default; pass `{ enabled: false }` to keep every detected floor cell.
   */
  readonly strayTrim?: StrayTrimOptions;
  /**
   * Optional override for WASM-side floater pruning (statistical outlier removal).
   * On by default; pass `{ enabled: false }` to keep every splat, or tune
   * `{ k, stdRatio }`.
   */
  readonly prune?: PruneFloatersOptions;
}

/** Reactive API returned by {@link useSplatFastNav}. */
export interface UseSplatFastNav {
  readonly status: Ref<FastNavStatus>;
  readonly statusMessage: Ref<string>;
  readonly errorMessage: Ref<string | null>;
  readonly logs: Ref<LogEntry[]>;
  readonly isBusy: ComputedRef<boolean>;
  /** Current pipeline phase (prune -> floor -> navmesh -> done). */
  readonly phase: Ref<FastNavUiPhase>;
  /** Latest throttled WASM progress, or null when none is active. */
  readonly progress: Ref<FastNavProgress | null>;
  /** Raw splat count of the loaded scene, or null before/while loading. */
  readonly splatCount: Ref<number | null>;
  /** Highest SH degree present in the loaded file. */
  readonly maxShDegree: Ref<number>;
  /** Maximum chunk extent allowed for the loaded scene. */
  readonly maxChunkExtent: Ref<number>;
  /** Validate, load, auto-run FAST NAV, then frame the player top-down. */
  readonly loadAndProcess: (file: File) => Promise<void>;
  /**
   * Load a splat model without running Fast Nav (used by NavKit restore).
   */
  readonly loadSplatOnly: (file: File) => Promise<void>;
  /** Fetch an example splat from a URL, then run the same pipeline. */
  readonly loadExample: (
    url: string,
    title: string,
    collisionSceneType?: ExampleCollisionSceneType
  ) => Promise<void>;
  /**
   * Export the loaded splat as a SOG bundle: `'streamed'` produces a streamed
   * multi-chunk `lod-meta.json` set; `'single'` produces one SOG `meta.json`.
   * Returns a {@link SliceArchive} (download / streaming handles). Throws if no
   * splat is loaded.
   */
  readonly exportSog: (mode: SogExportMode, settings?: SliceSettings) => Promise<SliceArchive>;
  /** Export the generated Recast navmesh binary. */
  readonly exportNavmesh: () => Promise<void>;
  /** Frame top-down on the player agent when a navmesh session exists. */
  readonly goToPlayer: () => void;
  /**
   * True when top-down framing (`focusOnPlayer`) was applied — not merely when
   * pipeline status is `done` (NavKit cam pose restore skips top-down).
   */
  readonly topDownViewApplied: Ref<boolean>;
  /** Download NavKit zip (meta-nav + original model + nav artifacts). */
  readonly downloadNavKit: () => Promise<void>;
  /** Load a NavKit zip: model + baked nav (no Fast Nav recompute). */
  readonly loadNavKit: (file: File) => Promise<void>;
  /** Download legacy nav-artifacts zip (session + Recast bin ± collision GLB). */
  readonly downloadNavArtifacts: () => Promise<void>;
  /** Upload legacy zip or multi-select contract files and restore nav. */
  readonly uploadNavArtifacts: (files: File[] | FileList) => Promise<void>;
  readonly hasNavArtifactBundle: Ref<boolean>;
  /** True when Download NavKit can run (model source + nav pack). */
  readonly hasNavKit: Ref<boolean>;
  /** Player input mode: click / WASDQE / both. */
  readonly controlsMode: Ref<NavKitControlsMode>;
  readonly setControlsMode: (mode: NavKitControlsMode) => void;
  readonly controlsWasdLegend: string;
  readonly navArtifactUploadHint: string;
  readonly navKitUploadHint: string;
  /** Editable camera-select AABB offsets (meters). */
  readonly cameraSelectOffsets: Ref<CameraSelectRegionOffsets>;
  readonly resetCameraSelectOffsets: () => void;
  /** Live NavKit-shaped camera pose (sampled while Camera Information is open). */
  readonly cameraInfo: Ref<NavKitCameraPoseInfo>;
  readonly cameraInfoCopyText: ComputedRef<string>;
  readonly copyCameraPose: () => Promise<boolean>;
  readonly setCameraInfoPanelOpen: (open: boolean) => void;
  /** Live NavKit-shaped player pose (sampled while Player Information is open). */
  readonly playerInfo: Ref<NavKitPlayerPoseInfo>;
  readonly playerInfoCopyText: ComputedRef<string>;
  readonly copyPlayerPose: () => Promise<boolean>;
  readonly setPlayerInfoPanelOpen: (open: boolean) => void;
  /** Pin yellow box from live FreeCamera + offsets; used on next Fast Nav. */
  readonly applySelectRegionFromCamera: () => Promise<void>;
  /** Generate and show the collision voxel boundary overlay. */
  readonly generateCollisionBoundary: () => Promise<CollisionBoundaryArtifact>;
  /** Export the collision voxel boundary mesh as `.collision.glb`. */
  readonly exportCollisionMesh: () => Promise<Uint8Array>;
  /** Show or hide the collision voxel boundary overlay. */
  readonly setCollisionBoundaryVisible: (visible: boolean) => void;
  /** True once a cyan MC shell / collision overlay exists this session. */
  readonly hasCollisionBoundary: Ref<boolean>;
  /** Show or hide the green walkable navmesh overlay (click-to-move target). */
  readonly setNavMeshVisible: (visible: boolean) => void;
  /** Enable NavMesh Editor tools (suppresses click-to-move while on). */
  readonly setNavMeshEditorEnabled: (enabled: boolean) => void;
  readonly setNavMeshEditorMode: (mode: 'vertex' | 'circle' | 'global') => void;
  readonly navMeshEditorGlobalY: (steps: number) => void;
  readonly navMeshEditorFillHole: () => boolean;
  readonly navMeshEditorDeleteVertices: () => Promise<boolean>;
  readonly applyNavMeshEditorToLive: () => Promise<boolean>;
  readonly onNavMeshEditorStatus: (
    listener: (status: import('@/navigation/navmeshEditor').NavMeshEditorStatus) => void
  ) => () => void;
  readonly getNavMeshEditorStatus: () => import('@/navigation/navmeshEditor').NavMeshEditorStatus | null;
  /** Detour binary including post-editor rebakes. */
  readonly getNavMeshData: () => Uint8Array | null;
  /** Full NM override panel (floor coverage + Recast), shared with Storage Adapter. */
  readonly navSettings: Ref<DemoNavSettings>;
  /** Reset {@link navSettings} to the indoor/outdoor preset for the current scene type. */
  readonly resetNavSettings: () => void;
  /**
   * Whether WASM floater pruning runs on the next Fast Nav.
   * Synced with {@link navSettings}.pruneFloaters.
   */
  readonly pruneFloaters: Ref<boolean>;
  /** True once a navmesh has been generated this session. */
  readonly hasNavMesh: Ref<boolean>;
  /** True once splat bytes are loaded (including after a Fast Nav failure). */
  readonly hasLoadedSplat: ComputedRef<boolean>;
  /** Whether the yellow selection-region box is visible / pinned. */
  readonly selectionRegionVisible: Ref<boolean>;
  /** Show or hide the selection region (pins Fast Nav / collision AABB when shown). */
  readonly setSelectionRegionVisible: (visible: boolean) => Promise<void>;
  /**
   * Re-run Fast Nav on the loaded splat using current prune / region / session scale.
   * Pass {@link scaleMultiplier} (UI factor; `1` = no change) to multiply session
   * scale before the cache key / WASM bake.
   */
  readonly rerunFastNav: (options?: { readonly scaleMultiplier?: number }) => Promise<void>;
  /** Nav generation technique (floor field, voxel collision, or WASM SDF-MC). */
  readonly navGenerationMode: Ref<NavGenerationMode>;
  /**
   * Indoor sealed fill vs outdoor floor fill for voxel / SDF-MC Fast Nav.
   * Example scene buttons seed this; the Scene type dropdown overrides it.
   */
  readonly collisionSceneType: Ref<ExampleCollisionSceneType>;
  /** Apply scene type and matching indoor/outdoor DemoNavSettings preset. */
  readonly setCollisionSceneType: (sceneType: ExampleCollisionSceneType) => void;
  /** Active locomotion intent (Recast / Voxel mesh / dual). */
  readonly activeNavigationMode: Ref<ActiveNavigationMode>;
  readonly setActiveNavigationMode: (mode: ActiveNavigationMode) => Promise<void>;
  readonly activeNavigationModeDisabledReason: (mode: ActiveNavigationMode) => string | null;
  readonly liveBackend: Ref<LiveNavBackend>;
  readonly navCapabilities: ComputedRef<NavCapabilities>;
  /**
   * Multiply session environment scale by {@link scaleMultiplier} (`1` = no-op),
   * then re-run FAST NAV so collision / navmesh bake in the same world meters.
   * When no splat is loaded yet, only updates the pending session scale.
   */
  readonly applyEnvironmentScale: (scaleMultiplier: number) => Promise<void>;
  /**
   * Multiply session scale by {@link scaleMultiplier} (`1` = no-op) without rebuilding.
   * @returns Absolute session scale after the update
   */
  readonly applyScaleMultiplier: (scaleMultiplier: number) => number;
  /** Absolute session environment scale (splat transform + WASM bake factor). */
  readonly sessionEnvironmentScale: Ref<number>;
  /** Stash absolute scale for the next Fast Nav without rebuilding (no-op if invalid). */
  readonly setPendingEnvironmentScale: (scale: number) => void;
  /** Reset back to the idle state, clearing logs and errors. */
  readonly reset: () => void;
}

const SUPPORTED_EXTENSIONS = SUPPORTED_SPLAT_EXTENSIONS;

function parseLog(message: string): LogEntry {
  const match = /^\[(INFO|WAIT|WARN|ERROR|SUCCESS|WORKER)\]\s*/.exec(message);
  const tag = (match?.[1]?.toLowerCase() as LogTag | undefined) ?? 'info';
  const text = match ? message.slice(match[0].length) : message;
  return { id: Date.now() + Math.random(), tag, message: text };
}

/**
 * Orchestrate the showcase: drop/browse a splat, render it, auto-run FAST NAV,
 * and end on a top-down view of the player. All Babylon/WASM work is delegated
 * to the viewer and the shared `fastNav` module (no logic in the component).
 */
export function useSplatFastNav(
  babylon: UseBabylonViewer,
  options: UseSplatFastNavOptions = {}
): UseSplatFastNav {
  const status = ref<FastNavStatus>('idle');
  const statusMessage = ref('Drop a .ply, .spz, or .splat splat to begin.');
  const errorMessage = ref<string | null>(null);
  const logs = ref<LogEntry[]>([]);
  const phase = ref<FastNavUiPhase>('idle');
  const progress = ref<FastNavProgress | null>(null);
  const splatCount = ref<number | null>(null);
  const maxShDegree = ref(DEFAULT_SLICE_SETTINGS.sh_degree);
  const maxChunkExtent = ref(DEFAULT_SLICE_SETTINGS.chunk_extent);
  // HEAD / prod floor_field uses outdoor-wide DemoNavSettings (coverage parity).
  const navSettings = ref<DemoNavSettings>({
    ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
    pruneFloaters: options.prune?.enabled ?? DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS.pruneFloaters,
  });
  const pruneFloaters = computed({
    get: () => navSettings.value.pruneFloaters,
    set: (value: boolean) => {
      navSettings.value = { ...navSettings.value, pruneFloaters: value };
    },
  });
  const selectionRegionVisible = ref(false);
  const hasLoadedSplat = ref(false);
  const hasNavMesh = ref(false);
  const hasCollisionBoundary = ref(false);
  const topDownViewApplied = ref(false);
  const navGenerationMode = ref<NavGenerationMode>('floor_field');
  const collisionSceneType = ref<ExampleCollisionSceneType>('indoor');
  const activeNavigationMode = ref<ActiveNavigationMode>(DEFAULT_ACTIVE_NAVIGATION_MODE);
  const liveBackend = ref<LiveNavBackend>('none');
  const controlsMode = ref<NavKitControlsMode>(DEFAULT_NAV_KIT_CONTROLS_MODE_NEW);
  const isBusy = computed(() => status.value === 'loading' || status.value === 'processing');
  const hasLoadedSplatComputed = computed(() => hasLoadedSplat.value);
  const cameraInfo = ref<NavKitCameraPoseInfo>(emptyNavKitCameraPoseInfo());
  const playerInfo = ref<NavKitPlayerPoseInfo>(emptyNavKitPlayerPoseInfo());
  const cameraInfoCopyText = computed(() => formatNavKitCameraCopyText(cameraInfo.value));
  const playerInfoCopyText = computed(() => formatNavKitPlayerCopyText(playerInfo.value));
  let cameraInfoPanelOpen = false;
  let playerInfoPanelOpen = false;
  let poseInfoRafId = 0;

  const resolveCollisionSceneType = (algo: NavGenerationMode): ExampleCollisionSceneType =>
    collisionSceneTypeForAlgo({
      algo,
      exampleSceneType: collisionSceneType.value,
    });

  let wasmReady = false;
  // Bytes + base name of the loaded scene, retained for SOG export.
  let currentBytes: Uint8Array | null = null;
  /** Original dropped/uploaded model bytes (pre-normalize) for NavKit packs. */
  let currentModelSourceBytes: Uint8Array | null = null;
  let currentModelFilename = 'model.ply';
  let currentName = 'splat';
  let currentCollisionArtifact: CollisionBoundaryArtifact | null = null;
  let currentNavMeshData: Uint8Array | null = null;
  let currentNavArtifactBundle: NavArtifactBundle | null = null;
  /** Session locomotion artifacts — shallowRef so navCapabilities stays live after Fast Nav. */
  const sessionVolume = shallowRef<CollisionVoxelVolume | null>(null);
  const sessionRecastBin = shallowRef<Uint8Array | null>(null);
  const sessionSeed = shallowRef<number[] | null>(null);
  const sessionSpawn = shallowRef<[number, number, number] | null>(null);
  let sessionCameraSelect: CameraSelectRegionInput | undefined = options.cameraSelect;
  /** Stashed so Scale Environment set before load applies on first Fast Nav. */
  let pendingEnvironmentScale = 1;
  /** Absolute session scale (reactive mirror of viewer / pending). */
  const sessionEnvironmentScale = ref(1);

  const buildDemoCollisionSettings = (params: {
    readonly algo: NavGenerationMode;
    readonly emitGlb: boolean;
    readonly emitVolume?: boolean;
    readonly flipY: boolean;
    readonly rotation: [number, number, number];
    readonly seed?: number[];
  }) => {
    const sceneType = resolveCollisionSceneType(params.algo);
    const keepVolume =
      params.emitVolume ?? shouldKeepVolumeForActiveMode(activeNavigationMode.value);
    const environmentScale =
      babylon.viewer.value?.getEnvironmentScale() ?? pendingEnvironmentScale;
    return buildCollisionBoundarySettings({
      base: {
        ...voxelNavSettingsToCollisionBase({
          ...DEFAULT_VOXEL_NAV_SETTINGS,
          collisionSceneType: sceneType,
        }),
        prune_floaters: navSettings.value.pruneFloaters,
        collision_mesh_mode: params.algo === 'sdf_marching_cubes' ? 'smooth' : 'walkable_floors',
        collision_scene_type: sceneType,
        environment_scale: environmentScale,
        ...(params.algo === 'sdf_marching_cubes'
          ? {
              sdf_band_voxels: DEFAULT_VOXEL_NAV_SETTINGS.sdfBandVoxels,
              mc_iso_level: DEFAULT_VOXEL_NAV_SETTINGS.mcIsoLevel,
              mc_smooth_iterations: DEFAULT_VOXEL_NAV_SETTINGS.mcSmoothIterations,
              ...(sceneType === 'outdoor'
                ? { floor_project_flatten_m: OUTDOOR_SDF_MC_FLOOR_PROJECT_FLATTEN_M }
                : {}),
            }
          : {}),
      },
      emitGlb: params.emitGlb,
      emitVolume: keepVolume || params.algo === 'voxel_collision',
      flipY: params.flipY,
      rotation: params.rotation,
      seed: params.seed,
    });
  };
  /** Last selection-region AABB so hide→show can restore the user's box. */
  let cachedSelectionRegion: { min: number[]; max: number[] } | null = null;
  const cameraSelectOffsets = ref<CameraSelectRegionOffsets>({
    ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  });
  // Plain lets are not reactive — mirror readiness into refs (same pattern as sessionVolume).
  const hasNavArtifactBundle = ref(false);
  const hasNavKit = ref(false);
  const syncNavExportReadiness = (): void => {
    hasNavArtifactBundle.value = currentNavArtifactBundle !== null;
    hasNavKit.value =
      currentNavArtifactBundle !== null &&
      currentModelSourceBytes !== null &&
      currentModelSourceBytes.byteLength > 0;
  };
  const navCapabilities = computed<NavCapabilities>(() =>
    navCapabilitiesFromParts({
      recastBin: sessionRecastBin.value,
      volume: sessionVolume.value,
    })
  );

  const storeMinimalNavArtifacts = async (params: {
    readonly debugIndices?: Uint32Array | null;
    readonly debugPositions?: Float32Array | null;
    readonly navMeshData: Uint8Array;
    readonly playerSpawn: { x: number; y: number; z: number } | null | undefined;
    readonly volume?: CollisionVoxelVolume | null;
  }): Promise<void> => {
    const viewer = babylon.viewer.value;
    const region = viewer?.getWasmRegionBounds() ?? null;
    currentNavArtifactBundle = await buildMinimalNavArtifactBundle({
      collisionGlb: currentCollisionArtifact?.result.glb ?? null,
      debugIndices: params.debugIndices ?? null,
      debugPositions: params.debugPositions ?? null,
      navMeshData: params.navMeshData,
      playerSpawn: params.playerSpawn
        ? [params.playerSpawn.x, params.playerSpawn.y, params.playerSpawn.z]
        : null,
      regionMax: region?.max ?? null,
      regionMin: region?.min ?? null,
      volume: params.volume ?? sessionVolume.value,
    });
    syncNavExportReadiness();
  };

  /** Keep session Detour bin + NavKit/artifact packs aligned after editor rebake. */
  const syncSessionFromEditedRebake = async (result: {
    readonly navMeshData: Uint8Array;
    readonly debugPositions: Float32Array;
    readonly debugIndices: Uint32Array;
  }): Promise<void> => {
    currentNavMeshData = result.navMeshData;
    sessionRecastBin.value = result.navMeshData;
    const spawn = sessionSpawn.value;
    await storeMinimalNavArtifacts({
      debugIndices: result.debugIndices,
      debugPositions: result.debugPositions,
      navMeshData: result.navMeshData,
      playerSpawn: spawn
        ? { x: spawn[0]!, y: spawn[1]!, z: spawn[2]! }
        : null,
      volume: sessionVolume.value,
    });
    appendLog('[INFO] NavMesh Editor rebake synced to session / NavKit artifacts.');
  };

  let unsubEditedNavMeshRebake: (() => void) | null = null;
  watch(
    () => babylon.viewer.value,
    (viewer) => {
      unsubEditedNavMeshRebake?.();
      unsubEditedNavMeshRebake = null;
      if (!viewer) {
        return;
      }
      unsubEditedNavMeshRebake = viewer.onEditedNavMeshRebake((result) =>
        syncSessionFromEditedRebake(result)
      );
    },
    { immediate: true }
  );

  const syncSessionFromFastNav = (params: {
    readonly navMeshData: Uint8Array;
    readonly playerSpawn: { x: number; y: number; z: number } | null | undefined;
    readonly volume?: CollisionVoxelVolume | null;
  }): void => {
    sessionRecastBin.value = params.navMeshData;
    sessionVolume.value = params.volume ?? null;
    sessionSpawn.value = params.playerSpawn
      ? [params.playerSpawn.x, params.playerSpawn.y, params.playerSpawn.z]
      : null;
    sessionSeed.value = sessionSpawn.value ? [...sessionSpawn.value] : null;
    liveBackend.value =
      navGenerationMode.value === 'floor_field'
        ? 'recast_crowd'
        : initialLiveBackendForActiveMode(activeNavigationMode.value);
    const caps = navCapabilitiesFromParts({
      recastBin: sessionRecastBin.value,
      volume: sessionVolume.value,
    });
    appendLog(
      `[INFO] Session nav caps: hasRecast=${caps.hasRecast} hasVolume=${caps.hasVolume}` +
        ` · live=${liveNavBackendLabel(liveBackend.value)}.`
    );
    if (
      navGenerationMode.value !== 'floor_field' &&
      !sessionVolume.value &&
      (activeNavigationMode.value === 'voxel_mesh' ||
        activeNavigationMode.value === 'recast_and_voxel_mesh')
    ) {
      appendLog(
        '[WARN] No volume in session — Active Voxel / Dual click-to-walk needs a re-run with emit_volume.'
      );
    }
  };

  const setCollisionSceneType = (sceneType: ExampleCollisionSceneType): void => {
    collisionSceneType.value = sceneType;
    // floor_field matches HEAD/prod outdoor bands; indoor/outdoor presets apply to voxel/SDF-MC.
    if (navGenerationMode.value === 'floor_field') {
      appendLog(
        `[INFO] Scene type → ${sceneType} (floor_field keeps outdoor DemoNavSettings like HEAD).`
      );
      return;
    }
    navSettings.value = demoNavSettingsForSceneType(sceneType, {
      preservePrune: navSettings.value.pruneFloaters,
    });
    appendLog(
      `[INFO] Scene type → ${sceneType}; applied ${sceneType} DemoNavSettings preset.`
    );
  };

  watch(navGenerationMode, (mode) => {
    if (mode === 'floor_field' && activeNavigationMode.value !== 'recast') {
      activeNavigationMode.value = 'recast';
      appendLog(
        '[INFO] Active navigation mode → Recast (floor field cannot produce voxel volume).'
      );
    }
    if (mode === 'floor_field') {
      navSettings.value = {
        ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
        pruneFloaters: navSettings.value.pruneFloaters,
      };
      appendLog('[INFO] floor_field: restored outdoor DemoNavSettings (HEAD/prod parity).');
    } else {
      navSettings.value = demoNavSettingsForSceneType(collisionSceneType.value, {
        preservePrune: navSettings.value.pruneFloaters,
      });
      appendLog(
        `[INFO] Applied ${collisionSceneType.value} DemoNavSettings for ${mode}.`
      );
    }
  });

  const activeNavigationModeDisabledReason = (mode: ActiveNavigationMode): string | null =>
    sharedActiveNavigationModeDisabledReason({
      algo: navGenerationMode.value,
      busy: isBusy.value,
      caps: navCapabilities.value,
      liveBackend: liveBackend.value,
      mode,
    });

  const setActiveNavigationMode = async (mode: ActiveNavigationMode): Promise<void> => {
    if (isBusy.value) {
      appendLog('[WARN] Active navigation mode ignored — busy.');
      return;
    }
    if (navGenerationMode.value === 'floor_field' && mode !== 'recast') {
      const reason = activeNavigationModeDisabledReason(mode) ?? 'not available';
      appendLog(`[WARN] Active ${mode} unavailable: ${reason}`);
      errorMessage.value = reason;
      return;
    }
    const previous = activeNavigationMode.value;
    activeNavigationMode.value = mode;
    const viewer = babylon.viewer.value;
    const result = await resolveActiveNavigationChange({
      liveBackend: liveBackend.value,
      mode,
      onLog: appendLog,
      previousMode: previous,
      recastBin: sessionRecastBin.value,
      seed: sessionSeed.value,
      spawnHint: sessionSpawn.value,
      viewer: viewer ?? null,
      volume: sessionVolume.value,
    });
    liveBackend.value = result.liveBackend;
    if (!result.applied) {
      activeNavigationMode.value = result.revertToMode ?? previous;
      errorMessage.value =
        result.failureMessage ??
        'Could not switch Live locomotion — missing volume or Recast assets. ' +
          'Re-run Nav under Voxel / SDF-MC with volume, then try again.';
      return;
    }
    errorMessage.value = null;
    if (result.liveBackend !== 'none' && viewer) {
      hasNavMesh.value = true;
      viewer.setControlsMode(controlsMode.value);
      const framing = viewer.focusOnPlayer();
      if (framing) {
        topDownViewApplied.value = true;
        appendLog(
          `[SUCCESS] Top-down view above player at ` +
            `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      }
      statusMessage.value =
        result.liveBackend === 'recast_crowd'
          ? 'Live: Recast crowd. Click the green navmesh to move.'
          : 'Live: Voxel walk. Click surfaces — player walks to nearest floor cell.';
    }
  };

  const resolveFastNavTuning = () => {
    const tuning = demoNavSettingsToFastNavTuning(navSettings.value);
    return {
      ...tuning,
      prune: {
        ...options.prune,
        enabled: navSettings.value.pruneFloaters,
      },
    };
  };

  const appendLog = (message: string): void => {
    logs.value.push(parseLog(message));
    console.log(message);
  };

  // Throttled WASM progress (parse/prune/...) flows through the shared bridge.
  splatwalk.onProgress = (stage: string, fraction: number | null): void => {
    progress.value = { stage, fraction };
  };

  const reset = (): void => {
    cameraInfoPanelOpen = false;
    playerInfoPanelOpen = false;
    if (poseInfoRafId !== 0) {
      cancelAnimationFrame(poseInfoRafId);
      poseInfoRafId = 0;
    }
    cameraInfo.value = emptyNavKitCameraPoseInfo();
    playerInfo.value = emptyNavKitPlayerPoseInfo();
    status.value = 'idle';
    statusMessage.value = 'Drop a .ply, .spz, or .splat splat to begin.';
    errorMessage.value = null;
    logs.value = [];
    phase.value = 'idle';
    progress.value = null;
    splatCount.value = null;
    maxShDegree.value = DEFAULT_SLICE_SETTINGS.sh_degree;
    maxChunkExtent.value = DEFAULT_SLICE_SETTINGS.chunk_extent;
    currentBytes = null;
    currentModelSourceBytes = null;
    currentModelFilename = 'model.ply';
    currentCollisionArtifact = null;
    currentName = 'splat';
    currentNavMeshData = null;
    currentNavArtifactBundle = null;
    syncNavExportReadiness();
    pendingEnvironmentScale = 1;
    sessionEnvironmentScale.value = 1;
    cachedSelectionRegion = null;
    hasLoadedSplat.value = false;
    hasNavMesh.value = false;
    hasCollisionBoundary.value = false;
    topDownViewApplied.value = false;
    sessionVolume.value = null;
    sessionRecastBin.value = null;
    sessionSeed.value = null;
    sessionSpawn.value = null;
    liveBackend.value = 'none';
    activeNavigationMode.value = DEFAULT_ACTIVE_NAVIGATION_MODE;
    navSettings.value = {
      ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
      pruneFloaters: options.prune?.enabled ?? DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS.pruneFloaters,
    };
    selectionRegionVisible.value = false;
    babylon.viewer.value?.disableRegionSelection();
    babylon.viewer.value?.clearColliderMesh();
    babylon.viewer.value?.setEnvironmentScale(1);
  };

  const resetNavSettings = (): void => {
    if (navGenerationMode.value === 'floor_field') {
      navSettings.value = {
        ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
        pruneFloaters: options.prune?.enabled ?? navSettings.value.pruneFloaters,
      };
      appendLog('[INFO] Navmesh settings reset to outdoor defaults (floor_field / HEAD).');
      return;
    }
    navSettings.value = demoNavSettingsForSceneType(collisionSceneType.value, {
      preservePrune: options.prune?.enabled ?? navSettings.value.pruneFloaters,
    });
    appendLog(
      `[INFO] Navmesh settings reset to ${collisionSceneType.value} defaults.`
    );
  };

  const processFile = async (
    file: File,
    processOptions?: { readonly skipNav?: boolean }
  ): Promise<void> => {
    const name = file.name.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      errorMessage.value = 'Only .ply, .spz, and .splat splat files are supported.';
      status.value = 'error';
      return;
    }

    try {
      status.value = 'loading';
      statusMessage.value = `Loading ${file.name}...`;
      appendLog(`[INFO] Loading file: ${file.name} (${file.size} bytes)`);

      const viewer = await babylon.initViewer();
      viewer.setEnvironmentScale(pendingEnvironmentScale);
      sessionEnvironmentScale.value = pendingEnvironmentScale;
      viewer.clearColliderMesh();
      hasCollisionBoundary.value = false;
      viewer.disableRegionSelection();
      selectionRegionVisible.value = false;
      cachedSelectionRegion = null;

      if (!wasmReady) {
        appendLog('[WAIT] Initializing SplatWalk WASM...');
        await splatwalk.init();
        wasmReady = true;
      }

      // Keep original bytes for NavKit packs; normalize a copy for viewer / nav.
      currentModelSourceBytes = new Uint8Array(await file.arrayBuffer());
      currentModelFilename = file.name;
      const bytes = await readSplatBytes(file);
      maxShDegree.value = inferPlyShDegree(bytes);
      await viewer.loadGaussianSplat(bytes);
      appendLog('[INFO] Splat visualized.');

      currentBytes = bytes;
      hasLoadedSplat.value = true;
      currentCollisionArtifact = null;
      currentName = file.name.replace(/\.(ply|spz|splat)$/i, '');
      currentNavMeshData = null;
      currentNavArtifactBundle = null;
      syncNavExportReadiness();
      hasNavMesh.value = false;
      try {
        const bounds = await splatwalk.getSplatBounds(bytes, { mode: 2, prune_floaters: false } as MeshSettings);
        splatCount.value = bounds.point_count;
        maxChunkExtent.value = maxChunkExtentFromBounds({
          min: bounds.oriented_min,
          max: bounds.oriented_max,
        });
      } catch {
        splatCount.value = null;
        maxChunkExtent.value = DEFAULT_SLICE_SETTINGS.chunk_extent;
      }

      if (processOptions?.skipNav) {
        topDownViewApplied.value = false;
        phase.value = 'idle';
        progress.value = null;
        status.value = 'done';
        statusMessage.value = 'Splat loaded (nav restore pending).';
        return;
      }

      topDownViewApplied.value = false;
      status.value = 'processing';
      statusMessage.value = 'Running FAST NAV...';
      const tuning = resolveFastNavTuning();
      const mode = navGenerationMode.value;
      appendLog(`[INFO] Floater prune: ${tuning.prune.enabled === false ? 'off' : 'on'}`);
      appendLog(`[INFO] Collision scene type: ${resolveCollisionSceneType(mode)}`);
      const rotation = viewer.getSplatRotation();
      const collisionSettings =
        mode === 'floor_field'
          ? undefined
          : buildDemoCollisionSettings({
              algo: mode,
              emitGlb: false,
              emitVolume: true,
              flipY: viewer.isSplatYFlipped(),
              rotation: [rotation.x, rotation.y, rotation.z],
              seed: seedFromRegionBounds({ regionBounds: viewer.getRegionBounds() }),
            });
      const activeMode =
        mode === 'floor_field' ? 'recast' : activeNavigationMode.value;
      if (mode === 'floor_field' && activeNavigationMode.value !== 'recast') {
        activeNavigationMode.value = 'recast';
      }
      const sceneTypeForRun = resolveCollisionSceneType(mode);
      const fastNav = await runFastNav({
        activeNavigationMode: activeMode,
        algo: mode,
        viewer,
        bytes,
        cameraSelect: sessionCameraSelect ?? options.cameraSelect,
        keepCameraSelectView: options.keepCameraSelectView,
        collisionSettings,
        onLog: appendLog,
        onPhase: (next) => { phase.value = next; },
        recovery: options.recovery,
        strayTrim: options.strayTrim,
        ...tuning,
        // Outdoor floor_field: seed-centered ~100 m pin (Storage Adapter / prod parity).
        seedCenteredOutdoor: mode === 'floor_field' && sceneTypeForRun === 'outdoor',
      });
      currentNavMeshData = fastNav.navMeshData;
      hasNavMesh.value = true;
      viewer.setControlsMode(controlsMode.value);
      if (mode === 'voxel_collision' || mode === 'sdf_marching_cubes') {
        hasCollisionBoundary.value = true;
      }
      if (viewer.getRegionBounds()) {
        selectionRegionVisible.value = true;
      }
      syncSessionFromFastNav({
        navMeshData: fastNav.navMeshData,
        playerSpawn: fastNav.playerSpawn,
        volume: fastNav.volume,
      });
      await storeMinimalNavArtifacts({
        debugIndices: fastNav.debugIndices,
        debugPositions: fastNav.debugPositions,
        navMeshData: fastNav.navMeshData,
        playerSpawn: fastNav.playerSpawn,
        volume: fastNav.volume,
      });
      phase.value = 'done';
      progress.value = null;

      if (!fastNav.keptCameraSelectView) {
        statusMessage.value = 'Framing the player (top-down)...';
        const framing = viewer.focusOnPlayer();
        if (framing) {
          topDownViewApplied.value = true;
          appendLog(
            `[SUCCESS] Top-down view set above player at ` +
              `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
          );
        } else {
          appendLog('[WARN] No player agent to frame; leaving the default camera.');
        }
      }

      status.value = 'done';
      statusMessage.value = 'FAST NAV complete. Click the navmesh to move the player.';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = processOptions?.skipNav ? 'Splat load failed.' : 'FAST NAV failed.';
      // Keep any prior navmesh if recompute failed after a successful run.
      if (!currentNavMeshData) {
        hasNavMesh.value = false;
      }
    }
  };

  const loadSplatOnly = async (file: File): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    errorMessage.value = null;
    await processFile(file, { skipNav: true });
  };

  const loadNavKit = async (file: File): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    errorMessage.value = null;
    logs.value = [];
    phase.value = 'idle';
    progress.value = null;
    try {
      status.value = 'loading';
      statusMessage.value = `Loading NavKit ${file.name}...`;
      appendLog(`[INFO] Loading NavKit: ${file.name} (${file.size} bytes)`);
      const kit = await parseNavKitFile(file);
      appendLog(
        `[INFO] NavKit meta: technique=${kit.meta.defaultNavTechnique}` +
          ` active=${kit.meta.defaultActiveNavigationMode}` +
          ` locomotion=${kit.meta.defaultLocomotionMode}.`
      );
      navGenerationMode.value = kit.meta.defaultNavTechnique;
      activeNavigationMode.value = kit.meta.defaultActiveNavigationMode;
      await processFile(kit.modelFile, { skipNav: true });
      if (status.value === 'error') {
        throw new Error(errorMessage.value ?? 'Failed to load NavKit model.');
      }
      const viewer = babylon.viewer.value;
      if (!viewer) {
        throw new Error('Viewer not ready after NavKit model load.');
      }
      status.value = 'processing';
      statusMessage.value = 'Restoring NavKit nav artifacts...';
      viewer.clearNavArtifacts();
      currentNavArtifactBundle = kit.navParsed.bundle;
      currentModelSourceBytes = kit.modelBytes;
      currentModelFilename = kit.meta.model.filename;
      currentName = kit.meta.slug;
      syncNavExportReadiness();
      if (kit.navParsed.bundle.recastNavmeshBin) {
        currentNavMeshData = kit.navParsed.bundle.recastNavmeshBin;
        sessionRecastBin.value = kit.navParsed.bundle.recastNavmeshBin;
      }
      sessionVolume.value = kit.navParsed.volume;
      if (
        kit.navParsed.session.playerSpawn &&
        kit.navParsed.session.playerSpawn.length >= 3
      ) {
        sessionSpawn.value = [
          kit.navParsed.session.playerSpawn[0]!,
          kit.navParsed.session.playerSpawn[1]!,
          kit.navParsed.session.playerSpawn[2]!,
        ];
        sessionSeed.value = [...sessionSpawn.value];
      } else if (
        kit.navParsed.session.collisionSeed &&
        kit.navParsed.session.collisionSeed.length >= 3
      ) {
        sessionSeed.value = [...kit.navParsed.session.collisionSeed];
      }
      await applyNavArtifactsToViewer({
        focusCamera: false,
        onLog: appendLog,
        parsed: kit.navParsed,
        viewer,
      });
      const metaApplied = applyNavKitMetaToViewer({
        meta: kit.meta,
        onLog: appendLog,
        parsed: kit.navParsed,
        viewer,
      });
      topDownViewApplied.value = metaApplied.topDownViewApplied;
      controlsMode.value = metaApplied.controlsMode;
      liveBackend.value =
        kit.meta.defaultLocomotionMode === 'voxel_walk' ||
        kit.navParsed.session.locomotionMode === 'voxel_walk'
          ? 'voxel_walk'
          : 'recast_crowd';
      hasNavMesh.value = true;
      if (kit.navParsed.bundle.collisionGlb) {
        hasCollisionBoundary.value = true;
      }
      if (viewer.getRegionBounds()) {
        selectionRegionVisible.value = true;
      }
      phase.value = 'done';
      progress.value = null;
      status.value = 'done';
      statusMessage.value =
        'NavKit restored. Use Controls (click / WASDQE / both) to move.';
      appendLog(`[SUCCESS] NavKit loaded. ${NAV_KIT_UPLOAD_HINT}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = 'NavKit load failed.';
      throw error;
    }
  };

  const loadAndProcess = async (file: File): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    errorMessage.value = null;
    logs.value = [];
    phase.value = 'idle';
    progress.value = null;
    const kitMeta = await peekNavKitMeta(file);
    if (kitMeta) {
      await loadNavKit(file);
      return;
    }
    await processFile(file);
  };

  const loadExample = async (
    url: string,
    title: string,
    sceneType: ExampleCollisionSceneType = 'indoor'
  ): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    errorMessage.value = null;
    logs.value = [];
    phase.value = 'idle';
    progress.value = null;
    setCollisionSceneType(sceneType);

    try {
      status.value = 'loading';
      statusMessage.value = `Fetching ${title}...`;
      appendLog(
        `[WAIT] Fetching example scene: ${title} (collision_scene_type=${sceneType})...`
      );

      // Load via Babylon's XHR-based loader (Tools.LoadFile) rather than fetch():
      // the browser fetch() stream aborts mid-body on some networks, while
      // Babylon's transport (used everywhere else) downloads reliably.
      const data = (await Tools.LoadFileAsync(url, true)) as ArrayBuffer;
      // Name the file from the URL's real extension so `.spz` / `.splat` example
      // scenes get normalized to PLY (via readSplatBytes) just like dropped files.
      const fileName = url.split('/').pop() || `${title}.ply`;
      const file = new File([data], fileName, { type: 'application/octet-stream' });
      appendLog(`[SUCCESS] Fetched ${title} (${(file.size / (1024 * 1024)).toFixed(2)} MB).`);

      await processFile(file);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = 'Failed to load the example scene.';
    }
  };

  const exportSog = async (mode: SogExportMode, settings: SliceSettings = {}): Promise<SliceArchive> => {
    if (!currentBytes) {
      throw new Error('No splat loaded to export.');
    }
    const cappedSettings = clampSliceSettingsForScene(settings, {
      maxShDegree: maxShDegree.value,
      maxChunkExtent: maxChunkExtent.value,
    });
    const result =
      mode === 'streamed'
        ? await splatwalk.sliceSplat(currentBytes, cappedSettings)
        : await splatwalk.convertToSog(currentBytes, cappedSettings);
    const archive = new SliceArchive(result, { streamed: mode === 'streamed' });
    archive.download(`${currentName}-sog`);
    return archive;
  };

  const exportNavmesh = async (): Promise<void> => {
    const data =
      babylon.viewer.value?.getNavMeshData() ?? currentNavMeshData;
    if (!data) {
      throw new Error('No navmesh generated to export.');
    }
    currentNavMeshData = data;
    sessionRecastBin.value = data;
    exportNavmeshBinary({
      filename: `${currentName}.nav`,
      navMeshData: data,
    });
  };

  const generateCollisionBoundary = async (): Promise<CollisionBoundaryArtifact> => {
    const bytes = currentBytes;
    const viewer = babylon.viewer.value;
    if (!bytes || !viewer) {
      throw new Error('No loaded splat to generate collision from.');
    }
    const rotation = viewer.getSplatRotation();
    const algo = navGenerationMode.value;
    const useSmooth = algo === 'sdf_marching_cubes';
    const settings = buildDemoCollisionSettings({
      algo,
      emitGlb: true,
      flipY: viewer.isSplatYFlipped(),
      rotation: [rotation.x, rotation.y, rotation.z],
      seed: seedFromRegionBounds({ regionBounds: viewer.getRegionBounds() }),
    });
    const artifact = await generateCollisionBoundaryArtifact({ bytes, settings });
    currentCollisionArtifact = artifact;
    if (useSmooth) {
      const mcShell = requireSdfMcColliderMesh({
        colliderMesh: artifact.result.collider_mesh,
        recastMesh: artifact.result.mesh,
      });
      viewer.displayColliderMesh(
        new Float32Array(mcShell.vertices),
        new Uint32Array(mcShell.indices),
        0.35
      );
      viewer.setColliderVisible(true);
      hasCollisionBoundary.value = true;
      appendLog(
        `[SUCCESS] Collision boundary ready: SDF-MC cyan = collider_mesh (interior MC shell): ` +
          `${mcShell.vertex_count} verts, ${mcShell.face_count} faces.`
      );
    } else {
      const overlay = artifact.result.mesh;
      viewer.displayColliderMesh(
        new Float32Array(overlay.vertices),
        new Uint32Array(overlay.indices),
        0.35
      );
      viewer.setColliderVisible(true);
      hasCollisionBoundary.value = true;
      appendLog(
        `[SUCCESS] Collision boundary ready: ${overlay.vertex_count} vertices, ${overlay.face_count} faces.`
      );
    }
    return artifact;
  };

  const exportCollisionMesh = async (): Promise<Uint8Array> => {
    const artifact = currentCollisionArtifact ?? await generateCollisionBoundary();
    return exportCollisionBoundaryGlb({
      artifact,
      filename: `${currentName}.collision.glb`,
    });
  };

  const setCollisionBoundaryVisible = (visible: boolean): void => {
    babylon.viewer.value?.setColliderVisible(visible);
  };

  const goToPlayer = (): void => {
    const viewer = babylon.viewer.value;
    if (!viewer || !hasNavMesh.value) {
      appendLog('[WARN] Go to Player: no player agent.');
      return;
    }
    const framing = viewer.focusOnPlayer();
    if (framing) {
      topDownViewApplied.value = true;
      appendLog(
        `[SUCCESS] Go to Player — top-down at ` +
          `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
      );
      return;
    }
    appendLog('[WARN] Go to Player: focusOnPlayer returned null.');
  };

  const stopPoseInfoSampling = (): void => {
    if (poseInfoRafId !== 0) {
      cancelAnimationFrame(poseInfoRafId);
      poseInfoRafId = 0;
    }
  };

  const samplePoseInfoOnce = (): void => {
    const viewer = babylon.viewer.value;
    const cam = viewer?.getCameraPoseNavKit() ?? null;
    if (cam) {
      cameraInfo.value = {
        eulerDegrees: { ...cam.eulerDegrees },
        mode: null,
        position: { ...cam.position },
        target: { ...cam.target },
      };
    } else {
      cameraInfo.value = emptyNavKitCameraPoseInfo();
    }
    const player = viewer?.getPlayerPoseNavKit() ?? null;
    if (player) {
      playerInfo.value = {
        available: true,
        eulerDegrees: { ...player.eulerDegrees },
        position: { ...player.position },
      };
    } else {
      playerInfo.value = emptyNavKitPlayerPoseInfo();
    }
  };

  const tickPoseInfoSampling = (): void => {
    if (!cameraInfoPanelOpen && !playerInfoPanelOpen) {
      poseInfoRafId = 0;
      return;
    }
    samplePoseInfoOnce();
    poseInfoRafId = requestAnimationFrame(tickPoseInfoSampling);
  };

  const syncPoseInfoSampling = (): void => {
    if (!cameraInfoPanelOpen && !playerInfoPanelOpen) {
      stopPoseInfoSampling();
      return;
    }
    if (poseInfoRafId !== 0) {
      return;
    }
    samplePoseInfoOnce();
    poseInfoRafId = requestAnimationFrame(tickPoseInfoSampling);
  };

  const setCameraInfoPanelOpen = (open: boolean): void => {
    cameraInfoPanelOpen = open;
    syncPoseInfoSampling();
  };

  const setPlayerInfoPanelOpen = (open: boolean): void => {
    playerInfoPanelOpen = open;
    syncPoseInfoSampling();
  };

  const copyCameraPose = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(cameraInfoCopyText.value);
      return true;
    } catch {
      return false;
    }
  };

  const copyPlayerPose = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(playerInfoCopyText.value);
      return true;
    } catch {
      return false;
    }
  };

  const setNavMeshVisible = (visible: boolean): void => {
    babylon.viewer.value?.setNavMeshVisible(visible);
  };

  const setNavMeshEditorEnabled = (enabled: boolean): void => {
    babylon.viewer.value?.setNavMeshEditorEnabled(enabled);
  };
  const setNavMeshEditorMode = (mode: 'vertex' | 'circle' | 'global'): void => {
    babylon.viewer.value?.setNavMeshEditorMode(mode);
  };
  const navMeshEditorGlobalY = (steps: number): void => {
    babylon.viewer.value?.navMeshEditorGlobalY(steps);
  };
  const navMeshEditorFillHole = (): boolean =>
    babylon.viewer.value?.navMeshEditorFillHole() ?? false;
  const navMeshEditorDeleteVertices = async (): Promise<boolean> => {
    const viewer = babylon.viewer.value;
    if (!viewer) {
      return false;
    }
    return viewer.navMeshEditorDeleteVertices();
  };
  const applyNavMeshEditorToLive = async (): Promise<boolean> => {
    const viewer = babylon.viewer.value;
    if (!viewer) {
      return false;
    }
    return viewer.applyNavMeshEditorToLive();
  };
  const onNavMeshEditorStatus = (
    listener: (status: import('@/navigation/navmeshEditor').NavMeshEditorStatus) => void
  ): (() => void) => {
    const viewer = babylon.viewer.value;
    if (!viewer) {
      return () => undefined;
    }
    return viewer.onNavMeshEditorStatus(listener);
  };
  const getNavMeshEditorStatus = () =>
    babylon.viewer.value?.getNavMeshEditorStatus() ?? null;
  const getNavMeshData = (): Uint8Array | null =>
    babylon.viewer.value?.getNavMeshData() ?? null;

  const setSelectionRegionVisible = async (visible: boolean): Promise<void> => {
    const viewer = babylon.viewer.value;
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
      appendLog('[INFO] Selection region hidden — Fast Nav will auto-select a region.');
      return;
    }

    if (!currentBytes || !viewer) {
      throw new Error('Load a splat before showing the selection region.');
    }

    errorMessage.value = null;
    try {
      let region = cachedSelectionRegion;
      if (!region) {
        try {
          const rotation = viewer.getSplatRotation();
          const suggested = await splatwalk.suggestRegion(currentBytes, {
            mode: 2,
            flip_y: viewer.isSplatYFlipped(),
            rotation: [rotation.x, rotation.y, rotation.z],
            prune_floaters: navSettings.value.pruneFloaters,
            environment_scale: viewer.getEnvironmentScale(),
          });
          region = {
            min: [...suggested.region_min],
            max: [...suggested.region_max],
          };
          appendLog(
            `[INFO] Selection region suggested: ` +
              `${region.min.map((v) => v.toFixed(2)).join(', ')} → ` +
              `${region.max.map((v) => v.toFixed(2)).join(', ')}`
          );
        } catch (suggestError) {
          const splatBounds = viewer.getSplatBoundsForDiagnostics();
          if (!splatBounds) {
            throw suggestError;
          }
          region = {
            min: [splatBounds.min.x, splatBounds.min.y, splatBounds.min.z],
            max: [splatBounds.max.x, splatBounds.max.y, splatBounds.max.z],
          };
          appendLog(
            `[WARN] suggestRegion failed; using splat AABB for selection region.`
          );
        }
        cachedSelectionRegion = region;
      }
      viewer.enableRegionSelection({ min: region.min, max: region.max });
      selectionRegionVisible.value = true;
      appendLog(
        '[INFO] Selection region shown — drag/scale the yellow box, then Re-run Fast Nav to pin it.'
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      selectionRegionVisible.value = false;
      appendLog(`[ERROR] ${detail}`);
      throw error;
    }
  };

  const setPendingEnvironmentScale = (scale: number): void => {
    if (!Number.isFinite(scale) || scale <= 0) {
      return;
    }
    pendingEnvironmentScale = scale;
    sessionEnvironmentScale.value = scale;
    babylon.viewer.value?.setEnvironmentScale(scale);
  };

  /**
   * Multiply absolute session scale by {@link scaleMultiplier}. Factor `1` is a no-op.
   */
  const applyScaleMultiplier = (scaleMultiplier: number): number => {
    if (!Number.isFinite(scaleMultiplier) || scaleMultiplier <= 0) {
      throw new Error('Scale Environment must be a positive number.');
    }
    const current =
      babylon.viewer.value?.getEnvironmentScale() ?? pendingEnvironmentScale;
    if (scaleMultiplier === 1) {
      sessionEnvironmentScale.value = current;
      return current;
    }
    const next = current * scaleMultiplier;
    pendingEnvironmentScale = next;
    sessionEnvironmentScale.value = next;
    babylon.viewer.value?.setEnvironmentScale(next);
    appendLog(`[INFO] Session scale → ${next} (×${scaleMultiplier})`);
    return next;
  };

  const rerunFastNav = async (rerunOptions?: {
    readonly scaleMultiplier?: number;
  }): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    if (!currentBytes) {
      throw new Error('Load a splat before re-running Fast Nav.');
    }
    const viewer = babylon.viewer.value;
    if (!viewer) {
      throw new Error('Viewer is not ready.');
    }

    if (rerunOptions?.scaleMultiplier !== undefined) {
      applyScaleMultiplier(rerunOptions.scaleMultiplier);
    }

    errorMessage.value = null;
    // Keep the selection box if visible so getRegionBounds() pins the AABB.
    if (selectionRegionVisible.value) {
      const bounds = viewer.getRegionBounds();
      if (bounds) {
        cachedSelectionRegion = {
          min: [...bounds.min],
          max: [...bounds.max],
        };
      }
    }
    currentCollisionArtifact = null;
    currentNavMeshData = null;
    hasNavMesh.value = false;

    const regionNote = viewer.getRegionBounds() ? ' (pinned region)' : '';
    const mode = navGenerationMode.value;
    appendLog(
      `[INFO] Re-running nav (${mode})${regionNote}… ` +
        `environment_scale=${viewer.getEnvironmentScale()}`
    );

    try {
      topDownViewApplied.value = false;
      status.value = 'processing';
      statusMessage.value = `Re-running ${mode}…`;
      phase.value = 'idle';
      progress.value = null;

      const tuning = resolveFastNavTuning();
      appendLog(`[INFO] Floater prune: ${tuning.prune.enabled === false ? 'off' : 'on'}`);
      appendLog(`[INFO] Collision scene type: ${resolveCollisionSceneType(mode)}`);

      const rotation = viewer.getSplatRotation();
      const collisionSettings =
        mode === 'floor_field'
          ? undefined
          : buildDemoCollisionSettings({
              algo: mode,
              emitGlb: false,
              emitVolume: true,
              flipY: viewer.isSplatYFlipped(),
              rotation: [rotation.x, rotation.y, rotation.z],
              seed: seedFromRegionBounds({ regionBounds: viewer.getRegionBounds() }),
            });

      const activeMode =
        mode === 'floor_field' ? 'recast' : activeNavigationMode.value;
      if (mode === 'floor_field' && activeNavigationMode.value !== 'recast') {
        activeNavigationMode.value = 'recast';
      }
      const sceneTypeForRun = resolveCollisionSceneType(mode);
      const fastNav = await runFastNav({
        activeNavigationMode: activeMode,
        algo: mode,
        viewer,
        bytes: currentBytes,
        cameraSelect: sessionCameraSelect ?? options.cameraSelect,
        keepCameraSelectView: options.keepCameraSelectView,
        collisionSettings,
        onLog: appendLog,
        onPhase: (next) => {
          phase.value = next;
        },
        recovery: options.recovery,
        strayTrim: options.strayTrim,
        ...tuning,
        // Outdoor floor_field: seed-centered ~100 m pin (Storage Adapter / prod parity).
        seedCenteredOutdoor: mode === 'floor_field' && sceneTypeForRun === 'outdoor',
      });
      currentNavMeshData = fastNav.navMeshData;
      hasNavMesh.value = true;
      viewer.setControlsMode(controlsMode.value);
      if (mode === 'voxel_collision' || mode === 'sdf_marching_cubes') {
        hasCollisionBoundary.value = true;
      }
      if (viewer.getRegionBounds()) {
        selectionRegionVisible.value = true;
      }
      syncSessionFromFastNav({
        navMeshData: fastNav.navMeshData,
        playerSpawn: fastNav.playerSpawn,
        volume: fastNav.volume,
      });
      await storeMinimalNavArtifacts({
        debugIndices: fastNav.debugIndices,
        debugPositions: fastNav.debugPositions,
        navMeshData: fastNav.navMeshData,
        playerSpawn: fastNav.playerSpawn,
        volume: fastNav.volume,
      });
      phase.value = 'done';
      progress.value = null;

      if (!fastNav.keptCameraSelectView) {
        statusMessage.value = 'Framing the player (top-down)...';
        const framing = viewer.focusOnPlayer();
        if (framing) {
          topDownViewApplied.value = true;
          appendLog(
            `[SUCCESS] Top-down view set above player at ` +
              `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
          );
        }
      }

      status.value = 'done';
      statusMessage.value =
        mode === 'sdf_marching_cubes'
          ? 'SDF Marching Cubes nav complete. Click the navmesh to move.'
          : mode === 'voxel_collision'
            ? 'Voxel collision nav complete. Click the navmesh to move.'
            : 'Fast Nav complete. Click the navmesh to move the player.';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = 'Nav generation failed.';
      // Keep any prior navmesh if recompute failed after a successful run.
      if (!currentNavMeshData) {
        hasNavMesh.value = false;
      }
      throw error;
    }
  };

  const applyEnvironmentScale = async (scaleMultiplier: number): Promise<void> => {
    if (isBusy.value) {
      return;
    }

    errorMessage.value = null;
    const sessionScale = applyScaleMultiplier(scaleMultiplier);

    if (!currentBytes) {
      appendLog(
        `[INFO] Session scale → ${sessionScale} (applies on next Fast Nav).`
      );
      return;
    }

    appendLog(`[INFO] Session scale → ${sessionScale}; re-running FAST NAV...`);
    await rerunFastNav();
  };

  const resetCameraSelectOffsets = (): void => {
    cameraSelectOffsets.value = { ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS };
  };

  const applySelectRegionFromCamera = async (): Promise<void> => {
    const viewer = babylon.viewer.value;
    if (!viewer) {
      throw new Error('Viewer is not ready.');
    }
    const cam = viewer.getScene().activeCamera;
    if (!(cam instanceof FreeCamera)) {
      appendLog('[WARN] Apply select region from camera requires Fly (FreeCamera) mode.');
      return;
    }
    const radToDeg = 180 / Math.PI;
    const input: CameraSelectRegionInput = {
      view: {
        position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
        eulerDegrees: {
          x: cam.rotation.x * radToDeg,
          y: cam.rotation.y * radToDeg,
          z: cam.rotation.z * radToDeg,
        },
      },
      offsets: { ...cameraSelectOffsets.value },
    };
    sessionCameraSelect = input;
    const bounds = regionBoundsFromCameraSelect(input);
    cachedSelectionRegion = { min: [...bounds.min], max: [...bounds.max] };
    viewer.enableRegionSelection({ min: bounds.min, max: bounds.max });
    selectionRegionVisible.value = true;
    appendLog(
      `[INFO] Camera select region pinned: ` +
        `${bounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
        `${bounds.max.map((v) => v.toFixed(2)).join(', ')}`
    );
  };

  const setControlsMode = (mode: NavKitControlsMode): void => {
    controlsMode.value = mode;
    const viewer = babylon.viewer.value;
    if (viewer) {
      viewer.setControlsMode(mode);
    }
    appendLog(`[INFO] Controls mode: ${mode}.`);
  };

  const syncBundleForDownload = async (): Promise<NavArtifactBundle | null> => {
    if (!currentNavArtifactBundle) {
      return null;
    }
    const viewer = babylon.viewer.value;
    if (viewer?.getNavMeshEditorStatus()?.hasPendingLiveApply) {
      appendLog('[INFO] Applying pending NavMesh Editor edits before download…');
      await viewer.applyNavMeshEditorToLive();
    }
    const editedNav = viewer?.getNavMeshData();
    const editedBuffers = viewer?.getOrientedNavMeshBuffers();
    if (!editedNav || !editedBuffers) {
      return currentNavArtifactBundle;
    }
    currentNavMeshData = editedNav;
    sessionRecastBin.value = editedNav;
    const region = viewer?.getWasmRegionBounds() ?? null;
    const spawn = sessionSpawn.value;
    currentNavArtifactBundle = await rebuildNavArtifactBundleFromLiveMesh({
      base: currentNavArtifactBundle,
      debugIndices: editedBuffers.indices,
      debugPositions: editedBuffers.positions,
      navMeshData: editedNav,
      playerSpawn: spawn,
      regionMax: region?.max ?? null,
      regionMin: region?.min ?? null,
      volume: sessionVolume.value,
    });
    syncNavExportReadiness();
    return currentNavArtifactBundle;
  };

  const downloadNavKit = async (): Promise<void> => {
    if (!currentNavArtifactBundle || !currentModelSourceBytes) {
      appendLog('[WARN] No NavKit — run Fast Nav on a loaded splat first.');
      return;
    }
    const locomotionMode =
      liveBackend.value === 'voxel_walk' ? 'voxel_walk' : 'recast_crowd';
    const modelFilename = reconcileSplatModelFilename(
      currentModelSourceBytes,
      currentModelFilename
    );
    currentModelFilename = modelFilename;
    const viewer = babylon.viewer.value;
    const navBundle = await syncBundleForDownload();
    if (!navBundle) {
      appendLog('[WARN] No NavKit — run Fast Nav on a loaded splat first.');
      return;
    }
    const regionBounds = viewer?.getRegionBounds() ?? null;
    const cam = viewer?.getCameraPoseNavKit() ?? null;
    const player = viewer?.getPlayerPoseNavKit() ?? null;
    downloadNavKitZip({
      activeNavigationMode: activeNavigationMode.value,
      camEulerDeg: cam?.eulerDegrees ?? null,
      camPos: cam?.position ?? null,
      camTarget: cam?.target ?? null,
      controlsMode: controlsMode.value,
      locomotionMode,
      modelBytes: currentModelSourceBytes,
      modelFilename,
      navBundle,
      navTechnique: navGenerationMode.value,
      playerEulerDeg: player?.eulerDegrees ?? null,
      playerPos: player?.position ?? null,
      region: regionBounds
        ? {
            min: [
              regionBounds.min[0]!,
              regionBounds.min[1]!,
              regionBounds.min[2]!,
            ],
            max: [
              regionBounds.max[0]!,
              regionBounds.max[1]!,
              regionBounds.max[2]!,
            ],
          }
        : null,
      slug: currentName,
      title: currentName,
    });
    appendLog(`[SUCCESS] Downloaded navkit-${currentName}.zip`);
  };

  const downloadNavArtifacts = async (): Promise<void> => {
    const bundle = await syncBundleForDownload();
    if (!bundle) {
      appendLog('[WARN] No nav artifact pack — run Fast Nav first.');
      return;
    }
    downloadNavArtifactZip({ bundle, slug: currentName });
    appendLog(`[SUCCESS] Downloaded nav-artifacts-${currentName}.zip`);
  };

  const uploadNavArtifacts = async (files: File[] | FileList): Promise<void> => {
    const list = Array.from(files);
    appendLog(
      `[INFO] Uploading nav artifacts (${list.length} file${list.length === 1 ? '' : 's'}: ` +
        `${list.map((f) => f.name).join(', ') || '(none)'})…`
    );
    if (isBusy.value) {
      appendLog('[WARN] Upload ignored — another job is still running.');
      return;
    }
    const viewer = babylon.viewer.value;
    if (!viewer || !hasLoadedSplat.value) {
      const detail = 'Load a splat before uploading nav artifacts.';
      appendLog(`[ERROR] ${detail}`);
      throw new Error(detail);
    }
    errorMessage.value = null;
    try {
      status.value = 'processing';
      statusMessage.value = 'Uploading nav artifacts...';
      const parsed = await parseNavArtifactFiles(list);
      appendLog(
        `[INFO] Parsed pack: locomotion=${parsed.session.locomotionMode}` +
          (parsed.bundle.recastNavmeshBin ? ', recast.navmesh.bin' : '') +
          (parsed.volume ? ', volume trio' : '')
      );
      viewer.clearNavArtifacts();
      currentNavArtifactBundle = parsed.bundle;
      syncNavExportReadiness();
      if (parsed.bundle.recastNavmeshBin) {
        currentNavMeshData = parsed.bundle.recastNavmeshBin;
        sessionRecastBin.value = parsed.bundle.recastNavmeshBin;
      }
      sessionVolume.value = parsed.volume;
      if (parsed.session.playerSpawn && parsed.session.playerSpawn.length >= 3) {
        sessionSpawn.value = [
          parsed.session.playerSpawn[0]!,
          parsed.session.playerSpawn[1]!,
          parsed.session.playerSpawn[2]!,
        ];
        sessionSeed.value = [...sessionSpawn.value];
      }
      await applyNavArtifactsToViewer({
        onLog: appendLog,
        parsed,
        viewer,
      });
      // Default focusCamera frames top-down after artifact restore.
      topDownViewApplied.value = true;
      liveBackend.value =
        parsed.session.locomotionMode === 'voxel_walk' ? 'voxel_walk' : 'recast_crowd';
      hasNavMesh.value = true;
      viewer.setControlsMode(controlsMode.value);
      status.value = 'done';
      statusMessage.value =
        'Nav artifacts restored. Use Controls (click / WASDQE / both) to move.';
      appendLog(`[SUCCESS] Uploaded nav artifacts. ${NAV_ARTIFACT_UPLOAD_HINT}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = 'Upload nav artifacts failed.';
      throw error;
    }
  };

  return {
    status,
    statusMessage,
    errorMessage,
    logs,
    isBusy,
    phase,
    progress,
    splatCount,
    maxShDegree,
    maxChunkExtent,
    loadAndProcess,
    loadSplatOnly,
    loadExample,
    exportSog,
    exportNavmesh,
    goToPlayer,
    topDownViewApplied,
    downloadNavKit,
    loadNavKit,
    downloadNavArtifacts,
    uploadNavArtifacts,
    hasNavArtifactBundle,
    hasNavKit,
    controlsMode,
    setControlsMode,
    controlsWasdLegend: NAV_KIT_WASDQE_LEGEND,
    navArtifactUploadHint: NAV_ARTIFACT_UPLOAD_HINT,
    navKitUploadHint: NAV_KIT_UPLOAD_HINT,
    cameraSelectOffsets,
    resetCameraSelectOffsets,
    cameraInfo,
    cameraInfoCopyText,
    copyCameraPose,
    setCameraInfoPanelOpen,
    playerInfo,
    playerInfoCopyText,
    copyPlayerPose,
    setPlayerInfoPanelOpen,
    applySelectRegionFromCamera,
    generateCollisionBoundary,
    exportCollisionMesh,
    setCollisionBoundaryVisible,
    hasCollisionBoundary,
    setNavMeshVisible,
    setNavMeshEditorEnabled,
    setNavMeshEditorMode,
    navMeshEditorGlobalY,
    navMeshEditorFillHole,
    navMeshEditorDeleteVertices,
    applyNavMeshEditorToLive,
    onNavMeshEditorStatus,
    getNavMeshEditorStatus,
    getNavMeshData,
    navSettings,
    resetNavSettings,
    hasNavMesh,
    pruneFloaters,
    hasLoadedSplat: hasLoadedSplatComputed,
    selectionRegionVisible,
    setSelectionRegionVisible,
    rerunFastNav,
    navGenerationMode,
    collisionSceneType,
    setCollisionSceneType,
    activeNavigationMode,
    setActiveNavigationMode,
    activeNavigationModeDisabledReason,
    liveBackend,
    navCapabilities,
    applyScaleMultiplier,
    sessionEnvironmentScale,
    applyEnvironmentScale,
    setPendingEnvironmentScale,
    reset,
  };
}
