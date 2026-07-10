use crate::splat::PointNormal;
use crate::{
    CollisionVoxelBoundaryResult, CoordinateSpace, FieldBasis, FloorPlane, GroundFieldCell,
    GroundFieldCellState, MeshBuffers, MeshSettings, NavmeshBasisResult, ReconstructionDiagnostics,
    ReconstructionResult, SplatBounds, SuggestedRegion, WalkableGroundFieldResult,
};
use nalgebra::{Point3, UnitQuaternion, Vector3};
use poisson_reconstruction::{PoissonReconstruction, Real};
use rand::Rng;

#[derive(Debug)]
pub struct ReconstructedMesh {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
}

#[derive(Clone)]
struct Plane {
    normal: Vector3<Real>,
    d: Real,
}

impl Plane {
    fn from_points(p1: &Point3<Real>, p2: &Point3<Real>, p3: &Point3<Real>) -> Option<Self> {
        let v1 = p2 - p1;
        let v2 = p3 - p1;
        let cross = v1.cross(&v2);

        if cross.magnitude() < 1e-6 {
            return None;
        }

        let normal = cross.normalize();
        let d = -normal.dot(&p1.coords);
        Some(Plane { normal, d })
    }

    fn distance(&self, p: &Point3<Real>) -> Real {
        (self.normal.dot(&p.coords) + self.d).abs()
    }
}

#[derive(Clone)]
struct ReconstructionContext {
    oriented_points: Vec<PointNormal>,
    filtered_points: Vec<PointNormal>,
    diagnostics: ReconstructionDiagnostics,
}

struct FieldBuild {
    cells: Vec<GroundFieldCell>,
    width: usize,
    height: usize,
    cell_size: f64,
    basis: FieldBasis,
    plane: FloorPlane,
    diagnostics: ReconstructionDiagnostics,
}

struct CollisionBuild {
    mesh: ReconstructedMesh,
    basis: FieldBasis,
    plane: FloorPlane,
    diagnostics: ReconstructionDiagnostics,
}

#[derive(Clone, Copy)]
struct VoxelGrid {
    min: Vector3<f64>,
    dims: [usize; 3],
    voxel_size: f64,
}

impl VoxelGrid {
    fn len(&self) -> usize {
        self.dims[0] * self.dims[1] * self.dims[2]
    }

    fn idx(&self, x: usize, y: usize, z: usize) -> usize {
        (y * self.dims[2] + z) * self.dims[0] + x
    }

    fn coords(&self, idx: usize) -> (usize, usize, usize) {
        let x = idx % self.dims[0];
        let yz = idx / self.dims[0];
        let z = yz % self.dims[2];
        let y = yz / self.dims[2];
        (x, y, z)
    }

    fn center(&self, x: usize, y: usize, z: usize) -> Vector3<f64> {
        self.min
            + Vector3::new(
                (x as f64 + 0.5) * self.voxel_size,
                (y as f64 + 0.5) * self.voxel_size,
                (z as f64 + 0.5) * self.voxel_size,
            )
    }

    fn point_to_voxel(&self, p: &Vector3<f64>) -> Option<(usize, usize, usize)> {
        let rel = (p - self.min) / self.voxel_size;
        let x = rel.x.floor() as isize;
        let y = rel.y.floor() as isize;
        let z = rel.z.floor() as isize;
        if x < 0
            || y < 0
            || z < 0
            || x >= self.dims[0] as isize
            || y >= self.dims[1] as isize
            || z >= self.dims[2] as isize
        {
            return None;
        }
        Some((x as usize, y as usize, z as usize))
    }
}

pub fn get_splat_bounds(
    points: &[PointNormal],
    settings: &MeshSettings,
) -> Result<SplatBounds, wasm_bindgen::JsValue> {
    let context = build_context(points, settings);
    let min = context
        .diagnostics
        .oriented_min
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("No valid oriented points for bounds"))?;
    let max = context
        .diagnostics
        .oriented_max
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("No valid oriented points for bounds"))?;
    let floor_y = context.diagnostics.floor_y_percentile_02.unwrap_or(min[1]);

    Ok(SplatBounds {
        api_version: crate::API_VERSION,
        semver: crate::core_semver(),
        capabilities: crate::capabilities(),
        point_count: context.oriented_points.len(),
        oriented_min: min,
        oriented_max: max,
        floor_y_percentile_02: floor_y,
        space: CoordinateSpace::splatwalk_oriented(),
    })
}

pub fn suggest_region(
    points: &[PointNormal],
    settings: &MeshSettings,
) -> Result<SuggestedRegion, wasm_bindgen::JsValue> {
    let bounds = get_splat_bounds(points, settings)?;
    let desired_height = 2.0_f64;
    let available_height = (bounds.oriented_max[1] - bounds.oriented_min[1]).max(0.0);
    let region_height = desired_height.min(available_height);
    let floor_y = bounds.floor_y_percentile_02;
    let region_min_y = bounds.oriented_min[1].min(floor_y);

    Ok(SuggestedRegion {
        api_version: crate::API_VERSION,
        semver: crate::core_semver(),
        capabilities: crate::capabilities(),
        region_min: [bounds.oriented_min[0], region_min_y, bounds.oriented_min[2]],
        region_max: [
            bounds.oriented_max[0],
            region_min_y + region_height,
            bounds.oriented_max[2],
        ],
        floor_y,
        sample_count: bounds.point_count,
        clamped_height: region_height < desired_height,
        space: CoordinateSpace::splatwalk_oriented(),
    })
}

pub fn reconstruct_mesh(points: &[PointNormal], settings: &MeshSettings) -> ReconstructionResult {
    let mode = settings.mode;
    web_sys::console::log_1(&format!("Reconstructing mesh (Mode: {})...", mode).into());

    let context = build_context(points, settings);
    let mut diagnostics = context.diagnostics.clone();

    let mesh = if context.filtered_points.is_empty() {
        ReconstructedMesh {
            vertices: vec![],
            indices: vec![],
        }
    } else if mode == 1 {
        reconstruct_plane_ransac(&context.filtered_points, &mut diagnostics)
    } else if mode == 2 {
        reconstruct_voxel_navmesh(&context, settings, &mut diagnostics)
    } else {
        reconstruct_poisson(&context.filtered_points)
    };

    ReconstructionResult {
        api_version: crate::API_VERSION,
        semver: crate::core_semver(),
        capabilities: crate::capabilities(),
        mesh: MeshBuffers::new(mesh.vertices, mesh.indices),
        space: CoordinateSpace::splatwalk_oriented(),
        diagnostics,
    }
}

pub fn convert_splat_to_navmesh_basis(
    points: &[PointNormal],
    settings: &MeshSettings,
) -> NavmeshBasisResult {
    let context = build_context(points, settings);
    let mut diagnostics = context.diagnostics.clone();
    let collision = build_collision_mesh(&context, settings, &mut diagnostics);
    let (mesh, basis, plane, diagnostics) = if let Some(collision) = collision {
        (
            collision.mesh,
            collision.basis,
            collision.plane,
            collision.diagnostics,
        )
    } else {
        (
            ReconstructedMesh {
                vertices: vec![],
                indices: vec![],
            },
            default_field_basis(),
            FloorPlane {
                normal: [0.0, 1.0, 0.0],
                d: 0.0,
            },
            diagnostics,
        )
    };

    NavmeshBasisResult {
        api_version: crate::API_VERSION,
        semver: crate::core_semver(),
        capabilities: crate::capabilities(),
        mesh: MeshBuffers::new(mesh.vertices, mesh.indices),
        space: CoordinateSpace::splatwalk_oriented(),
        basis,
        floor_plane: plane,
        diagnostics,
    }
}

pub fn build_collision_voxel_boundary(
    points: &[PointNormal],
    settings: &MeshSettings,
) -> CollisionVoxelBoundaryResult {
    let context = build_context(points, settings);
    let mut diagnostics = context.diagnostics.clone();
    let collision = build_collision_mesh(&context, settings, &mut diagnostics);
    let (mesh, basis, plane, diagnostics) = if let Some(collision) = collision {
        (
            collision.mesh,
            collision.basis,
            collision.plane,
            collision.diagnostics,
        )
    } else {
        (
            ReconstructedMesh {
                vertices: vec![],
                indices: vec![],
            },
            default_field_basis(),
            FloorPlane {
                normal: [0.0, 1.0, 0.0],
                d: 0.0,
            },
            diagnostics,
        )
    };

    CollisionVoxelBoundaryResult {
        api_version: crate::API_VERSION,
        semver: crate::core_semver(),
        capabilities: crate::capabilities(),
        mesh: MeshBuffers::new(mesh.vertices, mesh.indices),
        glb: None,
        space: CoordinateSpace::splatwalk_oriented(),
        basis,
        floor_plane: plane,
        diagnostics,
    }
}

pub fn build_walkable_ground_field(
    points: &[PointNormal],
    settings: &MeshSettings,
) -> Result<WalkableGroundFieldResult, wasm_bindgen::JsValue> {
    let context = build_context(points, settings);
    let mut diagnostics = context.diagnostics.clone();
    let field = build_field(&context, settings, &mut diagnostics)
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("Unable to build walkable ground field"))?;

    Ok(WalkableGroundFieldResult {
        api_version: crate::API_VERSION,
        semver: crate::core_semver(),
        capabilities: crate::capabilities(),
        cells: field.cells,
        width: field.width,
        height: field.height,
        cell_size: field.cell_size,
        basis: field.basis,
        floor_plane: field.plane,
        space: CoordinateSpace::splatwalk_oriented(),
        diagnostics: field.diagnostics,
    })
}

fn default_field_basis() -> FieldBasis {
    FieldBasis {
        origin: [0.0, 0.0, 0.0],
        tangent: [1.0, 0.0, 0.0],
        bitangent: [0.0, 0.0, 1.0],
        up: [0.0, 1.0, 0.0],
    }
}

fn environment_scale(settings: &MeshSettings) -> f64 {
    match settings.environment_scale {
        Some(s) if s.is_finite() && s > 0.0 => s,
        _ => 1.0,
    }
}

fn build_context(points: &[PointNormal], settings: &MeshSettings) -> ReconstructionContext {
    let min_alpha = settings.min_alpha.unwrap_or(0.05);
    let max_scale = settings.max_scale.unwrap_or(5.0);
    let env_scale = environment_scale(settings);
    // Filter against authoring-space gaussian scales; positions/scales are then
    // multiplied by env_scale so world-space bake matches the renderer.
    let max_scale_world = max_scale * env_scale;
    let rot_matrix = settings.rotation.as_ref().and_then(|rot| {
        if rot.len() == 3 {
            let q =
                UnitQuaternion::from_euler_angles(rot[0] as Real, rot[1] as Real, rot[2] as Real);
            Some(q.to_rotation_matrix())
        } else {
            None
        }
    });

    let mut diagnostics = ReconstructionDiagnostics::empty(points.len());
    diagnostics.region_min = settings.region_min.clone();
    diagnostics.region_max = settings.region_max.clone();

    let mut oriented_points = Vec::with_capacity(points.len());
    let mut y_values = Vec::with_capacity(points.len());
    let mut min = [f64::MAX; 3];
    let mut max = [f64::MIN; 3];

    for p in points {
        if !p.point.x.is_finite() || !p.point.y.is_finite() || !p.point.z.is_finite() {
            diagnostics.points_invalid += 1;
            continue;
        }

        let mut pt = Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real);
        let mut norm = Vector3::new(p.normal.x as Real, p.normal.y as Real, p.normal.z as Real);

        if let Some(ref m) = rot_matrix {
            pt = m.transform_point(&pt);
            norm = m.transform_vector(&norm);
        }

        let oriented = PointNormal {
            point: Point3::new(
                pt.x as f64 * env_scale,
                pt.y as f64 * env_scale,
                pt.z as f64 * env_scale,
            ),
            normal: Vector3::new(norm.x as f64, norm.y as f64, norm.z as f64),
            scale: Vector3::new(
                p.scale.x * env_scale,
                p.scale.y * env_scale,
                p.scale.z * env_scale,
            ),
            opacity: p.opacity,
        };

        let coords = [oriented.point.x, oriented.point.y, oriented.point.z];
        for axis in 0..3 {
            min[axis] = min[axis].min(coords[axis]);
            max[axis] = max[axis].max(coords[axis]);
        }
        y_values.push(oriented.point.y);
        oriented_points.push(oriented);
    }

    if !oriented_points.is_empty() {
        diagnostics.oriented_min = Some(min);
        diagnostics.oriented_max = Some(max);
        diagnostics.floor_y_percentile_02 = Some(percentile(&mut y_values, 0.02));
    }

    let mut filtered_points = Vec::with_capacity(oriented_points.len());

    for p in &oriented_points {
        if let (Some(region_min), Some(region_max)) = (&settings.region_min, &settings.region_max) {
            if region_min.len() == 3 && region_max.len() == 3 {
                if p.point.x < region_min[0]
                    || p.point.x > region_max[0]
                    || p.point.y < region_min[1]
                    || p.point.y > region_max[1]
                    || p.point.z < region_min[2]
                    || p.point.z > region_max[2]
                {
                    diagnostics.points_region_discarded += 1;
                    continue;
                }
            }
        }

        if p.opacity <= min_alpha
            || p.scale.x >= max_scale_world
            || p.scale.y >= max_scale_world
            || p.scale.z >= max_scale_world
        {
            continue;
        }

        filtered_points.push(p.clone());
    }

    diagnostics.points_after_filter = filtered_points.len();

    ReconstructionContext {
        oriented_points,
        filtered_points,
        diagnostics,
    }
}

fn percentile(values: &mut [f64], p: f64) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if values.is_empty() {
        return 0.0;
    }

    let idx = ((values.len() - 1) as f64 * p.clamp(0.0, 1.0)).round() as usize;
    values[idx]
}

fn reconstruct_voxel_navmesh(
    context: &ReconstructionContext,
    settings: &MeshSettings,
    diagnostics: &mut ReconstructionDiagnostics,
) -> ReconstructedMesh {
    let Some(collision) = build_collision_mesh(context, settings, diagnostics) else {
        return ReconstructedMesh {
            vertices: vec![],
            indices: vec![],
        };
    };

    *diagnostics = collision.diagnostics;
    collision.mesh
}

fn build_collision_mesh(
    context: &ReconstructionContext,
    settings: &MeshSettings,
    diagnostics: &mut ReconstructionDiagnostics,
) -> Option<CollisionBuild> {
    let points = &context.filtered_points;
    if points.is_empty() {
        diagnostics.collision_failure_reason = Some("no_filtered_points".to_string());
        return None;
    }

    let min = diagnostics.oriented_min?;
    let max = diagnostics.oriented_max?;
    let bounds_min = Vector3::new(min[0], min[1], min[2]);
    let bounds_max = Vector3::new(max[0], max[1], max[2]);
    let mut voxel_size = settings
        .collision_voxel_size
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.08)
        .clamp(0.025, 0.5);
    let padding = settings.collision_fill_size.unwrap_or(1.2).max(0.3);
    let max_voxels = 1_500_000usize;

    let grid = loop {
        let padded_min = bounds_min - Vector3::new(padding, padding, padding);
        let padded_max = bounds_max + Vector3::new(padding, padding, padding);
        let extent = padded_max - padded_min;
        let dims = [
            (extent.x / voxel_size).ceil().max(1.0) as usize + 1,
            (extent.y / voxel_size).ceil().max(1.0) as usize + 1,
            (extent.z / voxel_size).ceil().max(1.0) as usize + 1,
        ];
        let grid = VoxelGrid {
            min: padded_min,
            dims,
            voxel_size,
        };
        if grid.len() <= max_voxels || voxel_size >= 0.5 {
            break grid;
        }
        voxel_size *= 1.25;
    };

    let threshold = settings
        .collision_opacity_threshold
        .unwrap_or(0.1)
        .max(0.001);
    let mut density = vec![0.0_f64; grid.len()];
    for p in points {
        let center = Vector3::new(p.point.x, p.point.y, p.point.z);
        let scale_avg = ((p.scale.x + p.scale.y + p.scale.z) / 3.0).max(voxel_size * 0.5);
        let radius = (scale_avg * 2.5).max(voxel_size).min(voxel_size * 6.0);
        let Some((cx, cy, cz)) = grid.point_to_voxel(&center) else {
            continue;
        };
        let vr = (radius / voxel_size).ceil() as isize;

        for y in (cy as isize - vr).max(0)..=(cy as isize + vr).min(grid.dims[1] as isize - 1) {
            for z in (cz as isize - vr).max(0)..=(cz as isize + vr).min(grid.dims[2] as isize - 1) {
                for x in
                    (cx as isize - vr).max(0)..=(cx as isize + vr).min(grid.dims[0] as isize - 1)
                {
                    let voxel_center = grid.center(x as usize, y as usize, z as usize);
                    let dist_sq = (voxel_center - center).norm_squared();
                    if dist_sq > radius * radius {
                        continue;
                    }
                    let falloff = (-dist_sq / (2.0 * radius * radius)).exp();
                    let idx = grid.idx(x as usize, y as usize, z as usize);
                    density[idx] += p.opacity.max(0.0) * falloff;
                }
            }
        }
    }

    let mut solid = density
        .iter()
        .map(|v| *v >= threshold)
        .collect::<Vec<bool>>();
    let occupied_before = solid.iter().filter(|&&v| v).count();
    if occupied_before == 0 {
        diagnostics.collision_failure_reason = Some("no_occupied_voxels".to_string());
        return None;
    }

    let seed = collision_seed(settings, diagnostics, &grid);
    diagnostics.collision_seed_used = Some([seed.x, seed.y, seed.z]);
    diagnostics.collision_seed_state = seed_state(
        &grid,
        &solid,
        seed,
        settings.collision_carve_height.unwrap_or(1.6),
        settings.collision_carve_radius.unwrap_or(0.25),
    );
    let (cluster_kept, cluster_discarded) = filter_occupied_seed_cluster(&grid, &mut solid, seed);
    let scene_type = settings
        .collision_scene_type
        .as_deref()
        .unwrap_or("outdoor")
        .to_string();
    let (filled, external_fill_leaked) = apply_collision_fill(
        &grid,
        &mut solid,
        &scene_type,
        settings.collision_fill_size.unwrap_or(1.2),
        seed,
    );
    let reachable = carve_reachable_empty(
        &grid,
        &solid,
        seed,
        settings.collision_carve_height.unwrap_or(1.6),
        settings.collision_carve_radius.unwrap_or(0.25),
    );
    let carved = reachable.iter().filter(|&&v| v).count();
    if carved == 0 {
        diagnostics.collision_failure_reason =
            Some("seed_not_reachable_or_capsule_blocked".to_string());
        return None;
    }

    let mesh_mode = settings
        .collision_mesh_mode
        .as_deref()
        .unwrap_or("faces")
        .to_string();
    let mesh = mesh_from_voxels(&grid, &solid, &reachable);
    let surface_faces = mesh.indices.len() / 3;

    diagnostics.floor_plane = Some(FloorPlane {
        normal: [0.0, 1.0, 0.0],
        d: -seed.y,
    });
    diagnostics.floor_plane_source = "voxel_collision".to_string();
    diagnostics.floor_plane_normal_y = 1.0;
    diagnostics.floor_plane_height = seed.y;
    diagnostics.grid_width = grid.dims[0];
    diagnostics.grid_height = grid.dims[2];
    diagnostics.cell_size = grid.voxel_size;
    diagnostics.faces_generated = surface_faces;
    diagnostics.valid_vertices = mesh.vertices.len() / 3;
    diagnostics.collision_voxel_size = grid.voxel_size;
    diagnostics.collision_grid_width = grid.dims[0];
    diagnostics.collision_grid_height = grid.dims[1];
    diagnostics.collision_grid_depth = grid.dims[2];
    diagnostics.collision_occupied_voxels = occupied_before;
    diagnostics.collision_cluster_kept_voxels = cluster_kept;
    diagnostics.collision_cluster_discarded_voxels = cluster_discarded;
    diagnostics.collision_filled_voxels = filled;
    diagnostics.collision_carved_voxels = carved;
    diagnostics.collision_surface_faces = surface_faces;
    diagnostics.collision_seed_state = seed_state(
        &grid,
        &solid,
        seed,
        settings.collision_carve_height.unwrap_or(1.6),
        settings.collision_carve_radius.unwrap_or(0.25),
    );
    diagnostics.collision_scene_type = scene_type;
    diagnostics.collision_mesh_mode = mesh_mode;
    diagnostics.collision_external_fill_leaked = external_fill_leaked;
    diagnostics.collision_failure_reason = None;

    web_sys::console::log_1(&format!(
        "PlayCanvas-style collision: grid={}x{}x{}, voxel={:.3}, occupied={}, kept={}, discarded={}, filled={}, carved={}, faces={}",
        grid.dims[0], grid.dims[1], grid.dims[2], grid.voxel_size, occupied_before, cluster_kept, cluster_discarded, filled, carved, surface_faces
    ).into());

    let basis = FieldBasis {
        origin: [grid.min.x, grid.min.y, grid.min.z],
        tangent: [1.0, 0.0, 0.0],
        bitangent: [0.0, 0.0, 1.0],
        up: [0.0, 1.0, 0.0],
    };
    let plane = diagnostics.floor_plane.clone().unwrap_or(FloorPlane {
        normal: [0.0, 1.0, 0.0],
        d: -seed.y,
    });

    Some(CollisionBuild {
        mesh,
        basis,
        plane,
        diagnostics: diagnostics.clone(),
    })
}

fn collision_seed(
    settings: &MeshSettings,
    diagnostics: &ReconstructionDiagnostics,
    grid: &VoxelGrid,
) -> Vector3<f64> {
    if let Some(seed) = &settings.collision_seed {
        if seed.len() == 3 && seed.iter().all(|v| v.is_finite()) {
            return Vector3::new(seed[0], seed[1], seed[2]);
        }
    }

    let min = diagnostics
        .oriented_min
        .unwrap_or([grid.min.x, grid.min.y, grid.min.z]);
    let max = diagnostics
        .oriented_max
        .unwrap_or([grid.min.x, grid.min.y, grid.min.z]);
    Vector3::new(
        (min[0] + max[0]) * 0.5,
        diagnostics.floor_y_percentile_02.unwrap_or(min[1]) + 1.0,
        (min[2] + max[2]) * 0.5,
    )
}

fn filter_occupied_seed_cluster(
    grid: &VoxelGrid,
    solid: &mut [bool],
    seed: Vector3<f64>,
) -> (usize, usize) {
    let Some(seed_idx) = nearest_solid_voxel(grid, solid, seed) else {
        let occupied = solid.iter().filter(|&&v| v).count();
        return (occupied, 0);
    };
    let mut keep = vec![false; solid.len()];
    let mut queue = std::collections::VecDeque::new();
    keep[seed_idx] = true;
    queue.push_back(seed_idx);

    while let Some(idx) = queue.pop_front() {
        for nidx in voxel_neighbors6(grid, idx) {
            if solid[nidx] && !keep[nidx] {
                keep[nidx] = true;
                queue.push_back(nidx);
            }
        }
    }

    let mut kept = 0usize;
    let mut discarded = 0usize;
    for idx in 0..solid.len() {
        if solid[idx] {
            if keep[idx] {
                kept += 1;
            } else {
                solid[idx] = false;
                discarded += 1;
            }
        }
    }
    (kept, discarded)
}

fn nearest_solid_voxel(grid: &VoxelGrid, solid: &[bool], seed: Vector3<f64>) -> Option<usize> {
    let seed_voxel = grid.point_to_voxel(&seed).unwrap_or((
        grid.dims[0] / 2,
        grid.dims[1] / 2,
        grid.dims[2] / 2,
    ));
    let max_radius = grid.dims.iter().copied().max().unwrap_or(0).min(64) as isize;
    for radius in 0..=max_radius {
        for y in (seed_voxel.1 as isize - radius).max(0)
            ..=(seed_voxel.1 as isize + radius).min(grid.dims[1] as isize - 1)
        {
            for z in (seed_voxel.2 as isize - radius).max(0)
                ..=(seed_voxel.2 as isize + radius).min(grid.dims[2] as isize - 1)
            {
                for x in (seed_voxel.0 as isize - radius).max(0)
                    ..=(seed_voxel.0 as isize + radius).min(grid.dims[0] as isize - 1)
                {
                    let idx = grid.idx(x as usize, y as usize, z as usize);
                    if solid[idx] {
                        return Some(idx);
                    }
                }
            }
        }
    }
    None
}

fn apply_collision_fill(
    grid: &VoxelGrid,
    solid: &mut [bool],
    scene_type: &str,
    fill_size: f64,
    seed: Vector3<f64>,
) -> (usize, bool) {
    match scene_type {
        "indoor" => apply_external_fill(grid, solid, fill_size, seed),
        "object" => (0, false),
        _ => (apply_floor_fill(grid, solid, fill_size), false),
    }
}

fn apply_floor_fill(grid: &VoxelGrid, solid: &mut [bool], fill_size: f64) -> usize {
    let mut filled = 0usize;
    let support_radius = (fill_size / grid.voxel_size).ceil().max(1.0) as isize;
    let original = solid.to_vec();

    for z in 0..grid.dims[2] {
        for x in 0..grid.dims[0] {
            if !floor_column_has_local_support(grid, &original, x, z, support_radius) {
                continue;
            }

            let first_solid = (0..grid.dims[1]).find(|&y| original[grid.idx(x, y, z)]);
            if let Some(top_y) = first_solid {
                for y in 0..top_y {
                    let idx = grid.idx(x, y, z);
                    if !solid[idx] {
                        solid[idx] = true;
                        filled += 1;
                    }
                }
            }
        }
    }
    filled
}

fn floor_column_has_local_support(
    grid: &VoxelGrid,
    solid: &[bool],
    x: usize,
    z: usize,
    radius: isize,
) -> bool {
    let mut supported = 0usize;
    let mut checked = 0usize;
    for zz in (z as isize - radius).max(0)..=(z as isize + radius).min(grid.dims[2] as isize - 1) {
        for xx in
            (x as isize - radius).max(0)..=(x as isize + radius).min(grid.dims[0] as isize - 1)
        {
            checked += 1;
            if (0..grid.dims[1]).any(|y| solid[grid.idx(xx as usize, y, zz as usize)]) {
                supported += 1;
            }
        }
    }

    checked > 0 && supported as f64 / checked as f64 >= 0.35
}

fn apply_external_fill(
    grid: &VoxelGrid,
    solid: &mut [bool],
    fill_size: f64,
    seed: Vector3<f64>,
) -> (usize, bool) {
    let dilated = dilate_solid(
        grid,
        solid,
        (fill_size / grid.voxel_size).ceil().max(1.0) as usize,
    );

    let mut exterior = vec![false; solid.len()];
    let mut queue = std::collections::VecDeque::new();
    for idx in boundary_empty_voxels(grid, &dilated) {
        exterior[idx] = true;
        queue.push_back(idx);
    }
    while let Some(idx) = queue.pop_front() {
        for nidx in voxel_neighbors6(grid, idx) {
            if !dilated[nidx] && !exterior[nidx] {
                exterior[nidx] = true;
                queue.push_back(nidx);
            }
        }
    }

    if let Some((sx, sy, sz)) = grid.point_to_voxel(&seed) {
        if exterior[grid.idx(sx, sy, sz)] {
            return (0, true);
        }
    }

    let mut filled = 0usize;
    solid.copy_from_slice(&dilated);
    for idx in 0..dilated.len() {
        if exterior[idx] && !solid[idx] {
            solid[idx] = true;
            filled += 1;
        }
    }
    (filled, false)
}

fn dilate_solid(grid: &VoxelGrid, solid: &[bool], radius: usize) -> Vec<bool> {
    let mut out = solid.to_vec();
    let radius_i = radius as isize;
    for idx in 0..solid.len() {
        if !solid[idx] {
            continue;
        }
        let (x, y, z) = grid.coords(idx);
        for yy in
            (y as isize - radius_i).max(0)..=(y as isize + radius_i).min(grid.dims[1] as isize - 1)
        {
            for zz in (z as isize - radius_i).max(0)
                ..=(z as isize + radius_i).min(grid.dims[2] as isize - 1)
            {
                for xx in (x as isize - radius_i).max(0)
                    ..=(x as isize + radius_i).min(grid.dims[0] as isize - 1)
                {
                    out[grid.idx(xx as usize, yy as usize, zz as usize)] = true;
                }
            }
        }
    }
    out
}

fn boundary_empty_voxels(grid: &VoxelGrid, solid: &[bool]) -> Vec<usize> {
    let mut out = Vec::new();
    for y in 0..grid.dims[1] {
        for z in 0..grid.dims[2] {
            for x in 0..grid.dims[0] {
                if x != 0
                    && y != 0
                    && z != 0
                    && x + 1 != grid.dims[0]
                    && y + 1 != grid.dims[1]
                    && z + 1 != grid.dims[2]
                {
                    continue;
                }
                let idx = grid.idx(x, y, z);
                if !solid[idx] {
                    out.push(idx);
                }
            }
        }
    }
    out
}

fn seed_state(
    grid: &VoxelGrid,
    solid: &[bool],
    seed: Vector3<f64>,
    height: f64,
    radius: f64,
) -> String {
    let Some((x, y, z)) = grid.point_to_voxel(&seed) else {
        return "outside_grid".to_string();
    };

    if solid[grid.idx(x, y, z)] {
        return "inside_solid".to_string();
    }

    if capsule_fits(grid, solid, x, y, z, height, radius) {
        "capsule_fits".to_string()
    } else {
        "capsule_blocked".to_string()
    }
}

fn carve_reachable_empty(
    grid: &VoxelGrid,
    solid: &[bool],
    seed: Vector3<f64>,
    height: f64,
    radius: f64,
) -> Vec<bool> {
    let mut reachable = vec![false; solid.len()];
    let Some(seed_empty) = nearest_capsule_fit_voxel(grid, solid, seed, height, radius) else {
        return reachable;
    };

    let mut queue = std::collections::VecDeque::new();
    reachable[seed_empty] = true;
    queue.push_back(seed_empty);
    while let Some(idx) = queue.pop_front() {
        for nidx in voxel_neighbors6(grid, idx) {
            if !reachable[nidx] {
                let (x, y, z) = grid.coords(nidx);
                if capsule_fits(grid, solid, x, y, z, height, radius) {
                    reachable[nidx] = true;
                    queue.push_back(nidx);
                }
            }
        }
    }
    reachable
}

fn nearest_capsule_fit_voxel(
    grid: &VoxelGrid,
    solid: &[bool],
    seed: Vector3<f64>,
    height: f64,
    radius: f64,
) -> Option<usize> {
    let seed_voxel = grid.point_to_voxel(&seed).unwrap_or((
        grid.dims[0] / 2,
        grid.dims[1] / 2,
        grid.dims[2] / 2,
    ));
    let max_radius = grid.dims.iter().copied().max().unwrap_or(0).min(64) as isize;
    for search in 0..=max_radius {
        for y in (seed_voxel.1 as isize - search).max(0)
            ..=(seed_voxel.1 as isize + search).min(grid.dims[1] as isize - 1)
        {
            for z in (seed_voxel.2 as isize - search).max(0)
                ..=(seed_voxel.2 as isize + search).min(grid.dims[2] as isize - 1)
            {
                for x in (seed_voxel.0 as isize - search).max(0)
                    ..=(seed_voxel.0 as isize + search).min(grid.dims[0] as isize - 1)
                {
                    if capsule_fits(
                        grid, solid, x as usize, y as usize, z as usize, height, radius,
                    ) {
                        return Some(grid.idx(x as usize, y as usize, z as usize));
                    }
                }
            }
        }
    }
    None
}

fn capsule_fits(
    grid: &VoxelGrid,
    solid: &[bool],
    x: usize,
    y: usize,
    z: usize,
    height: f64,
    radius: f64,
) -> bool {
    if solid[grid.idx(x, y, z)] {
        return false;
    }
    let rx = (radius / grid.voxel_size).ceil().max(0.0) as isize;
    let ry = (height / grid.voxel_size).ceil().max(1.0) as isize;
    let r_sq = (radius + grid.voxel_size * 0.5).powi(2);
    for yy in y as isize..=(y as isize + ry).min(grid.dims[1] as isize - 1) {
        for zz in (z as isize - rx).max(0)..=(z as isize + rx).min(grid.dims[2] as isize - 1) {
            for xx in (x as isize - rx).max(0)..=(x as isize + rx).min(grid.dims[0] as isize - 1) {
                let dx = (xx - x as isize) as f64 * grid.voxel_size;
                let dz = (zz - z as isize) as f64 * grid.voxel_size;
                if dx * dx + dz * dz <= r_sq
                    && solid[grid.idx(xx as usize, yy as usize, zz as usize)]
                {
                    return false;
                }
            }
        }
    }
    true
}

fn mesh_from_voxels(grid: &VoxelGrid, solid: &[bool], reachable: &[bool]) -> ReconstructedMesh {
    let mut vertices = Vec::<f32>::new();
    let mut indices = Vec::<u32>::new();
    let mut vertex_map = std::collections::HashMap::<(usize, usize, usize), u32>::new();
    let faces: [((isize, isize, isize), [(usize, usize, usize); 4]); 6] = [
        ((1, 0, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
        ((-1, 0, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
        ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
        ((0, -1, 0), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
        ((0, 0, 1), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
        ((0, 0, -1), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
    ];

    for idx in 0..solid.len() {
        if !solid[idx] {
            continue;
        }
        let (x, y, z) = grid.coords(idx);
        for (dir, corners) in faces {
            let nx = x as isize + dir.0;
            let ny = y as isize + dir.1;
            let nz = z as isize + dir.2;
            let expose = if nx < 0
                || ny < 0
                || nz < 0
                || nx >= grid.dims[0] as isize
                || ny >= grid.dims[1] as isize
                || nz >= grid.dims[2] as isize
            {
                false
            } else {
                reachable[grid.idx(nx as usize, ny as usize, nz as usize)]
            };
            if !expose {
                continue;
            }

            let mut face_indices = [0_u32; 4];
            for (slot, corner) in corners.iter().enumerate() {
                let key = (x + corner.0, y + corner.1, z + corner.2);
                if let Some(existing) = vertex_map.get(&key) {
                    face_indices[slot] = *existing;
                    continue;
                }
                let p = grid.min
                    + Vector3::new(
                        key.0 as f64 * grid.voxel_size,
                        key.1 as f64 * grid.voxel_size,
                        key.2 as f64 * grid.voxel_size,
                    );
                let new_idx = (vertices.len() / 3) as u32;
                vertices.push(p.x as f32);
                vertices.push(p.y as f32);
                vertices.push(p.z as f32);
                vertex_map.insert(key, new_idx);
                face_indices[slot] = new_idx;
            }

            indices.extend_from_slice(&[
                face_indices[0],
                face_indices[1],
                face_indices[2],
                face_indices[0],
                face_indices[2],
                face_indices[3],
            ]);
        }
    }

    ReconstructedMesh { vertices, indices }
}

fn voxel_neighbors6(grid: &VoxelGrid, idx: usize) -> Vec<usize> {
    let (x, y, z) = grid.coords(idx);
    let mut out = Vec::with_capacity(6);
    if x > 0 {
        out.push(grid.idx(x - 1, y, z));
    }
    if x + 1 < grid.dims[0] {
        out.push(grid.idx(x + 1, y, z));
    }
    if y > 0 {
        out.push(grid.idx(x, y - 1, z));
    }
    if y + 1 < grid.dims[1] {
        out.push(grid.idx(x, y + 1, z));
    }
    if z > 0 {
        out.push(grid.idx(x, y, z - 1));
    }
    if z + 1 < grid.dims[2] {
        out.push(grid.idx(x, y, z + 1));
    }
    out
}

fn build_field(
    context: &ReconstructionContext,
    settings: &MeshSettings,
    diagnostics: &mut ReconstructionDiagnostics,
) -> Option<FieldBuild> {
    let points = &context.filtered_points;
    if points.is_empty() {
        return None;
    }

    let voxel_target = settings.voxel_target.unwrap_or(4000.0);
    let ransac_thresh = settings.ransac_thresh.unwrap_or(0.1);
    let floor_projection_epsilon = settings
        .floor_projection_epsilon
        .or(settings.height_projection_epsilon)
        .unwrap_or(ransac_thresh.max(0.16));
    let obstacle_height_epsilon = settings
        .obstacle_height_epsilon
        .unwrap_or((floor_projection_epsilon * 1.5).max(0.24));
    let min_floor_confidence = settings.min_floor_confidence.unwrap_or(0.01);
    let min_evidence_weight = 0.001;
    let obstacle_threshold = 0.35;
    // Agent clearance band: density between floor+clearance_lo and floor+clearance_hi blocks
    // walking; anything above clearance_hi (ceilings, tall furniture) is ignored so that open
    // floor under a high ceiling stays walkable.
    let obstacle_clearance_min = settings
        .obstacle_clearance_min
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(floor_projection_epsilon);
    let obstacle_clearance_max = settings
        .obstacle_clearance_max
        .filter(|v| v.is_finite() && *v > obstacle_clearance_min)
        .unwrap_or_else(|| {
            settings
                .collision_carve_height
                .unwrap_or(1.7)
                .max(obstacle_clearance_min + 0.1)
        });
    // Local floor continuity: a cell whose floor height departs from the neighbor median by more
    // than this step is treated as a discontinuity (wall base, ledge) rather than walkable floor.
    let continuity_threshold = obstacle_height_epsilon.max(0.2);
    let sdf_vertical_cell_size = settings
        .sdf_vertical_cell_size
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or((floor_projection_epsilon * 0.5).clamp(0.025, 0.12));
    let sdf_density_threshold = settings.sdf_density_threshold.unwrap_or(0.08).max(0.0001);
    let sdf_max_layers = settings.sdf_max_layers.unwrap_or(2).max(1);
    let sdf_smoothing_radius = settings.sdf_smoothing_radius.unwrap_or(1);
    let influence_radius_scale = settings
        .sdf_influence_radius_scale
        .unwrap_or(2.5)
        .clamp(0.5, 6.0);

    let p_coords: Vec<Point3<Real>> = points
        .iter()
        .map(|p| Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real))
        .collect();
    let mut y_values = p_coords.iter().map(|p| p.y as f64).collect::<Vec<f64>>();
    let floor_y = if y_values.is_empty() {
        diagnostics.floor_y_percentile_02.unwrap_or(0.0)
    } else {
        percentile(&mut y_values, 0.02)
    };
    let lower_band_height = (floor_projection_epsilon * 4.0).max(0.45);
    let min_floor_normal_y = 0.82;
    let (_diagnostic_plane, max_inliers) = find_floor_plane(
        &p_coords,
        ransac_thresh,
        1200,
        floor_y,
        lower_band_height,
        min_floor_normal_y,
    );
    diagnostics.ransac_inliers = max_inliers;

    let floor_d = -floor_y;
    let floor_height = floor_y;
    diagnostics.floor_plane = Some(FloorPlane {
        normal: [0.0, 1.0, 0.0],
        d: floor_d,
    });
    diagnostics.floor_plane_source = "lower_envelope".to_string();
    diagnostics.floor_plane_normal_y = 1.0;
    diagnostics.floor_plane_height = floor_height;
    diagnostics.floor_plane_used_fallback = false;

    let tangent_64 = Vector3::new(1.0, 0.0, 0.0);
    let bitangent_64 = Vector3::new(0.0, 0.0, 1.0);
    let up_64 = Vector3::new(0.0, 1.0, 0.0);

    let mut min_u = f64::MAX;
    let mut max_u = f64::MIN;
    let mut min_v = f64::MAX;
    let mut max_v = f64::MIN;
    let mut min_y = f64::MAX;
    let mut max_y = f64::MIN;

    for p in points {
        min_u = min_u.min(p.point.x);
        max_u = max_u.max(p.point.x);
        min_v = min_v.min(p.point.z);
        max_v = max_v.max(p.point.z);
        min_y = min_y.min(p.point.y);
        max_y = max_y.max(p.point.y);
    }

    let width_m = max_u - min_u;
    let depth_m = max_v - min_v;
    if width_m <= 0.0 || depth_m <= 0.0 {
        return None;
    }

    let mut cell_size = settings
        .sdf_cell_size
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or_else(|| (width_m * depth_m / voxel_target).sqrt());
    cell_size = cell_size.clamp(0.03, 2.0);

    let cols = (width_m / cell_size).ceil() as usize;
    let rows = (depth_m / cell_size).ceil() as usize;
    let width = cols.max(1);
    let height = rows.max(1);
    let num_cells = width * height;
    let y_padding = obstacle_height_epsilon.max(floor_projection_epsilon) * 2.0;
    let profile_min_y = min_y - y_padding;
    let profile_max_y = max_y + y_padding;
    let profile_bins =
        (((profile_max_y - profile_min_y) / sdf_vertical_cell_size).ceil() as usize).clamp(2, 256);
    let mut profiles = vec![0.0_f64; num_cells * profile_bins];
    let mut normal_weight = vec![0.0_f64; num_cells];
    let mut sample_weight = vec![0.0_f64; num_cells];

    for p in points {
        let normal_y = p.normal.y.abs().min(1.0);
        let scale_avg = ((p.scale.x + p.scale.y + p.scale.z) / 3.0).max(0.001);
        let influence_radius = (scale_avg * influence_radius_scale)
            .max(cell_size * 0.5)
            .min(cell_size * 4.0);
        let col_min =
            (((p.point.x - influence_radius - min_u) / cell_size).floor() as isize).max(0);
        let col_max = (((p.point.x + influence_radius - min_u) / cell_size).floor() as isize)
            .min(width as isize - 1);
        let row_min =
            (((p.point.z - influence_radius - min_v) / cell_size).floor() as isize).max(0);
        let row_max = (((p.point.z + influence_radius - min_v) / cell_size).floor() as isize)
            .min(height as isize - 1);
        let bin_center = ((p.point.y - profile_min_y) / sdf_vertical_cell_size).round() as isize;
        let y_sigma = scale_avg.max(sdf_vertical_cell_size * 0.5);
        let bin_radius = ((y_sigma * influence_radius_scale / sdf_vertical_cell_size).ceil()
            as isize)
            .clamp(1, 8);
        let base_density = p.opacity.max(0.0) * (0.35 + 0.65 * normal_y);

        for row in row_min..=row_max {
            for col in col_min..=col_max {
                let cell_center_x = min_u + (col as f64 + 0.5) * cell_size;
                let cell_center_z = min_v + (row as f64 + 0.5) * cell_size;
                let dx = cell_center_x - p.point.x;
                let dz = cell_center_z - p.point.z;
                let xz_dist_sq = dx * dx + dz * dz;
                if xz_dist_sq > influence_radius * influence_radius {
                    continue;
                }

                let xz_falloff = (-xz_dist_sq / (2.0 * influence_radius * influence_radius)).exp();
                let cell_idx = row as usize * width + col as usize;
                normal_weight[cell_idx] += normal_y * base_density * xz_falloff;
                sample_weight[cell_idx] += base_density * xz_falloff;

                for db in -bin_radius..=bin_radius {
                    let bin = bin_center + db;
                    if bin < 0 || bin >= profile_bins as isize {
                        continue;
                    }
                    let bin_y = profile_min_y + (bin as f64 + 0.5) * sdf_vertical_cell_size;
                    let dy = bin_y - p.point.y;
                    let y_falloff = (-(dy * dy) / (2.0 * y_sigma * y_sigma)).exp();
                    profiles[cell_idx * profile_bins + bin as usize] +=
                        base_density * xz_falloff * y_falloff;
                }
            }
        }
    }

    let surfaces = extract_density_surfaces(
        &profiles,
        num_cells,
        profile_bins,
        profile_min_y,
        sdf_vertical_cell_size,
        sdf_density_threshold,
        sdf_max_layers,
        obstacle_clearance_min,
        obstacle_clearance_max,
        floor_y,
    );
    let mut surface_heights = surfaces
        .iter()
        .map(|surface| surface.primary_height)
        .collect::<Vec<Option<f64>>>();
    let smoothed_cells = smooth_surface_heights(
        &mut surface_heights,
        &surfaces,
        width,
        height,
        sdf_smoothing_radius,
        floor_height,
        continuity_threshold,
    );

    let mut cells: Vec<GroundFieldCell> = Vec::with_capacity(num_cells);
    let mut valid_cell_count = 0;
    let mut cells_rejected_low_confidence = 0;
    let mut cells_rejected_height_variance = 0;
    let mut cells_rejected_obstacle = 0;
    let mut cells_void = 0;
    let mut cells_rejected_discontinuity = 0;
    let mut points_contributed = 0;
    let mut obstacle_points = 0;
    let mut cells_with_surface = 0;
    let mut multi_layer_cells = 0;

    for idx in 0..num_cells {
        let surface = surfaces[idx];
        let mut primary_height = surface_heights[idx].unwrap_or(floor_height);
        if surface.primary_height.is_some() {
            cells_with_surface += 1;
        }
        if surface.layer_count > 1 {
            multi_layer_cells += 1;
        }
        points_contributed += surface.floor_bins;
        obstacle_points += surface.obstacle_bins;

        let floor_weight = surface.surface_confidence;
        let obstacle_weight = surface.obstacle_density;
        let total_evidence = floor_weight + obstacle_weight;
        let obstacle_score = if total_evidence > 0.0 {
            obstacle_weight / total_evidence
        } else {
            0.0
        };
        let confidence = floor_weight;
        let variance = surface.height_variance;
        let normal_alignment = if sample_weight[idx] > 0.0 {
            normal_weight[idx] / sample_weight[idx]
        } else {
            0.0
        };
        // Local floor continuity: compare this cell's floor height to the median of its 8
        // neighbors. A large departure indicates a wall base, ledge, or stacked surface rather
        // than continuous walkable floor. This replaces the old intra-column variance gate, which
        // wrongly rejected floor simply because furniture/ceiling existed above it.
        let discontinuous = if surface.primary_height.is_some() {
            let row = idx / width;
            let col = idx % width;
            let mut neighbor_heights: Vec<f64> = Vec::with_capacity(8);
            for dr in -1i64..=1 {
                for dc in -1i64..=1 {
                    if dr == 0 && dc == 0 {
                        continue;
                    }
                    let nr = row as i64 + dr;
                    let nc = col as i64 + dc;
                    if nr < 0 || nc < 0 || nr >= height as i64 || nc >= width as i64 {
                        continue;
                    }
                    let nidx = nr as usize * width + nc as usize;
                    if let Some(h) = surface_heights[nidx] {
                        neighbor_heights.push(h);
                    }
                }
            }
            if neighbor_heights.len() >= 3 {
                neighbor_heights
                    .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let median = neighbor_heights[neighbor_heights.len() / 2];
                let delta = (primary_height - median).abs();
                if delta > continuity_threshold {
                    // Only genuine ledges (>= reject_band) are rejected as a discontinuity.
                    // A small departure on an otherwise-flat floor is snapped to the neighbour
                    // median and kept walkable, instead of punching a hole that fragments the
                    // floor into separate Recast islands.
                    let reject_band = (continuity_threshold * 2.5).max(0.6);
                    if delta < reject_band {
                        primary_height = median;
                        surface_heights[idx] = Some(median);
                        false
                    } else {
                        true
                    }
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };

        let state = if surface.primary_height.is_none() {
            cells_void += 1;
            GroundFieldCellState::Void
        } else if obstacle_weight >= min_evidence_weight && obstacle_score >= obstacle_threshold {
            cells_rejected_obstacle += 1;
            GroundFieldCellState::Obstacle
        } else if total_evidence < min_evidence_weight {
            cells_void += 1;
            GroundFieldCellState::Void
        } else if confidence < min_floor_confidence {
            cells_rejected_low_confidence += 1;
            GroundFieldCellState::LowConfidence
        } else if discontinuous {
            cells_rejected_discontinuity += 1;
            cells_rejected_height_variance += 1;
            GroundFieldCellState::HeightVariance
        } else {
            valid_cell_count += 1;
            GroundFieldCellState::Walkable
        };

        cells.push(GroundFieldCell {
            height: primary_height as f32,
            confidence: confidence as f32,
            variance: if variance.is_finite() {
                variance as f32
            } else {
                f32::NAN
            },
            normal_alignment: normal_alignment as f32,
            obstacle_score: obstacle_score as f32,
            primary_layer_height: primary_height as f32,
            layer_count: surface.layer_count,
            peak_density: surface.peak_density as f32,
            surface_confidence: surface.surface_confidence as f32,
            signed_distance: surface.signed_distance_proxy as f32,
            gradient: [0.0, 0.0],
            component_id: -1,
            state,
        });
    }

    apply_gradients(&mut cells, &surface_heights, width, height, cell_size);

    let holes_filled = fill_low_confidence_holes(
        &mut cells,
        width,
        height,
        settings.hole_fill_radius.unwrap_or(1),
    );
    let cells_eroded = erode_agent_radius(
        &mut cells,
        width,
        height,
        settings.agent_radius_erode.unwrap_or(0.0),
        cell_size,
    );
    let (component_count, largest_component_cells, selected_component_id, discarded_cells) =
        select_connected_component(
            &mut cells,
            width,
            height,
            settings.component_mode.as_deref(),
        );
    let selected_cells = cells
        .iter()
        .map(|cell| {
            matches!(
                cell.state,
                GroundFieldCellState::Walkable | GroundFieldCellState::Filled
            )
        })
        .collect::<Vec<bool>>();
    let rejected_cells = cells
        .iter()
        .filter(|cell| {
            !matches!(
                cell.state,
                GroundFieldCellState::Walkable | GroundFieldCellState::Filled
            )
        })
        .count();

    diagnostics.grid_width = width;
    diagnostics.grid_height = height;
    diagnostics.cell_size = cell_size;
    diagnostics.valid_vertices = valid_cell_count + holes_filled;
    diagnostics.holes_filled = holes_filled;
    diagnostics.rejected_cells = rejected_cells;
    diagnostics.cells_rejected_low_confidence = cells_rejected_low_confidence;
    diagnostics.cells_rejected_height_variance = cells_rejected_height_variance;
    diagnostics.cells_rejected_obstacle = cells_rejected_obstacle;
    diagnostics.cells_void = cells_void;
    diagnostics.cells_filled = holes_filled;
    diagnostics.cells_eroded = cells_eroded;
    diagnostics.cells_discarded_component = discarded_cells;
    diagnostics.connected_components = component_count;
    diagnostics.largest_component_faces = largest_component_cells * 2;
    diagnostics.selected_component_id = selected_component_id;
    diagnostics.selected_component_area =
        selected_cells.iter().filter(|&&selected| selected).count() as f64 * cell_size * cell_size;
    diagnostics.points_after_filter = points.len();
    diagnostics.sdf_density_threshold = sdf_density_threshold;
    diagnostics.sdf_vertical_cell_size = sdf_vertical_cell_size;
    diagnostics.sdf_profile_bins = profile_bins;
    diagnostics.sdf_cells_with_surface = cells_with_surface;
    diagnostics.sdf_cells_multi_layer = multi_layer_cells;
    diagnostics.sdf_cells_smoothed = smoothed_cells;

    web_sys::console::log_1(&format!(
        "2.5D SDF column field: {}x{}, cell_size={:.3}, y_bins={}, clearance=[{:.2},{:.2}], surfaces={}, multi_layer={}, floor_bins={}, obstacleBand_bins={}, holes_filled={}, eroded={}, discarded={}, rejected(conf={}, discontinuity={}, obs={}, void={})",
        width,
        height,
        cell_size,
        profile_bins,
        obstacle_clearance_min,
        obstacle_clearance_max,
        cells_with_surface,
        multi_layer_cells,
        points_contributed,
        obstacle_points,
        holes_filled,
        cells_eroded,
        discarded_cells,
        cells_rejected_low_confidence,
        cells_rejected_discontinuity,
        cells_rejected_obstacle,
        cells_void
    ).into());

    let origin_vec = tangent_64 * min_u + bitangent_64 * min_v;
    let plane = diagnostics.floor_plane.clone().unwrap_or(FloorPlane {
        normal: [0.0, 1.0, 0.0],
        d: 0.0,
    });
    let basis = FieldBasis {
        origin: [origin_vec.x, origin_vec.y, origin_vec.z],
        tangent: [tangent_64.x, tangent_64.y, tangent_64.z],
        bitangent: [bitangent_64.x, bitangent_64.y, bitangent_64.z],
        up: [up_64.x, up_64.y, up_64.z],
    };

    Some(FieldBuild {
        cells,
        width,
        height,
        cell_size,
        basis,
        plane,
        diagnostics: diagnostics.clone(),
    })
}

fn fill_low_confidence_holes(
    cells: &mut [GroundFieldCell],
    width: usize,
    height: usize,
    radius: usize,
) -> usize {
    if radius == 0 || width == 0 || height == 0 {
        return 0;
    }

    let original = cells.to_vec();
    let mut visited = vec![false; cells.len()];
    let mut fills = Vec::<(usize, f32)>::new();
    let max_hole_cells = ((radius * 2 + 1) * (radius * 2 + 1)).max(1);

    for row in 0..height {
        for col in 0..width {
            let start_idx = row * width + col;
            if visited[start_idx] || !is_fillable_hole(&original[start_idx].state) {
                continue;
            }

            let mut queue = std::collections::VecDeque::new();
            let mut component = Vec::new();
            let mut boundary_sum = 0.0_f32;
            let mut boundary_count = 0usize;
            let mut enclosed_by_floor = true;

            queue.push_back((row, col));
            visited[start_idx] = true;

            while let Some((r, c)) = queue.pop_front() {
                let idx = r * width + c;
                component.push(idx);

                for (nr, nc) in neighbors4(r, c, width, height) {
                    let nidx = nr * width + nc;
                    let neighbor = &original[nidx];

                    if is_fillable_hole(&neighbor.state) {
                        if !visited[nidx] {
                            visited[nidx] = true;
                            queue.push_back((nr, nc));
                        }
                    } else if is_accepted_state(&neighbor.state) {
                        boundary_sum += neighbor.height;
                        boundary_count += 1;
                    } else {
                        enclosed_by_floor = false;
                    }
                }

                if r == 0 || c == 0 || r + 1 == height || c + 1 == width {
                    enclosed_by_floor = false;
                }
            }

            if enclosed_by_floor && component.len() <= max_hole_cells && boundary_count > 0 {
                let fill_height = boundary_sum / boundary_count as f32;
                for idx in component {
                    fills.push((idx, fill_height));
                }
            }
        }
    }

    let filled = fills.len();
    for (idx, height_value) in fills {
        cells[idx].height = height_value;
        cells[idx].state = GroundFieldCellState::Filled;
    }

    filled
}

#[derive(Clone, Copy)]
struct DensitySurface {
    primary_height: Option<f64>,
    layer_count: usize,
    peak_density: f64,
    surface_confidence: f64,
    obstacle_density: f64,
    height_variance: f64,
    signed_distance_proxy: f64,
    floor_bins: usize,
    obstacle_bins: usize,
}

fn empty_density_surface() -> DensitySurface {
    DensitySurface {
        primary_height: None,
        layer_count: 0,
        peak_density: 0.0,
        surface_confidence: 0.0,
        obstacle_density: 0.0,
        height_variance: f64::MAX,
        signed_distance_proxy: f64::NAN,
        floor_bins: 0,
        obstacle_bins: 0,
    }
}

fn extract_density_surfaces(
    profiles: &[f64],
    cell_count: usize,
    profile_bins: usize,
    min_y: f64,
    vertical_cell_size: f64,
    density_threshold: f64,
    max_layers: usize,
    clearance_lo: f64,
    clearance_hi: f64,
    floor_y_hint: f64,
) -> Vec<DensitySurface> {
    let mut surfaces = vec![empty_density_surface(); cell_count];

    // PASS 1 -- per column, split each density profile into contiguous above-threshold
    // layers (start_bin, end_bin, weighted_centroid_y, accumulated_weight), and accumulate
    // a scene-wide weighted histogram of layer centroids. The dominant floor plane is the
    // single heaviest horizontal accumulation, which we use to anchor every column's floor.
    let mut all_layers: Vec<Vec<(usize, usize, f64, f64)>> = Vec::with_capacity(cell_count);
    let mut peak_densities = vec![0.0_f64; cell_count];
    let mut floor_histogram = vec![0.0_f64; profile_bins];

    for cell_idx in 0..cell_count {
        let start = cell_idx * profile_bins;
        let profile = &profiles[start..start + profile_bins];
        let peak_density = profile.iter().copied().fold(0.0_f64, f64::max);
        peak_densities[cell_idx] = peak_density;
        if peak_density <= 0.0 {
            all_layers.push(Vec::new());
            continue;
        }

        let mut layers = Vec::<(usize, usize, f64, f64)>::new();
        let mut bin = 0usize;
        while bin < profile_bins {
            if profile[bin] < density_threshold {
                bin += 1;
                continue;
            }

            let layer_start = bin;
            let mut layer_end = bin;
            let mut weighted_y = 0.0;
            let mut weight = 0.0;
            while layer_end < profile_bins && profile[layer_end] >= density_threshold {
                let y = min_y + (layer_end as f64 + 0.5) * vertical_cell_size;
                weighted_y += y * profile[layer_end];
                weight += profile[layer_end];
                layer_end += 1;
            }
            let height = if weight > 0.0 {
                weighted_y / weight
            } else {
                min_y + (layer_start as f64 + 0.5) * vertical_cell_size
            };
            // Accumulate every layer into a scene-wide weighted height histogram. The floor
            // is the single dominant horizontal accumulation (most-observed, density-weighted
            // by |normal_y| so it wins regardless of whether the data is Y-up or Y-down), so
            // no orientation assumption or vertical half-split is needed to find it.
            let hist_bin = (((height - min_y) / vertical_cell_size).floor() as isize)
                .clamp(0, profile_bins as isize - 1) as usize;
            floor_histogram[hist_bin] += weight;
            layers.push((layer_start, layer_end - 1, height, weight));
            bin = layer_end;
        }

        all_layers.push(layers);
    }

    // The global floor plane is the LOWEST sufficiently-dominant horizontal accumulation
    // (a gravity prior), not merely the single heaviest bin. In enclosed scenes such as
    // warehouses the large continuous flat roof forms a density peak that can rival or
    // exceed the floor's, so a plain global argmax latches onto the roof and drags every
    // column's floor (and the navmesh, seed, and region) up onto it. To avoid that we:
    //   1. Smooth the histogram so a floor whose weight straddles adjacent bins is not
    //      out-voted by a roof concentrated in a single bin.
    //   2. Keep only peaks that are both significant and not below the floater-robust
    //      percentile floor `floor_y_hint` (rejecting sub-floor slivers/reflections).
    //   3. Pick the LOWEST such peak (the floor sits beneath shelving, mezzanines, roof).
    let global_floor_height = {
        let n = floor_histogram.len();
        let smooth_radius = ((0.15 / vertical_cell_size).round() as usize).clamp(1, 6);
        let mut smoothed = vec![0.0_f64; n];
        for b in 0..n {
            let lo = b.saturating_sub(smooth_radius);
            let hi = (b + smooth_radius + 1).min(n);
            smoothed[b] = floor_histogram[lo..hi].iter().sum();
        }
        let max_weight = smoothed.iter().copied().fold(0.0_f64, f64::max);
        if max_weight <= 0.0 {
            None
        } else {
            let significance = 0.25 * max_weight;
            // Do not accept a "floor" appreciably below the percentile floor: that is
            // sub-floor noise, not the walkable surface.
            let lower_bound = floor_y_hint - (vertical_cell_size * 4.0).max(0.5);
            let bin_height = |b: usize| min_y + (b as f64 + 0.5) * vertical_cell_size;
            let qualifies = |b: usize| smoothed[b] >= significance && bin_height(b) >= lower_bound;
            // Prefer the lowest significant local maximum (a real plane, not a skirt).
            let lowest_peak = (0..n).find(|&b| {
                qualifies(b)
                    && (b == 0 || smoothed[b] >= smoothed[b - 1])
                    && (b + 1 >= n || smoothed[b] >= smoothed[b + 1])
            });
            // Fallbacks: lowest qualifying bin, then the global argmax (legacy behavior).
            let chosen = lowest_peak
                .or_else(|| (0..n).find(|&b| qualifies(b)))
                .or_else(|| {
                    smoothed
                        .iter()
                        .enumerate()
                        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                        .map(|(b, _)| b)
                });
            chosen.map(bin_height)
        }
    };

    // PASS 2 -- classify each column against the scene-wide floor plane.
    for cell_idx in 0..cell_count {
        let layers = &all_layers[cell_idx];
        let peak_density = peak_densities[cell_idx];
        if peak_density <= 0.0 {
            continue;
        }
        if layers.is_empty() {
            surfaces[cell_idx] = DensitySurface {
                peak_density,
                ..empty_density_surface()
            };
            continue;
        }

        // Anchor the floor to the scene-wide dominant plane: pick the layer whose centroid
        // sits closest to it. Faint sub-floor slivers (below the plane) and furniture/shelf
        // tops (above the plane) are both farther away than the real floor layer, so neither
        // is mistaken for the floor -- and there is no hand-tuned distance constant. Without
        // a detected plane (degenerate scenes) we fall back to the lowest layer.
        let primary_idx = match global_floor_height {
            Some(floor_y) => layers
                .iter()
                .enumerate()
                .min_by(|a, b| {
                    (a.1 .2 - floor_y)
                        .abs()
                        .partial_cmp(&(b.1 .2 - floor_y).abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(idx, _)| idx)
                .unwrap_or(0),
            None => 0,
        };
        let primary = layers[primary_idx];
        // The walkable surface is the density-weighted centroid of the floor layer, which
        // coincides with the measured dominant floor plane (where the rendered floor is
        // densest and where an agent visibly stands).
        let primary_centroid = primary.2;
        let primary_height = primary_centroid;
        let mut variance_sum = 0.0;
        let mut variance_weight = 0.0;
        for layer in layers.iter().take(max_layers.max(1)) {
            let delta = layer.2 - primary_centroid;
            variance_sum += delta * delta * layer.3;
            variance_weight += layer.3;
        }

        // Only density inside the agent clearance band above the floor layer counts as a
        // navigation obstacle. Density at or below the floor surface (delta < clearance_lo)
        // is floor slab/sub-floor; density above clearance_hi (ceiling, high shelves, tall
        // plant canopy) does not block walking. in_clearance_band excludes the floor layer
        // itself (delta 0) and anything beneath it, so all layers can be scanned uniformly.
        let in_clearance_band = |height: f64| -> bool {
            let delta = height - primary_height;
            delta >= clearance_lo && delta <= clearance_hi
        };
        let obstacle_density = layers
            .iter()
            .filter(|(_, _, height, _)| in_clearance_band(*height))
            .map(|(_, _, _, weight)| *weight)
            .sum::<f64>();
        let obstacle_bins = layers
            .iter()
            .filter(|(_, _, height, _)| in_clearance_band(*height))
            .map(|(start, end, _, _)| end - start + 1)
            .sum();
        let signed_distance_proxy = density_threshold - peak_density;

        surfaces[cell_idx] = DensitySurface {
            primary_height: Some(primary_height),
            layer_count: layers.len(),
            peak_density,
            surface_confidence: primary.3,
            obstacle_density,
            height_variance: if variance_weight > 0.0 {
                variance_sum / variance_weight
            } else {
                0.0
            },
            signed_distance_proxy,
            floor_bins: primary.1 - primary.0 + 1,
            obstacle_bins,
        };
    }

    surfaces
}

fn smooth_surface_heights(
    heights: &mut [Option<f64>],
    surfaces: &[DensitySurface],
    width: usize,
    height: usize,
    radius: usize,
    floor_height: f64,
    near_floor_band: f64,
) -> usize {
    if radius == 0 || width == 0 || height == 0 {
        return 0;
    }

    let original = heights.to_vec();
    // A cell participates in smoothing when it is single-layer OR when its (multi-layer)
    // surface sits close to the dominant floor plane. Multi-layer floor cells near shelving
    // / overhead used to be excluded entirely, so their raw, noisy heights produced vertical
    // cracks that fragmented an otherwise-flat floor.
    let is_smoothable = |idx: usize| -> bool {
        if surfaces[idx].layer_count <= 1 {
            return true;
        }
        matches!(original[idx], Some(h) if (h - floor_height).abs() <= near_floor_band)
    };
    let mut updates = Vec::<(usize, f64)>::new();

    for row in 0..height {
        for col in 0..width {
            let idx = row * width + col;
            if original[idx].is_none() || !is_smoothable(idx) {
                continue;
            }

            let row_min = row.saturating_sub(radius);
            let row_max = (row + radius).min(height - 1);
            let col_min = col.saturating_sub(radius);
            let col_max = (col + radius).min(width - 1);
            let mut sum = 0.0;
            let mut count = 0usize;

            for rr in row_min..=row_max {
                for cc in col_min..=col_max {
                    let nidx = rr * width + cc;
                    if is_smoothable(nidx) {
                        if let Some(h) = original[nidx] {
                            sum += h;
                            count += 1;
                        }
                    }
                }
            }

            if count >= 3 {
                updates.push((idx, sum / count as f64));
            }
        }
    }

    let count = updates.len();
    for (idx, height_value) in updates {
        heights[idx] = Some(height_value);
    }
    count
}

fn apply_gradients(
    cells: &mut [GroundFieldCell],
    heights: &[Option<f64>],
    width: usize,
    height: usize,
    cell_size: f64,
) {
    if width == 0 || height == 0 || cell_size <= 0.0 {
        return;
    }

    for row in 0..height {
        for col in 0..width {
            let idx = row * width + col;
            let Some(center) = heights[idx] else {
                continue;
            };

            let left = if col > 0 {
                heights[row * width + col - 1].unwrap_or(center)
            } else {
                center
            };
            let right = if col + 1 < width {
                heights[row * width + col + 1].unwrap_or(center)
            } else {
                center
            };
            let down = if row > 0 {
                heights[(row - 1) * width + col].unwrap_or(center)
            } else {
                center
            };
            let up = if row + 1 < height {
                heights[(row + 1) * width + col].unwrap_or(center)
            } else {
                center
            };

            cells[idx].gradient = [
                ((right - left) / (2.0 * cell_size)) as f32,
                ((up - down) / (2.0 * cell_size)) as f32,
            ];
        }
    }
}

fn is_accepted_state(state: &GroundFieldCellState) -> bool {
    matches!(
        state,
        GroundFieldCellState::Walkable | GroundFieldCellState::Filled
    )
}

/// Cell states that may be closed by [`fill_low_confidence_holes`] when they form a
/// small pocket fully enclosed by accepted floor: low-confidence cells and density
/// voids (seams, painted lines, reflective patches) that would otherwise fragment a
/// continuous floor.
fn is_fillable_hole(state: &GroundFieldCellState) -> bool {
    matches!(
        state,
        GroundFieldCellState::LowConfidence | GroundFieldCellState::Void
    )
}

fn is_blocking_state(state: &GroundFieldCellState) -> bool {
    matches!(
        state,
        GroundFieldCellState::Obstacle
            | GroundFieldCellState::HeightVariance
            | GroundFieldCellState::Void
            | GroundFieldCellState::LowConfidence
    )
}

fn erode_agent_radius(
    cells: &mut [GroundFieldCell],
    width: usize,
    height: usize,
    agent_radius: f64,
    cell_size: f64,
) -> usize {
    if agent_radius <= 0.0 || cell_size <= 0.0 || width == 0 || height == 0 {
        return 0;
    }

    let distances = distance_field_to_blocked(cells, width, height);
    let erode = distances
        .iter()
        .enumerate()
        .filter_map(|(idx, distance_cells)| {
            if is_accepted_state(&cells[idx].state) && *distance_cells * cell_size < agent_radius {
                Some(idx)
            } else {
                None
            }
        })
        .collect::<Vec<usize>>();

    let count = erode.len();
    for idx in erode {
        cells[idx].state = GroundFieldCellState::Eroded;
        cells[idx].component_id = -1;
    }
    count
}

fn distance_field_to_blocked(cells: &[GroundFieldCell], width: usize, height: usize) -> Vec<f64> {
    let mut distances = vec![f64::INFINITY; cells.len()];
    let diagonal = std::f64::consts::SQRT_2;

    for row in 0..height {
        for col in 0..width {
            let idx = row * width + col;
            if is_blocking_state(&cells[idx].state) {
                distances[idx] = 0.0;
            } else if row == 0 || col == 0 || row + 1 == height || col + 1 == width {
                distances[idx] = distances[idx].min(1.0);
            }
        }
    }

    for row in 0..height {
        for col in 0..width {
            let idx = row * width + col;
            let mut best = distances[idx];
            if row > 0 {
                best = best.min(distances[(row - 1) * width + col] + 1.0);
                if col > 0 {
                    best = best.min(distances[(row - 1) * width + col - 1] + diagonal);
                }
                if col + 1 < width {
                    best = best.min(distances[(row - 1) * width + col + 1] + diagonal);
                }
            }
            if col > 0 {
                best = best.min(distances[row * width + col - 1] + 1.0);
            }
            distances[idx] = best;
        }
    }

    for row in (0..height).rev() {
        for col in (0..width).rev() {
            let idx = row * width + col;
            let mut best = distances[idx];
            if row + 1 < height {
                best = best.min(distances[(row + 1) * width + col] + 1.0);
                if col > 0 {
                    best = best.min(distances[(row + 1) * width + col - 1] + diagonal);
                }
                if col + 1 < width {
                    best = best.min(distances[(row + 1) * width + col + 1] + diagonal);
                }
            }
            if col + 1 < width {
                best = best.min(distances[row * width + col + 1] + 1.0);
            }
            distances[idx] = best;
        }
    }

    distances
}

fn select_connected_component(
    cells: &mut [GroundFieldCell],
    width: usize,
    height: usize,
    mode: Option<&str>,
) -> (usize, usize, i32, usize) {
    if width == 0 || height == 0 {
        return (0, 0, -1, 0);
    }

    let mut component_sizes: Vec<usize> = Vec::new();
    let mut component_centers: Vec<(f64, f64)> = Vec::new();
    let mut current_component: i32 = 0;

    for row in 0..height {
        for col in 0..width {
            let start_idx = row * width + col;
            if !is_accepted_state(&cells[start_idx].state) || cells[start_idx].component_id >= 0 {
                continue;
            }

            let mut queue = std::collections::VecDeque::new();
            queue.push_back((row, col));
            cells[start_idx].component_id = current_component;
            let mut size = 0usize;
            let mut sum_row = 0.0;
            let mut sum_col = 0.0;

            while let Some((r, c)) = queue.pop_front() {
                size += 1;
                sum_row += r as f64;
                sum_col += c as f64;

                for (nr, nc) in neighbors4(r, c, width, height) {
                    let nidx = nr * width + nc;
                    if is_accepted_state(&cells[nidx].state) && cells[nidx].component_id < 0 {
                        cells[nidx].component_id = current_component;
                        queue.push_back((nr, nc));
                    }
                }
            }

            component_sizes.push(size);
            component_centers.push((sum_row / size as f64, sum_col / size as f64));
            current_component += 1;
        }
    }

    if component_sizes.is_empty() {
        return (0, 0, -1, 0);
    }

    let selected_component = if matches!(mode, Some("all")) {
        component_sizes
            .iter()
            .enumerate()
            .max_by_key(|(_, size)| *size)
            .map(|(idx, _)| idx as i32)
            .unwrap_or(0)
    } else if matches!(mode, Some("nearest_region_center")) {
        let target = ((height as f64 - 1.0) * 0.5, (width as f64 - 1.0) * 0.5);
        component_centers
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| {
                let da = (a.0 - target.0).powi(2) + (a.1 - target.1).powi(2);
                let db = (b.0 - target.0).powi(2) + (b.1 - target.1).powi(2);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(idx, _)| idx as i32)
            .unwrap_or(0)
    } else {
        component_sizes
            .iter()
            .enumerate()
            .max_by_key(|(_, size)| *size)
            .map(|(idx, _)| idx as i32)
            .unwrap_or(0)
    };

    let mut discarded = 0;
    if !matches!(mode, Some("all")) {
        for cell in cells.iter_mut() {
            if is_accepted_state(&cell.state) && cell.component_id != selected_component {
                cell.state = GroundFieldCellState::DiscardedComponent;
                discarded += 1;
            }
        }
    }

    (
        component_sizes.len(),
        *component_sizes
            .get(selected_component as usize)
            .unwrap_or(&0),
        selected_component,
        discarded,
    )
}

fn neighbors4(row: usize, col: usize, width: usize, height: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(4);
    if row > 0 {
        out.push((row - 1, col));
    }
    if row + 1 < height {
        out.push((row + 1, col));
    }
    if col > 0 {
        out.push((row, col - 1));
    }
    if col + 1 < width {
        out.push((row, col + 1));
    }
    out
}

fn find_floor_plane(
    points: &[Point3<Real>],
    threshold: f64,
    iterations: usize,
    floor_y: f64,
    lower_band_height: f64,
    min_normal_y: f64,
) -> (Option<Plane>, usize) {
    let mut rng = rand::thread_rng();
    let lower_limit = floor_y + lower_band_height;
    let mut sample_indices = points
        .iter()
        .enumerate()
        .filter_map(|(idx, p)| {
            if (p.y as f64) <= lower_limit {
                Some(idx)
            } else {
                None
            }
        })
        .collect::<Vec<usize>>();

    if sample_indices.len() < 3 {
        sample_indices = (0..points.len()).collect();
    }

    if sample_indices.len() < 3 {
        return (None, 0);
    }

    let mut best_plane = None;
    let mut best_score = 0.0_f64;
    let mut best_inliers = 0usize;

    for _ in 0..iterations {
        let idx1 = sample_indices[rng.gen_range(0..sample_indices.len())];
        let idx2 = sample_indices[rng.gen_range(0..sample_indices.len())];
        let idx3 = sample_indices[rng.gen_range(0..sample_indices.len())];
        if idx1 == idx2 || idx2 == idx3 || idx1 == idx3 {
            continue;
        }

        let Some(mut plane) = Plane::from_points(&points[idx1], &points[idx2], &points[idx3])
        else {
            continue;
        };

        if plane.normal.y < 0.0 {
            plane.normal = -plane.normal;
            plane.d = -plane.d;
        }

        if (plane.normal.y as f64) < min_normal_y {
            continue;
        }

        let mut lower_inliers = 0usize;
        let mut all_inliers = 0usize;
        let mut low_height_error = 0.0_f64;

        for p in points {
            if plane.distance(p) < threshold {
                all_inliers += 1;
                if (p.y as f64) <= lower_limit {
                    lower_inliers += 1;
                    low_height_error += ((p.y as f64) - floor_y).abs();
                }
            }
        }

        if lower_inliers == 0 {
            continue;
        }

        let mean_low_height_error = low_height_error / lower_inliers as f64;
        let low_band_bonus = lower_inliers as f64 * 3.0;
        let height_penalty = mean_low_height_error / lower_band_height.max(0.001);
        let score = all_inliers as f64 + low_band_bonus - height_penalty;

        if score > best_score {
            best_score = score;
            best_inliers = all_inliers;
            best_plane = Some(plane);
        }
    }

    (best_plane, best_inliers)
}

fn find_ransac_plane(
    points: &[Point3<Real>],
    threshold: f64,
    iterations: usize,
) -> (Option<Plane>, usize) {
    let mut rng = rand::thread_rng();
    let mut best_plane = None;
    let mut max_inliers = 0;
    let n = points.len();

    if n <= 3 {
        return (best_plane, max_inliers);
    }

    for _ in 0..iterations {
        let idx1 = rng.gen_range(0..n);
        let idx2 = rng.gen_range(0..n);
        let idx3 = rng.gen_range(0..n);
        if idx1 == idx2 || idx2 == idx3 || idx1 == idx3 {
            continue;
        }

        if let Some(plane) = Plane::from_points(&points[idx1], &points[idx2], &points[idx3]) {
            let inliers = points
                .iter()
                .filter(|p| plane.distance(p) < threshold)
                .count();
            if inliers > max_inliers {
                max_inliers = inliers;
                best_plane = Some(plane);
            }
        }
    }

    (best_plane, max_inliers)
}

fn reconstruct_plane_ransac(
    points: &[PointNormal],
    diagnostics: &mut ReconstructionDiagnostics,
) -> ReconstructedMesh {
    let p_coords: Vec<Point3<Real>> = points
        .iter()
        .map(|p| Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real))
        .collect();

    if p_coords.len() < 3 {
        return ReconstructedMesh {
            vertices: vec![],
            indices: vec![],
        };
    }

    let (best_plane, max_inliers) = find_ransac_plane(&p_coords, 0.2, 2000);
    diagnostics.ransac_inliers = max_inliers;

    if let Some(plane) = best_plane {
        generate_plane_mesh(&plane, &p_coords, 0.2)
    } else {
        ReconstructedMesh {
            vertices: vec![],
            indices: vec![],
        }
    }
}

fn generate_plane_mesh(
    plane: &Plane,
    points: &[Point3<Real>],
    threshold: Real,
) -> ReconstructedMesh {
    let normal = plane.normal;
    let mut tangent = if normal.x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    tangent = (tangent - normal * normal.dot(&tangent)).normalize();
    let bitangent = normal.cross(&tangent);
    let mut min_u = Real::MAX;
    let mut max_u = Real::MIN;
    let mut min_v = Real::MAX;
    let mut max_v = Real::MIN;
    let mut count = 0;

    for p in points {
        if plane.distance(p) < threshold {
            let u = p.coords.dot(&tangent);
            let v = p.coords.dot(&bitangent);
            min_u = min_u.min(u);
            max_u = max_u.max(u);
            min_v = min_v.min(v);
            max_v = max_v.max(v);
            count += 1;
        }
    }

    if count == 0 {
        return ReconstructedMesh {
            vertices: vec![],
            indices: vec![],
        };
    }

    let corners_uv = [
        (min_u, min_v),
        (max_u, min_v),
        (max_u, max_v),
        (min_u, max_v),
    ];
    let mut vertices = Vec::new();

    for (u, v) in corners_uv {
        let p_rec = u * tangent + v * bitangent - plane.d * normal;
        vertices.push(p_rec.x as f32);
        vertices.push(p_rec.y as f32);
        vertices.push(p_rec.z as f32);
    }

    ReconstructedMesh {
        vertices,
        indices: vec![0, 1, 2, 0, 2, 3],
    }
}

fn reconstruct_poisson(points: &[PointNormal]) -> ReconstructedMesh {
    let p_coords: Vec<Point3<Real>> = points
        .iter()
        .map(|p| Point3::new(p.point.x as Real, p.point.y as Real, p.point.z as Real))
        .collect();
    let p_normals: Vec<Vector3<Real>> = points
        .iter()
        .map(|p| Vector3::new(p.normal.x as Real, p.normal.y as Real, p.normal.z as Real))
        .collect();

    if p_coords.is_empty() {
        return ReconstructedMesh {
            vertices: vec![],
            indices: vec![],
        };
    }

    let poisson =
        PoissonReconstruction::from_points_and_normals(&p_coords, &p_normals, 0.0, 4, 4, 10);
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

// ---------------------------------------------------------------------------
// WASM-side room-floor extraction (port of the TypeScript FAST NAV floor path).
// ---------------------------------------------------------------------------

/// Successful result of [`extract_room_floor`].
pub struct RoomFloorBuild {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub diagnostics: ReconstructionDiagnostics,
    pub selected_area: f64,
    pub component_count: usize,
    pub selected_cell_count: usize,
    pub accepted_cell_count: usize,
    pub obstacle_cell_count: usize,
    pub rejected_cell_count: usize,
    pub fallback_used: bool,
    pub step_label: String,
}

/// Typed failure from [`extract_room_floor`]; `reason` mirrors the TypeScript
/// `FastNavFloorReason` (`no_component` / `too_small` / `empty_mesh`). `area` and
/// `components` carry diagnostic context for callers that want it.
#[allow(dead_code)]
pub struct RoomFloorError {
    pub reason: String,
    pub message: String,
    pub area: f64,
    pub components: usize,
}

struct FloorComponent {
    cells: Vec<usize>,
    distance_to_seed: f64,
}

/// Drop a small number of stray peripheral / height-outlier cells, keeping the
/// largest contiguous in-band core. Conservative: returns the input unchanged
/// when removals would be structural. Port of TS `trimStrayFloorCells` defaults.
fn trim_stray_floor_cells(field: &FieldBuild, cells: &[usize]) -> Vec<usize> {
    let height_tolerance = 0.5_f64;
    let max_stray_fraction = 0.3_f64;
    let min_keep_cells = 16usize;

    if cells.len() <= min_keep_cells {
        return cells.to_vec();
    }

    let mut heights: Vec<f64> = cells
        .iter()
        .filter_map(|&i| {
            let h = field.cells[i].height;
            if h.is_finite() {
                Some(h as f64)
            } else {
                None
            }
        })
        .collect();
    if heights.is_empty() {
        return cells.to_vec();
    }
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_height = heights[heights.len() / 2];

    let within_band: Vec<usize> = cells
        .iter()
        .cloned()
        .filter(|&i| {
            let h = field.cells[i].height;
            h.is_finite() && ((h as f64) - median_height).abs() <= height_tolerance
        })
        .collect();
    let dropped_height_outliers = cells.len() - within_band.len();
    if (dropped_height_outliers as f64) > max_stray_fraction * cells.len() as f64
        || within_band.len() < min_keep_cells
    {
        return cells.to_vec();
    }

    let width = field.width;
    let height = field.height;
    let in_band: std::collections::HashSet<usize> = within_band.iter().cloned().collect();
    let mut visited: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut best: Vec<usize> = Vec::new();
    for &start in &within_band {
        if visited.contains(&start) {
            continue;
        }
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(start);
        visited.insert(start);
        let mut cluster: Vec<usize> = Vec::new();
        while let Some(idx) = queue.pop_front() {
            cluster.push(idx);
            let row = idx / width;
            let col = idx % width;
            let mut neighbors: Vec<isize> = Vec::with_capacity(4);
            neighbors.push(if row > 0 {
                idx as isize - width as isize
            } else {
                -1
            });
            neighbors.push(if row + 1 < height {
                idx as isize + width as isize
            } else {
                -1
            });
            neighbors.push(if col > 0 { idx as isize - 1 } else { -1 });
            neighbors.push(if col + 1 < width {
                idx as isize + 1
            } else {
                -1
            });
            for n in neighbors {
                if n >= 0 {
                    let nu = n as usize;
                    if in_band.contains(&nu) && !visited.contains(&nu) {
                        visited.insert(nu);
                        queue.push_back(nu);
                    }
                }
            }
        }
        if cluster.len() > best.len() {
            best = cluster;
        }
    }

    let dropped_peripheral = within_band.len() - best.len();
    let total_dropped = dropped_height_outliers + dropped_peripheral;
    if best.len() < min_keep_cells
        || (total_dropped as f64) > max_stray_fraction * cells.len() as f64
    {
        return cells.to_vec();
    }
    best
}

/// Extract a triangulated room-floor mesh from the 2.5D ground field. Port of the
/// TypeScript `buildFastFloorMesh` selection + trim + triangulation, with the
/// seed snapped to the detected floor plane.
pub fn extract_room_floor(
    points: &[PointNormal],
    settings: &MeshSettings,
    min_room_floor_area: f64,
    step_label: &str,
) -> Result<RoomFloorBuild, RoomFloorError> {
    let context = build_context(points, settings);
    let mut diagnostics = context.diagnostics.clone();
    let field =
        build_field(&context, settings, &mut diagnostics).ok_or_else(|| RoomFloorError {
            reason: "no_component".to_string(),
            message: "Unable to build walkable ground field".to_string(),
            area: 0.0,
            components: 0,
        })?;

    let cs = field.cell_size;
    let width = field.width;
    let height = field.height;

    // Seed (oriented space), snapped to the detected floor plane height.
    let mut seed: Option<[f64; 3]> = settings.collision_seed.as_ref().and_then(|s| {
        if s.len() >= 3 {
            Some([s[0], s[1], s[2]])
        } else {
            None
        }
    });
    let floor_y = field.diagnostics.floor_plane_height;
    if let Some(ref mut s) = seed {
        if floor_y.is_finite() {
            s[1] = floor_y;
        }
    }

    let o = field.basis.origin;
    let t = field.basis.tangent;
    let bi = field.basis.bitangent;
    let up = field.basis.up;
    let point_at = |col: f64, row: f64, h: f64| -> [f64; 3] {
        [
            o[0] + t[0] * col * cs + bi[0] * row * cs + up[0] * h,
            o[1] + t[1] * col * cs + bi[1] * row * cs + up[1] * h,
            o[2] + t[2] * col * cs + bi[2] * row * cs + up[2] * h,
        ]
    };
    let cell_center = |idx: usize| -> [f64; 3] {
        let row = (idx / width) as f64;
        let col = (idx % width) as f64;
        let h = field.cells[idx].height;
        let h = if h.is_finite() { h as f64 } else { 0.0 };
        point_at(col + 0.5, row + 0.5, h)
    };

    // State counts (per documented GroundFieldCellState names).
    let mut state_counts: std::collections::HashMap<&'static str, usize> =
        std::collections::HashMap::new();
    for cell in &field.cells {
        *state_counts.entry(state_name(&cell.state)).or_insert(0) += 1;
    }
    let obstacle_cell_count = *state_counts.get("obstacle").unwrap_or(&0)
        + *state_counts.get("height_variance").unwrap_or(&0);

    let build_mask = |relaxed: bool| -> Vec<bool> {
        field
            .cells
            .iter()
            .map(|cell| {
                match cell.state {
                    GroundFieldCellState::Walkable | GroundFieldCellState::Filled => return true,
                    _ => {}
                }
                if !relaxed {
                    return false;
                }
                if !cell.height.is_finite() {
                    return false;
                }
                match cell.state {
                    GroundFieldCellState::DiscardedComponent => true,
                    GroundFieldCellState::LowConfidence => {
                        cell.variance <= 0.18 && cell.obstacle_score <= 0.42
                    }
                    GroundFieldCellState::HeightVariance => {
                        cell.confidence >= 0.01
                            && cell.variance <= 0.08
                            && cell.obstacle_score <= 0.35
                    }
                    GroundFieldCellState::Obstacle => {
                        cell.confidence >= 0.02
                            && cell.variance <= 0.05
                            && cell.obstacle_score <= 0.52
                    }
                    _ => false,
                }
            })
            .collect()
    };

    let collect_components = |mask: &[bool]| -> Vec<FloorComponent> {
        let mut visited = vec![false; field.cells.len()];
        let mut components: Vec<FloorComponent> = Vec::new();
        for start in 0..field.cells.len() {
            if !mask[start] || visited[start] {
                continue;
            }
            let mut queue = std::collections::VecDeque::new();
            queue.push_back(start);
            visited[start] = true;
            let mut cells: Vec<usize> = Vec::new();
            let (mut sx, mut sy, mut sz) = (0.0_f64, 0.0_f64, 0.0_f64);
            while let Some(idx) = queue.pop_front() {
                cells.push(idx);
                let c = cell_center(idx);
                sx += c[0];
                sy += c[1];
                sz += c[2];
                let row = idx / width;
                let col = idx % width;
                let mut neighbors: Vec<isize> = Vec::with_capacity(4);
                neighbors.push(if row > 0 {
                    idx as isize - width as isize
                } else {
                    -1
                });
                neighbors.push(if row + 1 < height {
                    idx as isize + width as isize
                } else {
                    -1
                });
                neighbors.push(if col > 0 { idx as isize - 1 } else { -1 });
                neighbors.push(if col + 1 < width {
                    idx as isize + 1
                } else {
                    -1
                });
                for n in neighbors {
                    if n >= 0 {
                        let nu = n as usize;
                        if mask[nu] && !visited[nu] {
                            visited[nu] = true;
                            queue.push_back(nu);
                        }
                    }
                }
            }
            let inv = 1.0 / cells.len() as f64;
            let centroid = [sx * inv, sy * inv, sz * inv];
            let distance_to_seed = match seed {
                Some(s) => {
                    let dx = centroid[0] - s[0];
                    let dy = centroid[1] - s[1];
                    let dz = centroid[2] - s[2];
                    (dx * dx + dy * dy + dz * dz).sqrt()
                }
                None => 0.0,
            };
            components.push(FloorComponent {
                cells,
                distance_to_seed,
            });
        }
        components
    };

    let select = |components: &Vec<FloorComponent>| -> Option<(usize, bool)> {
        let min_cells = 20usize;
        let min_area = 1.2_f64;
        let max_seed_distance = 3.25_f64;
        let viable: Vec<usize> = (0..components.len())
            .filter(|&i| {
                let c = &components[i];
                let area = c.cells.len() as f64 * cs * cs;
                c.cells.len() >= min_cells && area >= min_area
            })
            .collect();
        if viable.is_empty() {
            return None;
        }
        let seed_near: Vec<usize> = if seed.is_some() {
            viable
                .iter()
                .cloned()
                .filter(|&i| components[i].distance_to_seed <= max_seed_distance)
                .collect()
        } else {
            viable.clone()
        };
        let used_largest_fallback = seed.is_some() && seed_near.is_empty();
        let mut candidates = if !seed_near.is_empty() {
            seed_near.clone()
        } else {
            viable.clone()
        };
        if seed.is_none() || seed_near.is_empty() {
            candidates.sort_by(|&a, &b| components[b].cells.len().cmp(&components[a].cells.len()));
        } else {
            let score = |i: usize| -> f64 {
                let c = &components[i];
                let area = c.cells.len() as f64 * cs * cs;
                c.distance_to_seed - area.sqrt() * 0.45
            };
            candidates.sort_by(|&a, &b| {
                score(a)
                    .partial_cmp(&score(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(components[b].cells.len().cmp(&components[a].cells.len()))
            });
        }
        Some((candidates[0], used_largest_fallback))
    };

    let area_of_sel = |comps: &Vec<FloorComponent>, sel: &Option<(usize, bool)>| -> f64 {
        sel.as_ref()
            .map(|(i, _)| comps[*i].cells.len() as f64 * cs * cs)
            .unwrap_or(0.0)
    };

    let strict_mask = build_mask(false);
    let accepted_cell_count = strict_mask.iter().filter(|b| **b).count();
    let rejected_cell_count = field.cells.len() - accepted_cell_count;
    let mut components = collect_components(&strict_mask);
    let mut selection = select(&components);
    let mut fallback_used = false;

    if selection.is_none() || area_of_sel(&components, &selection) < min_room_floor_area {
        let relaxed_mask = build_mask(true);
        let relaxed_components = collect_components(&relaxed_mask);
        let relaxed_selection = select(&relaxed_components);
        let relaxed_area = area_of_sel(&relaxed_components, &relaxed_selection);
        if relaxed_selection.is_some()
            && (selection.is_none() || relaxed_area > area_of_sel(&components, &selection))
        {
            components = relaxed_components;
            selection = relaxed_selection;
            fallback_used = true;
        }
    }

    let component_count = components.len();
    let (sel_idx, used_largest_fallback) = match selection {
        Some(s) => s,
        None => {
            let largest = components.iter().map(|c| c.cells.len()).max().unwrap_or(0);
            let largest_area = largest as f64 * cs * cs;
            return Err(RoomFloorError {
                reason: "no_component".to_string(),
                message: format!(
                    "Could not find a viable floor component (components={}, largest={} cells, {:.2} m^2).",
                    component_count, largest, largest_area
                ),
                area: largest_area,
                components: component_count,
            });
        }
    };
    if used_largest_fallback {
        fallback_used = true;
    }

    let floor_cells = trim_stray_floor_cells(&field, &components[sel_idx].cells);

    let selected_area = floor_cells.len() as f64 * cs * cs;
    if selected_area < min_room_floor_area {
        return Err(RoomFloorError {
            reason: "too_small".to_string(),
            message: format!(
                "Floor is too small to be a room ({:.2} m^2 < {:.1} m^2, components={}, accepted={}).",
                selected_area, min_room_floor_area, component_count, accepted_cell_count
            ),
            area: selected_area,
            components: component_count,
        });
    }

    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    for &idx in &floor_cells {
        let row = (idx / width) as f64;
        let col = (idx % width) as f64;
        let h = field.cells[idx].height;
        let h = if h.is_finite() { h as f64 } else { 0.0 };
        let base = (positions.len() / 3) as u32;
        for p in [
            point_at(col, row, h),
            point_at(col, row + 1.0, h),
            point_at(col + 1.0, row + 1.0, h),
            point_at(col + 1.0, row, h),
        ] {
            positions.push(p[0] as f32);
            positions.push(p[1] as f32);
            positions.push(p[2] as f32);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    if positions.is_empty() || indices.is_empty() {
        return Err(RoomFloorError {
            reason: "empty_mesh".to_string(),
            message: "Produced an empty floor mesh.".to_string(),
            area: selected_area,
            components: component_count,
        });
    }

    Ok(RoomFloorBuild {
        positions,
        indices,
        basis: field.basis.clone(),
        floor_plane: field.plane.clone(),
        diagnostics: field.diagnostics.clone(),
        selected_area,
        component_count,
        selected_cell_count: floor_cells.len(),
        accepted_cell_count,
        obstacle_cell_count,
        rejected_cell_count,
        fallback_used,
        step_label: step_label.to_string(),
    })
}

/// Stable string name for a [`GroundFieldCellState`] (matches the serde
/// `snake_case` rename used on the wire).
fn state_name(state: &GroundFieldCellState) -> &'static str {
    match state {
        GroundFieldCellState::Walkable => "walkable",
        GroundFieldCellState::LowConfidence => "low_confidence",
        GroundFieldCellState::HeightVariance => "height_variance",
        GroundFieldCellState::Obstacle => "obstacle",
        GroundFieldCellState::Void => "void",
        GroundFieldCellState::Filled => "filled",
        GroundFieldCellState::Eroded => "eroded",
        GroundFieldCellState::DiscardedComponent => "discarded_component",
    }
}
