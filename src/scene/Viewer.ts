import {
    Engine,
    Scene,
    ArcRotateCamera,
    Vector3,
    HemisphericLight,
    Color3,
    SceneLoader,
    AbstractMesh,
    Mesh,
    VertexData,
    StandardMaterial,
    Material,
    PointerEventTypes,
    GizmoManager,
    DynamicTexture,
} from '@babylonjs/core';
import '@babylonjs/loaders'; // Import loaders (OBJ, GLTF, STL)
import { GLTF2Export } from '@babylonjs/serializers/glTF';
import { Crowd, NavMesh as RecastNavMesh, init as initRecast, importNavMesh, CrowdAgent } from 'recast-navigation';
import type { GroundFieldCellState, WalkableGroundFieldResult } from '../wasm/bridge';

export class Viewer {
    private engine: Engine;
    private scene: Scene;
    private camera: ArcRotateCamera;

    constructor(canvas: HTMLCanvasElement) {
        this.engine = new Engine(canvas, true);
        this.scene = this.createScene();
        this.camera = this.createCamera();
        this.createLights();

        // Initial dummy mesh
        // this.createDummyMesh();

        // Start render loop
        this.engine.runRenderLoop(() => {
            this.scene.render();
        });

        // Handle resize
        window.addEventListener('resize', () => {
            this.engine.resize();
        });
    }

    public resize(): void {
        this.engine.resize();
    }

    private createScene(): Scene {
        const scene = new Scene(this.engine);
        scene.clearColor = new Color3(0.1, 0.1, 0.1).toColor4();
        return scene;
    }

    private createCamera(): ArcRotateCamera {
        const camera = new ArcRotateCamera(
            'camera',
            -Math.PI / 2,
            Math.PI / 2.5,
            10,
            Vector3.Zero(),
            this.scene
        );
        camera.attachControl(this.engine.getRenderingCanvas(), true);
        camera.wheelPrecision = 50;
        return camera;
    }

    private createLights(): void {
        const light = new HemisphericLight('light', new Vector3(0, 1, 0), this.scene);
        light.intensity = 0.7;
    }


    private splatMesh: AbstractMesh | null = null;
    private splatMeshes: AbstractMesh[] = [];
    private rotation: { x: number, y: number, z: number } = { x: 0, y: 0, z: 0 };

    /**
     * Visualize a splat from full-fidelity binary 3DGS PLY bytes. Non-PLY formats
     * (`.spz`, `.splat`) are normalized to PLY upstream (see `@/wasm/normalize`),
     * so Babylon only ever drives its PLY loader here. This avoids Babylon's `.spz`
     * loader, which fetches a third-party decoder from a CDN at runtime (blocked by
     * the app CSP), and keeps splat orientation consistent across input formats.
     */
    public async loadGaussianSplat(plyBytes: Uint8Array): Promise<void> {
        try {
            this.disableRegionSelection();
            this.clearGroundFieldOverlay();
            this.resetDerivedSceneState();

            // Clear remaining meshes (splat and any stragglers)
            while (this.scene.meshes.length > 0) {
                this.scene.meshes[0].dispose();
            }

            // Reset rotation
            this.rotation = { x: 0, y: 0, z: 0 };
            this.splatMesh = null;
            this.splatMeshes = [];

            // Always load PLY: the normalized bytes are wrapped as a `.ply` File so
            // Babylon selects its PLY loader (no CDN-backed loaders involved).
            const plyFile = new File([plyBytes as BlobPart], 'scene.ply', { type: 'application/octet-stream' });
            const result = await SceneLoader.ImportMeshAsync("", "", plyFile, this.scene);

            if (result.meshes.length > 0) {
                // Usually the first mesh is the root or the splat
                this.splatMesh = result.meshes[0];
                this.splatMeshes = result.meshes;

                // Auto-focus the camera
                const worldExtends = this.scene.getWorldExtends();
                const center = worldExtends.min.add(worldExtends.max).scale(0.5);
                const radius = worldExtends.max.subtract(worldExtends.min).length() / 2;

                this.camera.setTarget(center);
                this.camera.radius = radius * 2.0;
            }

        } catch (e) {
            console.error("Failed to visualize splat:", e);
            // Non-blocking error - we still want to proceed with conversion
        }
    }

    /**
     * Gaussian-splat loaders import with a negative Y scale (Y-down source convention),
     * so the rendered splat lives in a Y-flipped world relative to the raw PLY/SPZ data
     * that WASM parses. Report that flip so the navmesh pipeline can match render space.
     */
    public isSplatYFlipped(): boolean {
        const mesh = this.splatMesh;
        if (!mesh) return false;
        mesh.computeWorldMatrix(true);
        return (mesh.scaling?.y ?? 1) < 0;
    }

    public rotateSplat(axis: 'x' | 'y' | 'z'): void {
        if (!this.splatMesh) {
            console.warn("No splat mesh to rotate");
            return;
        }

        // Increment rotation state (conceptual 90 degrees)
        this.rotation[axis] += Math.PI / 2;

        // Apply to mesh
        this.splatMesh.rotation[axis] += Math.PI / 2;

        console.log(`Rotated ${axis} by 90deg. Current:`, this.rotation);
    }

    public getSplatRotation(): { x: number, y: number, z: number } {
        return { ...this.rotation };
    }

    public async loadMesh(data: Uint8Array | ArrayBuffer | string, extension: string = '.glb'): Promise<void> {
        try {
            // Clear existing meshes
            while (this.scene.meshes.length > 0) {
                this.scene.meshes[0].dispose();
            }

            if (typeof data === 'string') {
                await SceneLoader.AppendAsync('', data, this.scene);
            } else {
                await SceneLoader.AppendAsync('', data as any, this.scene, undefined, extension);
            }
        } catch (e) {
            console.error("Failed to load mesh", e);
            throw e;
        }
    }

    public async exportGLB(filename: string): Promise<void> {
        try {
            const glb = await GLTF2Export.GLBAsync(this.scene, filename, {
                shouldExportNode: (node: any) => {
                    return node.name === "custom_mesh";
                }
            });
            glb.downloadFiles();
        } catch (e) {
            console.error("Export failed", e);
            throw e;
        }
    }

    public focusOnMesh(mesh: AbstractMesh): void {
        const boundingInfo = mesh.getBoundingInfo();
        const center = boundingInfo.boundingBox.centerWorld;
        const radius = boundingInfo.boundingSphere.radiusWorld;

        this.camera.setTarget(center);
        this.camera.radius = radius * 3.0; // Zoom out to fit
        this.camera.alpha = Math.PI / 4;
        this.camera.beta = Math.PI / 3;
    }

    // Place the camera directly above the player agent looking straight down,
    // at a vertical offset derived from the player height and the room ceiling,
    // so the player is always clearly visible on the navmesh floor without the
    // surrounding splat walls occluding the view. The camera sits just below the
    // ceiling (clamped to a sensible range) which gives definitive proof of the
    // player resting on the ground. Returns details, or null if no player exists.
    public focusOnPlayer(): {
        player: [number, number, number];
        cameraHeight: number;
        ceilingY: number;
        floorY: number;
    } | null {
        if (!this.userMesh) {
            return null;
        }
        const position = this.userMesh.getAbsolutePosition();

        // Player vertical extent (agent box is ~0.5m; its center is `position`).
        const playerBounds = this.userMesh.getHierarchyBoundingVectors(true);
        const playerTopY = playerBounds.max.y;
        const playerBottomY = playerBounds.min.y;
        const playerHeight = Math.max(0.5, playerTopY - playerBottomY);

        // Room ceiling from the splat bounds; fall back to scene extents.
        let ceilingY = Number.NEGATIVE_INFINITY;
        const splatTargets = [this.splatMesh, ...this.splatMeshes].filter(Boolean) as AbstractMesh[];
        for (const mesh of splatTargets) {
            const b = mesh.getHierarchyBoundingVectors(true);
            ceilingY = Math.max(ceilingY, b.max.y);
        }
        if (!Number.isFinite(ceilingY)) {
            ceilingY = this.scene.getWorldExtends().max.y;
        }

        // Sit just below the ceiling, always at least one player-height above the
        // player's head, and clamp the offset so the player stays clearly framed.
        const ceilingMargin = 0.15;
        const minOffset = playerHeight; // never closer than one player height above the head
        const maxOffset = 4.0;          // avoid tiny players in very tall/outdoor scenes
        const offsetToCeiling = (ceilingY - ceilingMargin) - playerTopY;
        const offset = Math.min(maxOffset, Math.max(minOffset, offsetToCeiling));
        const cameraHeight = playerTopY + offset;

        this.camera.setTarget(position.clone());
        // beta near 0 places the camera on the +Y axis above the target looking down.
        this.camera.beta = 0.0001;
        this.camera.radius = cameraHeight - position.y;
        this.scene.render();

        return {
            player: [position.x, position.y, position.z],
            cameraHeight,
            ceilingY,
            floorY: playerBottomY,
        };
    }

    private crowd: Crowd | null = null;
    private recastNavMesh: RecastNavMesh | null = null;
    private npcAgents: CrowdAgent[] = [];
    private userAgent: CrowdAgent | null = null;
    private userMesh: AbstractMesh | null = null;
    private npcMeshes: AbstractMesh[] = [];
    private navMeshDebugMesh: Mesh | null = null;
    private navMeshMaterial: StandardMaterial | null = null;
    private navMeshVisualOffset: Vector3 = Vector3.Zero();
    private navMeshSpawnPoint: Vector3 | null = null;
    private pointerObserver: any = null;
    private crowdUpdateObserver: any = null;
    private selectionMesh: Mesh | null = null;
    private gizmoManager: GizmoManager | null = null;
    private groundFieldOverlayMeshes: Mesh[] = [];
    private colliderMeshes: AbstractMesh[] = [];
    private colliderMaterial: StandardMaterial | null = null;
    private seedMarker: Mesh | null = null;
    private markerLabels: Mesh[] = [];
    private preferredPlayerSpawn: Vector3 | null = null;
    private preferredNpcSpawn: Vector3 | null = null;

    private getLoadedSplatBounds(): { min: Vector3, max: Vector3 } | null {
        if (!this.splatMesh && this.splatMeshes.length === 0) return null;

        const meshes = new Set<AbstractMesh>();

        if (this.splatMesh) {
            meshes.add(this.splatMesh);
            for (const child of this.splatMesh.getChildMeshes(false)) {
                meshes.add(child);
            }
        }

        for (const mesh of this.splatMeshes) {
            meshes.add(mesh);
            for (const child of mesh.getChildMeshes(false)) {
                meshes.add(child);
            }
        }

        let min: Vector3 | null = null;
        let max: Vector3 | null = null;

        for (const mesh of meshes) {
            try {
                if (mesh.getTotalVertices() === 0) {
                    continue;
                }

                mesh.computeWorldMatrix(true);
                const boundingBox = mesh.getBoundingInfo().boundingBox;
                const meshMin = boundingBox.minimumWorld;
                const meshMax = boundingBox.maximumWorld;
                const values = [meshMin.x, meshMin.y, meshMin.z, meshMax.x, meshMax.y, meshMax.z];

                if (!values.every(Number.isFinite)) {
                    continue;
                }

                min = min ? Vector3.Minimize(min, meshMin) : meshMin.clone();
                max = max ? Vector3.Maximize(max, meshMax) : meshMax.clone();
            } catch (error) {
                console.warn(`[Viewer] Skipping mesh with unavailable bounds: ${mesh.name}`, error);
            }
        }

        if (!min || !max || max.x < min.x || max.y < min.y || max.z < min.z) {
            return null;
        }

        return { min, max };
    }

    public enableRegionSelection(region?: { min: number[], max: number[] }): void {
        const scene = this.scene;

        if (!this.selectionMesh) {
            this.selectionMesh = Mesh.CreateBox("selection_region", 1, scene);

            const mat = new StandardMaterial("selection_mat", scene);
            mat.diffuseColor = new Color3(1, 1, 0); // Yellow
            mat.alpha = 0.2;
            mat.backFaceCulling = false;
            this.selectionMesh.material = mat;
            this.selectionMesh.isPickable = true;
        }

        const bounds = region ? {
            min: new Vector3(region.min[0], region.min[1], region.min[2]),
            max: new Vector3(region.max[0], region.max[1], region.max[2]),
        } : this.getLoadedSplatBounds();

        if (bounds) {
            const minFootprintMeters = 0.1;
            const sizeX = Math.max(bounds.max.x - bounds.min.x, minFootprintMeters);
            const sizeZ = Math.max(bounds.max.z - bounds.min.z, minFootprintMeters);
            const sizeY = Math.max(bounds.max.y - bounds.min.y, minFootprintMeters);

            this.selectionMesh.scaling.set(sizeX, sizeY, sizeZ);
            this.selectionMesh.position.set(
                (bounds.min.x + bounds.max.x) / 2,
                bounds.min.y + sizeY / 2,
                (bounds.min.z + bounds.max.z) / 2
            );

            console.log(
                `[Viewer] Region selector auto-fit to splat bounds ` +
                `min=${bounds.min.toString()} max=${bounds.max.toString()} size=${this.selectionMesh.scaling.toString()}`
            );
        } else {
            this.selectionMesh.scaling.set(5, 0.5, 5);
            this.selectionMesh.position.copyFrom(this.camera.target);
            console.warn("[Viewer] Could not determine splat bounds. Region selector placed at camera target.");
        }

        // Setup Gizmos
        if (!this.gizmoManager) {
            this.gizmoManager = new GizmoManager(scene);
        }
        this.gizmoManager.positionGizmoEnabled = true;
        this.gizmoManager.scaleGizmoEnabled = true;
        this.gizmoManager.attachableMeshes = [this.selectionMesh];
        this.gizmoManager.attachToMesh(this.selectionMesh);

        console.log("[Viewer] Region selection enabled");
    }

    public disableRegionSelection(): void {
        const hadRegionSelection = Boolean(this.gizmoManager || this.selectionMesh);

        if (this.gizmoManager) {
            this.gizmoManager.dispose();
            this.gizmoManager = null;
        }
        if (this.selectionMesh) {
            this.selectionMesh.dispose();
            this.selectionMesh = null;
        }
        if (hadRegionSelection) {
            console.log("[Viewer] Region selection disabled");
        }
    }

    public getRegionBounds(): { min: number[], max: number[] } | null {
        if (!this.selectionMesh) return null;

        this.selectionMesh.computeWorldMatrix(true);
        const boundingBox = this.selectionMesh.getBoundingInfo().boundingBox;
        const min = boundingBox.minimumWorld;
        const max = boundingBox.maximumWorld;

        return {
            min: [min.x, min.y, min.z],
            max: [max.x, max.y, max.z]
        };
    }

    public async loadColliderMesh(file: File, opacity = 0.35): Promise<{ positions: Float32Array, indices: Uint32Array }> {
        this.clearColliderMesh();
        const result = await SceneLoader.ImportMeshAsync("", "", file, this.scene);
        this.colliderMeshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
        if (this.colliderMeshes.length === 0) {
            throw new Error("Imported collider GLB has no usable mesh geometry.");
        }

        this.colliderMaterial = new StandardMaterial("collider_mesh_mat", this.scene);
        this.colliderMaterial.diffuseColor = new Color3(0.0, 0.85, 1.0);
        this.applyAlphaOpacity(this.colliderMaterial, opacity);
        this.colliderMaterial.backFaceCulling = false;

        for (const mesh of this.colliderMeshes) {
            mesh.material = this.colliderMaterial;
            mesh.isPickable = false;
        }

        const geometry = this.getColliderMeshBuffers();
        const bounds = this.getColliderBounds();
        console.log(
            `[Viewer] Collider GLB imported: ${geometry.positions.length / 3} vertices, ` +
            `${geometry.indices.length / 3} triangles` +
            (bounds ? `, bounds min=${bounds.min.toString()} max=${bounds.max.toString()}` : "")
        );
        return geometry;
    }

    public displayColliderMesh(positions: Float32Array | number[], indices: Uint32Array | number[], opacity = 0.35): void {
        this.clearColliderMesh();
        const mesh = new Mesh("collider_mesh_generated", this.scene);
        const vertexData = new VertexData();
        vertexData.positions = Array.from(positions);
        vertexData.indices = Array.from(indices);
        vertexData.applyToMesh(mesh);

        this.colliderMaterial = new StandardMaterial("collider_mesh_mat", this.scene);
        this.colliderMaterial.diffuseColor = new Color3(0.0, 0.85, 1.0);
        this.applyAlphaOpacity(this.colliderMaterial, opacity);
        this.colliderMaterial.backFaceCulling = false;
        mesh.material = this.colliderMaterial;
        mesh.isPickable = false;
        this.colliderMeshes = [mesh];
    }

    public clearColliderMesh(): void {
        for (const mesh of this.colliderMeshes) {
            mesh.dispose();
        }
        this.colliderMeshes = [];
        if (this.colliderMaterial) {
            this.colliderMaterial.dispose();
            this.colliderMaterial = null;
        }
    }

    public setColliderVisible(visible: boolean): void {
        for (const mesh of this.colliderMeshes) {
            mesh.setEnabled(visible);
        }
    }

    public setColliderOpacity(opacity: number): void {
        if (this.colliderMaterial) {
            this.applyAlphaOpacity(this.colliderMaterial, opacity);
        }
    }

    public setNavMeshVisible(visible: boolean): void {
        this.navMeshDebugMesh?.setEnabled(visible);
    }

    public setNavMeshOpacity(opacity: number): void {
        if (this.navMeshMaterial) {
            this.applyAlphaOpacity(this.navMeshMaterial, opacity);
        }
    }

    private applyAlphaOpacity(material: StandardMaterial, alpha: number): void {
        material.alpha = alpha;
        material.transparencyMode = alpha < 1 ? Material.MATERIAL_ALPHABLEND : Material.MATERIAL_OPAQUE;
    }

    public getColliderBounds(): { min: Vector3, max: Vector3 } | null {
        if (this.colliderMeshes.length === 0) return null;
        let min: Vector3 | null = null;
        let max: Vector3 | null = null;

        for (const mesh of this.colliderMeshes) {
            if (mesh.getTotalVertices() === 0) continue;
            mesh.computeWorldMatrix(true);
            const box = mesh.getBoundingInfo().boundingBox;
            min = min ? Vector3.Minimize(min, box.minimumWorld) : box.minimumWorld.clone();
            max = max ? Vector3.Maximize(max, box.maximumWorld) : box.maximumWorld.clone();
        }

        return min && max ? { min, max } : null;
    }

    public getSplatBoundsForDiagnostics(): { min: Vector3, max: Vector3 } | null {
        return this.getLoadedSplatBounds();
    }

    public getColliderMeshBuffers(): { positions: Float32Array, indices: Uint32Array } {
        const positions: number[] = [];
        const indices: number[] = [];

        for (const mesh of this.colliderMeshes) {
            const sourcePositions = mesh.getVerticesData("position");
            if (!sourcePositions || sourcePositions.length === 0) {
                continue;
            }

            mesh.computeWorldMatrix(true);
            const world = mesh.getWorldMatrix();
            const base = positions.length / 3;

            for (let i = 0; i < sourcePositions.length; i += 3) {
                const p = Vector3.TransformCoordinates(
                    new Vector3(sourcePositions[i], sourcePositions[i + 1], sourcePositions[i + 2]),
                    world
                );
                positions.push(p.x, p.y, p.z);
            }

            const sourceIndices = mesh.getIndices();
            if (sourceIndices && sourceIndices.length > 0) {
                for (const index of sourceIndices) {
                    indices.push(base + index);
                }
            } else {
                for (let i = 0; i + 2 < sourcePositions.length / 3; i += 3) {
                    indices.push(base + i, base + i + 1, base + i + 2);
                }
            }
        }

        if (positions.length === 0 || indices.length === 0) {
            throw new Error("Collider mesh has no triangulated geometry for Recast.");
        }

        return {
            positions: new Float32Array(positions),
            indices: new Uint32Array(indices),
        };
    }

    public displaySeedMarker(seed: [number, number, number] | number[]): void {
        if (this.seedMarker) {
            this.seedMarker.dispose();
            this.seedMarker = null;
        }

        this.seedMarker = Mesh.CreateSphere("collision_seed_marker", 16, 0.25, this.scene);
        this.seedMarker.position.set(seed[0], seed[1], seed[2]);
        const mat = new StandardMaterial("collision_seed_marker_mat", this.scene);
        mat.diffuseColor = new Color3(1.0, 0.0, 1.0);
        mat.emissiveColor = new Color3(0.5, 0.0, 0.5);
        this.seedMarker.material = mat;
        this.seedMarker.isPickable = false;
        this.attachMarkerLabel(this.seedMarker, "SEED", new Color3(1.0, 0.0, 1.0));
        console.log(`[INFO] Seed marker placed at ${seed.map((v) => Number(v).toFixed(3)).join(', ')}`);
    }

    public setPreferredNavSpawnPoints(player: [number, number, number] | number[] | null, npc?: [number, number, number] | number[] | null): void {
        this.preferredPlayerSpawn = player ? Vector3.FromArray(player) : null;
        this.preferredNpcSpawn = npc ? Vector3.FromArray(npc) : null;
    }

    private attachMarkerLabel(mesh: AbstractMesh, text: string, color: Color3): void {
        const label = Mesh.CreatePlane(`${mesh.name}_label`, 0.8, this.scene);
        const texture = new DynamicTexture(`${mesh.name}_label_texture`, { width: 256, height: 96 }, this.scene, true);
        texture.hasAlpha = true;
        texture.drawText(text, null, 58, "bold 44px Arial", color.toHexString(), "transparent", true);

        const material = new StandardMaterial(`${mesh.name}_label_mat`, this.scene);
        material.diffuseTexture = texture;
        material.emissiveColor = color;
        material.opacityTexture = texture;
        material.backFaceCulling = false;
        label.material = material;
        label.billboardMode = Mesh.BILLBOARDMODE_ALL;
        label.isPickable = false;
        label.parent = mesh;
        label.position.set(0, 0.9, 0);
        this.markerLabels.push(label);
    }

    public async displayNavMesh(positions: Float32Array, indices: Uint32Array, visualOffsetY = 0): Promise<Vector3 | null> {
        this.clearNavMeshOverlay();

        const mesh = new Mesh("navmesh_debug", this.scene);
        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.applyToMesh(mesh);
        mesh.position.y = visualOffsetY;

        const mat = new StandardMaterial("navmesh_mat", this.scene);
        mat.diffuseColor = new Color3(0, 1, 0);
        this.applyAlphaOpacity(mat, 0.55);
        mat.backFaceCulling = false;
        mesh.material = mat;
        mesh.isPickable = true;

        this.navMeshDebugMesh = mesh;
        this.navMeshMaterial = mat;
        this.navMeshVisualOffset = new Vector3(0, visualOffsetY, 0);
        this.navMeshSpawnPoint = this.getMostInteriorNavMeshPoint(positions, indices)
            ?? this.getFirstNavMeshPoint(positions, indices);

        console.log(`[Viewer] Navmesh visualized${visualOffsetY !== 0 ? ` with Y offset ${visualOffsetY.toFixed(3)}` : ""}`);
        return this.navMeshSpawnPoint?.clone() ?? null;
    }

    public displayGroundFieldOverlay(fieldResult: WalkableGroundFieldResult, visibleStates: Set<GroundFieldCellState>): void {
        this.clearGroundFieldOverlay();

        if (visibleStates.size === 0 || fieldResult.width === 0 || fieldResult.height === 0) {
            return;
        }

        const origin = Vector3.FromArray(fieldResult.basis.origin);
        const tangent = Vector3.FromArray(fieldResult.basis.tangent);
        const bitangent = Vector3.FromArray(fieldResult.basis.bitangent);
        const up = Vector3.FromArray(fieldResult.basis.up);
        const grouped = new Map<GroundFieldCellState, { positions: number[], indices: number[] }>();

        for (let row = 0; row < fieldResult.height; row++) {
            for (let col = 0; col < fieldResult.width; col++) {
                const idx = row * fieldResult.width + col;
                const cell = fieldResult.cells[idx];
                if (!cell || !visibleStates.has(cell.state)) {
                    continue;
                }

                const group = grouped.get(cell.state) ?? { positions: [], indices: [] };
                grouped.set(cell.state, group);

                const h = Number.isFinite(cell.height) ? cell.height : 0;
                const u0 = col * fieldResult.cell_size;
                const u1 = (col + 1) * fieldResult.cell_size;
                const v0 = row * fieldResult.cell_size;
                const v1 = (row + 1) * fieldResult.cell_size;
                const lift = up.scale(0.015);
                const p00 = origin.add(tangent.scale(u0)).add(bitangent.scale(v0)).add(up.scale(h)).add(lift);
                const p10 = origin.add(tangent.scale(u1)).add(bitangent.scale(v0)).add(up.scale(h)).add(lift);
                const p11 = origin.add(tangent.scale(u1)).add(bitangent.scale(v1)).add(up.scale(h)).add(lift);
                const p01 = origin.add(tangent.scale(u0)).add(bitangent.scale(v1)).add(up.scale(h)).add(lift);
                const base = group.positions.length / 3;

                for (const p of [p00, p10, p11, p01]) {
                    group.positions.push(p.x, p.y, p.z);
                }
                group.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
        }

        for (const [state, buffers] of grouped) {
            if (buffers.positions.length === 0) {
                continue;
            }

            const mesh = new Mesh(`ground_field_${state}`, this.scene);
            const vertexData = new VertexData();
            vertexData.positions = buffers.positions;
            vertexData.indices = buffers.indices;
            vertexData.applyToMesh(mesh);
            mesh.isPickable = false;

            const material = new StandardMaterial(`ground_field_${state}_mat`, this.scene);
            const { color, alpha } = this.getGroundFieldStateStyle(state);
            material.diffuseColor = color;
            material.alpha = alpha;
            material.backFaceCulling = false;
            mesh.material = material;
            this.groundFieldOverlayMeshes.push(mesh);
        }

        console.log(`[Viewer] Ground field overlay rendered for ${visibleStates.size} states.`);
    }

    public clearGroundFieldOverlay(): void {
        for (const mesh of this.groundFieldOverlayMeshes) {
            mesh.dispose();
        }
        this.groundFieldOverlayMeshes = [];
    }

    private getGroundFieldStateStyle(state: GroundFieldCellState): { color: Color3, alpha: number } {
        switch (state) {
            case 'walkable':
                return { color: new Color3(0.0, 0.9, 0.1), alpha: 0.42 };
            case 'filled':
                return { color: new Color3(1.0, 0.85, 0.0), alpha: 0.5 };
            case 'obstacle':
                return { color: new Color3(1.0, 0.0, 0.0), alpha: 0.55 };
            case 'height_variance':
                return { color: new Color3(1.0, 0.45, 0.0), alpha: 0.55 };
            case 'low_confidence':
                return { color: new Color3(0.45, 0.45, 0.45), alpha: 0.35 };
            case 'void':
                return { color: new Color3(0.02, 0.02, 0.02), alpha: 0.25 };
            case 'eroded':
                return { color: new Color3(0.0, 0.25, 1.0), alpha: 0.5 };
            case 'discarded_component':
                return { color: new Color3(0.55, 0.0, 0.9), alpha: 0.48 };
        }
    }

    public async initCrowd(navMeshData: Uint8Array, spawnPoint?: Vector3 | null): Promise<void> {
        await initRecast();

        this.destroyCrowdSimulation();

        const { navMesh } = importNavMesh(navMeshData);
        this.recastNavMesh = navMesh;

        this.crowd = new Crowd(this.recastNavMesh, {
            maxAgents: 100,
            maxAgentRadius: 1.0
        });

        // Setup user agent
        const startPoint = this.preferredPlayerSpawn?.clone() ?? spawnPoint?.clone() ?? this.navMeshSpawnPoint?.clone();
        if (!startPoint) {
            console.warn("[WARN] Cannot initialize crowd: no valid navmesh spawn point.");
            return;
        }

        this.userAgent = this.crowd.addAgent(startPoint, {
            radius: 0.5,
            height: 2.0,
            maxAcceleration: 20.0,
            maxSpeed: 5.0,
        });

        this.userMesh = Mesh.CreateBox("user_agent", 0.5, this.scene);
        const userMat = new StandardMaterial("user_mat", this.scene);
        userMat.diffuseColor = new Color3(0, 0, 1);
        this.userMesh.material = userMat;
        this.attachMarkerLabel(this.userMesh, "PLAYER", new Color3(0.1, 0.5, 1.0));
        this.syncAgentMesh(this.userMesh, this.userAgent);
        console.log(`[INFO] Player agent spawned at ${startPoint.x.toFixed(3)}, ${startPoint.y.toFixed(3)}, ${startPoint.z.toFixed(3)}.`);

        // Register pointer click for movement
        this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type === PointerEventTypes.POINTERTAP) {
                const pickResult = this.scene.pick(
                    this.scene.pointerX,
                    this.scene.pointerY,
                    (mesh) => mesh === this.navMeshDebugMesh
                );
                if (pickResult?.hit && pickResult.pickedPoint && this.userAgent) {
                    const target = pickResult.pickedPoint.subtract(this.navMeshVisualOffset);
                    this.userAgent.requestMoveTarget(target);
                    console.log(`[Viewer] User move target: ${target.toString()}`);
                }
            }
        });

        // Update loop for crowd
        this.crowdUpdateObserver = this.scene.onBeforeRenderObservable.add(() => {
            if (this.crowd) {
                const delta = this.engine.getDeltaTime() / 1000;
                this.crowd.update(delta);

                // Sync user mesh
                if (this.userMesh && this.userAgent) {
                    this.syncAgentMesh(this.userMesh, this.userAgent);
                }

                // Sync NPC meshes
                for (let i = 0; i < this.npcMeshes.length; i++) {
                    const agent = this.npcAgents[i];
                    if (agent) {
                        this.syncAgentMesh(this.npcMeshes[i], agent);
                    }
                }
            }
        });

        console.log("[SUCCESS] Crowd simulation initialized. Click the green navmesh to move the blue player agent.");
    }

    public addNPC(): void {
        if (!this.crowd || !this.recastNavMesh) {
            console.warn("[WARN] Crowd not initialized; generate a navmesh before adding an NPC.");
            return;
        }

        const userPosition = this.userAgent?.position();
        const pos = this.preferredNpcSpawn?.clone()
            ?? (userPosition ? new Vector3(userPosition.x + 1.0, userPosition.y, userPosition.z) : this.navMeshSpawnPoint?.clone());
        if (!pos) {
            console.warn("[WARN] No valid navmesh point available for NPC spawn.");
            return;
        }
        if (userPosition) {
            const dx = pos.x - userPosition.x;
            const dz = pos.z - userPosition.z;
            if (Math.sqrt(dx * dx + dz * dz) < 0.25) {
                console.warn("[WARN] NPC spawn would overlap the player marker, so no NPC was spawned.");
                return;
            }
        }

        const agent = this.crowd.addAgent(pos, {
            radius: 0.5,
            height: 2.0,
            maxAcceleration: 10.0,
            maxSpeed: 3.0,
        });

        const npc = Mesh.CreateSphere(`npc_${agent.agentIndex}`, 16, 0.5, this.scene);
        const mat = new StandardMaterial(`npc_mat_${agent.agentIndex}`, this.scene);
        mat.diffuseColor = new Color3(0.2, 1.0, 0.35);
        mat.emissiveColor = new Color3(0.02, 0.25, 0.05);
        npc.material = mat;
        this.attachMarkerLabel(npc, "NPC", new Color3(0.2, 1.0, 0.35));
        this.syncAgentMesh(npc, agent);

        this.npcAgents.push(agent);
        this.npcMeshes.push(npc);
        this.preferredNpcSpawn = null;

        console.log(`[INFO] NPC spawned at ${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}.`);
    }

    // Pick the navmesh point deepest inside the walkable area (farthest from any
    // boundary edge in the floor plane). This keeps the player off walls/furniture
    // fringes and out in open floor, where it is clearly visible from above.
    private getMostInteriorNavMeshPoint(positions: Float32Array, indices: Uint32Array): Vector3 | null {
        if (indices.length < 3) {
            return null;
        }

        const quant = (value: number) => Math.round(value * 1000);
        const keyOf = (vi: number) => `${quant(positions[vi * 3])},${quant(positions[vi * 3 + 2])}`;

        // Count undirected edges by quantized XZ endpoints; boundary edges occur once.
        const edgeCount = new Map<string, { count: number; ax: number; az: number; bx: number; bz: number }>();
        const addEdge = (a: number, b: number) => {
            const ka = keyOf(a);
            const kb = keyOf(b);
            const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const existing = edgeCount.get(key);
            if (existing) {
                existing.count += 1;
            } else {
                edgeCount.set(key, {
                    count: 1,
                    ax: positions[a * 3], az: positions[a * 3 + 2],
                    bx: positions[b * 3], bz: positions[b * 3 + 2],
                });
            }
        };

        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];
            addEdge(i0, i1);
            addEdge(i1, i2);
            addEdge(i2, i0);
        }

        const boundary: { ax: number; az: number; bx: number; bz: number }[] = [];
        for (const e of edgeCount.values()) {
            if (e.count === 1) {
                boundary.push(e);
            }
        }
        if (boundary.length === 0) {
            return null;
        }

        const distToSegmentXZ = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => {
            const dx = bx - ax;
            const dz = bz - az;
            const lenSq = dx * dx + dz * dz;
            let t = lenSq < 1e-12 ? 0 : ((px - ax) * dx + (pz - az) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const cx = ax + t * dx;
            const cz = az + t * dz;
            return Math.hypot(px - cx, pz - cz);
        };

        let best: Vector3 | null = null;
        let bestClearance = -Infinity;
        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;
            const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
            const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
            const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
            if (![cx, cy, cz].every(Number.isFinite)) {
                continue;
            }

            let clearance = Infinity;
            for (const e of boundary) {
                const d = distToSegmentXZ(cx, cz, e.ax, e.az, e.bx, e.bz);
                if (d < clearance) {
                    clearance = d;
                    if (clearance <= bestClearance) {
                        break;
                    }
                }
            }

            if (clearance > bestClearance) {
                bestClearance = clearance;
                best = new Vector3(cx, cy, cz);
            }
        }

        return best;
    }

    private getFirstNavMeshPoint(positions: Float32Array, indices: Uint32Array): Vector3 | null {
        const isUsablePoint = (point: Vector3): boolean => {
            return [point.x, point.y, point.z].every(Number.isFinite) && point.lengthSquared() > 1e-8;
        };

        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;
            const point = new Vector3(
                (positions[i0] + positions[i1] + positions[i2]) / 3,
                (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3,
                (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3
            );
            if (isUsablePoint(point)) {
                return point;
            }
        }

        for (let i = 0; i + 2 < positions.length; i += 3) {
            const point = new Vector3(positions[i], positions[i + 1], positions[i + 2]);
            if (isUsablePoint(point)) {
                return point;
            }
        }

        return null;
    }

    private syncAgentMesh(mesh: AbstractMesh, agent: CrowdAgent): void {
        const pos = agent.position();
        mesh.position.set(
            pos.x + this.navMeshVisualOffset.x,
            pos.y + this.navMeshVisualOffset.y + 0.25,
            pos.z + this.navMeshVisualOffset.z
        );
    }

    private cleanupCrowdObservers(): void {
        if (this.pointerObserver) {
            this.scene.onPointerObservable.remove(this.pointerObserver);
            this.pointerObserver = null;
        }
        if (this.crowdUpdateObserver) {
            this.scene.onBeforeRenderObservable.remove(this.crowdUpdateObserver);
            this.crowdUpdateObserver = null;
        }
    }

    private destroyCrowdSimulation(): void {
        this.cleanupCrowdObservers();

        if (this.crowd) {
            this.crowd.destroy();
            this.crowd = null;
        }
        if (this.recastNavMesh) {
            this.recastNavMesh.destroy();
            this.recastNavMesh = null;
        }

        this.userAgent = null;
        this.npcAgents = [];

        if (this.userMesh) {
            this.userMesh.dispose();
            this.userMesh = null;
        }
        for (const mesh of this.npcMeshes) {
            mesh.dispose();
        }
        this.npcMeshes = [];

        for (const label of this.markerLabels) {
            if (!label.isDisposed()) {
                label.dispose();
            }
        }
        this.markerLabels = [];
    }

    private resetDerivedSceneState(): void {
        this.destroyCrowdSimulation();

        if (this.seedMarker) {
            this.seedMarker.dispose();
            this.seedMarker = null;
        }

        this.preferredPlayerSpawn = null;
        this.preferredNpcSpawn = null;
        this.clearNavMeshOverlay();
        this.clearColliderMesh();
    }

    private clearNavMeshOverlay(): void {
        if (this.navMeshDebugMesh) {
            this.navMeshDebugMesh.dispose();
            this.navMeshDebugMesh = null;
        }
        const old = this.scene.getMeshByName("navmesh_debug");
        if (old) {
            old.dispose();
        }
        if (this.navMeshMaterial) {
            this.navMeshMaterial.dispose();
            this.navMeshMaterial = null;
        }
        this.navMeshSpawnPoint = null;
        this.navMeshVisualOffset = Vector3.Zero();
    }

    public getScene(): Scene {
        return this.scene;
    }
}
