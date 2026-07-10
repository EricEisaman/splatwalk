/**
 * Local file storage adapter for SOG LOD bundles.
 * 
 * Supports uploading zip files and extracting them for in-memory streaming preview,
 * or direct URL access to locally served bundles.
 */

import type {
  LocalStorageConfig,
  StorageAdapter,
  StorageAdapterOptions,
  StorageSourceMetadata,
  StorageFetchResponse,
  StorageInfo,
  ResolvedStorageConfig,
} from '../types';

/**
 * Handles streaming SOG LOD bundles from local storage (zip files or direct URLs).
 */
export class LocalStorageAdapter implements StorageAdapter {
  private bundleFiles: Map<string, Uint8Array> | null = null;
  private manifestData: unknown | null = null;
  private objectUrls = new Map<string, string>();
  private _metadata: StorageSourceMetadata;

  public constructor(
    public readonly config: LocalStorageConfig,
    metadata: StorageSourceMetadata,
    private options: Required<StorageAdapterOptions>
  ) {
    this._metadata = metadata;
  }

  public get metadata(): StorageSourceMetadata {
    return this._metadata;
  }

  /**
   * Create a local storage adapter from configuration.
   */
  static async create(
    config: LocalStorageConfig,
    options?: StorageAdapterOptions
  ): Promise<ResolvedStorageConfig> {
    const defaultOptions: Required<StorageAdapterOptions> = {
      timeout: 30_000,
      enableCache: true,
      maxCacheBytes: 50 * 1024 * 1024, // 50MB
      fetch: typeof fetch !== 'undefined' ? fetch : undefined as any,
    };
    const opts = { ...defaultOptions, ...options };

    // Determine metadata based on source type
    let metadata: StorageSourceMetadata;

    if (config.source instanceof File || config.source instanceof Blob) {
      // File upload: extract as zip and create blob URLs
      metadata = {
        type: 'local',
        manifestUrl: '', // Will be set after extraction
        baseUrl: 'blob:', // Use blob: URLs for in-memory files
      };
    } else {
      // String URL: assume it's a hosted zip or directory
      metadata = {
        type: 'local',
        manifestUrl: typeof config.source === 'string' 
          ? config.source 
          : 'file://local',
        baseUrl: typeof config.source === 'string'
          ? new URL('.', config.source).href
          : 'file://',
      };
    }

    const adapter = new LocalStorageAdapter(config, metadata, opts);

    // Extract bundle if it's a File or Blob
    if (config.source instanceof File || config.source instanceof Blob) {
      await adapter.extractZipBundle(config.source);
    }

    const manifestUrl = adapter.metadata.manifestUrl || 
      adapter.resolveUrl('lod-meta.json');

    return {
      adapter,
      manifestUrl,
    };
  }

  /**
   * Extract a zip file and populate the bundle map.
   */
  private async extractZipBundle(source: File | Blob): Promise<void> {
    const arrayBuffer = await source.arrayBuffer();
    const files = await this.unzipBuffer(new Uint8Array(arrayBuffer));
    this.bundleFiles = files;

    // Update manifest URL to point to the extracted manifest
    const manifestPath = this.findManifestPath(files);
    if (manifestPath) {
      this._metadata = {
        ...this._metadata,
        manifestUrl: this.createBlobUrl(manifestPath),
      };
    }
  }

  /**
   * Simple zip extraction (stores-only format, no compression).
   * This is a minimal implementation suitable for store-only zips.
   */
  private async unzipBuffer(buffer: Uint8Array): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    
    // This is a simplified unzip that works with store-only (uncompressed) zips
    // For production, consider using a library like 'unzipit' or 'jszip'
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
    let offset = 0;

    while (offset < buffer.length - 22) {
      // Look for local file header signature (0x04034b50)
      if (view.getUint32(offset, true) === 0x04034b50) {
        const filenameLen = view.getUint16(offset + 26, true);
        const extraLen = view.getUint16(offset + 28, true);
        const compressedSize = view.getUint32(offset + 18, true);

        const nameBytes = buffer.slice(offset + 30, offset + 30 + filenameLen);
        const filename = new TextDecoder().decode(nameBytes);

        const dataStart = offset + 30 + filenameLen + extraLen;
        const fileData = buffer.slice(dataStart, dataStart + compressedSize);

        files.set(filename, new Uint8Array(fileData));

        offset = dataStart + compressedSize;
      } else {
        offset += 1;
      }
    }

    return files;
  }

  /**
   * Find the manifest file path in the bundle.
   */
  private findManifestPath(files: Map<string, Uint8Array>): string | null {
    // Check for lod-meta.json first (streamed SOG)
    for (const path of files.keys()) {
      if (path.endsWith('lod-meta.json')) {
        return path;
      }
    }
    // Fall back to meta.json (single SOG)
    for (const path of files.keys()) {
      if (path.endsWith('meta.json') && !path.includes('/')) {
        return path;
      }
    }
    return null;
  }

  /**
   * Create a blob URL for a file path and track it for cleanup.
   */
  private createBlobUrl(path: string): string {
    if (this.objectUrls.has(path)) {
      return this.objectUrls.get(path)!;
    }

    const fileData = this.bundleFiles?.get(path);
    if (!fileData) {
      throw new Error(`File not found in bundle: ${path}`);
    }

    const blobPart = new Uint8Array(fileData).buffer;
    const blob = new Blob([blobPart], { type: this.getMimeType(path) });
    const url = URL.createObjectURL(blob);
    this.objectUrls.set(path, url);
    return url;
  }

  /**
   * Get MIME type based on file extension.
   */
  private getMimeType(path: string): string {
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.zip')) return 'application/zip';
    return 'application/octet-stream';
  }

  /**
   * Get the manifest file.
   */
  async getManifest(): Promise<unknown> {
    if (this.manifestData) {
      return this.manifestData;
    }

    const manifestPath = this.findManifestPath(this.bundleFiles || new Map());
    if (!manifestPath) {
      throw new Error('No manifest found in local bundle');
    }

    const data = this.bundleFiles?.get(manifestPath);
    if (!data) {
      throw new Error('Manifest file is empty');
    }

    this.manifestData = JSON.parse(new TextDecoder().decode(data));
    return this.manifestData;
  }

  /**
   * Fetch a chunk by path.
   */
  async fetchChunk(path: string): Promise<StorageFetchResponse> {
    if (this.bundleFiles) {
      const data = this.bundleFiles.get(path);
      if (!data) {
        throw new Error(`Chunk not found: ${path}`);
      }
      return {
        data,
        contentType: this.getMimeType(path),
      };
    }

    // If not extracted as zip, attempt HTTP fetch
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
    if (this.bundleFiles?.has(path)) {
      // Return blob URL if we have it in memory
      if (this.objectUrls.has(path)) {
        return this.objectUrls.get(path)!;
      }
      // Create and cache blob URL
      return this.createBlobUrl(path);
    }

    // For remote URLs, construct the full URL
    const baseUrl = this.metadata.baseUrl || '';
    return new URL(path, baseUrl).href;
  }

  /**
   * Extract the entire bundle as a map.
   */
  async extractBundle(): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
    return this.bundleFiles || undefined;
  }

  /**
   * Get storage info.
   */
  async getInfo(): Promise<StorageInfo> {
    let totalBytes = 0;
    if (this.bundleFiles) {
      for (const data of this.bundleFiles.values()) {
        totalBytes += data.length;
      }
    }

    return {
      type: 'local',
      totalBytes,
      chunkCount: this.bundleFiles?.size,
    };
  }

  /**
   * Fetch a URL via HTTP.
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
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
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
   * Dispose and clean up resources.
   */
  dispose(): void {
    for (const url of this.objectUrls.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.objectUrls.clear();
    this.bundleFiles = null;
    this.manifestData = null;
  }
}
