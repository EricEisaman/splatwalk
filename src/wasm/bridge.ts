import init, {
    init_splatwalk,
    build_walkable_ground_field,
    convert_splat_to_mesh,
    convert_splat_to_navmesh_basis,
    get_splat_bounds,
    suggest_region,
} from '../../pkg/wasm_splatwalk/wasm_splatwalk.js';

export interface MeshBuffers {
    vertices: Float32Array;
    indices: Uint32Array;
    vertex_count: number;
    face_count: number;
}

export interface CoordinateSpace {
    space: 'splatwalk_oriented' | string;
    up_axis: 'y' | string;
    handedness: 'right' | 'left' | string;
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

export interface ReconstructionResult {
    api_version: 2;
    mesh: MeshBuffers;
    space: CoordinateSpace;
    diagnostics: ReconstructionDiagnostics;
}

export interface SplatBounds {
    api_version: 2;
    point_count: number;
    oriented_min: [number, number, number];
    oriented_max: [number, number, number];
    floor_y_percentile_02: number;
    space: CoordinateSpace;
}

export interface SuggestedRegion {
    api_version: 2;
    region_min: [number, number, number];
    region_max: [number, number, number];
    floor_y: number;
    sample_count: number;
    clamped_height: boolean;
    space: CoordinateSpace;
}

export interface NavmeshBasisResult {
    api_version: 2;
    mesh: MeshBuffers;
    space: CoordinateSpace;
    basis: FieldBasis;
    floor_plane: FloorPlane;
    diagnostics: ReconstructionDiagnostics;
}

export interface WalkableGroundFieldResult {
    api_version: 2;
    cells: GroundFieldCell[];
    width: number;
    height: number;
    cell_size: number;
    basis: FieldBasis;
    floor_plane: FloorPlane;
    space: CoordinateSpace;
    diagnostics: ReconstructionDiagnostics;
}

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
    rotation?: number[];
    flip_y?: boolean;
}

export class SplatWalkBridge {
    private static instance: SplatWalkBridge;
    private isInitialized = false;

    private constructor() { }

    public static getInstance(): SplatWalkBridge {
        if (!SplatWalkBridge.instance) {
            SplatWalkBridge.instance = new SplatWalkBridge();
        }
        return SplatWalkBridge.instance;
    }

    public async init(): Promise<void> {
        if (this.isInitialized) return;

        try {
            await init();
            const message = init_splatwalk();
            console.log('Rust says:', message);
            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to initialize SplatWalk WASM:', error);
            throw error;
        }
    }

    public getSplatBounds(data: Uint8Array, settings: MeshSettings): SplatBounds {
        this.assertInitialized();
        return get_splat_bounds(data, settings) as SplatBounds;
    }

    public suggestRegion(data: Uint8Array, settings: MeshSettings): SuggestedRegion {
        this.assertInitialized();
        return suggest_region(data, settings) as SuggestedRegion;
    }

    public convertSplatToMesh(data: Uint8Array, settings: MeshSettings): ReconstructionResult {
        this.assertInitialized();
        try {
            return convert_splat_to_mesh(data, settings) as ReconstructionResult;
        } catch (e) {
            console.error("Conversion failed in WASM:", e);
            throw e;
        }
    }

    public convertSplatToNavmeshBasis(data: Uint8Array, settings: MeshSettings): NavmeshBasisResult {
        this.assertInitialized();
        return convert_splat_to_navmesh_basis(data, settings) as NavmeshBasisResult;
    }

    public buildWalkableGroundField(data: Uint8Array, settings: MeshSettings): WalkableGroundFieldResult {
        this.assertInitialized();
        return build_walkable_ground_field(data, settings) as WalkableGroundFieldResult;
    }

    private assertInitialized(): void {
        if (!this.isInitialized) {
            throw new Error("SplatWalk WASM not initialized");
        }
    }
}

export const splatwalk = SplatWalkBridge.getInstance();
