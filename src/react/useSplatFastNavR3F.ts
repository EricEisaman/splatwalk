import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import NavWorker from '@/navigation/navmesh.worker?worker';
import {
  buildCollisionBoundarySettings,
  exportCollisionBoundaryGlb,
  exportNavmeshBinary,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
  seedFromRegionBounds,
  type CollisionBoundaryArtifact,
} from '@/collision/voxelBoundary';
import { applyNavArtifactsToR3F } from '@/navigation/applyNavArtifacts';
import { applyNavKitMetaToR3F } from '@/navigation/applyNavKitMeta';
import {
  DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  clampPointToAabb,
  groundAnchoredCameraRegion,
  regionBoundsFromCameraPose,
  regionBoundsFromCameraSelect,
  type CameraSelectRegionInput,
  type CameraSelectRegionOffsets,
} from '@/navigation/cameraSelectRegion';
import {
  applySeedCenteredOutdoorFieldKnobs,
  applySeedCenteredOutdoorPin,
  FAST_NAV_PRESET,
  FAST_NAV_RECAST_ATTEMPTS,
  VOXEL_COLLIDER_RECAST_ATTEMPTS,
  extractFloorFieldWithRecovery,
  resolveRecovery,
  type FastNavLogger,
  type RecastParams,
} from '@/navigation/fastNav';
import {
  buildFastNavCacheSignature,
  FAST_NAV_FLOOR_PIPELINE,
} from '@/navigation/fastNavCacheSignature';
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
  downloadNavKitZip,
  parseNavKitFile,
  peekNavKitMeta,
} from '@/navigation/navKitBundle';
import {
  emptyNavKitCameraPoseInfo,
  emptyNavKitPlayerPoseInfo,
  formatNavKitCameraCopyText,
  formatNavKitPlayerCopyText,
  type NavKitCameraPoseInfo,
  type NavKitPlayerPoseInfo,
} from '@/navigation/navKitPoseInfo';
import {
  DEFAULT_ACTIVE_NAVIGATION_MODE,
  activeNavigationModeDisabledReason as sharedActiveNavigationModeDisabledReason,
  type ActiveNavigationMode,
  type LiveNavBackend,
  type NavCapabilities,
  navCapabilitiesFromParts,
} from '@/navigation/activeNavigation';
import { resolveActiveNavigationChange } from '@/navigation/demoActiveNavigation';
import {
  DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
  demoNavSettingsForSceneType,
  demoNavSettingsToFastNavTuning,
  type DemoNavSettings,
} from '@/navigation/navSettings';
import { buildNavmeshKey, getNavmesh, putNavmesh } from '@/navigation/navmeshCache';
import { ensureSdfMcRegionForDenseBudget } from '@/navigation/collisionGridBudget';
import {
  collisionSceneTypeForAlgo,
  type ExampleCollisionSceneType,
} from '@/navigation/exampleSceneCollision';
import { requireSdfMcColliderMesh } from '@/navigation/sdfMcColliderOverlay';
import {
  DEFAULT_VOXEL_NAV_SETTINGS,
  type NavGenerationMode,
  voxelNavSettingsToCollisionBase,
} from '@/navigation/voxelNavSettings';
import {
  volumeToConnectedWalkableMesh,
  volumeToWalkableFloorMesh,
} from '@/navigation/voxelWalkRuntime';
import { splatwalk, type CollisionVoxelVolume, type FastNavSettings, type MeshSettings } from '@/wasm/bridge';
import {
  normalizeSplatToPly,
  reconcileSplatModelFilename,
  SUPPORTED_SPLAT_EXTENSIONS,
} from '@/wasm/normalize';
import { SliceArchive } from '@/wasm/sliceArchive';
import {
  DEFAULT_SLICE_SETTINGS,
  inferPlyShDegree,
  maxChunkExtentFromBounds,
  type SliceSettings,
} from '@/wasm/sogTypes';
import { SplatNavController } from '@/react/three/SplatNavController';

/** Options for {@link useSplatFastNavR3F} (mirrors Babylon `useSplatFastNav`). */
export interface UseSplatFastNavR3FOptions {
  readonly cameraSelect?: CameraSelectRegionInput;
  readonly keepCameraSelectView?: boolean;
}

export type SogExportMode = 'streamed' | 'single';
export type FastNavStatus = 'idle' | 'loading' | 'processing' | 'done' | 'error';
export type LogTag = 'info' | 'wait' | 'warn' | 'error' | 'success' | 'worker';
export type FastNavUiPhase = 'idle' | 'prune' | 'floor' | 'navmesh' | 'done';

export interface LogEntry {
  readonly id: number;
  readonly tag: LogTag;
  readonly message: string;
}

export interface FastNavProgress {
  readonly stage: string;
  readonly fraction: number | null;
}

const SUPPORTED_EXTENSIONS = SUPPORTED_SPLAT_EXTENSIONS;

interface NavWorkerResult {
  navMeshData: Uint8Array;
  debugPositions: Float32Array;
  debugIndices: Uint32Array;
}

function parseLog(message: string): LogEntry {
  const match = /^\[(INFO|WAIT|WARN|ERROR|SUCCESS|WORKER)\]\s*/.exec(message);
  const tag = (match?.[1]?.toLowerCase() as LogTag | undefined) ?? 'info';
  const text = match ? message.slice(match[0].length) : message;
  return { id: Date.now() + Math.random(), tag, message: text };
}

/** Read raw splat bytes; `.spz` / `.splat` are normalized to PLY via WASM. */
async function readSplatBytes(file: File): Promise<Uint8Array> {
  return normalizeSplatToPly(file);
}

function runNavWorker(
  positions: Float32Array,
  indices: Uint32Array,
  params: RecastParams,
  splatBounds: { min: number[]; max: number[] } | null,
  sourceLabel: string,
  colliderBounds: { min: number[]; max: number[] } | null
): Promise<NavWorkerResult> {
  const worker = new NavWorker();
  return new Promise<NavWorkerResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent): void => {
      const { type, payload } = e.data;
      if (type === 'done') {
        worker.terminate();
        resolve(payload as NavWorkerResult);
      } else if (type === 'error') {
        worker.terminate();
        reject(new Error(String(payload)));
      }
    };
    worker.onerror = (event): void => {
      worker.terminate();
      reject(new Error(event.message || 'NavMesh worker crashed.'));
    };
    worker.postMessage({
      type: 'generate',
      payload: { positions, indices, params, sourceLabel, splatBounds, colliderBounds },
    });
  });
}

async function generateNavMesh(options: {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly splatBounds: { min: number[]; max: number[] } | null;
  readonly log: FastNavLogger;
  readonly recastOverrides?: Partial<RecastParams>;
  readonly sourceLabel?: string;
  readonly colliderBounds?: { min: number[]; max: number[] } | null;
  readonly useVoxelRecastLadder?: boolean;
}): Promise<NavWorkerResult> {
  const sourceLabel = options.sourceLabel ?? 'fast_floor_field';
  const colliderBounds = options.colliderBounds ?? null;
  const baseAttempts = options.useVoxelRecastLadder
    ? VOXEL_COLLIDER_RECAST_ATTEMPTS
    : FAST_NAV_RECAST_ATTEMPTS;
  const attempts = options.recastOverrides
    ? baseAttempts.map((attempt) => ({
        ...attempt,
        params: { ...attempt.params, ...options.recastOverrides },
      }))
    : baseAttempts;
  let lastError: unknown = null;
  for (const attempt of attempts) {
    options.log(`[WAIT] Spawning NavMesh worker (${attempt.label}, ${sourceLabel})...`);
    try {
      const result = await runNavWorker(
        options.positions,
        options.indices,
        attempt.params as RecastParams,
        options.splatBounds,
        sourceLabel,
        colliderBounds
      );
      if (result.debugIndices.length < 3) {
        throw new Error('Recast produced an empty debug navmesh.');
      }
      if (attempt.label !== 'strict') {
        options.log(`[WARN] Fast nav recovered with ${attempt.label} Recast settings.`);
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === attempts[attempts.length - 1]) {
        break;
      }
      options.log(
        `[WARN] Fast nav ${attempt.label} attempt failed; retrying with relaxed Recast settings.`
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const boundsFromPositions = (
  positions: Float32Array
): { min: number[]; max: number[] } | null => {
  if (positions.length < 3) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
};

function navMeshCentroid(positions: Float32Array): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    if (Number.isFinite(positions[i])) {
      x += positions[i];
      y += positions[i + 1];
      z += positions[i + 2];
      n += 1;
    }
  }
  return n > 0 ? [x / n, y / n, z / n] : [0, 0, 0];
}

function farthestVertex(
  positions: Float32Array,
  from: [number, number, number]
): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let bestD = -1;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d = Math.hypot(positions[i] - from[0], positions[i + 2] - from[2]);
    if (d > bestD) {
      bestD = d;
      best = [positions[i], positions[i + 1], positions[i + 2]];
    }
  }
  return best;
}

/**
 * React orchestration for the R3F Fast Nav showcase: drop/browse a splat, render
 * it, auto-run WASM `fast_nav` (floor / voxel / SDF via Navmesh settings) → Recast
 * → crowd + NPC, then frame the player. Mirrors Vuetify `useSplatFastNav`, but
 * drives the three.js {@link SplatNavController} instead of the Babylon viewer.
 *
 * When `cameraSelect` is set, pins {@link SplatNavController.enableRegionSelection}
 * from the derived AABB and restores that view after nav (skips top-down focus).
 */
export function useSplatFastNavR3F(options: UseSplatFastNavR3FOptions = {}) {
  const controller = useMemo(() => new SplatNavController(), []);
  const cameraSelectRef = useRef(options.cameraSelect);
  const keepCameraSelectViewRef = useRef(options.keepCameraSelectView !== false);
  keepCameraSelectViewRef.current = options.keepCameraSelectView !== false;
  useEffect(() => {
    if (options.cameraSelect) {
      cameraSelectRef.current = options.cameraSelect;
    }
  }, [options.cameraSelect]);
  const currentNavArtifactBundle = useRef<NavArtifactBundle | null>(null);
  const [hasNavArtifactBundle, setHasNavArtifactBundle] = useState(false);
  const [cameraSelectOffsets, setCameraSelectOffsetsState] = useState<CameraSelectRegionOffsets>({
    ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  });
  const cameraSelectOffsetsRef = useRef(cameraSelectOffsets);
  cameraSelectOffsetsRef.current = cameraSelectOffsets;

  const [status, setStatus] = useState<FastNavStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('Drop a .ply, .spz, or .splat splat to begin.');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<FastNavUiPhase>('idle');
  const [progress, setProgress] = useState<FastNavProgress | null>(null);
  const [splatCount, setSplatCount] = useState<number | null>(null);
  const [maxShDegree, setMaxShDegree] = useState(DEFAULT_SLICE_SETTINGS.sh_degree);
  const [maxChunkExtent, setMaxChunkExtent] = useState(DEFAULT_SLICE_SETTINGS.chunk_extent);
  // HEAD / prod floor_field uses outdoor-wide DemoNavSettings (coverage parity).
  const [navSettings, setNavSettings] = useState<DemoNavSettings>(() => ({
    ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
  }));
  const [selectionRegionVisible, setSelectionRegionVisibleState] = useState(false);
  const [hasLoadedSplat, setHasLoadedSplat] = useState(false);
  const [hasNavMesh, setHasNavMesh] = useState(false);
  const [hasCollisionBoundary, setHasCollisionBoundary] = useState(false);
  const [topDownViewApplied, setTopDownViewApplied] = useState(false);
  const [navGenerationMode, setNavGenerationModeState] =
    useState<NavGenerationMode>('floor_field');
  const [collisionSceneType, setCollisionSceneTypeState] =
    useState<ExampleCollisionSceneType>('indoor');
  const [activeNavigationMode, setActiveNavigationModeState] =
    useState<ActiveNavigationMode>(DEFAULT_ACTIVE_NAVIGATION_MODE);
  const [controlsMode, setControlsModeState] = useState<NavKitControlsMode>(
    DEFAULT_NAV_KIT_CONTROLS_MODE_NEW
  );
  const [liveBackend, setLiveBackend] = useState<LiveNavBackend>('none');
  const liveBackendRef = useRef<LiveNavBackend>('none');
  liveBackendRef.current = liveBackend;
  const sessionVolumeRef = useRef<CollisionVoxelVolume | null>(null);
  const sessionRecastBinRef = useRef<Uint8Array | null>(null);
  const sessionSpawnRef = useRef<[number, number, number] | null>(null);
  const lastRecastDebugMeshRef = useRef<{
    positions: Float32Array;
    indices: Uint32Array;
  } | null>(null);
  const activeNavigationModeRef = useRef(activeNavigationMode);
  activeNavigationModeRef.current = activeNavigationMode;

  const wasmReady = useRef(false);
  const currentCollisionArtifact = useRef<CollisionBoundaryArtifact | null>(null);
  const currentBytes = useRef<Uint8Array | null>(null);
  const currentModelSourceBytes = useRef<Uint8Array | null>(null);
  const currentModelFilename = useRef('model.ply');
  const currentName = useRef('splat');
  const currentNavMeshData = useRef<Uint8Array | null>(null);
  const [hasNavKit, setHasNavKit] = useState(false);
  const [cameraInfo, setCameraInfo] = useState<NavKitCameraPoseInfo>(emptyNavKitCameraPoseInfo);
  const [playerInfo, setPlayerInfo] = useState<NavKitPlayerPoseInfo>(emptyNavKitPlayerPoseInfo);
  const [cameraInfoPanelOpen, setCameraInfoPanelOpenState] = useState(false);
  const [playerInfoPanelOpen, setPlayerInfoPanelOpenState] = useState(false);
  /** Stashed so Scale Environment set before load applies on first Fast Nav. */
  const pendingEnvironmentScale = useRef(1);
  const [sessionEnvironmentScale, setSessionEnvironmentScale] = useState(1);
  /** Last selection-region AABB so hide→show can restore the user's box. */
  const cachedSelectionRegion = useRef<{ min: number[]; max: number[] } | null>(null);
  const navSettingsRef = useRef(navSettings);
  navSettingsRef.current = navSettings;
  const navGenerationModeRef = useRef(navGenerationMode);
  /** Commit scene type before the next render so load-after-dropdown never races. */
  const collisionSceneTypeRef = useRef<ExampleCollisionSceneType>('indoor');
  const appendLog = useCallback((message: string): void => {
    setLogs((prev) => [...prev, parseLog(message)]);
    console.log(message);
  }, []);

  useEffect(() => {
    return controller.onEditedNavMeshRebake(async (result) => {
      currentNavMeshData.current = result.navMeshData;
      sessionRecastBinRef.current = result.navMeshData;
      lastRecastDebugMeshRef.current = {
        positions: result.debugPositions,
        indices: result.debugIndices,
      };
      const region = controller.getRegionBounds();
      currentNavArtifactBundle.current = await buildMinimalNavArtifactBundle({
        debugIndices: result.debugIndices,
        debugPositions: result.debugPositions,
        navMeshData: result.navMeshData,
        playerSpawn: sessionSpawnRef.current,
        regionMax: region?.max ?? null,
        regionMin: region?.min ?? null,
        volume: sessionVolumeRef.current,
      });
      setHasNavArtifactBundle(true);
      appendLog(
        '[INFO] NavMesh Editor rebake synced to session / NavKit artifacts.'
      );
    });
  }, [appendLog, controller]);

  const setNavGenerationMode = useCallback((mode: NavGenerationMode): void => {
    navGenerationModeRef.current = mode;
    setNavGenerationModeState(mode);
    controller.clearCollisionBoundary();
    setHasCollisionBoundary(false);
    if (mode === 'floor_field') {
      setActiveNavigationModeState(DEFAULT_ACTIVE_NAVIGATION_MODE);
      setNavSettings((prev) => ({
        ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
        pruneFloaters: prev.pruneFloaters,
      }));
      appendLog('[INFO] floor_field: restored outdoor DemoNavSettings (HEAD/prod parity).');
    } else {
      setNavSettings((prev) =>
        demoNavSettingsForSceneType(collisionSceneTypeRef.current, {
          preservePrune: prev.pruneFloaters,
        })
      );
    }
  }, [appendLog, controller]);
  const setCollisionSceneType = useCallback((sceneType: ExampleCollisionSceneType): void => {
    collisionSceneTypeRef.current = sceneType;
    setCollisionSceneTypeState(sceneType);
    // floor_field matches HEAD/prod outdoor bands; indoor/outdoor presets apply to voxel/SDF-MC.
    if (navGenerationModeRef.current === 'floor_field') {
      appendLog(
        `[INFO] Scene type → ${sceneType} (floor_field keeps outdoor DemoNavSettings like HEAD).`
      );
      return;
    }
    setNavSettings((prev) =>
      demoNavSettingsForSceneType(sceneType, { preservePrune: prev.pruneFloaters })
    );
  }, [appendLog]);
  navGenerationModeRef.current = navGenerationMode;
  collisionSceneTypeRef.current = collisionSceneType;
  const pruneFloaters = navSettings.pruneFloaters;
  const setPruneFloaters = useCallback((enabled: boolean): void => {
    setNavSettings((prev) => ({ ...prev, pruneFloaters: enabled }));
  }, []);

  const isBusy = status === 'loading' || status === 'processing';
  const navCapabilities: NavCapabilities = navCapabilitiesFromParts({
    recastBin: sessionRecastBinRef.current,
    volume: sessionVolumeRef.current,
  });

  const resetNavSettings = useCallback((): void => {
    if (navGenerationModeRef.current === 'floor_field') {
      setNavSettings((prev) => ({
        ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS,
        pruneFloaters: prev.pruneFloaters,
      }));
      appendLog('[INFO] Navmesh settings reset to outdoor defaults (floor_field / HEAD).');
      return;
    }
    const sceneType = collisionSceneTypeRef.current;
    setNavSettings((prev) =>
      demoNavSettingsForSceneType(sceneType, { preservePrune: prev.pruneFloaters })
    );
    appendLog(`[INFO] Navmesh settings reset to ${sceneType} defaults.`);
  }, [appendLog]);

  const activeNavigationModeDisabledReason = useCallback(
    (mode: ActiveNavigationMode): string | null =>
      sharedActiveNavigationModeDisabledReason({
        algo: navGenerationModeRef.current,
        busy: isBusy,
        caps: navCapabilitiesFromParts({
          recastBin: sessionRecastBinRef.current,
          volume: sessionVolumeRef.current,
        }),
        liveBackend,
        mode,
      }),
    [isBusy, liveBackend]
  );

  const setActiveNavigationMode = useCallback(
    (mode: ActiveNavigationMode): void => {
      void (async () => {
        if (isBusy) {
          appendLog('[WARN] Active navigation mode ignored — busy.');
          return;
        }
        if (navGenerationModeRef.current === 'floor_field' && mode !== 'recast') {
          appendLog(
            '[WARN] Floor field generation only produces Recast. Switch Nav generation for Voxel mesh.'
          );
          return;
        }
        const previous = activeNavigationModeRef.current;
        setActiveNavigationModeState(mode);
        const result = await resolveActiveNavigationChange({
          activateBackend: async ({ backend, onLog, recastBin, spawnHint, volume }) => {
            if (backend === 'voxel_walk') {
              if (!volume) {
                throw new Error('Voxel / Dual Live needs a carved volume in session.');
              }
              const floor = volumeToWalkableFloorMesh(volume);
              controller.showNavMesh(floor.positions, floor.indices);
              onLog(
                '[SUCCESS] Active → Voxel floor mesh (R3F: click floor surface; Recast crowd pathing).'
              );
              return { liveBackend: 'voxel_walk' };
            }
            if (!recastBin || recastBin.byteLength === 0) {
              throw new Error('Recast Live needs recast.navmesh.bin in session.');
            }
            const debug = lastRecastDebugMeshRef.current;
            if (debug) {
              controller.showNavMesh(debug.positions, debug.indices);
            }
            const spawn = spawnHint
              ? ([spawnHint[0], spawnHint[1], spawnHint[2]] as [number, number, number])
              : sessionSpawnRef.current;
            await controller.initCrowd(recastBin, spawn);
            controller.addNPC(null);
            onLog('[SUCCESS] Active → Recast crowd. Click the green navmesh to move.');
            return { liveBackend: 'recast_crowd' };
          },
          liveBackend: liveBackendRef.current,
          mode,
          onLog: appendLog,
          previousMode: previous,
          recastBin: sessionRecastBinRef.current,
          spawnHint: sessionSpawnRef.current,
          viewer: null,
          volume: sessionVolumeRef.current,
        });
        setLiveBackend(result.liveBackend);
        if (!result.applied) {
          setActiveNavigationModeState(result.revertToMode ?? previous);
          setErrorMessage(
            result.failureMessage ??
              'Could not switch Live locomotion — missing volume or Recast assets.'
          );
          return;
        }
        setErrorMessage(null);
        if (result.liveBackend !== 'none') {
          setHasNavMesh(true);
          setStatusMessage(
            result.liveBackend === 'recast_crowd'
              ? 'Live: Recast crowd. Click the green navmesh to move.'
              : 'Live: Voxel floor mesh. Click the floor surface to move (Recast pathing).'
          );
        }
      })();
    },
    [appendLog, controller, isBusy]
  );

  const setControlsMode = useCallback(
    (mode: NavKitControlsMode): void => {
      setControlsModeState(mode);
      controller.setControlsMode(mode);
      appendLog(`[INFO] Controls mode: ${mode}.`);
    },
    [appendLog, controller]
  );

  useEffect(() => {
    splatwalk.onProgress = (stage, fraction): void => setProgress({ stage, fraction });
    return () => {
      splatwalk.onProgress = null;
    };
  }, []);

  useEffect(() => {
    if (!cameraInfoPanelOpen && !playerInfoPanelOpen) {
      return;
    }
    let rafId = 0;
    const tick = (): void => {
      const cam = controller.getCameraPoseNavKit();
      if (cam) {
        setCameraInfo({
          eulerDegrees: { ...cam.eulerDegrees },
          mode: null,
          position: { ...cam.position },
          target: { ...cam.target },
        });
      } else {
        setCameraInfo(emptyNavKitCameraPoseInfo());
      }
      const player = controller.getPlayerPoseNavKit();
      if (player) {
        setPlayerInfo({
          available: true,
          eulerDegrees: { ...player.eulerDegrees },
          position: { ...player.position },
        });
      } else {
        setPlayerInfo(emptyNavKitPlayerPoseInfo());
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [cameraInfoPanelOpen, controller, playerInfoPanelOpen]);

  const cameraInfoCopyText = useMemo(
    () => formatNavKitCameraCopyText(cameraInfo),
    [cameraInfo]
  );
  const playerInfoCopyText = useMemo(
    () => formatNavKitPlayerCopyText(playerInfo),
    [playerInfo]
  );

  const setCameraInfoPanelOpen = useCallback((open: boolean): void => {
    setCameraInfoPanelOpenState(open);
  }, []);

  const setPlayerInfoPanelOpen = useCallback((open: boolean): void => {
    setPlayerInfoPanelOpenState(open);
  }, []);

  const copyCameraPose = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(formatNavKitCameraCopyText(cameraInfo));
      return true;
    } catch {
      return false;
    }
  }, [cameraInfo]);

  const copyPlayerPose = useCallback(async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(formatNavKitPlayerCopyText(playerInfo));
      return true;
    } catch {
      return false;
    }
  }, [playerInfo]);

  const reset = useCallback((): void => {
    setCameraInfoPanelOpenState(false);
    setPlayerInfoPanelOpenState(false);
    setCameraInfo(emptyNavKitCameraPoseInfo());
    setPlayerInfo(emptyNavKitPlayerPoseInfo());
    setStatus('idle');
    setStatusMessage('Drop a .ply, .spz, or .splat splat to begin.');
    setErrorMessage(null);
    setLogs([]);
    setPhase('idle');
    setProgress(null);
    setSplatCount(null);
    setMaxShDegree(DEFAULT_SLICE_SETTINGS.sh_degree);
    setMaxChunkExtent(DEFAULT_SLICE_SETTINGS.chunk_extent);
    currentCollisionArtifact.current = null;
    currentBytes.current = null;
    currentModelSourceBytes.current = null;
    currentModelFilename.current = 'model.ply';
    currentName.current = 'splat';
    currentNavMeshData.current = null;
    currentNavArtifactBundle.current = null;
    setHasNavArtifactBundle(false);
    setHasNavKit(false);
    pendingEnvironmentScale.current = 1;
    setSessionEnvironmentScale(1);
    cachedSelectionRegion.current = null;
    sessionVolumeRef.current = null;
    sessionRecastBinRef.current = null;
    sessionSpawnRef.current = null;
    lastRecastDebugMeshRef.current = null;
    setLiveBackend('none');
    setActiveNavigationModeState(DEFAULT_ACTIVE_NAVIGATION_MODE);
    setNavSettings({ ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS });
    setSelectionRegionVisibleState(false);
    setHasLoadedSplat(false);
    setHasNavMesh(false);
    setHasCollisionBoundary(false);
    setTopDownViewApplied(false);
    controller.disableRegionSelection();
    controller.setEnvironmentScale(1);
    void controller.reset();
  }, [controller]);

  const processBytes = useCallback(
    async (
      bytes: Uint8Array,
      name: string,
      processOptions?: {
        readonly skipNav?: boolean;
        readonly modelSource?: Uint8Array;
        /** Recompute on an already-loaded splat — keep yellow region, skip splat reload. */
        readonly preserveLoadedScene?: boolean;
      }
    ): Promise<void> => {
      const preserveLoadedScene = processOptions?.preserveLoadedScene === true;
      const preservedRegion =
        preserveLoadedScene
          ? (controller.getRegionBounds() ??
            (cachedSelectionRegion.current
              ? {
                  min: [...cachedSelectionRegion.current.min],
                  max: [...cachedSelectionRegion.current.max],
                }
              : null))
          : null;

      currentBytes.current = bytes;
      currentModelSourceBytes.current =
        processOptions?.modelSource ?? currentModelSourceBytes.current ?? bytes;
      // Recompute must not rewrite `meadow.spz` → `meadow.ply` while source bytes
      // remain gzip SPZ — that mislabels NavKit downloads and breaks R3F restore.
      if (!preserveLoadedScene) {
        currentModelFilename.current = name.match(/\.(ply|spz|splat)$/i)
          ? name
          : `${name}.ply`;
      }
      setHasLoadedSplat(true);
      currentCollisionArtifact.current = null;
      currentName.current = name.replace(/\.(ply|spz|splat)$/i, '');
      currentNavMeshData.current = null;
      currentNavArtifactBundle.current = null;
      setHasNavArtifactBundle(false);
      setHasNavKit(false);
      setHasNavMesh(false);
      setHasCollisionBoundary(false);
      setMaxShDegree(inferPlyShDegree(bytes));
      // New splat: clear region. Recompute: keep the user's moved yellow pin.
      controller.clearNavSessionOverlays({ keepRegion: preserveLoadedScene });
      if (!preserveLoadedScene) {
        cachedSelectionRegion.current = null;
        setSelectionRegionVisibleState(false);
      } else if (preservedRegion) {
        cachedSelectionRegion.current = {
          min: [...preservedRegion.min],
          max: [...preservedRegion.max],
        };
        setSelectionRegionVisibleState(true);
      }

      if (!wasmReady.current) {
        appendLog('[WAIT] Initializing SplatWalk WASM...');
        await splatwalk.init();
        wasmReady.current = true;
      }

      controller.setEnvironmentScale(pendingEnvironmentScale.current);
      setSessionEnvironmentScale(pendingEnvironmentScale.current);
      if (preserveLoadedScene) {
        appendLog('[INFO] Reusing loaded splat for recompute (region preserved).');
      } else {
        appendLog('[WAIT] Rendering Gaussian splat...');
        await controller.loadSplat(bytes);
        appendLog('[INFO] Splat visualized.');
      }

      if (processOptions?.skipNav) {
        setTopDownViewApplied(false);
        setPhase('idle');
        setProgress(null);
        setStatus('done');
        setStatusMessage('Splat loaded (nav restore pending).');
        return;
      }

      setTopDownViewApplied(false);
      const cameraSelect = cameraSelectRef.current;
      if (cameraSelect && !preserveLoadedScene) {
        const bounds = regionBoundsFromCameraSelect(cameraSelect);
        controller.enableRegionSelection({ min: bounds.min, max: bounds.max });
        setSelectionRegionVisibleState(true);
        appendLog(
          `[INFO] Camera select region pinned: ` +
            `${bounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
            `${bounds.max.map((v) => v.toFixed(2)).join(', ')}`
        );
      } else if (preserveLoadedScene && preservedRegion && !controller.getRegionBounds()) {
        controller.enableRegionSelection({
          min: preservedRegion.min,
          max: preservedRegion.max,
        });
        setSelectionRegionVisibleState(true);
        appendLog('[INFO] Restored selection region for recompute.');
      }

      const tuning = demoNavSettingsToFastNavTuning(navSettingsRef.current);
      const algoEarly = navGenerationModeRef.current;
      const base: MeshSettings = {
        ...FAST_NAV_PRESET,
        ...tuning.meshSettings,
        mode: 2,
        flip_y: true,
        rotation: [0, 0, 0],
        environment_scale: controller.getEnvironmentScale(),
        prune_floaters: tuning.prune.enabled,
      };
      let regionBounds = controller.getRegionBounds() ?? preservedRegion;
      const orientedPose = controller.getCameraPoseOriented();
      const liveCamera = orientedPose?.position ?? controller.getCameraPosition();
      if (cameraSelect && !preserveLoadedScene) {
        base.camera_position = [
          cameraSelect.view.position.x,
          cameraSelect.view.position.y,
          cameraSelect.view.position.z,
        ];
      } else if (liveCamera) {
        base.camera_position = [liveCamera.x, liveCamera.y, liveCamera.z];
      }
      // Voxel collision only: auto camera pin when the user has not set a region.
      // Never overwrite a user-moved yellow box on recompute.
      if (
        !regionBounds &&
        algoEarly === 'voxel_collision' &&
        orientedPose
      ) {
        const camBounds = regionBoundsFromCameraPose({
          offsets: DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
          pose: orientedPose,
        });
        controller.enableRegionSelection({ min: camBounds.min, max: camBounds.max });
        setSelectionRegionVisibleState(true);
        regionBounds = camBounds;
      }
      if (regionBounds) {
        base.region_min = [...regionBounds.min];
        base.region_max = [...regionBounds.max];
      }
      let splatBounds: { min: number[]; max: number[] } | null = null;
      let floorY: number | null = null;
      try {
        const bounds = await splatwalk.getSplatBounds(bytes, { ...base, prune_floaters: false });
        setSplatCount(bounds.point_count);
        splatBounds = { min: bounds.oriented_min, max: bounds.oriented_max };
        floorY = bounds.floor_y_percentile_02;
        setMaxChunkExtent(maxChunkExtentFromBounds(splatBounds));
        controller.setSceneBounds(bounds.oriented_min, bounds.oriented_max);
      } catch {
        setSplatCount(null);
        setMaxChunkExtent(DEFAULT_SLICE_SETTINGS.chunk_extent);
      }

      setStatus('processing');
      setStatusMessage('Running FAST NAV...');
      const algo = navGenerationModeRef.current;
      const isCollisionAlgo = algo === 'voxel_collision' || algo === 'sdf_marching_cubes';
      appendLog(`[INFO] Fast Nav algo: ${algo}`);
      appendLog(`[INFO] Floater prune: ${tuning.prune.enabled === false ? 'off' : 'on'}`);

      const carveHeightEarly =
        DEFAULT_VOXEL_NAV_SETTINGS.collisionCarveHeight ||
        FAST_NAV_PRESET.collision_carve_height ||
        1.6;
      // Voxel collision: auto ground-anchor only when the user has not pinned a region.
      // Recompute must honor a user-moved yellow box (never overwrite preservedRegion).
      // SDF-MC: keep user yellow pin if present; otherwise leave unpinned for full-room MC.
      if (algo === 'voxel_collision' && orientedPose && !preservedRegion) {
        const resolvedFloorY =
          floorY ??
          splatBounds?.min[1] ??
          orientedPose.position.y - 1.6;
        const camBounds = groundAnchoredCameraRegion({
          carveHeight: carveHeightEarly,
          floorY: resolvedFloorY,
          offsets: cameraSelect?.offsets ?? DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
          pose: orientedPose,
        });
        controller.enableRegionSelection({ min: camBounds.min, max: camBounds.max });
        setSelectionRegionVisibleState(true);
        regionBounds = camBounds;
        base.region_min = [...camBounds.min];
        base.region_max = [...camBounds.max];
        base.camera_position = clampPointToAabb({
          point: orientedPose.position,
          regionMax: camBounds.max,
          regionMin: camBounds.min,
        });
        appendLog(
          `[INFO] Oriented ground-anchored region for ${algo}: ` +
            `${camBounds.min.map((v) => v.toFixed(1)).join(', ')} → ` +
            `${camBounds.max.map((v) => v.toFixed(1)).join(', ')}`
        );
      } else if (algo === 'voxel_collision' && preservedRegion) {
        regionBounds = controller.getRegionBounds() ?? preservedRegion;
        base.region_min = [...regionBounds.min];
        base.region_max = [...regionBounds.max];
        if (base.camera_position) {
          base.camera_position = clampPointToAabb({
            point: base.camera_position,
            regionMax: regionBounds.max,
            regionMin: regionBounds.min,
          });
        }
        setSelectionRegionVisibleState(true);
        appendLog(
          `[INFO] Honoring user selection region: ` +
            `${regionBounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
            `${regionBounds.max.map((v) => v.toFixed(2)).join(', ')}`
        );
      } else if (algo === 'sdf_marching_cubes') {
        const sceneTypeEarly = collisionSceneTypeForAlgo({
          algo,
          exampleSceneType: collisionSceneTypeRef.current,
        });
        const resolvedFloorY =
          floorY ??
          splatBounds?.min[1] ??
          orientedPose?.position.y ??
          0;
        const candidatePose = orientedPose ?? {
          position: {
            x: splatBounds
              ? (splatBounds.min[0]! + splatBounds.max[0]!) * 0.5
              : 0,
            y: resolvedFloorY,
            z: splatBounds
              ? (splatBounds.min[2]! + splatBounds.max[2]!) * 0.5
              : 0,
          },
          yawRadians: 0,
        };
        const candidateRegion = groundAnchoredCameraRegion({
          carveHeight: carveHeightEarly,
          floorY: resolvedFloorY,
          offsets: cameraSelect?.offsets ?? DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
          pose: candidatePose,
        });
        const decision = ensureSdfMcRegionForDenseBudget({
          candidateRegion,
          existingRegion: regionBounds,
          fillSize: DEFAULT_VOXEL_NAV_SETTINGS.collisionFillSize,
          sceneType: sceneTypeEarly,
          splatBounds: splatBounds ?? candidateRegion,
        });
        appendLog(`[INFO] SDF-MC: ${decision.reason}`);
        if (decision.pinned && decision.region) {
          controller.enableRegionSelection({
            min: decision.region.min,
            max: decision.region.max,
          });
          setSelectionRegionVisibleState(true);
          regionBounds = decision.region;
          base.region_min = [...decision.region.min];
          base.region_max = [...decision.region.max];
          if (base.camera_position) {
            base.camera_position = clampPointToAabb({
              point: base.camera_position,
              regionMax: decision.region.max,
              regionMin: decision.region.min,
            });
          }
        } else {
          delete base.region_min;
          delete base.region_max;
          regionBounds = null;
        }
      } else if (regionBounds && base.camera_position) {
        base.camera_position = clampPointToAabb({
          point: base.camera_position,
          regionMax: regionBounds.max,
          regionMin: regionBounds.min,
        });
      }

      const recovery = resolveRecovery();
      const caps = await splatwalk.capabilities();
      if (!caps.includes('fast_nav')) {
        throw new Error(
          'WASM capability fast_nav missing — rebuild @splatwalk/core (npm run build:wasm).'
        );
      }
      if (algo === 'sdf_marching_cubes' && !caps.includes('sdf_marching_cubes')) {
        throw new Error(
          'SDF Marching Cubes requires WASM capability sdf_marching_cubes. Rebuild @splatwalk/core.'
        );
      }

      // Spawn the crowd + frame the player from a navmesh artifact (freshly
      // computed or restored from cache). Spawns are deterministic functions of
      // the navmesh geometry, so they reproduce exactly on a cache hit.
      const spawnCrowdAndFrame = async (
        navMeshData: Uint8Array,
        debugPositions: Float32Array,
        debugIndices: Uint32Array
      ): Promise<void> => {
        currentNavMeshData.current = navMeshData;
        setHasNavMesh(true);
        controller.showNavMesh(debugPositions, debugIndices);
        const playerSpawn = navMeshCentroid(debugPositions);
        const npcSpawn = farthestVertex(debugPositions, playerSpawn);
        await controller.initCrowd(navMeshData, playerSpawn);
        controller.addNPC(npcSpawn);
        appendLog('[SUCCESS] Crowd ready: player + NPC spawned.');
        sessionRecastBinRef.current = navMeshData;
        sessionSpawnRef.current = playerSpawn;
        lastRecastDebugMeshRef.current = { positions: debugPositions, indices: debugIndices };
        setLiveBackend('recast_crowd');

        const region = controller.getRegionBounds();
        currentNavArtifactBundle.current = await buildMinimalNavArtifactBundle({
          debugIndices,
          debugPositions,
          navMeshData,
          playerSpawn,
          regionMax: region?.max ?? null,
          regionMin: region?.min ?? null,
          volume: sessionVolumeRef.current,
        });
        setHasNavArtifactBundle(true);
        setHasNavKit(
          Boolean(
            currentModelSourceBytes.current &&
              currentModelSourceBytes.current.byteLength > 0
          )
        );
        const caps = navCapabilitiesFromParts({
          recastBin: sessionRecastBinRef.current,
          volume: sessionVolumeRef.current,
        });
        appendLog(
          `[INFO] Session nav caps: hasRecast=${caps.hasRecast} hasVolume=${caps.hasVolume}` +
            ` · live=Recast crowd.`
        );

        setPhase('done');
        setProgress(null);
        const keepView =
          cameraSelectRef.current !== undefined && keepCameraSelectViewRef.current;
        if (keepView && cameraSelectRef.current) {
          controller.applyCameraSelectView(cameraSelectRef.current.view);
          appendLog('[INFO] Restored camera select view after nav (skipped top-down focus).');
        } else {
          setStatusMessage('Framing the player (top-down)...');
          controller.focusOnPlayer();
          setTopDownViewApplied(true);
        }

        setStatus('done');
        setStatusMessage(
          algo === 'sdf_marching_cubes'
            ? 'SDF Marching Cubes nav complete. Click the navmesh to move.'
            : 'FAST NAV complete. Click the navmesh to move the player.'
        );
      };

      const sceneType = collisionSceneTypeForAlgo({
        algo,
        exampleSceneType: collisionSceneTypeRef.current,
      });
      if (isCollisionAlgo) {
        Object.assign(
          base,
          voxelNavSettingsToCollisionBase({
            ...DEFAULT_VOXEL_NAV_SETTINGS,
            collisionSceneType: sceneType,
          }),
          {
            collision_mesh_mode: algo === 'sdf_marching_cubes' ? 'smooth' : 'faces',
            collision_scene_type: sceneType,
            ...(algo === 'sdf_marching_cubes'
              ? {
                  sdf_band_voxels: DEFAULT_VOXEL_NAV_SETTINGS.sdfBandVoxels,
                  mc_iso_level: DEFAULT_VOXEL_NAV_SETTINGS.mcIsoLevel,
                  mc_smooth_iterations: DEFAULT_VOXEL_NAV_SETTINGS.mcSmoothIterations,
                  ...(sceneType === 'outdoor'
                    ? { floor_project_flatten_m: 0.35 }
                    : {}),
                }
              : {}),
          }
        );
      }
      appendLog(`[INFO] Collision scene type: ${sceneType}`);

      const envScale = base.environment_scale ?? 1;
      appendLog(`[INFO] Environment scale for this run: ${envScale}`);
      // Outdoor floor_field: seed-centered ~100 m pin (Storage Adapter / prod parity).
      const seedCenteredOutdoor = algo === 'floor_field' && sceneType === 'outdoor';
      const recastAttempts = FAST_NAV_RECAST_ATTEMPTS.map((attempt) => ({
        label: attempt.label,
        params: { ...attempt.params, ...tuning.recastOverrides },
      }));
      // Persistent navmesh cache: same splat + settings + algo skips WASM + Recast.
      const navCacheKey = buildNavmeshKey(
        bytes,
        buildFastNavCacheSignature({
          algo,
          base,
          recovery,
          recastAttempts,
          floorMesh: { ...tuning.floorMesh, seedCenteredOutdoor },
          floorPipeline: algo === 'floor_field' ? FAST_NAV_FLOOR_PIPELINE : null,
          seedCenteredOutdoor,
          islandValidation: tuning.islandValidation,
          extras: {
            activeNavigationMode: activeNavigationModeRef.current,
            collisionSceneType: sceneType,
            navSettings: navSettingsRef.current,
          },
        })
      );
      const cached = await getNavmesh(navCacheKey);
      const cachedHasCollider =
        !!cached?.colliderPositions?.length && !!cached?.colliderIndices?.length;
      if (cached && !(algo === 'sdf_marching_cubes' && !cachedHasCollider)) {
        appendLog(
          `[INFO] FAST NAV navmesh restored from cache (skipping recompute; ` +
            `environment_scale=${envScale}).`
        );
        setPhase('navmesh');
        if (algo === 'sdf_marching_cubes' && cachedHasCollider) {
          controller.showCollisionBoundary(
            cached.colliderPositions!,
            cached.colliderIndices!
          );
          setHasCollisionBoundary(true);
          appendLog(
            `[INFO] SDF-MC cyan = cached collider_mesh (interior MC shell): ` +
              `${cached.colliderPositions!.length / 3} verts.`
          );
        } else {
          controller.clearCollisionBoundary();
          setHasCollisionBoundary(false);
        }
        await spawnCrowdAndFrame(cached.navMeshData, cached.debugPositions, cached.debugIndices);
        return;
      }
      if (cached && algo === 'sdf_marching_cubes' && !cachedHasCollider) {
        appendLog(
          '[WARN] SDF-MC cache entry missing collider_mesh — recomputing for interior MC shell.'
        );
      }

      // Seed: region floor + half carve height (not mid-box Y — that blocks capsules).
      setPhase(tuning.prune.enabled === false ? 'floor' : 'prune');
      const carveHeight = carveHeightEarly;
      let seed: number[];
      let outdoorSuggested: {
        region_min: number[];
        region_max: number[];
        floor_y: number;
      } | null = null;
      if (regionBounds) {
        seed = seedFromRegionBounds({ carveHeight, regionBounds });
        seed = clampPointToAabb({
          point: seed,
          regionMax: regionBounds.max,
          regionMin: regionBounds.min,
        });
        appendLog('[INFO] Using pinned selection region for Fast Nav.');
      } else {
        const suggested = await splatwalk.suggestRegion(bytes, base);
        outdoorSuggested = {
          region_min: suggested.region_min as number[],
          region_max: suggested.region_max as number[],
          floor_y: suggested.floor_y,
        };
        seed = [
          (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
          suggested.floor_y + carveHeight * 0.5,
          (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
        ];
      }
      appendLog(`[INFO] Fast path seed: ${seed.map((v) => v.toFixed(3)).join(', ')}`);

      setPhase('floor');
      let cachedColliderPositions: Float32Array | null = null;
      let cachedColliderIndices: Uint32Array | null = null;
      let recastPositions: Float32Array;
      let recastIndices: Uint32Array;
      let sourceLabel = 'fast_floor_field';

      if (algo === 'floor_field') {
        // Match workbench/Vuetify: TS floor-field + recovery (honors region_min/max).
        const fieldSettings: MeshSettings = {
          ...base,
          collision_seed: seed,
        };
        if (regionBounds) {
          // Yellow-box pin always wins over outdoor seed-centered pin.
          fieldSettings.region_min = [...regionBounds.min];
          fieldSettings.region_max = [...regionBounds.max];
          if (seedCenteredOutdoor) {
            applySeedCenteredOutdoorFieldKnobs(fieldSettings);
          }
          appendLog(
            `[INFO] Floor-field region pin: ` +
              `${regionBounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
              `${regionBounds.max.map((v) => v.toFixed(2)).join(', ')}`
          );
        } else if (seedCenteredOutdoor && outdoorSuggested) {
          seed = applySeedCenteredOutdoorPin({
            settings: fieldSettings,
            seedX: (outdoorSuggested.region_min[0] + outdoorSuggested.region_max[0]) * 0.5,
            seedZ: (outdoorSuggested.region_min[2] + outdoorSuggested.region_max[2]) * 0.5,
            floorY: outdoorSuggested.floor_y,
            carveHeight,
            log: (msg) => {
              appendLog(msg);
            },
          });
          fieldSettings.collision_seed = seed;
        }
        appendLog('[WAIT] Extracting floor field (TypeScript + recovery)…');
        const extracted = await extractFloorFieldWithRecovery({
          bytes,
          buildField: (b, s) => splatwalk.buildWalkableGroundField(b, s),
          baseSettings: fieldSettings,
          seed,
          recovery,
          floorMesh: { ...tuning.floorMesh, seedCenteredOutdoor },
          seedCenteredOutdoor,
          log: (msg) => {
            appendLog(msg);
          },
        });
        sessionVolumeRef.current = null;
        controller.clearCollisionBoundary();
        setHasCollisionBoundary(false);
        recastPositions = extracted.floorMesh.positions;
        recastIndices = extracted.floorMesh.indices;
        if (recastPositions.length < 9 || recastIndices.length < 3) {
          throw new Error('Floor-field extraction produced an empty floor mesh.');
        }
        appendLog(
          `[SUCCESS] Floor mesh ready (${recastPositions.length / 3} verts, ` +
            `${recastIndices.length / 3} tris, step="${extracted.stepLabel}").`
        );
      } else {
        const fastNavSettings: FastNavSettings = {
          ...base,
          algo,
          collision_seed: seed,
          emit_glb: false,
          // Always emit volume so Dual / Voxel Live hot-swap has session assets.
          emit_volume: true,
        };
        if (regionBounds) {
          fastNavSettings.region_min = [...regionBounds.min];
          fastNavSettings.region_max = [...regionBounds.max];
        }
        if (regionBounds && fastNavSettings.camera_position) {
          fastNavSettings.camera_position = clampPointToAabb({
            point: fastNavSettings.camera_position,
            regionMax: regionBounds.max,
            regionMin: regionBounds.min,
          });
        }
        appendLog(`[WAIT] WASM fast_nav (${algo})…`);
        const wasmNav = await splatwalk.fastNav(bytes, fastNavSettings);
        sessionVolumeRef.current = wasmNav.volume ?? null;
        const recastMesh = wasmNav.mesh;
        if (recastMesh.vertex_count === 0 || recastMesh.indices.length === 0) {
          throw new Error(`fast_nav (${algo}) returned an empty mesh.`);
        }
        appendLog(
          `[SUCCESS] fast_nav mesh ready (${recastMesh.vertex_count} verts, ` +
            `${wasmNav.selected_area.toFixed(2)} m^2 area stat).`
        );
        if (algo === 'sdf_marching_cubes') {
          const mcShell = requireSdfMcColliderMesh({
            colliderMesh: wasmNav.collider_mesh,
            recastMesh,
          });
          cachedColliderPositions = new Float32Array(mcShell.vertices);
          cachedColliderIndices = new Uint32Array(mcShell.indices);
          controller.showCollisionBoundary(cachedColliderPositions, cachedColliderIndices);
          setHasCollisionBoundary(true);
          appendLog(
            `[INFO] SDF-MC cyan = collider_mesh (interior MC shell): ` +
              `${mcShell.vertex_count} verts, ${mcShell.face_count} faces; ` +
              `Recast mesh: ${recastMesh.vertex_count} verts.`
          );
          sourceLabel = 'generated_sdf_mc_floor_project';
          const mode = wasmNav.diagnostics.collision_floor_project_mode ?? 'open';
          appendLog(
            `[INFO] Baking Recast from SDF-MC downward floor project (${mode})…`
          );
          recastPositions = new Float32Array(recastMesh.vertices);
          recastIndices = new Uint32Array(recastMesh.indices);
        } else {
          const overlayMesh = wasmNav.mesh;
          controller.showCollisionBoundary(
            new Float32Array(overlayMesh.vertices),
            new Uint32Array(overlayMesh.indices)
          );
          setHasCollisionBoundary(true);
          sourceLabel = 'generated_voxel_volume';
          if (!wasmNav.volume) {
            throw new Error(
              'Voxel collision Recast needs emit_volume from fast_nav — rebuild WASM or retry.'
            );
          }
          const connected = volumeToConnectedWalkableMesh(wasmNav.volume, 0.75);
          recastPositions = new Float32Array(connected.positions);
          recastIndices = new Uint32Array(connected.indices);
          if (recastIndices.length < 3) {
            throw new Error('Voxel volume produced no walkable floor spans for Recast.');
          }
          appendLog(
            `[INFO] Baking Recast from voxel walkable spans (${recastIndices.length / 3} tris)…`
          );
        }
      }

      setPhase('navmesh');
      const colliderBounds = boundsFromPositions(recastPositions);
      const nav = await generateNavMesh({
        positions: recastPositions,
        indices: recastIndices,
        splatBounds,
        log: appendLog,
        recastOverrides: tuning.recastOverrides,
        sourceLabel,
        colliderBounds,
        useVoxelRecastLadder: isCollisionAlgo,
      });
      if (nav.debugIndices.length < 3 || nav.debugPositions.length < 9) {
        throw new Error(
          `Walkable navmesh overlay is empty after Recast (${sourceLabel}). ` +
            `Check region pin / seed (seed must stay inside region_min/max).`
        );
      }
      appendLog(
        `[SUCCESS] NavMesh generated (${nav.debugIndices.length / 3} debug tris).`
      );
      await putNavmesh(navCacheKey, {
        navMeshData: nav.navMeshData,
        debugPositions: nav.debugPositions,
        debugIndices: nav.debugIndices,
        colliderPositions: cachedColliderPositions,
        colliderIndices: cachedColliderIndices,
      });

      await spawnCrowdAndFrame(nav.navMeshData, nav.debugPositions, nav.debugIndices);
    },
    [appendLog, controller]
  );

  const loadNavKit = useCallback(
    async (file: File): Promise<void> => {
      if (isBusy) {
        return;
      }
      setErrorMessage(null);
      setLogs([]);
      setPhase('idle');
      setProgress(null);
      try {
        setStatus('loading');
        setStatusMessage(`Loading NavKit ${file.name}...`);
        appendLog(`[INFO] Loading NavKit: ${file.name} (${file.size} bytes)`);
        const kit = await parseNavKitFile(file);
        appendLog(
          `[INFO] NavKit meta: technique=${kit.meta.defaultNavTechnique}` +
            ` active=${kit.meta.defaultActiveNavigationMode}` +
            ` locomotion=${kit.meta.defaultLocomotionMode}.`
        );
        setNavGenerationMode(kit.meta.defaultNavTechnique);
        setActiveNavigationModeState(kit.meta.defaultActiveNavigationMode);
        currentModelSourceBytes.current = kit.modelBytes;
        currentModelFilename.current = reconcileSplatModelFilename(
          kit.modelBytes,
          kit.meta.model.filename
        );
        // SPZ→PLY (including mislabeled gzip-as-.ply kits) needs WASM first.
        if (!wasmReady.current) {
          appendLog('[WAIT] Initializing SplatWalk WASM...');
          await splatwalk.init();
          wasmReady.current = true;
        }
        const bytes = await readSplatBytes(
          new File([kit.modelBytes as BlobPart], currentModelFilename.current)
        );
        await processBytes(bytes, kit.meta.model.filename, {
          modelSource: kit.modelBytes,
          skipNav: true,
        });
        setStatus('processing');
        setStatusMessage('Restoring NavKit nav artifacts...');
        currentNavArtifactBundle.current = kit.navParsed.bundle;
        setHasNavArtifactBundle(true);
        currentName.current = kit.meta.slug;
        if (kit.navParsed.bundle.recastNavmeshBin) {
          currentNavMeshData.current = kit.navParsed.bundle.recastNavmeshBin;
          sessionRecastBinRef.current = kit.navParsed.bundle.recastNavmeshBin;
        }
        sessionVolumeRef.current = kit.navParsed.volume;
        const spawn = kit.navParsed.session.playerSpawn ?? kit.navParsed.session.collisionSeed;
        if (spawn && spawn.length >= 3) {
          sessionSpawnRef.current = [spawn[0]!, spawn[1]!, spawn[2]!];
        }
        await applyNavArtifactsToR3F({
          controller,
          focusCamera: false,
          onLog: appendLog,
          parsed: kit.navParsed,
        });
        const metaApplied = applyNavKitMetaToR3F({
          controller,
          meta: kit.meta,
          onLog: appendLog,
          parsed: kit.navParsed,
        });
        setTopDownViewApplied(metaApplied.topDownViewApplied);
        setControlsModeState(metaApplied.controlsMode);
        setLiveBackend(
          kit.meta.defaultLocomotionMode === 'voxel_walk' ? 'voxel_walk' : 'recast_crowd'
        );
        setHasNavMesh(true);
        setHasNavKit(true);
        setPhase('done');
        setProgress(null);
        setStatus('done');
        setStatusMessage('NavKit restored. Click the navmesh to move.');
        appendLog(`[SUCCESS] NavKit loaded. ${NAV_KIT_UPLOAD_HINT}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('NavKit load failed.');
        throw error;
      }
    },
    [appendLog, controller, isBusy, processBytes, setNavGenerationMode]
  );

  const loadAndProcess = useCallback(
    async (file: File): Promise<void> => {
      if (isBusy) return;
      setErrorMessage(null);
      setLogs([]);
      setPhase('idle');
      setProgress(null);
      const kitMeta = await peekNavKitMeta(file);
      if (kitMeta) {
        await loadNavKit(file);
        return;
      }
      const name = file.name.toLowerCase();
      if (!SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        setErrorMessage(
          'Only .ply, .spz, .splat, or a valid navkit.zip are supported.'
        );
        setStatus('error');
        return;
      }
      try {
        setStatus('loading');
        setStatusMessage(`Loading ${file.name}...`);
        appendLog(`[INFO] Loading file: ${file.name} (${file.size} bytes)`);
        const modelSource = new Uint8Array(await file.arrayBuffer());
        currentModelSourceBytes.current = modelSource;
        currentModelFilename.current = file.name;
        const bytes = await readSplatBytes(file);
        await processBytes(bytes, file.name, { modelSource });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('FAST NAV failed.');
      }
    },
    [appendLog, isBusy, loadNavKit, processBytes]
  );

  const loadExample = useCallback(
    async (
      url: string,
      title: string,
      sceneType: ExampleCollisionSceneType = 'indoor'
    ): Promise<void> => {
      if (isBusy) return;
      setErrorMessage(null);
      setLogs([]);
      setPhase('idle');
      setProgress(null);
      setCollisionSceneType(sceneType);
      try {
        setStatus('loading');
        setStatusMessage(`Fetching ${title}...`);
        appendLog(
          `[WAIT] Fetching example scene: ${title} (collision_scene_type=${sceneType})...`
        );
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${title}: ${response.status}`);
        const raw = new Uint8Array(await response.arrayBuffer());
        appendLog(`[SUCCESS] Fetched ${title} (${(raw.byteLength / (1024 * 1024)).toFixed(2)} MB).`);
        // Normalize by the URL's real extension (.spz / .splat -> PLY) exactly like
        // a dropped file, so non-PLY example scenes load too. WASM must be ready
        // first: spz/splat conversion runs in the core (init() is idempotent).
        const fileName = url.split('/').pop() || `${title}.ply`;
        if (!wasmReady.current) {
          await splatwalk.init();
          wasmReady.current = true;
        }
        const bytes = await readSplatBytes(new File([raw], fileName));
        // Keep original fetch bytes for NavKit packs (not only normalized PLY).
        await processBytes(bytes, fileName, { modelSource: raw });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('Failed to load the example scene.');
      }
    },
    [appendLog, controller, isBusy, processBytes, setCollisionSceneType]
  );

  const exportSog = useCallback(
    async (mode: SogExportMode, settings: SliceSettings = {}): Promise<SliceArchive> => {
      const bytes = currentBytes.current;
      if (!bytes) throw new Error('No splat loaded to export.');
      const result =
        mode === 'streamed'
          ? await splatwalk.sliceSplat(bytes, settings)
          : await splatwalk.convertToSog(bytes, settings);
      const archive = new SliceArchive(result, { streamed: mode === 'streamed' });
      archive.download(`${currentName.current}-sog`);
      return archive;
    },
    []
  );

  const exportNavmesh = useCallback(async (): Promise<void> => {
    const navMeshData =
      controller.getNavMeshData() ?? currentNavMeshData.current;
    if (!navMeshData) throw new Error('No navmesh generated to export.');
    currentNavMeshData.current = navMeshData;
    exportNavmeshBinary({
      filename: `${currentName.current}.nav`,
      navMeshData,
    });
  }, [controller]);

  const generateCollisionBoundary = useCallback(async (): Promise<CollisionBoundaryArtifact> => {
    const bytes = currentBytes.current;
    if (!bytes) throw new Error('No splat loaded to generate collision from.');
    const tuning = demoNavSettingsToFastNavTuning(navSettingsRef.current);
    const base: MeshSettings = {
      ...FAST_NAV_PRESET,
      ...tuning.meshSettings,
      mode: 2,
      flip_y: true,
      rotation: [0, 0, 0],
      environment_scale: controller.getEnvironmentScale(),
      prune_floaters: tuning.prune.enabled,
    };
    const regionBounds = controller.getRegionBounds();
    if (regionBounds) {
      base.region_min = [...regionBounds.min];
      base.region_max = [...regionBounds.max];
    }
    const orientedPose = controller.getCameraPoseOriented();
    if (orientedPose && regionBounds) {
      base.camera_position = clampPointToAabb({
        point: orientedPose.position,
        regionMax: regionBounds.max,
        regionMin: regionBounds.min,
      });
    }
    const carveHeight = FAST_NAV_PRESET.collision_carve_height ?? 1.7;
    let seed: number[];
    if (regionBounds) {
      seed = seedFromRegionBounds({ carveHeight, regionBounds });
      seed = clampPointToAabb({
        point: seed,
        regionMax: regionBounds.max,
        regionMin: regionBounds.min,
      });
    } else {
      const suggested = await splatwalk.suggestRegion(bytes, base);
      seed = [
        (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
        suggested.floor_y + carveHeight * 0.5,
        (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
      ];
    }
    const algo = navGenerationModeRef.current;
    const useSmooth = algo === 'sdf_marching_cubes';
    const sceneType = collisionSceneTypeForAlgo({
      algo,
      exampleSceneType: collisionSceneTypeRef.current,
    });
    const artifact = await generateCollisionBoundaryArtifact({
      bytes,
      settings: buildCollisionBoundarySettings({
        base: {
          ...base,
          collision_mesh_mode: useSmooth ? 'smooth' : base.collision_mesh_mode ?? 'faces',
          collision_scene_type: sceneType,
          ...(useSmooth
            ? {
                sdf_band_voxels: 3,
                mc_iso_level: 0,
                mc_smooth_iterations: 1,
              }
            : {}),
        },
        emitGlb: true,
        flipY: true,
        rotation: [0, 0, 0],
        seed,
      }),
    });
    currentCollisionArtifact.current = artifact;
    if (useSmooth) {
      const mcShell = requireSdfMcColliderMesh({
        colliderMesh: artifact.result.collider_mesh,
        recastMesh: artifact.result.mesh,
      });
      controller.showCollisionBoundary(
        new Float32Array(mcShell.vertices),
        new Uint32Array(mcShell.indices)
      );
      setHasCollisionBoundary(true);
      appendLog(
        `[SUCCESS] Collision boundary ready: SDF-MC cyan = collider_mesh (interior MC shell): ` +
          `${mcShell.vertex_count} verts, ${mcShell.face_count} faces.`
      );
    } else {
      const overlay = artifact.result.mesh;
      controller.showCollisionBoundary(
        new Float32Array(overlay.vertices),
        new Uint32Array(overlay.indices)
      );
      setHasCollisionBoundary(true);
      appendLog(
        `[SUCCESS] Collision boundary ready: ${overlay.vertex_count} vertices, ${overlay.face_count} faces.`
      );
    }
    return artifact;
  }, [appendLog, controller]);

  const setSelectionRegionVisible = useCallback(
    async (visible: boolean): Promise<void> => {
      if (!visible) {
        try {
          const bounds = controller.getRegionBounds();
          if (bounds) {
            cachedSelectionRegion.current = {
              min: [...bounds.min],
              max: [...bounds.max],
            };
          }
          controller.disableRegionSelection();
          appendLog('[INFO] Selection region hidden — Fast Nav will auto-select a region.');
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          appendLog(`[WARN] Selection region hide cleanup: ${detail}`);
        } finally {
          // Always clear UI state even if gizmo teardown throws.
          setSelectionRegionVisibleState(false);
        }
        return;
      }

      const bytes = currentBytes.current;
      if (!bytes) {
        throw new Error('Load a splat before showing the selection region.');
      }

      setErrorMessage(null);
      try {
        let region = cachedSelectionRegion.current;
        if (!region) {
          try {
            const suggested = await splatwalk.suggestRegion(bytes, {
              ...FAST_NAV_PRESET,
              mode: 2,
              flip_y: true,
              rotation: [0, 0, 0],
              prune_floaters: navSettingsRef.current.pruneFloaters,
              environment_scale: controller.getEnvironmentScale(),
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
            const splatBounds = controller.getSceneBounds();
            if (!splatBounds) {
              throw suggestError;
            }
            region = {
              min: [...splatBounds.min],
              max: [...splatBounds.max],
            };
            appendLog('[WARN] suggestRegion failed; using splat AABB for selection region.');
          }
          cachedSelectionRegion.current = region;
        }
        controller.enableRegionSelection({ min: region.min, max: region.max });
        setSelectionRegionVisibleState(true);
        appendLog(
          '[INFO] Selection region shown — drag/scale the yellow box with the move + scale gizmos, then Recompute.'
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        try {
          controller.disableRegionSelection();
        } catch {
          // Best-effort cleanup after a failed enable.
        }
        setSelectionRegionVisibleState(false);
        appendLog(`[ERROR] ${detail}`);
        throw error;
      }
    },
    [appendLog, controller]
  );

  const setPendingEnvironmentScale = useCallback(
    (scale: number): void => {
      if (!Number.isFinite(scale) || scale <= 0) {
        return;
      }
      pendingEnvironmentScale.current = scale;
      setSessionEnvironmentScale(scale);
      controller.setEnvironmentScale(scale);
    },
    [controller]
  );

  const applyScaleMultiplier = useCallback(
    (scaleMultiplier: number): number => {
      if (!Number.isFinite(scaleMultiplier) || scaleMultiplier <= 0) {
        throw new Error('Scale Environment must be a positive number.');
      }
      const current = controller.getEnvironmentScale() || pendingEnvironmentScale.current;
      if (scaleMultiplier === 1) {
        setSessionEnvironmentScale(current);
        return current;
      }
      const next = current * scaleMultiplier;
      pendingEnvironmentScale.current = next;
      setSessionEnvironmentScale(next);
      controller.setEnvironmentScale(next);
      appendLog(`[INFO] Session scale → ${next} (×${scaleMultiplier})`);
      return next;
    },
    [appendLog, controller]
  );

  const rerunFastNav = useCallback(
    async (rerunOptions?: { readonly scaleMultiplier?: number }): Promise<number> => {
      if (isBusy) {
        return controller.getEnvironmentScale() || pendingEnvironmentScale.current;
      }
      const bytes = currentBytes.current;
      if (!bytes) {
        throw new Error('Load a splat before re-running Fast Nav.');
      }
      const sessionScale =
        rerunOptions?.scaleMultiplier !== undefined
          ? applyScaleMultiplier(rerunOptions.scaleMultiplier)
          : controller.getEnvironmentScale() || pendingEnvironmentScale.current;
      // Always snapshot the live yellow box (gizmo may have moved since last cache).
      {
        const bounds = controller.getRegionBounds();
        if (bounds) {
          cachedSelectionRegion.current = {
            min: [...bounds.min],
            max: [...bounds.max],
          };
        }
      }
      setErrorMessage(null);
      currentNavMeshData.current = null;
      setHasNavMesh(false);
      const mode = navGenerationModeRef.current;
      const pinned = cachedSelectionRegion.current;
      const regionNote = pinned
        ? ` (pinned region ${pinned.min.map((v) => v.toFixed(1)).join(',')}→${pinned.max.map((v) => v.toFixed(1)).join(',')})`
        : '';
      appendLog(
        `[INFO] Re-running nav (${mode})${regionNote}… ` +
          `environment_scale=${sessionScale}`
      );
      setStatus('processing');
      setStatusMessage(`Re-running ${mode}…`);
      setPhase('idle');
      setProgress(null);
      try {
        // Keep the yellow pin + skip splat reload so the moved region is honored.
        await processBytes(bytes, currentModelFilename.current, {
          preserveLoadedScene: true,
        });
        return sessionScale;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('FAST NAV failed.');
        throw error;
      }
    },
    [appendLog, applyScaleMultiplier, controller, isBusy, processBytes]
  );

  const exportCollisionMesh = useCallback(async (): Promise<Uint8Array> => {
    const artifact = currentCollisionArtifact.current ?? await generateCollisionBoundary();
    return exportCollisionBoundaryGlb({
      artifact,
      filename: `${currentName.current}.collision.glb`,
    });
  }, [generateCollisionBoundary]);

  const setCollisionBoundaryVisible = useCallback(
    (visible: boolean): void => controller.setCollisionBoundaryVisible(visible),
    [controller]
  );

  const setNavMeshVisible = useCallback(
    (visible: boolean): void => controller.setNavMeshVisible(visible),
    [controller]
  );

  const setNavMeshEditorEnabled = useCallback(
    (enabled: boolean): void => controller.setNavMeshEditorEnabled(enabled),
    [controller]
  );
  const setNavMeshEditorMode = useCallback(
    (mode: 'vertex' | 'circle' | 'global'): void =>
      controller.setNavMeshEditorMode(mode),
    [controller]
  );
  const navMeshEditorGlobalY = useCallback(
    (steps: number): void => controller.navMeshEditorGlobalY(steps),
    [controller]
  );
  const navMeshEditorFillHole = useCallback(
    (): boolean => controller.navMeshEditorFillHole(),
    [controller]
  );
  const navMeshEditorDeleteVertices = useCallback(
    (): Promise<boolean> => controller.navMeshEditorDeleteVertices(),
    [controller]
  );
  const applyNavMeshEditorToLive = useCallback(
    (): Promise<boolean> => controller.applyNavMeshEditorToLive(),
    [controller]
  );
  const onNavMeshEditorStatus = useCallback(
    (
      listener: (status: import('@/navigation/navmeshEditor').NavMeshEditorStatus) => void
    ): (() => void) => controller.onNavMeshEditorStatus(listener),
    [controller]
  );
  const getNavMeshEditorStatus = useCallback(
    () => controller.getNavMeshEditorStatus(),
    [controller]
  );
  const getNavMeshData = useCallback(
    (): Uint8Array | null => controller.getNavMeshData(),
    [controller]
  );

  const applyEnvironmentScale = useCallback(
    async (scaleMultiplier: number): Promise<number> => {
      if (isBusy) {
        return controller.getEnvironmentScale() || pendingEnvironmentScale.current;
      }
      setErrorMessage(null);
      const sessionScale = applyScaleMultiplier(scaleMultiplier);

      const bytes = currentBytes.current;
      if (!bytes) {
        appendLog(`[INFO] Session scale → ${sessionScale} (applies on next Fast Nav).`);
        return sessionScale;
      }

      appendLog(`[INFO] Session scale → ${sessionScale}; re-running FAST NAV...`);
      // Multiplier already applied; recompute at current session scale.
      await rerunFastNav();
      return sessionScale;
    },
    [appendLog, applyScaleMultiplier, controller, isBusy, rerunFastNav]
  );

  const resetCameraSelectOffsets = useCallback((): void => {
    setCameraSelectOffsetsState({ ...DEFAULT_CAMERA_SELECT_REGION_OFFSETS });
  }, []);

  const setCameraSelectOffsets = useCallback(
    (partial: Partial<CameraSelectRegionOffsets>): void => {
      setCameraSelectOffsetsState((prev) => ({ ...prev, ...partial }));
    },
    []
  );

  const applySelectRegionFromCamera = useCallback((): void => {
    const oriented = controller.getCameraPoseOriented();
    if (!oriented) {
      appendLog('[WARN] Apply select region from camera: controller not attached.');
      return;
    }
    const yawDegrees = (oriented.yawRadians * 180) / Math.PI;
    const input: CameraSelectRegionInput = {
      view: {
        position: oriented.position,
        eulerDegrees: { x: 0, y: yawDegrees, z: 0 },
      },
      offsets: { ...cameraSelectOffsetsRef.current },
    };
    cameraSelectRef.current = input;
    const floorY =
      controller.getSceneBounds()?.min[1] ?? oriented.position.y - 1.6;
    const carveHeight =
      DEFAULT_VOXEL_NAV_SETTINGS.collisionCarveHeight ||
      FAST_NAV_PRESET.collision_carve_height ||
      1.6;
    const bounds = groundAnchoredCameraRegion({
      carveHeight,
      floorY,
      offsets: input.offsets,
      pose: oriented,
    });
    controller.enableRegionSelection({ min: bounds.min, max: bounds.max });
    setSelectionRegionVisibleState(true);
    appendLog(
      `[INFO] Camera select region pinned (oriented, ground-anchored): ` +
        `${bounds.min.map((v) => v.toFixed(2)).join(', ')} → ` +
        `${bounds.max.map((v) => v.toFixed(2)).join(', ')}`
    );
  }, [appendLog, controller]);

  const syncBundleForDownload = useCallback(async (): Promise<NavArtifactBundle | null> => {
    const base = currentNavArtifactBundle.current;
    if (!base) {
      return null;
    }
    if (controller.getNavMeshEditorStatus()?.hasPendingLiveApply) {
      appendLog('[INFO] Applying pending NavMesh Editor edits before download…');
      await controller.applyNavMeshEditorToLive();
    }
    const editedNav = controller.getNavMeshData();
    const editedBuffers = controller.getOrientedNavMeshBuffers();
    if (!editedNav || !editedBuffers) {
      return base;
    }
    currentNavMeshData.current = editedNav;
    sessionRecastBinRef.current = editedNav;
    lastRecastDebugMeshRef.current = {
      positions: editedBuffers.positions,
      indices: editedBuffers.indices,
    };
    const region = controller.getRegionBounds();
    const rebuilt = await rebuildNavArtifactBundleFromLiveMesh({
      base,
      debugIndices: editedBuffers.indices,
      debugPositions: editedBuffers.positions,
      navMeshData: editedNav,
      playerSpawn: sessionSpawnRef.current,
      regionMax: region?.max ?? null,
      regionMin: region?.min ?? null,
      volume: sessionVolumeRef.current,
    });
    currentNavArtifactBundle.current = rebuilt;
    setHasNavArtifactBundle(true);
    return rebuilt;
  }, [appendLog, controller]);

  const downloadNavKit = useCallback(async (): Promise<void> => {
    const modelBytes = currentModelSourceBytes.current;
    if (!currentNavArtifactBundle.current || !modelBytes) {
      appendLog('[WARN] No NavKit — run Fast Nav on a loaded splat first.');
      return;
    }
    const modelFilename = reconcileSplatModelFilename(
      modelBytes,
      currentModelFilename.current
    );
    currentModelFilename.current = modelFilename;
    const navBundle = await syncBundleForDownload();
    if (!navBundle) {
      appendLog('[WARN] No NavKit — run Fast Nav on a loaded splat first.');
      return;
    }
    const cam = controller.getCameraPoseNavKit();
    const player = controller.getPlayerPoseNavKit();
    const regionBounds = controller.getRegionBounds();
    downloadNavKitZip({
      activeNavigationMode: activeNavigationModeRef.current,
      camEulerDeg: cam?.eulerDegrees ?? null,
      camPos: cam?.position ?? null,
      camTarget: cam?.target ?? null,
      controlsMode,
      locomotionMode: liveBackendRef.current === 'voxel_walk' ? 'voxel_walk' : 'recast_crowd',
      modelBytes,
      modelFilename,
      navBundle,
      navTechnique: navGenerationModeRef.current,
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
      slug: currentName.current,
      title: currentName.current,
    });
    appendLog(`[SUCCESS] Downloaded navkit-${currentName.current}.zip`);
  }, [appendLog, controller, controlsMode, syncBundleForDownload]);

  const downloadNavArtifacts = useCallback(async (): Promise<void> => {
    const bundle = await syncBundleForDownload();
    if (!bundle) {
      appendLog('[WARN] No nav artifact pack — run Fast Nav first.');
      return;
    }
    downloadNavArtifactZip({ bundle, slug: currentName.current });
    appendLog(`[SUCCESS] Downloaded nav-artifacts-${currentName.current}.zip`);
  }, [appendLog, syncBundleForDownload]);

  const uploadNavArtifacts = useCallback(
    async (files: File[] | FileList): Promise<void> => {
      const list = Array.from(files);
      appendLog(
        `[INFO] Uploading nav artifacts (${list.length} file${list.length === 1 ? '' : 's'}: ` +
          `${list.map((f) => f.name).join(', ') || '(none)'})…`
      );
      if (isBusy) {
        appendLog('[WARN] Upload ignored — another job is still running.');
        return;
      }
      if (!hasLoadedSplat) {
        const detail = 'Load a splat before uploading nav artifacts.';
        appendLog(`[ERROR] ${detail}`);
        throw new Error(detail);
      }
      setErrorMessage(null);
      try {
        setStatus('processing');
        setStatusMessage('Uploading nav artifacts...');
        const parsed = await parseNavArtifactFiles(list);
        appendLog(
          `[INFO] Parsed pack: locomotion=${parsed.session.locomotionMode}` +
            (parsed.bundle.recastNavmeshBin ? ', recast.navmesh.bin' : '') +
            (parsed.volume ? ', volume trio' : '')
        );
        currentNavArtifactBundle.current = parsed.bundle;
        setHasNavArtifactBundle(true);
        if (parsed.bundle.recastNavmeshBin) {
          currentNavMeshData.current = parsed.bundle.recastNavmeshBin;
          sessionRecastBinRef.current = parsed.bundle.recastNavmeshBin;
        }
        sessionVolumeRef.current = parsed.volume;
        await applyNavArtifactsToR3F({
          controller,
          onLog: appendLog,
          parsed,
        });
        // Default focusCamera frames top-down after artifact restore.
        setTopDownViewApplied(true);
        setLiveBackend(
          parsed.session.locomotionMode === 'voxel_walk' ? 'voxel_walk' : 'recast_crowd'
        );
        setHasNavMesh(true);
        setHasNavKit(
          Boolean(
            currentModelSourceBytes.current &&
              currentModelSourceBytes.current.byteLength > 0
          )
        );
        setStatus('done');
        setStatusMessage(
          'Nav artifacts restored. Top-down framed — click the navmesh to move.'
        );
        appendLog(`[SUCCESS] Uploaded nav artifacts. ${NAV_ARTIFACT_UPLOAD_HINT}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('Upload nav artifacts failed.');
        throw error;
      }
    },
    [appendLog, controller, hasLoadedSplat, isBusy]
  );

  const goToPlayer = useCallback((): void => {
    if (!controller || !hasNavMesh) {
      appendLog('[WARN] Go to Player: no player agent.');
      return;
    }
    controller.focusOnPlayer();
    setTopDownViewApplied(true);
    appendLog('[SUCCESS] Go to Player — framing player top-down.');
  }, [appendLog, controller, hasNavMesh]);

  return {
    controller,
    status,
    statusMessage,
    errorMessage,
    setErrorMessage,
    logs,
    isBusy,
    phase,
    progress,
    splatCount,
    maxShDegree,
    maxChunkExtent,
    loadAndProcess,
    loadNavKit,
    loadExample,
    exportSog,
    exportNavmesh,
    goToPlayer,
    topDownViewApplied,
    downloadNavKit,
    downloadNavArtifacts,
    uploadNavArtifacts,
    hasNavArtifactBundle,
    hasNavKit,
    navArtifactUploadHint: NAV_ARTIFACT_UPLOAD_HINT,
    navKitUploadHint: NAV_KIT_UPLOAD_HINT,
    cameraSelectOffsets,
    setCameraSelectOffsets,
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
    setNavSettings,
    resetNavSettings,
    hasNavMesh,
    hasCollisionBoundary,
    pruneFloaters,
    setPruneFloaters,
    hasLoadedSplat,
    selectionRegionVisible,
    setSelectionRegionVisible,
    rerunFastNav,
    navGenerationMode,
    setNavGenerationMode,
    collisionSceneType,
    setCollisionSceneType,
    activeNavigationMode,
    setActiveNavigationMode,
    activeNavigationModeDisabledReason,
    controlsMode,
    setControlsMode,
    controlsWasdLegend: NAV_KIT_WASDQE_LEGEND,
    liveBackend,
    navCapabilities,
    applyEnvironmentScale,
    applyScaleMultiplier,
    sessionEnvironmentScale,
    setPendingEnvironmentScale,
    reset,
  };
}

export type UseSplatFastNavR3F = ReturnType<typeof useSplatFastNavR3F>;
