import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { Tools } from '@babylonjs/core';

import {
  buildCollisionBoundarySettings,
  exportCollisionBoundaryGlb,
  exportNavmeshBinary,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
  seedFromRegionBounds,
  type CollisionBoundaryArtifact,
} from '@/collision/voxelBoundary';
import {
  readSplatBytes,
  runFastNav,
  type FastNavRecoveryConfig,
  type StrayTrimOptions,
  type PruneFloatersOptions,
  type FastNavPhase,
} from '@/navigation/fastNav';
import {
  DEFAULT_DEMO_NAV_SETTINGS,
  demoNavSettingsToFastNavTuning,
  type DemoNavSettings,
} from '@/navigation/navSettings';
import { splatwalk, type MeshSettings } from '@/wasm/bridge';
import { SUPPORTED_SPLAT_EXTENSIONS } from '@/wasm/normalize';
import { SliceArchive } from '@/wasm/sliceArchive';
import {
  clampSliceSettingsForScene,
  DEFAULT_SLICE_SETTINGS,
  inferPlyShDegree,
  maxChunkExtentFromBounds,
  type SliceSettings,
} from '@/wasm/sogTypes';
import type { UseBabylonViewer } from '@/composables/useBabylonViewer';

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
  /** Fetch an example splat from a URL, then run the same pipeline. */
  readonly loadExample: (url: string, title: string) => Promise<void>;
  /**
   * Export the loaded splat as a SOG bundle: `'streamed'` produces a streamed
   * multi-chunk `lod-meta.json` set; `'single'` produces one SOG `meta.json`.
   * Returns a {@link SliceArchive} (download / streaming handles). Throws if no
   * splat is loaded.
   */
  readonly exportSog: (mode: SogExportMode, settings?: SliceSettings) => Promise<SliceArchive>;
  /** Export the generated Recast navmesh binary. */
  readonly exportNavmesh: () => Promise<void>;
  /** Generate and show the collision voxel boundary overlay. */
  readonly generateCollisionBoundary: () => Promise<CollisionBoundaryArtifact>;
  /** Export the collision voxel boundary mesh as `.collision.glb`. */
  readonly exportCollisionMesh: () => Promise<Uint8Array>;
  /** Show or hide the collision voxel boundary overlay. */
  readonly setCollisionBoundaryVisible: (visible: boolean) => void;
  /** Show or hide the green walkable navmesh overlay (click-to-move target). */
  readonly setNavMeshVisible: (visible: boolean) => void;
  /** Full NM override panel (floor coverage + Recast), shared with Storage Adapter. */
  readonly navSettings: Ref<DemoNavSettings>;
  /** Reset {@link navSettings} to outdoor defaults. */
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
  /** Re-run Fast Nav on the loaded splat using current prune / region / scale. */
  readonly rerunFastNav: () => Promise<void>;
  /**
   * Apply absolute uniform environment scale to the splat, then re-run FAST NAV
   * so collision / navmesh bake in the same world meters.
   * When no splat is loaded yet, only stashes the scale for the next Fast Nav.
   */
  readonly applyEnvironmentScale: (scale: number) => Promise<void>;
  /** Stash scale for the next Fast Nav without rebuilding (no-op if invalid). */
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
  const navSettings = ref<DemoNavSettings>({
    ...DEFAULT_DEMO_NAV_SETTINGS,
    pruneFloaters: options.prune?.enabled ?? DEFAULT_DEMO_NAV_SETTINGS.pruneFloaters,
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
  const isBusy = computed(() => status.value === 'loading' || status.value === 'processing');
  const hasLoadedSplatComputed = computed(() => hasLoadedSplat.value);

  let wasmReady = false;
  // Bytes + base name of the loaded scene, retained for SOG export.
  let currentBytes: Uint8Array | null = null;
  let currentName = 'splat';
  let currentCollisionArtifact: CollisionBoundaryArtifact | null = null;
  let currentNavMeshData: Uint8Array | null = null;
  /** Stashed so Scale Environment set before load applies on first Fast Nav. */
  let pendingEnvironmentScale = 1;
  /** Last selection-region AABB so hide→show can restore the user's box. */
  let cachedSelectionRegion: { min: number[]; max: number[] } | null = null;

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
  };

  // Throttled WASM progress (parse/prune/...) flows through the shared bridge.
  splatwalk.onProgress = (stage: string, fraction: number | null): void => {
    progress.value = { stage, fraction };
  };

  const reset = (): void => {
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
    currentCollisionArtifact = null;
    currentName = 'splat';
    currentNavMeshData = null;
    pendingEnvironmentScale = 1;
    cachedSelectionRegion = null;
    hasLoadedSplat.value = false;
    hasNavMesh.value = false;
    navSettings.value = {
      ...DEFAULT_DEMO_NAV_SETTINGS,
      pruneFloaters: options.prune?.enabled ?? DEFAULT_DEMO_NAV_SETTINGS.pruneFloaters,
    };
    selectionRegionVisible.value = false;
    babylon.viewer.value?.disableRegionSelection();
    babylon.viewer.value?.setEnvironmentScale(1);
  };

  const resetNavSettings = (): void => {
    navSettings.value = {
      ...DEFAULT_DEMO_NAV_SETTINGS,
      pruneFloaters: options.prune?.enabled ?? DEFAULT_DEMO_NAV_SETTINGS.pruneFloaters,
    };
    appendLog('[INFO] Navmesh settings reset to outdoor defaults.');
  };

  const processFile = async (file: File): Promise<void> => {
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

      const viewer = babylon.initViewer();
      viewer.setEnvironmentScale(pendingEnvironmentScale);

      if (!wasmReady) {
        appendLog('[WAIT] Initializing SplatWalk WASM...');
        await splatwalk.init();
        wasmReady = true;
      }

      // Normalize to PLY once (WASM is ready above), then reuse the same bytes
      // for both the viewer and the nav pipeline.
      const bytes = await readSplatBytes(file);
      maxShDegree.value = inferPlyShDegree(bytes);
      await viewer.loadGaussianSplat(bytes);
      appendLog('[INFO] Splat visualized.');

      currentBytes = bytes;
      hasLoadedSplat.value = true;
      currentCollisionArtifact = null;
      currentName = file.name.replace(/\.(ply|spz|splat)$/i, '');
      currentNavMeshData = null;
      hasNavMesh.value = false;
      // Capture the raw splat count for the export UI (cheap: the parse is cached
      // and reused by the FAST NAV run below).
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

      status.value = 'processing';
      statusMessage.value = 'Running FAST NAV...';
      const tuning = resolveFastNavTuning();
      appendLog(`[INFO] Floater prune: ${tuning.prune.enabled === false ? 'off' : 'on'}`);
      const fastNav = await runFastNav({
        viewer,
        bytes,
        onLog: appendLog,
        onPhase: (next) => { phase.value = next; },
        recovery: options.recovery,
        strayTrim: options.strayTrim,
        ...tuning,
      });
      currentNavMeshData = fastNav.navMeshData;
      hasNavMesh.value = true;
      phase.value = 'done';
      progress.value = null;

      statusMessage.value = 'Framing the player (top-down)...';
      const framing = viewer.focusOnPlayer();
      if (framing) {
        appendLog(
          `[SUCCESS] Top-down view set above player at ` +
            `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      } else {
        appendLog('[WARN] No player agent to frame; leaving the default camera.');
      }

      status.value = 'done';
      statusMessage.value = 'FAST NAV complete. Click the navmesh to move the player.';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = 'FAST NAV failed.';
      // Keep any prior navmesh if recompute failed after a successful run.
      if (!currentNavMeshData) {
        hasNavMesh.value = false;
      }
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
    await processFile(file);
  };

  const loadExample = async (url: string, title: string): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    errorMessage.value = null;
    logs.value = [];
    phase.value = 'idle';
    progress.value = null;

    try {
      status.value = 'loading';
      statusMessage.value = `Fetching ${title}...`;
      appendLog(`[WAIT] Fetching example scene: ${title}...`);

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
    if (!currentNavMeshData) {
      throw new Error('No navmesh generated to export.');
    }
    exportNavmeshBinary({
      filename: `${currentName}.nav`,
      navMeshData: currentNavMeshData,
    });
  };

  const generateCollisionBoundary = async (): Promise<CollisionBoundaryArtifact> => {
    const bytes = currentBytes;
    const viewer = babylon.viewer.value;
    if (!bytes || !viewer) {
      throw new Error('No loaded splat to generate collision from.');
    }
    const rotation = viewer.getSplatRotation();
    const settings = buildCollisionBoundarySettings({
      base: {
        prune_floaters: navSettings.value.pruneFloaters,
      },
      emitGlb: true,
      flipY: viewer.isSplatYFlipped(),
      rotation: [rotation.x, rotation.y, rotation.z],
      seed: seedFromRegionBounds({ regionBounds: viewer.getRegionBounds() }),
    });
    const artifact = await generateCollisionBoundaryArtifact({ bytes, settings });
    currentCollisionArtifact = artifact;
    viewer.displayColliderMesh(artifact.result.mesh.vertices, artifact.result.mesh.indices, 0.35);
    viewer.setColliderVisible(true);
    appendLog(
      `[SUCCESS] Collision boundary ready: ${artifact.result.mesh.vertex_count} vertices, ${artifact.result.mesh.face_count} faces.`
    );
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

  const setNavMeshVisible = (visible: boolean): void => {
    babylon.viewer.value?.setNavMeshVisible(visible);
  };

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
          const splatBounds = viewer.getLoadedSplatBounds();
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
    babylon.viewer.value?.setEnvironmentScale(scale);
  };

  const rerunFastNav = async (): Promise<void> => {
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
    appendLog(`[INFO] Re-running FAST NAV${regionNote}…`);

    try {
      status.value = 'processing';
      statusMessage.value = 'Re-running FAST NAV...';
      phase.value = 'idle';
      progress.value = null;

      const tuning = resolveFastNavTuning();
      appendLog(`[INFO] Floater prune: ${tuning.prune.enabled === false ? 'off' : 'on'}`);
      const fastNav = await runFastNav({
        viewer,
        bytes: currentBytes,
        onLog: appendLog,
        onPhase: (next) => {
          phase.value = next;
        },
        recovery: options.recovery,
        strayTrim: options.strayTrim,
        ...tuning,
      });
      currentNavMeshData = fastNav.navMeshData;
      hasNavMesh.value = true;
      phase.value = 'done';
      progress.value = null;

      statusMessage.value = 'Framing the player (top-down)...';
      const framing = viewer.focusOnPlayer();
      if (framing) {
        appendLog(
          `[SUCCESS] Top-down view set above player at ` +
            `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      }

      status.value = 'done';
      statusMessage.value = 'FAST NAV complete. Click the navmesh to move the player.';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorMessage.value = detail;
      appendLog(`[ERROR] ${detail}`);
      status.value = 'error';
      statusMessage.value = 'FAST NAV failed.';
      // Keep any prior navmesh if recompute failed after a successful run.
      if (!currentNavMeshData) {
        hasNavMesh.value = false;
      }
      throw error;
    }
  };

  const applyEnvironmentScale = async (scale: number): Promise<void> => {
    if (isBusy.value) {
      return;
    }
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error('Scale Environment must be a positive number.');
    }

    errorMessage.value = null;
    setPendingEnvironmentScale(scale);

    if (!currentBytes) {
      appendLog(`[INFO] Environment scale set to ${scale} (applies on next Fast Nav).`);
      return;
    }

    appendLog(`[INFO] Environment scale set to ${scale}; re-running FAST NAV...`);
    await rerunFastNav();
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
    loadExample,
    exportSog,
    exportNavmesh,
    generateCollisionBoundary,
    exportCollisionMesh,
    setCollisionBoundaryVisible,
    setNavMeshVisible,
    navSettings,
    resetNavSettings,
    hasNavMesh,
    pruneFloaters,
    hasLoadedSplat: hasLoadedSplatComputed,
    selectionRegionVisible,
    setSelectionRegionVisible,
    rerunFastNav,
    applyEnvironmentScale,
    setPendingEnvironmentScale,
    reset,
  };
}
