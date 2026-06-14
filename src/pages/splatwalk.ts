import { Viewer } from '../scene/Viewer';
import { DropZone } from '../components/DropZone';
import { splatwalk, type GroundFieldCellState, type MeshSettings } from '../wasm/bridge';
import { Mesh, VertexData, StandardMaterial, Color3, Tools, Material } from '@babylonjs/core';
/// <reference types="vite/client" />
import NavWorker from '../navigation/navmesh.worker?worker';
import { extractFloorFieldWithRecovery, resolveRecovery, estimateDenseFloorRegion } from '../navigation/fastNav';
import { registerServiceWorker, setupOfflineHandling } from '../pwa/sw-register';

async function main() {
    const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    const logDiv = document.getElementById('systemLogsContent') as HTMLDivElement;
    const errorDiv = document.getElementById('error') as HTMLDivElement;

    // Custom Logger
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const appendSystemLog = (...args: unknown[]) => {
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
            } else if (msg.startsWith("[WAIT]")) {
                tag = "WAIT";
                typeClass = "log-tag-wait";
                content = msg.substring(6).trim();
            } else if (msg.startsWith("[WARN]")) {
                tag = "WARN";
                typeClass = "log-tag-wait";
                content = msg.substring(6).trim();
            } else if (msg.startsWith("[ERROR]")) {
                tag = "ERROR";
                typeClass = "log-tag-error";
                content = msg.substring(7).trim();
            } else if (msg.startsWith("[WORKER]")) {
                tag = "WORKER";
                typeClass = "log-tag-worker";
                content = msg.substring(8).trim();
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

            // Handle multi-line results from worker diagnostics
            if (content.includes('\n')) {
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const lineSpan = document.createElement('div');
                    lineSpan.textContent = line;
                    lineSpan.style.paddingLeft = i > 0 ? '45px' : '0'; // Indent sub-lines
                    msgSpan.appendChild(lineSpan);
                });
            } else {
                msgSpan.textContent = content;
            }

            entry.appendChild(tagSpan);
            entry.appendChild(msgSpan);

            logDiv.appendChild(entry);
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    };
    console.log = (...args) => {
        originalLog(...args);
        appendSystemLog(...args);
    };
    console.warn = (...args) => {
        originalWarn(...args);
        appendSystemLog(...args);
    };
    console.error = (...args) => {
        originalError(...args);
        appendSystemLog(...args);
    };

    // Register the service worker (prod) or self-heal stale caches (dev) so a
    // rebuilt wasm is always picked up without manual cache clearing.
    registerServiceWorker();
    setupOfflineHandling();

    const logError = (msg: string) => {
        if (errorDiv) {
            errorDiv.textContent = msg;
            errorDiv.style.display = 'block';

            // Exit fullscreen if active to ensure user sees the header
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => { });
            }

            // Scroll to top/error and focus
            errorDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            errorDiv.focus();
        }
        console.error(`[ERROR] ${msg}`);
    }

    // Visual cue while the splat WASM pipeline runs (now off the main thread in a
    // worker): show a spinner overlay whenever any WASM op is in flight. Hiding is
    // debounced so multi-call operations (e.g. suggestAdaptedRegion fires
    // suggestRegion + buildWalkableGroundField back-to-back) don't flicker.
    const processingOverlay = document.getElementById('processingOverlay');
    const processingLabel = document.getElementById('processingLabel');
    let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;
    const setProcessingOverlay = (busy: boolean, label = 'Processing splat…'): void => {
        if (!processingOverlay) return;
        if (busy) {
            if (hideOverlayTimer) { clearTimeout(hideOverlayTimer); hideOverlayTimer = null; }
            if (processingLabel) processingLabel.textContent = label;
            processingOverlay.classList.add('is-active');
            processingOverlay.setAttribute('aria-hidden', 'false');
        } else {
            if (hideOverlayTimer) clearTimeout(hideOverlayTimer);
            hideOverlayTimer = setTimeout(() => {
                processingOverlay.classList.remove('is-active');
                processingOverlay.setAttribute('aria-hidden', 'true');
                hideOverlayTimer = null;
            }, 220);
        }
    };
    splatwalk.onBusyChange = (busy: boolean): void => setProcessingOverlay(busy);

    const PROGRESS_STAGE_LABELS: Record<string, string> = {
        parse: 'Parsing splat…',
        prune: 'Pruning floaters',
        field: 'Building floor field…',
    };
    splatwalk.onProgress = (stage: string, fraction: number | null): void => {
        if (!processingLabel) return;
        const base = PROGRESS_STAGE_LABELS[stage] ?? 'Processing splat…';
        processingLabel.textContent =
            fraction !== null ? `${base} ${Math.round(fraction * 100)}%` : base;
    };

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

    const applyMeshMaterialOpacity = (mat: StandardMaterial, alpha: number): void => {
        mat.alpha = alpha;
        mat.transparencyMode = alpha < 1 ? Material.MATERIAL_ALPHABLEND : Material.MATERIAL_OPAQUE;
    };

    // UI Event Listeners placeholder (will be attached to mesh once created)
    let currentMesh: Mesh | null = null;
    let currentMat: StandardMaterial | null = null;
    let importedColliderGeometry: { positions: Float32Array, indices: Uint32Array } | null = null;

    if (showMeshCheckbox) {
        showMeshCheckbox.addEventListener('change', () => {
            if (currentMesh) currentMesh.setEnabled(showMeshCheckbox.checked);
        });
    }

    if (meshOpacitySlider) {
        meshOpacitySlider.addEventListener('input', () => {
            if (currentMat) applyMeshMaterialOpacity(currentMat, parseFloat(meshOpacitySlider.value));
        });
    }

    // Advanced Settings Toggle logic
    const advancedToggle = document.getElementById('advancedToggle');
    const advancedSettings = document.getElementById('advancedSettings');
    if (advancedToggle && advancedSettings) {
        advancedToggle.addEventListener('click', () => {
            const isHidden = advancedSettings.style.display === 'none';
            advancedSettings.style.display = isHidden ? 'flex' : 'none';
            advancedToggle.classList.toggle('open', isHidden);
        });
    }

    try {
        console.log("[INFO] Initializing SplatWalk...");

        // Init WASM
        await splatwalk.init();

        // Init Viewer
        const viewer = new Viewer(canvas);
        // Expose the viewer for dev-only end-to-end visual tests (camera framing).
        if (import.meta.env.DEV) {
            (window as unknown as { __splatwalkViewer?: Viewer }).__splatwalkViewer = viewer;
        }
        const colliderGlbInput = document.getElementById('colliderGlbInput') as HTMLInputElement | null;
        const colliderGlbBtn = document.getElementById('colliderGlbBtn') as HTMLButtonElement | null;
        const showColliderCheckbox = document.getElementById('showColliderMesh') as HTMLInputElement | null;
        const colliderOpacitySlider = document.getElementById('colliderOpacity') as HTMLInputElement | null;
        const showNavMeshCheckbox = document.getElementById('showNavMesh') as HTMLInputElement | null;
        const navMeshOpacitySlider = document.getElementById('navMeshOpacity') as HTMLInputElement | null;

        const applyNavMeshDisplayState = (): void => {
            if (showNavMeshCheckbox) {
                viewer.setNavMeshVisible(showNavMeshCheckbox.checked);
            }
            if (navMeshOpacitySlider) {
                viewer.setNavMeshOpacity(Number.parseFloat(navMeshOpacitySlider.value));
            }
        };

        const setColliderGlbLabel = (name: string | null) => {
            if (colliderGlbBtn) colliderGlbBtn.textContent = name ?? 'Import GLB';
        };

        colliderGlbBtn?.addEventListener('click', () => colliderGlbInput?.click());

        colliderGlbInput?.addEventListener('change', async () => {
            const colliderFile = colliderGlbInput.files?.[0];
            if (!colliderFile) {
                setColliderGlbLabel(null);
                return;
            }
            if (!/\.(glb|gltf)$/i.test(colliderFile.name)) {
                logError("Collider import requires a .glb or .gltf file.");
                setColliderGlbLabel(null);
                return;
            }

            try {
                const opacity = Number.parseFloat(colliderOpacitySlider?.value ?? '0.35') || 0.35;
                importedColliderGeometry = await viewer.loadColliderMesh(colliderFile, opacity);
                if (showColliderCheckbox) {
                    viewer.setColliderVisible(showColliderCheckbox.checked);
                }
                const sourceSelect = document.getElementById('paramColliderSource') as HTMLSelectElement | null;
                if (sourceSelect) sourceSelect.value = 'imported';
                setColliderGlbLabel(colliderFile.name);
                console.log(`[INFO] Imported dedicated collider mesh: ${colliderFile.name}`);
            } catch (error) {
                importedColliderGeometry = null;
                setColliderGlbLabel(null);
                logError(`Collider GLB import failed: ${error}`);
            }
        });

        showColliderCheckbox?.addEventListener('change', () => {
            viewer.setColliderVisible(showColliderCheckbox.checked);
        });

        colliderOpacitySlider?.addEventListener('input', () => {
            viewer.setColliderOpacity(Number.parseFloat(colliderOpacitySlider.value));
        });

        showNavMeshCheckbox?.addEventListener('change', () => {
            viewer.setNavMeshVisible(showNavMeshCheckbox.checked);
        });

        navMeshOpacitySlider?.addEventListener('input', () => {
            viewer.setNavMeshOpacity(Number.parseFloat(navMeshOpacitySlider.value));
        });

        // Resize handling for Fullscreen
        document.addEventListener('fullscreenchange', () => {
            // Small delay to ensure browser layout is updated
            setTimeout(() => viewer.resize(), 50);
        });

        // Helper to load and setup a file (drag or dropdown)
        const handleFileLoad = async (file: File) => {
            console.log(`[INFO] Loading file: ${file.name} (${file.size} bytes)`);

            if (!file.name.toLowerCase().endsWith('.ply') && !file.name.toLowerCase().endsWith('.spz')) {
                logError("Only .ply and .spz files are supported.");
                return;
            }

            errorDiv.style.display = 'none';
            document.getElementById('resultSection')!.style.display = 'none';
            document.getElementById('setupSection')!.style.display = 'block';

            // Open settings on drop
            toggleSettings(true);

            console.log("[WAIT] Processing file...");

            // 1. Visualize input splat
            await viewer.loadGaussianSplat(file);
            currentMesh = null;
            currentMat = null;
            importedColliderGeometry = null;
            if (colliderGlbInput) colliderGlbInput.value = '';
            setColliderGlbLabel(null);
            console.log("[INFO] Input splat visualized. Ready for setup.");

            let splatBytesPromise: Promise<Uint8Array> | null = null;

            const readSplatBytes = async (): Promise<Uint8Array> => {
                if (!splatBytesPromise) {
                    splatBytesPromise = (async () => {
                        let buffer: ArrayBuffer;

                        if (file.name.toLowerCase().endsWith('.spz')) {
                            console.log("[INFO] Detected .spz file. Decompressing...");
                            if ('DecompressionStream' in window) {
                                const ds = new DecompressionStream('gzip');
                                const decompressedStream = file.stream().pipeThrough(ds);
                                buffer = await new Response(decompressedStream).arrayBuffer();
                                console.log(`[INFO] Decompressed .spz to ${buffer.byteLength} bytes.`);
                            } else {
                                throw new Error("Browser does not support DecompressionStream. Cannot read .spz files.");
                            }
                        } else {
                            buffer = await file.arrayBuffer();
                        }

                        return new Uint8Array(buffer);
                    })();
                }

                return splatBytesPromise;
            };

            let generatedNavData: Uint8Array | null = null;
            // Track whether a navmesh has been built and which path produced it, so a manual
            // splat rotation can re-run the same generation and keep the navmesh, spawn point
            // and agents aligned with the re-oriented splat.
            let navHasBeenGenerated = false;
            let lastNavUsedFastPath = true;
            let realignNavTimer: ReturnType<typeof setTimeout> | null = null;

            // Suggest a region adapted to the DENSE floor band rather than the raw
            // suggestRegion() output, which on large floater-heavy scans is dragged
            // far below the real floor by stray under-floor splats. We build the
            // ground field once and clamp the region (and floor height) to where the
            // splats actually concentrate. Falls back to suggestRegion() on failure.
            const suggestAdaptedRegion = async (
                bytes: Uint8Array
            ): Promise<{ region_min: number[]; region_max: number[]; floor_y: number }> => {
                const baseSettings = buildMeshSettings(false);
                const suggested = await splatwalk.suggestRegion(bytes, baseSettings);
                const fallback = {
                    region_min: suggested.region_min as number[],
                    region_max: suggested.region_max as number[],
                    floor_y: suggested.floor_y,
                };
                try {
                    const seedCenter = [
                        (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
                        suggested.floor_y,
                        (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
                    ];
                    const field = await splatwalk.buildWalkableGroundField(bytes, { ...baseSettings, collision_seed: seedCenter });
                    const dense = estimateDenseFloorRegion(field);
                    if (!dense) return fallback;
                    // Keep XZ generous (prefer the wider of suggested vs dense), but
                    // adopt the dense Y band so the region sits at the real floor.
                    const region_min = [
                        Math.min(fallback.region_min[0], dense.min[0]),
                        dense.min[1],
                        Math.min(fallback.region_min[2], dense.min[2]),
                    ];
                    const region_max = [
                        Math.max(fallback.region_max[0], dense.max[0]),
                        dense.max[1],
                        Math.max(fallback.region_max[2], dense.max[2]),
                    ];
                    const floor_y = dense.min[1] + 0.6; // modal floor height (region_min Y = modal - 0.6)
                    console.log(
                        `[INFO] Adapted region to dense floor band: y ${region_min[1].toFixed(2)}..${region_max[1].toFixed(2)} ` +
                        `(floor ~${floor_y.toFixed(2)}; suggestRegion floor was ${suggested.floor_y.toFixed(2)}).`
                    );
                    return { region_min, region_max, floor_y };
                } catch (error) {
                    console.warn(`[WARN] Dense region adaptation failed, using suggestRegion(): ${error}`);
                    return fallback;
                }
            };

            const ensureFastCollisionSeed = async (bytes: Uint8Array): Promise<number[] | null> => {
                const seedX = document.getElementById('paramCollisionSeedX') as HTMLInputElement | null;
                const seedY = document.getElementById('paramCollisionSeedY') as HTMLInputElement | null;
                const seedZ = document.getElementById('paramCollisionSeedZ') as HTMLInputElement | null;
                if (!seedX || !seedY || !seedZ) return null;

                const regionBounds = viewer.getRegionBounds();
                const carveHeightInput = document.getElementById('paramCollisionCarveHeight') as HTMLInputElement | null;
                const carveHeight = Number.parseFloat(carveHeightInput?.value ?? '1.6') || 1.6;

                let seed: number[];
                if (regionBounds) {
                    seed = [
                        (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
                        regionBounds.min[1] + carveHeight * 0.5,
                        (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
                    ];
                } else {
                    const suggested = await suggestAdaptedRegion(bytes);
                    seed = [
                        (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
                        suggested.floor_y + carveHeight * 0.5,
                        (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
                    ];
                }

                seedX.value = seed[0].toFixed(3);
                seedY.value = seed[1].toFixed(3);
                seedZ.value = seed[2].toFixed(3);
                viewer.displaySeedMarker(seed);
                console.log(`[INFO] Fast path seed: ${seed.map((v) => v.toFixed(3)).join(', ')}`);
                return seed;
            };

            const buildFastFieldSettings = (base: MeshSettings, seed: number[] | null): MeshSettings => {
                return {
                    ...base,
                    mode: 2,
                    voxel_target: Math.max(base.voxel_target ?? 4000, 9000),
                    min_alpha: Math.max(base.min_alpha ?? 0.05, 0.08),
                    max_scale: Math.min(base.max_scale ?? 5.0, 3.5),
                    sdf_cell_size: 0.14,
                    sdf_vertical_cell_size: 0.05,
                    sdf_density_threshold: 0.06,
                    sdf_max_layers: 2,
                    sdf_smoothing_radius: 2,
                    sdf_influence_radius_scale: 2.6,
                    floor_projection_epsilon: 0.20,
                    obstacle_height_epsilon: 0.34,
                    obstacle_clearance_min: 0.18,
                    obstacle_clearance_max: 1.7,
                    max_local_height_variance: 0.14,
                    min_floor_confidence: 0.005,
                    hole_fill_radius: 2,
                    agent_radius_erode: 0,
                    component_mode: 'all',
                    collision_seed: seed ?? base.collision_seed,
                    collision_carve_height: 1.7,
                    collision_carve_radius: 0.35,
                };
            };

            const triangleArea = (positions: Float32Array, i0: number, i1: number, i2: number): number => {
                const ax = positions[i1] - positions[i0];
                const ay = positions[i1 + 1] - positions[i0 + 1];
                const az = positions[i1 + 2] - positions[i0 + 2];
                const bx = positions[i2] - positions[i0];
                const by = positions[i2 + 1] - positions[i0 + 1];
                const bz = positions[i2 + 2] - positions[i0 + 2];
                const cx = ay * bz - az * by;
                const cy = az * bx - ax * bz;
                const cz = ax * by - ay * bx;
                return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
            };

            type NavIslandMetadata = {
                area: number;
                centroid: [number, number, number];
                distanceToSeed: number;
                triangleCount: number;
                islandCount: number;
            };

            const filterNavmeshIslandNearSeed = (
                positions: Float32Array,
                indices: Uint32Array,
                seed: number[] | null
            ): { positions: Float32Array, indices: Uint32Array, metadata: NavIslandMetadata | null } => {
                const triangleCount = Math.floor(indices.length / 3);
                if (!seed || triangleCount <= 1) {
                    return { positions, indices, metadata: null };
                }

                const vertexToTriangles = new Map<string, number[]>();
                const vertexKey = (vertexIndex: number): string => {
                    const p = vertexIndex * 3;
                    return `${positions[p].toFixed(3)},${positions[p + 1].toFixed(3)},${positions[p + 2].toFixed(3)}`;
                };

                for (let tri = 0; tri < triangleCount; tri++) {
                    for (let corner = 0; corner < 3; corner++) {
                        const key = vertexKey(indices[tri * 3 + corner]);
                        const triangles = vertexToTriangles.get(key);
                        if (triangles) {
                            triangles.push(tri);
                        } else {
                            vertexToTriangles.set(key, [tri]);
                        }
                    }
                }

                const visited = new Uint8Array(triangleCount);
                const components: Array<{ triangles: number[], area: number, centroid: [number, number, number], distanceToSeed: number }> = [];
                for (let startTri = 0; startTri < triangleCount; startTri++) {
                    if (visited[startTri]) continue;

                    const stack = [startTri];
                    const component: number[] = [];
                    visited[startTri] = 1;
                    let area = 0;
                    let weightedX = 0;
                    let weightedY = 0;
                    let weightedZ = 0;

                    while (stack.length > 0) {
                        const tri = stack.pop()!;
                        component.push(tri);
                        const i0 = indices[tri * 3] * 3;
                        const i1 = indices[tri * 3 + 1] * 3;
                        const i2 = indices[tri * 3 + 2] * 3;
                        const triArea = triangleArea(positions, i0, i1, i2);
                        area += triArea;
                        const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
                        const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
                        const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
                        weightedX += cx * triArea;
                        weightedY += cy * triArea;
                        weightedZ += cz * triArea;

                        for (let corner = 0; corner < 3; corner++) {
                            const neighbors = vertexToTriangles.get(vertexKey(indices[tri * 3 + corner])) ?? [];
                            for (const nextTri of neighbors) {
                                if (!visited[nextTri]) {
                                    visited[nextTri] = 1;
                                    stack.push(nextTri);
                                }
                            }
                        }
                    }

                    const invArea = area > 0 ? 1 / area : 0;
                    const centroid: [number, number, number] = [
                        weightedX * invArea,
                        weightedY * invArea,
                        weightedZ * invArea,
                    ];
                    const dx = centroid[0] - seed[0];
                    const dy = centroid[1] - seed[1];
                    const dz = centroid[2] - seed[2];
                    components.push({
                        triangles: component,
                        area,
                        centroid,
                        distanceToSeed: Math.sqrt(dx * dx + dy * dy + dz * dz),
                    });
                }

                if (components.length <= 1) {
                    const only = components[0];
                    return {
                        positions,
                        indices,
                        metadata: only ? {
                            area: only.area,
                            centroid: only.centroid,
                            distanceToSeed: only.distanceToSeed,
                            triangleCount,
                            islandCount: 1,
                        } : null,
                    };
                }

                const largestArea = Math.max(...components.map((component) => component.area));
                const viable = components.filter((component) => component.area >= largestArea * 0.08);
                viable.sort((a, b) => a.distanceToSeed - b.distanceToSeed || b.area - a.area);
                const selected = viable[0] ?? components.sort((a, b) => b.area - a.area)[0];

                const remap = new Map<number, number>();
                const filteredPositions: number[] = [];
                const filteredIndices: number[] = [];
                const addVertex = (oldIndex: number): number => {
                    const existing = remap.get(oldIndex);
                    if (existing !== undefined) return existing;
                    const next = filteredPositions.length / 3;
                    const p = oldIndex * 3;
                    filteredPositions.push(positions[p], positions[p + 1], positions[p + 2]);
                    remap.set(oldIndex, next);
                    return next;
                };

                const orderedTriangles = [...selected.triangles].sort((a, b) => {
                    const centroidDistance = (tri: number): number => {
                        const i0 = indices[tri * 3] * 3;
                        const i1 = indices[tri * 3 + 1] * 3;
                        const i2 = indices[tri * 3 + 2] * 3;
                        const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
                        const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
                        const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;
                        const dx = cx - seed[0];
                        const dy = cy - seed[1];
                        const dz = cz - seed[2];
                        return Math.sqrt(dx * dx + dy * dy + dz * dz);
                    };
                    return centroidDistance(a) - centroidDistance(b);
                });

                for (const tri of orderedTriangles) {
                    filteredIndices.push(
                        addVertex(indices[tri * 3]),
                        addVertex(indices[tri * 3 + 1]),
                        addVertex(indices[tri * 3 + 2])
                    );
                }

                console.log(
                    `[INFO] Fast nav island filter: kept ${selected.triangles.length}/${triangleCount} triangles ` +
                    `across ${components.length} islands, area=${selected.area.toFixed(2)}, seedDistance=${selected.distanceToSeed.toFixed(2)}`
                );

                return {
                    positions: new Float32Array(filteredPositions),
                    indices: new Uint32Array(filteredIndices),
                    metadata: {
                        area: selected.area,
                        centroid: selected.centroid,
                        distanceToSeed: selected.distanceToSeed,
                        triangleCount: selected.triangles.length,
                        islandCount: components.length,
                    },
                };
            };

            const validateFastNavIsland = (metadata: NavIslandMetadata | null, seed: number[] | null, expectedFloorY: number | null): void => {
                if (!metadata) {
                    console.warn("[WARN] Fast nav island validation skipped because no seed island metadata was available.");
                    return;
                }

                const floorDelta = expectedFloorY !== null ? metadata.centroid[1] - expectedFloorY : 0;
                console.log(
                    `[INFO] Fast nav selected island: triangles=${metadata.triangleCount}, area=${metadata.area.toFixed(2)}, ` +
                    `centroid=${metadata.centroid.map((v) => v.toFixed(3)).join(', ')}, seedDistance=${metadata.distanceToSeed.toFixed(2)}, ` +
                    `floorDelta=${expectedFloorY !== null ? floorDelta.toFixed(2) : 'n/a'}`
                );

                if (metadata.area < 0.35 || metadata.triangleCount < 2) {
                    throw new Error("Fast nav rejected a tiny navmesh island. The floor field did not produce a usable room-floor region. Try defining a region seed on the floor or importing a Collider GLB for manual nav.");
                }
                if (seed && metadata.distanceToSeed > 6.0) {
                    throw new Error("Fast nav rejected an island too far from the seed. Move the seed onto the room floor or define a tighter region.");
                }
                if (expectedFloorY !== null && floorDelta < -0.7) {
                    throw new Error("Fast nav rejected a navmesh below the expected floor. Define a region seed on the visible room floor or import a Collider GLB for manual nav.");
                }
            };

            const chooseNpcSpawnPoint = (positions: Float32Array, indices: Uint32Array, playerSpawn: { x: number, y: number, z: number } | null): [number, number, number] | null => {
                if (!playerSpawn || indices.length < 3) return null;

                let best: [number, number, number] | null = null;
                let bestScore = -Infinity;
                for (let i = 0; i + 2 < indices.length; i += 3) {
                    const i0 = indices[i] * 3;
                    const i1 = indices[i + 1] * 3;
                    const i2 = indices[i + 2] * 3;
                    const candidate: [number, number, number] = [
                        (positions[i0] + positions[i1] + positions[i2]) / 3,
                        (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3,
                        (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3,
                    ];
                    const dx = candidate[0] - playerSpawn.x;
                    const dz = candidate[2] - playerSpawn.z;
                    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
                    const yPenalty = Math.abs(candidate[1] - playerSpawn.y);
                    const score = horizontalDistance - yPenalty * 2;
                    if (horizontalDistance >= 0.75 && score > bestScore) {
                        best = candidate;
                        bestScore = score;
                    }
                }

                return best;
            };

            const runNavmeshFromCollider = async (autoSpawnNpc = false): Promise<void> => {
                console.log(autoSpawnNpc ? "[WAIT] Fast path: splat -> collider -> navmesh -> NPC..." : "[WAIT] Building navmesh from dedicated collider source...");
                const bytes = await readSplatBytes();
                let fastSeed: number[] | null = null;
                if (autoSpawnNpc) {
                    fastSeed = await ensureFastCollisionSeed(bytes);
                }

                const navSettings = autoSpawnNpc
                    ? buildFastFieldSettings(buildMeshSettings(true), fastSeed)
                    : buildMeshSettings(true);
                if (autoSpawnNpc) {
                    console.log(
                        `[INFO] Fast preset: floor-field source, cell=0.14, obstacleEps=0.34, variance=0.14, component=all, ` +
                        `seed=${(navSettings.collision_seed ?? fastSeed)?.map((v) => v.toFixed(3)).join(', ') ?? 'auto'}`
                    );
                }
                if (navSettings.collision_seed) {
                    viewer.displaySeedMarker(navSettings.collision_seed);
                }

                const colliderSourceSelect = document.getElementById('paramColliderSource') as HTMLSelectElement | null;
                let colliderSource = colliderSourceSelect?.value ?? 'generated';
                if (autoSpawnNpc && colliderSource === 'imported' && !importedColliderGeometry) {
                    colliderSource = 'generated';
                    if (colliderSourceSelect) {
                        colliderSourceSelect.value = 'generated';
                    }
                    console.warn("[WARN] Fast path switched to generated collider because no Collider GLB is loaded.");
                }
                const showColliderCheckbox = document.getElementById('showColliderMesh') as HTMLInputElement | null;
                const colliderOpacitySlider = document.getElementById('colliderOpacity') as HTMLInputElement | null;
                let geometry: { positions: Float32Array, indices: Uint32Array };
                let sourceLabel = 'generated_voxel_collider';
                let effectiveFastSeed = navSettings.collision_seed ?? fastSeed;

                if (autoSpawnNpc) {
                    // Shared, built-in adaptive recovery: escalate floor-field extraction
                    // parameters and retry instead of failing on sparse/large scenes.
                    const extracted = await extractFloorFieldWithRecovery({
                        bytes,
                        baseSettings: navSettings,
                        seed: effectiveFastSeed ?? fastSeed ?? [],
                        recovery: resolveRecovery(),
                        log: (message: string): void => console.log(message),
                    });
                    const floorMesh = extracted.floorMesh;
                    effectiveFastSeed = extracted.effectiveSeed;
                    geometry = {
                        positions: floorMesh.positions,
                        indices: floorMesh.indices,
                    };
                    if (floorMesh.fallbackUsed) {
                        effectiveFastSeed = floorMesh.centroid;
                        viewer.displaySeedMarker(floorMesh.centroid);
                        console.warn(`[WARN] Fast nav relocated the seed marker to the accepted floor island centroid: ${floorMesh.centroid.map((v) => v.toFixed(3)).join(', ')}`);
                    }
                    sourceLabel = 'fast_floor_field';
                    console.log(
                        `[INFO] Fast floor Recast source: vertices=${geometry.positions.length / 3}, triangles=${geometry.indices.length / 3}, ` +
                        `selectedCells=${floorMesh.selectedCellCount}, area=${floorMesh.selectedArea.toFixed(2)}`
                    );
                } else if (colliderSource === 'imported') {
                    geometry = importedColliderGeometry ?? viewer.getColliderMeshBuffers();
                    sourceLabel = 'imported_collider_glb';
                    console.log(`[INFO] Using imported Collider GLB as authoritative Recast input.`);
                    console.log(`[INFO] Imported collider: ${geometry.positions.length / 3} vertices, ${geometry.indices.length / 3} triangles.`);
                } else {
                    const basis = await splatwalk.convertSplatToNavmeshBasis(bytes, navSettings);
                    geometry = {
                        positions: new Float32Array(basis.mesh.vertices),
                        indices: new Uint32Array(basis.mesh.indices),
                    };
                    const opacity = Number.parseFloat(colliderOpacitySlider?.value ?? '0.35') || 0.35;
                    viewer.displayColliderMesh(geometry.positions, geometry.indices, opacity);
                    if (showColliderCheckbox) {
                        viewer.setColliderVisible(showColliderCheckbox.checked);
                    }

                    console.log(`[INFO] Generated collider: ${basis.mesh.vertex_count} vertices, ${basis.mesh.face_count} faces.`);
                    console.log(
                        `[INFO] Collision grid: ${basis.diagnostics.collision_grid_width}x${basis.diagnostics.collision_grid_height}x${basis.diagnostics.collision_grid_depth}, ` +
                        `voxel=${basis.diagnostics.collision_voxel_size.toFixed(3)}, ` +
                        `scene=${basis.diagnostics.collision_scene_type}, mesh=${basis.diagnostics.collision_mesh_mode}`
                    );
                    console.log(
                        `[INFO] Collision stages: occupied=${basis.diagnostics.collision_occupied_voxels}, ` +
                        `clusterKept=${basis.diagnostics.collision_cluster_kept_voxels}, ` +
                        `clusterDiscarded=${basis.diagnostics.collision_cluster_discarded_voxels}, ` +
                        `filled=${basis.diagnostics.collision_filled_voxels}, ` +
                        `carved=${basis.diagnostics.collision_carved_voxels}, ` +
                        `surfaceFaces=${basis.diagnostics.collision_surface_faces}`
                    );
                    console.log(
                        `[INFO] Collision seed: used=${JSON.stringify(basis.diagnostics.collision_seed_used ?? navSettings.collision_seed)}, ` +
                        `state=${basis.diagnostics.collision_seed_state}, ` +
                        `externalFillLeaked=${basis.diagnostics.collision_external_fill_leaked}`
                    );
                    if (basis.diagnostics.collision_seed_used) {
                        viewer.displaySeedMarker(basis.diagnostics.collision_seed_used);
                    }
                    if (basis.diagnostics.collision_external_fill_leaked) {
                        console.warn("[WARN] Indoor external fill skipped because the seed leaked to exterior. Move the seed inside the room or increase fill size.");
                    }
                }

                const splatBounds = viewer.getSplatBoundsForDiagnostics();
                const colliderBounds = autoSpawnNpc ? null : viewer.getColliderBounds();
                if (splatBounds) {
                    console.log(`[INFO] Splat bounds: min=${splatBounds.min.toString()}, max=${splatBounds.max.toString()}`);
                }
                if (colliderBounds) {
                    console.log(`[INFO] Collider bounds: min=${colliderBounds.min.toString()}, max=${colliderBounds.max.toString()}`);
                }

                if (geometry.positions.length === 0 || geometry.indices.length === 0) {
                    throw new Error(`Collider mesh is empty. Import a Collider GLB or adjust seed, scene type, voxel size, opacity, or carve capsule.`);
                }

                const params = {
                    cs: autoSpawnNpc ? 0.12 : parseFloat((document.getElementById('paramNavCS') as HTMLInputElement).value),
                    ch: autoSpawnNpc ? 0.10 : parseFloat((document.getElementById('paramNavCH') as HTMLInputElement).value),
                    walkableHeight: autoSpawnNpc ? 1.7 : parseFloat((document.getElementById('paramNavHeight') as HTMLInputElement).value),
                    walkableRadius: autoSpawnNpc ? 0.45 : parseFloat((document.getElementById('paramNavRadius') as HTMLInputElement).value),
                    walkableClimb: autoSpawnNpc ? 0.25 : parseFloat((document.getElementById('paramNavClimb') as HTMLInputElement).value),
                    walkableSlopeAngle: autoSpawnNpc ? 28 : parseFloat((document.getElementById('paramNavSlope') as HTMLInputElement).value),
                    maxEdgeLen: 12,
                    maxSimplificationError: autoSpawnNpc ? 0.5 : 0.8,
                    minRegionArea: autoSpawnNpc ? 24 : 2,
                    mergeRegionArea: autoSpawnNpc ? 36 : 12,
                    maxVertsPerPoly: 6,
                    detailSampleDist: 6,
                    detailSampleMaxError: 1
                };

                const fastAttempts = [
                    { label: 'strict', params },
                    {
                        label: 'balanced',
                        params: {
                            ...params,
                            cs: 0.15,
                            ch: 0.12,
                            walkableHeight: 1.4,
                            walkableRadius: 0.32,
                            walkableClimb: 0.4,
                            walkableSlopeAngle: 38,
                            maxSimplificationError: 0.8,
                            minRegionArea: 8,
                            mergeRegionArea: 16,
                        }
                    },
                    {
                        label: 'recovery',
                        params: {
                            ...params,
                            cs: 0.18,
                            ch: 0.14,
                            walkableHeight: 1.2,
                            walkableRadius: 0.25,
                            walkableClimb: 0.55,
                            walkableSlopeAngle: 45,
                            maxSimplificationError: 1.0,
                            minRegionArea: 2,
                            mergeRegionArea: 8,
                        }
                    },
                ];
                const attempts = autoSpawnNpc ? fastAttempts : [{ label: 'manual', params }];

                let result: { navMeshData: Uint8Array, debugPositions: Float32Array, debugIndices: Uint32Array, report: any } | null = null;
                let lastError: unknown = null;
                for (const attempt of attempts) {
                    console.log(`[INFO] NavMesh Parameters (${attempt.label}):`, attempt.params);
                    console.log("[WAIT] Spawning NavMesh Worker...");

                    const worker = new NavWorker();
                    try {
                        result = await new Promise<{ navMeshData: Uint8Array, debugPositions: Float32Array, debugIndices: Uint32Array, report: any }>((resolve, reject) => {
                            worker.onmessage = (e: MessageEvent) => {
                                const { type, payload } = e.data;
                                if (type === 'done') {
                                    worker.terminate();
                                    resolve(payload);
                                } else if (type === 'error') {
                                    worker.terminate();
                                    reject(new Error(payload));
                                }
                            };

                            worker.postMessage({
                                type: 'generate',
                                payload: {
                                    positions: geometry.positions,
                                    indices: geometry.indices,
                                    params: attempt.params,
                                    sourceLabel,
                                    splatBounds: splatBounds ? { min: splatBounds.min.asArray(), max: splatBounds.max.asArray() } : null,
                                    colliderBounds: colliderBounds ? { min: colliderBounds.min.asArray(), max: colliderBounds.max.asArray() } : null,
                                }
                            });
                        });
                        if (autoSpawnNpc && attempt.label !== 'strict') {
                            console.warn(`[WARN] Fast nav recovered with ${attempt.label} Recast settings.`);
                        }
                        break;
                    } catch (error) {
                        worker.terminate();
                        lastError = error;
                        if (!autoSpawnNpc || attempt === attempts[attempts.length - 1]) {
                            break;
                        }
                        console.warn(`[WARN] Fast nav ${attempt.label} attempt failed; retrying with relaxed Recast settings.`);
                    }
                }

                if (!result) {
                    throw lastError instanceof Error ? lastError : new Error(String(lastError));
                }

                generatedNavData = result.navMeshData;
                navHasBeenGenerated = true;
                lastNavUsedFastPath = autoSpawnNpc;
                console.log("[SUCCESS] NavMesh generated successfully!");

                const { report } = result;
                if (report) {
                    if (report.isOverride) {
                        console.warn(`[WARN] AUTO-SCALED: Cell Size adjusted to ${report.activeCS}m for environment resolution.`);
                    }
                    if (report.wasFlipped) {
                        console.log(`[INFO] Winding Correction: System auto-corrected mesh orientation for Recast compatibility.`);
                    }
                    if (report.headroomPadding > 0) {
                        console.log(`[INFO] Applied +${report.headroomPadding.toFixed(2)}m vertical padding for headroom.`);
                    }
                    console.log(`[INFO] Mesh Normal Quality: ${(report.avgUpDot * 100).toFixed(1)}% Up-Facing`);
                    console.log(`[INFO] Final Voxel Grid: ${report.gridDim[0]}x${report.gridDim[1]}x${report.gridDim[2]}`);
                    console.log(`[INFO] Recast source: ${report.sourceLabel}`);
                    if (report.splatBounds) {
                        console.log(`[INFO] Splat bounds audit: ${JSON.stringify(report.splatBounds.min)} to ${JSON.stringify(report.splatBounds.max)}`);
                    }
                    if (report.colliderBounds) {
                        console.log(`[INFO] Collider bounds audit: ${JSON.stringify(report.colliderBounds.min)} to ${JSON.stringify(report.colliderBounds.max)}`);
                    }
                    if (report.sourceBounds && report.debugBounds) {
                        console.log(`[INFO] Recast input Y bounds: ${report.sourceBounds.min[1].toFixed(3)} to ${report.sourceBounds.max[1].toFixed(3)}`);
                        console.log(`[INFO] Recast debug Y bounds: ${report.debugBounds.min[1].toFixed(3)} to ${report.debugBounds.max[1].toFixed(3)}`);
                    }
                }

                console.log("[WAIT] Rendering NavMesh visual overlay...");
                const expectedFloorY = autoSpawnNpc && effectiveFastSeed && navSettings.collision_carve_height
                    ? effectiveFastSeed[1] - navSettings.collision_carve_height * 0.5
                    : null;
                const visualNavmesh = { positions: result.debugPositions, indices: result.debugIndices, metadata: null as NavIslandMetadata | null };
                if (autoSpawnNpc) {
                    const safety = filterNavmeshIslandNearSeed(result.debugPositions, result.debugIndices, effectiveFastSeed);
                    validateFastNavIsland(safety.metadata, effectiveFastSeed, expectedFloorY);
                    if (safety.metadata && safety.metadata.islandCount > 1) {
                        console.warn(`[WARN] Fast floor Recast returned ${safety.metadata.islandCount} islands; display/crowd will still use the full field-derived Recast result.`);
                    }
                }
                const spawnPoint = await viewer.displayNavMesh(visualNavmesh.positions, visualNavmesh.indices, 0);
                applyNavMeshDisplayState();
                if (autoSpawnNpc && spawnPoint) {
                    const npcSpawn = chooseNpcSpawnPoint(visualNavmesh.positions, visualNavmesh.indices, spawnPoint);
                    viewer.setPreferredNavSpawnPoints(
                        [spawnPoint.x, spawnPoint.y, spawnPoint.z],
                        npcSpawn
                    );
                    console.log(`[INFO] Player agent spawn: ${spawnPoint.x.toFixed(3)}, ${spawnPoint.y.toFixed(3)}, ${spawnPoint.z.toFixed(3)}`);
                    if (npcSpawn) {
                        console.log(`[INFO] NPC preferred spawn: ${npcSpawn.map((v) => v.toFixed(3)).join(', ')}`);
                    } else {
                        console.warn("[WARN] No separated NPC spawn point found on the visible navmesh island.");
                    }
                }
                (document.getElementById('resultSection') as HTMLElement | null)!.style.display = 'block';
                const downloadNavBtn = document.getElementById('downloadNavBtn') as HTMLButtonElement | null;
                if (downloadNavBtn) downloadNavBtn.style.display = 'block';

                console.log("[WAIT] Initializing NPC Crowd Simulation...");
                await viewer.initCrowd(result.navMeshData, spawnPoint);
                const simulationSection = document.getElementById('simulationSection') as HTMLDivElement | null;
                if (simulationSection) simulationSection.style.display = 'block';

                if (autoSpawnNpc) {
                    viewer.addNPC();
                    const framing = viewer.focusOnPlayer();
                    if (framing) {
                        console.log(`[INFO] Top-down view set above player at ${framing.player.map((v) => v.toFixed(2)).join(', ')}.`);
                    } else {
                        console.warn("[WARN] No player agent found to frame for the top-down view.");
                    }
                    console.log("[SUCCESS] Fast path complete: navmesh ready, NPC spawned, click navmesh to move.");
                } else {
                    console.log("[SUCCESS] Simulation ready.");
                }
            };

            const fastNavBtn = document.getElementById('fastNavBtn');
            if (fastNavBtn) {
                const newFastNavBtn = fastNavBtn.cloneNode(true) as HTMLButtonElement;
                fastNavBtn.parentNode?.replaceChild(newFastNavBtn, fastNavBtn);
                newFastNavBtn.addEventListener('click', async () => {
                    try {
                        errorDiv.style.display = 'none';
                        document.getElementById('resultSection')!.style.display = 'block';
                        toggleSettings(true);
                        await runNavmeshFromCollider(true);
                    } catch (error) {
                        logError(`Fast nav path failed: ${error}`);
                    }
                });
            }

            const globalDownloadNavBtn = document.getElementById('downloadNavBtn') as HTMLButtonElement | null;
            const globalGenerateNavBtn = document.getElementById('generateNavBtn') as HTMLButtonElement | null;
            const globalAddNpcBtn = document.getElementById('addNpcBtn') as HTMLButtonElement | null;
            if (globalGenerateNavBtn) {
                globalGenerateNavBtn.onclick = async () => {
                    try {
                        await runNavmeshFromCollider(false);
                    } catch (error) {
                        logError(`NavMesh generation failed: ${error}`);
                    }
                };
            }
            if (globalDownloadNavBtn) {
                globalDownloadNavBtn.onclick = () => {
                    if (!generatedNavData) {
                        console.warn("[WARN] No navmesh binary generated yet.");
                        return;
                    }
                    const blob = new Blob([generatedNavData as any], { type: 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${file.name.replace(/\.(ply|spz)$/i, "")}.nav`;
                    a.click();
                    URL.revokeObjectURL(url);
                    console.log("[Main] NavMesh binary download started.");
                };
            }
            if (globalAddNpcBtn) {
                globalAddNpcBtn.onclick = () => viewer.addNPC();
            }

            const buildMeshSettings = (includeRegion: boolean): MeshSettings => {
                const readNumber = (id: string, fallback: number): number => {
                    const input = document.getElementById(id) as HTMLInputElement | null;
                    const value = input ? Number(input.value) : NaN;
                    return Number.isFinite(value) ? value : fallback;
                };
                const readInteger = (id: string, fallback: number): number => Math.max(0, Math.round(readNumber(id, fallback)));
                const readBool = (id: string, fallback: boolean): boolean => {
                    const input = document.getElementById(id) as HTMLInputElement | null;
                    return input ? input.checked : fallback;
                };

                let mode = 2; // Default to Voxels now
                const modeRadios = document.getElementsByName('reconMode');
                for (let i = 0; i < modeRadios.length; i++) {
                    if ((modeRadios[i] as HTMLInputElement).checked) {
                        mode = parseInt((modeRadios[i] as HTMLInputElement).value);
                        break;
                    }
                }

                const rot = viewer.getSplatRotation();
                const settings: MeshSettings = {
                    mode,
                    voxel_target: readNumber('paramVoxelTarget', 4000),
                    sdf_cell_size: readNumber('paramSdfCellSize', 0.15),
                    sdf_vertical_cell_size: readNumber('paramSdfVerticalCellSize', 0.05),
                    sdf_density_threshold: readNumber('paramSdfDensityThreshold', 0.08),
                    sdf_max_layers: readInteger('paramSdfMaxLayers', 2),
                    sdf_smoothing_radius: readInteger('paramSdfSmoothingRadius', 1),
                    sdf_influence_radius_scale: readNumber('paramSdfInfluenceRadiusScale', 2.5),
                    collision_voxel_size: readNumber('paramCollisionVoxelSize', 0.08),
                    collision_opacity_threshold: readNumber('paramCollisionOpacityThreshold', 0.10),
                    collision_scene_type: ((document.getElementById('paramCollisionSceneType') as HTMLSelectElement | null)?.value as MeshSettings['collision_scene_type']) ?? 'outdoor',
                    collision_seed: [
                        readNumber('paramCollisionSeedX', 0),
                        readNumber('paramCollisionSeedY', 1),
                        readNumber('paramCollisionSeedZ', 0),
                    ],
                    collision_fill_size: readNumber('paramCollisionFillSize', 1.2),
                    collision_carve_height: readNumber('paramCollisionCarveHeight', 1.6),
                    collision_carve_radius: readNumber('paramCollisionCarveRadius', 0.25),
                    collision_mesh_mode: ((document.getElementById('paramCollisionMeshMode') as HTMLSelectElement | null)?.value as MeshSettings['collision_mesh_mode']) ?? 'faces',
                    min_alpha: readNumber('paramMinAlpha', 0.05),
                    max_scale: readNumber('paramMaxScale', 5.0),
                    prune_floaters: readBool('paramPruneFloaters', true),
                    prune_floaters_k: readInteger('paramPruneFloatersK', 16),
                    prune_floaters_std_ratio: readNumber('paramPruneFloatersStdRatio', 2.0),
                    normal_align: readNumber('paramNormalAlign', 0.05),
                    ransac_thresh: readNumber('paramRansacThresh', 0.1),
                    floor_projection_epsilon: readNumber('paramFloorProjectionEpsilon', 0.16),
                    height_projection_epsilon: readNumber('paramFloorProjectionEpsilon', 0.16),
                    obstacle_height_epsilon: readNumber('paramObstacleHeightEpsilon', 0.24),
                    max_local_height_variance: readNumber('paramMaxLocalHeightVariance', 0.08),
                    min_floor_confidence: readNumber('paramMinFloorConfidence', 0.01),
                    hole_fill_radius: readInteger('paramHoleFillRadius', 1),
                    agent_radius_erode: readNumber('paramAgentRadiusErode', 0),
                    component_mode: ((document.getElementById('paramComponentMode') as HTMLSelectElement | null)?.value as MeshSettings['component_mode']) ?? 'largest',
                    rotation: [rot.x, rot.y, rot.z],
                    flip_y: viewer.isSplatYFlipped(),
                };

                if (includeRegion) {
                    const regionBounds = viewer.getRegionBounds();
                    settings.region_min = regionBounds?.min;
                    settings.region_max = regionBounds?.max;
                }

                return settings;
            };

            const getVisibleGroundFieldStates = (): Set<GroundFieldCellState> => {
                const visible = new Set<GroundFieldCellState>();
                document.querySelectorAll<HTMLInputElement>('.ground-field-state').forEach((checkbox) => {
                    if (checkbox.checked) {
                        visible.add(checkbox.value as GroundFieldCellState);
                    }
                });
                return visible;
            };

            // 2. Attach Rotation Listeners
            const attachRotListener = (id: string, axis: 'x' | 'y' | 'z') => {
                const oldBtn = document.getElementById(id);
                if (oldBtn) {
                    const newBtn = oldBtn.cloneNode(true) as HTMLButtonElement;
                    oldBtn.parentNode?.replaceChild(newBtn, oldBtn);
                    newBtn.addEventListener('click', () => {
                        console.log(`[UI] Rotation ${axis} clicked`);
                        viewer.rotateSplat(axis);
                        // A rotation changes the splat orientation that WASM bakes into the
                        // navmesh, basis and spawn points. If a navmesh already exists it is now
                        // stale, so re-run the same generation path to re-align everything.
                        // Debounced so rapid multi-axis clicks collapse into a single rebuild.
                        if (navHasBeenGenerated) {
                            if (realignNavTimer) clearTimeout(realignNavTimer);
                            realignNavTimer = setTimeout(() => {
                                realignNavTimer = null;
                                console.log("[INFO] Splat rotated -- re-aligning navmesh to the new orientation...");
                                runNavmeshFromCollider(lastNavUsedFastPath).catch((error) => {
                                    logError(`Navmesh re-alignment after rotation failed: ${error}`);
                                });
                            }, 350);
                        }
                    });
                }
            };
            attachRotListener('rotX', 'x');
            attachRotListener('rotY', 'y');
            attachRotListener('rotZ', 'z');

            // 2.5 Region Selection Listeners
            const defineRegionBtn = document.getElementById('defineRegionBtn');
            const clearRegionBtn = document.getElementById('clearRegionBtn');

            if (defineRegionBtn && clearRegionBtn) {
                // Remove existing listeners by cloning
                const newDefineBtn = defineRegionBtn.cloneNode(true) as HTMLButtonElement;
                defineRegionBtn.parentNode?.replaceChild(newDefineBtn, defineRegionBtn);
                const newClearBtn = clearRegionBtn.cloneNode(true) as HTMLButtonElement;
                clearRegionBtn.parentNode?.replaceChild(newClearBtn, clearRegionBtn);

                newDefineBtn.addEventListener('click', async () => {
                    try {
                        const bytes = await readSplatBytes();
                        const suggestedRegion = await suggestAdaptedRegion(bytes);
                        viewer.enableRegionSelection({
                            min: suggestedRegion.region_min,
                            max: suggestedRegion.region_max,
                        });
                        newClearBtn.style.display = 'block';
                        newDefineBtn.textContent = 'UPDATE REGION';
                        console.log(`[UI] Region selection mode active: ${JSON.stringify(suggestedRegion.region_min)} to ${JSON.stringify(suggestedRegion.region_max)}`);
                    } catch (error) {
                        logError(`Region suggestion failed: ${error}`);
                    }
                });

                newClearBtn.addEventListener('click', () => {
                    viewer.disableRegionSelection();
                    newClearBtn.style.display = 'none';
                    newDefineBtn.textContent = 'DEFINE REGION';
                });
            }

            const useRegionSeedBtn = document.getElementById('useRegionSeedBtn');
            if (useRegionSeedBtn) {
                const newUseRegionSeedBtn = useRegionSeedBtn.cloneNode(true) as HTMLButtonElement;
                useRegionSeedBtn.parentNode?.replaceChild(newUseRegionSeedBtn, useRegionSeedBtn);
                newUseRegionSeedBtn.addEventListener('click', () => {
                    const regionBounds = viewer.getRegionBounds();
                    if (!regionBounds) {
                        console.warn("[WARN] Define a region first, then use its center as the collision seed.");
                        return;
                    }
                    const carveHeightInput = document.getElementById('paramCollisionCarveHeight') as HTMLInputElement | null;
                    const carveHeight = Number.parseFloat(carveHeightInput?.value ?? '1.6') || 1.6;
                    const seed = [
                        (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
                        regionBounds.min[1] + carveHeight * 0.5,
                        (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
                    ];
                    (document.getElementById('paramCollisionSeedX') as HTMLInputElement | null)!.value = seed[0].toFixed(3);
                    (document.getElementById('paramCollisionSeedY') as HTMLInputElement | null)!.value = seed[1].toFixed(3);
                    (document.getElementById('paramCollisionSeedZ') as HTMLInputElement | null)!.value = seed[2].toFixed(3);
                    viewer.displaySeedMarker(seed);
                    console.log(`[UI] Collision seed set from region center: ${seed.map((v) => v.toFixed(3)).join(', ')}`);
                });
            }

            // 3. Attach Generate Button Listener
            const oldProcessBtn = document.getElementById('processBtn');
            if (oldProcessBtn) {
                const newProcessBtn = oldProcessBtn.cloneNode(true) as HTMLButtonElement;
                oldProcessBtn.parentNode?.replaceChild(newProcessBtn, oldProcessBtn);

                newProcessBtn.addEventListener('click', async () => {
                    console.log("[WAIT] Starting generation...");
                    try {
                        const bytes = await readSplatBytes();
                        const settings = buildMeshSettings(true);

                        if (settings.region_min && settings.region_max) {
                            console.log(`[INFO] Applying region constraint: ${JSON.stringify(settings.region_min)} to ${JSON.stringify(settings.region_max)}`);
                        }

                        console.log(`[INFO] Reconstruction Settings:`, settings);
                        const start = performance.now();

                        const result = await splatwalk.convertSplatToMesh(bytes, settings);
                        const mesh = result.mesh;
                        const diagnostics = result.diagnostics;

                        const end = performance.now();
                        console.log(`[INFO] Conversion complete in ${(end - start).toFixed(2)}ms`);
                        console.log(`[INFO] Mesh: ${mesh.vertex_count} vertices, ${mesh.face_count} faces`);
                        console.log(
                            `[INFO] Diagnostics: points=${diagnostics.points_after_filter}/${diagnostics.points_total}, ` +
                            `grid=${diagnostics.grid_width}x${diagnostics.grid_height}, ` +
                            `faces=${diagnostics.faces_generated}, holes_filled=${diagnostics.holes_filled}`
                        );

                        // Region Integrity Audit
                        if (settings.region_min && settings.region_max) {
                            console.log(`[WAIT] Auditing mesh region integrity...`);
                            let outsideCount = 0;
                            const epsilon = 0.001;
                            for (let i = 0; i < mesh.vertices.length; i += 3) {
                                const x = mesh.vertices[i];
                                const y = mesh.vertices[i + 1];
                                const z = mesh.vertices[i + 2];

                                if (x < settings.region_min[0] - epsilon || x > settings.region_max[0] + epsilon ||
                                    y < settings.region_min[1] - epsilon || y > settings.region_max[1] + epsilon ||
                                    z < settings.region_min[2] - epsilon || z > settings.region_max[2] + epsilon) {
                                    outsideCount++;
                                }
                            }
                            if (outsideCount === 0) {
                                console.log(`[SUCCESS] Region Integrity Verified: All ${mesh.vertex_count} vertices are within bounds.`);
                            } else {
                                console.warn(`[WARN] Region Audit: ${outsideCount} vertices (${((outsideCount / mesh.vertex_count) * 100).toFixed(1)}%) were outside defined region.`);
                            }
                        }

                        // WASM Output Audit
                        let outNan = 0, outInf = 0;
                        for (let i = 0; i < mesh.vertices.length; i++) {
                            const v = mesh.vertices[i];
                            if (isNaN(v)) outNan++;
                            else if (!isFinite(v)) outInf++;
                        }
                        if (outNan > 0 || outInf > 0) {
                            console.warn(`[WARN] WASM produced artifacts: ${outNan} NaNs, ${outInf} Infinities. Sanitization will handle these.`);
                        }

                        if (mesh.vertex_count === 0) {
                            logError("Resulting mesh has 0 vertices. Conversion failed to produce geometry.");
                            return;
                        }

                        const scene = viewer.getScene();

                        // Dispose old custom mesh
                        const oldMesh = scene.getMeshByName("custom_mesh");
                        if (oldMesh) oldMesh.dispose();

                        const customMesh = new Mesh("custom_mesh", scene);
                        const vertexData = new VertexData();

                        vertexData.positions = mesh.vertices;

                        if (mesh.indices && mesh.indices.length > 0) {
                            vertexData.indices = mesh.indices;
                        } else {
                            console.warn("[WARN] No indices returned.");
                        }

                        vertexData.applyToMesh(customMesh);

                        // WASM now returns the mesh already oriented to the user-applied rotation
                        customMesh.rotation.set(0, 0, 0);

                        // Create material
                        const mat = new StandardMaterial("mat", scene);
                        if (mesh.indices.length === 0 || mesh.face_count === 0) {
                            mat.pointsCloud = true;
                            mat.pointSize = 2;
                        } else {
                            mat.backFaceCulling = true;
                            mat.diffuseColor = new Color3(0.5, 0.5, 0.5);
                        }
                        customMesh.material = mat;

                        viewer.focusOnMesh(customMesh);
                        console.log("[INFO] Mesh created in scene.");

                        currentMesh = customMesh;
                        currentMat = mat;

                        if (showMeshCheckbox) customMesh.setEnabled(showMeshCheckbox.checked);
                        if (meshOpacitySlider) applyMeshMaterialOpacity(mat, parseFloat(meshOpacitySlider.value));

                        document.getElementById('resultSection')!.style.display = 'block';
                        toggleSettings(true);

                        // Show download button logic...
                        if (downloadContainer && downloadBtn) {
                            downloadContainer.style.display = 'block';
                            const newBtn = downloadBtn.cloneNode(true);
                            downloadBtn.parentNode?.replaceChild(newBtn, downloadBtn);

                            newBtn.addEventListener('click', async () => {
                                console.log("[WAIT] Downloading GLB...");
                                const name = file.name.replace(/\.(ply|spz)$/i, "");
                                try {
                                    await viewer.exportGLB(name);
                                    console.log("[INFO] Download started.");
                                } catch (e) {
                                    logError(`Export failed: ${e}`);
                                }
                            });
                        }

                        // --- NavMesh Generation Logic ---
                        const generateNavBtn = document.getElementById('generateNavBtn') as HTMLButtonElement;
                        const downloadNavBtn = document.getElementById('downloadNavBtn') as HTMLButtonElement;
                        const addNpcBtn = document.getElementById('addNpcBtn') as HTMLButtonElement;
                        const generateFieldOverlayBtn = document.getElementById('generateFieldOverlayBtn') as HTMLButtonElement;
                        const clearFieldOverlayBtn = document.getElementById('clearFieldOverlayBtn') as HTMLButtonElement;

                        if (generateFieldOverlayBtn) {
                            generateFieldOverlayBtn.onclick = async () => {
                                console.log("[WAIT] Building 2.5D SDF field overlay...");
                                try {
                                    const fieldSettings = buildMeshSettings(true);
                                    const field = await splatwalk.buildWalkableGroundField(bytes, fieldSettings);
                                    viewer.displayGroundFieldOverlay(field, getVisibleGroundFieldStates());
                                    console.log(
                                        `[INFO] Ground field overlay: ${field.width}x${field.height}, ` +
                                        `cell=${field.cell_size.toFixed(3)}, filled=${field.diagnostics.cells_filled}, ` +
                                        `eroded=${field.diagnostics.cells_eroded}, discarded=${field.diagnostics.cells_discarded_component}`
                                    );
                                    console.log(
                                        `[INFO] SDF columns: yBins=${field.diagnostics.sdf_profile_bins}, ` +
                                        `yBinSize=${field.diagnostics.sdf_vertical_cell_size.toFixed(3)}, ` +
                                        `threshold=${field.diagnostics.sdf_density_threshold.toFixed(3)}, ` +
                                        `surfaces=${field.diagnostics.sdf_cells_with_surface}, ` +
                                        `multiLayer=${field.diagnostics.sdf_cells_multi_layer}, ` +
                                        `smoothed=${field.diagnostics.sdf_cells_smoothed}`
                                    );
                                    if (field.diagnostics.floor_plane_used_fallback) {
                                        console.warn("[WARN] Floor fallback active: using lower-percentile Y anchor because RANSAC floor was suspect.");
                                    }
                                } catch (e) {
                                    logError(`Ground field overlay failed: ${e}`);
                                }
                            };
                        }

                        if (clearFieldOverlayBtn) {
                            clearFieldOverlayBtn.onclick = () => viewer.clearGroundFieldOverlay();
                        }

                        if (generateNavBtn) {
                            generateNavBtn.onclick = async () => {
                                try {
                                    await runNavmeshFromCollider(false);
                                } catch (e) {
                                    logError(`NavMesh generation failed: ${e}`);
                                }
                            };
                        }

                        if (downloadNavBtn) {
                            downloadNavBtn.onclick = () => {
                                if (!generatedNavData) return;
                                const blob = new Blob([generatedNavData as any], { type: 'application/octet-stream' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = `${file.name.replace(/\.(ply|spz)$/i, "")}.nav`;
                                a.click();
                                URL.revokeObjectURL(url);
                                console.log("[Main] NavMesh binary download started.");
                            };
                        }

                        if (addNpcBtn) {
                            addNpcBtn.onclick = () => {
                                viewer.addNPC();
                            };
                        }

                    } catch (e) {
                        console.error(e);
                        logError(`Processing failed: ${e}`);
                    }
                });
            }
        };

        // Init DropZone
        new DropZone('renderCanvas', (file: File) => {
            handleFileLoad(file);
        });

        // Example Selector Listener
        const exampleSelect = document.getElementById('exampleSelect') as HTMLSelectElement;
        if (exampleSelect) {
            exampleSelect.addEventListener('change', async () => {
                const url = exampleSelect.value;
                if (!url) return;

                const selectedOption = exampleSelect.options[exampleSelect.selectedIndex];
                const fileName = selectedOption.textContent?.split(' (')[0] + ".ply";

                console.log(`[WAIT] Fetching example file: ${fileName}...`);

                try {
                    // Load via Babylon's XHR-based loader (Tools.LoadFile) rather than
                    // fetch(): the browser fetch() stream aborts mid-body on some networks,
                    // while Babylon's transport (used everywhere else) downloads reliably.
                    const data = (await Tools.LoadFileAsync(url, true)) as ArrayBuffer;

                    // Basic validation
                    if (fileName.toLowerCase().endsWith('.ply')) {
                        const header = new TextDecoder().decode(new Uint8Array(data, 0, 4));
                        if (header !== "ply\n" && header !== "ply\r") {
                            throw new Error("Fetched data is not a valid PLY file. If this is a Google Drive link, it may be blocked by CORS or showing a virus scan warning.");
                        }
                    }

                    const file = new File([data], fileName, { type: 'application/octet-stream' });
                    console.log(`[SUCCESS] Example file fetched: ${(file.size / (1024 * 1024)).toFixed(2)} MB.`);
                    handleFileLoad(file);
                } catch (err: any) {
                    console.error(`[ERROR] Failed to load example: ${err?.message ?? err}`);
                    logError(`Failed to load example: ${err.message}`);
                    exampleSelect.value = ""; // Reset dropdown
                }
            });
        }

        // Mobile Local File Upload Logic
        const chooseFileBtn = document.getElementById('chooseFileBtn');
        const localFileInput = document.getElementById('localFileInput') as HTMLInputElement;

        if (chooseFileBtn && localFileInput) {
            chooseFileBtn.addEventListener('click', () => {
                localFileInput.click();
            });

            localFileInput.addEventListener('change', () => {
                if (localFileInput.files && localFileInput.files.length > 0) {
                    const file = localFileInput.files[0];
                    handleFileLoad(file);
                    // Clear value to allow re-selecting the same file if needed
                    localFileInput.value = '';
                }
            });
        }

        // Prevent variable unused lint error (dummy usage)
        if (viewer) {
            // keep refs alive
        }

    } catch (e) {
        console.error("Initialization failed", e);
        logError(`Initialization failed: ${e}`);
    }
}

main();
