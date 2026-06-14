use std::collections::HashMap;
use std::io::Cursor;
use ply_rs::parser::Parser;
use ply_rs::ply::{Property, PropertyAccess};
use nalgebra::{Point3, Vector3, Quaternion, UnitQuaternion};
use web_sys::console;

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
