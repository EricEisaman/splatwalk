/**
 * Load PlayCanvas / Babylon streamed SOG (lod-meta.json) from a CDN URL or a
 * local SplatWalk store-only zip, using Babylon 9.16 GaussianSplattingStream.
 */

import type { AbstractMesh, Scene } from '@babylonjs/core';
import { AppendSceneAsync } from '@babylonjs/core/Loading/sceneLoader';
// Side-effect: registers DefaultLoadingScreen for AppendSceneAsync
import '@babylonjs/core/Loading/loadingScreen';
import {
  GaussianSplattingStream,
  type ISOGLODMetadata,
} from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

import { createStorageAdapter } from './factory';

const LOD_META_BASENAME = 'lod-meta.json';
const STORE_COMPRESSION_METHOD = 0;

export interface SogLodManifestSummary {
  readonly environment?: string;
  readonly filenameCount: number;
  readonly filenamesSample: readonly string[];
  readonly lodLevels: number;
}

export interface LoadCdnLodMetaResult {
  readonly manifest: ISOGLODMetadata;
  readonly summary: SogLodManifestSummary;
}

export interface LoadLocalSogZipResult {
  readonly dispose: () => void;
  readonly manifest: ISOGLODMetadata;
  readonly stream: GaussianSplattingStream;
  readonly summary: SogLodManifestSummary;
  readonly fileCount: number;
}

interface BjsDownloadManagerView {
  loadFileAsync(url: string, groupId?: string | number): Promise<ArrayBuffer>;
}

interface BjsNativeStreamDownloadView {
  _downloadManager?: BjsDownloadManagerView;
}

const basenameFromUrl = (url: string): string => {
  const withoutQuery = url.split('?')[0] ?? url;
  const lastSlash = withoutQuery.lastIndexOf('/');
  return decodeURIComponent(lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery);
};

const directoryOf = (path: string | undefined): string => {
  if (!path) {
    return '';
  }
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
};

const joinSogPath = (directory: string, filename: string): string =>
  directory ? `${directory}/${filename}` : filename;

const normalizePath = (path: string): string => {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
};

/**
 * Validate a user-provided CDN lod-meta.json URL.
 */
export const assertLodMetaCdnUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Paste a full https:// …/lod-meta.json URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL. Paste a full https:// …/lod-meta.json link.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('URL must use http or https.');
  }
  if (!parsed.pathname.toLowerCase().endsWith(LOD_META_BASENAME)) {
    throw new Error('URL must point directly to lod-meta.json.');
  }
  return parsed.href;
};

export const isSogLodMetadata = (data: unknown): data is ISOGLODMetadata =>
  GaussianSplattingStream.IsLODMetadata(data);

export const assertNotInterimLodMeta = (data: unknown): void => {
  if (!data || typeof data !== 'object') {
    return;
  }
  const record = data as Record<string, unknown>;
  const hasInterim =
    (Array.isArray(record.levels) || Array.isArray(record.lods)) &&
    !Array.isArray(record.filenames);
  if (hasInterim) {
    throw new Error(
      'This lod-meta.json uses an older interim schema (levels/chunks). Re-export with SplatWalk streamed SOD LOD so the manifest includes lodLevels, filenames, and tree.'
    );
  }
};

export const summarizeLodMeta = (manifest: ISOGLODMetadata): SogLodManifestSummary => ({
  environment: manifest.environment,
  filenameCount: manifest.filenames.length,
  filenamesSample: manifest.filenames.slice(0, 8),
  lodLevels: manifest.lodLevels,
});

/**
 * Strip a shared zip root folder so keys match lod-meta filenames
 * (e.g. `bundle/lod-meta.json` → `lod-meta.json`).
 */
export const stripCommonZipRoot = (
  files: ReadonlyMap<string, Uint8Array>
): Map<string, Uint8Array> => {
  const normalizedEntries: Array<[string, Uint8Array]> = [];
  for (const [key, value] of files) {
    const normalized = normalizePath(key);
    if (!normalized || normalized.endsWith('/')) {
      continue;
    }
    normalizedEntries.push([normalized, value]);
  }

  const lodMetaPath = normalizedEntries
    .map(([path]) => path)
    .find((path) => path === LOD_META_BASENAME || path.endsWith(`/${LOD_META_BASENAME}`));

  let prefix = '';
  if (lodMetaPath && lodMetaPath !== LOD_META_BASENAME) {
    prefix = lodMetaPath.slice(0, lodMetaPath.length - LOD_META_BASENAME.length);
  }

  const stripped = new Map<string, Uint8Array>();
  for (const [path, value] of normalizedEntries) {
    stripped.set(prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path, value);
  }
  return stripped;
};

const mimeForPath = (path: string): string => {
  if (path.endsWith('.json')) {
    return 'application/json';
  }
  if (path.endsWith('.webp')) {
    return 'image/webp';
  }
  if (path.endsWith('.png')) {
    return 'image/png';
  }
  if (path.endsWith('.sog') || path.endsWith('.zip')) {
    return 'application/octet-stream';
  }
  return 'application/octet-stream';
};

const buildBlobUrlMap = (files: ReadonlyMap<string, Uint8Array>): Map<string, string> => {
  const urls = new Map<string, string>();
  for (const [path, bytes] of files) {
    const copy = new Uint8Array(bytes);
    urls.set(path, URL.createObjectURL(new Blob([copy as BlobPart], { type: mimeForPath(path) })));
  }
  return urls;
};

const rewriteMetadataUrls = (
  metadata: ISOGLODMetadata,
  fileUrls: ReadonlyMap<string, string>
): ISOGLODMetadata => {
  const resolve = (relativePath: string): string => {
    const normalized = normalizePath(relativePath);
    const mapped = fileUrls.get(normalized);
    if (!mapped) {
      throw new Error(`Bundle is missing path referenced by lod-meta: ${normalized}`);
    }
    return mapped;
  };

  return {
    ...metadata,
    filenames: metadata.filenames.map(resolve),
    environment: metadata.environment ? resolve(metadata.environment) : undefined,
  };
};

/**
 * Patch GaussianSplattingStream's download manager so WebP planes resolve from
 * blob URLs when meta paths are absolute blob: URLs (no directory prefix).
 */
export const installSogDownloadResolver = (
  stream: GaussianSplattingStream,
  sourceFilenames: readonly string[],
  fileUrls: ReadonlyMap<string, string>
): void => {
  if (fileUrls.size === 0) {
    return;
  }
  const downloadManager = (stream as unknown as BjsNativeStreamDownloadView)._downloadManager;
  if (!downloadManager) {
    return;
  }

  const urlRecord: Record<string, string> = {};
  for (const [path, url] of fileUrls) {
    urlRecord[path] = url;
    urlRecord[url] = url;
  }

  const originalLoadFileAsync = downloadManager.loadFileAsync.bind(downloadManager);
  downloadManager.loadFileAsync = async (url, groupId) => {
    const exactMapped = urlRecord[url];
    if (exactMapped) {
      return originalLoadFileAsync(exactMapped, groupId);
    }
    if (typeof groupId === 'number') {
      const sourceDirectory = directoryOf(sourceFilenames[groupId]);
      const basename = basenameFromUrl(url);
      const mappedUrl = urlRecord[joinSogPath(sourceDirectory, basename)];
      if (mappedUrl) {
        return originalLoadFileAsync(mappedUrl, groupId);
      }
    }
    return originalLoadFileAsync(url, groupId);
  };
};

const disposeMeshes = (meshes: readonly AbstractMesh[]): void => {
  for (const mesh of meshes) {
    mesh.dispose(false, true);
  }
};

/**
 * Load a CDN-hosted lod-meta.json stream via AppendSceneAsync (Babylon Playground pattern).
 */
export const loadCdnLodMeta = async (params: {
  lodMetaUrl: string;
  scene: Scene;
  previousMeshes?: readonly AbstractMesh[];
}): Promise<LoadCdnLodMetaResult> => {
  const lodMetaUrl = assertLodMetaCdnUrl(params.lodMetaUrl);
  if (params.previousMeshes?.length) {
    disposeMeshes(params.previousMeshes);
  }

  const response = await fetch(lodMetaUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch lod-meta.json (${response.status}).`);
  }
  const raw: unknown = await response.json();
  assertNotInterimLodMeta(raw);
  if (!isSogLodMetadata(raw)) {
    throw new Error(
      'lod-meta.json does not match PlayCanvas/Babylon streamed SOG metadata (lodLevels, filenames, tree).'
    );
  }

  await AppendSceneAsync(lodMetaUrl, params.scene);
  return {
    manifest: raw,
    summary: summarizeLodMeta(raw),
  };
};

/**
 * Load a SplatWalk-exported store-only SOD LOD zip into a GaussianSplattingStream.
 */
export const loadLocalSogZip = async (params: {
  file: File | Blob;
  scene: Scene;
  previousMeshes?: readonly AbstractMesh[];
}): Promise<LoadLocalSogZipResult> => {
  if (params.previousMeshes?.length) {
    disposeMeshes(params.previousMeshes);
  }

  const { adapter } = await createStorageAdapter({ type: 'local', source: params.file });
  if (!adapter.extractBundle) {
    throw new Error('Local adapter does not support zip extraction.');
  }
  const extracted = await adapter.extractBundle();
  if (!extracted || extracted.size === 0) {
    throw new Error('Zip contained no files. Export a store-only SOD LOD zip from SplatWalk.');
  }

  const files = stripCommonZipRoot(extracted);
  const lodMetaBytes = files.get(LOD_META_BASENAME);
  if (!lodMetaBytes) {
    throw new Error('Zip is missing lod-meta.json at the bundle root.');
  }

  const raw: unknown = JSON.parse(new TextDecoder().decode(lodMetaBytes));
  assertNotInterimLodMeta(raw);
  if (!isSogLodMetadata(raw)) {
    throw new Error(
      'lod-meta.json does not match PlayCanvas/Babylon streamed SOG metadata (lodLevels, filenames, tree).'
    );
  }

  const blobUrls = buildBlobUrlMap(files);
  const sourceFilenames = [...raw.filenames];
  const rewritten = rewriteMetadataUrls(raw, blobUrls);

  const stream = new GaussianSplattingStream(
    'storageAdapterSogStream',
    rewritten,
    '',
    params.scene
  );
  installSogDownloadResolver(stream, sourceFilenames, blobUrls);

  return {
    dispose: () => {
      stream.dispose();
      for (const url of blobUrls.values()) {
        URL.revokeObjectURL(url);
      }
      blobUrls.clear();
      adapter.dispose();
    },
    fileCount: files.size,
    manifest: raw,
    stream,
    summary: summarizeLodMeta(raw),
  };
};

/** Exported for unit-style checks of the store-only zip contract. */
export const STORE_ONLY_ZIP_METHOD = STORE_COMPRESSION_METHOD;
