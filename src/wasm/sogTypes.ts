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
  /** Number of LOD levels (>=1); level 0 is coarsest, the last is full detail. */
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
  sh_degree: 3,
  sh_cluster_count: 4096,
  sh_iterations: 10,
  chunk_count: 256_000,
  chunk_extent: 16,
  lod_levels: 1,
};

/**
 * Splat count above which the UI auto-enables slicing/streamed export by
 * default (per product requirement: default slicing for >1M-splat scenes).
 */
export const DEFAULT_AUTO_SLICE_THRESHOLD = 1_000_000;

// --- raw manifest returned by the WASM layer -----------------------------

/** A small text artifact (e.g. a chunk `meta.json`) destined for the bundle. */
export interface SliceTextFile {
  readonly path: string;
  readonly contents: string;
}

/** An encoded binary artifact (a lossless `.webp` plane) for the bundle. */
export interface SliceBinaryFile {
  /** Bundle-relative output path, e.g. `lod0/chunk3/means_l.webp`. */
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
