use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod glb;
mod mesh;
mod output_space;
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
    log("G2M WASM Initialized with Parsing Support");
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
    "progress_protocol_v1",
    "glb_export",
    "room_floor_mesh",
    "sog_export",
    "streamed_sog",
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

#[derive(Serialize)]
pub struct CollisionVoxelBoundaryResult {
    pub api_version: u8,
    pub semver: String,
    pub capabilities: Vec<String>,
    pub mesh: MeshBuffers,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glb: Option<serde_bytes::ByteBuf>,
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
#[derive(Deserialize, Default)]
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
    match settings.collision_mesh_mode.as_deref().unwrap_or("faces") {
        "faces" => Ok(()),
        "smooth" => Err(JsValue::from_str(
            "collision_mesh_mode=\"smooth\" is reserved but not implemented; use \"faces\".",
        )),
        other => Err(JsValue::from_str(&format!(
            "Invalid collision_mesh_mode: {}. Expected \"faces\" or \"smooth\".",
            other
        ))),
    }
}

/// Identity of a parsed+pruned+oriented point set, so repeated WASM calls on the
/// same bytes+settings within a session can reuse the result instead of
/// re-parsing the PLY and re-running the (expensive) floater prune every time.
#[derive(Clone, PartialEq)]
struct ParseKey {
    len: usize,
    hash: u64,
    prune: bool,
    k: usize,
    std_ratio_bits: u64,
    flip_y: bool,
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

fn parse_splats(data: &[u8], settings: &MeshSettings) -> Result<Vec<splat::PointNormal>, JsValue> {
    let prune = settings.prune_floaters.unwrap_or(true);
    let k = settings.prune_floaters_k.unwrap_or(16);
    let std_ratio = settings.prune_floaters_std_ratio.unwrap_or(2.0);
    let flip_y = settings.flip_y.unwrap_or(false);

    let key = ParseKey {
        len: data.len(),
        hash: fingerprint(data),
        prune,
        k,
        std_ratio_bits: std_ratio.to_bits(),
        flip_y,
    };

    // Cache hit: reuse the previously parsed+pruned+oriented points.
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

    // Prune stray floater splats at the single ingest chokepoint so every
    // downstream op (bounds, region suggestion, seed, floor field, mesh) operates
    // on the cleaned set. Defaults on; integrators can disable or tune it.
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
    let settings = parse_settings(settings)?;
    validate_collision_mesh_mode(&settings)?;
    let splats = parse_splats(data, &settings)?;
    let mut result = mesh::build_collision_voxel_boundary(&splats, &settings);
    output_space::apply_collision_voxel_boundary(&settings, &mut result);
    if options.emit_glb.unwrap_or(false) {
        let bytes = glb::mesh_to_glb(&result.mesh.vertices, &result.mesh.indices)
            .map_err(|e| JsValue::from_str(&e))?;
        result.glb = Some(serde_bytes::ByteBuf::from(bytes));
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

/// Extract a triangulated room-floor mesh entirely in WASM: the binary-side
/// equivalent of the TypeScript FAST NAV floor path. Builds the 2.5D walkable
/// ground field, selects the seed-nearest connected floor component (with a
/// relaxed-mask and largest-island fallback), trims stray cells, and triangulates
/// the result. Runs an adaptive recovery ladder (`settings.recovery`, or a
/// built-in default) and returns the same failure reasons as the TS path
/// (`no_component` / `too_small` / `empty_mesh`). Set `settings.emit_glb` to also
/// receive GLB bytes.
#[wasm_bindgen]
pub fn build_room_floor_mesh(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let base_value: serde_json::Value = serde_wasm_bindgen::from_value(settings.clone())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let options: RoomFloorOptions = serde_wasm_bindgen::from_value(settings).unwrap_or_default();

    let emit_glb = options.emit_glb.unwrap_or(false);
    let base_min_area = options.min_room_floor_area.unwrap_or(4.0);
    let steps = match options.recovery {
        Some(steps) if !steps.is_empty() => steps,
        _ => default_room_floor_recovery(),
    };

    // Bake the canonical FAST NAV preset as the base layer so binary-only callers
    // get upstream-correct floor extraction without copying the preset. Caller
    // settings override the preset, and the per-step recovery patch overrides both
    // (preset < caller settings < step patch).
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
            merged.insert(k.clone(), v.clone());
        }
        if let Some(serde_json::Value::Object(patch)) = &step.settings {
            for (k, v) in patch {
                merged.insert(k.clone(), v.clone());
            }
        }
        let settings: MeshSettings = serde_json::from_value(serde_json::Value::Object(merged))
            .map_err(|e| JsValue::from_str(&format!("Invalid room-floor settings: {}", e)))?;

        let splats = parse_splats(data, &settings)?;
        match mesh::extract_room_floor(&splats, &settings, min_area, &label) {
            Ok(build) => {
                // Convert geometry to the requested output space (if any) BEFORE
                // generating the GLB, so both the mesh buffers and the GLB bytes
                // agree on a single coordinate convention.
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
                    let bytes = glb::mesh_to_glb(&mesh.vertices, &mesh.indices)
                        .map_err(|e| JsValue::from_str(&e))?;
                    Some(serde_bytes::ByteBuf::from(bytes))
                } else {
                    None
                };
                let result = RoomFloorMeshResult {
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
                };
                return Ok(serde_wasm_bindgen::to_value(&result)?);
            }
            Err(e) => {
                attempted.push(format!("{}({})", label, e.reason));
                last_err = Some(e);
            }
        }
    }

    // Reject with a structured failure object (not a bare string) so integrators
    // branch on a stable `reason` code instead of string-matching prose.
    let summary = attempted.join(" -> ");
    let failure = match last_err {
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
    };
    Err(serde_wasm_bindgen::to_value(&failure)?)
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
