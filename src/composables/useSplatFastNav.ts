import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { readSplatBytes, runFastNav } from '@/navigation/fastNav';
import { splatwalk } from '@/wasm/bridge';
import type { UseBabylonViewer } from '@/composables/useBabylonViewer';

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

/** Reactive API returned by {@link useSplatFastNav}. */
export interface UseSplatFastNav {
  readonly status: Ref<FastNavStatus>;
  readonly statusMessage: Ref<string>;
  readonly errorMessage: Ref<string | null>;
  readonly logs: Ref<LogEntry[]>;
  readonly isBusy: ComputedRef<boolean>;
  /** Validate, load, auto-run FAST NAV, then frame the player top-down. */
  readonly loadAndProcess: (file: File) => Promise<void>;
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
export function useSplatFastNav(babylon: UseBabylonViewer): UseSplatFastNav {
  const status = ref<FastNavStatus>('idle');
  const statusMessage = ref('Drop a .ply or .spz splat to begin.');
  const errorMessage = ref<string | null>(null);
  const logs = ref<LogEntry[]>([]);
  const isBusy = computed(() => status.value === 'loading' || status.value === 'processing');

  let wasmReady = false;

  const appendLog = (message: string): void => {
    logs.value.push(parseLog(message));
  };

  const reset = (): void => {
    status.value = 'idle';
    statusMessage.value = 'Drop a .ply or .spz splat to begin.';
    errorMessage.value = null;
    logs.value = [];
  };

  const loadAndProcess = async (file: File): Promise<void> => {
    if (isBusy.value) {
      return;
    }

    const name = file.name.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      errorMessage.value = 'Only .ply and .spz splat files are supported.';
      status.value = 'error';
      return;
    }

    errorMessage.value = null;
    logs.value = [];

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

      status.value = 'processing';
      statusMessage.value = 'Running FAST NAV...';
      await runFastNav({ viewer, bytes, onLog: appendLog });

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

  return { status, statusMessage, errorMessage, logs, isBusy, loadAndProcess, reset };
}
