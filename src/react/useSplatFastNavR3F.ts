import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import NavWorker from '@/navigation/navmesh.worker?worker';
import {
  buildCollisionBoundarySettings,
  exportCollisionBoundaryGlb,
  exportNavmeshBinary,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
  type CollisionBoundaryArtifact,
} from '@/collision/voxelBoundary';
import {
  FAST_NAV_PRESET,
  extractFloorFieldWithRecovery,
  resolveRecovery,
  type FastNavLogger,
} from '@/navigation/floor';
import {
  DEFAULT_DEMO_NAV_SETTINGS,
  demoNavSettingsToFastNavTuning,
  type DemoNavSettings,
} from '@/navigation/navSettings';
import { buildNavmeshKey, getNavmesh, putNavmesh } from '@/navigation/navmeshCache';
import { splatwalk, type MeshSettings } from '@/wasm/bridge';
import { normalizeSplatToPly, SUPPORTED_SPLAT_EXTENSIONS } from '@/wasm/normalize';
import { SliceArchive } from '@/wasm/sliceArchive';
import {
  DEFAULT_SLICE_SETTINGS,
  inferPlyShDegree,
  maxChunkExtentFromBounds,
  type SliceSettings,
} from '@/wasm/sogTypes';
import { SplatNavController } from '@/react/three/SplatNavController';

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

/** Recast parameters + adaptive ladder, mirroring `FAST_NAV_RECAST_ATTEMPTS`. */
interface RecastParams {
  cs: number;
  ch: number;
  walkableHeight: number;
  walkableRadius: number;
  walkableClimb: number;
  walkableSlopeAngle: number;
  maxEdgeLen: number;
  maxSimplificationError: number;
  minRegionArea: number;
  mergeRegionArea: number;
  maxVertsPerPoly: number;
  detailSampleDist: number;
  detailSampleMaxError: number;
  autoCellSize?: boolean;
  maxNavCells?: number;
}

const FAST_NAV_BASE_PARAMS: RecastParams = {
  cs: 0.2,
  ch: 0.1,
  walkableHeight: 1.7,
  walkableRadius: 0.5,
  autoCellSize: true,
  maxNavCells: 1_000_000,
  walkableClimb: 0.5,
  walkableSlopeAngle: 40,
  maxEdgeLen: 12,
  maxSimplificationError: 0.5,
  minRegionArea: 24,
  mergeRegionArea: 36,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

const FAST_NAV_RECAST_ATTEMPTS: ReadonlyArray<{ label: string; params: RecastParams }> = [
  { label: 'strict', params: FAST_NAV_BASE_PARAMS },
  {
    label: 'balanced',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      cs: 0.15,
      ch: 0.12,
      walkableHeight: 1.4,
      walkableSlopeAngle: 42,
      maxSimplificationError: 0.8,
      minRegionArea: 8,
      mergeRegionArea: 16,
    },
  },
  {
    label: 'recovery',
    params: {
      ...FAST_NAV_BASE_PARAMS,
      cs: 0.18,
      ch: 0.14,
      walkableHeight: 1.2,
      walkableSlopeAngle: 48,
      maxSimplificationError: 1.0,
      minRegionArea: 2,
      mergeRegionArea: 8,
    },
  },
];

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
  splatBounds: { min: number[]; max: number[] } | null
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
      payload: { positions, indices, params, sourceLabel: 'fast_floor_field', splatBounds, colliderBounds: null },
    });
  });
}

async function generateNavMesh(
  positions: Float32Array,
  indices: Uint32Array,
  splatBounds: { min: number[]; max: number[] } | null,
  log: FastNavLogger,
  recastOverrides?: Partial<RecastParams>
): Promise<NavWorkerResult> {
  const attempts = recastOverrides
    ? FAST_NAV_RECAST_ATTEMPTS.map((attempt) => ({
        ...attempt,
        params: { ...attempt.params, ...recastOverrides },
      }))
    : FAST_NAV_RECAST_ATTEMPTS;
  let lastError: unknown = null;
  for (const attempt of attempts) {
    log(`[WAIT] Spawning NavMesh worker (${attempt.label})...`);
    try {
      const result = await runNavWorker(positions, indices, attempt.params, splatBounds);
      if (attempt.label !== 'strict') log(`[WARN] Fast nav recovered with ${attempt.label} Recast settings.`);
      return result;
    } catch (error) {
      lastError = error;
      log(`[WARN] Fast nav ${attempt.label} attempt failed; relaxing Recast settings.`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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
 * React orchestration for the R3F FAST NAV showcase: drop/browse a splat, render
 * it, auto-run FAST NAV (floor field -> floor mesh -> Recast navmesh -> crowd +
 * NPC), then frame the player. Mirrors the Vuetify `useSplatFastNav`, but drives
 * the three.js {@link SplatNavController} instead of the Babylon viewer.
 */
export function useSplatFastNavR3F() {
  const controller = useMemo(() => new SplatNavController(), []);

  const [status, setStatus] = useState<FastNavStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('Drop a .ply, .spz, or .splat splat to begin.');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<FastNavUiPhase>('idle');
  const [progress, setProgress] = useState<FastNavProgress | null>(null);
  const [splatCount, setSplatCount] = useState<number | null>(null);
  const [maxShDegree, setMaxShDegree] = useState(DEFAULT_SLICE_SETTINGS.sh_degree);
  const [maxChunkExtent, setMaxChunkExtent] = useState(DEFAULT_SLICE_SETTINGS.chunk_extent);
  const [navSettings, setNavSettings] = useState<DemoNavSettings>({ ...DEFAULT_DEMO_NAV_SETTINGS });
  const [selectionRegionVisible, setSelectionRegionVisibleState] = useState(false);
  const [hasLoadedSplat, setHasLoadedSplat] = useState(false);
  const [hasNavMesh, setHasNavMesh] = useState(false);

  const wasmReady = useRef(false);
  const currentCollisionArtifact = useRef<CollisionBoundaryArtifact | null>(null);
  const currentBytes = useRef<Uint8Array | null>(null);
  const currentName = useRef('splat');
  const currentNavMeshData = useRef<Uint8Array | null>(null);
  /** Stashed so Scale Environment set before load applies on first Fast Nav. */
  const pendingEnvironmentScale = useRef(1);
  /** Last selection-region AABB so hide→show can restore the user's box. */
  const cachedSelectionRegion = useRef<{ min: number[]; max: number[] } | null>(null);
  const navSettingsRef = useRef(navSettings);
  navSettingsRef.current = navSettings;
  const pruneFloaters = navSettings.pruneFloaters;
  const setPruneFloaters = useCallback((enabled: boolean): void => {
    setNavSettings((prev) => ({ ...prev, pruneFloaters: enabled }));
  }, []);

  const isBusy = status === 'loading' || status === 'processing';

  const appendLog = useCallback((message: string): void => {
    setLogs((prev) => [...prev, parseLog(message)]);
  }, []);

  const resetNavSettings = useCallback((): void => {
    setNavSettings({ ...DEFAULT_DEMO_NAV_SETTINGS });
    appendLog('[INFO] Navmesh settings reset to outdoor defaults.');
  }, [appendLog]);

  useEffect(() => {
    splatwalk.onProgress = (stage, fraction): void => setProgress({ stage, fraction });
    return () => {
      splatwalk.onProgress = null;
    };
  }, []);

  const reset = useCallback((): void => {
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
    currentName.current = 'splat';
    currentNavMeshData.current = null;
    pendingEnvironmentScale.current = 1;
    cachedSelectionRegion.current = null;
    setNavSettings({ ...DEFAULT_DEMO_NAV_SETTINGS });
    setSelectionRegionVisibleState(false);
    setHasLoadedSplat(false);
    setHasNavMesh(false);
    controller.disableRegionSelection();
    controller.setEnvironmentScale(1);
    void controller.reset();
  }, [controller]);

  const processBytes = useCallback(
    async (bytes: Uint8Array, name: string): Promise<void> => {
      currentBytes.current = bytes;
      setHasLoadedSplat(true);
      currentCollisionArtifact.current = null;
      currentName.current = name.replace(/\.(ply|spz|splat)$/i, '');
      currentNavMeshData.current = null;
      setHasNavMesh(false);
      setMaxShDegree(inferPlyShDegree(bytes));

      if (!wasmReady.current) {
        appendLog('[WAIT] Initializing SplatWalk WASM...');
        await splatwalk.init();
        wasmReady.current = true;
      }

      appendLog('[WAIT] Rendering Gaussian splat...');
      controller.setEnvironmentScale(pendingEnvironmentScale.current);
      await controller.loadSplat(bytes);
      appendLog('[INFO] Splat visualized.');

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
      let splatBounds: { min: number[]; max: number[] } | null = null;
      try {
        const bounds = await splatwalk.getSplatBounds(bytes, { ...base, prune_floaters: false });
        setSplatCount(bounds.point_count);
        splatBounds = { min: bounds.oriented_min, max: bounds.oriented_max };
        setMaxChunkExtent(maxChunkExtentFromBounds(splatBounds));
        controller.setSceneBounds(bounds.oriented_min, bounds.oriented_max);
      } catch {
        setSplatCount(null);
        setMaxChunkExtent(DEFAULT_SLICE_SETTINGS.chunk_extent);
      }

      setStatus('processing');
      setStatusMessage('Running FAST NAV...');
      appendLog(`[INFO] Floater prune: ${tuning.prune.enabled === false ? 'off' : 'on'}`);

      const recovery = resolveRecovery();

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

        setPhase('done');
        setProgress(null);
        setStatusMessage('Framing the player (top-down)...');
        controller.focusOnPlayer();

        setStatus('done');
        setStatusMessage('FAST NAV complete. Click the navmesh to move the player.');
      };

      // Persistent navmesh cache (the Babylon workbench / Vuetify pattern): the
      // FAST NAV product is fully reproducible from the splat bytes + settings,
      // so a revisit with the same inputs skips parse -> prune -> field -> Recast.
      const navCacheKey = buildNavmeshKey(bytes, {
        base,
        recovery,
        recastAttempts: FAST_NAV_RECAST_ATTEMPTS,
        recastOverrides: tuning.recastOverrides,
        floorMesh: tuning.floorMesh,
        islandValidation: tuning.islandValidation,
        navSettings: navSettingsRef.current,
        preset: 'fast-nav-r3f-v2',
      });
      const cached = await getNavmesh(navCacheKey);
      if (cached) {
        appendLog('[INFO] FAST NAV navmesh restored from cache (skipping recompute).');
        setPhase('navmesh');
        await spawnCrowdAndFrame(cached.navMeshData, cached.debugPositions, cached.debugIndices);
        return;
      }

      // Seed: center of the pinned or suggested region, lifted to standing height.
      setPhase('prune');
      const carveHeight = FAST_NAV_PRESET.collision_carve_height ?? 1.7;
      let seed: number[];
      if (regionBounds) {
        seed = [
          (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
          (regionBounds.min[1] + regionBounds.max[1]) * 0.5,
          (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
        ];
        appendLog('[INFO] Using pinned selection region for Fast Nav.');
      } else {
        const suggested = await splatwalk.suggestRegion(bytes, base);
        seed = [
          (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
          suggested.floor_y + carveHeight * 0.5,
          (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
        ];
      }
      appendLog(`[INFO] Fast path seed: ${seed.map((v) => v.toFixed(3)).join(', ')}`);

      setPhase('floor');
      const extracted = await extractFloorFieldWithRecovery({
        bytes,
        buildField: (b, s) => splatwalk.buildWalkableGroundField(b, s),
        baseSettings: { ...base, collision_seed: seed },
        seed,
        recovery,
        floorMesh: tuning.floorMesh,
        log: appendLog,
      });
      const floorMesh = extracted.floorMesh;
      controller.showFloor(floorMesh.positions, floorMesh.indices);
      appendLog(`[SUCCESS] Floor mesh ready (${floorMesh.selectedArea.toFixed(2)} m^2).`);

      setPhase('navmesh');
      const nav = await generateNavMesh(
        floorMesh.positions,
        floorMesh.indices,
        splatBounds,
        appendLog,
        tuning.recastOverrides
      );
      appendLog('[SUCCESS] NavMesh generated successfully.');
      await putNavmesh(navCacheKey, {
        navMeshData: nav.navMeshData,
        debugPositions: nav.debugPositions,
        debugIndices: nav.debugIndices,
      });

      await spawnCrowdAndFrame(nav.navMeshData, nav.debugPositions, nav.debugIndices);
    },
    [appendLog, controller]
  );

  const loadAndProcess = useCallback(
    async (file: File): Promise<void> => {
      if (isBusy) return;
      const name = file.name.toLowerCase();
      if (!SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        setErrorMessage('Only .ply, .spz, and .splat splat files are supported.');
        setStatus('error');
        return;
      }
      setErrorMessage(null);
      setLogs([]);
      setPhase('idle');
      setProgress(null);
      try {
        setStatus('loading');
        setStatusMessage(`Loading ${file.name}...`);
        appendLog(`[INFO] Loading file: ${file.name} (${file.size} bytes)`);
        const bytes = await readSplatBytes(file);
        await processBytes(bytes, file.name);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('FAST NAV failed.');
      }
    },
    [appendLog, controller, isBusy, processBytes]
  );

  const loadExample = useCallback(
    async (url: string, title: string): Promise<void> => {
      if (isBusy) return;
      setErrorMessage(null);
      setLogs([]);
      setPhase('idle');
      setProgress(null);
      try {
        setStatus('loading');
        setStatusMessage(`Fetching ${title}...`);
        appendLog(`[WAIT] Fetching example scene: ${title}...`);
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
        await processBytes(bytes, fileName);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(detail);
        appendLog(`[ERROR] ${detail}`);
        setStatus('error');
        setStatusMessage('Failed to load the example scene.');
      }
    },
    [appendLog, controller, isBusy, processBytes]
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
    const navMeshData = currentNavMeshData.current;
    if (!navMeshData) throw new Error('No navmesh generated to export.');
    exportNavmeshBinary({
      filename: `${currentName.current}.nav`,
      navMeshData,
    });
  }, []);

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
    const carveHeight = FAST_NAV_PRESET.collision_carve_height ?? 1.7;
    let seed: number[];
    if (regionBounds) {
      seed = [
        (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
        (regionBounds.min[1] + regionBounds.max[1]) * 0.5,
        (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
      ];
    } else {
      const suggested = await splatwalk.suggestRegion(bytes, base);
      seed = [
        (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
        suggested.floor_y + carveHeight * 0.5,
        (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
      ];
    }
    const artifact = await generateCollisionBoundaryArtifact({
      bytes,
      settings: buildCollisionBoundarySettings({
        base,
        emitGlb: true,
        flipY: true,
        rotation: [0, 0, 0],
        seed,
      }),
    });
    currentCollisionArtifact.current = artifact;
    controller.showCollisionBoundary(
      new Float32Array(artifact.result.mesh.vertices),
      new Uint32Array(artifact.result.mesh.indices)
    );
    appendLog(
      `[SUCCESS] Collision boundary ready: ${artifact.result.mesh.vertex_count} vertices, ${artifact.result.mesh.face_count} faces.`
    );
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

  const rerunFastNav = useCallback(async (): Promise<void> => {
    if (isBusy) {
      return;
    }
    const bytes = currentBytes.current;
    if (!bytes) {
      throw new Error('Load a splat before re-running Fast Nav.');
    }
    if (selectionRegionVisible) {
      const bounds = controller.getRegionBounds();
      if (bounds) {
        cachedSelectionRegion.current = {
          min: [...bounds.min],
          max: [...bounds.max],
        };
      }
    }
    setErrorMessage(null);
    const regionNote = controller.getRegionBounds() ? ' (pinned region)' : '';
    appendLog(`[INFO] Re-running FAST NAV${regionNote}…`);
    setStatus('processing');
    setStatusMessage('Re-running FAST NAV...');
    setPhase('idle');
    setProgress(null);
    try {
      await processBytes(bytes, `${currentName.current}.ply`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setErrorMessage(detail);
      appendLog(`[ERROR] ${detail}`);
      setStatus('error');
      setStatusMessage('FAST NAV failed.');
      throw error;
    }
  }, [appendLog, controller, isBusy, processBytes, selectionRegionVisible]);

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

  const setPendingEnvironmentScale = useCallback(
    (scale: number): void => {
      if (!Number.isFinite(scale) || scale <= 0) {
        return;
      }
      pendingEnvironmentScale.current = scale;
      controller.setEnvironmentScale(scale);
    },
    [controller]
  );

  const applyEnvironmentScale = useCallback(
    async (scale: number): Promise<void> => {
      if (isBusy) return;
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error('Scale Environment must be a positive number.');
      }
      setErrorMessage(null);
      setPendingEnvironmentScale(scale);

      const bytes = currentBytes.current;
      if (!bytes) {
        appendLog(`[INFO] Environment scale set to ${scale} (applies on next Fast Nav).`);
        return;
      }

      appendLog(`[INFO] Environment scale set to ${scale}; re-running FAST NAV...`);
      await rerunFastNav();
    },
    [appendLog, isBusy, rerunFastNav, setPendingEnvironmentScale]
  );

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
    loadExample,
    exportSog,
    exportNavmesh,
    generateCollisionBoundary,
    exportCollisionMesh,
    setCollisionBoundaryVisible,
    setNavMeshVisible,
    navSettings,
    setNavSettings,
    resetNavSettings,
    hasNavMesh,
    pruneFloaters,
    setPruneFloaters,
    hasLoadedSplat,
    selectionRegionVisible,
    setSelectionRegionVisible,
    rerunFastNav,
    applyEnvironmentScale,
    setPendingEnvironmentScale,
    reset,
  };
}

export type UseSplatFastNavR3F = ReturnType<typeof useSplatFastNavR3F>;
