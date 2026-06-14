use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

mod splat;
mod mesh;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
pub fn init_splatwalk() -> String {
    console_error_panic_hook::set_once();
    log("G2M WASM Initialized with Parsing Support");
    "Ready".to_string()
}

#[derive(Deserialize)]
pub struct MeshSettings {
    pub mode: u8,
    pub voxel_target: Option<f64>,
    pub sdf_cell_size: Option<f64>,
    pub sdf_vertical_cell_size: Option<f64>,
    pub sdf_density_threshold: Option<f64>,
    pub sdf_max_layers: Option<usize>,
    pub sdf_smoothing_radius: Option<usize>,
    pub sdf_influence_radius_scale: Option<f64>,
    pub collision_voxel_size: Option<f64>,
    pub collision_opacity_threshold: Option<f64>,
    pub collision_scene_type: Option<String>,
    pub collision_seed: Option<Vec<f64>>,
    pub collision_fill_size: Option<f64>,
    pub collision_carve_height: Option<f64>,
    pub collision_carve_radius: Option<f64>,
    pub collision_mesh_mode: Option<String>,
    pub min_alpha: Option<f64>,
    pub max_scale: Option<f64>,
    pub normal_align: Option<f64>,
    pub ransac_thresh: Option<f64>,
    pub floor_projection_epsilon: Option<f64>,
    pub height_projection_epsilon: Option<f64>,
    pub obstacle_height_epsilon: Option<f64>,
    pub obstacle_clearance_min: Option<f64>,
    pub obstacle_clearance_max: Option<f64>,
    pub max_local_height_variance: Option<f64>,
    pub min_floor_confidence: Option<f64>,
    pub hole_fill_radius: Option<usize>,
    pub agent_radius_erode: Option<f64>,
    pub component_mode: Option<String>,
    pub region_min: Option<Vec<f64>>,
    pub region_max: Option<Vec<f64>>,
    pub rotation: Option<Vec<f64>>,
    /// When true, negate the Y axis of every parsed splat (position and normal) so that
    /// WASM operates in the same world space the renderer displays. Gaussian-splat loaders
    /// (e.g. Babylon) flip Y on import; passing that flip here keeps the navmesh, basis,
    /// spawn points and agents co-located with the rendered splat and makes the +Y-up
    /// floor/clearance heuristics valid.
    pub flip_y: Option<bool>,
}

#[derive(Clone, Serialize)]
pub struct MeshBuffers {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_count: usize,
    pub face_count: usize,
}

impl MeshBuffers {
    pub fn new(vertices: Vec<f32>, indices: Vec<u32>) -> Self {
        let vertex_count = vertices.len() / 3;
        let face_count = indices.len() / 3;
        Self { vertices, indices, vertex_count, face_count }
    }
}

#[derive(Clone, Serialize)]
pub struct CoordinateSpace {
    pub space: String,
    pub up_axis: String,
    pub handedness: String,
}

impl CoordinateSpace {
    pub fn splatwalk_oriented() -> Self {
        Self {
            space: "splatwalk_oriented".to_string(),
            up_axis: "y".to_string(),
            handedness: "right".to_string(),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct FloorPlane {
    pub normal: [f64; 3],
    pub d: f64,
}

#[derive(Clone, Serialize)]
pub struct FieldBasis {
    pub origin: [f64; 3],
    pub tangent: [f64; 3],
    pub bitangent: [f64; 3],
    pub up: [f64; 3],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroundFieldCellState {
    Walkable,
    LowConfidence,
    HeightVariance,
    Obstacle,
    Void,
    Filled,
    Eroded,
    DiscardedComponent,
}

#[derive(Clone, Serialize)]
pub struct GroundFieldCell {
    pub height: f32,
    pub confidence: f32,
    pub variance: f32,
    pub normal_alignment: f32,
    pub obstacle_score: f32,
    pub primary_layer_height: f32,
    pub layer_count: usize,
    pub peak_density: f32,
    pub surface_confidence: f32,
    pub signed_distance: f32,
    pub gradient: [f32; 2],
    pub component_id: i32,
    pub state: GroundFieldCellState,
}

#[derive(Clone, Serialize)]
pub struct ReconstructionDiagnostics {
    pub api_version: u8,
    pub region_min: Option<Vec<f64>>,
    pub region_max: Option<Vec<f64>>,
    pub oriented_min: Option<[f64; 3]>,
    pub oriented_max: Option<[f64; 3]>,
    pub floor_y_percentile_02: Option<f64>,
    pub points_total: usize,
    pub points_invalid: usize,
    pub points_region_discarded: usize,
    pub points_after_filter: usize,
    pub ransac_inliers: usize,
    pub grid_width: usize,
    pub grid_height: usize,
    pub cell_size: f64,
    pub valid_vertices: usize,
    pub faces_generated: usize,
    pub faces_rejected_no_coverage: usize,
    pub faces_rejected_too_steep: usize,
    pub connected_components: usize,
    pub largest_component_faces: usize,
    pub holes_filled: usize,
    pub rejected_cells: usize,
    pub cells_rejected_low_confidence: usize,
    pub cells_rejected_height_variance: usize,
    pub cells_rejected_obstacle: usize,
    pub cells_void: usize,
    pub cells_filled: usize,
    pub cells_eroded: usize,
    pub cells_discarded_component: usize,
    pub selected_component_id: i32,
    pub selected_component_area: f64,
    pub floor_plane_source: String,
    pub floor_plane_normal_y: f64,
    pub floor_plane_height: f64,
    pub floor_plane_used_fallback: bool,
    pub sdf_density_threshold: f64,
    pub sdf_vertical_cell_size: f64,
    pub sdf_profile_bins: usize,
    pub sdf_cells_with_surface: usize,
    pub sdf_cells_multi_layer: usize,
    pub sdf_cells_smoothed: usize,
    pub collision_voxel_size: f64,
    pub collision_grid_width: usize,
    pub collision_grid_height: usize,
    pub collision_grid_depth: usize,
    pub collision_occupied_voxels: usize,
    pub collision_cluster_kept_voxels: usize,
    pub collision_cluster_discarded_voxels: usize,
    pub collision_filled_voxels: usize,
    pub collision_carved_voxels: usize,
    pub collision_surface_faces: usize,
    pub collision_seed_used: Option<[f64; 3]>,
    pub collision_seed_state: String,
    pub collision_scene_type: String,
    pub collision_mesh_mode: String,
    pub collision_external_fill_leaked: bool,
    pub collision_failure_reason: Option<String>,
    pub floor_plane: Option<FloorPlane>,
}

impl ReconstructionDiagnostics {
    pub fn empty(points_total: usize) -> Self {
        Self {
            api_version: 2,
            region_min: None,
            region_max: None,
            oriented_min: None,
            oriented_max: None,
            floor_y_percentile_02: None,
            points_total,
            points_invalid: 0,
            points_region_discarded: 0,
            points_after_filter: 0,
            ransac_inliers: 0,
            grid_width: 0,
            grid_height: 0,
            cell_size: 0.0,
            valid_vertices: 0,
            faces_generated: 0,
            faces_rejected_no_coverage: 0,
            faces_rejected_too_steep: 0,
            connected_components: 0,
            largest_component_faces: 0,
            holes_filled: 0,
            rejected_cells: 0,
            cells_rejected_low_confidence: 0,
            cells_rejected_height_variance: 0,
            cells_rejected_obstacle: 0,
            cells_void: 0,
            cells_filled: 0,
            cells_eroded: 0,
            cells_discarded_component: 0,
            selected_component_id: -1,
            selected_component_area: 0.0,
            floor_plane_source: "unknown".to_string(),
            floor_plane_normal_y: 0.0,
            floor_plane_height: 0.0,
            floor_plane_used_fallback: false,
            sdf_density_threshold: 0.0,
            sdf_vertical_cell_size: 0.0,
            sdf_profile_bins: 0,
            sdf_cells_with_surface: 0,
            sdf_cells_multi_layer: 0,
            sdf_cells_smoothed: 0,
            collision_voxel_size: 0.0,
            collision_grid_width: 0,
            collision_grid_height: 0,
            collision_grid_depth: 0,
            collision_occupied_voxels: 0,
            collision_cluster_kept_voxels: 0,
            collision_cluster_discarded_voxels: 0,
            collision_filled_voxels: 0,
            collision_carved_voxels: 0,
            collision_surface_faces: 0,
            collision_seed_used: None,
            collision_seed_state: "unknown".to_string(),
            collision_scene_type: "outdoor".to_string(),
            collision_mesh_mode: "faces".to_string(),
            collision_external_fill_leaked: false,
            collision_failure_reason: None,
            floor_plane: None,
        }
    }
}

#[derive(Serialize)]
pub struct ReconstructionResult {
    pub api_version: u8,
    pub mesh: MeshBuffers,
    pub space: CoordinateSpace,
    pub diagnostics: ReconstructionDiagnostics,
}

#[derive(Serialize)]
pub struct SplatBounds {
    pub api_version: u8,
    pub point_count: usize,
    pub oriented_min: [f64; 3],
    pub oriented_max: [f64; 3],
    pub floor_y_percentile_02: f64,
    pub space: CoordinateSpace,
}

#[derive(Serialize)]
pub struct SuggestedRegion {
    pub api_version: u8,
    pub region_min: [f64; 3],
    pub region_max: [f64; 3],
    pub floor_y: f64,
    pub sample_count: usize,
    pub clamped_height: bool,
    pub space: CoordinateSpace,
}

#[derive(Serialize)]
pub struct NavmeshBasisResult {
    pub api_version: u8,
    pub mesh: MeshBuffers,
    pub space: CoordinateSpace,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub diagnostics: ReconstructionDiagnostics,
}

#[derive(Serialize)]
pub struct WalkableGroundFieldResult {
    pub api_version: u8,
    pub cells: Vec<GroundFieldCell>,
    pub width: usize,
    pub height: usize,
    pub cell_size: f64,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub space: CoordinateSpace,
    pub diagnostics: ReconstructionDiagnostics,
}

fn parse_settings(settings: JsValue) -> Result<MeshSettings, JsValue> {
    serde_wasm_bindgen::from_value(settings).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn parse_splats(data: &[u8], settings: &MeshSettings) -> Result<Vec<splat::PointNormal>, JsValue> {
    let mut splats = splat::parse_ply(data).map_err(|e| JsValue::from_str(&e))?;
    if settings.flip_y.unwrap_or(false) {
        for p in &mut splats {
            p.point.y = -p.point.y;
            p.normal.y = -p.normal.y;
        }
        log(&format!("Parsed {} splats (Y-flipped to render space)", splats.len()));
    } else {
        log(&format!("Parsed {} splats", splats.len()));
    }
    Ok(splats)
}

#[wasm_bindgen]
pub fn get_splat_bounds(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let result = mesh::get_splat_bounds(&splats, &settings)?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn suggest_region(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let result = mesh::suggest_region(&splats, &settings)?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn convert_splat_to_mesh(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let mode = settings.mode;
    
    log(&format!("Received {} bytes (Mode: {})", data.len(), mode));
    
    let splats = parse_splats(data, &settings)?;
    let result = mesh::reconstruct_mesh(&splats, &settings);
    log(&format!("Reconstructed mesh with {} vertices", result.mesh.vertex_count));
    
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn convert_splat_to_navmesh_basis(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let result = mesh::convert_splat_to_navmesh_basis(&splats, &settings);
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn build_walkable_ground_field(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let result = mesh::build_walkable_ground_field(&splats, &settings)?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}
