import {
    Engine,
    Scene,
    ArcRotateCamera,
    Vector3,
    HemisphericLight,
    Color3,
    SceneLoader,
    AbstractMesh,
} from '@babylonjs/core';
import '@babylonjs/loaders'; // Import loaders (OBJ, GLTF, STL)
import { GLTF2Export } from '@babylonjs/serializers/glTF';

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

    public getScene(): Scene {
        return this.scene;
    }
}
