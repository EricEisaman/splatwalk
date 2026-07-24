use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod glb;
mod mesh;
mod output_space;
mod sdf_mc;
mod slice;
mod sog;
mod splat;

use output_space::OutputSpaceSettings;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
pub fn init_splatwalk() -> String {
    console_error_panic_hook::set_once();
    log(&format!("💩🚶 SplatWalk v{} (api {})", core_semver(), API_VERSION));
    "Ready".to_string()
}

/// The integer data-contract version carried on every result. Bumped only on a
/// breaking change to a result shape; additive change is advertised via
/// `capabilities` instead. Kept in one place so every result agrees.
pub const API_VERSION: u8 = 2;

/// Additive capability flags advertised on every result. The integer
/// `api_version` remains the hard data contract; these flags let integrators
/// tolerate additive changes (new entry points / fields) instead of hard-failing
/// on every version bump. See `docs/wasm-api.md` for the documented meaning.
pub const CAPABILITIES: &[&str] = &[
    "collision_voxel_boundary",
    "collision_voxel_volume",
    "sdf_marching_cubes",
    "sdf_mc_floor_project",
    "progress_protocol_v1",
    "glb_export",
    "room_floor_mesh",
    "sog_export",
    "streamed_sog",
    "fast_nav",
    "fast_nav_preset",
    "output_space",
    "recast_config",
    "progress_callback",
    "splat_ingest",
];

/// Semantic version of the WASM core build. Tracks `Cargo.toml`'s `version` so a
/// tagged release and the binary always agree.
pub fn core_semver() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Capability flags as owned strings, ready to serialize into a result.
pub fn capabilities() -> Vec<String> {
    CAPABILITIES.iter().map(|s| s.to_string()).collect()
}

/// JS-reachable semantic version of the core build. Lets an integrator do cheap
/// pre-flight feature detection (and fail fast on a stale binary) before doing
/// any parse/field work, instead of reading `semver` off an expensive result.
#[wasm_bindgen]
pub fn splatwalk_version() -> String {
    core_semver()
}

/// JS-reachable integer data-contract version (the same value carried on every
/// result's `api_version`).
#[wasm_bindgen]
pub fn splatwalk_api_version() -> u8 {
    API_VERSION
}

/// JS-reachable capability flags advertised by this build, as a string array.
#[wasm_bindgen]
pub fn splatwalk_capabilities() -> Result<JsValue, JsValue> {
    Ok(serde_wasm_bindgen::to_value(&capabilities())?)
}

thread_local! {
    static PROGRESS_CALLBACK: RefCell<Option<js_sys::Function>> = RefCell::new(None);
}

/// Register (or, with `None`/`undefined`, clear) an opt-in JS progress callback.
/// It is invoked as `callback(stage: string, fraction: number | undefined)` at
/// the same stage boundaries as the `@progress` line protocol. The line protocol
/// is still emitted as a fallback, so `progress_protocol_v1` consumers keep
/// working and integrators no longer need to monkey-patch the global console.
#[wasm_bindgen]
pub fn set_progress_callback(callback: Option<js_sys::Function>) {
    PROGRESS_CALLBACK.with(|cb| {
        *cb.borrow_mut() = callback;
    });
}

/// Emit a progress event to the registered JS callback (if any) AND to the
/// `@progress <stage> [<fraction>]` console line protocol (the documented
/// `progress_protocol_v1` fallback). `fraction` is an optional 0..1 completion
/// ratio for the stage.
pub(crate) fn emit_progress(stage: &str, fraction: Option<f64>) {
    PROGRESS_CALLBACK.with(|cb| {
        if let Some(func) = cb.borrow().as_ref() {
            let stage_val = JsValue::from_str(stage);
            let frac_val = match fraction {
                Some(f) => JsValue::from_f64(f),
                None => JsValue::UNDEFINED,
            };
            let _ = func.call2(&JsValue::NULL, &stage_val, &frac_val);
        }
    });
    match fraction {
        Some(f) => log(&format!("@progress {} {:.4}", stage, f)),
        None => log(&format!("@progress {}", stage)),
    }
}

/// Canonical FAST NAV floor-field preset, baked into the core so binary-only
/// integrators don't reverse-engineer the TypeScript constant. Mirrors
/// `FAST_NAV_PRESET` in `src/navigation/floor.ts` — keep the two in sync. It
/// intentionally omits per-scene fields (`rotation`, `flip_y`, `collision_seed`,
/// `region_*`, `output_space`) so callers supply those for their own splat.
fn fast_nav_preset_json() -> serde_json::Value {
    serde_json::json!({
        "mode": 2,
        "voxel_target": 9000,
        "min_alpha": 0.08,
        "max_scale": 3.5,
        "sdf_cell_size": 0.14,
        "sdf_vertical_cell_size": 0.05,
        "sdf_density_threshold": 0.06,
        "sdf_max_layers": 2,
        "sdf_smoothing_radius": 2,
        "sdf_influence_radius_scale": 2.6,
        "prune_floaters": true,
        "prune_floaters_k": 16,
        "prune_floaters_std_ratio": 2.0,
        "normal_align": 0.3,
        "ransac_thresh": 0.16,
        "floor_projection_epsilon": 0.2,
        "height_projection_epsilon": 0.16,
        "obstacle_height_epsilon": 0.34,
        "obstacle_clearance_min": 0.18,
        "obstacle_clearance_max": 1.7,
        "max_local_height_variance": 0.14,
        "min_floor_confidence": 0.005,
        "hole_fill_radius": 2,
        "agent_radius_erode": 0,
        "component_mode": "all",
        "collision_carve_height": 1.7,
        "collision_carve_radius": 0.35
    })
}

/// Export the canonical FAST NAV floor-field preset as a settings object so a
/// binary-only integrator can pass it straight to `build_walkable_ground_field`
/// / `build_room_floor_mesh` (merged with their own per-scene `rotation`,
/// `flip_y`, `collision_seed`, and optional `region_*`) instead of copying a
/// TypeScript-only constant. `build_room_floor_mesh` already applies this preset
/// as its base layer automatically.
#[wasm_bindgen]
pub fn fast_nav_preset() -> Result<JsValue, JsValue> {
    Ok(serde_wasm_bindgen::to_value(&fast_nav_preset_json())?)
}

/// Agent / cell-size inputs (all in metres) for `recast_config`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RecastConfigInput {
    cs: Option<f64>,
    ch: Option<f64>,
    walkable_height: Option<f64>,
    walkable_climb: Option<f64>,
    walkable_radius: Option<f64>,
    walkable_slope_angle: Option<f64>,
    /// Optional highest floor-cell Y (metres) so the helper can suggest a padded
    /// `bmax.y` that keeps the open-sky floor sheet above Recast's low-height cull.
    max_floor_y: Option<f64>,
}

/// Reference FAST NAV agent defaults (metres) used by the browser path. Exposed
/// so binary-only integrators don't transcribe them from the docs.
#[wasm_bindgen]
pub fn recast_agent_defaults() -> Result<JsValue, JsValue> {
    let defaults = serde_json::json!({
        // cs is the FALLBACK; prefer auto-sizing it from the mesh extent + agent
        // radius (Recast guideline cs in [radius/3, radius/2]) bounded by a total
        // cell budget, so large scenes are covered completely. For radius 0.5 the
        // window is [0.167, 0.25]; 0.2 is a sane mid-range default.
        "cs": 0.2,
        "ch": 0.1,
        "walkableHeight": 1.7,
        // 0.5 m agent cylinder (gaming standard). walkableClimb is 0.5 m to match
        // the floor field's same-level band so Recast does not re-sever a continuous
        // floor at a capture-noise crease.
        "walkableRadius": 0.5,
        "walkableClimb": 0.5,
        "walkableSlopeAngle": 40
    });
    Ok(serde_wasm_bindgen::to_value(&defaults)?)
}

/// Convert metre-valued agent dimensions into Recast's integer voxel counts
/// (`walkableHeight = ceil(h/ch)`, `walkableClimb = floor(climb/ch)`,
/// `walkableRadius = ceil(r/cs)`) and suggest vertical-bounds padding. Skipping
/// this conversion silently truncates sub-metre climb/radius to `0` voxels,
/// which removes erosion and fragments one walkable level into disjoint islands.
/// Inputs (metres) default to the FAST NAV reference values when omitted.
#[wasm_bindgen]
pub fn recast_config(settings: JsValue) -> Result<JsValue, JsValue> {
    let input: RecastConfigInput = if settings.is_undefined() || settings.is_null() {
        RecastConfigInput::default()
    } else {
        serde_wasm_bindgen::from_value(settings).map_err(|e| JsValue::from_str(&e.to_string()))?
    };

    let cs = input.cs.unwrap_or(0.12);
    let ch = input.ch.unwrap_or(0.1);
    let walkable_height_m = input.walkable_height.unwrap_or(1.7);
    let walkable_climb_m = input.walkable_climb.unwrap_or(0.5);
    let walkable_radius_m = input.walkable_radius.unwrap_or(0.5);
    let walkable_slope_angle = input.walkable_slope_angle.unwrap_or(40.0);

    let walkable_height = ((walkable_height_m / ch).ceil() as i64).max(1);
    let walkable_climb = ((walkable_climb_m / ch).floor() as i64).max(0);
    let walkable_radius = ((walkable_radius_m / cs).ceil() as i64).max(0);
    let bmax_y_padding = walkable_height_m + 0.5;

    let out = serde_json::json!({
        "cs": cs,
        "ch": ch,
        "walkableHeight": walkable_height,
        "walkableClimb": walkable_climb,
        "walkableRadius": walkable_radius,
        "walkableSlopeAngle": walkable_slope_angle,
        "bmaxYPadding": bmax_y_padding,
        "suggestedBmaxY": input.max_floor_y.map(|y| y + bmax_y_padding)
    });
    Ok(serde_wasm_bindgen::to_value(&out)?)
}

#[derive(Clone, Deserialize)]
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
    /// Truncation half-width (voxels) for the 3D SDF used by `collision_mesh_mode: "smooth"`.
    /// Default `3`. Clamped to `[1, 16]`.
    pub sdf_band_voxels: Option<f64>,
    /// Isosurface level for Marching Cubes when `collision_mesh_mode: "smooth"` (default `0`).
    pub mc_iso_level: Option<f64>,
    /// Laplacian smooth iterations after Marching Cubes (default `1`, clamped to `[0, 8]`).
    pub mc_smooth_iterations: Option<usize>,
    /// Metres of undulation to flatten on the SDF-MC → Recast floor heightfield only
    /// (never the MC shell). Default `0.08`; `0` disables. Clamped to `[0, 0.5]`.
    pub floor_project_flatten_m: Option<f64>,
    collision_filter_cluster: Option<bool>,
    /// Cap dense collision grid voxels (default 1_500_000). Lower under memory pressure.
    pub collision_max_voxels: Option<usize>,
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
    /// Optional AABB minimum corner `[x,y,z]` in `splatwalk_oriented` space
    /// (post-`flip_y`, post-`rotation`, in the same metres as `environment_scale`).
    /// When both `region_min` and `region_max` are set, WASM culls splats outside
    /// the box **before floater prune** and again in `build_context`, so
    /// `fast_nav` / collision / floor work only the consideration volume.
    pub region_min: Option<Vec<f64>>,
    /// Optional AABB maximum corner `[x,y,z]` paired with {@link region_min}.
    pub region_max: Option<Vec<f64>>,
    /// Optional camera / viewpoint `[x,y,z]` in `splatwalk_oriented` space.
    /// Used when a pinned region culls every splat and the cloud is immense:
    /// WASM builds a reasonable AABB around this point instead of loading all
    /// splats. Falls back to `collision_seed`, then the cloud AABB center.
    pub camera_position: Option<Vec<f64>>,
    /// Statistical outlier removal ("prune floaters"). When true (the default),
    /// stray sparse splats far from the dense surface are removed before any
    /// geometry/region/seed computation. See `splat::prune_floaters`.
    pub prune_floaters: Option<bool>,
    /// Neighbours sampled per splat for outlier removal (default 16). Higher =
    /// smoother/more conservative estimate.
    pub prune_floaters_k: Option<usize>,
    /// Removal aggressiveness: keep splats whose mean neighbour distance is within
    /// `mean + std_ratio * stddev` (default 2.0). Lower = more aggressive.
    pub prune_floaters_std_ratio: Option<f64>,
    pub rotation: Option<Vec<f64>>,
    /// Opt-in output coordinate convention. When set, every mesh/basis/floor-plane
    /// result is converted from the default `splatwalk_oriented` space (right-handed,
    /// +Y up, CCW winding) into the requested `up_axis`/`handedness`/`winding` and the
    /// reported `space` metadata is updated. Absent (the default) leaves all outputs
    /// in `splatwalk_oriented` space, byte-for-byte unchanged. Per-cell ground-field
    /// scalars and `diagnostics` stay in `splatwalk_oriented` space.
    pub output_space: Option<OutputSpaceSettings>,
    /// When true, negate the Y axis of every parsed splat (position and normal) so that
    /// WASM operates in the same world space the renderer displays. Gaussian-splat loaders
    /// (e.g. Babylon) flip Y on import; passing that flip here keeps the navmesh, basis,
    /// spawn points and agents co-located with the rendered splat and makes the +Y-up
    /// floor/clearance heuristics valid.
    pub flip_y: Option<bool>,
    /// Uniform world scale applied to oriented splat positions and per-splat gaussian
    /// scales inside `build_context` (default 1). Matches the renderer's environment
    /// scale so collision / floor / navmesh bake in the same meters as the visible splat.
    /// Region bounds and collision seeds are expected in this scaled world space already
    /// (do not pre-scale them again here).
    pub environment_scale: Option<f64>,
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
        Self {
            vertices,
            indices,
            vertex_count,
            face_count,
        }
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
    /// SDF truncation band (voxels) used for `smooth` mesh mode; `0` when unused.
    pub collision_sdf_band_voxels: f64,
    /// Marching Cubes iso level used for `smooth` mesh mode.
    pub collision_mc_iso_level: f64,
    /// Laplacian iterations applied after Marching Cubes for `smooth` mesh mode.
    pub collision_mc_smooth_iterations: usize,
    /// `"interior"` | `"open"` | `""` — downward floor project mode for SDF-MC Recast mesh.
    pub collision_floor_project_mode: String,
    /// Applied `floor_project_flatten_m` for SDF-MC Recast floor (0 when unused).
    pub collision_floor_project_flatten_m: f64,
    pub floor_plane: Option<FloorPlane>,
}

impl ReconstructionDiagnostics {
    pub fn empty(points_total: usize) -> Self {
        Self {
            api_version: API_VERSION,
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
            collision_sdf_band_voxels: 0.0,
            collision_mc_iso_level: 0.0,
            collision_mc_smooth_iterations: 0,
            collision_floor_project_mode: String::new(),
            collision_floor_project_flatten_m: 0.0,
            floor_plane: None,
        }
    }
}

#[derive(Serialize)]
pub struct ReconstructionResult {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub mesh: MeshBuffers,
    pub space: CoordinateSpace,
    pub diagnostics: ReconstructionDiagnostics,
}

#[derive(Serialize)]
pub struct SplatBounds {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub point_count: usize,
    pub oriented_min: [f64; 3],
    pub oriented_max: [f64; 3],
    pub floor_y_percentile_02: f64,
    pub space: CoordinateSpace,
}

#[derive(Serialize)]
pub struct SuggestedRegion {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
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
    pub semver: String,
    pub capabilities: Vec<String>,
    pub mesh: MeshBuffers,
    pub space: CoordinateSpace,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub diagnostics: ReconstructionDiagnostics,
}

/// Packed dense voxel volume for runtime walk (solid + carved nav).
/// Bitmasks are LSB-first, length `ceil(n/8)`, index order matching `grid.idx(x,y,z)`.
#[derive(Serialize)]
pub struct CollisionVoxelVolume {
    pub origin: [f64; 3],
    pub dims: [u32; 3],
    pub voxel_size: f64,
    pub solid: serde_bytes::ByteBuf,
    pub nav_region: serde_bytes::ByteBuf,
}

#[derive(Serialize)]
pub struct CollisionVoxelBoundaryResult {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub mesh: MeshBuffers,
    /// Full SDF-MC shell for overlay when `collision_mesh_mode: "smooth"`; Recast uses `mesh`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collider_mesh: Option<MeshBuffers>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glb: Option<serde_bytes::ByteBuf>,
    /// Present when `emit_volume` was set — dense solid + nav_region for voxel walk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<CollisionVoxelVolume>,
    pub space: CoordinateSpace,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub diagnostics: ReconstructionDiagnostics,
}

#[derive(Serialize)]
pub struct WalkableGroundFieldResult {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub cells: Vec<GroundFieldCell>,
    pub width: usize,
    pub height: usize,
    pub cell_size: f64,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub space: CoordinateSpace,
    pub diagnostics: ReconstructionDiagnostics,
}

#[derive(Serialize)]
pub struct RoomFloorMeshResult {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub mesh: MeshBuffers,
    /// GLB bytes of the floor mesh, present only when `emit_glb` was set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glb: Option<serde_bytes::ByteBuf>,
    pub space: CoordinateSpace,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub selected_area: f64,
    pub component_count: usize,
    pub selected_cell_count: usize,
    pub accepted_cell_count: usize,
    pub obstacle_cell_count: usize,
    pub rejected_cell_count: usize,
    pub fallback_used: bool,
    pub step_label: String,
    pub diagnostics: ReconstructionDiagnostics,
}

/// One attempt in the WASM-side room-floor recovery ladder. `settings` is a raw
/// JSON object whose keys are merged over the base settings for this attempt.
#[derive(Clone, Deserialize, Default)]
struct RoomFloorStepCfg {
    label: Option<String>,
    settings: Option<serde_json::Value>,
    min_room_floor_area: Option<f64>,
}

/// Extra (non-`MeshSettings`) options accepted by `build_room_floor_mesh`.
#[derive(Deserialize, Default)]
struct RoomFloorOptions {
    min_room_floor_area: Option<f64>,
    emit_glb: Option<bool>,
    recovery: Option<Vec<RoomFloorStepCfg>>,
}

#[derive(Deserialize, Default)]
struct CollisionVoxelBoundaryOptions {
    emit_glb: Option<bool>,
    /// When true, result includes packed `solid` + `nav_region` bitmasks for runtime walk.
    emit_volume: Option<bool>,
}

/// Extra options accepted by the star {@link fast_nav} export (superset of room-floor
/// + collision flags). `algo` selects the compute path; MeshSettings fields ride on
/// the same JSON object.
#[derive(Deserialize, Default)]
struct FastNavOptions {
    algo: Option<String>,
    min_room_floor_area: Option<f64>,
    emit_glb: Option<bool>,
    emit_volume: Option<bool>,
    recovery: Option<Vec<RoomFloorStepCfg>>,
}

/// Unified success shape for {@link fast_nav}. Floor-only stats are zeroed for
/// collision algos; `volume` is present only when `emit_volume` was set on a
/// voxel / SDF-MC path.
#[derive(Serialize)]
pub struct FastNavResult {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub algo: String,
    pub mesh: MeshBuffers,
    /// Full SDF-MC shell for overlay when present; Recast uses `mesh` (projected floor).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collider_mesh: Option<MeshBuffers>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glb: Option<serde_bytes::ByteBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<CollisionVoxelVolume>,
    pub space: CoordinateSpace,
    pub basis: FieldBasis,
    pub floor_plane: FloorPlane,
    pub selected_area: f64,
    pub component_count: usize,
    pub selected_cell_count: usize,
    pub accepted_cell_count: usize,
    pub obstacle_cell_count: usize,
    pub rejected_cell_count: usize,
    pub fallback_used: bool,
    pub step_label: String,
    pub diagnostics: ReconstructionDiagnostics,
}

/// Structured failure thrown by {@link fast_nav}.
#[derive(Serialize)]
struct FastNavFailure {
    api_version: u8,
    algo: String,
    reason: String,
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attempted: Vec<String>,
    selected_area: f64,
    component_count: usize,
    steps: usize,
}

fn fast_nav_failure(
    algo: &str,
    reason: &str,
    message: impl Into<String>,
    attempted: Vec<String>,
    selected_area: f64,
    component_count: usize,
    steps: usize,
) -> JsValue {
    let failure = FastNavFailure {
        api_version: API_VERSION,
        algo: algo.to_string(),
        reason: reason.to_string(),
        message: message.into(),
        attempted,
        selected_area,
        component_count,
        steps,
    };
    serde_wasm_bindgen::to_value(&failure).unwrap_or_else(|_| JsValue::from_str(reason))
}

fn parse_fast_nav_algo(raw: Option<&str>) -> Result<&'static str, String> {
    match raw.unwrap_or("floor_field").trim() {
        "" | "floor_field" => Ok("floor_field"),
        "voxel_collision" => Ok("voxel_collision"),
        "sdf_marching_cubes" => Ok("sdf_marching_cubes"),
        other => Err(format!(
            "Invalid fast_nav algo \"{}\". Expected \"floor_field\", \"voxel_collision\", or \"sdf_marching_cubes\".",
            other
        )),
    }
}

/// Apply product `collision_mesh_mode` defaults for collision algos.
fn apply_fast_nav_collision_mesh_mode(algo: &str, merged: &mut serde_json::Map<String, serde_json::Value>) {
    match algo {
        "sdf_marching_cubes" => {
            merged.insert(
                "collision_mesh_mode".to_string(),
                serde_json::Value::String("smooth".to_string()),
            );
        }
        "voxel_collision" => {
            let mode = merged
                .get("collision_mesh_mode")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if mode.is_empty() || mode == "smooth" {
                merged.insert(
                    "collision_mesh_mode".to_string(),
                    serde_json::Value::String("faces".to_string()),
                );
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod fast_nav_algo_tests {
    use super::{
        apply_collision_recovery_step_for_algo, apply_fast_nav_collision_mesh_mode,
        is_recoverable_collision_failure, parse_fast_nav_algo, MeshSettings,
        ReconstructionDiagnostics,
    };
    use crate::mesh;

    #[test]
    fn default_and_aliases_are_floor_field() {
        assert_eq!(parse_fast_nav_algo(None).unwrap(), "floor_field");
        assert_eq!(parse_fast_nav_algo(Some("")).unwrap(), "floor_field");
        assert_eq!(parse_fast_nav_algo(Some("floor_field")).unwrap(), "floor_field");
    }

    #[test]
    fn accepts_collision_algos() {
        assert_eq!(
            parse_fast_nav_algo(Some("voxel_collision")).unwrap(),
            "voxel_collision"
        );
        assert_eq!(
            parse_fast_nav_algo(Some("sdf_marching_cubes")).unwrap(),
            "sdf_marching_cubes"
        );
    }

    #[test]
    fn rejects_unknown_algo() {
        assert!(parse_fast_nav_algo(Some("magic")).is_err());
    }

    #[test]
    fn sdf_algo_forces_smooth_mesh_mode() {
        let mut merged = serde_json::Map::new();
        merged.insert(
            "collision_mesh_mode".to_string(),
            serde_json::Value::String("faces".to_string()),
        );
        apply_fast_nav_collision_mesh_mode("sdf_marching_cubes", &mut merged);
        assert_eq!(
            merged.get("collision_mesh_mode").and_then(|v| v.as_str()),
            Some("smooth")
        );
    }

    #[test]
    fn voxel_algo_defaults_faces_and_keeps_walkable_floors() {
        let mut empty = serde_json::Map::new();
        apply_fast_nav_collision_mesh_mode("voxel_collision", &mut empty);
        assert_eq!(
            empty.get("collision_mesh_mode").and_then(|v| v.as_str()),
            Some("faces")
        );

        let mut floors = serde_json::Map::new();
        floors.insert(
            "collision_mesh_mode".to_string(),
            serde_json::Value::String("walkable_floors".to_string()),
        );
        apply_fast_nav_collision_mesh_mode("voxel_collision", &mut floors);
        assert_eq!(
            floors.get("collision_mesh_mode").and_then(|v| v.as_str()),
            Some("walkable_floors")
        );
    }

    #[test]
    fn seed_blocked_is_recoverable() {
        assert!(is_recoverable_collision_failure(
            Some("seed_not_reachable_or_capsule_blocked"),
            false
        ));
        assert!(is_recoverable_collision_failure(
            Some("no_filtered_points"),
            true
        ));
        assert!(!is_recoverable_collision_failure(
            Some("no_filtered_points"),
            false
        ));
        assert!(is_recoverable_collision_failure(Some("region_too_large"), false));
        assert!(is_recoverable_collision_failure(Some("region_too_large"), true));
    }

    #[test]
    fn drop_region_uses_camera_centered_box() {
        let mut settings: MeshSettings = serde_json::from_value(serde_json::json!({
            "mode": 2,
            "region_min": [0.0, 0.0, 0.0],
            "region_max": [1.0, 1.0, 1.0],
            "camera_position": [5.0, 1.5, -2.0],
        }))
        .unwrap();
        let diagnostics = ReconstructionDiagnostics::empty(0);
        apply_collision_recovery_step_for_algo(
            "drop region",
            &mut settings,
            &diagnostics,
            "voxel_collision",
        );
        let rmin = settings.region_min.as_ref().unwrap();
        let rmax = settings.region_max.as_ref().unwrap();
        assert!((rmin[0] - (5.0 - 12.0)).abs() < 1e-9);
        assert!((rmax[0] - (5.0 + 12.0)).abs() < 1e-9);
        assert!((rmin[1] - (1.5 - 5.0)).abs() < 1e-9);
        assert!((rmax[1] - (1.5 + 15.0)).abs() < 1e-9);
    }

    #[test]
    fn sdf_drop_region_clears_pin_for_full_aabb() {
        let mut settings: MeshSettings = serde_json::from_value(serde_json::json!({
            "mode": 2,
            "region_min": [0.0, 0.0, 0.0],
            "region_max": [1.0, 1.0, 1.0],
            "camera_position": [5.0, 1.5, -2.0],
        }))
        .unwrap();
        let diagnostics = ReconstructionDiagnostics::empty(0);
        apply_collision_recovery_step_for_algo(
            "drop region",
            &mut settings,
            &diagnostics,
            "sdf_marching_cubes",
        );
        assert!(settings.region_min.is_none());
        assert!(settings.region_max.is_none());
    }

    #[test]
    fn shrink_camera_region_is_tighter() {
        let mut settings: MeshSettings = serde_json::from_value(serde_json::json!({
            "mode": 2,
            "camera_position": [0.0, 1.0, 0.0],
        }))
        .unwrap();
        let diagnostics = ReconstructionDiagnostics::empty(0);
        apply_collision_recovery_step_for_algo(
            "shrink camera region",
            &mut settings,
            &diagnostics,
            "voxel_collision",
        );
        let rmin = settings.region_min.as_ref().unwrap();
        let rmax = settings.region_max.as_ref().unwrap();
        assert!((rmin[0] - (-8.0)).abs() < 1e-9);
        assert!((rmax[0] - 8.0).abs() < 1e-9);
    }

    #[test]
    fn clamp_seed_and_camera_into_region() {
        let mut settings: MeshSettings = serde_json::from_value(serde_json::json!({
            "mode": 2,
            "region_min": [0.0, 0.0, 0.0],
            "region_max": [2.0, 2.0, 2.0],
            "collision_seed": [5.0, 1.0, -3.0],
            "camera_position": [-1.0, 10.0, 1.0],
        }))
        .unwrap();
        mesh::clamp_seed_and_camera_to_region(&mut settings);
        let seed = settings.collision_seed.as_ref().unwrap();
        let cam = settings.camera_position.as_ref().unwrap();
        assert!((seed[0] - 2.0).abs() < 1e-9);
        assert!((seed[1] - 1.0).abs() < 1e-9);
        assert!((seed[2] - 0.0).abs() < 1e-9);
        assert!((cam[0] - 0.0).abs() < 1e-9);
        assert!((cam[1] - 2.0).abs() < 1e-9);
        assert!((cam[2] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn null_region_keys_are_treated_as_omitted() {
        use super::validate_region_json;
        assert!(validate_region_json(&serde_json::json!({
            "region_min": null,
            "region_max": null,
        }))
        .is_ok());
        assert!(validate_region_json(&serde_json::json!({})).is_ok());
    }
}

/// Built-in recovery ladder mirroring the TypeScript `DEFAULT_FAST_NAV_RECOVERY`.
fn default_room_floor_recovery() -> Vec<RoomFloorStepCfg> {
    use serde_json::json;
    vec![
        RoomFloorStepCfg {
            label: Some("default".to_string()),
            settings: Some(json!({})),
            min_room_floor_area: Some(4.0),
        },
        RoomFloorStepCfg {
            label: Some("relaxed".to_string()),
            settings: Some(json!({
                "sdf_density_threshold": 0.04,
                "max_local_height_variance": 0.2,
                "obstacle_height_epsilon": 0.42,
                "min_floor_confidence": 0.003,
                "hole_fill_radius": 3,
                "voxel_target": 12000
            })),
            min_room_floor_area: Some(4.0),
        },
        RoomFloorStepCfg {
            label: Some("coarse".to_string()),
            settings: Some(json!({
                "sdf_cell_size": 0.2,
                "sdf_density_threshold": 0.03,
                "max_local_height_variance": 0.28,
                "min_floor_confidence": 0.002,
                "voxel_target": 14000,
                "hole_fill_radius": 3
            })),
            min_room_floor_area: Some(2.5),
        },
        RoomFloorStepCfg {
            label: Some("coarse-last-resort".to_string()),
            settings: Some(json!({
                "sdf_cell_size": 0.26,
                "sdf_density_threshold": 0.022,
                "max_local_height_variance": 0.36,
                "min_floor_confidence": 0.0015,
                "voxel_target": 16000,
                "hole_fill_radius": 4
            })),
            min_room_floor_area: Some(1.5),
        },
    ]
}

fn parse_settings(settings: JsValue) -> Result<MeshSettings, JsValue> {
    serde_wasm_bindgen::from_value(settings).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn validate_collision_mesh_mode(settings: &MeshSettings) -> Result<(), JsValue> {
    match settings.collision_mesh_mode.as_deref().unwrap_or("walkable_floors") {
        "faces" | "obstacle_shell" | "walkable_floors" | "smooth" => Ok(()),
        other => Err(JsValue::from_str(&format!(
            "Invalid collision_mesh_mode: {}. Expected \"walkable_floors\", \"obstacle_shell\", \"faces\", or \"smooth\".",
            other
        ))),
    }
}

/// Identity of a parsed+pruned(+region-culled) point set, so repeated WASM calls
/// on the same bytes+settings within a session can reuse the result instead of
/// re-parsing the PLY and re-running the (expensive) floater prune every time.
/// Region / rotation / environment_scale are part of the key because early cull
/// depends on them.
#[derive(Clone, PartialEq)]
struct ParseKey {
    len: usize,
    hash: u64,
    prune: bool,
    k: usize,
    std_ratio_bits: u64,
    flip_y: bool,
    /// Fingerprint of region AABB + rotation + environment_scale (0 when none).
    region_orient_hash: u64,
}

struct ParseCacheEntry {
    key: ParseKey,
    points: Vec<splat::PointNormal>,
}

thread_local! {
    static PARSE_CACHE: RefCell<Option<ParseCacheEntry>> = RefCell::new(None);
}

/// Cheap content fingerprint: FNV-1a over the length plus a strided sample of the
/// bytes. Full hashing of tens of MB on every call would itself be costly; a
/// sampled hash is more than enough to detect "same file" within a session.
fn fingerprint(data: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET ^ (data.len() as u64);
    // ~4096 samples spread across the buffer.
    let stride = (data.len() / 4096).max(1);
    let mut i = 0;
    while i < data.len() {
        hash ^= data[i] as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
        i += stride;
    }
    hash
}

fn mix_f64(hash: &mut u64, value: f64) {
    const FNV_PRIME: u64 = 0x100000001b3;
    *hash ^= value.to_bits();
    *hash = hash.wrapping_mul(FNV_PRIME);
}

/// Fingerprint of the early-cull pose (region AABB + rotation + environment_scale).
fn region_orient_fingerprint(settings: &MeshSettings) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    let mut hash = FNV_OFFSET;
    match (&settings.region_min, &settings.region_max) {
        (Some(rmin), Some(rmax)) if rmin.len() == 3 && rmax.len() == 3 => {
            for v in rmin.iter().chain(rmax.iter()) {
                mix_f64(&mut hash, *v);
            }
        }
        _ => {}
    }
    if let Some(rot) = settings.rotation.as_ref() {
        for v in rot {
            mix_f64(&mut hash, *v);
        }
    }
    if let Some(scale) = settings.environment_scale {
        mix_f64(&mut hash, scale);
    }
    hash
}

/// Validate optional `region_min` / `region_max`: both omitted, or both length-3
/// with finite coords and min <= max per axis.
fn validate_region_settings(settings: &MeshSettings) -> Result<(), JsValue> {
    validate_region_pair(
        settings.region_min.as_deref(),
        settings.region_max.as_deref(),
    )
}

fn validate_region_json(value: &serde_json::Value) -> Result<(), JsValue> {
    // Treat JSON null the same as omitted (hosts often send region_min: null / undefined).
    let region_min_value = value.get("region_min").filter(|v| !v.is_null());
    let region_max_value = value.get("region_max").filter(|v| !v.is_null());

    let rmin = region_min_value.and_then(|v| {
        v.as_array().map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_f64())
                .collect::<Vec<f64>>()
        })
    });
    let rmax = region_max_value.and_then(|v| {
        v.as_array().map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_f64())
                .collect::<Vec<f64>>()
        })
    });
    // If the key is present (and non-null) but not a numeric array, reject.
    if region_min_value.is_some() && rmin.is_none() {
        return Err(JsValue::from_str(
            "region_min must be a length-3 [x,y,z] number array.",
        ));
    }
    if region_max_value.is_some() && rmax.is_none() {
        return Err(JsValue::from_str(
            "region_max must be a length-3 [x,y,z] number array.",
        ));
    }
    validate_region_pair(rmin.as_deref(), rmax.as_deref())
}

fn validate_region_pair(rmin: Option<&[f64]>, rmax: Option<&[f64]>) -> Result<(), JsValue> {
    match (rmin, rmax) {
        (None, None) => Ok(()),
        (Some(_), None) | (None, Some(_)) => Err(JsValue::from_str(
            "region_min and region_max must both be set (or both omitted). Expected [x,y,z] each.",
        )),
        (Some(rmin), Some(rmax)) => {
            if rmin.len() != 3 || rmax.len() != 3 {
                return Err(JsValue::from_str(
                    "region_min and region_max must each be length-3 [x,y,z] arrays.",
                ));
            }
            for i in 0..3 {
                if !rmin[i].is_finite() || !rmax[i].is_finite() {
                    return Err(JsValue::from_str(
                        "region_min / region_max must contain finite numbers.",
                    ));
                }
                if rmin[i] > rmax[i] {
                    return Err(JsValue::from_str(
                        "region_min must be <= region_max on every axis.",
                    ));
                }
            }
            Ok(())
        }
    }
}

fn parse_splats(data: &[u8], settings: &MeshSettings) -> Result<Vec<splat::PointNormal>, JsValue> {
    validate_region_settings(settings)?;

    let prune = settings.prune_floaters.unwrap_or(true);
    let k = settings.prune_floaters_k.unwrap_or(16);
    let std_ratio = settings.prune_floaters_std_ratio.unwrap_or(2.0);
    let flip_y = settings.flip_y.unwrap_or(false);
    let has_region = settings.region_min.is_some() && settings.region_max.is_some();

    let key = ParseKey {
        len: data.len(),
        hash: fingerprint(data),
        prune,
        k,
        std_ratio_bits: std_ratio.to_bits(),
        flip_y,
        region_orient_hash: region_orient_fingerprint(settings),
    };

    // Cache hit: reuse the previously parsed(+region-culled)+pruned points.
    if let Some(points) = PARSE_CACHE.with(|cache| {
        cache
            .borrow()
            .as_ref()
            .filter(|entry| entry.key == key)
            .map(|entry| entry.points.clone())
    }) {
        log(&format!("Reusing cached splats ({} points)", points.len()));
        return Ok(points);
    }

    emit_progress("parse", Some(0.0));
    let mut splats = splat::parse_ply(data).map_err(|e| JsValue::from_str(&e))?;

    if flip_y {
        for p in &mut splats {
            p.point.y = -p.point.y;
            p.normal.y = -p.normal.y;
        }
        log(&format!(
            "Parsed {} splats (Y-flipped to render space)",
            splats.len()
        ));
    } else {
        log(&format!("Parsed {} splats", splats.len()));
    }

    // Pin consideration volume before prune so floater removal + every algo
    // (floor_field / voxel_collision / sdf_marching_cubes) never pays for
    // out-of-box splats. Region is in splatwalk_oriented space.
    if has_region {
        emit_progress("region_cull", Some(0.0));
        let before = splats.len();
        let (kept, discarded) = mesh::cull_points_outside_region(&splats, settings);
        if kept.is_empty() && discarded > 0 {
            if before > mesh::EMPTY_REGION_FULL_CLOUD_MAX_SPLATS {
                // Immense cloud: never prune/bake the full set — camera box instead.
                let center = settings
                    .camera_position
                    .as_ref()
                    .filter(|c| c.len() == 3 && c.iter().all(|v| v.is_finite()))
                    .map(|c| [c[0], c[1], c[2]])
                    .or_else(|| {
                        settings
                            .collision_seed
                            .as_ref()
                            .filter(|s| s.len() == 3 && s.iter().all(|v| v.is_finite()))
                            .map(|s| [s[0], s[1], s[2]])
                    })
                    .unwrap_or([0.0, 1.0, 0.0]);
                let (rmin, rmax) = mesh::camera_centered_fallback_region(center);
                let mut cam_settings = settings.clone();
                cam_settings.region_min = Some(rmin);
                cam_settings.region_max = Some(rmax);
                let (cam_kept, cam_discarded) =
                    mesh::cull_points_outside_region(&splats, &cam_settings);
                log(&format!(
                    "region empty + immense ({} splats) — camera-centered cull kept {} (discarded {})",
                    before,
                    cam_kept.len(),
                    cam_discarded
                ));
                splats = cam_kept;
            } else {
                log(&format!(
                    "region_min/region_max discarded every splat ({} total) — defaulting to all splats",
                    before
                ));
            }
        } else {
            splats = kept;
            log(&format!(
                "Region cull (pre-prune): discarded {} / {} splats outside region_min/max (kept {})",
                discarded,
                before,
                splats.len()
            ));
        }
        emit_progress("region_cull", Some(1.0));
    }

    // Prune stray floater splats at the single ingest chokepoint so every
    // downstream op (bounds, region suggestion, seed, floor field, mesh) operates
    // on the cleaned set. Defaults on; integrators can disable or tune it.
    // When a region is pinned, prune runs on the culled subset only.
    if prune {
        let result = splat::prune_floaters(splats, k, std_ratio, 0.4);
        match result.skipped_reason {
            Some(reason) => log(&format!(
                "Floater prune skipped ({}); kept all {} splats",
                reason, result.input_count
            )),
            None => log(&format!(
                "Pruned {} floater splats (k={}, std_ratio={:.2}): {} -> {}",
                result.removed_count,
                k,
                std_ratio,
                result.input_count,
                result.input_count - result.removed_count
            )),
        }
        splats = result.points;
    }

    PARSE_CACHE.with(|cache| {
        *cache.borrow_mut() = Some(ParseCacheEntry {
            key,
            points: splats.clone(),
        });
    });

    Ok(splats)
}

#[wasm_bindgen]
pub fn get_splat_bounds(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::get_splat_bounds(&splats, &settings)?;
    output_space::apply_bounds(&settings, &mut result);
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn suggest_region(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::suggest_region(&splats, &settings)?;
    output_space::apply_region(&settings, &mut result);
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn convert_splat_to_mesh(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let mode = settings.mode;
    if mode == 2 {
        validate_collision_mesh_mode(&settings)?;
    }

    log(&format!("Received {} bytes (Mode: {})", data.len(), mode));

    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::reconstruct_mesh(&splats, &settings);
    log(&format!(
        "Reconstructed mesh with {} vertices",
        result.mesh.vertex_count
    ));
    output_space::apply_reconstruction(&settings, &mut result);

    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn convert_splat_to_navmesh_basis(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    validate_collision_mesh_mode(&settings)?;
    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::convert_splat_to_navmesh_basis(&splats, &settings);
    output_space::apply_navmesh_basis(&settings, &mut result);
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn build_collision_voxel_boundary(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let options: CollisionVoxelBoundaryOptions =
        serde_wasm_bindgen::from_value(settings.clone()).unwrap_or_default();
    let mut settings = parse_settings(settings)?;
    mesh::clamp_seed_and_camera_to_region(&mut settings);
    validate_collision_mesh_mode(&settings)?;
    let splats = parse_splats(data, &settings)?;
    let emit_volume = options.emit_volume.unwrap_or(false);
    let mut result = mesh::build_collision_voxel_boundary(&splats, &settings, emit_volume);
    output_space::apply_collision_voxel_boundary(&settings, &mut result);
    if options.emit_glb.unwrap_or(false) {
        result.glb = soft_emit_glb(&result.mesh.vertices, &result.mesh.indices);
    }
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

#[wasm_bindgen]
pub fn build_walkable_ground_field(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_settings(settings)?;
    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::build_walkable_ground_field(&splats, &settings)?;
    output_space::apply_ground_field(&settings, &mut result);
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

/// Shared room-floor extraction used by {@link build_room_floor_mesh} and
/// {@link fast_nav} (`algo: "floor_field"`). Preset < caller settings < recovery
/// step patch.
fn run_room_floor_pipeline(
    data: &[u8],
    base_value: &serde_json::Value,
    emit_glb: bool,
    base_min_area: f64,
    steps: &[RoomFloorStepCfg],
) -> Result<RoomFloorMeshResult, RoomFloorFailure> {
    let preset_obj = fast_nav_preset_json()
        .as_object()
        .cloned()
        .unwrap_or_default();
    let base_obj = base_value.as_object().cloned().unwrap_or_default();
    let mut last_err: Option<mesh::RoomFloorError> = None;
    let mut attempted: Vec<String> = Vec::new();

    for (i, step) in steps.iter().enumerate() {
        let label = step.label.clone().unwrap_or_else(|| format!("step{}", i));
        let min_area = step.min_room_floor_area.unwrap_or(base_min_area);

        let mut merged = preset_obj.clone();
        for (k, v) in &base_obj {
            // Skip fast_nav-only keys that are not MeshSettings fields.
            if matches!(
                k.as_str(),
                "algo" | "recovery" | "emit_glb" | "emit_volume" | "min_room_floor_area"
            ) {
                continue;
            }
            merged.insert(k.clone(), v.clone());
        }
        if let Some(serde_json::Value::Object(patch)) = &step.settings {
            for (k, v) in patch {
                merged.insert(k.clone(), v.clone());
            }
        }
        let settings: MeshSettings = match serde_json::from_value(serde_json::Value::Object(merged))
        {
            Ok(s) => s,
            Err(e) => {
                return Err(RoomFloorFailure {
                    api_version: API_VERSION,
                    reason: "invalid_settings".to_string(),
                    message: format!("Invalid room-floor settings: {}", e),
                    attempted,
                    selected_area: 0.0,
                    component_count: 0,
                    steps: steps.len(),
                });
            }
        };

        let splats = match parse_splats(data, &settings) {
            Ok(s) => s,
            Err(e) => {
                let message = e
                    .as_string()
                    .unwrap_or_else(|| "Failed to parse splats".to_string());
                return Err(RoomFloorFailure {
                    api_version: API_VERSION,
                    reason: "parse_error".to_string(),
                    message,
                    attempted,
                    selected_area: 0.0,
                    component_count: 0,
                    steps: steps.len(),
                });
            }
        };
        match mesh::extract_room_floor(&splats, &settings, min_area, &label) {
            Ok(build) => {
                let mut mesh = MeshBuffers::new(build.positions, build.indices);
                let mut basis = build.basis;
                let mut floor_plane = build.floor_plane;
                let mut space = CoordinateSpace::splatwalk_oriented();
                if let Some(transform) = output_space::transform_for(&settings) {
                    output_space::apply_mesh_buffers(&transform, &mut mesh);
                    output_space::apply_basis(&transform, &mut basis);
                    output_space::apply_floor_plane(&transform, &mut floor_plane);
                    space = transform.coordinate_space();
                }
                let glb = if emit_glb {
                    soft_emit_glb(&mesh.vertices, &mesh.indices)
                } else {
                    None
                };
                return Ok(RoomFloorMeshResult {
                    api_version: API_VERSION,
                    semver: core_semver(),
                    capabilities: capabilities(),
                    mesh,
                    glb,
                    space,
                    basis,
                    floor_plane,
                    selected_area: build.selected_area,
                    component_count: build.component_count,
                    selected_cell_count: build.selected_cell_count,
                    accepted_cell_count: build.accepted_cell_count,
                    obstacle_cell_count: build.obstacle_cell_count,
                    rejected_cell_count: build.rejected_cell_count,
                    fallback_used: build.fallback_used,
                    step_label: build.step_label,
                    diagnostics: build.diagnostics,
                });
            }
            Err(e) => {
                attempted.push(format!("{}({})", label, e.reason));
                last_err = Some(e);
            }
        }
    }

    let summary = attempted.join(" -> ");
    Err(match last_err {
        Some(e) => RoomFloorFailure {
            api_version: API_VERSION,
            reason: e.reason,
            message: format!(
                "FAST NAV floor extraction failed after {} step(s): {}. {}",
                steps.len(),
                summary,
                e.message
            ),
            attempted,
            selected_area: e.area,
            component_count: e.components,
            steps: steps.len(),
        },
        None => RoomFloorFailure {
            api_version: API_VERSION,
            reason: "no_steps".to_string(),
            message: "FAST NAV recovery had no configured steps.".to_string(),
            attempted,
            selected_area: 0.0,
            component_count: 0,
            steps: 0,
        },
    })
}

/// Extract a triangulated room-floor mesh entirely in WASM: the binary-side
/// equivalent of the TypeScript FAST NAV floor path. Prefer {@link fast_nav}
/// with `algo: "floor_field"` for the product FastNav surface; this export
/// remains for specialized / legacy callers.
#[wasm_bindgen]
pub fn build_room_floor_mesh(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let base_value: serde_json::Value = serde_wasm_bindgen::from_value(settings.clone())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let options: RoomFloorOptions = serde_wasm_bindgen::from_value(settings).unwrap_or_default();

    let emit_glb = options.emit_glb.unwrap_or(false);
    let base_min_area = options.min_room_floor_area.unwrap_or(4.0);
    let steps = match options.recovery {
        Some(ref steps) if !steps.is_empty() => steps.clone(),
        _ => default_room_floor_recovery(),
    };

    match run_room_floor_pipeline(data, &base_value, emit_glb, base_min_area, &steps) {
        Ok(result) => Ok(serde_wasm_bindgen::to_value(&result)?),
        Err(failure) => Err(serde_wasm_bindgen::to_value(&failure)?),
    }
}

fn room_floor_to_fast_nav(algo: &str, room: RoomFloorMeshResult) -> FastNavResult {
    FastNavResult {
        api_version: room.api_version,
        semver: room.semver,
        capabilities: room.capabilities,
        algo: algo.to_string(),
        mesh: room.mesh,
        collider_mesh: None,
        glb: room.glb,
        volume: None,
        space: room.space,
        basis: room.basis,
        floor_plane: room.floor_plane,
        selected_area: room.selected_area,
        component_count: room.component_count,
        selected_cell_count: room.selected_cell_count,
        accepted_cell_count: room.accepted_cell_count,
        obstacle_cell_count: room.obstacle_cell_count,
        rejected_cell_count: room.rejected_cell_count,
        fallback_used: room.fallback_used,
        step_label: room.step_label,
        diagnostics: room.diagnostics,
    }
}

fn json_has_pinned_region(value: &serde_json::Value) -> bool {
    matches!(
        (value.get("region_min"), value.get("region_max")),
        (Some(serde_json::Value::Array(a)), Some(serde_json::Value::Array(b)))
            if a.len() == 3 && b.len() == 3
    )
}

fn json_without_region(value: &serde_json::Value) -> serde_json::Value {
    let mut out = value.clone();
    if let Some(obj) = out.as_object_mut() {
        obj.remove("region_min");
        obj.remove("region_max");
    }
    out
}

fn settings_has_pinned_region(settings: &MeshSettings) -> bool {
    matches!(
        (&settings.region_min, &settings.region_max),
        (Some(a), Some(b)) if a.len() == 3 && b.len() == 3
    )
}

fn collision_mesh_is_empty(result: &CollisionVoxelBoundaryResult) -> bool {
    result.mesh.vertex_count == 0 || result.mesh.face_count == 0
}

fn sdf_mc_shell_missing(result: &CollisionVoxelBoundaryResult) -> bool {
    match &result.collider_mesh {
        Some(m) => m.face_count == 0 || m.vertex_count == 0,
        None => true,
    }
}

/// Recast floor empty, or SDF-MC missing the interior MC shell (floor can still be non-empty
/// via walkable_floors fallback — that must not count as success).
fn collision_build_needs_recovery(algo: &str, result: &CollisionVoxelBoundaryResult) -> bool {
    if collision_mesh_is_empty(result) {
        return true;
    }
    algo == "sdf_marching_cubes" && sdf_mc_shell_missing(result)
}

fn is_recoverable_collision_failure(reason: Option<&str>, had_region: bool) -> bool {
    match reason {
        Some("region_too_large")
        | Some("seed_not_reachable_or_capsule_blocked")
        | Some("no_occupied_voxels")
        | Some("filter_cluster_removed_all")
        | Some("sdf_mc_empty_mesh") => true,
        Some("no_filtered_points") if had_region => true,
        None if had_region => true,
        _ => false,
    }
}

fn pin_camera_centered_region(
    settings: &mut MeshSettings,
    diagnostics: Option<&ReconstructionDiagnostics>,
    half_xz_m: f64,
) {
    let center = mesh::camera_region_viewpoint(settings, diagnostics, [0.0, 1.0, 0.0]);
    let (rmin, rmax) = mesh::camera_centered_fallback_region_extent(center, half_xz_m);
    settings.region_min = Some(rmin);
    settings.region_max = Some(rmax);
    settings.collision_seed = Some(vec![center[0], center[1], center[2]]);
    if settings.camera_position.is_none() {
        settings.camera_position = Some(vec![center[0], center[1], center[2]]);
    }
    mesh::clamp_seed_and_camera_to_region(settings);
}

fn compute_collision_reseed(
    settings: &MeshSettings,
    diagnostics: &ReconstructionDiagnostics,
) -> Vec<f64> {
    let carve_height = settings.collision_carve_height.unwrap_or(1.6);
    let (min, max) = match (
        settings.region_min.as_deref(),
        settings.region_max.as_deref(),
    ) {
        (Some(rmin), Some(rmax)) if rmin.len() == 3 && rmax.len() == 3 => {
            ([rmin[0], rmin[1], rmin[2]], [rmax[0], rmax[1], rmax[2]])
        }
        _ => (
            diagnostics.oriented_min.unwrap_or([0.0, 0.0, 0.0]),
            diagnostics.oriented_max.unwrap_or([0.0, 2.0, 0.0]),
        ),
    };
    let floor_y = diagnostics
        .floor_y_percentile_02
        .unwrap_or(min[1]);
    vec![
        (min[0] + max[0]) * 0.5,
        floor_y + carve_height * 0.5,
        (min[2] + max[2]) * 0.5,
    ]
}

fn clear_pinned_region(settings: &mut MeshSettings) {
    settings.region_min = None;
    settings.region_max = None;
}

/// Algo-aware recovery patches. SDF-MC `drop region` / empty-region unclip clear the pin so
/// indoor shells can rebuild on the full splat AABB; voxel collision keeps a camera box.
fn apply_collision_recovery_step_for_algo(
    label: &str,
    settings: &mut MeshSettings,
    diagnostics: &ReconstructionDiagnostics,
    algo: &str,
) -> bool {
    let applied = match label {
        "empty_region_unclip" | "drop region" => {
            if algo == "sdf_marching_cubes" {
                clear_pinned_region(settings);
                true
            } else {
                // Voxel: pin a camera box — never expand to the full city AABB.
                pin_camera_centered_region(settings, Some(diagnostics), 12.0);
                true
            }
        }
        "camera region" => {
            pin_camera_centered_region(settings, Some(diagnostics), 12.0);
            true
        }
        "shrink camera region" => {
            pin_camera_centered_region(settings, Some(diagnostics), 8.0);
            settings.collision_voxel_size = Some(
                settings
                    .collision_voxel_size
                    .unwrap_or(0.05)
                    .max(0.08),
            );
            true
        }
        "coarser voxels" => {
            pin_camera_centered_region(settings, Some(diagnostics), 10.0);
            settings.collision_voxel_size = Some(
                settings
                    .collision_voxel_size
                    .unwrap_or(0.05)
                    .max(0.12),
            );
            settings.collision_fill_size = Some(
                settings
                    .collision_fill_size
                    .unwrap_or(1.6)
                    .min(1.0),
            );
            true
        }
        "reseed" => {
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        "object mode (carve only)" => {
            settings.collision_scene_type = Some("object".to_string());
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        "pc indoor defaults" => {
            settings.collision_carve_height = Some(1.6);
            settings.collision_carve_radius = Some(0.2);
            settings.collision_fill_size = Some(1.6);
            settings.collision_scene_type = Some("indoor".to_string());
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        "indoor bridge gaps" => {
            settings.collision_carve_height = Some(1.6);
            settings.collision_carve_radius = Some(0.2);
            settings.collision_fill_size = Some(2.0);
            settings.collision_opacity_threshold = Some(
                settings
                    .collision_opacity_threshold
                    .unwrap_or(0.1)
                    .min(0.06),
            );
            settings.collision_scene_type = Some("indoor".to_string());
            settings.collision_voxel_size = Some(
                settings
                    .collision_voxel_size
                    .unwrap_or(0.05)
                    .min(0.04),
            );
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        "indoor smaller capsule" => {
            settings.collision_carve_height = Some(1.4);
            settings.collision_carve_radius = Some(0.15);
            settings.collision_fill_size =
                Some(settings.collision_fill_size.unwrap_or(1.6).max(1.6));
            settings.collision_scene_type = Some("indoor".to_string());
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        "outdoor floor fill" => {
            settings.collision_scene_type = Some("outdoor".to_string());
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        "outdoor + relaxed opacity" => {
            settings.collision_carve_radius = Some(
                settings
                    .collision_carve_radius
                    .unwrap_or(0.35)
                    .min(0.25),
            );
            settings.collision_opacity_threshold = Some(
                settings
                    .collision_opacity_threshold
                    .unwrap_or(0.1)
                    .min(0.06),
            );
            settings.collision_scene_type = Some("outdoor".to_string());
            settings.collision_seed = Some(compute_collision_reseed(settings, diagnostics));
            false
        }
        _ => false,
    };
    mesh::clamp_seed_and_camera_to_region(settings);
    applied
}

const COLLISION_RECOVERY_LABELS: &[&str] = &[
    // region_too_large / huge pins: shrink to camera first (never full AABB).
    "camera region",
    "shrink camera region",
    "coarser voxels",
    "reseed",
    "object mode (carve only)",
    "pc indoor defaults",
    "indoor bridge gaps",
    "indoor smaller capsule",
    "outdoor floor fill",
    "outdoor + relaxed opacity",
    "drop region",
];

fn merge_fast_nav_collision_settings(
    base_value: &serde_json::Value,
    algo: &str,
) -> Result<MeshSettings, JsValue> {
    let mut merged = serde_json::Map::new();
    // MeshSettings.mode is required — default to collision/nav mode 2 when omitted
    // so binary callers can pass `{ algo: "voxel_collision" }` alone.
    merged.insert("mode".to_string(), serde_json::json!(2));
    if let Some(obj) = base_value.as_object() {
        for (k, v) in obj {
            if matches!(
                k.as_str(),
                "algo" | "recovery" | "emit_glb" | "emit_volume" | "min_room_floor_area"
            ) {
                continue;
            }
            merged.insert(k.clone(), v.clone());
        }
    }
    apply_fast_nav_collision_mesh_mode(algo, &mut merged);

    let settings: MeshSettings = serde_json::from_value(serde_json::Value::Object(merged))
        .map_err(|e| {
            fast_nav_failure(
                algo,
                "invalid_settings",
                format!("Invalid fast_nav collision settings: {}", e),
                Vec::new(),
                0.0,
                0,
                0,
            )
        })?;
    validate_collision_mesh_mode(&settings).map_err(|e| {
        let message = e
            .as_string()
            .unwrap_or_else(|| "Invalid collision_mesh_mode".to_string());
        fast_nav_failure(
            algo,
            "invalid_settings",
            message,
            Vec::new(),
            0.0,
            0,
            0,
        )
    })?;
    Ok(settings)
}

fn run_collision_build_pass(
    data: &[u8],
    settings: &MeshSettings,
    emit_glb: bool,
    emit_volume: bool,
) -> Result<CollisionVoxelBoundaryResult, JsValue> {
    let mut settings = settings.clone();
    mesh::clamp_seed_and_camera_to_region(&mut settings);
    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::build_collision_voxel_boundary(&splats, &settings, emit_volume);
    output_space::apply_collision_voxel_boundary(&settings, &mut result);
    if emit_glb {
        result.glb = soft_emit_glb(&result.mesh.vertices, &result.mesh.indices);
    }
    Ok(result)
}

fn run_fast_nav_collision(
    data: &[u8],
    base_value: &serde_json::Value,
    algo: &str,
    emit_glb: bool,
    emit_volume: bool,
) -> Result<FastNavResult, JsValue> {
    if algo == "sdf_marching_cubes" && !CAPABILITIES.contains(&"sdf_marching_cubes") {
        return Err(fast_nav_failure(
            algo,
            "unsupported_capability",
            "This build does not advertise capability sdf_marching_cubes.",
            Vec::new(),
            0.0,
            0,
            0,
        ));
    }

    let mut settings = merge_fast_nav_collision_settings(base_value, algo)?;
    mesh::clamp_seed_and_camera_to_region(&mut settings);
    let initially_pinned = settings_has_pinned_region(&settings);
    let mut attempted: Vec<String> = Vec::new();
    let mut fallback_used = false;
    let mut step_label = algo.to_string();

    // Voxel collision without a pin sizes the grid to the full splat AABB and can
    // hit region_too_large on outdoor/city streams — start from a camera box.
    // SDF-MC needs the unpinned full AABB for the indoor interior MC shell; if the
    // region is too large, recovery still pins a camera box via the ladder.
    if !initially_pinned {
        if algo == "sdf_marching_cubes" {
            log("fast_nav: sdf_marching_cubes unpinned — full splat AABB for interior MC shell");
        } else {
            log("fast_nav: no region pin — defaulting to camera-centered region");
            pin_camera_centered_region(&mut settings, None, 12.0);
            fallback_used = true;
            step_label = "camera region default".to_string();
            attempted.push("camera region default".to_string());
        }
    }

    let mut result = run_collision_build_pass(data, &settings, emit_glb, emit_volume)?;

    // Empty region cull → unclip once before the carve/settings ladder.
    if collision_build_needs_recovery(algo, &result)
        && initially_pinned
        && (result.diagnostics.collision_failure_reason.as_deref() == Some("no_filtered_points")
            || result.diagnostics.points_region_discarded > 0
                && result.diagnostics.points_after_filter == 0)
    {
        let reason = result
            .diagnostics
            .collision_failure_reason
            .clone()
            .unwrap_or_else(|| "empty_region".to_string());
        log(&format!(
            "fast_nav recovery: empty_region_unclip (reason: {})",
            reason
        ));
        attempted.push(format!("empty_region_unclip({})", reason));
        apply_collision_recovery_step_for_algo(
            "empty_region_unclip",
            &mut settings,
            &result.diagnostics,
            algo,
        );
        fallback_used = true;
        step_label = "empty_region_unclip".to_string();
        result = run_collision_build_pass(data, &settings, emit_glb, emit_volume)?;
    }

    for label in COLLISION_RECOVERY_LABELS {
        if !collision_build_needs_recovery(algo, &result) {
            break;
        }
        let reason = result.diagnostics.collision_failure_reason.as_deref();
        let had_region = settings_has_pinned_region(&settings) || initially_pinned;
        if !is_recoverable_collision_failure(reason, had_region)
            && !(algo == "sdf_marching_cubes" && sdf_mc_shell_missing(&result))
        {
            break;
        }
        if *label == "drop region" && !initially_pinned && !settings_has_pinned_region(&settings) {
            continue;
        }
        let reason_owned = reason
            .unwrap_or(if algo == "sdf_marching_cubes" && sdf_mc_shell_missing(&result) {
                "sdf_mc_empty_mesh"
            } else {
                "empty_mesh"
            })
            .to_string();
        log(&format!(
            "fast_nav recovery: {} (reason: {})",
            label, reason_owned
        ));
        attempted.push(format!("{}({})", label, reason_owned));
        apply_collision_recovery_step_for_algo(label, &mut settings, &result.diagnostics, algo);
        fallback_used = true;
        step_label = (*label).to_string();
        // Re-force product mesh mode after patches (SDF always smooth).
        if algo == "sdf_marching_cubes" {
            settings.collision_mesh_mode = Some("smooth".to_string());
        } else if settings.collision_mesh_mode.as_deref().unwrap_or("").is_empty()
            || settings.collision_mesh_mode.as_deref() == Some("smooth")
        {
            settings.collision_mesh_mode = Some("faces".to_string());
        }
        result = run_collision_build_pass(data, &settings, emit_glb, emit_volume)?;
    }

    if collision_mesh_is_empty(&result)
        || (algo == "sdf_marching_cubes" && sdf_mc_shell_missing(&result))
    {
        let reason = result
            .diagnostics
            .collision_failure_reason
            .clone()
            .unwrap_or_else(|| {
                if algo == "sdf_marching_cubes" && sdf_mc_shell_missing(&result) {
                    "sdf_mc_empty_mesh".to_string()
                } else {
                    "empty_mesh".to_string()
                }
            });
        let summary = if attempted.is_empty() {
            reason.clone()
        } else {
            format!("{} after {}", reason, attempted.join(" -> "))
        };
        let fail_reason = if algo == "sdf_marching_cubes" && sdf_mc_shell_missing(&result) {
            "sdf_mc_empty_mesh"
        } else {
            "empty_mesh"
        };
        return Err(fast_nav_failure(
            algo,
            fail_reason,
            format!(
                "fast_nav ({}) produced an empty collider mesh (reason: {}).",
                algo, summary
            ),
            attempted,
            0.0,
            0,
            0,
        ));
    }

    if fallback_used {
        log(&format!("fast_nav recovery succeeded: {}", step_label));
    }

    Ok(FastNavResult {
        api_version: result.api_version,
        semver: result.semver,
        capabilities: result.capabilities,
        algo: algo.to_string(),
        mesh: result.mesh,
        collider_mesh: result.collider_mesh,
        glb: result.glb,
        volume: result.volume,
        space: result.space,
        basis: result.basis,
        floor_plane: result.floor_plane,
        selected_area: 0.0,
        component_count: 0,
        selected_cell_count: 0,
        accepted_cell_count: 0,
        obstacle_cell_count: 0,
        rejected_cell_count: 0,
        fallback_used,
        step_label,
        diagnostics: result.diagnostics,
    })
}

/// Star FastNav export: one-shot splat → Recast-ready mesh for
/// `algo: "floor_field" | "voxel_collision" | "sdf_marching_cubes"` (default
/// `floor_field`). Hosts run Recast/crowd on the returned mesh. Prefer this over
/// piecing together `build_room_floor_mesh` / `build_collision_voxel_boundary`.
///
/// Optional `region_min` / `region_max` (`[x,y,z]` each, `splatwalk_oriented`
/// space) pin the consideration volume: splats outside the box are culled before
/// floater prune and before every algo's floor/collision compute.
#[wasm_bindgen]
pub fn fast_nav(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let base_value: serde_json::Value = if settings.is_undefined() || settings.is_null() {
        serde_json::json!({})
    } else {
        serde_wasm_bindgen::from_value(settings.clone())
            .map_err(|e| JsValue::from_str(&e.to_string()))?
    };
    let options: FastNavOptions = if settings.is_undefined() || settings.is_null() {
        FastNavOptions::default()
    } else {
        serde_wasm_bindgen::from_value(settings).unwrap_or_default()
    };

    // Validate region early so bad AABBs fail before any expensive parse.
    if let Err(err) = validate_region_json(&base_value) {
        let message = err
            .as_string()
            .unwrap_or_else(|| "Invalid region_min/region_max".to_string());
        return Err(fast_nav_failure(
            options.algo.as_deref().unwrap_or("floor_field"),
            "invalid_region",
            message,
            Vec::new(),
            0.0,
            0,
            0,
        ));
    }

    let algo = match parse_fast_nav_algo(options.algo.as_deref()) {
        Ok(a) => a,
        Err(message) => {
            let bad = options.algo.as_deref().unwrap_or("");
            return Err(fast_nav_failure(
                bad,
                "invalid_algo",
                message,
                Vec::new(),
                0.0,
                0,
                0,
            ));
        }
    };
    emit_progress("fast_nav", Some(0.0));
    let region_note = match (
        base_value.get("region_min"),
        base_value.get("region_max"),
    ) {
        (Some(_), Some(_)) => " region=pinned",
        _ => " region=full",
    };
    log(&format!("fast_nav algo={}{}", algo, region_note));

    let result = match algo {
        "floor_field" => {
            let emit_glb = options.emit_glb.unwrap_or(false);
            let base_min_area = options.min_room_floor_area.unwrap_or(4.0);
            let steps = match options.recovery {
                Some(ref steps) if !steps.is_empty() => steps.clone(),
                _ => default_room_floor_recovery(),
            };
            match run_room_floor_pipeline(data, &base_value, emit_glb, base_min_area, &steps) {
                Ok(room) => room_floor_to_fast_nav(algo, room),
                Err(failure)
                    if json_has_pinned_region(&base_value)
                        && matches!(
                            failure.reason.as_str(),
                            "no_component" | "too_small" | "empty_mesh" | "parse_error"
                        ) =>
                {
                    log(&format!(
                        "fast_nav recovery: empty_region_unclip (floor reason: {})",
                        failure.reason
                    ));
                    let stripped = json_without_region(&base_value);
                    let mut attempted = failure.attempted.clone();
                    attempted.push(format!("empty_region_unclip({})", failure.reason));
                    match run_room_floor_pipeline(
                        data,
                        &stripped,
                        emit_glb,
                        base_min_area,
                        &steps,
                    ) {
                        Ok(mut room) => {
                            room.fallback_used = true;
                            room.step_label =
                                format!("empty_region_unclip+{}", room.step_label);
                            log("fast_nav recovery succeeded: empty_region_unclip");
                            room_floor_to_fast_nav(algo, room)
                        }
                        Err(failure2) => {
                            let mut all = attempted;
                            all.extend(failure2.attempted);
                            return Err(fast_nav_failure(
                                algo,
                                &failure2.reason,
                                failure2.message,
                                all,
                                failure2.selected_area,
                                failure2.component_count,
                                failure2.steps,
                            ));
                        }
                    }
                }
                Err(failure) => {
                    return Err(fast_nav_failure(
                        algo,
                        &failure.reason,
                        failure.message,
                        failure.attempted,
                        failure.selected_area,
                        failure.component_count,
                        failure.steps,
                    ));
                }
            }
        }
        "voxel_collision" | "sdf_marching_cubes" => run_fast_nav_collision(
            data,
            &base_value,
            algo,
            options.emit_glb.unwrap_or(false),
            options.emit_volume.unwrap_or(false),
        )?,
        _ => unreachable!("normalize_fast_nav_algo only returns known algos"),
    };

    emit_progress("fast_nav", Some(1.0));
    Ok(serde_wasm_bindgen::to_value(&result)?)
}

/// Structured failure returned (as a rejected/thrown value) by
/// `build_room_floor_mesh`. `reason` is a stable machine code
/// (`no_component` / `too_small` / `empty_mesh` / `no_steps`); `message` is the
/// human-readable summary; `attempted` lists each recovery step and the reason
/// it failed.
#[derive(Serialize)]
struct RoomFloorFailure {
    api_version: u8,
    reason: String,
    message: String,
    attempted: Vec<String>,
    selected_area: f64,
    component_count: usize,
    steps: usize,
}

/// Tunable parameters for SOG export and streamed-SOG slicing. All fields are
/// optional; omitted values fall back to [`slice::SliceParams::default`].
#[derive(Deserialize, Default)]
pub struct SliceSettings {
    pub sh_degree: Option<usize>,
    pub sh_cluster_count: Option<usize>,
    pub sh_iterations: Option<usize>,
    pub chunk_count: Option<usize>,
    pub chunk_extent: Option<f64>,
    pub lod_levels: Option<usize>,
}

impl SliceSettings {
    fn to_params(&self) -> slice::SliceParams {
        let d = slice::SliceParams::default();
        slice::SliceParams {
            sh_degree: self.sh_degree.unwrap_or(d.sh_degree).min(3),
            sh_cluster_count: self
                .sh_cluster_count
                .unwrap_or(d.sh_cluster_count)
                .clamp(1, 65536),
            sh_iterations: self.sh_iterations.unwrap_or(d.sh_iterations).max(1),
            chunk_count: self.chunk_count.unwrap_or(d.chunk_count).max(1),
            chunk_extent: self.chunk_extent.unwrap_or(d.chunk_extent).max(0.0),
            lod_levels: self.lod_levels.unwrap_or(d.lod_levels).max(1),
        }
    }
}

fn parse_slice_settings(settings: JsValue) -> Result<SliceSettings, JsValue> {
    if settings.is_undefined() || settings.is_null() {
        return Ok(SliceSettings::default());
    }
    serde_wasm_bindgen::from_value(settings).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Slice a `.ply`/`.spz` splat into a streamed-SOG bundle: a `lod-meta.json`
/// manifest, per-chunk `meta.json` files, and raw RGBA planes for the JS layer
/// to encode to lossless WebP. Follows Babylon PR #18563's streaming layout.
#[wasm_bindgen]
pub fn slice_splat(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_slice_settings(settings)?;
    let params = settings.to_params();
    let cloud = splat::parse_full_cloud(data).map_err(|e| JsValue::from_str(&e))?;
    log(&format!(
        "Slicing {} splats (SH degree {}, {} LOD level(s), ~{} splats/chunk)",
        cloud.len(),
        params.sh_degree,
        params.lod_levels,
        params.chunk_count
    ));
    let manifest = slice::slice(&cloud, &params).map_err(|e| JsValue::from_str(&e))?;
    log(&format!("Sliced into {} chunk(s)", manifest.chunk_count));
    Ok(serde_wasm_bindgen::to_value(&manifest)?)
}

/// Convert a `.ply`/`.spz` splat into a single (non-LOD) SOG v2 bundle:
/// a `meta.json` plus raw RGBA planes for lossless WebP encoding.
#[wasm_bindgen]
pub fn convert_to_sog(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings = parse_slice_settings(settings)?;
    let params = settings.to_params();
    let cloud = splat::parse_full_cloud(data).map_err(|e| JsValue::from_str(&e))?;
    let manifest = slice::encode_single(
        &cloud,
        params.sh_degree,
        params.sh_cluster_count,
        params.sh_iterations,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_wasm_bindgen::to_value(&manifest)?)
}

/// Convert a `.spz` (or `.ply`) splat to a binary little-endian 3DGS `.ply`,
/// preserving the full spherical-harmonic stack. Enables basic `.spz` support
/// by normalizing everything to PLY for the viewer and nav pipeline.
#[wasm_bindgen]
pub fn spz_to_ply(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let cloud = splat::parse_full_cloud(data).map_err(|e| JsValue::from_str(&e))?;
    Ok(splat::write_ply(&cloud))
}

/// Convert an antimatter15 `.splat` buffer to a binary little-endian 3DGS `.ply`.
/// The `.splat` format carries no spherical harmonics, so the output is SH degree
/// 0. Normalizes `.splat` input to PLY for the viewer and nav pipeline.
#[wasm_bindgen]
pub fn splat_to_ply(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let cloud = splat::parse_splat_buffer(data).map_err(|e| JsValue::from_str(&e))?;
    Ok(splat::write_ply(&cloud))
}

/// Serialize a positions + indices triangle mesh into minimal binary glTF (GLB)
/// bytes (no materials/normals). Lets a binary integrator turn vertex/index
/// buffers into GLB without standing up a 3D engine per call. `positions` are xyz
/// triplets; `indices` are `u32` triangle indices.
#[wasm_bindgen]
pub fn mesh_to_glb(positions: &[f32], indices: &[u32]) -> Result<Vec<u8>, JsValue> {
    glb::mesh_to_glb(positions, indices).map_err(|e| JsValue::from_str(&e))
}

/// Optional GLB for `emit_glb`: skip empty meshes instead of failing the whole build.
fn soft_emit_glb(vertices: &[f32], indices: &[u32]) -> Option<serde_bytes::ByteBuf> {
    if vertices.is_empty() || indices.is_empty() {
        log("emit_glb skipped: empty mesh (caller can synthesize GLB from volume)");
        return None;
    }
    match glb::mesh_to_glb(vertices, indices) {
        Ok(bytes) => Some(serde_bytes::ByteBuf::from(bytes)),
        Err(err) => {
            log(&format!("emit_glb skipped: {}", err));
            None
        }
    }
}
