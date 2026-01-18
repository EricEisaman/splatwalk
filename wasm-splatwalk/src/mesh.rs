// use wasm_bindgen::prelude::*;
use crate::splat::PointNormal;
use poisson_reconstruction::{PoissonReconstruction, Real};
use nalgebra::{Point3, Vector3};
use rand::Rng;

#[derive(Debug)]
pub struct ReconstructedMesh {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
}

struct Plane {
    normal: Vector3<Real>,
    d: Real,
}

impl Plane {
    fn from_points(p1: &Point3<Real>, p2: &Point3<Real>, p3: &Point3<Real>) -> Option<Self> {
        let v1 = p2 - p1;
        let v2 = p3 - p1;
        let normal = v1.cross(&v2).normalize();
        
        if normal.magnitude() < 1e-6 {
            return None;
        }
        
        let d = -normal.dot(&p1.coords);
        Some(Plane { normal, d })
    }

    fn distance(&self, p: &Point3<Real>) -> Real {
        (self.normal.dot(&p.coords) + self.d).abs()
    }
}

pub fn reconstruct_mesh(points: &[PointNormal], settings: &crate::MeshSettings) -> ReconstructedMesh {
    let mode = settings.mode;
    web_sys::console::log_1(&format!("Reconstructing mesh (Mode: {})...", mode).into());

    let p_coords: Vec<Point3<Real>> = points.iter()
        .filter(|p| !(p.point.x.is_nan() || p.point.y.is_nan() || p.point.z.is_nan()))
        .map(|p| Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real))
        .collect();
    let p_normals: Vec<Vector3<Real>> = points.iter()
        .filter(|p| !(p.point.x.is_nan() || p.point.y.is_nan() || p.point.z.is_nan()))
        .map(|p| Vector3::new(p.normal.x as Real, p.normal.y as Real, p.normal.z as Real))
        .collect();

    if p_coords.is_empty() {
        return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    if mode == 1 {
        // Single Plane Detection (RANSAC)
        return reconstruct_plane_ransac(&p_coords);
    } else if mode == 2 {
        // Mode 2: Voxel NavMesh (Advanced)
        return reconstruct_voxel_navmesh(points, settings);
    } else {
        // Mode 0: Default Poisson
         return reconstruct_poisson(&p_coords, &p_normals);
    }
}

fn reconstruct_voxel_navmesh(points: &[PointNormal], settings: &crate::MeshSettings) -> ReconstructedMesh {
    // Extract settings with defaults
    let voxel_target = settings.voxel_target.unwrap_or(4000.0);
    let min_alpha = settings.min_alpha.unwrap_or(0.05);
    let max_scale = settings.max_scale.unwrap_or(5.0);
    let normal_align = settings.normal_align.unwrap_or(0.05);
    let ransac_thresh = settings.ransac_thresh.unwrap_or(0.1);

    web_sys::console::log_1(&format!("NavMesh Params: Target={}, Alpha={}, Scale={}, Align={}, RANSAC={}", 
        voxel_target, min_alpha, max_scale, normal_align, ransac_thresh).into());

    if points.is_empty() {
        return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    // 1. Robust Filter
    let filtered_points: Vec<&PointNormal> = points.iter()
        .filter(|p| {
            p.opacity > min_alpha && 
            p.scale.x < max_scale && p.scale.y < max_scale && p.scale.z < max_scale
        })
        .collect();

    web_sys::console::log_1(&format!("Points after floater filter: {}/{}", filtered_points.len(), points.len()).into());

    if filtered_points.is_empty() {
        return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    // 2. Find Dominant Plane via RANSAC
    let p_coords: Vec<Point3<Real>> = filtered_points.iter()
        .map(|p| Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real))
        .collect();
    
    let iterations = 1000;
    let mut best_plane: Option<Plane> = None;
    let mut max_inliers = 0;
    let mut rng = rand::thread_rng();
    let n = p_coords.len();

    if n > 3 {
        for _ in 0..iterations {
            let idx1 = rng.gen_range(0..n);
            let idx2 = rng.gen_range(0..n);
            let idx3 = rng.gen_range(0..n);
            if idx1 == idx2 || idx2 == idx3 || idx1 == idx3 { continue; }
            if let Some(plane) = Plane::from_points(&p_coords[idx1], &p_coords[idx2], &p_coords[idx3]) {
                let mut inliers = 0;
                for p in &p_coords {
                    if plane.distance(p) < ransac_thresh { inliers += 1; }
                }
                if inliers > max_inliers {
                    max_inliers = inliers;
                    best_plane = Some(plane);
                }
            }
        }
    }

    web_sys::console::log_1(&format!("RANSAC max inliers: {}/{}", max_inliers, n).into());

    let up = if let Some(ref plane) = best_plane {
        let normal = if plane.normal.y < 0.0 { -plane.normal } else { plane.normal };
        web_sys::console::log_1(&format!("Aligned Ground Normal: {:?}", normal).into());
        normal
    } else {
        web_sys::console::log_1(&"RANSAC failed, falling back to +Y".into());
        Vector3::new(0.0, 1.0, 0.0)
    };

    // 3. Create Basis
    let mut tangent = if up.x.abs() < 0.9 { Vector3::new(1.0, 0.0, 0.0) } else { Vector3::new(0.0, 1.0, 0.0) };
    tangent = (tangent - up * up.dot(&tangent)).normalize();
    let bitangent = up.cross(&tangent);

    // 4. Bounding Box in Projected Space
    let mut min_u = f64::MAX;
    let mut max_u = f64::MIN;
    let mut min_v = f64::MAX;
    let mut max_v = f64::MIN;

    for p in &filtered_points {
        let u = p.point.coords.dot(&Vector3::new(tangent.x as f64, tangent.y as f64, tangent.z as f64));
        let v = p.point.coords.dot(&Vector3::new(bitangent.x as f64, bitangent.y as f64, bitangent.z as f64));
        if u < min_u { min_u = u; }
        if u > max_u { max_u = u; }
        if v < min_v { min_v = v; }
        if v > max_v { max_v = v; }
    }

    // 5. Grid Config
    let width = max_u - min_u;
    let depth = max_v - min_v;
    let mut cell_size = (width * depth / voxel_target).sqrt();
    cell_size = cell_size.clamp(0.01, 2.0);

    let rows = (depth / cell_size).ceil() as usize;
    let cols = (width / cell_size).ceil() as usize;
    let mut grid_accum = vec![(0.0, 0.0); rows * cols];

    // 6. Aligned Density Splatting
    let up_64 = Vector3::new(up.x as f64, up.y as f64, up.z as f64);
    let mut max_w_seen = 0.0;

    for p in &filtered_points {
        let normal_weight = p.normal.dot(&up_64).abs().powi(2);
        if normal_weight < normal_align { continue; }

        let u = p.point.coords.dot(&Vector3::new(tangent.x as f64, tangent.y as f64, tangent.z as f64));
        let v = p.point.coords.dot(&Vector3::new(bitangent.x as f64, bitangent.y as f64, bitangent.z as f64));
        let h = p.point.coords.dot(&up_64);

        let col_center = (u - min_u) / cell_size;
        let row_center = (v - min_v) / cell_size;
        
        let scale_avg = (p.scale.x + p.scale.y + p.scale.z) / 3.0;
        let radius = (scale_avg / cell_size).ceil() as isize;
        let radius = radius.clamp(0, 2); 

        let weight = p.opacity * normal_weight;
        
        for dr in -radius..=radius {
            for dc in -radius..=radius {
                let c = (col_center.floor() as isize) + dc;
                let r = (row_center.floor() as isize) + dr;
                if c >= 0 && c < cols as isize && r >= 0 && r < rows as isize {
                    let idx = (r as usize) * cols + (c as usize);
                    let dist_sq = (dc as f64).powi(2) + (dr as f64).powi(2);
                    let falloff = (-dist_sq / 2.0).exp();
                    let w = weight * falloff;
                    let (sum_h, total_w) = grid_accum[idx];
                    grid_accum[idx] = (sum_h + h * w, total_w + w);
                    if grid_accum[idx].1 > max_w_seen { max_w_seen = grid_accum[idx].1; }
                }
            }
        }
    }

    web_sys::console::log_1(&format!("Max weight in grid: {:.4}", max_w_seen).into());

    // 7. Generate Mesh
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let mut vertex_map: std::collections::HashMap<(usize, usize), u32> = std::collections::HashMap::new();

    let up_f = Vector3::new(up.x as f32, up.y as f32, up.z as f32);
    let tangent_f = Vector3::new(tangent.x as f32, tangent.y as f32, tangent.z as f32);
    let bitangent_f = Vector3::new(bitangent.x as f32, bitangent.y as f32, bitangent.z as f32);

    for r in 0..rows {
        for c in 0..cols {
            let (sum_h, total_w) = grid_accum[r * cols + c];
            if total_w < 0.001 { continue; } 
            let avg_h = (sum_h / total_w) as f32;
            
            let corners = [(c, r), (c + 1, r), (c + 1, r + 1), (c, r + 1)];
            let mut cell_indices = [0u32; 4];
            for (i, (cc, rr)) in corners.iter().enumerate() {
                if let Some(&idx) = vertex_map.get(&(*cc, *rr)) {
                    cell_indices[i] = idx;
                } else {
                    let idx = (vertices.len() / 3) as u32;
                    let uu = (min_u + (*cc as f64) * cell_size) as f32;
                    let vv = (min_v + (*rr as f64) * cell_size) as f32;
                    let p_3d = uu * tangent_f + vv * bitangent_f + avg_h * up_f;
                    vertices.push(p_3d.x);
                    vertices.push(p_3d.y);
                    vertices.push(p_3d.z);
                    vertex_map.insert((*cc, *rr), idx);
                    cell_indices[i] = idx;
                }
            }
            indices.push(cell_indices[0]);
            indices.push(cell_indices[1]);
            indices.push(cell_indices[2]);
            indices.push(cell_indices[0]);
            indices.push(cell_indices[2]);
            indices.push(cell_indices[3]);
        }
    }

    web_sys::console::log_1(&format!("Final Mesh: {} vertices, {} indices", vertices.len()/3, indices.len()).into());
    ReconstructedMesh { vertices, indices }
}

fn reconstruct_plane_ransac(points: &[Point3<Real>]) -> ReconstructedMesh {
    let mut rng = rand::thread_rng();
    let n = points.len();
    if n < 3 {
         return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    let iterations = 2000;
    let threshold = 0.2; // Distance threshold for inliers (tunable)
    
    let mut best_plane: Option<Plane> = None;
    let mut max_inliers = 0;
    
    // RANSAC Loop
    for _ in 0..iterations {
        let idx1 = rng.gen_range(0..n);
        let idx2 = rng.gen_range(0..n);
        let idx3 = rng.gen_range(0..n);
        
        if idx1 == idx2 || idx2 == idx3 || idx1 == idx3 { continue; }
        
        if let Some(plane) = Plane::from_points(&points[idx1], &points[idx2], &points[idx3]) {
            let mut inliers = 0;
            for p in points {
                if plane.distance(p) < threshold {
                    inliers += 1;
                }
            }
            
            if inliers > max_inliers {
                max_inliers = inliers;
                best_plane = Some(plane);
            }
        }
    }
    
    if let Some(plane) = best_plane {
        web_sys::console::log_1(&format!("Plane Found! Inliers: {}/{}", max_inliers, n).into());
        // Generate quad from inliers
        generate_plane_mesh(&plane, points, threshold)
    } else {
        web_sys::console::log_1(&"No plane found.".into());
        ReconstructedMesh { vertices: vec![], indices: vec![] }
    }
}

fn generate_plane_mesh(plane: &Plane, points: &[Point3<Real>], threshold: Real) -> ReconstructedMesh {
    // 1. Create basis vectors
    let normal = plane.normal;
    // Find a tangent vector (perpendicular to normal)
    let mut tangent = if normal.x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    tangent = (tangent - normal * normal.dot(&tangent)).normalize();
    let bitangent = normal.cross(&tangent);
    
    // 2. Project inliers to 2D
    let mut min_u = Real::MAX;
    let mut max_u = Real::MIN;
    let mut min_v = Real::MAX;
    let mut max_v = Real::MIN;
    
    let mut center = Point3::origin();
    let mut count = 0;
    
    for p in points {
        if plane.distance(p) < threshold {
            let vec = p.coords;
            let u = vec.dot(&tangent);
            let v = vec.dot(&bitangent);
            
            if u < min_u { min_u = u; }
            if u > max_u { max_u = u; }
            if v < min_v { min_v = v; }
            if v > max_v { max_v = v; }
            
            center += vec;
            count += 1;
        }
    }

    if count == 0 { return ReconstructedMesh { vertices: vec![], indices: vec![] }; }
    
    // Compute Center of mass to anchor the plane better? 
    // Actually the basis projection handles it. The D component handles the offset.
    // Reconstruct 4 corners
    // Point = u * tangent + v * bitangent - d * normal?
    // Wait, Plane equation: Ax + By + Cz + D = 0 => N . P + D = 0 => P . N = -D
    // We need an origin point on the plane.
    // origin = -D * normal
    // let _origin = -plane.d * normal;
    
    let corners_uv = [
        (min_u, min_v),
        (max_u, min_v),
        (max_u, max_v),
        (min_u, max_v),
    ];
    
    let mut vertices = Vec::new();
    
    // We projected P . tangent = u. 
    // P = origin_plane + u * tangent + v * bitangent
    // BUT our u,v were calculated as P . tangent.
    // P = (P.t)t + (P.b)b + (P.n)n
    // Since points are ON plane (roughly), P.n = -d
    // So P approx = u*tangent + v*bitangent - d*normal 
    // This is correct reconstruction.
    
    for (u, v) in corners_uv {
        // The points were raw coordinates, so u = p . tangent.
        // Reconstructed P = u*tangent + v*bitangent + (p.normal)*normal
        // For the infinite plane, p.normal is constant? 
        // No, N . P + D = 0 -> N . P = -D.
        // So component along normal is -D.
        
        let p_rec = u * tangent + v * bitangent - plane.d * normal;
        vertices.push(p_rec.x as f32);
        vertices.push(p_rec.y as f32);
        vertices.push(p_rec.z as f32);
    }
    
    // Quad indices
    // 0, 1, 2
    // 0, 2, 3
    let indices = vec![0, 1, 2, 0, 2, 3];
    
    ReconstructedMesh {
        vertices,
        indices,
    }
}

fn reconstruct_poisson(p_coords: &[Point3<Real>], p_normals: &[Vector3<Real>]) -> ReconstructedMesh {
    web_sys::console::log_1(&"Running Poisson algorithm (depth=4)...".into());
    let poisson = PoissonReconstruction::from_points_and_normals(
        p_coords,
        p_normals,
        0.0, 4, 4, 10,
    );
        
    let mesh_buffers = poisson.reconstruct_mesh_buffers();
    
    let mut vertices = Vec::new();
    let mut indices = Vec::new();

    for v in mesh_buffers.vertices() {
         vertices.push(v.x as f32);
         vertices.push(v.y as f32);
         vertices.push(v.z as f32);
    }
    
    for i in mesh_buffers.indices() {
        indices.push(*i as u32);
    }

    ReconstructedMesh { vertices, indices }
}
