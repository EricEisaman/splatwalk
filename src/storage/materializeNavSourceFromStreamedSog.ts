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
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math';
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
  /**
   * Raw PlayCanvas / SOG coordinate AABB (same space as lod-meta `tree.bound`).
   * When set with {@link fullRegionCoverage}, only overlapping chunks at the chosen
   * LOD are decoded at full density — matching PC / SS collision on the full asset
   * within that volume instead of a budget-subsampled global slice.
   */
  readonly regionCoverage?: {
    readonly max: readonly [number, number, number];
    readonly min: readonly [number, number, number];
  };
  /** Decode every splat in {@link regionCoverage} chunks (no per-chunk subsampling). */
  readonly fullRegionCoverage?: boolean;
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

/** Axis-aligned box overlap test in raw SOG coordinates. */
export const aabbOverlaps = (
  a: { min: readonly number[]; max: readonly number[] },
  b: { min: readonly number[]; max: readonly number[] }
): boolean =>
  a.min[0]! <= b.max[0]! &&
  a.max[0]! >= b.min[0]! &&
  a.min[1]! <= b.max[1]! &&
  a.max[1]! >= b.min[1]! &&
  a.min[2]! <= b.max[2]! &&
  a.max[2]! >= b.min[2]!;

type LodMetaTreeNode = {
  readonly bound: { readonly min: number[]; readonly max: number[] };
  readonly children?: readonly LodMetaTreeNode[];
  readonly lods?: Readonly<Record<string, { readonly file: number }>>;
};

/**
 * Map a pinned world-space selection box to raw SOG coords (inverse stream mesh transform).
 * lod-meta tree bounds and decoded splat positions live in this space before WASM rotation.
 */
export const worldRegionToRawSogBounds = (
  world: { min: readonly number[]; max: readonly number[] },
  streamWorldMatrix: Matrix
): { min: [number, number, number]; max: [number, number, number] } => {
  const inv = Matrix.Invert(streamWorldMatrix);
  const xs = [world.min[0]!, world.max[0]!];
  const ys = [world.min[1]!, world.max[1]!];
  const zs = [world.min[2]!, world.max[2]!];
  let minOut: Vector3 | null = null;
  let maxOut: Vector3 | null = null;

  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const corner = Vector3.TransformCoordinates(new Vector3(x, y, z), inv);
        minOut = minOut ? Vector3.Minimize(minOut, corner) : corner.clone();
        maxOut = maxOut ? Vector3.Maximize(maxOut, corner) : corner.clone();
      }
    }
  }

  return {
    min: [minOut!.x, minOut!.y, minOut!.z],
    max: [maxOut!.x, maxOut!.y, maxOut!.z],
  };
};

/** Collect chunk meta.json paths whose lod-meta tree bounds overlap a raw SOG region. */
export const collectChunkMetaPathsOverlappingRegion = (
  metadata: ISOGLODMetadata,
  lodIndex: number,
  region: { min: readonly number[]; max: readonly number[] }
): string[] => {
  const tree = metadata.tree as LodMetaTreeNode | undefined;
  if (!tree) {
    return [];
  }

  const visit = (node: LodMetaTreeNode): string[] => {
    if (!aabbOverlaps(node.bound, region)) {
      return [];
    }
    const paths: string[] = [];
    const lodRef = node.lods?.[String(lodIndex)];
    if (lodRef !== undefined) {
      const rawPath = metadata.filenames[lodRef.file];
      if (rawPath) {
        const path = normalizePath(rawPath);
        if (path.endsWith(`/${META_BASENAME}`) || path === META_BASENAME) {
          paths.push(path);
        }
      }
    }
    for (const child of node.children ?? []) {
      paths.push(...visit(child));
    }
    return paths;
  };

  return [...new Set(visit(tree))];
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

const SPLAT_ROW_BYTES = 32;
const SPLAT_STRIDE_FLOATS = 8;

/**
 * Keep only splat rows inside a raw SOG AABB (selection region). Chunk overlap
 * materialize can otherwise include far-away splats that slow WASM and add floater solids.
 */
export const clipSplatBufferToAabb = (
  splatBuffer: Uint8Array,
  region: {
    readonly max: readonly [number, number, number];
    readonly min: readonly [number, number, number];
  },
  rowBytes = SPLAT_ROW_BYTES
): { splatBytes: Uint8Array; splatCount: number } => {
  const view = new Float32Array(
    splatBuffer.buffer,
    splatBuffer.byteOffset,
    Math.floor(splatBuffer.byteLength / 4)
  );
  const count = Math.floor(view.length / SPLAT_STRIDE_FLOATS);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const base = i * SPLAT_STRIDE_FLOATS;
    const x = view[base]!;
    const y = view[base + 1]!;
    const z = view[base + 2]!;
    if (
      x >= region.min[0] &&
      x <= region.max[0] &&
      y >= region.min[1] &&
      y <= region.max[1] &&
      z >= region.min[2] &&
      z <= region.max[2]
    ) {
      kept += 1;
    }
  }
  if (kept === count) {
    return { splatBytes: splatBuffer, splatCount: count };
  }
  const out = new Uint8Array(kept * rowBytes);
  let dst = 0;
  for (let i = 0; i < count; i++) {
    const base = i * SPLAT_STRIDE_FLOATS;
    const x = view[base]!;
    const y = view[base + 1]!;
    const z = view[base + 2]!;
    if (
      x < region.min[0] ||
      x > region.max[0] ||
      y < region.min[1] ||
      y > region.max[1] ||
      z < region.min[2] ||
      z > region.max[2]
    ) {
      continue;
    }
    const srcOff = i * rowBytes;
    out.set(splatBuffer.subarray(srcOff, srcOff + rowBytes), dst);
    dst += rowBytes;
  }
  return { splatBytes: out, splatCount: kept };
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
  fullDecodePaths?: ReadonlySet<string>;
  log: (message: string) => void;
  maxSplats?: number;
  scene: Scene;
}): Promise<{ bounds: MaterializeNavSourceResult['bounds']; splatBytes: Uint8Array; splatCount: number }> => {
  const { access, chunkMetas, log, scene } = params;
  const splatParts: ArrayBuffer[] = [];
  let splatCount = 0;
  const rowBytes = 32;
  const maxSplats = params.maxSplats;
  const fullDecodePaths = params.fullDecodePaths ?? new Set<string>();

  for (let i = 0; i < chunkMetas.length; i++) {
    const metaPath = chunkMetas[i]!;
    const decodeFull = fullDecodePaths.has(metaPath);
    const chunksLeft = chunkMetas.length - i;
    const remaining =
      decodeFull || maxSplats === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, maxSplats - splatCount);
    if (remaining <= 0) {
      log(
        `Hit maxSplats=${maxSplats} after ${i}/${chunkMetas.length} chunks (${splatCount} splats).`
      );
      break;
    }
    const chunkBudget = decodeFull
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.ceil(remaining / chunksLeft));

    log(
      `Decoding chunk ${i + 1}/${chunkMetas.length}: ${metaPath}` +
        (decodeFull ? ' (full region coverage)' : ` (budget ≤ ${chunkBudget} splats)`)
    );
    try {
      const fileMap = await loadChunkFileMap(access, metaPath);
      const parsed = await ParseSogMeta(fileMap, '', scene);
      const part = parsed.data;
      const partCount = Math.floor(part.byteLength / rowBytes);
      const take = decodeFull ? partCount : Math.min(partCount, chunkBudget, remaining);
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
        if (decodeFull) {
          log(`Chunk ${metaPath}: kept all ${partCount} splats (region coverage).`);
        }
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
  const regionCoverage = options.regionCoverage;
  const fullRegionCoverage = options.fullRegionCoverage === true && Boolean(regionCoverage);

  if (fullRegionCoverage && regionCoverage) {
    const finestLod = 0;
    const regionChunks = collectChunkMetaPathsOverlappingRegion(
      metadata,
      finestLod,
      regionCoverage
    );
    const fallbackChunks = selectChunkMetaPathsForLod(metadata, finestLod);
    const chunkMetas =
      regionChunks.length > 0 ? regionChunks : fallbackChunks;
    if (chunkMetas.length === 0) {
      throw new Error(`No chunk metas found for nav materialize. ${SPLAT_TRANSFORM_HINT}`);
    }

    log(
      `Materializing voxel nav at finest LOD with full density in ${chunkMetas.length} chunk(s)` +
        (regionChunks.length > 0
          ? ` overlapping pinned region (${regionChunks.length} via lod-meta tree).`
          : ' (region miss — using all finest chunks).')
    );

    const decoded = await decodeLodToSplatBuffer({
      access,
      chunkMetas,
      fullDecodePaths: new Set(chunkMetas),
      log,
      maxSplats: undefined,
      scene,
    });

    const clipped = regionCoverage
      ? clipSplatBufferToAabb(decoded.splatBytes, regionCoverage)
      : { splatBytes: decoded.splatBytes, splatCount: decoded.splatCount };
    if (clipped.splatCount < decoded.splatCount) {
      log(
        `Clipped nav source to pinned region: ${clipped.splatCount.toLocaleString()}/` +
          `${decoded.splatCount.toLocaleString()} splats kept.`
      );
    }

    log(`Converting ${clipped.splatCount} splats to PLY…`);
    const plyBytes = await splatwalk.splatToPly(clipped.splatBytes);
    log(`Nav PLY ready (${(plyBytes.byteLength / (1024 * 1024)).toFixed(2)} MB).`);

    return {
      bounds: boundsFromSplatBuffer(clipped.splatBytes),
      lodIndexUsed: finestLod,
      plyBytes,
      splatCount: clipped.splatCount,
    };
  }

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
