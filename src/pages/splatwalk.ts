import { Viewer } from '../scene/Viewer';
import { DropZone } from '../components/DropZone';
import { splatwalk } from '../wasm/bridge';
import { Mesh, VertexData, StandardMaterial, Color3 } from '@babylonjs/core';

async function main() {
    const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    const logDiv = document.getElementById('systemLogsContent') as HTMLDivElement;
    const errorDiv = document.getElementById('error') as HTMLDivElement;

    // Custom Logger
    const originalLog = console.log;
    console.log = (...args) => {
        originalLog(...args);
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        if (logDiv) {
            const entry = document.createElement('div');
            entry.className = 'log-entry';

            // Detect tag
            let tag = "INFO";
            let typeClass = "log-tag-info";
            let content = msg;

            if (msg.startsWith("[INFO]")) {
                content = msg.substring(6).trim();
            } else if (msg.toLowerCase().includes("error") || msg.toLowerCase().includes("failed")) {
                tag = "ERROR";
                typeClass = "log-tag-error";
            } else if (msg.toLowerCase().includes("success") || msg.toLowerCase().includes("complete")) {
                tag = "SUCCESS";
                typeClass = "log-tag-success";
            }

            // Create span for tag
            const tagSpan = document.createElement('span');
            tagSpan.className = `log-tag ${typeClass}`;
            tagSpan.textContent = `[${tag}]`;

            // Create span for message
            const msgSpan = document.createElement('span');
            msgSpan.className = 'log-message';
            msgSpan.textContent = content;

            entry.appendChild(tagSpan);
            entry.appendChild(msgSpan);

            logDiv.appendChild(entry);
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    };

    const logError = (msg: string) => {
        if (errorDiv) {
            errorDiv.textContent = msg;
            errorDiv.style.display = 'block';
        }
        console.error(msg);
    }

    // UI Elements
    const settingsToggle = document.getElementById('settingsToggle');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const controlsContainer = document.getElementById('controlsContainer') as HTMLDivElement;
    const workbenchContainer = document.getElementById('workbenchContainer') as HTMLDivElement;

    // Ensure hidden by default
    if (controlsContainer) {
        controlsContainer.classList.remove('active');
        // Clean up any inline display style from possible previous states/drops
        controlsContainer.style.display = '';
    }

    // Toggle Logic
    const toggleSettings = (show?: boolean) => {
        if (!controlsContainer) return;
        controlsContainer.style.display = ''; // Clear inline if any

        const isActive = controlsContainer.classList.contains('active');
        const shouldShow = show !== undefined ? show : !isActive;

        if (shouldShow) {
            controlsContainer.classList.add('active');
        } else {
            controlsContainer.classList.remove('active');
        }
    };

    if (settingsToggle) settingsToggle.addEventListener('click', () => toggleSettings());

    // Fullscreen Logic
    if (fullscreenBtn && workbenchContainer) {
        fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                workbenchContainer.requestFullscreen().catch(err => {
                    logError(`Error attempting to enable fullscreen: ${err.message}`);
                });
            } else {
                document.exitFullscreen();
            }
        });
    }

    const showMeshCheckbox = document.getElementById('showMesh') as HTMLInputElement;
    const meshOpacitySlider = document.getElementById('meshOpacity') as HTMLInputElement;
    const downloadContainer = document.getElementById('downloadContainer');
    const downloadBtn = document.getElementById('downloadBtn');

    // UI Event Listeners placeholder (will be attached to mesh once created)
    let currentMesh: Mesh | null = null;
    let currentMat: StandardMaterial | null = null;

    if (showMeshCheckbox) {
        showMeshCheckbox.addEventListener('change', () => {
            if (currentMesh) currentMesh.setEnabled(showMeshCheckbox.checked);
        });
    }

    if (meshOpacitySlider) {
        meshOpacitySlider.addEventListener('input', () => {
            if (currentMat) currentMat.alpha = parseFloat(meshOpacitySlider.value);
        });
    }

    try {
        console.log("Initializing SplatWalk...");

        // Init WASM
        await splatwalk.init();

        // Init Viewer
        const viewer = new Viewer(canvas);

        // Resize handling for Fullscreen
        document.addEventListener('fullscreenchange', () => {
            // Small delay to ensure browser layout is updated
            setTimeout(() => viewer.resize(), 50);
        });

        // Init DropZone
        // Init DropZone
        const dropZone = new DropZone('renderCanvas', async (file: File) => {
            console.log(`File dropped: ${file.name} (${file.size} bytes)`);

            if (!file.name.endsWith('.ply') && !file.name.endsWith('.spz')) {
                logError("Only .ply and .spz files are supported.");
                return;
            }

            errorDiv.style.display = 'none';
            document.getElementById('resultSection')!.style.display = 'none';
            document.getElementById('setupSection')!.style.display = 'block';

            // Open settings on drop (this adds .active class)
            toggleSettings(true);

            console.log("Processing file...");

            // 1. Visualize input splat
            await viewer.loadGaussianSplat(file);
            console.log("Input splat visualized. Ready for setup.");

            // 2. Attach Rotation Listeners
            const attachRotListener = (id: string, axis: 'x' | 'y' | 'z') => {
                const oldBtn = document.getElementById(id);
                if (oldBtn) {
                    const newBtn = oldBtn.cloneNode(true) as HTMLButtonElement;
                    oldBtn.parentNode?.replaceChild(newBtn, oldBtn);
                    newBtn.addEventListener('click', () => {
                        console.log(`[UI] Rotation ${axis} clicked`);
                        viewer.rotateSplat(axis);
                    });
                }
            };
            attachRotListener('rotX', 'x');
            attachRotListener('rotY', 'y');
            attachRotListener('rotZ', 'z');

            // 3. Attach Generate Button Listener
            const oldProcessBtn = document.getElementById('processBtn');
            if (oldProcessBtn) {
                const newProcessBtn = oldProcessBtn.cloneNode(true) as HTMLButtonElement;
                oldProcessBtn.parentNode?.replaceChild(newProcessBtn, oldProcessBtn);

                newProcessBtn.addEventListener('click', async () => {
                    console.log("Starting generation...");
                    try {
                        let buffer: ArrayBuffer;

                        // Handle .spz decompression
                        if (file.name.toLowerCase().endsWith('.spz')) {
                            console.log("Detected .spz file. Decompressing...");
                            if ('DecompressionStream' in window) {
                                const ds = new DecompressionStream('gzip');
                                const decompressedStream = file.stream().pipeThrough(ds);
                                buffer = await new Response(decompressedStream).arrayBuffer();
                                console.log(`Decompressed .spz to ${buffer.byteLength} bytes.`);
                            } else {
                                throw new Error("Browser does not support DecompressionStream. Cannot read .spz files.");
                            }
                        } else {
                            buffer = await file.arrayBuffer();
                        }

                        const bytes = new Uint8Array(buffer);

                        // Get Mode
                        let mode = 1; // Default: Single Plane
                        const modeRadios = document.getElementsByName('reconMode');
                        for (let i = 0; i < modeRadios.length; i++) {
                            if ((modeRadios[i] as HTMLInputElement).checked) {
                                mode = parseInt((modeRadios[i] as HTMLInputElement).value);
                                break;
                            }
                        }

                        console.log(`Reconstruction Mode: ${mode}`);
                        const start = performance.now();

                        const result = splatwalk.convertSplatToMesh(bytes, mode);
                        // Future: apply rotation to result if needed
                        // For now we just rely on visual alignment, but ideally we transform the vertices too?
                        // The user request "Sync Rotation to Generated Mesh" implies we should.
                        // I'll add that TODO or implementation here if I can, but let's get the buttons working first.

                        const end = performance.now();
                        console.log(`Conversion complete in ${(end - start).toFixed(2)}ms`);
                        console.log(`Mesh: ${result.vertex_count} vertices, ${result.face_count} faces`);

                        if (result.vertex_count === 0) {
                            logError("Resulting mesh has 0 vertices. Conversion failed to produce geometry.");
                            return;
                        }

                        const scene = viewer.getScene();

                        // Dispose old custom mesh
                        const oldMesh = scene.getMeshByName("custom_mesh");
                        if (oldMesh) oldMesh.dispose();

                        const customMesh = new Mesh("custom_mesh", scene);
                        const vertexData = new VertexData();

                        vertexData.positions = result.vertices;

                        if (result.indices && result.indices.length > 0) {
                            vertexData.indices = result.indices;
                        } else {
                            console.warn("No indices returned. Rendering points not fully supported by standard Mesh without indices.");
                        }

                        vertexData.applyToMesh(customMesh);

                        // Apply the rotation from the splat to the new mesh so it matches visual alignment
                        const rot = viewer.getSplatRotation();
                        // Reset splat rotation or hide it? 
                        // Usually we hide the splat and show the mesh.
                        // But wait, the mesh generated by RANSAC might be in the original coordinate space?
                        // If we rotated the Splat visually, we should rotate the Result visually to match.
                        customMesh.rotation.x = rot.x;
                        customMesh.rotation.y = rot.y;
                        customMesh.rotation.z = rot.z;

                        // Create material
                        const mat = new StandardMaterial("mat", scene);

                        if (result.indices.length === 0 || result.face_count === 0) {
                            mat.pointsCloud = true;
                            mat.pointSize = 2;
                            mat.diffuseColor = new Color3(1, 0.5, 0);
                        } else {
                            // Standard solid mesh
                            mat.backFaceCulling = true;
                            mat.diffuseColor = new Color3(0.5, 0.5, 0.5);
                        }
                        customMesh.material = mat;

                        viewer.focusOnMesh(customMesh);
                        console.log("Mesh created in scene.");

                        // Update global refs for UI
                        currentMesh = customMesh;
                        currentMat = mat;

                        // Sync UI state
                        if (showMeshCheckbox) customMesh.setEnabled(showMeshCheckbox.checked);
                        if (meshOpacitySlider) mat.alpha = parseFloat(meshOpacitySlider.value);

                        // Show result controls
                        document.getElementById('resultSection')!.style.display = 'block';

                        // Ensure settings are open
                        toggleSettings(true);

                        // Show download button logic...
                        if (downloadContainer && downloadBtn) {
                            downloadContainer.style.display = 'block';
                            const newBtn = downloadBtn.cloneNode(true);
                            downloadBtn.parentNode?.replaceChild(newBtn, downloadBtn);

                            newBtn.addEventListener('click', async () => {
                                console.log("Downloading GLB...");
                                const name = file.name.replace(/\.(ply|spz)$/i, "");
                                try {
                                    await viewer.exportGLB(name);
                                    console.log("Download started.");
                                } catch (e) {
                                    logError(`Export failed: ${e}`);
                                }
                            });
                        }

                    } catch (e) {
                        console.error(e);
                        logError(`Processing failed: ${e}`);
                    }
                });
            }
        });

        // Prevent variable unused lint error (dummy usage)
        if (dropZone && viewer) {
            // keep refs alive
        }

    } catch (e) {
        console.error("Initialization failed", e);
        logError(`Initialization failed: ${e}`);
    }
}

main();
