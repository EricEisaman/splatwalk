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
    PointerEventTypes,
} from '@babylonjs/core';
import '@babylonjs/loaders'; // Import loaders (OBJ, GLTF, STL)
import { GLTF2Export } from '@babylonjs/serializers/glTF';
import { Crowd, NavMesh as RecastNavMesh, init as initRecast, importNavMesh, CrowdAgent } from 'recast-navigation';

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
    private rotation: { x: number, y: number, z: number } = { x: 0, y: 0, z: 0 };

    public async loadGaussianSplat(file: File): Promise<void> {
        try {
            // Clear existing meshes
            while (this.scene.meshes.length > 0) {
                this.scene.meshes[0].dispose();
            }

            // Reset rotation
            this.rotation = { x: 0, y: 0, z: 0 };
            this.splatMesh = null;

            // BabylonJS 7+ supports loading .ply and .spz directly via SceneLoader if correct loaders are imported
            // We can use the file object directly
            const result = await SceneLoader.ImportMeshAsync("", "", file, this.scene);

            if (result.meshes.length > 0) {
                // Usually the first mesh is the root or the splat
                this.splatMesh = result.meshes[0];

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

    private crowd: Crowd | null = null;
    private recastNavMesh: RecastNavMesh | null = null;
    private npcAgents: CrowdAgent[] = [];
    private userAgent: CrowdAgent | null = null;
    private userMesh: AbstractMesh | null = null;
    private npcMeshes: AbstractMesh[] = [];

    public async displayNavMesh(positions: Float32Array, indices: Uint32Array): Promise<void> {
        const name = "navmesh_debug";
        const old = this.scene.getMeshByName(name);
        if (old) old.dispose();

        const mesh = new Mesh(name, this.scene);
        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.applyToMesh(mesh);

        const mat = new StandardMaterial("navmesh_mat", this.scene);
        mat.diffuseColor = new Color3(0, 1, 0);
        mat.alpha = 0.3;
        mat.backFaceCulling = false;
        mesh.material = mat;
        mesh.isPickable = true;

        console.log("[Viewer] Navmesh visualized");
    }

    public async initCrowd(navMeshData: Uint8Array): Promise<void> {
        await initRecast();

        if (this.recastNavMesh) this.recastNavMesh.destroy();
        if (this.crowd) this.crowd.destroy();

        const { navMesh } = importNavMesh(navMeshData);
        this.recastNavMesh = navMesh;

        this.crowd = new Crowd(this.recastNavMesh, {
            maxAgents: 100,
            maxAgentRadius: 1.0
        });

        // Setup user agent
        this.userAgent = this.crowd.addAgent(new Vector3(0, 0, 0), {
            radius: 0.5,
            height: 2.0,
            maxAcceleration: 20.0,
            maxSpeed: 5.0,
        });

        if (this.userMesh) this.userMesh.dispose();
        this.userMesh = Mesh.CreateBox("user_agent", 0.5, this.scene);
        const userMat = new StandardMaterial("user_mat", this.scene);
        userMat.diffuseColor = new Color3(0, 0, 1);
        this.userMesh.material = userMat;

        // Register pointer click for movement
        this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type === PointerEventTypes.POINTERTAP) {
                const pickResult = pointerInfo.pickInfo;
                if (pickResult?.hit && pickResult.pickedPoint && this.userAgent) {
                    this.userAgent.requestMoveTarget(pickResult.pickedPoint);
                }
            }
        });

        // Update loop for crowd
        this.scene.onBeforeRenderObservable.add(() => {
            if (this.crowd) {
                const delta = this.engine.getDeltaTime() / 1000;
                this.crowd.update(delta);

                // Sync user mesh
                if (this.userMesh && this.userAgent) {
                    const pos = this.userAgent.position();
                    this.userMesh.position.set(pos.x, pos.y, pos.z);
                }

                // Sync NPC meshes
                for (let i = 0; i < this.npcMeshes.length; i++) {
                    const agent = this.npcAgents[i];
                    if (agent) {
                        const pos = agent.position();
                        this.npcMeshes[i].position.set(pos.x, pos.y, pos.z);
                    }
                }
            }
        });

        console.log("[Viewer] Crowd simulation initialized");
    }

    public addNPC(): void {
        if (!this.crowd || !this.recastNavMesh) {
            console.warn("Crowd not initialized");
            return;
        }

        // Add agent at camera target
        const pos = this.camera.target.clone();
        const agent = this.crowd.addAgent(pos, {
            radius: 0.5,
            height: 2.0,
            maxAcceleration: 10.0,
            maxSpeed: 3.0,
        });

        const npc = Mesh.CreateSphere(`npc_${agent.agentIndex}`, 16, 0.5, this.scene);
        const mat = new StandardMaterial(`npc_mat_${agent.agentIndex}`, this.scene);
        mat.diffuseColor = Color3.Random();
        npc.material = mat;

        this.npcAgents.push(agent);
        this.npcMeshes.push(npc);

        console.log(`[Viewer] NPC added at index ${agent.agentIndex}`);
    }

    public getScene(): Scene {
        return this.scene;
    }
}
