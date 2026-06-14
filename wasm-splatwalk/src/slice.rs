//! Streamed-SOG slicer: Morton-orders a splat cloud, splits it into
//! spatially-local LOD chunks, and encodes each chunk as a SOG v2 dataset
//! indexed by a `lod-meta.json` manifest.
//!
//! The design follows PlayCanvas `splat-transform`'s streamed-SOG idea
//! (Morton reorder + per-chunk SOG keyed by approximate splat count and world
//! extent) and targets Babylon PR #18563's GS streaming loader, which consumes
//! `lod-meta.json`. Raw RGBA planes are returned for the JS layer to encode to
//! lossless WebP.

use serde::Serialize;

use crate::sog::encode_sog;
use crate::splat::FullSplatCloud;

/// Manifest schema version emitted in `lod-meta.json`.
pub const LOD_META_VERSION: u32 = 1;

/// Tunable slicing parameters. All fields are optional on the JS side and fall
/// back to the documented defaults here.
#[derive(Clone, Copy)]
pub struct SliceParams {
    /// Exported SH degree cap (0..=3). 0 drops higher-order SH.
    pub sh_degree: usize,
    /// shN k-means palette size (number of clusters).
    pub sh_cluster_count: usize,
    /// shN k-means refinement iterations.
    pub sh_iterations: usize,
    /// Target number of splats per LOD chunk.
    pub chunk_count: usize,
    /// Soft cap on a chunk's world-space extent (meters); chunks are cut early
    /// when exceeded to preserve spatial locality.
    pub chunk_extent: f64,
    /// Number of LOD levels (>=1). Level 0 is coarsest; the last is full detail.
    pub lod_levels: usize,
}

impl Default for SliceParams {
    fn default() -> Self {
        Self {
            sh_degree: 3,
            sh_cluster_count: 4096,
            sh_iterations: 10,
            chunk_count: 256_000,
            chunk_extent: 16.0,
            lod_levels: 1,
        }
    }
}

/// A text file (e.g. a chunk's `meta.json`) destined for the output bundle.
#[derive(Serialize)]
pub struct SliceTextFile {
    pub path: String,
    pub contents: String,
}

/// A binary file (a lossless-WebP-encoded plane) destined for the bundle.
#[derive(Serialize)]
pub struct SliceBinaryFile {
    pub path: String,
    #[serde(with = "serde_bytes")]
    pub bytes: Vec<u8>,
}

/// Everything needed to assemble the streamed-SOG bundle: the manifest plus the
/// fully-encoded text (`meta.json`) and binary (`.webp`) files, keyed by path.
#[derive(Serialize)]
pub struct SliceManifest {
    #[serde(rename = "lodMetaPath")]
    pub lod_meta_path: String,
    #[serde(rename = "lodMetaJson")]
    pub lod_meta_json: String,
    pub files: Vec<SliceTextFile>,
    pub binaries: Vec<SliceBinaryFile>,
    #[serde(rename = "splatCount")]
    pub splat_count: usize,
    #[serde(rename = "chunkCount")]
    pub chunk_count: usize,
}

// --- lod-meta.json schema ------------------------------------------------

#[derive(Serialize)]
struct LodMeta {
    version: u32,
    #[serde(rename = "splatCount")]
    splat_count: usize,
    #[serde(rename = "shDegree")]
    sh_degree: usize,
    #[serde(rename = "chunkCountTarget")]
    chunk_count_target: usize,
    #[serde(rename = "chunkExtent")]
    chunk_extent: f64,
    levels: Vec<LodLevel>,
}

#[derive(Serialize)]
struct LodLevel {
    level: usize,
    #[serde(rename = "splatCount")]
    splat_count: usize,
    chunks: Vec<LodChunk>,
}

#[derive(Serialize)]
struct LodChunk {
    id: usize,
    #[serde(rename = "splatCount")]
    splat_count: usize,
    #[serde(rename = "boundMin")]
    bound_min: [f32; 3],
    #[serde(rename = "boundMax")]
    bound_max: [f32; 3],
    /// Directory (within the bundle) holding this chunk's `meta.json` + planes.
    dir: String,
    meta: String,
}

/// Slice a full-fidelity cloud into a streamed-SOG manifest.
pub fn slice(cloud: &FullSplatCloud, params: &SliceParams) -> Result<SliceManifest, String> {
    let total = cloud.len();
    if total == 0 {
        return Err("Cannot slice an empty splat cloud".to_string());
    }

    let order = morton_order(cloud);
    let levels = params.lod_levels.max(1);

    let mut files: Vec<SliceTextFile> = Vec::new();
    let mut binaries: Vec<SliceBinaryFile> = Vec::new();
    let mut meta_levels: Vec<LodLevel> = Vec::with_capacity(levels);
    let mut global_chunk_count = 0usize;

    for level in 0..levels {
        // Coarsest level (0) is most decimated; the last level is full detail.
        let stride = 1usize << (levels - 1 - level);
        let level_indices: Vec<usize> = order.iter().copied().step_by(stride).collect();
        let chunks = chunk_indices(cloud, &level_indices, params);

        let mut meta_chunks: Vec<LodChunk> = Vec::with_capacity(chunks.len());
        for (chunk_id, chunk) in chunks.iter().enumerate() {
            let dir = format!("lod{}/chunk{}", level, chunk_id);
            let sub = cloud.select(chunk);
            let dataset = encode_sog(
                &sub,
                params.sh_degree,
                params.sh_cluster_count,
                params.sh_iterations,
            );

            let meta_json = serde_json::to_string(&dataset.meta)
                .map_err(|e| format!("Failed to serialize chunk meta: {}", e))?;
            files.push(SliceTextFile {
                path: format!("{}/meta.json", dir),
                contents: meta_json,
            });

            for plane in &dataset.planes {
                let bytes = plane.encode_webp()?;
                binaries.push(SliceBinaryFile {
                    path: format!("{}/{}", dir, plane.name),
                    bytes,
                });
            }

            let (bound_min, bound_max) = bounds(cloud, chunk);
            meta_chunks.push(LodChunk {
                id: chunk_id,
                splat_count: chunk.len(),
                bound_min,
                bound_max,
                dir,
                meta: "meta.json".to_string(),
            });
            global_chunk_count += 1;
        }

        meta_levels.push(LodLevel {
            level,
            splat_count: level_indices.len(),
            chunks: meta_chunks,
        });
    }

    let lod_meta = LodMeta {
        version: LOD_META_VERSION,
        splat_count: total,
        sh_degree: cloud.sh_degree.min(params.sh_degree),
        chunk_count_target: params.chunk_count,
        chunk_extent: params.chunk_extent,
        levels: meta_levels,
    };
    let lod_meta_json = serde_json::to_string_pretty(&lod_meta)
        .map_err(|e| format!("Failed to serialize lod-meta: {}", e))?;

    Ok(SliceManifest {
        lod_meta_path: "lod-meta.json".to_string(),
        lod_meta_json,
        files,
        binaries,
        splat_count: total,
        chunk_count: global_chunk_count,
    })
}

/// Convenience for the single-bundle (non-LOD) SOG export path. Returns one
/// `meta.json` plus its planes, all at the bundle root.
pub fn encode_single(
    cloud: &FullSplatCloud,
    sh_degree: usize,
    sh_cluster_count: usize,
    sh_iterations: usize,
) -> Result<SliceManifest, String> {
    if cloud.is_empty() {
        return Err("Cannot encode an empty splat cloud".to_string());
    }
    let dataset = encode_sog(cloud, sh_degree, sh_cluster_count, sh_iterations);
    let meta_json = serde_json::to_string(&dataset.meta)
        .map_err(|e| format!("Failed to serialize meta: {}", e))?;
    let mut binaries: Vec<SliceBinaryFile> = Vec::with_capacity(dataset.planes.len());
    for plane in &dataset.planes {
        binaries.push(SliceBinaryFile {
            path: plane.name.clone(),
            bytes: plane.encode_webp()?,
        });
    }

    Ok(SliceManifest {
        lod_meta_path: "meta.json".to_string(),
        lod_meta_json: meta_json.clone(),
        files: vec![SliceTextFile {
            path: "meta.json".to_string(),
            contents: meta_json,
        }],
        binaries,
        splat_count: cloud.len(),
        chunk_count: 1,
    })
}

// --- spatial helpers -----------------------------------------------------

/// Sort splat indices by 63-bit Morton (Z-order) code over quantized position.
fn morton_order(cloud: &FullSplatCloud) -> Vec<usize> {
    let (min, max) = bounds_all(cloud);
    let mut ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    for e in &mut ext {
        if !e.is_finite() || *e <= 0.0 {
            *e = 1.0;
        }
    }
    const BITS: u32 = 21; // 21 bits per axis -> 63-bit code
    let scale = ((1u32 << BITS) - 1) as f32;

    let mut keyed: Vec<(u64, usize)> = (0..cloud.len())
        .map(|i| {
            let p = cloud.positions[i];
            let x = (((p[0] - min[0]) / ext[0]).clamp(0.0, 1.0) * scale) as u32;
            let y = (((p[1] - min[1]) / ext[1]).clamp(0.0, 1.0) * scale) as u32;
            let z = (((p[2] - min[2]) / ext[2]).clamp(0.0, 1.0) * scale) as u32;
            (morton3(x, y, z), i)
        })
        .collect();
    keyed.sort_unstable_by_key(|(code, _)| *code);
    keyed.into_iter().map(|(_, i)| i).collect()
}

/// Interleave the low 21 bits of three coordinates into a 63-bit Morton code.
fn morton3(x: u32, y: u32, z: u32) -> u64 {
    split3(x) | (split3(y) << 1) | (split3(z) << 2)
}

/// Spread the low 21 bits of `v` so each occupies every third bit.
fn split3(v: u32) -> u64 {
    let mut x = (v as u64) & 0x1f_ffff; // 21 bits
    x = (x | (x << 32)) & 0x1f00_0000_00ff_ffff;
    x = (x | (x << 16)) & 0x1f00_00ff_0000_ffff;
    x = (x | (x << 8)) & 0x100f_00f0_0f00_f00f;
    x = (x | (x << 4)) & 0x10c3_0c30_c30c_30c3;
    x = (x | (x << 2)) & 0x1249_2492_4924_9249;
    x
}

/// Partition Morton-ordered `indices` into chunks bounded by both a target
/// splat count and a soft world-space extent.
fn chunk_indices(cloud: &FullSplatCloud, indices: &[usize], params: &SliceParams) -> Vec<Vec<usize>> {
    let target = params.chunk_count.max(1);
    let extent = params.chunk_extent as f32;
    let mut chunks: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut cmin = [f32::INFINITY; 3];
    let mut cmax = [f32::NEG_INFINITY; 3];

    for &i in indices {
        let p = cloud.positions[i];
        let mut nmin = cmin;
        let mut nmax = cmax;
        for a in 0..3 {
            nmin[a] = nmin[a].min(p[a]);
            nmax[a] = nmax[a].max(p[a]);
        }
        let span = (nmax[0] - nmin[0]).max(nmax[1] - nmin[1]).max(nmax[2] - nmin[2]);
        let exceeds_extent = extent > 0.0 && !current.is_empty() && span > extent;

        if !current.is_empty() && (current.len() >= target || exceeds_extent) {
            chunks.push(std::mem::take(&mut current));
            cmin = [f32::INFINITY; 3];
            cmax = [f32::NEG_INFINITY; 3];
        }

        current.push(i);
        for a in 0..3 {
            cmin[a] = cmin[a].min(p[a]);
            cmax[a] = cmax[a].max(p[a]);
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn bounds(cloud: &FullSplatCloud, indices: &[usize]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for &i in indices {
        let p = cloud.positions[i];
        for a in 0..3 {
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
    }
    sanitize_bounds(&mut min, &mut max);
    (min, max)
}

fn bounds_all(cloud: &FullSplatCloud) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in &cloud.positions {
        for a in 0..3 {
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
    }
    sanitize_bounds(&mut min, &mut max);
    (min, max)
}

fn sanitize_bounds(min: &mut [f32; 3], max: &mut [f32; 3]) {
    for a in 0..3 {
        if !min[a].is_finite() {
            min[a] = 0.0;
        }
        if !max[a].is_finite() || max[a] < min[a] {
            max[a] = min[a];
        }
    }
}
