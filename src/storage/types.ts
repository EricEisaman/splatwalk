/**
 * Storage adapter types for streaming SOG LOD splats from various backends.
 * 
 * Supports multiple storage providers (Cloudinary, local, S3, etc.) with a
 * unified interface for loading and streaming SOG bundles.
 */

import type { SecretReference } from './secrets/types';

/**
 * Configuration for a storage backend provider.
 * Each backend has its own specific configuration needs.
 */
export type StorageConfig =
  | LocalStorageConfig
  | CloudinaryStorageConfig;

/**
 * Local file storage configuration - for zip file uploads.
 */
export interface LocalStorageConfig {
  readonly type: 'local';
  /** Path or URL to a local SOG LOD zip file */
  readonly source: string | File | Blob;
}

/**
 * Cloudinary CDN storage configuration.
 * @see https://cloudinary.com/
 */
export interface CloudinaryStorageConfig {
  readonly type: 'cloudinary';
  /** 
   * Cloudinary cloud name.
   * Can be a direct string or a secret reference (e.g., GitHub Secrets, Netlify env vars).
   */
  readonly cloudName: string | SecretReference;
  /** Folder path where SOG bundles are stored */
  readonly folder: string;
  /** 
   * Optional: Cloudinary API key for programmatic access.
   * Can be a secret reference for secure credential management.
   */
  readonly apiKey?: string | SecretReference;
  /** 
   * Optional: Cloudinary API secret (use with caution; prefer secure references).
   * Should typically be a SecretReference, not a plain string.
   */
  readonly apiSecret?: SecretReference;
  /** Optional: specific bundle identifier (filename without extension) */
  readonly bundleId?: string;
  /** Optional: custom asset transformation/optimization parameters */
  readonly transformations?: Record<string, unknown>;
}

/**
 * Metadata about a storage source describing how to load a SOG bundle.
 */
export interface StorageSourceMetadata {
  /** The storage type/backend */
  readonly type: 'local' | 'cloudinary';
  /** URL or identifier for the root manifest file (lod-meta.json) */
  readonly manifestUrl: string;
  /** Optional: Base URL for resolving relative chunk URLs */
  readonly baseUrl?: string;
  /** Optional: Authentication headers needed for this source */
  readonly headers?: Record<string, string>;
  /** Optional: Custom fetch options */
  readonly fetchOptions?: RequestInit;
}

/**
 * Response from fetching manifest or chunk data.
 */
export interface StorageFetchResponse {
  /** The fetched data as bytes */
  readonly data: Uint8Array;
  /** Optional: the content type */
  readonly contentType?: string;
  /** Optional: response headers */
  readonly headers?: Record<string, string>;
}

/**
 * A storage adapter handles loading SOG LOD bundles from a specific backend.
 */
export interface StorageAdapter {
  /** Configuration used to initialize this adapter */
  readonly config: StorageConfig;
  
  /** Metadata describing how to access the storage source */
  readonly metadata: StorageSourceMetadata;

  /**
   * Fetch the root manifest file (lod-meta.json).
   * @returns parsed manifest object
   */
  getManifest(): Promise<unknown>;

  /**
   * Fetch a specific chunk file by its relative path.
   * @param path - Bundle-relative path (e.g., 'lod0/chunk0/means_l.webp')
   * @returns The chunk data as bytes
   */
  fetchChunk(path: string): Promise<StorageFetchResponse>;

  /**
   * Fetch multiple chunks in parallel.
   * @param paths - Array of bundle-relative paths
   * @returns Array of chunk responses in the same order
   */
  fetchChunks(paths: string[]): Promise<StorageFetchResponse[]>;

  /**
   * Resolve the absolute URL for a bundle-relative path.
   * @param path - Bundle-relative path
   * @returns Absolute URL suitable for direct access or streaming
   */
  resolveUrl(path: string): string;

  /**
   * Extract the entire bundle as a Map (for local preview/caching).
   * Only applicable for certain backends (e.g., local zip uploads).
   * @returns Map of bundle-relative paths to file bytes, or undefined if not supported
   */
  extractBundle?(): Promise<ReadonlyMap<string, Uint8Array> | undefined>;

  /**
   * Get metadata about the storage source (bundle size, chunk count, etc.)
   */
  getInfo(): Promise<StorageInfo>;

  /**
   * Clean up resources (e.g., revoke object URLs, close connections)
   */
  dispose(): void;
}

/**
 * Information about a storage source.
 */
export interface StorageInfo {
  /** Storage backend type */
  readonly type: string;
  /** Approximate total size in bytes (if known) */
  readonly totalBytes?: number;
  /** Estimated number of chunks */
  readonly chunkCount?: number;
  /** When the bundle was last modified */
  readonly lastModified?: Date;
  /** Optional: custom metadata from the provider */
  readonly custom?: Record<string, unknown>;
}

/**
 * Factory options for creating storage adapters.
 */
export interface StorageAdapterOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Whether to enable caching (default: true) */
  enableCache?: boolean;
  /** Maximum cache size in bytes (default: 50MB) */
  maxCacheBytes?: number;
  /** Optional: custom fetch function for HTTP requests */
  fetch?: typeof fetch;
}

/**
 * Represents a successfully resolved storage configuration ready for streaming.
 */
export interface ResolvedStorageConfig {
  adapter: StorageAdapter;
  manifestUrl: string;
}
