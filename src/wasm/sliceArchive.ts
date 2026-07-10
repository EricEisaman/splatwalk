/**
 * `SliceArchive` — the single, ergonomic surface for a finished streamed-SOG
 * slice. It wraps the universal path-keyed file map (see {@link SliceResult})
 * and exposes the three ways the SplatWalk demos consume a slice:
 *
 * 1. **Download** — {@link SliceArchive.download} / {@link SliceArchive.toZipBlob}
 *    produce a store-only `.zip` whose internal layout matches a hostable,
 *    streamable directory (`lod-meta.json`, `lodN/chunkM/...`).
 * 2. **In-app streaming preview** — {@link SliceArchive.createBlobDirectory}
 *    returns a `path -> blob:` resolver plus the manifest URL, so a URL-based
 *    loader can stream chunks straight from memory (no Service Worker, no
 *    network). This is the seam the GS-streaming integration plugs into.
 * 3. **Production streaming** — the unzipped bundle is hosted on any static
 *    host/CDN and streamed by `lod-meta.json` URL; no app code required.
 */

import { zipStore } from './zip';
import type { SliceResult } from './sogTypes';
import { assertStreamedSogFidelity } from './sogTypes';

/** A live object-URL view of an archive. Call {@link BlobDirectory.dispose}
 *  when done to revoke every URL and free memory. */
export interface BlobDirectory {
  /** Absolute `blob:` URL of the top-level manifest (`lod-meta.json`). */
  readonly rootUrl: string;
  /** Resolve any bundle-relative path to its `blob:` URL, or `undefined`. */
  resolve(path: string): string | undefined;
  /** Revoke all created object URLs. */
  dispose(): void;
}

export class SliceArchive {
  public constructor(
    private readonly result: SliceResult,
    options: { streamed?: boolean } = {},
  ) {
    if (options.streamed) {
      assertStreamedSogFidelity(this.manifest);
    }
  }

  /** All bundle files keyed by bundle-relative path. */
  public get files(): ReadonlyMap<string, Uint8Array> {
    return this.result.files;
  }

  /** Bundle-relative path of the top-level manifest. */
  public get manifestPath(): string {
    return this.result.lodMetaPath;
  }

  public get splatCount(): number {
    return this.result.splatCount;
  }

  public get chunkCount(): number {
    return this.result.chunkCount;
  }

  /** Number of files in the bundle (manifest + chunk metas + WebP planes). */
  public get fileCount(): number {
    return this.result.files.size;
  }

  /** Total uncompressed size of all bundle files, in bytes. */
  public get byteLength(): number {
    let total = 0;
    for (const bytes of this.result.files.values()) total += bytes.length;
    return total;
  }

  /** The parsed top-level manifest (`lod-meta.json` or single SOG `meta.json`). */
  public get manifest(): unknown {
    const bytes = this.result.files.get(this.result.lodMetaPath);
    if (!bytes) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** Build a store-only `.zip` of the whole bundle. */
  public toZipBlob(): Blob {
    return new Blob([zipStore(this.result.files) as BlobPart], { type: 'application/zip' });
  }

  /**
   * Trigger a browser download of the bundle as a `.zip`.
   * @param filename download name (`.zip` appended if missing)
   */
  public download(filename = 'splatwalk-sog'): void {
    const name = filename.endsWith('.zip') ? filename : `${filename}.zip`;
    const url = URL.createObjectURL(this.toZipBlob());
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      // Defer revoke so the click-initiated download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  /**
   * Mount the bundle as an in-memory object-URL directory for streaming preview.
   * Returns a resolver from bundle-relative path to `blob:` URL plus the
   * manifest URL. Remember to {@link BlobDirectory.dispose} when finished.
   */
  public createBlobDirectory(): BlobDirectory {
    const urls = new Map<string, string>();
    for (const [path, bytes] of this.result.files) {
      const type = path.endsWith('.json')
        ? 'application/json'
        : path.endsWith('.webp')
          ? 'image/webp'
          : 'application/octet-stream';
      urls.set(path, URL.createObjectURL(new Blob([bytes as BlobPart], { type })));
    }
    const rootUrl = urls.get(this.result.lodMetaPath) ?? '';
    return {
      rootUrl,
      resolve: (path: string): string | undefined => urls.get(normalizePath(path)),
      dispose: (): void => {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
      },
    };
  }
}

/** Normalize `./a/../b` style relative paths to canonical bundle keys. */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
