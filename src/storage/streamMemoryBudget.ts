/**
 * Fixed GPU residency budgets + tunable stream options for
 * {@link GaussianSplattingStream}.
 *
 * Catalog size (4M → 35M → 200M+) must never drive the work-buffer allocation.
 * Presets match PlayCanvas Low/Medium/High/Ultra (resident budget first);
 * advanced knobs override defaults before Load stream.
 */

import type { IGaussianSplattingStreamOptions } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

/** PlayCanvas Medium-class default — production default for city-scale streams. */
export const DEFAULT_STREAM_MAX_RESIDENT_SPLATS = 4_000_000;

/** Secondary MB ceiling (~84 bytes/resident splat); Babylon takes min(count, MB). */
export const DEFAULT_STREAM_MEMORY_BUDGET_MB = 384;

export const STREAM_QUALITY_PRESETS = ['low', 'medium', 'high', 'ultra'] as const;

export type StreamQualityPreset = (typeof STREAM_QUALITY_PRESETS)[number];

export const DEFAULT_STREAM_QUALITY_PRESET: StreamQualityPreset = 'medium';

/**
 * User-tunable stream overrides applied at {@link GaussianSplattingStream} construction.
 * Set before Load stream; changing them requires a reload.
 */
export interface StreamSettings {
  /** Frames before an unreferenced LOD file is evicted. PlayCanvas default 100. */
  evictionCooldownFrames: number;
  /** Bias off-screen nodes to coarsest LOD (keeps them in the set). Default true. */
  frustumCulling: boolean;
  /**
   * First LOD transition distance (local units). Raised above PlayCanvas's 5 so
   * more of large outdoor scenes stay coarse and fit under the same resident cap
   * (helps sky/far nodes survive Babylon's set-order base decode).
   */
  lodBaseDistance: number;
  /** Distance multiplier for nodes behind the camera. PlayCanvas default 1. */
  lodBehindPenalty: number;
  /** Geometric ratio between successive LOD distances. PlayCanvas default 3. */
  lodMultiplier: number;
  /** Concurrent LOD file downloads. PlayCanvas default 2. */
  maxConcurrentDownloads: number;
  /** LOD files decoded per frame (spreads GPU work). Default 1. */
  maxDecodesPerFrame: number;
  /**
   * Finest LOD index allowed (0 = full detail). Prefer 0 like PlayCanvas quality
   * modes — distance LOD still coarsens far nodes; a high cap can starve sky/distant
   * refinement under a tight resident budget.
   */
  maxDetailLod: number;
  /** GPU memory budget (MB); combined with maxResidentSplats by taking the smaller. */
  memoryBudgetMb: number;
  /** Max splats in the resident work buffer (enables eviction when catalog is larger). */
  maxResidentSplats: number;
  /** Active quality preset label (drives applyPreset). */
  preset: StreamQualityPreset;
}

interface StreamPresetConfig {
  readonly label: string;
  readonly maxResidentSplats: number;
  readonly memoryBudgetMb: number;
}

/**
 * Presets only change resident budget (PlayCanvas-style). maxDetailLod stays 0
 * so distance LOD can still refine sky / far nodes within the budget.
 */
const PRESET_CONFIG: Record<StreamQualityPreset, StreamPresetConfig> = {
  low: {
    label: 'Low',
    maxResidentSplats: 2_000_000,
    memoryBudgetMb: 192,
  },
  medium: {
    label: 'Medium',
    maxResidentSplats: DEFAULT_STREAM_MAX_RESIDENT_SPLATS,
    memoryBudgetMb: DEFAULT_STREAM_MEMORY_BUDGET_MB,
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

/** Outdoor / city-scale defaults (Medium budget + wider LOD base for sky coverage). */
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  evictionCooldownFrames: 100,
  frustumCulling: true,
  lodBaseDistance: 10,
  lodBehindPenalty: 1,
  lodMultiplier: 3,
  maxConcurrentDownloads: 2,
  maxDecodesPerFrame: 1,
  maxDetailLod: 0,
  memoryBudgetMb: DEFAULT_STREAM_MEMORY_BUDGET_MB,
  maxResidentSplats: DEFAULT_STREAM_MAX_RESIDENT_SPLATS,
  preset: DEFAULT_STREAM_QUALITY_PRESET,
};

export const streamQualityPresetLabel = (preset: StreamQualityPreset): string =>
  PRESET_CONFIG[preset].label;

export const streamQualityPresetResidentSplats = (preset: StreamQualityPreset): number =>
  PRESET_CONFIG[preset].maxResidentSplats;

/** Apply a PlayCanvas-style quality preset onto settings (budget fields only). */
export const applyStreamQualityPreset = (
  preset: StreamQualityPreset,
  current: StreamSettings = DEFAULT_STREAM_SETTINGS
): StreamSettings => {
  const config = PRESET_CONFIG[preset] ?? PRESET_CONFIG.medium;
  return {
    ...current,
    preset,
    maxResidentSplats: config.maxResidentSplats,
    memoryBudgetMb: config.memoryBudgetMb,
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
  const resident = options.maxResidentSplats ?? DEFAULT_STREAM_MAX_RESIDENT_SPLATS;
  return (
    `Stream budget: ${resident.toLocaleString()} resident / ${options.memoryBudgetMb} MB ` +
    `(${streamQualityPresetLabel(params.settings.preset)}; eviction on when catalog > budget); ` +
    `lodBase=${options.lodBaseDistance} mult=${options.lodMultiplier} ` +
    `maxDetailLod=${options.maxDetailLod} frustumCull=${options.frustumCulling}; ` +
    `catalog chunks=${params.chunkCount}`
  );
};
