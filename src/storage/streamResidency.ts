/**
 * Residency instrumentation for {@link GaussianSplattingStream}.
 *
 * Babylon decodes coarsest LODs in set order and skips when the budget is full.
 * PlayCanvas distance-balances LOD under a global splat budget instead. Until
 * Babylon grows a balancer (see UPSTREAM_ISSUES.md), we log decode/skip stats
 * and await camera-framed settle so Medium vs Ultra differences are observable.
 */

import type { Camera, Scene } from '@babylonjs/core';
import { Logger } from '@babylonjs/core/Misc/logger';
import type { GaussianSplattingStream } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

export interface StreamResidencyStats {
  readonly catalogFiles: number;
  readonly decodedFiles: number;
  readonly environmentSplats: number;
  readonly maxResidentSplats: number;
  readonly skippedBudgetWarnings: number;
  readonly settled: boolean;
}

interface StreamInternals {
  _decodedFiles?: Set<number>;
  _environmentRange?: { count: number; offset: number } | null;
  _residentBudget?: number;
  whenSettledAsync?: (stableFrames?: number) => Promise<void>;
}

const SKIP_WARN_RE = /resident memory budget full;\s*skipping LOD file/i;

/**
 * Install a Logger hook that counts Babylon "budget full; skipping LOD file" warnings.
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

export const readStreamResidencyStats = (
  stream: GaussianSplattingStream,
  catalogFiles: number,
  skippedBudgetWarnings: number
): StreamResidencyStats => {
  const internals = stream as unknown as StreamInternals;
  return {
    catalogFiles,
    decodedFiles: internals._decodedFiles?.size ?? 0,
    environmentSplats: internals._environmentRange?.count ?? 0,
    maxResidentSplats: internals._residentBudget ?? 0,
    skippedBudgetWarnings,
    settled: false,
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
      `budget ${report.maxResidentSplats.toLocaleString()} resident · ` +
      `budget-skip warnings=${report.skippedBudgetWarnings}` +
      (report.settled ? '' : ' (not fully settled)')
  );
  if (report.environmentSplats === 0) {
    log(
      '[WARN] No pinned environment SOG in residency (manifest may lack `environment`). ' +
        'PlayCanvas church uses example_roman_parish_02 with environment/environment.sog for the white sky.'
    );
  } else {
    log(`[SUCCESS] Environment sky resident: ${report.environmentSplats.toLocaleString()} splats (always-on).`);
  }
  if (report.skippedBudgetWarnings > 0) {
    log(
      '[WARN] Babylon skipped LOD files under the resident budget (set-order base decode). ' +
        'PlayCanvas distance-balances instead — see UPSTREAM_ISSUES.md. Try Ultra budget or larger lodBaseDistance.'
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
        'Babylon could not pin/decode the environment SOG into residency — white sky will be missing.'
    );
  }
};

/** Ensure active camera exists before settle (LOD evaluation is camera-relative). */
export const ensureActiveCameraForStream = (scene: Scene, camera: Camera | null): void => {
  if (camera) {
    scene.activeCamera = camera;
  }
};
