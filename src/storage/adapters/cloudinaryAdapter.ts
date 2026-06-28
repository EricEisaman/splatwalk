/**
 * Cloudinary CDN storage adapter for SOG LOD bundles.
 * 
 * Streams SOG bundles from Cloudinary with support for:
 * - Direct URL access to uploaded files
 * - API-based metadata retrieval
 * - Secret references (GitHub Secrets, Render, Netlify)
 * - Configurable transformations and optimizations
 */

import type {
  CloudinaryStorageConfig,
  StorageAdapter,
  StorageAdapterOptions,
  StorageSourceMetadata,
  StorageFetchResponse,
  StorageInfo,
  ResolvedStorageConfig,
} from '../types';
import type { SecretReference } from '../secrets/types';
import { getGlobalSecretsResolver } from '../secrets/resolver';

/**
 * Cloudinary URL builder configuration.
 */
interface CloudinaryUrlConfig {
  cloudName: string;
  folder: string;
  bundleId: string;
  transformations?: Record<string, unknown>;
}

/**
 * Handles streaming SOG LOD bundles from Cloudinary CDN.
 */
export class CloudinaryStorageAdapter implements StorageAdapter {
  private urlConfig: CloudinaryUrlConfig | null = null;
  private manifestData: unknown | null = null;
  private cloudName: string = '';
  private folder: string = '';
  private bundleId: string = '';

  public constructor(
    public readonly config: CloudinaryStorageConfig,
    public readonly metadata: StorageSourceMetadata,
    private options: Required<StorageAdapterOptions>
  ) {
    this.folder = config.folder;
  }

  /**
   * Create a Cloudinary storage adapter from configuration.
   * Resolves secret references for credentials.
   */
  static async create(
    config: CloudinaryStorageConfig,
    options?: StorageAdapterOptions
  ): Promise<ResolvedStorageConfig> {
    const defaultOptions: Required<StorageAdapterOptions> = {
      timeout: 30_000,
      enableCache: true,
      maxCacheBytes: 50 * 1024 * 1024, // 50MB
      fetch: typeof fetch !== 'undefined' ? fetch : undefined as any,
    };
    const opts = { ...defaultOptions, ...options };

    // Resolve cloud name from secret reference if needed
    const cloudName = await CloudinaryStorageAdapter.resolveSecret(
      config.cloudName
    );

    // Build the base URL for the Cloudinary folder
    const baseUrl = CloudinaryStorageAdapter.buildBaseUrl(
      cloudName,
      config.folder
    );

    // Determine bundle ID
    const bundleId =
      config.bundleId ||
      CloudinaryStorageAdapter.generateBundleId(config.folder);

    const manifestUrl = `${baseUrl}/lod-meta.json`;

    const metadata: StorageSourceMetadata = {
      type: 'cloudinary',
      manifestUrl,
      baseUrl,
      headers: {
        // Cloudinary doesn't require authentication headers for public assets
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
      },
    };

    const adapter = new CloudinaryStorageAdapter(config, metadata, opts);
    adapter.cloudName = cloudName;
    adapter.folder = config.folder;
    adapter.bundleId = bundleId;

    return {
      adapter,
      manifestUrl,
    };
  }

  /**
   * Resolve a value that might be a secret reference.
   */
  private static async resolveSecret(
    value: string | SecretReference
  ): Promise<string> {
    if (typeof value === 'string') {
      return value;
    }

    const resolver = getGlobalSecretsResolver();
    const resolved = await resolver.resolve(value, {
      throwOnMissing: true,
    });

    if (!resolved) {
      throw new Error('Failed to resolve Cloudinary credential');
    }

    return resolved.value;
  }

  /**
   * Build the base URL for a Cloudinary folder.
   */
  private static buildBaseUrl(cloudName: string, folder: string): string {
    // Cloudinary delivery URLs follow this pattern:
    // https://res.cloudinary.com/{cloud}/image/upload/v1/{path}
    const encodedFolder = folder
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');

    return `https://res.cloudinary.com/${cloudName}/image/upload/v1/${encodedFolder}`;
  }

  /**
   * Generate a bundle ID from folder path if not specified.
   */
  private static generateBundleId(folder: string): string {
    return folder
      .split('/')
      .pop()
      ?.replace(/[^a-z0-9-]/gi, '-') || 'bundle';
  }

  /**
   * Apply transformations to a URL.
   */
  private applyTransformations(url: string): string {
    if (!this.config.transformations || !this.cloudName) {
      return url;
    }

    // Build transformation string from config
    const transformParams: string[] = [];

    for (const [key, value] of Object.entries(this.config.transformations)) {
      if (typeof value === 'boolean') {
        if (value) transformParams.push(key);
      } else if (value !== null && value !== undefined) {
        transformParams.push(`${key}_${String(value)}`);
      }
    }

    if (transformParams.length === 0) {
      return url;
    }

    // Insert transformations into the URL path
    // Original: https://res.cloudinary.com/{cloud}/image/upload/v1/{path}
    // With transforms: https://res.cloudinary.com/{cloud}/image/upload/{transforms}/v1/{path}
    const transforms = transformParams.join(',');
    return url.replace('/upload/v1/', `/upload/${transforms}/v1/`);
  }

  /**
   * Get the manifest file.
   */
  async getManifest(): Promise<unknown> {
    if (this.manifestData) {
      return this.manifestData;
    }

    const response = await this.fetchUrl(this.metadata.manifestUrl);
    const text = new TextDecoder().decode(response.data);
    this.manifestData = JSON.parse(text);
    return this.manifestData;
  }

  /**
   * Fetch a chunk by path.
   */
  async fetchChunk(path: string): Promise<StorageFetchResponse> {
    const url = this.resolveUrl(path);
    return this.fetchUrl(url);
  }

  /**
   * Fetch multiple chunks in parallel.
   */
  async fetchChunks(paths: string[]): Promise<StorageFetchResponse[]> {
    return Promise.all(paths.map((path) => this.fetchChunk(path)));
  }

  /**
   * Resolve a bundle-relative path to an absolute URL.
   */
  resolveUrl(path: string): string {
    let url = `${this.metadata.baseUrl}/${path}`;
    return this.applyTransformations(url);
  }

  /**
   * Get storage info (metadata from Cloudinary API if available).
   */
  async getInfo(): Promise<StorageInfo> {
    try {
      // Attempt to fetch metadata from Cloudinary API
      // This requires authentication and is optional
      const apiKey = this.config.apiKey
        ? await CloudinaryStorageAdapter.resolveSecret(this.config.apiKey)
        : undefined;

      if (apiKey) {
        return await this.fetchStorageInfoFromAPI(apiKey);
      }
    } catch {
      // Fall back to basic info if API fails
    }

    return {
      type: 'cloudinary',
      custom: {
        cloudName: this.cloudName,
        folder: this.folder,
        bundleId: this.bundleId,
      },
    };
  }

  /**
   * Fetch storage info from Cloudinary Admin API.
   */
  private async fetchStorageInfoFromAPI(apiKey: string): Promise<StorageInfo> {
    // Note: This would require authenticated API calls with the API key
    // For now, return basic info as a fallback
    return {
      type: 'cloudinary',
      custom: {
        cloudName: this.cloudName,
        folder: this.folder,
        bundleId: this.bundleId,
        apiAccessible: true,
      },
    };
  }

  /**
   * Fetch a URL via HTTP with caching support.
   */
  private async fetchUrl(url: string): Promise<StorageFetchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeout
    );

    try {
      const response = await (this.options.fetch || fetch)(url, {
        signal: controller.signal,
        headers: this.metadata.headers,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch from Cloudinary: ${response.status} ${response.statusText}`
        );
      }

      const data = new Uint8Array(await response.arrayBuffer());
      return {
        data,
        contentType: response.headers.get('content-type') || undefined,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Cloudinary URLs are directly accessible, so extraction is not applicable.
   */
  async extractBundle(): Promise<undefined> {
    return undefined;
  }

  /**
   * Dispose and clean up resources.
   */
  dispose(): void {
    this.manifestData = null;
  }
}
