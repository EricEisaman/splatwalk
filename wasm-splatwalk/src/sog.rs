//! SOG (Spatially Ordered Gaussians) version-2 encoder.
//!
//! Produces the exact quantized RGBA8 planes + `meta.json` layout that
//! Babylon's `ParseSogMeta` / `ParseSogMetaAsTextures`
//! (`@babylonjs/loaders/SPLAT/sog.js`) decodes, so the output round-trips
//! through the engine and, next month, the GS streaming loader. WebP encoding
//! of the planes happens on the JS side (lossless libwebp) so the byte-exact
//! quantization survives.
//!
//! Encoding mirrors the inverse of the decoder:
//! - means: 16-bit, symmetric-log, per-axis min/max, split low/high byte across
//!   two planes.
//! - scales / sh0: 256-entry codebook (quantile-built) indexed per channel.
//! - quats: largest-three packing with the dropped-component index in alpha.
//! - shN: k-means palette (labels plane + centroids plane) with a 256-entry
//!   codebook, configurable SH degree.

use serde::Serialize;

use crate::splat::{sh_rest_coeffs_for_degree, FullSplatCloud};

/// SOG container version implemented here (codebook-based).
pub const SOG_VERSION: u32 = 2;
/// Entry count of every per-channel codebook (one byte indexes it).
const CODEBOOK_SIZE: usize = 256;
/// Palette columns per row in the shN centroids plane (matches the decoder's
/// `n % 64` / `n / 64` addressing).
const SH_PALETTE_COLUMNS: usize = 64;
/// Width cap for per-splat planes. Byte order is splat-major regardless of
/// width, so any cap works with the engine's texture reshaping.
const MAX_PLANE_WIDTH: usize = 8192;
/// Cap on the number of splats used to train the shN k-means centroids; keeps
/// training cheap while the (unavoidable) full assignment pass covers the rest.
const SH_TRAIN_SAMPLE_CAP: usize = 100_000;

/// One raw, un-encoded image plane. `rgba` is `width * height * 4` bytes in
/// splat-major order (tail padded with zeros), encoded to lossless WebP under
/// `name` via [`RawPlane::encode_webp`].
pub struct RawPlane {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

impl RawPlane {
    /// Encode this plane to a **lossless** WebP buffer. `image-webp` only emits
    /// VP8L (lossless), so the quantized codebook indices survive byte-exact.
    pub fn encode_webp(&self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let encoder = image_webp::WebPEncoder::new(&mut out);
        encoder
            .encode(&self.rgba, self.width as u32, self.height as u32, image_webp::ColorType::Rgba8)
            .map_err(|e| format!("WebP encode failed for {}: {}", self.name, e))?;
        Ok(out)
    }
}

/// A single SOG section descriptor, mirroring Babylon's `SOGDataFile`.
#[derive(Serialize)]
pub struct SogDataFile {
    pub shape: Vec<usize>,
    pub dtype: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mins: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maxs: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codebook: Option<Vec<f32>>,
    pub encoding: String,
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bands: Option<usize>,
}

/// Root SOG metadata, mirroring Babylon's `SOGRootData`.
#[derive(Serialize)]
pub struct SogMeta {
    pub version: u32,
    pub count: usize,
    pub means: SogDataFile,
    pub scales: SogDataFile,
    pub quats: SogDataFile,
    pub sh0: SogDataFile,
    #[serde(rename = "shN", skip_serializing_if = "Option::is_none")]
    pub sh_n: Option<SogDataFile>,
}

/// A complete SOG dataset: metadata plus the raw planes it references.
pub struct SogDataset {
    pub meta: SogMeta,
    pub planes: Vec<RawPlane>,
}

/// Encode a [`FullSplatCloud`] into a SOG v2 dataset.
///
/// `sh_degree_cap` clamps the exported SH degree (0 disables `shN`);
/// `sh_cluster_count` sets the shN palette size; `sh_iterations` is the number
/// of k-means refinement passes over the training sample.
pub fn encode_sog(
    cloud: &FullSplatCloud,
    sh_degree_cap: usize,
    sh_cluster_count: usize,
    sh_iterations: usize,
) -> SogDataset {
    let count = cloud.len();
    let (width, height) = plane_dims(count);

    let mut planes = Vec::with_capacity(7);

    let means = encode_means(cloud, width, height, &mut planes);
    let scales = encode_scales(cloud, width, height, &mut planes);
    let quats = encode_quats(cloud, width, height, &mut planes);
    let sh0 = encode_sh0(cloud, width, height, &mut planes);
    let sh_n = encode_sh_n(
        cloud,
        sh_degree_cap,
        sh_cluster_count,
        sh_iterations,
        width,
        height,
        &mut planes,
    );

    let meta = SogMeta {
        version: SOG_VERSION,
        count,
        means,
        scales,
        quats,
        sh0,
        sh_n,
    };

    SogDataset { meta, planes }
}

/// Per-splat plane dimensions. Width is capped; height grows to cover `count`.
fn plane_dims(count: usize) -> (usize, usize) {
    let width = count.min(MAX_PLANE_WIDTH).max(1);
    let height = count.div_ceil(width).max(1);
    (width, height)
}

#[inline]
fn sym_log(n: f32) -> f32 {
    n.signum() * (1.0 + n.abs()).ln()
}

#[inline]
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

// --- means ---------------------------------------------------------------

fn encode_means(
    cloud: &FullSplatCloud,
    width: usize,
    height: usize,
    planes: &mut Vec<RawPlane>,
) -> SogDataFile {
    let count = cloud.len();
    let mut mins = [f32::INFINITY; 3];
    let mut maxs = [f32::NEG_INFINITY; 3];
    for p in &cloud.positions {
        for a in 0..3 {
            let l = sym_log(p[a]);
            if l < mins[a] {
                mins[a] = l;
            }
            if l > maxs[a] {
                maxs[a] = l;
            }
        }
    }
    for a in 0..3 {
        if !mins[a].is_finite() {
            mins[a] = 0.0;
        }
        if !maxs[a].is_finite() || maxs[a] <= mins[a] {
            maxs[a] = mins[a] + 1.0;
        }
    }

    let mut low = vec![0u8; width * height * 4];
    let mut high = vec![0u8; width * height * 4];
    for (i, p) in cloud.positions.iter().enumerate() {
        let base = i * 4;
        for a in 0..3 {
            let l = sym_log(p[a]);
            let t = ((l - mins[a]) / (maxs[a] - mins[a])).clamp(0.0, 1.0);
            let q = (t * 65535.0).round() as u32;
            low[base + a] = (q & 0xff) as u8;
            high[base + a] = ((q >> 8) & 0xff) as u8;
        }
        low[base + 3] = 255;
        high[base + 3] = 255;
    }

    planes.push(RawPlane {
        name: "means_l.webp".to_string(),
        width,
        height,
        rgba: low,
    });
    planes.push(RawPlane {
        name: "means_u.webp".to_string(),
        width,
        height,
        rgba: high,
    });

    SogDataFile {
        shape: vec![count, 3],
        dtype: "uint16".to_string(),
        mins: Some(mins.to_vec()),
        maxs: Some(maxs.to_vec()),
        codebook: None,
        encoding: "log-quantized".to_string(),
        files: vec!["means_l.webp".to_string(), "means_u.webp".to_string()],
        bands: None,
    }
}

// --- scales --------------------------------------------------------------

fn encode_scales(
    cloud: &FullSplatCloud,
    width: usize,
    height: usize,
    planes: &mut Vec<RawPlane>,
) -> SogDataFile {
    let count = cloud.len();
    let codebook = build_codebook(cloud.scales.iter().flat_map(|s| s.iter().copied()));

    let mut rgba = vec![0u8; width * height * 4];
    for (i, s) in cloud.scales.iter().enumerate() {
        let base = i * 4;
        for a in 0..3 {
            rgba[base + a] = nearest_codebook_index(&codebook, s[a]);
        }
        rgba[base + 3] = 255;
    }

    planes.push(RawPlane {
        name: "scales.webp".to_string(),
        width,
        height,
        rgba,
    });

    SogDataFile {
        shape: vec![count, 3],
        dtype: "uint8".to_string(),
        mins: None,
        maxs: None,
        codebook: Some(codebook),
        encoding: "codebook".to_string(),
        files: vec!["scales.webp".to_string()],
        bands: None,
    }
}

// --- quats ---------------------------------------------------------------

fn encode_quats(
    cloud: &FullSplatCloud,
    width: usize,
    height: usize,
    planes: &mut Vec<RawPlane>,
) -> SogDataFile {
    let count = cloud.len();
    let sqrt2 = std::f32::consts::SQRT_2;
    let mut rgba = vec![0u8; width * height * 4];

    for (i, r) in cloud.rotations.iter().enumerate() {
        // Stored cloud order is (w, x, y, z); the SOG scheme indexes (x, y, z, w).
        let mut q = [r[1], r[2], r[3], r[0]];
        let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        if norm > 0.0 {
            for c in &mut q {
                *c /= norm;
            }
        } else {
            q = [0.0, 0.0, 0.0, 1.0];
        }

        // Largest-magnitude component is dropped and reconstructed at decode;
        // flip sign so it is non-negative (q and -q are the same rotation).
        let mut mode = 0usize;
        let mut max_abs = q[0].abs();
        for (idx, &c) in q.iter().enumerate().skip(1) {
            if c.abs() > max_abs {
                max_abs = c.abs();
                mode = idx;
            }
        }
        if q[mode] < 0.0 {
            for c in &mut q {
                *c = -*c;
            }
        }

        let base = i * 4;
        let mut out = 0usize;
        for idx in 0..4 {
            if idx == mode {
                continue;
            }
            // Inverse of decode `toComp(c) = ((c/255 - 0.5) * 2) / SQRT2`.
            let byte = ((q[idx] * sqrt2 / 2.0 + 0.5) * 255.0).round().clamp(0.0, 255.0);
            rgba[base + out] = byte as u8;
            out += 1;
        }
        rgba[base + 3] = (252 + mode) as u8;
    }

    planes.push(RawPlane {
        name: "quats.webp".to_string(),
        width,
        height,
        rgba,
    });

    SogDataFile {
        shape: vec![count, 4],
        dtype: "uint8".to_string(),
        mins: None,
        maxs: None,
        codebook: None,
        encoding: "quaternion-packed".to_string(),
        files: vec!["quats.webp".to_string()],
        bands: None,
    }
}

// --- sh0 (base color + opacity) -----------------------------------------

fn encode_sh0(
    cloud: &FullSplatCloud,
    width: usize,
    height: usize,
    planes: &mut Vec<RawPlane>,
) -> SogDataFile {
    let count = cloud.len();
    let codebook = build_codebook(cloud.sh0.iter().flat_map(|c| c.iter().copied()));

    let mut rgba = vec![0u8; width * height * 4];
    for i in 0..count {
        let base = i * 4;
        let c = cloud.sh0[i];
        for a in 0..3 {
            rgba[base + a] = nearest_codebook_index(&codebook, c[a]);
        }
        // v2 stores the already-sigmoided opacity byte directly in alpha.
        let alpha = (sigmoid(cloud.opacity_logit[i]) * 255.0).round().clamp(0.0, 255.0);
        rgba[base + 3] = alpha as u8;
    }

    planes.push(RawPlane {
        name: "sh0.webp".to_string(),
        width,
        height,
        rgba,
    });

    SogDataFile {
        shape: vec![count, 4],
        dtype: "uint8".to_string(),
        mins: None,
        maxs: None,
        codebook: Some(codebook),
        encoding: "codebook".to_string(),
        files: vec!["sh0.webp".to_string()],
        bands: None,
    }
}

// --- shN (higher-order spherical harmonics) ------------------------------

#[allow(clippy::too_many_arguments)]
fn encode_sh_n(
    cloud: &FullSplatCloud,
    sh_degree_cap: usize,
    sh_cluster_count: usize,
    sh_iterations: usize,
    width: usize,
    height: usize,
    planes: &mut Vec<RawPlane>,
) -> Option<SogDataFile> {
    let degree = cloud.sh_degree.min(sh_degree_cap);
    let coeffs = sh_rest_coeffs_for_degree(degree);
    let count = cloud.len();
    if degree == 0 || coeffs == 0 || count == 0 {
        return None;
    }

    let dim = coeffs * 3;
    let src_stride = cloud.sh_rest_stride();
    let src_coeffs = sh_rest_coeffs_for_degree(cloud.sh_degree);

    // Materialize per-splat SH vectors in coeff-major order (k * 3 + channel),
    // converting from the cloud's channel-major storage.
    let mut vectors = vec![0.0f32; count * dim];
    for i in 0..count {
        let src = i * src_stride;
        let dst = i * dim;
        for k in 0..coeffs {
            for j in 0..3 {
                vectors[dst + k * 3 + j] = cloud.sh_rest[src + j * src_coeffs + k];
            }
        }
    }

    let clusters = sh_cluster_count.clamp(1, 65536).min(count);
    let (centroids, labels) = kmeans(&vectors, dim, clusters, sh_iterations);

    // Codebook over all centroid component values; centroid bytes index it.
    let codebook = build_codebook(centroids.iter().copied());

    // --- labels plane (per-splat 16-bit cluster index, low/high in R/G) ---
    let mut labels_rgba = vec![0u8; width * height * 4];
    for (i, &label) in labels.iter().enumerate() {
        let base = i * 4;
        labels_rgba[base] = (label & 0xff) as u8;
        labels_rgba[base + 1] = ((label >> 8) & 0xff) as u8;
        labels_rgba[base + 3] = 255;
    }

    // --- centroids plane (64 palette columns wide, `coeffs` texels each) ---
    let centroids_width = SH_PALETTE_COLUMNS * coeffs;
    let centroids_height = clusters.div_ceil(SH_PALETTE_COLUMNS).max(1);
    let mut centroids_rgba = vec![0u8; centroids_width * centroids_height * 4];
    for n in 0..clusters {
        let col = n % SH_PALETTE_COLUMNS;
        let row = n / SH_PALETTE_COLUMNS;
        for k in 0..coeffs {
            let x = col * coeffs + k;
            let texel = (row * centroids_width + x) * 4;
            for j in 0..3 {
                let value = centroids[n * dim + k * 3 + j];
                centroids_rgba[texel + j] = nearest_codebook_index(&codebook, value);
            }
            centroids_rgba[texel + 3] = 255;
        }
    }

    planes.push(RawPlane {
        name: "shN_centroids.webp".to_string(),
        width: centroids_width,
        height: centroids_height,
        rgba: centroids_rgba,
    });
    planes.push(RawPlane {
        name: "shN_labels.webp".to_string(),
        width,
        height,
        rgba: labels_rgba,
    });

    Some(SogDataFile {
        shape: vec![count, dim],
        dtype: "uint8".to_string(),
        mins: None,
        maxs: None,
        codebook: Some(codebook),
        encoding: "kmeans-codebook".to_string(),
        // Decoder reads centroids first (index 5), then labels (index 6).
        files: vec!["shN_centroids.webp".to_string(), "shN_labels.webp".to_string()],
        bands: Some(degree),
    })
}

// --- shared quantization helpers -----------------------------------------

/// Build a 256-entry, ascending codebook from a value stream using equal-count
/// quantile bins (near-optimal for scalar quantization and O(n log n) fast).
fn build_codebook<I: Iterator<Item = f32>>(values: I) -> Vec<f32> {
    let mut sorted: Vec<f32> = values.filter(|v| v.is_finite()).collect();
    if sorted.is_empty() {
        return vec![0.0; CODEBOOK_SIZE];
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let mut codebook = Vec::with_capacity(CODEBOOK_SIZE);
    let n = sorted.len();
    for b in 0..CODEBOOK_SIZE {
        let start = b * n / CODEBOOK_SIZE;
        let end = ((b + 1) * n / CODEBOOK_SIZE).max(start + 1).min(n);
        let slice = &sorted[start..end];
        let mean = slice.iter().copied().sum::<f32>() / slice.len() as f32;
        codebook.push(mean);
    }
    // Guarantee strictly non-decreasing for binary search.
    for i in 1..codebook.len() {
        if codebook[i] < codebook[i - 1] {
            codebook[i] = codebook[i - 1];
        }
    }
    codebook
}

/// Nearest codebook entry to `value` (codebook is ascending), returned as a byte
/// index. Uses binary search + neighbor compare.
fn nearest_codebook_index(codebook: &[f32], value: f32) -> u8 {
    let v = if value.is_finite() { value } else { 0.0 };
    let pos = codebook.partition_point(|&c| c < v);
    let lo = pos.saturating_sub(1);
    let hi = pos.min(codebook.len() - 1);
    let idx = if (codebook[hi] - v).abs() < (v - codebook[lo]).abs() {
        hi
    } else {
        lo
    };
    idx.min(255) as u8
}

/// Minimal k-means over `count` vectors of length `dim`. Centroids are trained
/// on a capped random-ish sample for speed, then every vector is assigned to its
/// nearest centroid. Returns `(centroids[clusters * dim], labels[count])`.
fn kmeans(vectors: &[f32], dim: usize, clusters: usize, iterations: usize) -> (Vec<f32>, Vec<usize>) {
    let count = vectors.len() / dim;
    let clusters = clusters.clamp(1, count.max(1));

    // Deterministic, well-spread initial centroids by striding the input.
    let mut centroids = vec![0.0f32; clusters * dim];
    for c in 0..clusters {
        let src = (c * count / clusters).min(count.saturating_sub(1)) * dim;
        centroids[c * dim..(c + 1) * dim].copy_from_slice(&vectors[src..src + dim]);
    }

    // Training subsample (strided) keeps Lloyd iterations cheap.
    let train_stride = (count / SH_TRAIN_SAMPLE_CAP).max(1);
    let iters = iterations.max(1);
    let mut sums = vec![0.0f32; clusters * dim];
    let mut counts = vec![0u32; clusters];

    for _ in 0..iters {
        for s in &mut sums {
            *s = 0.0;
        }
        for c in &mut counts {
            *c = 0;
        }
        let mut i = 0;
        while i < count {
            let v = &vectors[i * dim..(i + 1) * dim];
            let c = nearest_centroid(&centroids, dim, clusters, v);
            let off = c * dim;
            for d in 0..dim {
                sums[off + d] += v[d];
            }
            counts[c] += 1;
            i += train_stride;
        }
        for c in 0..clusters {
            if counts[c] > 0 {
                let inv = 1.0 / counts[c] as f32;
                for d in 0..dim {
                    centroids[c * dim + d] = sums[c * dim + d] * inv;
                }
            }
        }
    }

    // Final full assignment.
    let mut labels = vec![0usize; count];
    let report_every = (count / 50).max(1);
    for i in 0..count {
        if i % report_every == 0 {
            web_sys::console::log_1(&format!("@progress sh {:.4}", i as f64 / count as f64).into());
        }
        let v = &vectors[i * dim..(i + 1) * dim];
        labels[i] = nearest_centroid(&centroids, dim, clusters, v);
    }

    (centroids, labels)
}

#[inline]
fn nearest_centroid(centroids: &[f32], dim: usize, clusters: usize, v: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_dist = f32::INFINITY;
    for c in 0..clusters {
        let off = c * dim;
        let mut dist = 0.0f32;
        for d in 0..dim {
            let diff = centroids[off + d] - v[d];
            dist += diff * diff;
            if dist >= best_dist {
                break;
            }
        }
        if dist < best_dist {
            best_dist = dist;
            best = c;
        }
    }
    best
}
