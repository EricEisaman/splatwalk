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
  stripCommonZipRoot,
  summarizeLodMeta,
  type LoadCdnLodMetaResult,
  type LoadLocalSogZipResult,
  type SogLodManifestSummary,
} from './sogStreamLoader';

// Fixed GPU residency budgets for city-scale streams
export {
  applyStreamQualityPreset,
  DEFAULT_STREAM_MAX_RESIDENT_SPLATS,
  DEFAULT_STREAM_MEMORY_BUDGET_MB,
  DEFAULT_STREAM_QUALITY_PRESET,
  DEFAULT_STREAM_SETTINGS,
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
  installBudgetSkipLogger,
  readStreamResidencyStats,
  type StreamResidencyStats,
} from './streamResidency';

// Streamed SOG → PLY for collision / FastNav
export {
  DEFAULT_NAV_MAX_SPLATS,
  DEFAULT_NAV_MIN_SPLATS,
  deriveLodMetaRootUrl,
  lodIndexFromChunkPath,
  materializeNavSourceFromStreamedSog,
  resolveLodIndex,
  selectChunkMetaPathsForLod,
  type LodIndexOption,
  type MaterializeNavSourceOptions,
  type MaterializeNavSourceResult,
  type StreamedBundleAccess,
} from './materializeNavSourceFromStreamedSog';
