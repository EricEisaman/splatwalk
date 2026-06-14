import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { Tools } from '@babylonjs/core';

import {
  readSplatBytes,
  runFastNav,
  type FastNavRecoveryConfig,
  type StrayTrimOptions,
  type PruneFloatersOptions,
  type FastNavPhase,
} from '@/navigation/fastNav';
import { splatwalk, type MeshSettings } from '@/wasm/bridge';
import { SliceArchive } from '@/wasm/sliceArchive';
import type { SliceSettings } from '@/wasm/sogTypes';
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
  /** Reset back to the idle state, clearing logs and errors. */
  readonly reset: () => void;
}

const SUPPORTED_EXTENSIONS = ['.ply', '.spz'] as const;

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
  const statusMessage = ref('Drop a .ply or .spz splat to begin.');
  const errorMessage = ref<string | null>(null);
  const logs = ref<LogEntry[]>([]);
  const phase = ref<FastNavUiPhase>('idle');
  const progress = ref<FastNavProgress | null>(null);
  const splatCount = ref<number | null>(null);
  const isBusy = computed(() => status.value === 'loading' || status.value === 'processing');

  let wasmReady = false;
  // Bytes + base name of the loaded scene, retained for SOG export.
  let currentBytes: Uint8Array | null = null;
  let currentName = 'splat';

  const appendLog = (message: string): void => {
    logs.value.push(parseLog(message));
  };

  // Throttled WASM progress (parse/prune/...) flows through the shared bridge.
  splatwalk.onProgress = (stage: string, fraction: number | null): void => {
    progress.value = { stage, fraction };
  };

  const reset = (): void => {
    status.value = 'idle';
    statusMessage.value = 'Drop a .ply or .spz splat to begin.';
    errorMessage.value = null;
    logs.value = [];
    phase.value = 'idle';
    progress.value = null;
    splatCount.value = null;
    currentBytes = null;
    currentName = 'splat';
  };

  const processFile = async (file: File): Promise<void> => {
    const name = file.name.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      errorMessage.value = 'Only .ply and .spz splat files are supported.';
      status.value = 'error';
      return;
    }

    try {
      status.value = 'loading';
      statusMessage.value = `Loading ${file.name}...`;
      appendLog(`[INFO] Loading file: ${file.name} (${file.size} bytes)`);

      const viewer = babylon.initViewer();

      if (!wasmReady) {
        appendLog('[WAIT] Initializing SplatWalk WASM...');
        await splatwalk.init();
        wasmReady = true;
      }

      await viewer.loadGaussianSplat(file);
      appendLog('[INFO] Splat visualized.');

      const bytes = await readSplatBytes(file);
      currentBytes = bytes;
      currentName = file.name.replace(/\.(ply|spz)$/i, '');
      // Capture the raw splat count for the export UI (cheap: the parse is cached
      // and reused by the FAST NAV run below).
      try {
        const bounds = await splatwalk.getSplatBounds(bytes, { mode: 2, prune_floaters: false } as MeshSettings);
        splatCount.value = bounds.point_count;
      } catch {
        splatCount.value = null;
      }

      status.value = 'processing';
      statusMessage.value = 'Running FAST NAV...';
      await runFastNav({
        viewer,
        bytes,
        onLog: appendLog,
        onPhase: (next) => { phase.value = next; },
        recovery: options.recovery,
        strayTrim: options.strayTrim,
        prune: options.prune,
      });
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
      const file = new File([data], `${title}.ply`, { type: 'application/octet-stream' });
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
    const result =
      mode === 'streamed'
        ? await splatwalk.sliceSplat(currentBytes, settings)
        : await splatwalk.convertToSog(currentBytes, settings);
    const archive = new SliceArchive(result);
    archive.download(`${currentName}-sog`);
    return archive;
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
    loadAndProcess,
    loadExample,
    exportSog,
    reset,
  };
}
