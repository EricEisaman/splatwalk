import { Viewer } from '../scene/Viewer';
import { DropZone } from '../components/DropZone';
import { splatwalk, type GroundFieldCellState, type MeshSettings } from '../wasm/bridge';
import {
    collisionBoundaryDiagnosticsSummary,
    exportCollisionBoundaryGlb,
    exportNavmeshBinary,
    generateCollisionBoundary,
    toCollisionBoundarySettings,
    type CollisionBoundaryArtifact,
} from '../collision/voxelBoundary';
import { normalizeSplatToPly, isSupportedSplatFile } from '../wasm/normalize';
import { SliceArchive } from '../wasm/sliceArchive';
import {
    clampSliceSettingsForScene,
    DEFAULT_AUTO_SLICE_THRESHOLD,
    DEFAULT_SLICE_SETTINGS,
    inferPlyShDegree,
    maxChunkExtentFromBounds,
    type SliceSettings,
} from '../wasm/sogTypes';
import { Mesh, VertexData, StandardMaterial, Color3, Tools, Material } from '@babylonjs/core';
/// <reference types="vite/client" />
import NavWorker from '../navigation/navmesh.worker?worker';
import {
    extractFloorFieldWithRecovery,
    resolveRecovery,
    estimateDenseFloorRegion,
    filterNavmeshIslandNearSeed,
    validateFastNavIsland,
    chooseNpcSpawnPoint,
    FAST_NAV_RECAST_ATTEMPTS,
    type RecastParams,
    type NavIslandMetadata,
} from '../navigation/fastNav';
import { buildNavmeshKey, getNavmesh, putNavmesh } from '../navigation/navmeshCache';
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
    let generatedCollisionArtifact: CollisionBoundaryArtifact | null = null;
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

    // Streamed SOG Export panel: collapsible toggle + mode-dependent visibility.
    const sogExportToggle = document.getElementById('sogExportToggle');
    const sogExportPanel = document.getElementById('sogExportPanel');
    if (sogExportToggle && sogExportPanel) {
        sogExportToggle.addEventListener('click', () => {
            const isHidden = sogExportPanel.style.display === 'none';
            sogExportPanel.style.display = isHidden ? 'flex' : 'none';
            sogExportToggle.classList.toggle('open', isHidden);
        });
    }
    const sogModeRadios = Array.from(document.getElementsByName('sogMode')) as HTMLInputElement[];
    const sogLodLevelsInput = document.getElementById('paramSogLodLevels') as HTMLInputElement | null;
    const sogLodLevelsWarning = document.getElementById('sogLodLevelsWarning');
    const isStreamedSogMode = (): boolean => sogModeRadios.find(r => r.checked)?.value !== 'single';
    const updateSogExportUi = (): void => {
        const streamed = isStreamedSogMode();
        document.querySelectorAll('.sog-streamed-only').forEach(el => {
            (el as HTMLElement).style.display = streamed ? '' : 'none';
        });
        const lodLevels = sogLodLevelsInput ? Number(sogLodLevelsInput.value) : NaN;
        const showLodWarning = streamed && lodLevels === 1;
        if (sogLodLevelsWarning) {
            sogLodLevelsWarning.style.display = showLodWarning ? '' : 'none';
        }
        const exportBtn = document.getElementById('sogExportBtn') as HTMLButtonElement | null;
        if (exportBtn && !exportBtn.disabled) {
            exportBtn.textContent = streamed
                ? 'EXPORT STREAMED SOG (.ZIP)'
                : 'EXPORT SINGLE SOG (.ZIP)';
        }
    };
    sogModeRadios.forEach(r => r.addEventListener('change', updateSogExportUi));
    sogLodLevelsInput?.addEventListener('input', updateSogExportUi);
    sogLodLevelsInput?.addEventListener('change', updateSogExportUi);
    updateSogExportUi();

    // Read the homepage SOG controls into a typed SliceSettings (omitted values
    // fall back to the WASM defaults).
    const buildSliceSettings = (): SliceSettings => {
        const num = (id: string): number | undefined => {
            const input = document.getElementById(id) as HTMLInputElement | null;
            const value = input ? Number(input.value) : NaN;
            return Number.isFinite(value) ? value : undefined;
        };
        return {
            sh_degree: num('paramSogShDegree'),
            sh_cluster_count: num('paramSogShClusters'),
            sh_iterations: num('paramSogShIterations'),
            chunk_count: num('paramSogChunkCount'),
            chunk_extent: num('paramSogChunkExtent'),
            lod_levels: num('paramSogLodLevels'),
        };
    };

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
                generatedCollisionArtifact = null;
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

            if (!isSupportedSplatFile(file.name)) {
                logError("Only .ply, .spz, and .splat files are supported.");
                return;
            }

            errorDiv.style.display = 'none';
            document.getElementById('resultSection')!.style.display = 'none';
            document.getElementById('setupSection')!.style.display = 'block';

            // Open settings on drop
            toggleSettings(true);

            console.log("[WAIT] Processing file...");

            // Normalize any supported splat (.ply/.spz/.splat) to full-fidelity PLY
            // once, then reuse those bytes for both the viewer and the nav pipeline.
            // This is the single ingest seam: Babylon only ever loads PLY (no
            // CDN-backed .spz loader), and non-PLY formats are converted in WASM.
            let splatBytesPromise: Promise<Uint8Array> | null = null;

            const readSplatBytes = async (): Promise<Uint8Array> => {
                if (!splatBytesPromise) {
                    splatBytesPromise = (async () => {
                        const ext = file.name.toLowerCase().match(/\.(spz|splat)$/)?.[1];
                        if (ext) {
                            console.log(`[INFO] Detected .${ext} file. Normalizing to .ply...`);
                        }
                        const ply = await normalizeSplatToPly(file);
                        if (ext) {
                            console.log(`[INFO] Normalized .${ext} to ${ply.byteLength}-byte .ply.`);
                        }
                        return ply;
                    })();
                }

                return splatBytesPromise;
            };

            let loadedShDegree = DEFAULT_SLICE_SETTINGS.sh_degree;
            let maxChunkExtent = DEFAULT_SLICE_SETTINGS.chunk_extent;
            const applySogCaps = (): void => {
                const shInput = document.getElementById('paramSogShDegree') as HTMLInputElement | null;
                if (shInput) {
                    shInput.max = String(loadedShDegree);
                    if (Number(shInput.value) > loadedShDegree) {
                        shInput.value = String(loadedShDegree);
                    }
                }
                const extentInput = document.getElementById('paramSogChunkExtent') as HTMLInputElement | null;
                if (extentInput) {
                    extentInput.max = String(maxChunkExtent);
                    if (Number(extentInput.value) > maxChunkExtent) {
                        extentInput.value = String(maxChunkExtent);
                    }
                }
            };

            // 1. Visualize input splat (from the normalized PLY bytes).
            const visualBytes = await readSplatBytes();
            loadedShDegree = inferPlyShDegree(visualBytes);
            applySogCaps();
            await viewer.loadGaussianSplat(visualBytes);
            currentMesh = null;
            currentMat = null;
            generatedCollisionArtifact = null;
            importedColliderGeometry = null;
            if (colliderGlbInput) colliderGlbInput.value = '';
            setColliderGlbLabel(null);
            console.log("[INFO] Input splat visualized. Ready for setup.");

            // --- Streamed SOG export (per loaded file) ---------------------
            const sogStatus = document.getElementById('sogExportStatus');
            const setSogStatus = (text: string, auto = false): void => {
                if (!sogStatus) return;
                sogStatus.textContent = text;
                sogStatus.classList.toggle('sog-auto', auto);
            };
            // Reset the export button's listeners for this file by cloning it.
            const existingSogBtn = document.getElementById('sogExportBtn') as HTMLButtonElement | null;
            if (existingSogBtn) {
                const sogBtn = existingSogBtn.cloneNode(true) as HTMLButtonElement;
                existingSogBtn.replaceWith(sogBtn);
                sogBtn.addEventListener('click', async () => {
                    try {
                        sogBtn.disabled = true;
                        sogBtn.textContent = 'EXPORTING…';
                        const bytes = await readSplatBytes();
                        const settings = clampSliceSettingsForScene(buildSliceSettings(), {
                            maxShDegree: loadedShDegree,
                            maxChunkExtent,
                        });
                        const streamed = isStreamedSogMode();
                        console.log(`[INFO] Exporting ${streamed ? 'streamed LOD' : 'single'} SOG...`);
                        const result = streamed
                            ? await splatwalk.sliceSplat(bytes, settings)
                            : await splatwalk.convertToSog(bytes, settings);
                        const archive = new SliceArchive(result, { streamed });
                        const base = file.name.replace(/\.(ply|spz|splat)$/i, '');
                        archive.download(`${base}-sog`);
                        const mb = (archive.byteLength / 1e6).toFixed(1);
                        console.log(`[INFO] Exported ${archive.fileCount} file(s), ${archive.chunkCount} chunk(s), ${mb} MB.`);
                        setSogStatus(`Exported ${archive.chunkCount} chunk(s), ${archive.fileCount} files (${mb} MB).`);
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        console.error(`[ERROR] SOG export failed: ${message}`);
                        setSogStatus(`Export failed: ${message}`);
                    } finally {
                        sogBtn.disabled = false;
                        updateSogExportUi();
                    }
                });
            }
            // Background: detect large scenes (>1M splats) and recommend/auto-open
            // streamed export, per the default-slicing requirement.
            void (async () => {
                try {
                    const bytes = await readSplatBytes();
                    const bounds = await splatwalk.getSplatBounds(bytes, { mode: 2, prune_floaters: false } as MeshSettings);
                    const count = bounds.point_count;
                    maxChunkExtent = maxChunkExtentFromBounds({
                        min: bounds.oriented_min,
                        max: bounds.oriented_max,
                    });
                    applySogCaps();
                    const large = count > DEFAULT_AUTO_SLICE_THRESHOLD;
                    setSogStatus(
                        large
                            ? `${count.toLocaleString()} splats — large scene. Streamed LOD export recommended.`
                            : `${count.toLocaleString()} splats. Streamed or single SOG export available.`,
                        large,
                    );
                    if (large) {
                        const streamedRadio = sogModeRadios.find(r => r.value === 'streamed');
                        if (streamedRadio) streamedRadio.checked = true;
                        updateSogExportUi();
                        if (sogExportPanel && sogExportToggle && sogExportPanel.style.display === 'none') {
                            sogExportPanel.style.display = 'flex';
                            sogExportToggle.classList.add('open');
                        }
                    }
                } catch {
                    // Best-effort: status stays blank if bounds can't be computed yet.
                }
            })();

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

            // Shared post-worker tail: render the navmesh overlay, validate the
            // fast-path island, choose spawns, init the crowd and spawn the NPC. Used
            // identically by a fresh Recast build and by a cache hit so the two paths
            // can never drift. Deterministic in its inputs.
            const finishFastNavTail = async (
                artifact: { navMeshData: Uint8Array; debugPositions: Float32Array; debugIndices: Uint32Array },
                effectiveFastSeed: number[] | null,
                expectedFloorY: number | null,
                autoSpawnNpc: boolean,
            ): Promise<void> => {
                generatedNavData = artifact.navMeshData;
                navHasBeenGenerated = true;
                lastNavUsedFastPath = autoSpawnNpc;

                console.log("[WAIT] Rendering NavMesh visual overlay...");
                const visualNavmesh = { positions: artifact.debugPositions, indices: artifact.debugIndices, metadata: null as NavIslandMetadata | null };
                if (autoSpawnNpc) {
                    const safety = filterNavmeshIslandNearSeed(artifact.debugPositions, artifact.debugIndices, effectiveFastSeed);
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
                await viewer.initCrowd(artifact.navMeshData, spawnPoint);
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

            const runNavmeshFromCollider = async (autoSpawnNpc = false): Promise<void> => {
                console.log(autoSpawnNpc ? "[WAIT] Fast path: splat -> collider -> navmesh -> NPC..." : "[WAIT] Building navmesh from dedicated collider source...");
                const bytes = await readSplatBytes();

                // Cross-visit cache (FAST NAV only): a revisit of the same splat with
                // unchanged parameters restores the prior navmesh and skips the whole
                // parse/prune/field/Recast pipeline. The collision seed is a derived
                // output here (ensureFastCollisionSeed writes it back to the DOM), not
                // an input, so it is excluded from the key; everything else that steers
                // the result (mesh/prune/field params, rotation/flip, region, Recast
                // ladder) is captured via buildMeshSettings.
                let navCacheKey: string | null = null;
                if (autoSpawnNpc) {
                    try {
                        const sig: Record<string, unknown> = { ...buildMeshSettings(true) };
                        delete sig.collision_seed;
                        navCacheKey = buildNavmeshKey(bytes, { settings: sig, recast: FAST_NAV_RECAST_ATTEMPTS, preset: 'fast-nav-v1' });
                        const cached = await getNavmesh(navCacheKey);
                        if (cached) {
                            console.log("[SUCCESS] FAST NAV restored from cache — skipping parse/prune/field/Recast.");
                            if (cached.effectiveSeed) viewer.displaySeedMarker(cached.effectiveSeed);
                            await finishFastNavTail(cached, cached.effectiveSeed ?? null, cached.expectedFloorY ?? null, true);
                            return;
                        }
                        console.log("[INFO] No cached navmesh for this splat + settings; computing fresh.");
                    } catch (error) {
                        console.warn(`[WARN] Navmesh cache lookup skipped: ${error}`);
                    }
                }

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
                let geometry: { positions: Float32Array, indices: Uint32Array };
                let sourceLabel = 'generated_voxel_collider';
                let effectiveFastSeed = navSettings.collision_seed ?? fastSeed;

                if (autoSpawnNpc) {
                    // Shared, built-in adaptive recovery: escalate floor-field extraction
                    // parameters and retry instead of failing on sparse/large scenes.
                    const extracted = await extractFloorFieldWithRecovery({
                        bytes,
                        buildField: (b, s) => splatwalk.buildWalkableGroundField(b, s),
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
                    const artifact = generatedCollisionArtifact ?? await generateCollisionBoundaryFromSplat(
                        bytes,
                        toCollisionBoundarySettings(navSettings)
                    );
                    const boundary = artifact.result;
                    geometry = {
                        positions: new Float32Array(boundary.mesh.vertices),
                        indices: new Uint32Array(boundary.mesh.indices),
                    };
                    if (showColliderCheckbox) {
                        viewer.setColliderVisible(showColliderCheckbox.checked);
                    }

                    console.log(`[INFO] Using generated collision boundary as Recast input.`);
                    console.log(`[INFO] Collision boundary: ${boundary.mesh.vertex_count} vertices, ${boundary.mesh.face_count} faces.`);
                    if (boundary.diagnostics.collision_seed_used) {
                        viewer.displaySeedMarker(boundary.diagnostics.collision_seed_used);
                    }
                    if (boundary.diagnostics.collision_external_fill_leaked) {
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

                // Manual (GENERATE NAVMESH) params come from the Advanced Settings
                // inputs. The FAST NAV path uses the single shared source of truth in
                // fastNav.ts (FAST_NAV_RECAST_ATTEMPTS) so there is exactly one place
                // that defines the fast-nav Recast tuning.
                const params: RecastParams = {
                    cs: parseFloat((document.getElementById('paramNavCS') as HTMLInputElement).value),
                    ch: parseFloat((document.getElementById('paramNavCH') as HTMLInputElement).value),
                    walkableHeight: parseFloat((document.getElementById('paramNavHeight') as HTMLInputElement).value),
                    walkableRadius: parseFloat((document.getElementById('paramNavRadius') as HTMLInputElement).value),
                    walkableClimb: parseFloat((document.getElementById('paramNavClimb') as HTMLInputElement).value),
                    walkableSlopeAngle: parseFloat((document.getElementById('paramNavSlope') as HTMLInputElement).value),
                    maxEdgeLen: 12,
                    maxSimplificationError: 0.8,
                    minRegionArea: 2,
                    mergeRegionArea: 12,
                    maxVertsPerPoly: 6,
                    detailSampleDist: 6,
                    detailSampleMaxError: 1,
                    // Manual path honours the operator's literal Cell Size input.
                    autoCellSize: false,
                };

                const attempts: ReadonlyArray<{ label: string; params: RecastParams }> =
                    autoSpawnNpc ? FAST_NAV_RECAST_ATTEMPTS : [{ label: 'manual', params }];

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

                const expectedFloorY = autoSpawnNpc && effectiveFastSeed && navSettings.collision_carve_height
                    ? effectiveFastSeed[1] - navSettings.collision_carve_height * 0.5
                    : null;
                await finishFastNavTail(result, effectiveFastSeed ?? null, expectedFloorY, autoSpawnNpc);

                // Persist the validated fast-path artifact so an unchanged revisit of
                // this exact splat + settings restores it instead of recomputing the
                // multi-minute pipeline. Best-effort and only after the tail (incl.
                // island validation) succeeded, so a bad navmesh is never cached.
                if (autoSpawnNpc && navCacheKey) {
                    await putNavmesh(navCacheKey, {
                        navMeshData: result.navMeshData,
                        debugPositions: result.debugPositions,
                        debugIndices: result.debugIndices,
                        effectiveSeed: effectiveFastSeed ?? null,
                        expectedFloorY,
                    });
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
            const globalDownloadCollisionBtn = document.getElementById('downloadCollisionBtn') as HTMLButtonElement | null;
            const globalGenerateNavBtn = document.getElementById('generateNavBtn') as HTMLButtonElement | null;
            const globalGenerateCollisionBtn = document.getElementById('generateCollisionBtn') as HTMLButtonElement | null;
            const globalAddNpcBtn = document.getElementById('addNpcBtn') as HTMLButtonElement | null;
            if (globalGenerateCollisionBtn) {
                globalGenerateCollisionBtn.onclick = async () => {
                    try {
                        await generateCollisionBoundaryFromSplat(await readSplatBytes());
                    } catch (error) {
                        logError(`Collision boundary generation failed: ${error}`);
                    }
                };
            }
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
                    exportNavmeshBinary({
                        filename: `${file.name.replace(/\.(ply|spz|splat)$/i, "")}.nav`,
                        navMeshData: generatedNavData,
                    });
                    console.log("[Main] NavMesh binary download started.");
                };
            }
            if (globalDownloadCollisionBtn) {
                globalDownloadCollisionBtn.onclick = async () => {
                    if (!generatedCollisionArtifact) {
                        console.warn("[WARN] No collision boundary generated yet.");
                        return;
                    }
                    await exportCollisionBoundaryGlb({
                        artifact: generatedCollisionArtifact,
                        filename: `${file.name.replace(/\.(ply|spz|splat)$/i, "")}.collision.glb`,
                    });
                    console.log("[Main] Collision mesh GLB download started.");
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
                    environment_scale: viewer.getEnvironmentScale(),
                };

                if (includeRegion) {
                    const regionBounds = viewer.getRegionBounds();
                    settings.region_min = regionBounds?.min;
                    settings.region_max = regionBounds?.max;
                }

                return settings;
            };

            const generateCollisionBoundaryFromSplat = async (
                bytes: Uint8Array,
                settings = toCollisionBoundarySettings(buildMeshSettings(true))
            ): Promise<CollisionBoundaryArtifact> => {
                console.log("[WAIT] Generating collision voxel boundary...");
                const artifact = await generateCollisionBoundary({ bytes, settings });
                generatedCollisionArtifact = artifact;

                const opacity = Number.parseFloat(colliderOpacitySlider?.value ?? '0.35') || 0.35;
                const mesh = artifact.result.mesh;
                viewer.displayColliderMesh(
                    new Float32Array(mesh.vertices),
                    new Uint32Array(mesh.indices),
                    opacity
                );
                if (showColliderCheckbox) {
                    viewer.setColliderVisible(showColliderCheckbox.checked);
                }
                if (artifact.result.diagnostics.collision_seed_used) {
                    viewer.displaySeedMarker(artifact.result.diagnostics.collision_seed_used);
                }

                const downloadCollisionBtn = document.getElementById('downloadCollisionBtn') as HTMLButtonElement | null;
                if (downloadCollisionBtn) {
                    downloadCollisionBtn.style.display = 'block';
                }

                console.log(
                    `[SUCCESS] Collision voxel boundary generated: ${mesh.vertex_count} vertices, ${mesh.face_count} faces.`
                );
                console.log(`[INFO] Collision boundary diagnostics: ${collisionBoundaryDiagnosticsSummary(artifact.result.diagnostics)}`);
                return artifact;
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

            // Scale Environment: absolute uniform scale + optional nav realign
            const applyEnvironmentScaleBtn = document.getElementById('applyEnvironmentScaleBtn');
            if (applyEnvironmentScaleBtn) {
                applyEnvironmentScaleBtn.addEventListener('click', () => {
                    const input = document.getElementById('paramEnvironmentScale') as HTMLInputElement | null;
                    const scale = Number.parseFloat(input?.value ?? '');
                    if (!Number.isFinite(scale) || scale <= 0) {
                        console.warn('[WARN] Scale Environment must be a positive number.');
                        return;
                    }
                    const previous = viewer.getEnvironmentScale();
                    const ratio = scale / (previous > 0 ? previous : 1);

                    // Keep seed UI in world space alongside the scaled splat.
                    if (ratio !== 1) {
                        for (const id of ['paramCollisionSeedX', 'paramCollisionSeedY', 'paramCollisionSeedZ'] as const) {
                            const seedInput = document.getElementById(id) as HTMLInputElement | null;
                            if (!seedInput) continue;
                            const value = Number.parseFloat(seedInput.value);
                            if (Number.isFinite(value)) {
                                seedInput.value = (value * ratio).toFixed(3);
                            }
                        }
                        viewer.scaleRegionSelection(ratio);
                    }

                    viewer.setEnvironmentScale(scale);

                    // Imported collider buffers were captured in world space at import
                    // time; force a fresh read from the scaled mesh on rebuild.
                    importedColliderGeometry = null;
                    generatedCollisionArtifact = null;

                    if (navHasBeenGenerated) {
                        if (realignNavTimer) clearTimeout(realignNavTimer);
                        realignNavTimer = setTimeout(() => {
                            realignNavTimer = null;
                            console.log('[INFO] Environment scaled -- re-aligning navmesh to the new scale...');
                            runNavmeshFromCollider(lastNavUsedFastPath).catch((error) => {
                                logError(`Navmesh re-alignment after scale failed: ${error}`);
                            });
                        }, 350);
                    }
                });
            }

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
                                const name = file.name.replace(/\.(ply|spz|splat)$/i, "");
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
                        const generateCollisionBtn = document.getElementById('generateCollisionBtn') as HTMLButtonElement;
                        const downloadCollisionBtn = document.getElementById('downloadCollisionBtn') as HTMLButtonElement;
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

                        if (generateCollisionBtn) {
                            generateCollisionBtn.onclick = async () => {
                                try {
                                    await generateCollisionBoundaryFromSplat(bytes);
                                } catch (e) {
                                    logError(`Collision boundary generation failed: ${e}`);
                                }
                            };
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
                                exportNavmeshBinary({
                                    filename: `${file.name.replace(/\.(ply|spz|splat)$/i, "")}.nav`,
                                    navMeshData: generatedNavData,
                                });
                                console.log("[Main] NavMesh binary download started.");
                            };
                        }

                        if (downloadCollisionBtn) {
                            downloadCollisionBtn.onclick = async () => {
                                if (!generatedCollisionArtifact) return;
                                await exportCollisionBoundaryGlb({
                                    artifact: generatedCollisionArtifact,
                                    filename: `${file.name.replace(/\.(ply|spz|splat)$/i, "")}.collision.glb`,
                                });
                                console.log("[Main] Collision mesh GLB download started.");
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
                // Name the file from the URL's real extension so `.spz` / `.splat`
                // example scenes get normalized to PLY (handleFileLoad ->
                // normalizeSplatToPly) instead of being mis-read as raw PLY.
                const fileName = url.split('/').pop() || ((selectedOption.textContent?.split(' (')[0] ?? 'example') + ".ply");

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
