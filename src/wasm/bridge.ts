import init, { init_splatwalk, convert_splat_to_mesh } from '../../pkg/wasm_splatwalk/wasm_splatwalk.js';

export interface MeshResult {
    vertices: Float32Array;
    indices: Uint32Array;
    vertex_count: number;
    face_count: number;
}

export interface MeshSettings {
    mode: number;
    voxel_target?: number;
    min_alpha?: number;
    max_scale?: number;
    normal_align?: number;
    ransac_thresh?: number;
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

    public convertSplatToMesh(data: Uint8Array, settings: MeshSettings): MeshResult {
        if (!this.isInitialized) {
            throw new Error("SplatWalk WASM not initialized");
        }

        try {
            const result = convert_splat_to_mesh(data, settings);
            return result as MeshResult;
        } catch (e) {
            console.error("Conversion failed in WASM:", e);
            throw e;
        }
    }
}

export const splatwalk = SplatWalkBridge.getInstance();
