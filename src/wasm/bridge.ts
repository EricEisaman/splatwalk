/// <reference types="vite/client" />
import SplatWorker from './splat.worker?worker';
import type { SliceSettings, SliceResult } from './sogTypes';

/** Worker payload shape for slice/convert results before Map reconstruction. */
interface SliceResultRaw {
    files: Array<[string, Uint8Array]>;
    lodMetaPath: string;
    splatCount: number;
    chunkCount: number;
}

export interface MeshBuffers {
    vertices: Float32Array;
    indices: Uint32Array;
    vertex_count: number;
    face_count: number;
}

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

/**
 * Fields present on every v2 WASM result. `api_version` is the hard data
 * contract; `semver` is the build's semantic version (tracks the crate) and
 * `capabilities` is an additive list of supported features so integrators can
 * tolerate additive change instead of hard-failing on a bump.
 */
export interface ResultContract {
    api_version: 2;
    semver: string;
    capabilities: string[];
}

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

/** Packed dense voxel volume for PC-style runtime walk (capability `collision_voxel_volume`). */
export interface CollisionVoxelVolume {
    /** Grid minimum corner in `splatwalk_oriented` space. */
    origin: [number, number, number];
    /** Voxel counts [x, y, z]. */
    dims: [number, number, number];
    voxel_size: number;
    /** LSB-first bit-packed solid occupancy (`ceil(n/8)` bytes). */
    solid: Uint8Array;
    /** LSB-first bit-packed carved nav region (`ceil(n/8)` bytes). */
    nav_region: Uint8Array;
}

export interface CollisionVoxelBoundaryResult extends ResultContract {
    mesh: MeshBuffers;
    /** GLB bytes of the collision mesh, present only when `emit_glb` was set. */
    glb?: Uint8Array;
    /** Dense solid + nav_region, present only when `emit_volume` was set. */
    volume?: CollisionVoxelVolume;
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

/** A single attempt in the optional WASM-side room-floor recovery ladder. */
export interface RoomFloorRecoveryStep {
    label: string;
    settings: Partial<MeshSettings>;
    min_room_floor_area: number;
}

/** Settings for {@link SplatWalkBridge.buildRoomFloorMesh} (a superset of {@link MeshSettings}). */
export interface RoomFloorSettings extends MeshSettings {
    /** Minimum accepted floor area (m^2) for the base attempt. Default 4.0. */
    min_room_floor_area?: number;
    /** When true, also emit a GLB of the floor mesh in `glb`. Default false. */
    emit_glb?: boolean;
    /** Optional recovery ladder; when omitted a built-in default ladder is used. */
    recovery?: RoomFloorRecoveryStep[];
}

/** Settings for {@link SplatWalkBridge.buildCollisionVoxelBoundary}. */
export interface CollisionVoxelBoundarySettings extends MeshSettings {
    /** When true, also emit a GLB of the collision boundary mesh in `glb`. Default false. */
    emit_glb?: boolean;
    /** When true, also emit packed `solid` + `nav_region` in `volume`. Default false. */
    emit_volume?: boolean;
}

/** Result of {@link SplatWalkBridge.buildRoomFloorMesh}: a triangulated room-floor mesh. */
export interface RoomFloorMeshResult extends ResultContract {
    mesh: MeshBuffers;
    /** GLB bytes of the floor mesh, present only when `emit_glb` was set. */
    glb?: Uint8Array;
    space: CoordinateSpace;
    basis: FieldBasis;
    floor_plane: FloorPlane;
    selected_area: number;
    component_count: number;
    selected_cell_count: number;
    accepted_cell_count: number;
    obstacle_cell_count: number;
    rejected_cell_count: number;
    fallback_used: boolean;
    step_label: string;
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
    collision_mesh_mode?: 'faces' | 'obstacle_shell' | 'smooth' | 'walkable_floors';
    /** PlayCanvas `--filter-cluster` on splats before fine voxelize (default true in WASM). */
    collision_filter_cluster?: boolean;
    /** Cap padded voxel grid size; WASM coarsens voxel_size when exceeded. */
    collision_max_voxels?: number;
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
    /**
     * Statistical outlier removal ("prune floaters"). When true (the default),
     * stray sparse splats far from the dense surface are removed before any
     * geometry/region/seed computation. Applies to every WASM entry point.
     */
    prune_floaters?: boolean;
    /** Neighbours sampled per splat for outlier removal (default 16). */
    prune_floaters_k?: number;
    /**
     * Removal aggressiveness: keep splats whose mean neighbour distance is within
     * `mean + std_ratio * stddev` (default 2.0). Lower = more aggressive.
     */
    prune_floaters_std_ratio?: number;
    rotation?: number[];
    /**
     * Opt-in output coordinate convention. Absent = default `splatwalk_oriented`
     * output (right-handed, `+Y` up, CCW). See {@link OutputSpaceSettings}.
     */
    output_space?: OutputSpaceSettings;
    flip_y?: boolean;
    /**
     * Uniform world scale for oriented splat positions / gaussian scales (default 1).
     * Must match the renderer's environment scale so bake space aligns with the splat.
     */
    environment_scale?: number;
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}

/**
 * Main-thread proxy for the SplatWalk WASM, which now runs inside a dedicated
 * Web Worker (`splat.worker.ts`). Every op is async and message-passed so the
 * heavy parse/prune/floor-field work never blocks UI interaction.
 *
 * The (potentially large) splat bytes are transferred to the worker once per
 * file via {@link ensureLoaded} and reused for all subsequent ops; combined with
 * the WASM-side parse+prune cache, repeated calls within a run are cheap.
 */
export class SplatWalkBridge {
    private static instance: SplatWalkBridge;

    private worker: Worker | null = null;
    private seq = 0;
    private readonly pending = new Map<number, PendingCall>();
    private initPromise: Promise<void> | null = null;
    /** The Uint8Array reference currently loaded in the worker (identity check). */
    private activeData: Uint8Array | null = null;
    /** Number of in-flight worker calls; drives the busy indicator. */
    private inflight = 0;

    /** Optional hook fired when the bridge transitions busy <-> idle. */
    public onBusyChange: ((busy: boolean) => void) | null = null;

    /**
     * Optional hook fired with throttled progress from the WASM worker.
     * `stage` is a short label (e.g. 'parse', 'prune'); `fraction` is 0..1 when a
     * real percentage is available, or `null` for indeterminate stages.
     */
    public onProgress: ((stage: string, fraction: number | null) => void) | null = null;

    /** Optional hook for worker/WASM `console.log` lines (parse counts, grid sizing, etc.). */
    public onWorkerLog: ((message: string) => void) | null = null;

    private constructor() { }

    public static getInstance(): SplatWalkBridge {
        if (!SplatWalkBridge.instance) {
            SplatWalkBridge.instance = new SplatWalkBridge();
        }
        return SplatWalkBridge.instance;
    }

    private ensureWorker(): Worker {
        if (!this.worker) {
            this.worker = new SplatWorker();
            this.worker.onmessage = (e: MessageEvent): void => {
                const data = e.data;
                if (data?.kind === 'log') {
                    // Replay worker/WASM logs through the main-thread console so any
                    // existing console capture (e.g. homepage System Logs) sees them.
                    const level = data.level as 'log' | 'warn' | 'error';
                    console[level](data.message);
                    this.onWorkerLog?.(data.message as string);
                    return;
                }
                if (data?.kind === 'progress') {
                    this.onProgress?.(data.stage as string, data.fraction as number | null);
                    return;
                }
                if (data?.kind === 'result') {
                    const call = this.pending.get(data.id);
                    if (!call) return;
                    this.pending.delete(data.id);
                    if (data.ok) call.resolve(data.result);
                    else call.reject(new Error(data.error));
                }
            };
        }
        return this.worker;
    }

    private call<T>(type: string, payload: unknown, transfer: Transferable[] = []): Promise<T> {
        const worker = this.ensureWorker();
        const id = ++this.seq;
        this.beginCall();
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => { this.endCall(); resolve(value as T); },
                reject: (reason) => { this.endCall(); reject(reason); },
            });
            worker.postMessage({ id, type, payload }, transfer);
        });
    }

    private beginCall(): void {
        this.inflight += 1;
        if (this.inflight === 1) this.onBusyChange?.(true);
    }

    private endCall(): void {
        this.inflight = Math.max(0, this.inflight - 1);
        if (this.inflight === 0) this.onBusyChange?.(false);
    }

    public async init(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.call<void>('init', null).catch((error) => {
                this.initPromise = null;
                throw error;
            });
        }
        await this.initPromise;
    }

    /** Transfer the splat bytes to the worker once; reuse for subsequent ops. */
    private async ensureLoaded(data: Uint8Array): Promise<void> {
        if (this.activeData === data) return;
        // Copy so the caller's array stays usable, then transfer the copy.
        const buffer = data.slice().buffer;
        await this.call<void>('loadSplat', { data: buffer }, [buffer]);
        this.activeData = data;
    }

    public async getSplatBounds(data: Uint8Array, settings: MeshSettings): Promise<SplatBounds> {
        await this.ensureLoaded(data);
        return this.call<SplatBounds>('getSplatBounds', { settings });
    }

    public async suggestRegion(data: Uint8Array, settings: MeshSettings): Promise<SuggestedRegion> {
        await this.ensureLoaded(data);
        return this.call<SuggestedRegion>('suggestRegion', { settings });
    }

    public async convertSplatToMesh(data: Uint8Array, settings: MeshSettings): Promise<ReconstructionResult> {
        await this.ensureLoaded(data);
        return this.call<ReconstructionResult>('convertSplatToMesh', { settings });
    }

    public async convertSplatToNavmeshBasis(data: Uint8Array, settings: MeshSettings): Promise<NavmeshBasisResult> {
        await this.ensureLoaded(data);
        return this.call<NavmeshBasisResult>('convertSplatToNavmeshBasis', { settings });
    }

    public async buildCollisionVoxelBoundary(data: Uint8Array, settings: CollisionVoxelBoundarySettings): Promise<CollisionVoxelBoundaryResult> {
        await this.ensureLoaded(data);
        return this.call<CollisionVoxelBoundaryResult>('buildCollisionVoxelBoundary', { settings });
    }

    public async buildWalkableGroundField(data: Uint8Array, settings: MeshSettings): Promise<WalkableGroundFieldResult> {
        await this.ensureLoaded(data);
        return this.call<WalkableGroundFieldResult>('buildWalkableGroundField', { settings });
    }

    /**
     * Extract a triangulated room-floor mesh entirely in WASM (the binary-side
     * equivalent of the TypeScript FAST NAV floor path). Rejects with the failure
     * reason in the message (`no_component` / `too_small` / `empty_mesh`).
     */
    public async buildRoomFloorMesh(data: Uint8Array, settings: RoomFloorSettings): Promise<RoomFloorMeshResult> {
        await this.ensureLoaded(data);
        return this.call<RoomFloorMeshResult>('buildRoomFloorMesh', { settings });
    }

    /**
     * Serialize a positions + indices triangle mesh into minimal GLB bytes via the
     * WASM glTF writer (no 3D engine needed). Caller arrays are copied, not detached.
     */
    public async meshToGlb(positions: Float32Array, indices: Uint32Array): Promise<Uint8Array> {
        const positionsBuffer = positions.slice().buffer;
        const indicesBuffer = indices.slice().buffer;
        return this.call<Uint8Array>(
            'meshToGlb',
            { positions: positionsBuffer, indices: indicesBuffer },
            [positionsBuffer, indicesBuffer]
        );
    }

    /**
     * Slice a splat into a streamed-SOG bundle (`lod-meta.json` + per-chunk SOG
     * datasets with lossless WebP planes). Returns the universal path-keyed file
     * map; wrap it in {@link SliceArchive} for download / streaming.
     */
    public async sliceSplat(data: Uint8Array, settings: SliceSettings = {}): Promise<SliceResult> {
        await this.ensureLoaded(data);
        const raw = await this.call<SliceResultRaw>('sliceSplat', { settings });
        return this.toSliceResult(raw);
    }

    /**
     * Convert a splat into a single (non-LOD) SOG v2 bundle (`meta.json` + WebP
     * planes). Returns the universal path-keyed file map.
     */
    public async convertToSog(data: Uint8Array, settings: SliceSettings = {}): Promise<SliceResult> {
        await this.ensureLoaded(data);
        const raw = await this.call<SliceResultRaw>('convertToSog', { settings });
        return this.toSliceResult(raw);
    }

    /**
     * Convert a `.spz` (or `.ply`) splat to a full-fidelity binary `.ply`.
     * Used to normalize `.spz` input to PLY for the viewer + nav pipeline.
     */
    public async spzToPly(data: Uint8Array): Promise<Uint8Array> {
        await this.ensureLoaded(data);
        return this.call<Uint8Array>('spzToPly', {});
    }

    /**
     * Convert an antimatter15 `.splat` buffer to a full-fidelity binary `.ply`.
     * Used to normalize `.splat` input to PLY for the viewer + nav pipeline.
     */
    public async splatToPly(data: Uint8Array): Promise<Uint8Array> {
        await this.ensureLoaded(data);
        return this.call<Uint8Array>('splatToPly', {});
    }

    private toSliceResult(raw: SliceResultRaw): SliceResult {
        return {
            files: new Map(raw.files),
            lodMetaPath: raw.lodMetaPath,
            splatCount: raw.splatCount,
            chunkCount: raw.chunkCount,
        };
    }
}

export const splatwalk = SplatWalkBridge.getInstance();
