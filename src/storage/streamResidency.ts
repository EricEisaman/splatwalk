/**
 * Residency instrumentation for {@link GaussianSplattingStream}.
 *
 * Under a resident budget, coarsest LODs decode in set order and later files
 * may be skipped when full. Logs decode/skip stats and awaits camera-framed
 * settle so preset differences are observable.
 */

import type { Camera, Scene } from '@babylonjs/core';
import { Logger } from '@babylonjs/core/Misc/logger';
import type { GaussianSplattingStream } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

export interface StreamResidencyStats {
  readonly bufferCapacity: number;
  readonly catalogFiles: number;
  readonly catalogSplatEstimate: number;
  readonly decodedFiles: number;
  readonly environmentSplats: number;
  readonly evictionEnabled: boolean;
  readonly maxResidentSplats: number;
  readonly skippedBudgetWarnings: number;
  readonly settled: boolean;
  readonly textureSize: number;
}

interface StreamWorkBufferView {
  textureSize?: number;
}

interface StreamInternals {
  _decodedFiles?: Set<number>;
  _environmentRange?: { count: number; offset: number } | null;
  _evictionEnabled?: boolean;
  _fileCounts?: Map<number, number>;
  _residentBudget?: number;
  _splatPositions?: Float32Array | null;
  _workBuffer?: StreamWorkBufferView | null;
  whenSettledAsync?: (stableFrames?: number) => Promise<void>;
}

const SKIP_WARN_RE = /resident memory budget full;\s*skipping LOD file/i;
const CAPACITY_OVER_BUDGET_RATIO = 1.25;

/**
 * Install a Logger hook that counts "budget full; skipping LOD file" warnings.
 * Call dispose() when the stream is cleared.
 */
export const installBudgetSkipLogger = (): {
  dispose: () => void;
  getSkipCount: () => number;
} => {
  let skips = 0;
  const originalWarn = Logger.Warn.bind(Logger);
  Logger.Warn = (message: string | object): void => {
    const text = typeof message === 'string' ? message : String(message);
    if (SKIP_WARN_RE.test(text)) {
      skips += 1;
    }
    originalWarn(message as string);
  };
  return {
    dispose: () => {
      Logger.Warn = originalWarn;
    },
    getSkipCount: () => skips,
  };
};

const estimateCatalogSplats = (internals: StreamInternals): number => {
  let total = 0;
  const counts = internals._fileCounts;
  if (counts) {
    for (const count of counts.values()) {
      total += count;
    }
  }
  total += internals._environmentRange?.count ?? 0;
  return total;
};

const readBufferCapacity = (internals: StreamInternals): {
  bufferCapacity: number;
  textureSize: number;
} => {
  const textureSize = internals._workBuffer?.textureSize ?? 0;
  const fromPositions =
    internals._splatPositions && internals._splatPositions.length >= 4
      ? Math.floor(internals._splatPositions.length / 4)
      : 0;
  const fromTexture = textureSize > 0 ? textureSize * textureSize : 0;
  return {
    bufferCapacity: Math.max(fromPositions, fromTexture),
    textureSize,
  };
};

export const readStreamResidencyStats = (
  stream: GaussianSplattingStream,
  catalogFiles: number,
  skippedBudgetWarnings: number
): StreamResidencyStats => {
  const internals = stream as unknown as StreamInternals;
  const { bufferCapacity, textureSize } = readBufferCapacity(internals);
  return {
    bufferCapacity,
    catalogFiles,
    catalogSplatEstimate: estimateCatalogSplats(internals),
    decodedFiles: internals._decodedFiles?.size ?? 0,
    environmentSplats: internals._environmentRange?.count ?? 0,
    evictionEnabled: Boolean(internals._evictionEnabled),
    maxResidentSplats: internals._residentBudget ?? 0,
    skippedBudgetWarnings,
    settled: false,
    textureSize,
  };
};

/**
 * Frame is assumed already set. Await stream settle (with timeout) and return residency stats.
 */
export const awaitStreamResidencyReport = async (params: {
  catalogFiles: number;
  getSkipCount: () => number;
  log: (message: string) => void;
  settleTimeoutMs?: number;
  stream: GaussianSplattingStream;
}): Promise<StreamResidencyStats> => {
  const { catalogFiles, getSkipCount, log, stream } = params;
  const settleTimeoutMs = params.settleTimeoutMs ?? 45_000;
  let settled = false;

  const settleFn = (stream as unknown as StreamInternals).whenSettledAsync?.bind(stream);
  if (settleFn) {
    log('[WAIT] Waiting for stream to settle (camera-framed LOD + decode idle)…');
    try {
      await Promise.race([
        settleFn(3).then(() => {
          settled = true;
        }),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, settleTimeoutMs);
        }),
      ]);
      if (!settled) {
        log(`[WARN] Stream settle timed out after ${settleTimeoutMs}ms — reporting partial residency.`);
      } else {
        log('[SUCCESS] Stream settled for current camera.');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`[WARN] Stream settle failed: ${detail}`);
    }
  }

  const base = readStreamResidencyStats(stream, catalogFiles, getSkipCount());
  const report: StreamResidencyStats = { ...base, settled };
  log(
    `[INFO] Stream residency: decoded ${report.decodedFiles}/${report.catalogFiles} catalog files · ` +
      `env ${report.environmentSplats.toLocaleString()} splats · ` +
      `budget ${report.maxResidentSplats.toLocaleString()} · ` +
      `buffer capacity ${report.bufferCapacity.toLocaleString()} ` +
      `(tex ${report.textureSize}²) · eviction=${report.evictionEnabled ? 'on' : 'off'} · ` +
      `catalog≈${report.catalogSplatEstimate.toLocaleString()} · ` +
      `budget-skip warnings=${report.skippedBudgetWarnings}` +
      (report.settled ? '' : ' (not fully settled)')
  );
  if (
    report.maxResidentSplats > 0 &&
    report.bufferCapacity > report.maxResidentSplats * CAPACITY_OVER_BUDGET_RATIO
  ) {
    log(
      '[WARN] Work buffer capacity far above resident budget — likely constructed without ' +
        'maxResidentSplats/memoryBudgetMb (full-catalog alloc). Reload with budgeted stream options.'
    );
  }
  if (!report.evictionEnabled && report.catalogSplatEstimate > report.maxResidentSplats) {
    log(
      '[WARN] Eviction disabled while catalog estimate exceeds budget — expect multi-GB renderer memory.'
    );
  }
  if (report.environmentSplats === 0) {
    log(
      '[WARN] No pinned environment SOG in residency (manifest may lack `environment`).'
    );
  } else {
    log(`[SUCCESS] Environment sky resident: ${report.environmentSplats.toLocaleString()} splats (always-on).`);
  }
  if (report.skippedBudgetWarnings > 0) {
    log(
      '[WARN] Skipped LOD files under the resident budget (set-order base decode). ' +
        'Try a larger budget or larger lodBaseDistance.'
    );
  }
  return report;
};

/**
 * Fail loudly when the manifest declares an environment SOG but residency has none.
 * Missing sky must not be silent.
 */
export const assertStreamEnvironmentLoaded = (params: {
  environmentPath: string | undefined;
  stream: GaussianSplattingStream;
}): void => {
  if (!params.environmentPath) {
    return;
  }
  const envCount =
    (params.stream as unknown as StreamInternals)._environmentRange?.count ?? 0;
  if (envCount <= 0) {
    throw new Error(
      `Sky environment failed to load ("${params.environmentPath}"). ` +
        'Could not pin/decode the environment SOG into residency — white sky will be missing.'
    );
  }
};

/** Ensure active camera exists before settle (LOD evaluation is camera-relative). */
export const ensureActiveCameraForStream = (scene: Scene, camera: Camera | null): void => {
  if (camera) {
    scene.activeCamera = camera;
  }
};

/** Status-line fragment: decoded / budget / capacity / eviction (not "N resident"). */
export const formatStreamResidencyStatus = (stats: StreamResidencyStats): string =>
  `decoded ${stats.decodedFiles}/${stats.catalogFiles} · ` +
  `budget ${stats.maxResidentSplats.toLocaleString()} · ` +
  `buffer ${stats.bufferCapacity.toLocaleString()} · ` +
  `eviction ${stats.evictionEnabled ? 'on' : 'off'}`;
