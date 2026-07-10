/**
 * Storage adapter factory for creating and managing SOG LOD streaming backends.
 * 
 * Handles configuration validation, adapter instantiation, and lifecycle management
 * for different storage providers (local, Cloudinary, etc.).
 */

import type {
  StorageConfig,
  StorageAdapter,
  StorageAdapterOptions,
  ResolvedStorageConfig,
} from './types';
import { LocalStorageAdapter } from './adapters/localStorageAdapter';
import { CloudinaryStorageAdapter } from './adapters/cloudinaryAdapter';

/**
 * Create a storage adapter for the given configuration.
 * 
 * @example
 * ```typescript
 * // Local zip file upload
 * const adapter = await createStorageAdapter({
 *   type: 'local',
 *   source: file // File object from input
 * });
 * 
 * // Cloudinary CDN
 * const adapter = await createStorageAdapter({
 *   type: 'cloudinary',
 *   cloudName: 'demo',
 *   folder: 'sog-bundles',
 *   bundleId: 'my-scene'
 * });
 * ```
 */
export async function createStorageAdapter(
  config: StorageConfig,
  options?: StorageAdapterOptions
): Promise<ResolvedStorageConfig> {
  switch (config.type) {
    case 'local':
      return await LocalStorageAdapter.create(config, options);
    case 'cloudinary':
      return await CloudinaryStorageAdapter.create(config, options);
    default:
      throw new Error(
        `Unknown storage type: ${(config as any).type}`
      );
  }
}

/**
 * Validates a storage configuration for completeness and correctness.
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateStorageConfig(config: StorageConfig): void {
  switch (config.type) {
    case 'local': {
      if (!config.source) {
        throw new Error('Local storage requires a source (File, Blob, or URL)');
      }
      break;
    }
    case 'cloudinary': {
      if (!config.cloudName || !config.folder) {
        throw new Error(
          'Cloudinary storage requires cloudName and folder'
        );
      }
      if (
        typeof config.cloudName === 'string' &&
        !/^[a-z0-9_-]+$/.test(config.cloudName)
      ) {
        throw new Error('Invalid Cloudinary cloud name');
      }
      break;
    }
    default:
      throw new Error(`Unknown storage type: ${(config as any).type}`);
  }
}

/**
 * Storage adapter registry for tracking active adapters and enabling cleanup.
 */
export class StorageAdapterRegistry {
  private adapters = new Set<StorageAdapter>();

  /**
   * Register an adapter for lifecycle tracking.
   */
  register(adapter: StorageAdapter): void {
    this.adapters.add(adapter);
  }

  /**
   * Unregister and dispose an adapter.
   */
  unregister(adapter: StorageAdapter): void {
    adapter.dispose();
    this.adapters.delete(adapter);
  }

  /**
   * Dispose all registered adapters.
   */
  disposeAll(): void {
    for (const adapter of this.adapters) {
      adapter.dispose();
    }
    this.adapters.clear();
  }

  /**
   * Get the number of active adapters.
   */
  get size(): number {
    return this.adapters.size;
  }
}

// Singleton registry instance
let registryInstance: StorageAdapterRegistry | null = null;

/**
 * Get the global storage adapter registry.
 */
export function getStorageRegistry(): StorageAdapterRegistry {
  if (!registryInstance) {
    registryInstance = new StorageAdapterRegistry();
  }
  return registryInstance;
}

/**
 * Cleanup all active storage adapters (typically on app shutdown).
 */
export function cleanupAllStorageAdapters(): void {
  getStorageRegistry().disposeAll();
}
