/**
 * Fixed GPU residency budgets + tunable stream options for
 * {@link GaussianSplattingStream}.
 *
 * Catalog size (4M → 35M → 200M+) must never drive the work-buffer allocation.
 * Desktop Performance Mode table (2M on / 4M off) is the default;
 * Low/Medium/High/Ultra remain advanced overrides.
 */

import type { IGaussianSplattingStreamOptions } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

/** Desktop Performance Mode off — high quality budget. */
export const DESKTOP_HIGH_RESIDENT_SPLATS = 4_000_000;
/** Desktop Performance Mode on — default for freeze-safe fly. */
export const DESKTOP_PERF_RESIDENT_SPLATS = 2_000_000;
/** MB ceiling paired with desktop Performance Mode on (~84 bytes/splat). */
export const DESKTOP_PERF_MEMORY_BUDGET_MB = 192;
/** MB ceiling paired with desktop Performance Mode off. */
export const DESKTOP_HIGH_MEMORY_BUDGET_MB = 384;

/** @deprecated Prefer {@link DESKTOP_HIGH_RESIDENT_SPLATS}. */
export const DEFAULT_STREAM_MAX_RESIDENT_SPLATS = DESKTOP_HIGH_RESIDENT_SPLATS;
/** @deprecated Prefer {@link DESKTOP_HIGH_MEMORY_BUDGET_MB}. */
export const DEFAULT_STREAM_MEMORY_BUDGET_MB = DESKTOP_HIGH_MEMORY_BUDGET_MB;
/** @deprecated Prefer {@link DESKTOP_HIGH_RESIDENT_SPLATS}. */
export const SS_DESKTOP_HIGH_RESIDENT_SPLATS = DESKTOP_HIGH_RESIDENT_SPLATS;
/** @deprecated Prefer {@link DESKTOP_PERF_RESIDENT_SPLATS}. */
export const SS_DESKTOP_PERF_RESIDENT_SPLATS = DESKTOP_PERF_RESIDENT_SPLATS;
/** @deprecated Prefer {@link DESKTOP_PERF_MEMORY_BUDGET_MB}. */
export const SS_DESKTOP_PERF_MEMORY_BUDGET_MB = DESKTOP_PERF_MEMORY_BUDGET_MB;
/** @deprecated Prefer {@link DESKTOP_HIGH_MEMORY_BUDGET_MB}. */
export const SS_DESKTOP_HIGH_MEMORY_BUDGET_MB = DESKTOP_HIGH_MEMORY_BUDGET_MB;

export const STREAM_QUALITY_PRESETS = ['low', 'medium', 'high', 'ultra'] as const;

export type StreamQualityPreset = (typeof STREAM_QUALITY_PRESETS)[number];

/** Advanced preset label when Performance Mode is not driving the budget. */
export const DEFAULT_STREAM_QUALITY_PRESET: StreamQualityPreset = 'low';

/**
 * User-tunable stream overrides applied at {@link GaussianSplattingStream} construction.
 * Set before Load stream; changing them requires a reload.
 */
export interface StreamSettings {
  /** Frames before an unreferenced LOD file is evicted. Default 100. */
  evictionCooldownFrames: number;
  /** Bias off-screen nodes to coarsest LOD (keeps them in the set). Default true. */
  frustumCulling: boolean;
  /**
   * First LOD transition distance (local units). Raised above 5 so more of large
   * outdoor scenes stay coarse and fit under the same resident cap.
   */
  lodBaseDistance: number;
  /**
   * Distance multiplier for nodes behind the camera.
   * Performance Mode path uses 5; engine default is often 1.
   */
  lodBehindPenalty: number;
  /** Geometric ratio between successive LOD distances. Default 3. */
  lodMultiplier: number;
  /** Frames between LOD re-evals once the camera has moved. Default 12. */
  lodUpdateInterval: number;
  /** Concurrent LOD file downloads. Default 2. */
  maxConcurrentDownloads: number;
  /** LOD files decoded per frame (spreads GPU work). Default 1. */
  maxDecodesPerFrame: number;
  /**
   * Finest LOD index allowed (0 = full detail). Prefer 0 so distance LOD can still
   * coarsen far nodes; a high cap can starve sky/distant refinement under a tight budget.
   */
  maxDetailLod: number;
  /** GPU memory budget (MB); combined with maxResidentSplats by taking the smaller. */
  memoryBudgetMb: number;
  /** Max splats in the resident work buffer (enables eviction when catalog is larger). */
  maxResidentSplats: number;
  /**
   * Performance Mode. When true (default), desktop budget is 2M/192MB.
   * When false, 4M/384MB. Advanced quality presets override the numeric fields.
   */
  performanceMode: boolean;
  /** Active quality preset label (drives applyPreset). */
  preset: StreamQualityPreset;
}

interface StreamPresetConfig {
  readonly label: string;
  readonly maxResidentSplats: number;
  readonly memoryBudgetMb: number;
}

/**
 * Presets only change resident budget. maxDetailLod stays 0 so distance LOD can
 * still refine sky / far nodes within the budget.
 */
const PRESET_CONFIG: Record<StreamQualityPreset, StreamPresetConfig> = {
  low: {
    label: 'Low',
    maxResidentSplats: DESKTOP_PERF_RESIDENT_SPLATS,
    memoryBudgetMb: DESKTOP_PERF_MEMORY_BUDGET_MB,
  },
  medium: {
    label: 'Medium',
    maxResidentSplats: DESKTOP_HIGH_RESIDENT_SPLATS,
    memoryBudgetMb: DESKTOP_HIGH_MEMORY_BUDGET_MB,
  },
  high: {
    label: 'High',
    maxResidentSplats: 8_000_000,
    memoryBudgetMb: 768,
  },
  ultra: {
    label: 'Ultra',
    maxResidentSplats: 16_000_000,
    memoryBudgetMb: 1536,
  },
};

/** Defaults match desktop Performance Mode on + behind-camera penalty. */
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  evictionCooldownFrames: 100,
  frustumCulling: true,
  lodBaseDistance: 10,
  lodBehindPenalty: 5,
  lodMultiplier: 3,
  lodUpdateInterval: 12,
  maxConcurrentDownloads: 2,
  maxDecodesPerFrame: 1,
  maxDetailLod: 0,
  memoryBudgetMb: DESKTOP_PERF_MEMORY_BUDGET_MB,
  maxResidentSplats: DESKTOP_PERF_RESIDENT_SPLATS,
  performanceMode: true,
  preset: DEFAULT_STREAM_QUALITY_PRESET,
};

export const streamQualityPresetLabel = (preset: StreamQualityPreset): string =>
  PRESET_CONFIG[preset].label;

export const streamQualityPresetResidentSplats = (preset: StreamQualityPreset): number =>
  PRESET_CONFIG[preset].maxResidentSplats;

/** Apply desktop Performance Mode budget table onto settings. */
export const applyStreamPerformanceMode = (
  performanceMode: boolean,
  current: StreamSettings = DEFAULT_STREAM_SETTINGS
): StreamSettings => {
  if (performanceMode) {
    return {
      ...current,
      performanceMode: true,
      maxResidentSplats: DESKTOP_PERF_RESIDENT_SPLATS,
      memoryBudgetMb: DESKTOP_PERF_MEMORY_BUDGET_MB,
      preset: 'low',
    };
  }
  return {
    ...current,
    performanceMode: false,
    maxResidentSplats: DESKTOP_HIGH_RESIDENT_SPLATS,
    memoryBudgetMb: DESKTOP_HIGH_MEMORY_BUDGET_MB,
    preset: 'medium',
  };
};

/** Apply a quality preset onto settings (budget fields only). */
export const applyStreamQualityPreset = (
  preset: StreamQualityPreset,
  current: StreamSettings = DEFAULT_STREAM_SETTINGS
): StreamSettings => {
  const config = PRESET_CONFIG[preset] ?? PRESET_CONFIG.low;
  return {
    ...current,
    preset,
    maxResidentSplats: config.maxResidentSplats,
    memoryBudgetMb: config.memoryBudgetMb,
    performanceMode: preset === 'low',
  };
};

/**
 * Always returns a non-zero resident budget so callers cannot construct an
 * unbounded {@link GaussianSplattingStream} work buffer.
 */
export const streamOptionsFromSettings = (
  settings: StreamSettings
): IGaussianSplattingStreamOptions => ({
  evictionCooldownFrames: Math.max(0, Math.floor(settings.evictionCooldownFrames)),
  frustumCulling: settings.frustumCulling,
  lodBaseDistance: Math.max(0.1, settings.lodBaseDistance),
  lodBehindPenalty: Math.max(0, settings.lodBehindPenalty),
  lodMultiplier: Math.max(1.01, settings.lodMultiplier),
  lodUpdateInterval: Math.max(1, Math.floor(settings.lodUpdateInterval)),
  maxConcurrentDownloads: Math.max(1, Math.floor(settings.maxConcurrentDownloads)),
  maxDecodesPerFrame: Math.max(1, Math.floor(settings.maxDecodesPerFrame)),
  maxDetailLod: Math.max(0, Math.floor(settings.maxDetailLod)),
  maxResidentSplats: Math.max(1, Math.floor(settings.maxResidentSplats)),
  memoryBudgetMb: Math.max(1, Math.floor(settings.memoryBudgetMb)),
});

/** @deprecated Prefer {@link streamOptionsFromSettings}; kept for simple preset-only callers. */
export const streamOptionsForPreset = (
  preset: StreamQualityPreset = DEFAULT_STREAM_QUALITY_PRESET
): IGaussianSplattingStreamOptions =>
  streamOptionsFromSettings(applyStreamQualityPreset(preset));

/** Human-readable budget line for status logs (budget ≠ catalog size). */
export const formatStreamBudgetLog = (params: {
  chunkCount: number;
  settings: StreamSettings;
}): string => {
  const options = streamOptionsFromSettings(params.settings);
  const resident = options.maxResidentSplats ?? DESKTOP_PERF_RESIDENT_SPLATS;
  const perfLabel = params.settings.performanceMode ? 'Performance Mode on' : 'Performance Mode off';
  return (
    `Stream budget: ${resident.toLocaleString()} max · ${options.memoryBudgetMb} MB ` +
    `(${perfLabel}; ${streamQualityPresetLabel(params.settings.preset)}; eviction on when catalog > budget); ` +
    `lodBase=${options.lodBaseDistance} mult=${options.lodMultiplier} behind=${options.lodBehindPenalty} ` +
    `lodInterval=${options.lodUpdateInterval} maxDetailLod=${options.maxDetailLod} ` +
    `frustumCull=${options.frustumCulling}; catalog chunks=${params.chunkCount}`
  );
};
