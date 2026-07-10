/**
 * Types for the SOG (Spatially Ordered Gaussians) export + streamed-SOG slicing
 * pipeline exposed by the WASM API (`slice_splat`, `convert_to_sog`).
 *
 * These mirror, on the TypeScript side, the structures the Rust encoder emits
 * (`wasm-splatwalk/src/{sog,slice}.rs`) and the SOG meta layout that Babylon's
 * `ParseSogMeta` / `ParseSogMetaAsTextures` consume, so the produced bundle
 * round-trips through the engine and, later, the GS streaming loader.
 *
 * The Rust layer performs all quantization *and* lossless WebP encoding
 * (`image-webp`, VP8L), so the manifest below already carries encoded `.webp`
 * bytes alongside the JSON `meta.json` text. The worker only has to collate
 * those into a path-keyed file map (and optionally a store-only zip).
 */

/** Tunable parameters for SOG export and streamed-SOG slicing. */
export interface SliceSettings {
  /** Exported SH degree cap (0..3). 0 drops higher-order spherical harmonics. */
  readonly sh_degree?: number;
  /** shN k-means palette size (cluster count, 1..65536). */
  readonly sh_cluster_count?: number;
  /** shN k-means refinement iterations. */
  readonly sh_iterations?: number;
  /** Target number of splats per LOD chunk. */
  readonly chunk_count?: number;
  /** Soft cap on a chunk's world-space extent, in meters. */
  readonly chunk_extent?: number;
  /** Number of LOD levels (>=1); level 0 is finest, higher numbers are coarser. */
  readonly lod_levels?: number;
}

/** Fully-resolved slicing config (no optionals); used by the UI layers. */
export interface ResolvedSliceSettings {
  readonly sh_degree: number;
  readonly sh_cluster_count: number;
  readonly sh_iterations: number;
  readonly chunk_count: number;
  readonly chunk_extent: number;
  readonly lod_levels: number;
}

/** Built-in slicing defaults (mirrors `SliceParams::default` in Rust). */
export const DEFAULT_SLICE_SETTINGS: ResolvedSliceSettings = {
  sh_degree: 0,
  sh_cluster_count: 4096,
  sh_iterations: 10,
  chunk_count: 256_000,
  chunk_extent: 16,
  lod_levels: 2,
};

/**
 * Splat count above which the UI auto-enables slicing/streamed export by
 * default (per product requirement: default slicing for >1M-splat scenes).
 */
export const DEFAULT_AUTO_SLICE_THRESHOLD = 1_000_000;

const SH_REST_PROPS_BY_DEGREE = [0, 9, 24, 45] as const;

export interface SplatSceneBounds {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface SliceSettingCaps {
  readonly maxShDegree: number;
  readonly maxChunkExtent: number;
}

export function inferPlyShDegree(bytes: Uint8Array): number {
  const headerLimit = Math.min(bytes.byteLength, 512 * 1024);
  const header = new TextDecoder().decode(bytes.subarray(0, headerLimit));
  const endHeaderIndex = header.indexOf("end_header");
  if (endHeaderIndex < 0) {
    return 0;
  }
  const headerText = header.slice(0, endHeaderIndex);
  const restProps = (headerText.match(/property\s+float\s+f_rest_\d+/g) ?? [])
    .length;
  let degree = 0;
  for (let i = 0; i < SH_REST_PROPS_BY_DEGREE.length; i++) {
    if (restProps >= SH_REST_PROPS_BY_DEGREE[i]) {
      degree = i;
    }
  }
  return degree;
}

export function maxChunkExtentFromBounds(
  bounds: SplatSceneBounds | null | undefined,
): number {
  if (!bounds) {
    return DEFAULT_SLICE_SETTINGS.chunk_extent;
  }
  const spans = [0, 1, 2].map((i) =>
    Math.max(0, Number(bounds.max[i]) - Number(bounds.min[i])),
  );
  const largest = Math.max(...spans.filter(Number.isFinite), 0);
  if (largest <= 0) {
    return DEFAULT_SLICE_SETTINGS.chunk_extent;
  }
  return largest * 0.5;
}

export function clampSliceSettingsForScene(
  settings: SliceSettings,
  caps: SliceSettingCaps,
): SliceSettings {
  const maxShDegree = Math.max(0, Math.min(3, Math.floor(caps.maxShDegree)));
  const maxChunkExtent = Math.max(0, caps.maxChunkExtent);
  return {
    ...settings,
    sh_degree: Math.min(
      maxShDegree,
      Math.max(0, Math.floor(settings.sh_degree ?? DEFAULT_SLICE_SETTINGS.sh_degree)),
    ),
    chunk_extent: Math.min(
      maxChunkExtent,
      Math.max(0, settings.chunk_extent ?? DEFAULT_SLICE_SETTINGS.chunk_extent),
    ),
  };
}

// --- raw manifest returned by the WASM layer -----------------------------

/** A small text artifact (e.g. a chunk `meta.json`) destined for the bundle. */
export interface SliceTextFile {
  readonly path: string;
  readonly contents: string;
}

/** An encoded binary artifact (a lossless `.webp` plane) for the bundle. */
export interface SliceBinaryFile {
  /** Bundle-relative output path, e.g. `0_3/means_l.webp`. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * The raw slice output from `slice_splat` / `convert_to_sog`. Field names match
 * the Rust serde output exactly. WebP bytes arrive already encoded.
 */
export interface SliceManifestRaw {
  /** Path of the top-level manifest (`lod-meta.json` or `meta.json`). */
  readonly lodMetaPath: string;
  /** Serialized contents of the top-level manifest. */
  readonly lodMetaJson: string;
  /** Additional text files (per-chunk `meta.json`). */
  readonly files: readonly SliceTextFile[];
  /** Encoded `.webp` planes. */
  readonly binaries: readonly SliceBinaryFile[];
  /** Total source splat count. */
  readonly splatCount: number;
  /** Number of chunks produced across all LOD levels. */
  readonly chunkCount: number;
}

/**
 * The assembled slice bundle: every output file (manifest, chunk metas, encoded
 * `.webp`) collated by bundle-relative path. A store-only `.zip` can be built
 * on demand via `zipStore` for download.
 */
export interface SliceResult {
  /** All bundle files by path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Path of the top-level manifest within {@link files}. */
  readonly lodMetaPath: string;
  /** Total source splat count. */
  readonly splatCount: number;
  /** Number of chunks produced. */
  readonly chunkCount: number;
}

/** Parsed PlayCanvas / BJS streamed SOG lod-meta (subset used for fidelity checks). */
export interface StreamedLodMeta {
  readonly lodLevels?: number;
  readonly filenames?: readonly string[];
  readonly tree?: {
    readonly children?: unknown;
    readonly lods?: unknown;
  };
}

const LEGACY_GLOBAL_LOD_PATH = /^lod\d+\/meta\.json$/i;
const SPATIAL_CHUNK_PATH = /^\d+_\d+\/meta\.json$/i;

/**
 * Count leaf nodes in a BJS/PlayCanvas lod-meta tree (nodes with `lods`, no children).
 */
export function countLodTreeLeaves(node: unknown): number {
  if (!node || typeof node !== "object") {
    return 0;
  }
  const record = node as { children?: unknown; lods?: unknown };
  const children = record.children;
  if (Array.isArray(children) && children.length > 0) {
    return children.reduce<number>((sum, child) => sum + countLodTreeLeaves(child), 0);
  }
  return record.lods ? 1 : 0;
}

/**
 * Guard streamed SOG exports so a stale WASM (global `lod0`/`lod1` single leaf)
 * cannot ship as "streamed" — that layout quantizes the whole AABB and looks
 * nothing like the source PLY. PlayCanvas-quality exports use spatial
 * `{level}_{chunk}` dirs and a multi-leaf tree when the scene is larger than
 * one chunk extent.
 */
export function assertStreamedSogFidelity(manifest: unknown): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(
      "Streamed SOG export missing lod-meta.json. Rebuild WASM (`npm run build:wasm`) and restart the demo.",
    );
  }
  const meta = manifest as StreamedLodMeta;
  const filenames = Array.isArray(meta.filenames) ? meta.filenames : [];
  if (filenames.length === 0) {
    throw new Error(
      "Streamed SOG lod-meta has no filenames. Rebuild WASM (`npm run build:wasm`) and restart the demo.",
    );
  }

  const legacyGlobal = filenames.every((path) => LEGACY_GLOBAL_LOD_PATH.test(path));
  if (legacyGlobal) {
    throw new Error(
      "Streamed SOG export is not spatially chunked (legacy lod0/lod1 single-leaf layout). " +
        "That destroys fidelity vs the source PLY. Run `npm run build:wasm`, restart `npm run dev`, and export again. " +
        "Good exports use paths like 0_0/meta.json with tree.children.",
    );
  }

  const spatial = filenames.every((path) => SPATIAL_CHUNK_PATH.test(path));
  if (!spatial) {
    throw new Error(
      "Streamed SOG filenames must look like 0_0/meta.json (spatial chunks). " +
        "Rebuild WASM (`npm run build:wasm`) and restart the demo.",
    );
  }

  const leafCount = countLodTreeLeaves(meta.tree);
  const hasChildren =
    Array.isArray(meta.tree?.children) && (meta.tree?.children?.length ?? 0) > 0;
  const bound = (meta.tree as { bound?: { min?: number[]; max?: number[] } } | undefined)
    ?.bound;
  const spans =
    bound?.min && bound?.max
      ? [0, 1, 2].map((i) => Math.abs(Number(bound.max![i]) - Number(bound.min![i])))
      : [];
  const maxSpan = Math.max(0, ...spans.filter(Number.isFinite));
  // Default chunk_extent is 16m; a scene much larger than that must split.
  const needsSpatialSplit = maxSpan > DEFAULT_SLICE_SETTINGS.chunk_extent * 1.5;

  if (needsSpatialSplit && leafCount < 2 && !hasChildren) {
    throw new Error(
      "Streamed SOG tree has only one leaf for a large scene — expected Morton/extent spatial splits. " +
        "Lower Splats/Chunk or Chunk Extent, run `npm run build:wasm`, restart the demo, and export again.",
    );
  }
}

// --- on-disk SOG meta.json schema (mirror of Babylon's SOGRootData) ------

/** One section descriptor inside a SOG `meta.json` (Babylon `SOGDataFile`). */
export interface SogDataFile {
  readonly shape: readonly number[];
  readonly dtype: string;
  readonly mins?: number | readonly number[];
  readonly maxs?: number | readonly number[];
  readonly codebook?: readonly number[];
  readonly encoding?: string;
  readonly files: readonly string[];
  readonly bands?: number;
}

/** Root SOG metadata (Babylon `SOGRootData`). */
export interface SogMeta {
  readonly version?: number;
  readonly count?: number;
  readonly means: SogDataFile;
  readonly scales: SogDataFile;
  readonly quats: SogDataFile;
  readonly sh0: SogDataFile;
  readonly shN?: SogDataFile;
}
