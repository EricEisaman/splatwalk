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
