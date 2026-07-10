import { onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

import type { FreeCamera, Scene } from '@babylonjs/core';
import { Engine } from '@babylonjs/core/Engines/engine';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { FreeCamera as FreeCameraCtor } from '@babylonjs/core/Cameras/freeCamera';
import { Color3, Vector3 } from '@babylonjs/core/Maths/math';
import { Scene as BabylonScene } from '@babylonjs/core/scene';
import type { ISOGLODMetadata } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';
import '@babylonjs/loaders/SPLAT';

import {
  buildCollisionBoundarySettings,
  generateCollisionBoundary as generateCollisionBoundaryArtifact,
  seedFromRegionBounds,
} from '@/collision/voxelBoundary';
import {
  runFastNav,
  STREAMED_FAST_NAV_RECAST_ATTEMPTS,
  type FastNavPhase,
} from '@/navigation/fastNav';
import {
  DEFAULT_FAST_NAV_RECOVERY,
  type FastNavRecoveryConfig,
} from '@/navigation/floor';
import { Viewer } from '@/scene/Viewer';
import {
  DEFAULT_NAV_MAX_SPLATS,
  DEFAULT_NAV_MIN_SPLATS,
  deriveLodMetaRootUrl,
  materializeNavSourceFromStreamedSog,
  type StreamedBundleAccess,
} from '@/storage/materializeNavSourceFromStreamedSog';
import {
  loadCdnLodMeta,
  loadLocalSogZip,
  type SogLodManifestSummary,
} from '@/storage/sogStreamLoader';
import { splatwalk } from '@/wasm/bridge';

export type StorageDemoSource = 'cdn' | 'local';

export type StorageDemoNavPhase = FastNavPhase | 'idle' | 'materialize' | 'error';

/**
 * User-tunable Fast Nav overrides for the Storage Adapter streamed flow.
 * Applied on top of the outdoor recovery / Recast ladders.
 */
export interface StreamedNavSettings {
  /** Per-cell height band above reference floor (m). */
  cellBandAbove: number;
  /** Per-cell height band below reference floor (m). */
  cellBandBelow: number;
  /** Hole-fill radius in field cells. */
  holeFillRadius: number;
  /** Max local height variance for floor field (m). */
  maxLocalHeightVariance: number;
  /** Recast min region area (cells before squaring). */
  minRegionArea: number;
  /** Component-median band above seed floor (m) — widen for bowls/ramps. */
  sameLevelAbove: number;
  /** Component-median band below seed floor (m). */
  sameLevelBelow: number;
  /** SDF cell size (m); larger = coarser outdoor coverage. */
  sdfCellSize: number;
  /** SDF density threshold; lower accepts sparser ground. */
  sdfDensityThreshold: number;
  /** Recast max climb (m). */
  walkableClimb: number;
  /** Recast agent radius (m); smaller = less erosion. */
  walkableRadius: number;
  /** Recast max slope (degrees); higher for bowls/ramps. */
  walkableSlopeAngle: number;
}

/** Outdoor-friendly defaults (wider height bands + steeper slopes than indoor). */
export const DEFAULT_STREAMED_NAV_SETTINGS: StreamedNavSettings = {
  cellBandAbove: 2.5,
  cellBandBelow: 2.0,
  holeFillRadius: 4,
  maxLocalHeightVariance: 0.35,
  minRegionArea: 2,
  sameLevelAbove: 2.0,
  sameLevelBelow: 1.5,
  sdfCellSize: 0.2,
  sdfDensityThreshold: 0.03,
  walkableClimb: 0.65,
  walkableRadius: 0.35,
  walkableSlopeAngle: 55,
};

export interface UseStorageAdapterDemo {
  readonly busy: Ref<boolean>;
  readonly clear: () => void;
  readonly clearNavArtifacts: () => void;
  readonly debugShowingNavPly: Ref<boolean>;
  readonly errorMessage: Ref<string | null>;
  readonly fileCount: Ref<number | null>;
  readonly generateCollision: () => Promise<void>;
  readonly hasNavMesh: Ref<boolean>;
  readonly hasNavSession: Ref<boolean>;
  readonly hasStream: Ref<boolean>;
  readonly initScene: () => void;
  readonly loadCdn: (url: string) => Promise<void>;
  readonly loadZip: (file: File) => Promise<void>;
  readonly logs: Ref<readonly string[]>;
  readonly navMeshVisible: Ref<boolean>;
  readonly navPhase: Ref<StorageDemoNavPhase>;
  readonly navSettings: Ref<StreamedNavSettings>;
  readonly resetNavSettings: () => void;
  readonly resize: () => void;
  readonly restoreStreamVisual: () => void;
  readonly runFastNavFromStream: () => Promise<void>;
  readonly setNavMeshVisible: (visible: boolean) => void;
  readonly showDebugNavPly: () => Promise<void>;
  readonly statusMessage: Ref<string>;
  readonly summary: ShallowRef<SogLodManifestSummary | null>;
}

const KEY_W = 87;
const KEY_A = 65;
const KEY_S = 83;
const KEY_D = 68;
const KEY_E = 69;
const KEY_Q = 81;

const DEFAULT_FLY_SPEED = 2.5;
const DEFAULT_ANGULAR_SENSIBILITY = 2000;

/** Outdoor / large-scene recovery: lower room-floor area floors than indoor Fast Nav. */
const STREAMED_FAST_NAV_RECOVERY: FastNavRecoveryConfig = {
  steps: [
    ...DEFAULT_FAST_NAV_RECOVERY.steps.map((step) => ({
      ...step,
      minRoomFloorArea: Math.min(step.minRoomFloorArea ?? 4, 2.0),
      settings: {
        ...step.settings,
        sdf_density_threshold: Math.min(
          (step.settings?.sdf_density_threshold as number | undefined) ?? 0.08,
          0.04
        ),
      },
    })),
    {
      label: 'streamed-outdoor-last-resort',
      settings: {
        sdf_cell_size: 0.32,
        sdf_density_threshold: 0.015,
        max_local_height_variance: 0.45,
        min_floor_confidence: 0.001,
        voxel_target: 18000,
        hole_fill_radius: 5,
      },
      minRoomFloorArea: 0.75,
    },
  ],
};

const configureFlyCamera = (camera: FreeCamera, canvas: HTMLCanvasElement): void => {
  camera.attachControl(canvas, true);
  camera.speed = DEFAULT_FLY_SPEED;
  camera.angularSensibility = DEFAULT_ANGULAR_SENSIBILITY;
  camera.minZ = 0.1;
  camera.keysUp = [KEY_W];
  camera.keysDown = [KEY_S];
  camera.keysLeft = [KEY_A];
  camera.keysRight = [KEY_D];
  camera.keysUpward = [KEY_E];
  camera.keysDownward = [KEY_Q];
  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', () => {
    canvas.focus();
  });
};

const frameCameraToScene = (scene: Scene, camera: FreeCamera): void => {
  const worldExtends = scene.getWorldExtends();
  const center = worldExtends.min.add(worldExtends.max).scale(0.5);
  const size = worldExtends.max.subtract(worldExtends.min).length();
  const distance = Math.max(6, size * 0.65);
  camera.position = center.add(new Vector3(0, distance * 0.25, -distance));
  camera.setTarget(center);
  camera.speed = Math.max(0.5, distance * 0.04);
};

/**
 * Babylon scene + CDN / local-zip streamed SOG loading, with optional
 * materialize → collision / FastNav handoff onto {@link Viewer}.
 */
export const useStorageAdapterDemo = (
  canvasRef: Readonly<Ref<HTMLCanvasElement | null>>
): UseStorageAdapterDemo => {
  const busy = ref(false);
  const debugShowingNavPly = ref(false);
  const errorMessage = ref<string | null>(null);
  const fileCount = ref<number | null>(null);
  const hasNavMesh = ref(false);
  const hasNavSession = ref(false);
  const hasStream = ref(false);
  const logs = ref<string[]>([]);
  const navMeshVisible = ref(true);
  const navPhase = ref<StorageDemoNavPhase>('idle');
  const navSettings = ref<StreamedNavSettings>({ ...DEFAULT_STREAMED_NAV_SETTINGS });
  const statusMessage = ref('Ready — load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.');
  const summary = shallowRef<SogLodManifestSummary | null>(null);

  let engine: Engine | null = null;
  let scene: BabylonScene | null = null;
  let camera: FreeCamera | null = null;
  let localDispose: (() => void) | null = null;
  let viewer: Viewer | null = null;
  let streamManifest: ISOGLODMetadata | null = null;
  let streamAccess: StreamedBundleAccess | null = null;
  let cachedPly: Uint8Array | null = null;
  let cachedPlySplatCount = 0;

  const addLog = (message: string): void => {
    logs.value = [...logs.value, message].slice(-80);
  };

  const clearLocalResources = (): void => {
    if (localDispose) {
      localDispose();
      localDispose = null;
    }
  };

  const disposeViewer = (): void => {
    if (!viewer) {
      return;
    }
    viewer.getScene().getEngine().stopRenderLoop();
    viewer.getScene().getEngine().dispose();
    viewer = null;
    hasNavMesh.value = false;
    hasNavSession.value = false;
    navMeshVisible.value = true;
  };

  const initScene = (): void => {
    if (engine || viewer || !canvasRef.value) {
      return;
    }
    const canvas = canvasRef.value;
    engine = new Engine(canvas, true);
    scene = new BabylonScene(engine);
    scene.clearColor = new Color3(0.05, 0.05, 0.05).toColor4();

    camera = new FreeCameraCtor('flyCamera', new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());
    configureFlyCamera(camera, canvas);

    const light = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    engine.runRenderLoop(() => {
      scene?.render();
    });
    window.addEventListener('resize', resize);
    addLog('Babylon scene ready (WASD fly · E/Q up/down · mouse look)');
  };

  const resize = (): void => {
    if (viewer) {
      viewer.resize();
      return;
    }
    engine?.resize();
  };

  const clearSceneStreams = (): void => {
    clearLocalResources();
    if (!scene) {
      return;
    }
    for (const mesh of [...scene.meshes]) {
      const className = mesh.getClassName();
      if (
        className.includes('Gaussian') ||
        className.includes('Splatting') ||
        mesh.name === 'storageAdapterSogStream' ||
        mesh.name === 'GaussianSplattingStream'
      ) {
        mesh.dispose(false, true);
      }
    }
  };

  const resetStreamState = (): void => {
    streamManifest = null;
    streamAccess = null;
    cachedPly = null;
    cachedPlySplatCount = 0;
    hasStream.value = false;
    hasNavMesh.value = false;
    hasNavSession.value = false;
    navMeshVisible.value = true;
    summary.value = null;
    fileCount.value = null;
    navPhase.value = 'idle';
  };

  const clear = (): void => {
    disposeViewer();
    clearSceneStreams();
    resetStreamState();
    errorMessage.value = null;
    if (!engine && canvasRef.value) {
      initScene();
    }
    statusMessage.value = 'Cleared. Load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.';
    addLog('Scene cleared');
  };

  const clearNavArtifacts = (): void => {
    if (viewer) {
      disposeViewer();
      cachedPly = null;
      cachedPlySplatCount = 0;
      navPhase.value = 'idle';
      if (canvasRef.value) {
        initScene();
      }
      hasStream.value = false;
      statusMessage.value =
        'Nav artifacts cleared. Reload a CDN lod-meta or zip to stream again, then re-run Fast Nav.';
      addLog('Nav artifacts cleared (reload stream to continue)');
      return;
    }
    navPhase.value = 'idle';
    statusMessage.value = 'Nav artifacts cleared.';
    addLog('Nav artifacts cleared');
  };

  const loadCdn = async (url: string): Promise<void> => {
    disposeViewer();
    if (!scene || !camera) {
      initScene();
    }
    if (!scene || !camera) {
      throw new Error('Scene is not initialized.');
    }
    busy.value = true;
    errorMessage.value = null;
    statusMessage.value = 'Loading CDN lod-meta.json…';
    try {
      clearSceneStreams();
      resetStreamState();
      const result = await loadCdnLodMeta({
        lodMetaUrl: url,
        scene,
      });
      streamManifest = result.manifest;
      streamAccess = { kind: 'cdn', rootUrl: deriveLodMetaRootUrl(result.lodMetaUrl) };
      summary.value = result.summary;
      fileCount.value = result.summary.filenameCount;
      hasStream.value = true;
      frameCameraToScene(scene, camera);
      statusMessage.value = `CDN stream ready · ${result.summary.lodLevels} LOD levels · ${result.summary.filenameCount} chunks`;
      addLog(`Loaded CDN: ${url}`);
      addLog(
        `Manifest: lodLevels=${result.summary.lodLevels}, filenames=${result.summary.filenameCount}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      statusMessage.value = 'CDN load failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const loadZip = async (file: File): Promise<void> => {
    disposeViewer();
    if (!scene || !camera) {
      initScene();
    }
    if (!scene || !camera) {
      throw new Error('Scene is not initialized.');
    }
    busy.value = true;
    errorMessage.value = null;
    statusMessage.value = `Extracting ${file.name}…`;
    try {
      clearSceneStreams();
      resetStreamState();
      const result = await loadLocalSogZip({
        file,
        scene,
      });
      localDispose = result.dispose;
      streamManifest = result.manifest;
      streamAccess = { kind: 'memory', files: result.files };
      summary.value = result.summary;
      fileCount.value = result.fileCount;
      hasStream.value = true;
      frameCameraToScene(scene, camera);
      statusMessage.value = `Local zip stream ready · ${result.summary.lodLevels} LOD levels · ${result.fileCount} files`;
      addLog(`Loaded zip: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);
      addLog(
        `Manifest: lodLevels=${result.summary.lodLevels}, filenames=${result.summary.filenameCount}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      statusMessage.value = 'Zip load failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const ensureMaterializedPly = async (): Promise<Uint8Array> => {
    if (cachedPly && cachedPlySplatCount >= DEFAULT_NAV_MIN_SPLATS) {
      return cachedPly;
    }
    if (!streamManifest || !streamAccess) {
      throw new Error('Load a streamed SOG (CDN or zip) before generating collision / navmesh.');
    }
    const decodeScene = scene ?? viewer?.getScene() ?? null;
    if (!decodeScene) {
      throw new Error('Scene is not initialized for SOG decode.');
    }
    navPhase.value = 'materialize';
    statusMessage.value = 'Materializing nav PLY (intermediary for WASM; stream visual kept)…';
    const result = await materializeNavSourceFromStreamedSog({
      access: streamAccess,
      metadata: streamManifest,
      options: {
        lodIndex: 'nav',
        maxSplats: DEFAULT_NAV_MAX_SPLATS,
        minSplats: DEFAULT_NAV_MIN_SPLATS,
        onProgress: addLog,
      },
      scene: decodeScene,
    });
    cachedPly = result.plyBytes;
    cachedPlySplatCount = result.splatCount;
    addLog(
      `Materialized LOD ${result.lodIndexUsed}: ${result.splatCount} splats → PLY (nav intermediary)`
    );
    if (result.splatCount < DEFAULT_NAV_MIN_SPLATS) {
      addLog(
        `[WARN] Only ${result.splatCount} splats after finest LOD (target ${DEFAULT_NAV_MIN_SPLATS}). Floor extraction may still fail on sparse outdoor scans.`
      );
    }
    return cachedPly;
  };

  /**
   * Adopt the live stream scene into Viewer for nav overlays.
   * Materialized PLY is WASM-only — the streamed SOG visual stays on canvas.
   */
  const handoffStreamToViewer = async (): Promise<Viewer> => {
    const canvas = canvasRef.value;
    if (!canvas || !engine || !scene) {
      throw new Error('Stream scene is not ready for Viewer handoff.');
    }

    engine.stopRenderLoop();
    window.removeEventListener('resize', resize);

    if (camera) {
      camera.detachControl();
      camera.dispose();
      camera = null;
    }

    const adoptedEngine = engine;
    const adoptedScene = scene;
    engine = null;
    scene = null;

    await splatwalk.init();
    viewer = new Viewer(canvas, {
      existing: {
        engine: adoptedEngine,
        preserveVisual: true,
        scene: adoptedScene,
      },
    });
    window.addEventListener('resize', resize);

    if (!viewer.hasLoadedSplat()) {
      disposeViewer();
      if (canvasRef.value) {
        initScene();
      }
      throw new Error(
        'Viewer handoff failed: no streamed SOG meshes on the canvas. Reload the stream and try again.'
      );
    }
    viewer.assertGroundLooksYUp();
    viewer.resize();
    hasStream.value = true;
    hasNavSession.value = true;
    debugShowingNavPly.value = false;
    addLog(
      'Viewer handoff complete — streamed SOG kept on canvas; PLY used only for WASM nav.'
    );
    return viewer;
  };

  const ensureViewerWithPly = async (): Promise<{ plyBytes: Uint8Array; activeViewer: Viewer }> => {
    const plyBytes = await ensureMaterializedPly();
    if (viewer) {
      viewer.assertGroundLooksYUp();
      return { plyBytes, activeViewer: viewer };
    }
    const activeViewer = await handoffStreamToViewer();
    return { plyBytes, activeViewer };
  };

  const showDebugNavPly = async (): Promise<void> => {
    if (!viewer) {
      throw new Error('Run Fast Nav or collision first so the stream is adopted into the Viewer.');
    }
    const plyBytes = await ensureMaterializedPly();
    busy.value = true;
    errorMessage.value = null;
    try {
      statusMessage.value = 'Showing intermediary nav PLY (debug)…';
      await viewer.showDebugIntermediaryPly(plyBytes, { applySogLodOrientation: true });
      try {
        viewer.assertGroundLooksYUp();
      } catch (orientError) {
        const message = orientError instanceof Error ? orientError.message : String(orientError);
        addLog(`[WARN] ${message}`);
        errorMessage.value = message;
      }
      debugShowingNavPly.value = true;
      statusMessage.value =
        'Debug: intermediary nav PLY visible. Use Restore stream to return to the live SOG.';
      addLog('[DEBUG] Intermediary nav PLY shown (stream hidden).');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
    }
  };

  const restoreStreamVisual = (): void => {
    if (!viewer) {
      return;
    }
    viewer.restoreStreamVisual();
    debugShowingNavPly.value = false;
    statusMessage.value = 'Restored streamed SOG visual.';
    addLog('[DEBUG] Streamed SOG visual restored.');
  };

  const setNavMeshVisible = (visible: boolean): void => {
    navMeshVisible.value = visible;
    viewer?.setNavMeshVisible(visible);
  };

  const resetNavSettings = (): void => {
    navSettings.value = { ...DEFAULT_STREAMED_NAV_SETTINGS };
    addLog('[INFO] Navmesh settings reset to outdoor defaults.');
  };

  const generateCollision = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly();
      statusMessage.value = 'Generating voxel collision boundary…';
      const rotation = activeViewer.getSplatRotation();
      const settings = buildCollisionBoundarySettings({
        emitGlb: true,
        flipY: activeViewer.isSplatYFlipped(),
        rotation: [rotation.x, rotation.y, rotation.z],
        seed: seedFromRegionBounds({ regionBounds: activeViewer.getRegionBounds() }),
      });
      const artifact = await generateCollisionBoundaryArtifact({ bytes: plyBytes, settings });
      activeViewer.displayColliderMesh(
        artifact.result.mesh.vertices,
        artifact.result.mesh.indices,
        0.35
      );
      activeViewer.setColliderVisible(true);
      statusMessage.value = `Collision ready · ${artifact.result.mesh.vertex_count} verts · ${artifact.result.mesh.face_count} faces`;
      addLog(
        `[SUCCESS] Collision boundary: ${artifact.result.mesh.vertex_count} vertices, ${artifact.result.mesh.face_count} faces.`
      );
      navPhase.value = 'done';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      navPhase.value = 'error';
      statusMessage.value = 'Collision generation failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  const runFastNavFromStream = async (): Promise<void> => {
    busy.value = true;
    errorMessage.value = null;
    try {
      const { plyBytes, activeViewer } = await ensureViewerWithPly();
      const settings = navSettings.value;
      statusMessage.value = 'Running Fast Nav…';
      navPhase.value = 'prune';
      addLog(
        `[INFO] Nav settings: slope=${settings.walkableSlopeAngle}° radius=${settings.walkableRadius}m ` +
          `climb=${settings.walkableClimb}m band=±${settings.sameLevelBelow}/${settings.sameLevelAbove}m ` +
          `sdf=${settings.sdfCellSize}/${settings.sdfDensityThreshold}`
      );
      const fastNav = await runFastNav({
        viewer: activeViewer,
        bytes: plyBytes,
        onLog: addLog,
        onPhase: (next) => {
          navPhase.value = next;
        },
        recovery: STREAMED_FAST_NAV_RECOVERY,
        recastAttempts: STREAMED_FAST_NAV_RECAST_ATTEMPTS,
        meshSettings: {
          sdf_cell_size: settings.sdfCellSize,
          sdf_density_threshold: settings.sdfDensityThreshold,
          max_local_height_variance: settings.maxLocalHeightVariance,
          hole_fill_radius: settings.holeFillRadius,
        },
        floorMesh: {
          sameLevelBelow: settings.sameLevelBelow,
          sameLevelAbove: settings.sameLevelAbove,
          cellBandBelow: settings.cellBandBelow,
          cellBandAbove: settings.cellBandAbove,
        },
        recastOverrides: {
          walkableSlopeAngle: settings.walkableSlopeAngle,
          walkableRadius: settings.walkableRadius,
          walkableClimb: settings.walkableClimb,
          minRegionArea: settings.minRegionArea,
        },
      });
      statusMessage.value = 'Framing the player (top-down)…';
      const framing = activeViewer.focusOnPlayer();
      if (framing) {
        addLog(
          `[SUCCESS] Top-down view above player at ${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
        );
      } else {
        addLog('[WARN] focusOnPlayer returned null; leaving splat framing.');
      }
      activeViewer.resize();
      hasNavMesh.value = true;
      navMeshVisible.value = true;
      activeViewer.setNavMeshVisible(true);
      navPhase.value = 'done';
      statusMessage.value =
        'Fast Nav complete. Click the navmesh to move the player.';
      addLog(
        `[SUCCESS] Navmesh ready (${(fastNav.navMeshData.byteLength / 1024).toFixed(1)} KB).`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorMessage.value = message;
      navPhase.value = 'error';
      statusMessage.value = 'Fast Nav failed';
      addLog(`Error: ${message}`);
      throw error;
    } finally {
      busy.value = false;
      requestAnimationFrame(() => {
        resize();
      });
    }
  };

  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize);
    clearLocalResources();
    disposeViewer();
    engine?.dispose();
    engine = null;
    scene = null;
    camera = null;
  });

  return {
    busy,
    clear,
    clearNavArtifacts,
    debugShowingNavPly,
    errorMessage,
    fileCount,
    generateCollision,
    hasNavMesh,
    hasNavSession,
    hasStream,
    initScene,
    loadCdn,
    loadZip,
    logs,
    navMeshVisible,
    navPhase,
    navSettings,
    resetNavSettings,
    resize,
    restoreStreamVisual,
    runFastNavFromStream,
    setNavMeshVisible,
    showDebugNavPly,
    statusMessage,
    summary,
  };
};
