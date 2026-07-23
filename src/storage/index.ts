/**
 * Storage adapter system for streaming SOG LOD splats.
 * 
 * Public API re-exports for the storage module.
 */

// Core types
export type {
  StorageConfig,
  LocalStorageConfig,
  CloudinaryStorageConfig,
  StorageAdapter,
  StorageSourceMetadata,
  StorageFetchResponse,
  StorageInfo,
  ResolvedStorageConfig,
  StorageAdapterOptions,
} from './types';

// Factory and registry
export {
  createStorageAdapter,
  validateStorageConfig,
  StorageAdapterRegistry,
  getStorageRegistry,
  cleanupAllStorageAdapters,
} from './factory';

// Secrets
export type {
  SecretReference,
  GitHubSecretReference,
  RenderSecretReference,
  NetlifySecretReference,
  PlainSecretValue,
  ResolvedSecret,
  SecretResolutionOptions,
  SecretsResolver,
  SecretPlatformDetector,
  SecretsResolverConfig,
} from './secrets/types';

export {
  DefaultSecretsResolver,
  createSecretsResolver,
  getGlobalSecretsResolver,
  initializeGlobalSecretsResolver,
} from './secrets/resolver';

// Adapters
export { LocalStorageAdapter } from './adapters/localStorageAdapter';
export { CloudinaryStorageAdapter } from './adapters/cloudinaryAdapter';

// Streamed SOG load helpers (CDN lod-meta + local zip)
export {
  assertLodMetaCdnUrl,
  assertNotInterimLodMeta,
  installSogDownloadResolver,
  isSogLodMetadata,
  loadCdnLodMeta,
  loadLocalSogZip,
  resolveLodMetaCdnUrl,
  stripCommonZipRoot,
  summarizeLodMeta,
  type LoadCdnLodMetaResult,
  type LoadLocalSogZipResult,
  type SogLodManifestSummary,
} from './sogStreamLoader';

export {
  parseCameraModeQuery,
  parseTruthyQuery,
  parseVec3Bracket,
  type DeepLinkVec3,
} from './storageAdapterDeepLink';

// Fixed GPU residency budgets for city-scale streams
export {
  applyStreamPerformanceMode,
  applyStreamQualityPreset,
  DEFAULT_STREAM_MAX_RESIDENT_SPLATS,
  DEFAULT_STREAM_MEMORY_BUDGET_MB,
  DEFAULT_STREAM_QUALITY_PRESET,
  DEFAULT_STREAM_SETTINGS,
  DESKTOP_HIGH_MEMORY_BUDGET_MB,
  DESKTOP_HIGH_RESIDENT_SPLATS,
  DESKTOP_PERF_MEMORY_BUDGET_MB,
  DESKTOP_PERF_RESIDENT_SPLATS,
  SS_DESKTOP_HIGH_MEMORY_BUDGET_MB,
  SS_DESKTOP_HIGH_RESIDENT_SPLATS,
  SS_DESKTOP_PERF_MEMORY_BUDGET_MB,
  SS_DESKTOP_PERF_RESIDENT_SPLATS,
  STREAM_QUALITY_PRESETS,
  formatStreamBudgetLog,
  streamOptionsForPreset,
  streamOptionsFromSettings,
  streamQualityPresetLabel,
  streamQualityPresetResidentSplats,
  type StreamQualityPreset,
  type StreamSettings,
} from './streamMemoryBudget';

export {
  assertStreamEnvironmentLoaded,
  awaitStreamResidencyReport,
  ensureActiveCameraForStream,
  formatStreamResidencyStatus,
  installBudgetSkipLogger,
  readStreamResidencyStats,
  type StreamResidencyStats,
} from './streamResidency';

export {
  UnboundedStreamBufferError,
  assertStreamBufferBounded,
} from './streamBufferGuard';

export { installBudgetedTargetLevels } from './installBudgetedTargetLevels';

export {
  FLY_VIEW_UPDATE_THRESHOLD,
  SORT_POST_MIN_INTERVAL_MS,
  SS_FLY_VIEW_UPDATE_THRESHOLD,
  applySafeStreamRuntimeTuning,
  applyStreamRuntimeTuning,
  clampLodRangeToCoarsest,
  createOnDemandRenderController,
  installCoarseUntilIdleLodGate,
  installMotionDecodePause,
  installSortPostBackpressure,
  openFullLodRangeAfterReveal,
  withCoarseFirstLodRange,
  type SafeStreamRuntimeTuningReport,
} from './streamRuntimeParity';

// Streamed SOG → PLY for collision / FastNav
export {
  DEFAULT_NAV_MAX_SPLATS,
  DEFAULT_NAV_MIN_SPLATS,
  deriveLodMetaRootUrl,
  lodIndexFromChunkPath,
  materializeNavSourceFromStreamedSog,
  resolveLodIndex,
  selectChunkMetaPathsForLod,
  worldRegionToRawSogBounds,
  collectChunkMetaPathsOverlappingRegion,
  aabbOverlaps,
  type LodIndexOption,
  type MaterializeNavSourceOptions,
  type MaterializeNavSourceResult,
  type StreamedBundleAccess,
} from './materializeNavSourceFromStreamedSog';
