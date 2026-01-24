// use wasm_bindgen::prelude::*;
use crate::splat::PointNormal;
use poisson_reconstruction::{PoissonReconstruction, Real};
use nalgebra::{Point3, Vector3, UnitQuaternion};
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
    
    // Configurable thresholds for walkable mesh
    let min_face_up_dot = 0.7_f32; // cos(45°) - faces must be roughly horizontal
    let min_vertex_weight = 0.01_f64; // Minimum coverage for a vertex to be valid

    web_sys::console::log_1(&format!("NavMesh Params: Target={}, Alpha={:.2}, Scale={:.1}, Align={:.2}, RANSAC={:.2}", 
        voxel_target, min_alpha, max_scale, normal_align, ransac_thresh).into());

    if points.is_empty() {
        return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    // 1. Transform Points and Apply Robust Filter
    // We apply the user's requested rotation to all points before processing.
    // This aligns the splat with the intended "ground" orientation.
    let rot_matrix = if let Some(ref rot) = settings.rotation {
        if rot.len() == 3 {
             // Babylon uses Pitch(X), Yaw(Y), Roll(Z). 
             // In nalgebra, from_euler_angles(x, y, z) applies them in that order.
             let q = UnitQuaternion::from_euler_angles(rot[0] as Real, rot[1] as Real, rot[2] as Real);
             Some(q.to_rotation_matrix())
        } else { None }
    } else { None };

    if let (Some(min), Some(max)) = (&settings.region_min, &settings.region_max) {
        web_sys::console::log_1(&format!("Region Filter Active: Min({:.2},{:.2},{:.2}), Max({:.2},{:.2},{:.2})", 
            min[0], min[1], min[2], max[0], max[1], max[2]).into());
    }

    let mut discarded_by_region = 0;
    let mut oriented_points: Vec<PointNormal> = Vec::with_capacity(points.len());

    for p in points {
        // Transform point and normal
        let mut pt = Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real);
        let mut norm = Vector3::new(p.normal.x as Real, p.normal.y as Real, p.normal.z as Real);
        
        if let Some(ref m) = rot_matrix {
            pt = m.transform_point(&pt);
            norm = m.transform_vector(&norm);
        }

        // Region Filter (Applied in oriented space)
        if let (Some(min), Some(max)) = (&settings.region_min, &settings.region_max) {
            if min.len() == 3 && max.len() == 3 {
                // Match Babylon Y-flip for comparison
                // IMPORTANT: We negate Y because our generation export negates Y to fit Babylon's left-hand space.
                let babylon_x = pt.x as f64;
                let babylon_y = -(pt.y as f64);
                let babylon_z = pt.z as f64;

                if babylon_x < min[0] || babylon_x > max[0] ||
                   babylon_y < min[1] || babylon_y > max[1] ||
                   babylon_z < min[2] || babylon_z > max[2] {
                    discarded_by_region += 1;
                    continue;
                }
            }
        }

        // Floater/Transparency filters
        if p.opacity <= min_alpha || 
           p.scale.x >= max_scale || p.scale.y >= max_scale || p.scale.z >= max_scale {
            continue;
        }

        oriented_points.push(PointNormal {
            point: Point3::new(pt.x as f64, pt.y as f64, pt.z as f64),
            normal: Vector3::new(norm.x as f64, norm.y as f64, norm.z as f64),
            scale: p.scale,
            opacity: p.opacity,
        });
    }

    web_sys::console::log_1(&format!("Region filter discarded {} points.", discarded_by_region).into());
    web_sys::console::log_1(&format!("Points after orientation/floater/region filter: {}/{}", oriented_points.len(), points.len()).into());

    if oriented_points.is_empty() {
        return ReconstructedMesh { vertices: vec![], indices: vec![] };
    }

    // 2. Find Dominant Plane via RANSAC
    let p_coords: Vec<Point3<Real>> = oriented_points.iter()
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
        web_sys::console::log_1(&format!("Aligned Ground Normal: ({:.3}, {:.3}, {:.3})", normal.x, normal.y, normal.z).into());
        normal
    } else {
        web_sys::console::log_1(&"RANSAC failed, falling back to +Y".into());
        Vector3::new(0.0, 1.0, 0.0)
    };

    // 3. Create Orthonormal Basis aligned to ground plane
    let mut tangent = if up.x.abs() < 0.9 { Vector3::new(1.0, 0.0, 0.0) } else { Vector3::new(0.0, 1.0, 0.0) };
    tangent = (tangent - up * up.dot(&tangent)).normalize();
    let bitangent = up.cross(&tangent);

    // 4. Compute bounding box in projected (u, v) space
    let tangent_64 = Vector3::new(tangent.x as f64, tangent.y as f64, tangent.z as f64);
    let bitangent_64 = Vector3::new(bitangent.x as f64, bitangent.y as f64, bitangent.z as f64);
    let up_64 = Vector3::new(up.x as f64, up.y as f64, up.z as f64);

    let mut min_u = f64::MAX;
    let mut max_u = f64::MIN;
    let mut min_v = f64::MAX;
    let mut max_v = f64::MIN;

    for p in &oriented_points {
        let u = p.point.coords.dot(&tangent_64);
        let v = p.point.coords.dot(&bitangent_64);
        min_u = min_u.min(u);
        max_u = max_u.max(u);
        min_v = min_v.min(v);
        max_v = max_v.max(v);
    }

    // 5. Grid configuration
    let width = max_u - min_u;
    let depth = max_v - min_v;
    let mut cell_size = (width * depth / voxel_target).sqrt();
    cell_size = cell_size.clamp(0.05, 2.0);

    let cols = (width / cell_size).ceil() as usize;
    let rows = (depth / cell_size).ceil() as usize;
    
    // KEY FIX: Store heights PER-VERTEX (grid corners), not per-cell
    // Grid has (cols+1) x (rows+1) vertices
    let num_verts = (cols + 1) * (rows + 1);
    let mut vertex_accum: Vec<(f64, f64)> = vec![(0.0, 0.0); num_verts]; // (sum_height, total_weight)

    web_sys::console::log_1(&format!("Grid: {}x{} cells, cell_size={:.3}, {} vertex slots", cols, rows, cell_size, num_verts).into());

    // 6. Splat point heights to VERTICES using bilinear weights
    let mut points_contributed = 0;
    
    for p in &oriented_points {
        // Check normal alignment - only ground-facing splats
        let normal_dot = p.normal.dot(&up_64).abs();
        if normal_dot < normal_align { continue; }

        let u = p.point.coords.dot(&tangent_64);
        let v = p.point.coords.dot(&bitangent_64);
        let h = p.point.coords.dot(&up_64);

        // Normalized grid coordinates
        let u_norm = (u - min_u) / cell_size;
        let v_norm = (v - min_v) / cell_size;
        
        // Find which cell this point is in
        let col = u_norm.floor() as isize;
        let row = v_norm.floor() as isize;
        
        // Bilinear interpolation weights (for future refinement)
        let _u_frac = u_norm - col as f64;
        let _v_frac = v_norm - row as f64;
        
        // Weight based on opacity and normal alignment
        let base_weight = p.opacity * normal_dot * normal_dot;
        
        // Splat to surrounding area based on scale
        let scale_avg = (p.scale.x + p.scale.y + p.scale.z) / 3.0;
        let radius = (scale_avg / cell_size).ceil() as isize;
        let radius = radius.clamp(0, 3);
        
        for dr in -radius..=radius {
            for dc in -radius..=radius {
                let c = col + dc;
                let r = row + dr;
                
                if c < 0 || c > cols as isize || r < 0 || r > rows as isize {
                    continue;
                }
                
                let idx = (r as usize) * (cols + 1) + (c as usize);
                
                // Distance falloff from splat center
                let du = (c as f64) - u_norm;
                let dv = (r as f64) - v_norm;
                let dist_sq = du * du + dv * dv;
                let falloff = (-dist_sq * 0.5).exp();
                
                let w = base_weight * falloff;
                vertex_accum[idx].0 += h * w;
                vertex_accum[idx].1 += w;
            }
        }
        points_contributed += 1;
    }

    web_sys::console::log_1(&format!("Points contributing to grid: {}", points_contributed).into());

    // 7. Compute final vertex heights and track valid vertices
    let mut vertex_heights: Vec<Option<f32>> = vec![None; num_verts];
    let mut valid_vertex_count = 0;
    
    for i in 0..num_verts {
        let (sum_h, total_w) = vertex_accum[i];
        if total_w >= min_vertex_weight {
            vertex_heights[i] = Some((sum_h / total_w) as f32);
            valid_vertex_count += 1;
        }
    }

    web_sys::console::log_1(&format!("Valid vertices with coverage: {}/{}", valid_vertex_count, num_verts).into());

    // 8. Generate mesh - only emit faces where ALL 4 corners have valid height
    let mut vertices: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut vertex_index_map: std::collections::HashMap<usize, u32> = std::collections::HashMap::new();
    
    let tangent_f = Vector3::new(tangent.x as f32, tangent.y as f32, tangent.z as f32);
    let bitangent_f = Vector3::new(bitangent.x as f32, bitangent.y as f32, bitangent.z as f32);
    let up_f = Vector3::new(up.x as f32, up.y as f32, up.z as f32);
    
    let mut faces_generated = 0;
    let mut faces_rejected_coverage = 0;
    let mut faces_rejected_steep = 0;

    for row in 0..rows {
        for col in 0..cols {
            // 4 corner vertices of this cell
            let v00 = row * (cols + 1) + col;           // bottom-left
            let v10 = row * (cols + 1) + col + 1;       // bottom-right
            let v11 = (row + 1) * (cols + 1) + col + 1; // top-right
            let v01 = (row + 1) * (cols + 1) + col;     // top-left
            
            // Check all 4 corners have valid height
            let h00 = match vertex_heights[v00] { Some(h) => h, None => { faces_rejected_coverage += 1; continue; } };
            let h10 = match vertex_heights[v10] { Some(h) => h, None => { faces_rejected_coverage += 1; continue; } };
            let h11 = match vertex_heights[v11] { Some(h) => h, None => { faces_rejected_coverage += 1; continue; } };
            let h01 = match vertex_heights[v01] { Some(h) => h, None => { faces_rejected_coverage += 1; continue; } };
            
            // Compute 3D positions
            let u0 = (min_u + (col as f64) * cell_size) as f32;
            let u1 = (min_u + ((col + 1) as f64) * cell_size) as f32;
            let v0 = (min_v + (row as f64) * cell_size) as f32;
            let v1 = (min_v + ((row + 1) as f64) * cell_size) as f32;
            
            let p00 = u0 * tangent_f + v0 * bitangent_f + h00 * up_f;
            let p10 = u1 * tangent_f + v0 * bitangent_f + h10 * up_f;
            let p11 = u1 * tangent_f + v1 * bitangent_f + h11 * up_f;
            let p01 = u0 * tangent_f + v1 * bitangent_f + h01 * up_f;
            
            // Check face normals - both triangles must face upward
            // Triangle 1: p00, p10, p11
            let edge1_a = p10 - p00;
            let edge2_a = p11 - p00;
            let normal_a = edge1_a.cross(&edge2_a);
            let normal_a_len = normal_a.magnitude();
            
            // Triangle 2: p00, p11, p01
            let edge1_b = p11 - p00;
            let edge2_b = p01 - p00;
            let normal_b = edge1_b.cross(&edge2_b);
            let normal_b_len = normal_b.magnitude();
            
            if normal_a_len < 1e-6 || normal_b_len < 1e-6 {
                faces_rejected_steep += 1;
                continue; // Degenerate triangle
            }
            
            let normal_a_unit = normal_a / normal_a_len;
            let normal_b_unit = normal_b / normal_b_len;
            
            // Check if faces point upward enough (dot with up vector)
            let dot_a = normal_a_unit.dot(&up_f);
            let dot_b = normal_b_unit.dot(&up_f);
            
            if dot_a < min_face_up_dot || dot_b < min_face_up_dot {
                faces_rejected_steep += 1;
                continue; // Face too steep or pointing wrong way
            }
            
            // Get or create vertex indices
            let mut get_or_create_vertex = |grid_idx: usize, pos: Vector3<f32>| -> u32 {
                if let Some(&idx) = vertex_index_map.get(&grid_idx) {
                    idx
                } else {
                    let idx = (vertices.len() / 3) as u32;
                    // Babylon.js uses left-handed coords - negate Y for correct vertical orientation
                    vertices.push(pos.x);
                    vertices.push(-pos.y);  // Flip Y for left-handed system
                    vertices.push(pos.z);
                    vertex_index_map.insert(grid_idx, idx);
                    idx
                }
            };
            
            let i00 = get_or_create_vertex(v00, p00);
            let i10 = get_or_create_vertex(v10, p10);
            let i11 = get_or_create_vertex(v11, p11);
            let i01 = get_or_create_vertex(v01, p01);
            
            // Emit two triangles for this quad (clockwise winding for left-handed Babylon.js)
            indices.push(i00);
            indices.push(i11);
            indices.push(i10);
            
            indices.push(i00);
            indices.push(i01);
            indices.push(i11);
            
            faces_generated += 2;
        }
    }

    web_sys::console::log_1(&format!("Faces: {} generated, {} rejected (no coverage), {} rejected (too steep)", 
        faces_generated, faces_rejected_coverage, faces_rejected_steep).into());

    // 9. Connected component filter - keep only the largest connected region
    let (filtered_vertices, filtered_indices) = filter_largest_connected_component(&vertices, &indices);

    web_sys::console::log_1(&format!("After connectivity filter: {} vertices, {} faces", 
        filtered_vertices.len() / 3, filtered_indices.len() / 3).into());

    ReconstructedMesh { 
        vertices: filtered_vertices, 
        indices: filtered_indices 
    }
}

/// Filters triangles to keep only the largest connected component
fn filter_largest_connected_component(vertices: &[f32], indices: &[u32]) -> (Vec<f32>, Vec<u32>) {
    if indices.is_empty() {
        return (vertices.to_vec(), indices.to_vec());
    }

    let num_faces = indices.len() / 3;
    let num_verts = vertices.len() / 3;
    
    // Build adjacency: for each vertex, which faces touch it
    let mut vertex_to_faces: Vec<Vec<usize>> = vec![Vec::new(); num_verts];
    for (face_idx, chunk) in indices.chunks(3).enumerate() {
        for &vi in chunk {
            vertex_to_faces[vi as usize].push(face_idx);
        }
    }
    
    // Build face adjacency: two faces are adjacent if they share a vertex
    let mut face_neighbors: Vec<Vec<usize>> = vec![Vec::new(); num_faces];
    for (face_idx, chunk) in indices.chunks(3).enumerate() {
        let mut neighbors: std::collections::HashSet<usize> = std::collections::HashSet::new();
        for &vi in chunk {
            for &other_face in &vertex_to_faces[vi as usize] {
                if other_face != face_idx {
                    neighbors.insert(other_face);
                }
            }
        }
        face_neighbors[face_idx] = neighbors.into_iter().collect();
    }
    
    // Find connected components via flood fill
    let mut face_component: Vec<i32> = vec![-1; num_faces];
    let mut component_sizes: Vec<usize> = Vec::new();
    let mut current_component = 0;
    
    for start_face in 0..num_faces {
        if face_component[start_face] >= 0 { continue; }
        
        // BFS from this face
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(start_face);
        face_component[start_face] = current_component;
        let mut size = 0;
        
        while let Some(face) = queue.pop_front() {
            size += 1;
            for &neighbor in &face_neighbors[face] {
                if face_component[neighbor] < 0 {
                    face_component[neighbor] = current_component;
                    queue.push_back(neighbor);
                }
            }
        }
        
        component_sizes.push(size);
        current_component += 1;
    }
    
    // Find largest component
    let largest_component = component_sizes.iter()
        .enumerate()
        .max_by_key(|&(_, size)| size)
        .map(|(idx, _)| idx as i32)
        .unwrap_or(0);
    
    web_sys::console::log_1(&format!("Found {} connected components, largest has {} faces", 
        component_sizes.len(), component_sizes.get(largest_component as usize).unwrap_or(&0)).into());
    
    // Rebuild mesh with only faces from largest component
    let mut new_indices: Vec<u32> = Vec::new();
    let mut used_verts: std::collections::HashSet<u32> = std::collections::HashSet::new();
    
    for (face_idx, chunk) in indices.chunks(3).enumerate() {
        if face_component[face_idx] == largest_component {
            for &vi in chunk {
                used_verts.insert(vi);
                new_indices.push(vi);
            }
        }
    }
    
    // Compact vertices (remap to new indices)
    let mut old_to_new: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut new_vertices: Vec<f32> = Vec::new();
    
    let mut sorted_verts: Vec<u32> = used_verts.into_iter().collect();
    sorted_verts.sort();
    
    for old_idx in sorted_verts {
        let new_idx = (new_vertices.len() / 3) as u32;
        old_to_new.insert(old_idx, new_idx);
        let base = (old_idx as usize) * 3;
        new_vertices.push(vertices[base]);
        new_vertices.push(vertices[base + 1]);
        new_vertices.push(vertices[base + 2]);
    }
    
    // Remap indices
    let remapped_indices: Vec<u32> = new_indices.iter()
        .map(|&old| *old_to_new.get(&old).unwrap_or(&0))
        .collect();
    
    (new_vertices, remapped_indices)
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
