/**
 * Streaming splat-storage adapter generator (Pro) - SCAFFOLD.
 *
 * This is the reserved entry point for the first `@splatwalk/core-pro` feature:
 * generating ready-to-deploy streaming adapters for popular backend object stores
 * (targeted for the next release on the road to 1.0). The implementation is not
 * present yet; this file fixes the public shape and the license gate.
 */

import { requireProLicense } from './license';

export type StorageBackend = 's3' | 'gcs' | 'azure-blob' | 'r2';

export interface StorageAdapterOptions {
  /** Target backend object store. */
  backend: StorageBackend;
  /** Bucket / container name. */
  bucket: string;
  /** Optional key/path prefix for the streamed SOG bundle. */
  prefix?: string;
  /** Public base URL the streamed chunks will be served from, if any. */
  publicBaseUrl?: string;
}

export interface GeneratedStorageAdapter {
  backend: StorageBackend;
  /** Generated adapter source (module text) to drop into a backend project. */
  source: string;
  /** Files the adapter expects to upload (relative paths). */
  files: string[];
}

/**
 * Generate a streaming storage adapter for the given backend.
 *
 * TODO(pro): implement adapter codegen per backend. Currently reserved.
 */
export async function generateStorageAdapter(
  options: StorageAdapterOptions
): Promise<GeneratedStorageAdapter> {
  requireProLicense('generateStorageAdapter');
  throw new Error(
    `[@splatwalk/core-pro] generateStorageAdapter(${options.backend}) is reserved ` +
      `and not yet implemented in this scaffold.`
  );
}
