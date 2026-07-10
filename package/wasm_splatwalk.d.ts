/* tslint:disable */
/* eslint-disable */
/**
 * Hand-authored TypeScript declarations for the SplatWalk WASM core.
 *
 * This file is a drop-in replacement for the `.d.ts` that wasm-bindgen generates,
 * which types every settings argument and every result as `any`. It is published
 * alongside the binary so binary-only integrators get the real settings and
 * result shapes without re-deriving them from the TypeScript bridge.
 *
 * The shapes here are the canonical v2 data contract. `api_version` stays the hard
 * compatibility gate (always `2`); `semver` and `capabilities` are additive so
 * integrators can tolerate additive change instead of hard-failing on a bump.
 * See `docs/wasm-api.md` for units, ranges, defaults, and the coordinate +
 * progress-line contracts.
 */

// ---------------------------------------------------------------------------
// Coordinate + shared shapes
// ---------------------------------------------------------------------------

export interface CoordinateSpace {
  /** `splatwalk_oriented` for default output, `engine_output` when an `output_space` conversion was applied. */
  space: 'splatwalk_oriented' | 'engine_output' | string;
  up_axis: 'y' | 'z' | string;
  handedness: 'right' | 'left' | string;
}

/**
 * Opt-in output coordinate convention for {@link MeshSettings.output_space}.
 *
 * When set, every mesh/basis/floor-plane result is converted from the default
 * `splatwalk_oriented` space (right-handed, `+Y` up, CCW winding) into the
 * requested convention and the reported `space` is updated to `engine_output`.
 * Omitting it leaves all outputs in `splatwalk_oriented` space, unchanged.
 * Per-cell ground-field scalars and `diagnostics` always stay in
 * `splatwalk_oriented` space.
 */
export interface OutputSpaceSettings {
  /** `"y"` (default) or `"z"` (rotates `+Y`-up into `+Z`-up about X). */
  up_axis?: 'y' | 'z';
  /** `"right"` (default) or `"left"` (mirrors the Z axis). */
  handedness?: 'right' | 'left';
  /** `"auto"` (default; flips only when the basis is mirrored), `"ccw"`, or `"cw"`. */
  winding?: 'auto' | 'ccw' | 'cw';
}

export interface MeshBuffers {
  vertices: Float32Array;
  indices: Uint32Array;
  vertex_count: number;
  face_count: number;
}

export interface FloorPlane {
  normal: [number, number, number];
  d: number;
}

export interface FieldBasis {
  origin: [number, number, number];
  tangent: [number, number, number];
  bitangent: [number, number, number];
  up: [number, number, number];
}

export type GroundFieldCellState =
  | 'walkable'
  | 'low_confidence'
  | 'height_variance'
  | 'obstacle'
  | 'void'
  | 'filled'
  | 'eroded'
  | 'discarded_component';

export interface GroundFieldCell {
  height: number;
  confidence: number;
  variance: number;
  normal_alignment: number;
  obstacle_score: number;
  primary_layer_height: number;
  layer_count: number;
  peak_density: number;
  surface_confidence: number;
  signed_distance: number;
  gradient: [number, number];
  component_id: number;
  state: GroundFieldCellState;
}

/** Fields present on every v2 result. */
export interface ResultContract {
  api_version: 2;
  /** Semantic version of the WASM core build (tracks the crate version). */
  semver: string;
  /** Additive capability flags advertised by this build. */
  capabilities: string[];
}

export interface ReconstructionDiagnostics {
  api_version: 2;
  region_min?: number[];
  region_max?: number[];
  oriented_min?: [number, number, number];
  oriented_max?: [number, number, number];
  floor_y_percentile_02?: number;
  points_total: number;
  points_invalid: number;
  points_region_discarded: number;
  points_after_filter: number;
  ransac_inliers: number;
  grid_width: number;
  grid_height: number;
  cell_size: number;
  valid_vertices: number;
  faces_generated: number;
  faces_rejected_no_coverage: number;
  faces_rejected_too_steep: number;
  connected_components: number;
  largest_component_faces: number;
  holes_filled: number;
  rejected_cells: number;
  cells_rejected_low_confidence: number;
  cells_rejected_height_variance: number;
  cells_rejected_obstacle: number;
  cells_void: number;
  cells_filled: number;
  cells_eroded: number;
  cells_discarded_component: number;
  selected_component_id: number;
  selected_component_area: number;
  floor_plane_source: string;
  floor_plane_normal_y: number;
  floor_plane_height: number;
  floor_plane_used_fallback: boolean;
  sdf_density_threshold: number;
  sdf_vertical_cell_size: number;
  sdf_profile_bins: number;
  sdf_cells_with_surface: number;
  sdf_cells_multi_layer: number;
  sdf_cells_smoothed: number;
  collision_voxel_size: number;
  collision_grid_width: number;
  collision_grid_height: number;
  collision_grid_depth: number;
  collision_occupied_voxels: number;
  collision_cluster_kept_voxels: number;
  collision_cluster_discarded_voxels: number;
  collision_filled_voxels: number;
  collision_carved_voxels: number;
  collision_surface_faces: number;
  collision_seed_used?: [number, number, number];
  collision_seed_state: string;
  collision_scene_type: string;
  collision_mesh_mode: string;
  collision_external_fill_leaked: boolean;
  collision_failure_reason?: string;
  floor_plane?: FloorPlane;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface MeshSettings {
  mode: number;
  voxel_target?: number;
  sdf_cell_size?: number;
  sdf_vertical_cell_size?: number;
  sdf_density_threshold?: number;
  sdf_max_layers?: number;
  sdf_smoothing_radius?: number;
  sdf_influence_radius_scale?: number;
  collision_voxel_size?: number;
  collision_opacity_threshold?: number;
  collision_scene_type?: 'indoor' | 'outdoor' | 'object';
  collision_seed?: number[];
  collision_fill_size?: number;
  collision_carve_height?: number;
  collision_carve_radius?: number;
  collision_mesh_mode?: 'faces' | 'smooth';
  min_alpha?: number;
  max_scale?: number;
  normal_align?: number;
  ransac_thresh?: number;
  floor_projection_epsilon?: number;
  height_projection_epsilon?: number;
  obstacle_height_epsilon?: number;
  obstacle_clearance_min?: number;
  obstacle_clearance_max?: number;
  max_local_height_variance?: number;
  min_floor_confidence?: number;
  hole_fill_radius?: number;
  agent_radius_erode?: number;
  component_mode?: 'largest' | 'nearest_region_center' | 'all';
  region_min?: number[];
  region_max?: number[];
  /** Statistical outlier removal ("prune floaters"). Default `true`. */
  prune_floaters?: boolean;
  /** Neighbours sampled per splat for outlier removal (default 16). */
  prune_floaters_k?: number;
  /** Keep splats within `mean + std_ratio * stddev` (default 2.0). Lower = more aggressive. */
  prune_floaters_std_ratio?: number;
  rotation?: number[];
  /**
   * Opt-in output coordinate convention. Absent = default `splatwalk_oriented`
   * output (right-handed, `+Y` up, CCW). See {@link OutputSpaceSettings}.
   */
  output_space?: OutputSpaceSettings;
  flip_y?: boolean;
}

export interface SliceSettings {
  /** Exported SH degree cap, 0..3 (default 0). */
  sh_degree?: number;
  /** shN k-means palette size (default 4096). */
  sh_cluster_count?: number;
  /** shN k-means refinement passes (default 10). */
  sh_iterations?: number;
  /** Target splats per LOD chunk (default 256000). */
  chunk_count?: number;
  /** Soft chunk extent in meters (default 16). */
  chunk_extent?: number;
  /** LOD levels, >= 1 (default 2). */
  lod_levels?: number;
}

/** A single attempt in the optional WASM-side floor recovery ladder. */
export interface RoomFloorRecoveryStep {
  label: string;
  settings: Partial<MeshSettings>;
  min_room_floor_area: number;
}

/** Settings for {@link build_room_floor_mesh} (a superset of {@link MeshSettings}). */
export interface RoomFloorSettings extends MeshSettings {
  /** Minimum accepted floor area (m^2) for the base attempt. Default 4.0. */
  min_room_floor_area?: number;
  /** When true, also emit a GLB of the floor mesh in `glb`. Default false. */
  emit_glb?: boolean;
  /** Optional recovery ladder; when omitted a built-in default ladder is used. */
  recovery?: RoomFloorRecoveryStep[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ReconstructionResult extends ResultContract {
  mesh: MeshBuffers;
  space: CoordinateSpace;
  diagnostics: ReconstructionDiagnostics;
}

export interface SplatBounds extends ResultContract {
  point_count: number;
  oriented_min: [number, number, number];
  oriented_max: [number, number, number];
  floor_y_percentile_02: number;
  space: CoordinateSpace;
}

export interface SuggestedRegion extends ResultContract {
  region_min: [number, number, number];
  region_max: [number, number, number];
  floor_y: number;
  sample_count: number;
  clamped_height: boolean;
  space: CoordinateSpace;
}

export interface NavmeshBasisResult extends ResultContract {
  mesh: MeshBuffers;
  space: CoordinateSpace;
  basis: FieldBasis;
  floor_plane: FloorPlane;
  diagnostics: ReconstructionDiagnostics;
}

export interface WalkableGroundFieldResult extends ResultContract {
  cells: GroundFieldCell[];
  width: number;
  height: number;
  cell_size: number;
  basis: FieldBasis;
  floor_plane: FloorPlane;
  space: CoordinateSpace;
  diagnostics: ReconstructionDiagnostics;
}

/** Result of {@link build_room_floor_mesh}: a triangulated room-floor mesh. */
export interface RoomFloorMeshResult extends ResultContract {
  mesh: MeshBuffers;
  /** GLB bytes of the floor mesh, present only when `emit_glb` was set. */
  glb?: Uint8Array;
  space: CoordinateSpace;
  basis: FieldBasis;
  floor_plane: FloorPlane;
  /** Selected floor area in square meters. */
  selected_area: number;
  /** Number of connected floor components considered. */
  component_count: number;
  selected_cell_count: number;
  accepted_cell_count: number;
  obstacle_cell_count: number;
  rejected_cell_count: number;
  /** Whether the relaxed mask / largest-island fallback was used. */
  fallback_used: boolean;
  /** Label of the recovery step that produced the floor. */
  step_label: string;
  diagnostics: ReconstructionDiagnostics;
}

/**
 * Structured failure value rejected/thrown by {@link build_room_floor_mesh} when
 * no recovery step yields a usable room floor. Branch on the stable `reason` code
 * rather than string-matching `message`.
 */
export interface RoomFloorFailure {
  api_version: 2;
  /** Stable machine code: the reason the last attempt failed. */
  reason: 'no_component' | 'too_small' | 'empty_mesh' | 'no_steps' | string;
  /** Human-readable summary across all attempted recovery steps. */
  message: string;
  /** Each attempted recovery step formatted as `label(reason)`. */
  attempted: string[];
  /** Largest usable floor area found, in square meters. */
  selected_area: number;
  /** Number of connected floor components considered. */
  component_count: number;
  /** Number of recovery steps attempted. */
  steps: number;
}

/** Raw streamed-SOG / SOG manifest returned by {@link slice_splat} / {@link convert_to_sog}. */
export interface SliceManifest {
  lodMetaPath: string;
  lodMetaJson: string;
  files: { path: string; contents: string }[];
  binaries: { path: string; bytes: Uint8Array }[];
  splatCount: number;
  chunkCount: number;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function init_splatwalk(): string;

// ---------------------------------------------------------------------------
// Cheap pre-flight introspection (no parse / field build required)
// ---------------------------------------------------------------------------

/** Semantic version of the WASM core build (tracks the crate version). */
export function splatwalk_version(): string;

/** Integer data-contract version (same value as every result's `api_version`). */
export function splatwalk_api_version(): number;

/** Additive capability flags advertised by this build. */
export function splatwalk_capabilities(): string[];

/**
 * Register (or, with `undefined`, clear) an opt-in progress callback invoked as
 * `callback(stage, fraction)` at the same boundaries as the `@progress` line
 * protocol. The line protocol is still emitted as a fallback.
 */
export function set_progress_callback(
  callback?: (stage: string, fraction?: number) => void
): void;

/**
 * The canonical FAST NAV floor-field preset as a settings object. Pass it
 * (merged with per-scene `rotation` / `flip_y` / `collision_seed` / `region_*`)
 * to {@link build_walkable_ground_field} / {@link build_room_floor_mesh};
 * the latter already applies it as a base layer automatically.
 */
export function fast_nav_preset(): MeshSettings;

/** Reference FAST NAV agent dimensions (metres). */
export function recast_agent_defaults(): {
  cs: number;
  ch: number;
  walkableHeight: number;
  walkableRadius: number;
  walkableClimb: number;
  walkableSlopeAngle: number;
};

/**
 * Convert metre-valued agent dimensions into Recast's integer voxel counts
 * (`walkableHeight = ceil(h/ch)`, `walkableClimb = floor(climb/ch)`,
 * `walkableRadius = ceil(r/cs)`) and suggest vertical-bounds padding. Inputs
 * (all metres) default to {@link recast_agent_defaults} when omitted.
 */
export function recast_config(settings?: {
  cs?: number;
  ch?: number;
  walkableHeight?: number;
  walkableClimb?: number;
  walkableRadius?: number;
  walkableSlopeAngle?: number;
  /** Highest floor-cell Y (metres); when given, `suggestedBmaxY` is returned. */
  maxFloorY?: number;
}): {
  cs: number;
  ch: number;
  walkableHeight: number;
  walkableClimb: number;
  walkableRadius: number;
  walkableSlopeAngle: number;
  /** Suggested padding to add above the highest floor cell, in metres. */
  bmaxYPadding: number;
  /** `maxFloorY + bmaxYPadding`, or `null` when `maxFloorY` was omitted. */
  suggestedBmaxY: number | null;
};

export function get_splat_bounds(data: Uint8Array, settings: MeshSettings): SplatBounds;

export function suggest_region(data: Uint8Array, settings: MeshSettings): SuggestedRegion;

export function convert_splat_to_mesh(data: Uint8Array, settings: MeshSettings): ReconstructionResult;

export function convert_splat_to_navmesh_basis(data: Uint8Array, settings: MeshSettings): NavmeshBasisResult;

export function build_walkable_ground_field(data: Uint8Array, settings: MeshSettings): WalkableGroundFieldResult;

/**
 * Extract a triangulated room-floor mesh directly in WASM (the binary-side
 * equivalent of the TypeScript FAST NAV floor path). The canonical FAST NAV
 * preset is applied as a base layer automatically (your settings and the
 * per-step recovery patch override it).
 *
 * On failure it throws/rejects with a structured {@link RoomFloorFailure} object
 * (not a string): branch on `err.reason` for control flow and telemetry.
 */
export function build_room_floor_mesh(data: Uint8Array, settings: RoomFloorSettings): RoomFloorMeshResult;

/**
 * Serialize positions + indices into a minimal binary glTF (GLB) without
 * standing up a 3D engine. Positions are xyz triplets; indices are `u32`.
 */
export function mesh_to_glb(positions: Float32Array, indices: Uint32Array): Uint8Array;

/** Slice a `.ply`/`.spz` splat into a streamed-SOG bundle. */
export function slice_splat(data: Uint8Array, settings: SliceSettings): SliceManifest;

/** Convert a `.ply`/`.spz` splat into a single (non-LOD) SOG v2 bundle. */
export function convert_to_sog(data: Uint8Array, settings: SliceSettings): SliceManifest;

/** Convert a `.spz` (or `.ply`) splat to a full-fidelity binary little-endian 3DGS `.ply`. */
export function spz_to_ply(data: Uint8Array): Uint8Array;

/** Convert an antimatter15 `.splat` buffer to a full-fidelity binary little-endian 3DGS `.ply` (SH degree 0). */
export function splat_to_ply(data: Uint8Array): Uint8Array;

// ---------------------------------------------------------------------------
// wasm-bindgen init plumbing (kept loose; matches the generated `--target web` glue)
// ---------------------------------------------------------------------------

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
export type SyncInitInput = BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly [exportName: string]: unknown;
}

/** Instantiate the module synchronously from already-fetched bytes/module. */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * Default export: load + instantiate the wasm. Always await this (or `initSync`)
 * before calling any named export.
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>
): Promise<InitOutput>;
