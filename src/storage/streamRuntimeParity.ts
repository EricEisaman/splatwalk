/**
 * Runtime helpers for {@link GaussianSplattingStream}: safe sort throttle,
 * motion decode pause, and LOD range helpers. Never terminates the sort worker.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Observer } from '@babylonjs/core/Misc/observable';
import type { Scene } from '@babylonjs/core/scene';
import type {
  GaussianSplattingStream,
  IGaussianSplattingStreamOptions,
} from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

/** Fly-friendly sort gate — default 1e-4 posts every micro-move. */
export const FLY_VIEW_UPDATE_THRESHOLD = 1e-2;
/** @deprecated Prefer {@link FLY_VIEW_UPDATE_THRESHOLD}. */
export const SS_FLY_VIEW_UPDATE_THRESHOLD = FLY_VIEW_UPDATE_THRESHOLD;

/** Min ms between GS `_postToWorker` calls after first-paint bootstrap. */
export const SORT_POST_MIN_INTERVAL_MS = 150;

const MOTION_MOVE_METERS = 0.08;
const MOTION_SETTLE_MS = 400;
const MOTION_TURN_DOT = 0.999;

interface StreamLodRangeInternals {
  _downloadManager?: { maxConcurrent?: number };
  _forceLodUpdate?: boolean;
  _lodRangeMax?: number;
  _lodRangeMin?: number;
  _maxDecodesPerFrame?: number;
  disableDepthSort: boolean;
}

interface SortBackpressureInternals {
  _cameraViewInfos?: Map<number, { splatIndexBufferSet: boolean }>;
  _frameSortBackpressureInstalled?: boolean;
  _postToWorker?: (forced?: boolean) => void;
}

export interface SafeStreamRuntimeTuningReport {
  readonly disableDepthSort: boolean;
  readonly shDegree: number;
  readonly viewUpdateThreshold: number;
}

export interface CameraMotionSample {
  readonly moving: boolean;
  readonly position: Vector3;
  readonly forward: Vector3;
}

/**
 * Coarse-first: clamp LOD range to coarsest level until first reveal.
 */
export const withCoarseFirstLodRange = (
  options: IGaussianSplattingStreamOptions,
  lodLevels: number
): IGaussianSplattingStreamOptions => {
  if (lodLevels <= 0) {
    return options;
  }
  const worstLod = lodLevels - 1;
  return {
    ...options,
    lodRangeMin: worstLod,
    lodRangeMax: worstLod,
  };
};

export const clampLodRangeToCoarsest = (
  stream: GaussianSplattingStream,
  lodLevels: number
): void => {
  if (lodLevels <= 0) {
    return;
  }
  const worstLod = lodLevels - 1;
  const internals = stream as unknown as StreamLodRangeInternals;
  internals._lodRangeMin = worstLod;
  internals._lodRangeMax = worstLod;
  internals._forceLodUpdate = true;
};

/**
 * Open full LOD range (call only while camera is idle after coarse ready).
 */
export const openFullLodRangeAfterReveal = (
  stream: GaussianSplattingStream,
  lodLevels: number
): void => {
  if (lodLevels <= 0) {
    return;
  }
  const internals = stream as unknown as StreamLodRangeInternals;
  internals._lodRangeMin = 0;
  internals._lodRangeMax = lodLevels - 1;
  internals._forceLodUpdate = true;
};

/**
 * Raise sort epsilon and disable SH. Never sets disableDepthSort.
 */
export const applySafeStreamRuntimeTuning = (
  stream: GaussianSplattingStream
): SafeStreamRuntimeTuningReport => {
  stream.viewUpdateThreshold = FLY_VIEW_UPDATE_THRESHOLD;
  if (stream.shDegree !== 0) {
    stream.shDegree = 0;
  }
  return {
    disableDepthSort: stream.disableDepthSort,
    shDegree: stream.shDegree,
    viewUpdateThreshold: stream.viewUpdateThreshold,
  };
};

/**
 * @deprecated Prefer {@link applySafeStreamRuntimeTuning}. Does not kill the sort worker.
 */
export const applyStreamRuntimeTuning = (
  stream: GaussianSplattingStream
): SafeStreamRuntimeTuningReport => applySafeStreamRuntimeTuning(stream);

/**
 * Rate-limit `_postToWorker` while keeping the sort worker alive.
 * Bootstrap cameras without a splat-index buffer always pass through.
 */
export const installSortPostBackpressure = (params: {
  minIntervalMs?: number;
  stream: GaussianSplattingStream;
}): void => {
  const internals = params.stream as unknown as SortBackpressureInternals;
  if (internals._frameSortBackpressureInstalled || !internals._postToWorker) {
    return;
  }
  const minIntervalMs = Math.max(1, params.minIntervalMs ?? SORT_POST_MIN_INTERVAL_MS);
  const original = internals._postToWorker.bind(params.stream);
  let lastPostAtMs = 0;
  internals._frameSortBackpressureInstalled = true;
  internals._postToWorker = (forced?: boolean) => {
    let needsBootstrap = false;
    internals._cameraViewInfos?.forEach((cameraViewInfos) => {
      if (!cameraViewInfos.splatIndexBufferSet) {
        needsBootstrap = true;
      }
    });
    const nowMs = performance.now();
    if (!needsBootstrap && lastPostAtMs > 0 && nowMs - lastPostAtMs < minIntervalMs) {
      return;
    }
    lastPostAtMs = nowMs;
    original(forced);
  };
};

const sampleCameraMotion = (params: {
  lastForward: Vector3 | null;
  lastPosition: Vector3 | null;
  scene: Scene;
}): {
  forward: Vector3;
  moving: boolean;
  position: Vector3;
} | null => {
  const camera = params.scene.activeCamera;
  if (!camera) {
    return null;
  }
  const position = camera.globalPosition;
  const forward = camera.getForwardRay(1).direction;
  if (!params.lastPosition || !params.lastForward) {
    return { forward: forward.clone(), moving: false, position: position.clone() };
  }
  const moveMetersSq = MOTION_MOVE_METERS * MOTION_MOVE_METERS;
  const dx = position.x - params.lastPosition.x;
  const dy = position.y - params.lastPosition.y;
  const dz = position.z - params.lastPosition.z;
  const moved = dx * dx + dy * dy + dz * dz > moveMetersSq;
  const dot = Math.min(
    1,
    Math.max(
      -1,
      forward.x * params.lastForward.x +
        forward.y * params.lastForward.y +
        forward.z * params.lastForward.z
    )
  );
  const turned = dot < MOTION_TURN_DOT;
  params.lastPosition.copyFrom(position);
  params.lastForward.copyFrom(forward);
  return { forward, moving: moved || turned, position };
};

/**
 * While moving: pause decode/download only (keep current splat ranges painted).
 * After idle settle: restore rates and force one LOD re-eval.
 */
export const installMotionDecodePause = (params: {
  getMaxConcurrentDownloads: () => number;
  getMaxDecodesPerFrame: () => number;
  onLog?: (message: string) => void;
  onRenderDirty?: () => void;
  stream: GaussianSplattingStream;
}): (() => void) => {
  const { stream } = params;
  const scene = stream.getScene();
  let frozen = false;
  let lastMotionAtMs = performance.now();
  let lastPosition: Vector3 | null = null;
  let lastForward: Vector3 | null = null;
  let savedMaxDecodes = Math.max(1, params.getMaxDecodesPerFrame());
  let savedMaxConcurrent = Math.max(1, params.getMaxConcurrentDownloads());

  const enterMotion = (): void => {
    const internals = stream as unknown as StreamLodRangeInternals;
    savedMaxDecodes = Math.max(1, params.getMaxDecodesPerFrame());
    savedMaxConcurrent = Math.max(1, params.getMaxConcurrentDownloads());
    internals._maxDecodesPerFrame = 0;
    if (internals._downloadManager) {
      internals._downloadManager.maxConcurrent = 0;
    }
    params.onRenderDirty?.();
  };

  const exitMotion = (): void => {
    const internals = stream as unknown as StreamLodRangeInternals;
    internals._maxDecodesPerFrame = savedMaxDecodes;
    if (internals._downloadManager) {
      internals._downloadManager.maxConcurrent = savedMaxConcurrent;
    }
    internals._forceLodUpdate = true;
    params.onLog?.('[INFO] Motion decode pause lifted; LOD re-eval forced.');
    params.onRenderDirty?.();
  };

  const observer: Observer<Scene> = scene.onBeforeRenderObservable.add(() => {
    const nowMs = performance.now();
    const sample = sampleCameraMotion({ lastForward, lastPosition, scene });
    if (!sample) {
      return;
    }
    if (!lastPosition || !lastForward) {
      lastPosition = sample.position.clone();
      lastForward = sample.forward.clone();
      return;
    }
    if (sample.moving) {
      lastMotionAtMs = nowMs;
      if (!frozen) {
        enterMotion();
        frozen = true;
      }
      params.onRenderDirty?.();
      return;
    }
    if (frozen && nowMs - lastMotionAtMs >= MOTION_SETTLE_MS) {
      exitMotion();
      frozen = false;
    }
  });

  return () => {
    scene.onBeforeRenderObservable.remove(observer);
    if (frozen) {
      const internals = stream as unknown as StreamLodRangeInternals;
      internals._maxDecodesPerFrame = savedMaxDecodes;
      if (internals._downloadManager) {
        internals._downloadManager.maxConcurrent = savedMaxConcurrent;
      }
      frozen = false;
    }
  };
};

/**
 * @deprecated Prefer {@link installMotionDecodePause} (decode-only; no LOD clamp).
 */
export const installCoarseUntilIdleLodGate = (params: {
  getMaxConcurrentDownloads: () => number;
  getMaxDecodesPerFrame: () => number;
  lodLevels: number;
  onLog?: (message: string) => void;
  onRenderDirty?: () => void;
  startWithFullRange?: boolean;
  stream: GaussianSplattingStream;
}): (() => void) => {
  if (params.startWithFullRange) {
    openFullLodRangeAfterReveal(params.stream, params.lodLevels);
  }
  return installMotionDecodePause(params);
};

/**
 * On-demand render: only call scene.render when the camera moved or dirty was flagged.
 * Prefer continuous renderLoop for streaming settle (on-demand can deadlock black).
 */
export const createOnDemandRenderController = (params: {
  getScene: () => Scene | null;
}): {
  dispose: () => void;
  markDirty: () => void;
  setContinuous: (enabled: boolean) => void;
  tick: () => void;
} => {
  let dirty = true;
  let continuous = true;
  let lastPosition: Vector3 | null = null;
  let lastForward: Vector3 | null = null;

  return {
    markDirty: () => {
      dirty = true;
    },
    setContinuous: (enabled: boolean) => {
      continuous = enabled;
      if (enabled) {
        dirty = true;
      }
    },
    dispose: () => {
      dirty = false;
      continuous = true;
      lastPosition = null;
      lastForward = null;
    },
    tick: () => {
      const scene = params.getScene();
      if (!scene) {
        return;
      }
      const sample = sampleCameraMotion({ lastForward, lastPosition, scene });
      if (sample) {
        if (!lastPosition || !lastForward) {
          lastPosition = sample.position.clone();
          lastForward = sample.forward.clone();
          dirty = true;
        } else if (sample.moving) {
          dirty = true;
        }
      }
      if (!continuous && !dirty) {
        return;
      }
      dirty = false;
      scene.render();
    },
  };
};
