/**
 * Materialize nav-grade PLY bytes from a streamed SOG bundle (lod-meta + chunks).
 *
 * FastNav / collision WASM consume PLY (or PLY-normalized) bytes — not lod-meta.
 * This bridge selects a LOD, decodes chunk SOGs via Babylon ParseSogMeta into
 * antimatter15 `.splat` records, then converts with WASM `splatToPly`.
 *
 * If in-app decode fails for an asset, convert offline with PlayCanvas
 * splat-transform (streamed SOG / .sog → .ply) and load that PLY into FastNav:
 * https://github.com/playcanvas/splat-transform
 */

import type { Scene } from '@babylonjs/core/scene';
import type { ISOGLODMetadata } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';
import { ParseSogMeta } from '@babylonjs/loaders/SPLAT/sog.pure';

import { splatwalk } from '@/wasm/bridge';

const META_BASENAME = 'meta.json';
const SPLAT_TRANSFORM_HINT =
  'If decode fails, convert the streamed SOG to PLY with splat-transform ' +
  '(https://github.com/playcanvas/splat-transform) and run FastNav on that PLY.';

export type LodIndexOption = 'coarsest' | 'finest' | 'nav' | number;

export interface MaterializeNavSourceOptions {
  readonly lodIndex?: LodIndexOption;
  /** Stop refining LODs once at least this many splats are decoded (nav preset). */
  readonly minSplats?: number;
  readonly maxSplats?: number;
  readonly onProgress?: (message: string) => void;
}

/** Default minimum splat count before Fast Nav / collision materialize stops refining LODs. */
export const DEFAULT_NAV_MIN_SPLATS = 50_000;

/** Soft cap so finest-LOD CDN scenes stay interactive. */
export const DEFAULT_NAV_MAX_SPLATS = 250_000;

export interface MaterializeNavSourceResult {
  readonly bounds: {
    readonly max: [number, number, number];
    readonly min: [number, number, number];
  };
  readonly lodIndexUsed: number;
  readonly plyBytes: Uint8Array;
  readonly splatCount: number;
}

export type StreamedBundleAccess =
  | { readonly kind: 'memory'; readonly files: ReadonlyMap<string, Uint8Array> }
  | { readonly kind: 'cdn'; readonly rootUrl: string };

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

const directoryOf = (path: string): string => {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
};

const joinPath = (directory: string, filename: string): string =>
  directory ? `${directory}/${filename}` : filename;

/**
 * Parse LOD index from a streamed chunk path like `3_0/meta.json` → 3.
 */
export const lodIndexFromChunkPath = (path: string): number | null => {
  const base = normalizePath(path).split('/')[0] ?? '';
  const match = /^(\d+)_\d+$/.exec(base);
  if (!match) {
    return null;
  }
  return Number(match[1]);
};

export const resolveLodIndex = (
  metadata: ISOGLODMetadata,
  lodIndex: LodIndexOption = 'nav'
): number => {
  const maxLod = Math.max(0, metadata.lodLevels - 1);
  if (lodIndex === 'coarsest') {
    return maxLod;
  }
  if (lodIndex === 'finest') {
    return 0;
  }
  // Mid detail: denser than coarsest, cheaper than full finest.
  if (lodIndex === 'nav') {
    return Math.max(0, Math.floor(maxLod * 0.5));
  }
  if (!Number.isFinite(lodIndex) || lodIndex < 0 || lodIndex > maxLod) {
    throw new Error(`lodIndex must be between 0 and ${maxLod} (coarsest).`);
  }
  return lodIndex;
};

/**
 * Chunk meta.json paths for a given LOD level.
 */
export const selectChunkMetaPathsForLod = (
  metadata: ISOGLODMetadata,
  lodIndex: number
): string[] => {
  const paths = metadata.filenames
    .map(normalizePath)
    .filter((path) => path.endsWith(`/${META_BASENAME}`) || path === META_BASENAME)
    .filter((path) => lodIndexFromChunkPath(path) === lodIndex);
  if (paths.length === 0 && metadata.filenames.length === 1) {
    const only = normalizePath(metadata.filenames[0]!);
    if (only === META_BASENAME || only.endsWith(`/${META_BASENAME}`)) {
      return [only];
    }
  }
  return paths;
};

const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

const readBundleFile = async (
  access: StreamedBundleAccess,
  path: string
): Promise<Uint8Array> => {
  const normalized = normalizePath(path);
  if (access.kind === 'memory') {
    const data = access.files.get(normalized);
    if (!data) {
      throw new Error(`Bundle missing path: ${normalized}`);
    }
    return data;
  }
  return fetchBytes(new URL(normalized, access.rootUrl).href);
};

interface SogRootDataLite {
  readonly means?: { readonly files?: readonly string[] };
  readonly scales?: { readonly files?: readonly string[] };
  readonly quats?: { readonly files?: readonly string[] };
  readonly sh0?: { readonly files?: readonly string[] };
  readonly shN?: { readonly files?: readonly string[] };
}

const collectPlaneFilenames = (meta: SogRootDataLite): string[] => {
  const names = new Set<string>();
  for (const group of [meta.means, meta.scales, meta.quats, meta.sh0, meta.shN]) {
    for (const file of group?.files ?? []) {
      names.add(file);
    }
  }
  return [...names];
};

/**
 * Build a ParseSogMeta-compatible Map (basename keys) for one chunk directory.
 */
const loadChunkFileMap = async (
  access: StreamedBundleAccess,
  metaPath: string
): Promise<Map<string, Uint8Array>> => {
  const dir = directoryOf(metaPath);
  const metaBytes = await readBundleFile(access, metaPath);
  const metaJson = JSON.parse(new TextDecoder().decode(metaBytes)) as SogRootDataLite;
  const map = new Map<string, Uint8Array>();
  map.set(META_BASENAME, metaBytes);

  for (const plane of collectPlaneFilenames(metaJson)) {
    const bundlePath = joinPath(dir, plane);
    map.set(plane, await readBundleFile(access, bundlePath));
  }
  return map;
};

const concatArrayBuffers = (parts: readonly ArrayBuffer[]): Uint8Array => {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out;
};

/**
 * Keep `takeCount` rows from a `.splat` buffer with even stride (not a prefix).
 * Prefix truncation biases toward whatever order the encoder wrote — often one
 * corner of a chunk — which shrinks outdoor floor coverage the same way as
 * stopping after early octree chunks.
 */
const subsampleSplatRows = (
  part: ArrayBuffer,
  partCount: number,
  takeCount: number,
  rowBytes: number
): ArrayBuffer => {
  if (takeCount >= partCount || takeCount <= 0) {
    return part.slice(0, Math.max(0, takeCount) * rowBytes);
  }
  const src = new Uint8Array(part);
  const out = new Uint8Array(takeCount * rowBytes);
  for (let i = 0; i < takeCount; i++) {
    const srcIndex = Math.floor((i * partCount) / takeCount);
    const srcOff = srcIndex * rowBytes;
    const dstOff = i * rowBytes;
    out.set(src.subarray(srcOff, srcOff + rowBytes), dstOff);
  }
  return out.buffer;
};

const boundsFromSplatBuffer = (
  splatBuffer: Uint8Array
): { max: [number, number, number]; min: [number, number, number] } => {
  const view = new Float32Array(
    splatBuffer.buffer,
    splatBuffer.byteOffset,
    Math.floor(splatBuffer.byteLength / 4)
  );
  const strideFloats = 8;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const count = Math.floor(view.length / strideFloats);
  for (let i = 0; i < count; i++) {
    const base = i * strideFloats;
    const x = view[base]!;
    const y = view[base + 1]!;
    const z = view[base + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
};

/**
 * Decode one LOD level into antimatter15 `.splat` bytes (not yet PLY).
 *
 * When `maxSplats` is set, the budget is spread across every chunk at this LOD
 * (remaining / chunksLeft each step). Stopping after the first N chunks would
 * bias the nav source to a spatial subset of the octree — a tiny local floor on
 * large outdoor scenes while the streamed visual still shows the full park.
 */
const decodeLodToSplatBuffer = async (params: {
  access: StreamedBundleAccess;
  chunkMetas: readonly string[];
  log: (message: string) => void;
  maxSplats?: number;
  scene: Scene;
}): Promise<{ bounds: MaterializeNavSourceResult['bounds']; splatBytes: Uint8Array; splatCount: number }> => {
  const { access, chunkMetas, log, scene } = params;
  const splatParts: ArrayBuffer[] = [];
  let splatCount = 0;
  const rowBytes = 32;
  const maxSplats = params.maxSplats;

  for (let i = 0; i < chunkMetas.length; i++) {
    const metaPath = chunkMetas[i]!;
    const chunksLeft = chunkMetas.length - i;
    const remaining =
      maxSplats === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxSplats - splatCount);
    if (remaining <= 0) {
      log(
        `Hit maxSplats=${maxSplats} after ${i}/${chunkMetas.length} chunks (${splatCount} splats).`
      );
      break;
    }
    // Fair share of whatever budget remains so later octants still contribute.
    const chunkBudget = Math.max(1, Math.ceil(remaining / chunksLeft));

    log(`Decoding chunk ${i + 1}/${chunkMetas.length}: ${metaPath} (budget ≤ ${chunkBudget} splats)`);
    try {
      const fileMap = await loadChunkFileMap(access, metaPath);
      const parsed = await ParseSogMeta(fileMap, '', scene);
      const part = parsed.data;
      const partCount = Math.floor(part.byteLength / rowBytes);
      const take = Math.min(partCount, chunkBudget, remaining);
      if (take <= 0) {
        continue;
      }
      if (take < partCount) {
        splatParts.push(subsampleSplatRows(part, partCount, take, rowBytes));
        log(
          `Chunk ${metaPath}: kept ${take}/${partCount} splats (strided) for spatial coverage under maxSplats.`
        );
      } else {
        splatParts.push(part);
      }
      splatCount += take;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed decoding ${metaPath}: ${detail}. ${SPLAT_TRANSFORM_HINT}`);
    }
  }

  if (splatCount === 0 || splatParts.length === 0) {
    throw new Error(`No splats decoded for nav. ${SPLAT_TRANSFORM_HINT}`);
  }

  const splatBytes = concatArrayBuffers(splatParts);
  const bounds = boundsFromSplatBuffer(splatBytes);
  const extentX = bounds.max[0] - bounds.min[0];
  const extentY = bounds.max[1] - bounds.min[1];
  const extentZ = bounds.max[2] - bounds.min[2];
  log(
    `Nav source coverage: ${splatCount} splats from ${splatParts.length} chunk slice(s); ` +
      `AABB ${extentX.toFixed(1)}×${extentY.toFixed(1)}×${extentZ.toFixed(1)} m`
  );
  return {
    bounds,
    splatBytes,
    splatCount,
  };
};

/**
 * Decode a streamed SOG LOD into PLY bytes for collision / FastNav.
 *
 * Default `lodIndex: 'nav'` starts at mid LOD and refines toward finest until
 * {@link DEFAULT_NAV_MIN_SPLATS} (or `minSplats`) so floor extraction has enough
 * density — coarsest-only is too sparse for Fast Nav on typical streamed scenes.
 */
export const materializeNavSourceFromStreamedSog = async (params: {
  access: StreamedBundleAccess;
  metadata: ISOGLODMetadata;
  options?: MaterializeNavSourceOptions;
  scene: Scene;
}): Promise<MaterializeNavSourceResult> => {
  const { access, metadata, scene } = params;
  const options = params.options ?? {};
  const log = options.onProgress ?? ((): void => undefined);

  if (!metadata.lodLevels || !Array.isArray(metadata.filenames) || !metadata.tree) {
    throw new Error(
      `Invalid lod-meta for nav materialize. ${SPLAT_TRANSFORM_HINT}`
    );
  }

  await splatwalk.init();

  const maxLod = Math.max(0, metadata.lodLevels - 1);
  const lodOption = options.lodIndex ?? 'nav';
  const startLod = resolveLodIndex(metadata, lodOption);
  const refineTowardFinest = lodOption === 'nav' || lodOption === 'coarsest';
  const minSplats = options.minSplats ?? (refineTowardFinest ? DEFAULT_NAV_MIN_SPLATS : 0);
  const maxSplats = options.maxSplats ?? DEFAULT_NAV_MAX_SPLATS;

  let bestSplat: {
    bounds: MaterializeNavSourceResult['bounds'];
    lodIndexUsed: number;
    splatBytes: Uint8Array;
    splatCount: number;
  } | null = null;

  const lodSequence: number[] = refineTowardFinest
    ? Array.from({ length: startLod + 1 }, (_, i) => startLod - i)
    : [startLod];

  for (const lod of lodSequence) {
    const chunkMetas = selectChunkMetaPathsForLod(metadata, lod);
    if (chunkMetas.length === 0) {
      continue;
    }

    log(
      `Materializing nav source from LOD ${lod}/${maxLod} (${chunkMetas.length} chunks` +
        (minSplats > 0 ? `, target ≥ ${minSplats} splats` : '') +
        ')…'
    );

    const decoded = await decodeLodToSplatBuffer({
      access,
      chunkMetas,
      log,
      maxSplats,
      scene,
    });
    bestSplat = { ...decoded, lodIndexUsed: lod };
    log(`LOD ${lod}: ${decoded.splatCount} splats`);

    if (decoded.splatCount >= minSplats) {
      break;
    }
    if (refineTowardFinest && lod > 0) {
      log(`LOD ${lod} below minSplats=${minSplats}; refining to finer LOD…`);
    }
  }

  if (!bestSplat) {
    throw new Error(`No chunk metas found for nav materialize. ${SPLAT_TRANSFORM_HINT}`);
  }

  log(`Converting ${bestSplat.splatCount} splats to PLY…`);
  const plyBytes = await splatwalk.splatToPly(bestSplat.splatBytes);
  log(`Nav PLY ready (${(plyBytes.byteLength / (1024 * 1024)).toFixed(2)} MB).`);

  return {
    bounds: bestSplat.bounds,
    lodIndexUsed: bestSplat.lodIndexUsed,
    plyBytes,
    splatCount: bestSplat.splatCount,
  };
};

/**
 * Derive CDN root URL (directory containing lod-meta.json).
 */
export const deriveLodMetaRootUrl = (lodMetaUrl: string): string => {
  const url = new URL(lodMetaUrl);
  const path = url.pathname;
  const slash = path.lastIndexOf('/');
  url.pathname = slash >= 0 ? path.slice(0, slash + 1) : '/';
  url.search = '';
  url.hash = '';
  return url.href;
};
