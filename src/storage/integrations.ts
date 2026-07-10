/**
 * Integration tests and practical examples for the storage adapter system.
 * 
 * These demonstrate real-world usage patterns and can serve as integration tests.
 */

import type { StorageAdapter } from './types';

/**
 * Simulated GPU splat rendering context.
 * In production, this would interact with actual GPU resources (WebGPU/WebGL2).
 */
interface GPUSplatContext {
  uploadSplats(data: Uint8Array, format: string): Promise<void>;
  cullSplats(count: number): Promise<void>;
  renderFrame(): Promise<void>;
}

/**
 * Streaming SOG LOD loader - mimics the supersplat streaming pattern.
 */
export class StreamingSOGLoader {
  private manifestCache: unknown | null = null;
  private loadedChunks = new Map<string, Uint8Array>();
  private loadingPromises = new Map<string, Promise<Uint8Array>>();

  public constructor(
    private adapter: StorageAdapter,
    private gpuContext: GPUSplatContext
  ) {}

  /**
   * Initialize and fetch the lowest LOD first (coarsest to finest).
   */
  async initialize(): Promise<void> {
    console.log('Initializing streaming SOG loader...');

    // Step 1: Fetch manifest
    this.manifestCache = await this.adapter.getManifest();
    console.log('Manifest loaded:', this.manifestCache);

    // Step 2: Load lowest LOD chunks
    const lowestLod = this.getLowestLodChunks();
    await this.loadChunks(lowestLod);
    console.log(`Loaded ${lowestLod.length} chunks from LOD 0`);

    // Step 3: Upload to GPU
    await this.uploadCurrentLodToGPU();
    console.log('LOD 0 uploaded to GPU');

    // Step 4: Start background loading of higher LODs
    this.backgroundLoadHigherLods();
  }

  /**
   * Get chunk paths for the lowest LOD level.
   */
  private getLowestLodChunks(): string[] {
    const manifest = this.manifestCache as any;
    if (!manifest?.lods?.[0]?.chunks) {
      return [];
    }
    return manifest.lods[0].chunks;
  }

  /**
   * Load multiple chunks in parallel.
   */
  private async loadChunks(paths: string[]): Promise<void> {
    const responses = await this.adapter.fetchChunks(paths);

    for (let i = 0; i < paths.length; i++) {
      this.loadedChunks.set(paths[i], responses[i].data);
    }
  }

  /**
   * Upload current LOD chunks to GPU.
   * In production, this would decode WebP, dequantize, and upload buffers.
   */
  private async uploadCurrentLodToGPU(): Promise<void> {
    const chunks = Array.from(this.loadedChunks.values());
    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);

    // Simulate concatenating chunks (in reality, each would be decoded/dequantized)
    for (const chunk of chunks) {
      await this.gpuContext.uploadSplats(chunk, 'webp');
    }

    console.log(`Uploaded ${totalBytes} bytes to GPU`);
  }

  /**
   * Background load higher LODs while streaming the current level.
   */
  private backgroundLoadHigherLods(): void {
    const manifest = this.manifestCache as any;
    if (!manifest?.lods) return;

    // Load LODs in background (LOD 1, 2, 3, ...)
    for (let lodIdx = 1; lodIdx < manifest.lods.length; lodIdx++) {
      setTimeout(async () => {
        console.log(`Loading higher LOD ${lodIdx} in background...`);
        const chunks = manifest.lods[lodIdx]?.chunks || [];
        const unloadedChunks = chunks.filter(
          (path: string) => !this.loadedChunks.has(path)
        );

        if (unloadedChunks.length > 0) {
          await this.loadChunks(unloadedChunks);
          console.log(`LOD ${lodIdx}: Loaded ${unloadedChunks.length} chunks`);
        }
      }, 100 * lodIdx); // Stagger loading
    }
  }

  /**
   * Stream a specific chunk on demand.
   */
  async streamChunk(path: string): Promise<Uint8Array> {
    // Check cache first
    if (this.loadedChunks.has(path)) {
      return this.loadedChunks.get(path)!;
    }

    // Avoid duplicate fetches
    if (this.loadingPromises.has(path)) {
      return this.loadingPromises.get(path)!;
    }

    // Fetch chunk
    const promise = (async () => {
      const response = await this.adapter.fetchChunk(path);
      this.loadedChunks.set(path, response.data);
      this.loadingPromises.delete(path);
      return response.data;
    })();

    this.loadingPromises.set(path, promise);
    return promise;
  }

  /**
   * Render current frame using GPU.
   */
  async renderFrame(): Promise<void> {
    await this.gpuContext.renderFrame();
  }

  /**
   * Cleanup resources.
   */
  dispose(): void {
    this.loadedChunks.clear();
    this.loadingPromises.clear();
    this.manifestCache = null;
  }
}

/**
 * Example: Initialize streaming for a scene.
 */
export async function exampleStreamingIntegration(
  adapter: StorageAdapter,
  gpuContext: GPUSplatContext
): Promise<void> {
  const loader = new StreamingSOGLoader(adapter, gpuContext);

  try {
    // Initialize and load lowest LOD
    await loader.initialize();

    // Render frames (in real app, in animation loop)
    for (let frame = 0; frame < 3; frame++) {
      await loader.renderFrame();
      console.log(`Rendered frame ${frame}`);
    }

    // On-demand streaming (e.g., user zooms in, needs higher detail)
    const highDetailChunks = await adapter.getManifest()
      .then((m: any) => m.lods?.[2]?.chunks || []);

    console.log(`Streaming ${highDetailChunks.length} high-detail chunks...`);
    for (const chunk of highDetailChunks.slice(0, 3)) {
      const data = await loader.streamChunk(chunk);
      console.log(`Streamed chunk: ${chunk} (${data.length} bytes)`);
    }
  } finally {
    loader.dispose();
  }
}

/**
 * Example: Detect and report available backends.
 */
export function exampleDetectAvailableBackends(): void {
  const platforms: string[] = [];

  if (typeof process !== 'undefined') {
    if (process.env.GITHUB_ACTIONS === 'true') platforms.push('GitHub Actions');
    if (process.env.RENDER === 'true') platforms.push('Render.com');
    if (process.env.NETLIFY === 'true') platforms.push('Netlify');
  }

  if (typeof window !== 'undefined') {
    platforms.push('Browser (Local/Manual)');
  }

  console.log('Available deployment platforms:');
  platforms.forEach((p) => console.log(`  • ${p}`));
}

/**
 * Example: Storage adapter with progress tracking.
 */
export class ProgressTrackingAdapter {
  private totalChunks = 0;
  private loadedChunks = 0;
  private progressCallback: ((progress: number) => void) | null = null;

  public constructor(private adapter: StorageAdapter) {}

  /**
   * Set progress callback (0-1).
   */
  setProgressCallback(callback: (progress: number) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Fetch chunks with progress tracking.
   */
  async fetchChunkWithProgress(path: string): Promise<Uint8Array> {
    const response = await this.adapter.fetchChunk(path);
    this.loadedChunks++;

    if (this.progressCallback && this.totalChunks > 0) {
      const progress = this.loadedChunks / this.totalChunks;
      this.progressCallback(progress);
    }

    return response.data;
  }

  /**
   * Fetch all chunks with progress tracking.
   */
  async fetchAllChunksWithProgress(paths: string[]): Promise<Uint8Array[]> {
    this.totalChunks = paths.length;
    this.loadedChunks = 0;

    const results: Uint8Array[] = [];
    for (const path of paths) {
      const data = await this.fetchChunkWithProgress(path);
      results.push(data);
    }

    return results;
  }
}

/**
 * Example: Error handling and retry logic.
 */
export class ResilientStorageAdapter {
  private maxRetries = 3;
  private retryDelayMs = 1000;

  public constructor(private adapter: StorageAdapter) {}

  /**
   * Fetch chunk with automatic retries.
   */
  async fetchChunkWithRetry(path: string): Promise<Uint8Array> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.adapter.fetchChunk(path);
        return response.data;
      } catch (error) {
        lastError = error as Error;
        console.warn(
          `Fetch failed for ${path} (attempt ${attempt + 1}/${this.maxRetries}):`,
          lastError.message
        );

        if (attempt < this.maxRetries - 1) {
          // Exponential backoff
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Failed to fetch ${path} after ${this.maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Fetch multiple chunks with retries.
   */
  async fetchChunksWithRetry(paths: string[]): Promise<Uint8Array[]> {
    return Promise.all(
      paths.map((path) => this.fetchChunkWithRetry(path))
    );
  }
}

/**
 * Example: Bandwidth-aware streaming.
 */
export class BandwidthAwareAdapter {
  private estimatedBandwidth = 0; // bytes per millisecond

  public constructor(private adapter: StorageAdapter) {
    this.estimateBandwidth();
  }

  /**
   * Estimate available bandwidth.
   */
  private async estimateBandwidth(): Promise<void> {
    try {
      const manifest = await this.adapter.getManifest();
      const testPath = (manifest as any).lods?.[0]?.chunks?.[0];

      if (!testPath) return;

      const startTime = performance.now();
      const response = await this.adapter.fetchChunk(testPath);
      const endTime = performance.now();

      const bytes = response.data.length;
      const ms = endTime - startTime;
      this.estimatedBandwidth = bytes / ms;

      console.log(
        `Estimated bandwidth: ${(this.estimatedBandwidth * 1000 / 1024 / 1024).toFixed(2)} MB/s`
      );
    } catch (error) {
      console.warn('Bandwidth estimation failed:', error);
    }
  }

  /**
   * Fetch chunks optimized for available bandwidth.
   */
  async fetchChunksOptimized(paths: string[]): Promise<Uint8Array[]> {
    // For low bandwidth, load serially; for high bandwidth, load in parallel
    const parallelThreshold = 1; // MB/s
    const bandwidthMbps = (this.estimatedBandwidth * 1000 / 1024 / 1024);

    if (bandwidthMbps < parallelThreshold) {
      // Serial loading for slow connections
      console.log('Low bandwidth: loading serially');
      const results: Uint8Array[] = [];
      for (const path of paths) {
        const response = await this.adapter.fetchChunk(path);
        results.push(response.data);
      }
      return results;
    } else {
      // Parallel loading for fast connections
      console.log('High bandwidth: loading in parallel');
      return this.adapter.fetchChunks(paths).then((rs) => rs.map((r) => r.data));
    }
  }
}
