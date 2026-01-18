use wasm_bindgen::prelude::*;
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

pub fn reconstruct_mesh(points: &[PointNormal], mode: u8) -> ReconstructedMesh {
    web_sys::console::log_1(&format!("Reconstructing mesh (Mode: {})...", mode).into());

    let mut p_coords = Vec::new();
    let mut p_normals = Vec::new();

    // Downsample for RANSAC speed (and Poisson stability)
    let target_count = if mode == 0 { 500 } else { 5000 }; 
    let stride = if points.len() > target_count { points.len() / target_count } else { 1 };
    
    for (i, p) in points.iter().enumerate() {
        if i % stride == 0 {
             if p.point.x.is_nan() || p.point.y.is_nan() || p.point.z.is_nan() { continue; }
             p_coords.push(Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real));
             p_normals.push(Vector3::new(p.normal.x as Real, p.normal.y as Real, p.normal.z as Real));
        }
    }
    
    if p_coords.is_empty() {
        return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    if mode == 1 {
        // Single Plane Detection (RANSAC)
        return reconstruct_plane_ransac(&p_coords);
    } else {
        // Mode 0: Default Poisson
         return reconstruct_poisson(&p_coords, &p_normals);
    }
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
    let origin = -plane.d * normal;
    
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
