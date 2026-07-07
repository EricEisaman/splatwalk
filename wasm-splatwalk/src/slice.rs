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

// --- PlayCanvas Streamed SOG v1 / BJS 9.15-compatible lod-meta.json schema ---
//
// BJS 9.15 GaussianSplattingStream is an explicit port of the PlayCanvas Streamed
// SOG format. IsLODMetadata validates { lodLevels, filenames, tree } and ignores
// the PlayCanvas v1 fields { version, count, counts, asset } for backward compat.
//
// We emit the full PlayCanvas v1 schema so the output is accepted by both BJS and
// PlayCanvas tooling:
//   version: 1              — PC v1 required; BJS ignores but accepts
//   count: N                — total Gaussians (finest level); PC v1 required
//   counts: [N0, N1, ...]   — per-LOD Gaussian count; PC v1 required
//   lodLevels: N            — required by both
//   filenames: [...]        — required by both
//   tree: { bound, lods }   — required by both
//
// References:
//   BJS PR #18588  — gaussianSplattingStream.ts ISOGLODMetadata
//   PlayCanvas spec — https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/

use std::collections::HashMap;

#[derive(Serialize)]
struct BjsLodEntry {
    file: usize,
    offset: usize,
    count: usize,
}

#[derive(Serialize)]
struct BjsBound {
    min: [f64; 3],
    max: [f64; 3],
}

#[derive(Serialize)]
struct BjsLodNode {
    bound: BjsBound,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<BjsLodNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lods: Option<HashMap<String, BjsLodEntry>>,
}

#[derive(Serialize)]
struct BjsLodMeta {
    /// PlayCanvas v1 format version. BJS ignores this field but accepts it.
    version: u32,
    #[serde(rename = "lodLevels")]
    lod_levels: usize,
    /// Total Gaussians in the scene (= finest LOD level count). PlayCanvas v1 required.
    count: usize,
    /// Gaussian count per LOD level (index 0 = finest). PlayCanvas v1 required.
    counts: Vec<usize>,
    filenames: Vec<String>,
    tree: BjsLodNode,
}

/// Slice a full-fidelity cloud into a BJS 9.15-compatible streamed-SOG manifest.
///
/// Each LOD level maps to one SOG meta.json + WebP planes. The `lod-meta.json`
/// `tree` is a single root leaf node whose `lods` map covers all levels, so BJS
/// can stream the finest available level based on camera distance. For multi-GB
/// source files the slicing stride thins the cloud at coarser levels without
/// holding the full cloud twice in memory.
pub fn slice(cloud: &FullSplatCloud, params: &SliceParams) -> Result<SliceManifest, String> {
    let total = cloud.len();
    if total == 0 {
        return Err("Cannot slice an empty splat cloud".to_string());
    }

    // Guard against overflow on very large clouds (multi-GB source files).
    let levels = params.lod_levels.max(1).min(8);

    let order = morton_order(cloud);

    let mut files: Vec<SliceTextFile> = Vec::new();
    let mut binaries: Vec<SliceBinaryFile> = Vec::new();
    let mut filenames: Vec<String> = Vec::with_capacity(levels);
    let mut lods: HashMap<String, BjsLodEntry> = HashMap::with_capacity(levels);
    let mut per_level_counts: Vec<usize> = Vec::with_capacity(levels);
    let mut global_chunk_count = 0usize;
    let mut file_index = 0usize;

    for level in 0..levels {
        // Level 0 = finest (BJS/PC convention). Coarser levels subsample.
        // stride = 1 at finest level; doubles per coarser step.
        let stride = 1usize << level;
        // Clamp to avoid zero-length level on very small clouds.
        let level_indices: Vec<usize> = order
            .iter()
            .copied()
            .step_by(stride.max(1))
            .take(total.saturating_div(stride.max(1)).max(1))
            .collect();

        if level_indices.is_empty() {
            continue;
        }

        let dir = format!("lod{}", level);
        let sub = cloud.select(&level_indices);
        let dataset = encode_sog(
            &sub,
            params.sh_degree,
            params.sh_cluster_count,
            params.sh_iterations,
        );

        let meta_path = format!("{}/meta.json", dir);
        let meta_json = serde_json::to_string(&dataset.meta)
            .map_err(|e| format!("Failed to serialize chunk meta: {}", e))?;
        files.push(SliceTextFile {
            path: meta_path.clone(),
            contents: meta_json,
        });

        for plane in &dataset.planes {
            let bytes = plane.encode_webp()?;
            binaries.push(SliceBinaryFile {
                path: format!("{}/{}", dir, plane.name),
                bytes,
            });
        }

        filenames.push(meta_path);
        lods.insert(
            level.to_string(),
            BjsLodEntry {
                file: file_index,
                offset: 0,
                count: level_indices.len(),
            },
        );
        per_level_counts.push(level_indices.len());
        file_index += 1;
        global_chunk_count += 1;
    }

    if filenames.is_empty() {
        return Err("Slice produced no LOD levels — cloud may be too small.".to_string());
    }

    let (world_min, world_max) = bounds_all(cloud);
    let root_node = BjsLodNode {
        bound: BjsBound {
            min: [world_min[0] as f64, world_min[1] as f64, world_min[2] as f64],
            max: [world_max[0] as f64, world_max[1] as f64, world_max[2] as f64],
        },
        children: None,
        lods: Some(lods),
    };

    // `count` = finest-level splat count (PC v1: total across all LOD levels
    // excluding environment; for our single-leaf tree, level 0 is the finest).
    let lod_meta = BjsLodMeta {
        version: 1,
        lod_levels: file_index,
        count: total,
        counts: per_level_counts,
        filenames: filenames.clone(),
        tree: root_node,
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

/// Single (non-LOD) SOG export: one `meta.json` + planes, plus a BJS-compatible
/// `lod-meta.json` wrapping it as a single-level tree root.
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

    let (world_min, world_max) = bounds_all(cloud);
    let mut lods = HashMap::new();
    lods.insert(
        "0".to_string(),
        BjsLodEntry {
            file: 0,
            offset: 0,
            count: cloud.len(),
        },
    );
    let splat_count = cloud.len();
    let lod_meta = BjsLodMeta {
        version: 1,
        lod_levels: 1,
        count: splat_count,
        counts: vec![splat_count],
        filenames: vec!["meta.json".to_string()],
        tree: BjsLodNode {
            bound: BjsBound {
                min: [world_min[0] as f64, world_min[1] as f64, world_min[2] as f64],
                max: [world_max[0] as f64, world_max[1] as f64, world_max[2] as f64],
            },
            children: None,
            lods: Some(lods),
        },
    };
    let lod_meta_json = serde_json::to_string_pretty(&lod_meta)
        .map_err(|e| format!("Failed to serialize lod-meta: {}", e))?;

    Ok(SliceManifest {
        lod_meta_path: "lod-meta.json".to_string(),
        lod_meta_json: lod_meta_json.clone(),
        files: vec![
            SliceTextFile {
                path: "lod-meta.json".to_string(),
                contents: lod_meta_json,
            },
            SliceTextFile {
                path: "meta.json".to_string(),
                contents: meta_json,
            },
        ],
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
