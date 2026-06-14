use std::collections::HashMap;
use std::io::Cursor;
use ply_rs::parser::Parser;
use ply_rs::ply::{Property, PropertyAccess};
use nalgebra::{Point3, Vector3, Quaternion, UnitQuaternion};
use web_sys::console;

/// First spherical-harmonic basis constant (`Y_0^0`). Shared with the SOG
/// encoder so the DC term round-trips through Babylon's decoder.
pub const SH_C0: f32 = 0.282_094_79;

/// SPZ stores the DC color scaled by this factor instead of [`SH_C0`] so that
/// slightly out-of-range base colors survive when higher SH bands pull them
/// back in. We undo it on read to recover the true SH0 coefficient.
const SPZ_COLOR_SCALE: f32 = 0.15;

#[derive(Debug, Clone)]
pub struct Splat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub rot_0: f32,
    pub rot_1: f32,
    pub rot_2: f32,
    pub rot_3: f32,
    pub scale_0: f32,
    pub scale_1: f32,
    pub scale_2: f32,
    pub opacity: f32,
}

impl PropertyAccess for Splat {
    fn new() -> Self {
        Splat {
            x: 0.0, y: 0.0, z: 0.0,
            rot_0: 1.0, rot_1: 0.0, rot_2: 0.0, rot_3: 0.0,
            scale_0: 0.1, scale_1: 0.1, scale_2: 0.1,
            opacity: 1.0,
        }
    }

    fn set_property(&mut self, key: String, property: Property) {
        match (key.as_ref(), property) {
            ("x", Property::Float(v)) => self.x = v,
            ("y", Property::Float(v)) => self.y = v,
            ("z", Property::Float(v)) => self.z = v,
            ("rot_0", Property::Float(v)) => self.rot_0 = v,
            ("rot_1", Property::Float(v)) => self.rot_1 = v,
            ("rot_2", Property::Float(v)) => self.rot_2 = v,
            ("rot_3", Property::Float(v)) => self.rot_3 = v,
            ("scale_0", Property::Float(v)) => self.scale_0 = v,
            ("scale_1", Property::Float(v)) => self.scale_1 = v,
            ("scale_2", Property::Float(v)) => self.scale_2 = v,
            ("opacity", Property::Float(v)) | 
            ("alpha", Property::Float(v)) | 
            ("scalar_opacity", Property::Float(v)) => self.opacity = v,
            _ => {} 
        }
    }
}

#[derive(Clone)]
pub struct PointNormal {
    pub point: Point3<f64>,
    pub normal: Vector3<f64>,
    pub scale: Vector3<f64>,
    pub opacity: f64,
}

/// Outcome of a {@link prune_floaters} pass.
pub struct PruneResult {
    pub points: Vec<PointNormal>,
    pub input_count: usize,
    pub removed_count: usize,
    /// Set when pruning was skipped (e.g. too few points, degenerate bounds, or
    /// the removal fraction exceeded the safety cap). `None` means it ran.
    pub skipped_reason: Option<String>,
}

/// Statistical outlier removal (SuperSplat-style "remove floaters"): for every
/// splat we compute the mean distance to its `k` nearest neighbours, then drop
/// splats whose mean neighbour distance exceeds `mean + std_ratio * stddev` of
/// that distribution. Sparse stray "floater" splats sit far from the dense
/// surface, so they have large neighbour distances and are removed, while the
/// dense scene body is preserved.
///
/// A uniform spatial-hash grid keeps this close to O(N): neighbours are gathered
/// from a growing ring of grid cells around each point. The pass is rigid-motion
/// invariant, so it is safe to run on raw (pre-orientation) coordinates.
///
/// `k` is clamped to a sane minimum; `std_ratio` smaller = more aggressive. As a
/// safety net, if more than `max_remove_fraction` of points would be removed the
/// pass is skipped and the input is returned unchanged.
pub fn prune_floaters(
    points: Vec<PointNormal>,
    k: usize,
    std_ratio: f64,
    max_remove_fraction: f64,
) -> PruneResult {
    let n = points.len();
    let k = k.max(1);
    if n <= k + 1 {
        return PruneResult {
            input_count: n,
            removed_count: 0,
            points,
            skipped_reason: Some("too few points".to_string()),
        };
    }

    // Bounding box over finite points.
    let mut min = [f64::MAX; 3];
    let mut max = [f64::MIN; 3];
    for p in &points {
        let c = [p.point.x, p.point.y, p.point.z];
        for a in 0..3 {
            if c[a].is_finite() {
                if c[a] < min[a] {
                    min[a] = c[a];
                }
                if c[a] > max[a] {
                    max[a] = c[a];
                }
            }
        }
    }
    let ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let diag = (ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]).sqrt();
    if !diag.is_finite() || diag <= 0.0 {
        return PruneResult {
            input_count: n,
            removed_count: 0,
            points,
            skipped_reason: Some("degenerate bounds".to_string()),
        };
    }

    // Target a handful of points per cell so a 3x3x3 ring usually yields ~k.
    let cell = (diag / (n as f64).cbrt()).max(1e-6);
    let key = |c: &[f64; 3]| -> (i64, i64, i64) {
        (
            ((c[0] - min[0]) / cell).floor() as i64,
            ((c[1] - min[1]) / cell).floor() as i64,
            ((c[2] - min[2]) / cell).floor() as i64,
        )
    };

    let mut grid: HashMap<(i64, i64, i64), Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        if p.point.x.is_finite() && p.point.y.is_finite() && p.point.z.is_finite() {
            grid.entry(key(&[p.point.x, p.point.y, p.point.z])).or_default().push(i);
        }
    }

    const MAX_RING: i64 = 8;
    let mut mean_dists = vec![f64::NAN; n];
    let mut squared: Vec<f64> = Vec::new();

    // Emit at most ~100 progress ticks over the (dominant) KNN pass. These are
    // routed to the UI via the worker; see `@progress` handling in splat.worker.ts.
    let report_every = (n / 100).max(1);

    for i in 0..n {
        if i % report_every == 0 {
            console::log_1(&format!("@progress prune {:.4}", i as f64 / n as f64).into());
        }
        let p = &points[i];
        if !p.point.x.is_finite() || !p.point.y.is_finite() || !p.point.z.is_finite() {
            // Invalid coordinates are treated as removable.
            continue;
        }
        let pc = [p.point.x, p.point.y, p.point.z];
        let base = key(&pc);

        let mut ring = 1i64;
        loop {
            squared.clear();
            for dx in -ring..=ring {
                for dy in -ring..=ring {
                    for dz in -ring..=ring {
                        if let Some(bucket) = grid.get(&(base.0 + dx, base.1 + dy, base.2 + dz)) {
                            for &j in bucket {
                                if j == i {
                                    continue;
                                }
                                let q = &points[j].point;
                                let d = (q.x - pc[0]).powi(2) + (q.y - pc[1]).powi(2) + (q.z - pc[2]).powi(2);
                                squared.push(d);
                            }
                        }
                    }
                }
            }
            if squared.len() >= k || ring >= MAX_RING {
                break;
            }
            ring += 1;
        }

        if squared.is_empty() {
            // Completely isolated within the search radius -> definite floater.
            mean_dists[i] = f64::INFINITY;
            continue;
        }

        let kk = k.min(squared.len());
        squared.select_nth_unstable_by(kk - 1, |a, b| {
            a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
        });
        let sum: f64 = squared[..kk].iter().map(|d| d.sqrt()).sum();
        mean_dists[i] = sum / kk as f64;
    }

    // Global statistics over finite per-point mean distances.
    let finite: Vec<f64> = mean_dists.iter().copied().filter(|d| d.is_finite()).collect();
    if finite.len() < 2 {
        return PruneResult {
            input_count: n,
            removed_count: 0,
            points,
            skipped_reason: Some("insufficient neighbour signal".to_string()),
        };
    }
    let mean = finite.iter().sum::<f64>() / finite.len() as f64;
    let variance = finite.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / finite.len() as f64;
    let stddev = variance.sqrt();
    let threshold = mean + std_ratio * stddev;

    // Safety: don't run if we'd nuke too much of the scene.
    let would_remove = mean_dists
        .iter()
        .filter(|d| !(d.is_finite() && **d <= threshold))
        .count();
    if (would_remove as f64) > (n as f64) * max_remove_fraction {
        return PruneResult {
            input_count: n,
            removed_count: 0,
            points,
            skipped_reason: Some(format!(
                "removal fraction {:.1}% exceeds cap {:.1}%",
                100.0 * would_remove as f64 / n as f64,
                100.0 * max_remove_fraction
            )),
        };
    }

    let mut kept = Vec::with_capacity(n - would_remove);
    for i in 0..n {
        let d = mean_dists[i];
        if d.is_finite() && d <= threshold {
            kept.push(points[i].clone());
        }
    }
    let removed_count = n - kept.len();

    PruneResult {
        input_count: n,
        removed_count,
        points: kept,
        skipped_reason: None,
    }
}

pub fn parse_ply(data: &[u8]) -> Result<Vec<PointNormal>, String> {
        // Check for "NGSP" magic number (Niantic SPZ format)
    if data.len() >= 4 && &data[0..4] == b"NGSP" {
        console::log_1(&"Detected NGSP/SPZ format. Parsing with spz_rs...".into());
        let cursor = std::io::Cursor::new(data);
        match spz_rs::load_packed_gaussians_from_decompressed_buffer(cursor) {
            Ok(packed) => {
                let num_points = packed.num_points;
                console::log_1(&format!("Parsed {} points from SPZ", num_points).into());

                let mut points = Vec::with_capacity(num_points);

                for i in 0..num_points {
                    let g = packed.unpack(i);
                    let pos = Point3::new(g.position[0] as f64, g.position[1] as f64, g.position[2] as f64);
                    let scale = Vector3::new(g.scale[0] as f64, g.scale[1] as f64, g.scale[2] as f64);
                    let opacity = g.alpha as f64;
                    
                    // rotation is [w, x, y, z]
                    let r0 = g.rotation[0] as f64; // w
                    let r1 = g.rotation[1] as f64; // x
                    let r2 = g.rotation[2] as f64; // y
                    let r3 = g.rotation[3] as f64; // z
                    
                    // Rotate Z-axis (0, 0, 1) by this quaternion
                    let nx = 2.0 * (r1 * r3 + r2 * r0);
                    let ny = 2.0 * (r2 * r3 - r1 * r0);
                    let nz = 1.0 - 2.0 * (r1 * r1 + r2 * r2);
                    
                    let normal = Vector3::new(nx, ny, nz);
                    
                    points.push(PointNormal { point: pos, normal, scale, opacity });
                }
                
                return Ok(points);
            }
            Err(e) => {
                 let err_msg = format!("Failed to parse SPZ: {:?}", e);
                 console::log_1(&err_msg.clone().into());
                 return Err(err_msg);
            }
        }
    }

    // Default to PLY parser
    let mut cursor = Cursor::new(data);
    let parser = Parser::<Splat>::new();
    
    let header = parser.read_header(&mut cursor).map_err(|e| e.to_string())?;
    
    // Check if vertex element exists
    if !header.elements.contains_key("vertex") {
        return Err("PLY file missing 'vertex' element".to_string());
    }

    let mut splats = Vec::new();
    for (_key, element) in &header.elements {
        if _key == "vertex" {
             splats = parser.read_payload_for_element(&mut cursor, element, &header).map_err(|e| e.to_string())?;
        }
    }

    let mut points = Vec::with_capacity(splats.len());

    for splat in splats {
        let p = Point3::new(splat.x as f64, splat.y as f64, splat.z as f64);
        let scale = Vector3::new(splat.scale_0 as f64, splat.scale_1 as f64, splat.scale_2 as f64);
        let opacity = splat.opacity as f64;
        
        let q = UnitQuaternion::new_normalize(Quaternion::new(splat.rot_0, splat.rot_1, splat.rot_2, splat.rot_3));
        let normal = q.transform_vector(&Vector3::z_axis());

        points.push(PointNormal {
            point: p,
            normal: Vector3::new(normal.x as f64, normal.y as f64, normal.z as f64),
            scale,
            opacity,
        });
    }

    Ok(points)
}

// ---------------------------------------------------------------------------
// Full-fidelity splat model (used by the SOG / slicing pipeline)
//
// The nav/mesh pipeline only needs position + a derived normal + scale +
// opacity, so `parse_ply` above stays lightweight to keep large scans cheap.
// SOG export, by contrast, must preserve every Gaussian attribute including
// the full spherical-harmonic stack, so it has its own parse path returning a
// Structure-of-Arrays cloud (no per-splat heap allocation).
// ---------------------------------------------------------------------------

/// Number of spherical-harmonic rest coefficients **per color channel** for a
/// given SH degree. The DC term (SH0) is stored separately, so this counts only
/// bands 1..=degree.
pub fn sh_rest_coeffs_for_degree(degree: usize) -> usize {
    match degree {
        0 => 0,
        1 => 3,
        2 => 8,
        3 => 15,
        _ => 15,
    }
}

/// Recover an SH degree (0..=3) from a total PLY `f_rest_*` property count
/// (which spans all three color channels).
fn degree_from_rest_total(total: usize) -> usize {
    match total / 3 {
        0 => 0,
        3 => 1,
        8 => 2,
        _ => 3,
    }
}

/// A complete Gaussian-splat point cloud in 3DGS/PLY conventions, stored as
/// parallel arrays. Scales are log-space, rotations are `(w, x, y, z)` and
/// normalized, opacity is the raw logit (pre-sigmoid), and `sh0` is the DC
/// coefficient (not premultiplied by [`SH_C0`]). `sh_rest` is a flat,
/// channel-major buffer with stride `3 * sh_rest_coeffs_for_degree(sh_degree)`
/// per splat: `[R(0..n), G(0..n), B(0..n)]`.
#[derive(Clone, Default)]
pub struct FullSplatCloud {
    pub sh_degree: usize,
    pub positions: Vec<[f32; 3]>,
    pub scales: Vec<[f32; 3]>,
    pub rotations: Vec<[f32; 4]>,
    pub opacity_logit: Vec<f32>,
    pub sh0: Vec<[f32; 3]>,
    pub sh_rest: Vec<f32>,
}

impl FullSplatCloud {
    pub fn len(&self) -> usize {
        self.positions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Per-splat stride (in `f32`s) of the flat `sh_rest` buffer.
    pub fn sh_rest_stride(&self) -> usize {
        3 * sh_rest_coeffs_for_degree(self.sh_degree)
    }

    /// Build a new cloud containing only the splats at `indices`, preserving the
    /// SH degree. Used by the slicer to materialize Morton-ordered LOD chunks.
    pub fn select(&self, indices: &[usize]) -> FullSplatCloud {
        let stride = self.sh_rest_stride();
        let mut out = FullSplatCloud {
            sh_degree: self.sh_degree,
            positions: Vec::with_capacity(indices.len()),
            scales: Vec::with_capacity(indices.len()),
            rotations: Vec::with_capacity(indices.len()),
            opacity_logit: Vec::with_capacity(indices.len()),
            sh0: Vec::with_capacity(indices.len()),
            sh_rest: Vec::with_capacity(indices.len() * stride),
        };
        for &i in indices {
            out.positions.push(self.positions[i]);
            out.scales.push(self.scales[i]);
            out.rotations.push(self.rotations[i]);
            out.opacity_logit.push(self.opacity_logit[i]);
            out.sh0.push(self.sh0[i]);
            if stride > 0 {
                out.sh_rest.extend_from_slice(&self.sh_rest[i * stride..(i + 1) * stride]);
            }
        }
        out
    }
}

/// ply-rs accessor capturing the full Gaussian attribute set, including up to
/// 45 `f_rest_*` SH coefficients (degree 3).
#[derive(Clone)]
struct FullSplatRecord {
    x: f32,
    y: f32,
    z: f32,
    rot: [f32; 4],
    scale: [f32; 3],
    opacity: f32,
    f_dc: [f32; 3],
    f_rest: [f32; 45],
}

impl PropertyAccess for FullSplatRecord {
    fn new() -> Self {
        FullSplatRecord {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            rot: [1.0, 0.0, 0.0, 0.0],
            scale: [0.0, 0.0, 0.0],
            opacity: 0.0,
            f_dc: [0.0, 0.0, 0.0],
            f_rest: [0.0; 45],
        }
    }

    fn set_property(&mut self, key: String, property: Property) {
        let v = match property {
            Property::Float(v) => v,
            Property::Double(v) => v as f32,
            _ => return,
        };
        match key.as_str() {
            "x" => self.x = v,
            "y" => self.y = v,
            "z" => self.z = v,
            "rot_0" => self.rot[0] = v,
            "rot_1" => self.rot[1] = v,
            "rot_2" => self.rot[2] = v,
            "rot_3" => self.rot[3] = v,
            "scale_0" => self.scale[0] = v,
            "scale_1" => self.scale[1] = v,
            "scale_2" => self.scale[2] = v,
            "opacity" | "alpha" | "scalar_opacity" => self.opacity = v,
            "f_dc_0" => self.f_dc[0] = v,
            "f_dc_1" => self.f_dc[1] = v,
            "f_dc_2" => self.f_dc[2] = v,
            _ => {
                if let Some(idx) = key.strip_prefix("f_rest_").and_then(|s| s.parse::<usize>().ok()) {
                    if idx < self.f_rest.len() {
                        self.f_rest[idx] = v;
                    }
                }
            }
        }
    }
}

/// Parse a `.ply` or `.spz` buffer into a full-fidelity [`FullSplatCloud`],
/// preserving spherical harmonics. Used exclusively by the SOG / slicing path.
pub fn parse_full_cloud(data: &[u8]) -> Result<FullSplatCloud, String> {
    if data.len() >= 4 && &data[0..4] == b"NGSP" {
        return parse_full_cloud_spz(data);
    }
    parse_full_cloud_ply(data)
}

fn parse_full_cloud_spz(data: &[u8]) -> Result<FullSplatCloud, String> {
    console::log_1(&"Detected NGSP/SPZ format. Parsing full splat cloud with spz_rs...".into());
    let cursor = Cursor::new(data);
    let packed = spz_rs::load_packed_gaussians_from_decompressed_buffer(cursor)
        .map_err(|e| format!("Failed to parse SPZ: {:?}", e))?;

    let degree = packed.sh_degree.min(3);
    let coeffs = sh_rest_coeffs_for_degree(degree);
    let stride = 3 * coeffs;
    let n = packed.num_points;
    let color_to_sh0 = SPZ_COLOR_SCALE / SH_C0;

    let mut cloud = FullSplatCloud {
        sh_degree: degree,
        positions: Vec::with_capacity(n),
        scales: Vec::with_capacity(n),
        rotations: Vec::with_capacity(n),
        opacity_logit: Vec::with_capacity(n),
        sh0: Vec::with_capacity(n),
        sh_rest: Vec::with_capacity(n * stride),
    };

    for i in 0..n {
        let g = packed.unpack(i);
        cloud.positions.push(g.position);
        cloud.scales.push(g.scale);
        cloud.rotations.push(g.rotation);
        cloud.opacity_logit.push(g.alpha);
        cloud.sh0.push([
            g.color[0] * color_to_sh0,
            g.color[1] * color_to_sh0,
            g.color[2] * color_to_sh0,
        ]);
        // Channel-major: all R coeffs, then G, then B.
        for k in 0..coeffs {
            cloud.sh_rest.push(g.sh_r[k]);
        }
        for k in 0..coeffs {
            cloud.sh_rest.push(g.sh_g[k]);
        }
        for k in 0..coeffs {
            cloud.sh_rest.push(g.sh_b[k]);
        }
    }

    console::log_1(&format!("Parsed {} splats from SPZ (SH degree {})", n, degree).into());
    Ok(cloud)
}

fn parse_full_cloud_ply(data: &[u8]) -> Result<FullSplatCloud, String> {
    let mut cursor = Cursor::new(data);
    let parser = Parser::<FullSplatRecord>::new();
    let header = parser.read_header(&mut cursor).map_err(|e| e.to_string())?;

    let vertex = header
        .elements
        .get("vertex")
        .ok_or_else(|| "PLY file missing 'vertex' element".to_string())?;

    let rest_total = vertex
        .properties
        .keys()
        .filter(|k| k.starts_with("f_rest_"))
        .count();
    let degree = degree_from_rest_total(rest_total);
    let coeffs = sh_rest_coeffs_for_degree(degree);
    let stride = 3 * coeffs;

    let records: Vec<FullSplatRecord> = parser
        .read_payload_for_element(&mut cursor, vertex, &header)
        .map_err(|e| e.to_string())?;

    let n = records.len();
    let mut cloud = FullSplatCloud {
        sh_degree: degree,
        positions: Vec::with_capacity(n),
        scales: Vec::with_capacity(n),
        rotations: Vec::with_capacity(n),
        opacity_logit: Vec::with_capacity(n),
        sh0: Vec::with_capacity(n),
        sh_rest: Vec::with_capacity(n * stride),
    };

    for r in &records {
        cloud.positions.push([r.x, r.y, r.z]);
        cloud.scales.push(r.scale);
        cloud.rotations.push(r.rot);
        cloud.opacity_logit.push(r.opacity);
        cloud.sh0.push(r.f_dc);
        // PLY `f_rest_*` is already channel-major: R(0..coeffs), G, B.
        cloud.sh_rest.extend_from_slice(&r.f_rest[0..stride]);
    }

    console::log_1(&format!("Parsed {} splats from PLY (SH degree {})", n, degree).into());
    Ok(cloud)
}

/// Serialize a [`FullSplatCloud`] to a binary little-endian 3DGS `.ply` buffer.
/// Powers inline `.spz -> .ply` conversion so the rest of the app (Babylon
/// viewer + nav pipeline) only ever has to deal with PLY.
pub fn write_ply(cloud: &FullSplatCloud) -> Vec<u8> {
    let coeffs = sh_rest_coeffs_for_degree(cloud.sh_degree);
    let rest_total = 3 * coeffs;
    let n = cloud.len();

    let mut header = String::new();
    header.push_str("ply\n");
    header.push_str("format binary_little_endian 1.0\n");
    header.push_str(&format!("element vertex {}\n", n));
    for prop in ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"] {
        header.push_str(&format!("property float {}\n", prop));
    }
    for i in 0..rest_total {
        header.push_str(&format!("property float f_rest_{}\n", i));
    }
    for prop in ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"] {
        header.push_str(&format!("property float {}\n", prop));
    }
    header.push_str("end_header\n");

    // 9 leading floats (xyz + normal + f_dc) + rest + 8 trailing floats.
    let floats_per_vertex = 9 + rest_total + 8;
    let mut out = Vec::with_capacity(header.len() + n * floats_per_vertex * 4);
    out.extend_from_slice(header.as_bytes());

    let stride = cloud.sh_rest_stride();
    for i in 0..n {
        let p = cloud.positions[i];
        push_f32(&mut out, p[0]);
        push_f32(&mut out, p[1]);
        push_f32(&mut out, p[2]);
        // Normals are unused by 3DGS but kept for loader compatibility.
        push_f32(&mut out, 0.0);
        push_f32(&mut out, 0.0);
        push_f32(&mut out, 0.0);
        let dc = cloud.sh0[i];
        push_f32(&mut out, dc[0]);
        push_f32(&mut out, dc[1]);
        push_f32(&mut out, dc[2]);
        if stride > 0 {
            for &v in &cloud.sh_rest[i * stride..(i + 1) * stride] {
                push_f32(&mut out, v);
            }
        }
        push_f32(&mut out, cloud.opacity_logit[i]);
        let s = cloud.scales[i];
        push_f32(&mut out, s[0]);
        push_f32(&mut out, s[1]);
        push_f32(&mut out, s[2]);
        let r = cloud.rotations[i];
        push_f32(&mut out, r[0]);
        push_f32(&mut out, r[1]);
        push_f32(&mut out, r[2]);
        push_f32(&mut out, r[3]);
    }

    out
}

#[inline]
fn push_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}
