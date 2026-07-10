import { onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

import type { FreeCamera, Scene } from '@babylonjs/core';
import { Engine } from '@babylonjs/core/Engines/engine';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { FreeCamera as FreeCameraCtor } from '@babylonjs/core/Cameras/freeCamera';
import { Color3, Vector3 } from '@babylonjs/core/Maths/math';
import { Scene as BabylonScene } from '@babylonjs/core/scene';
import '@babylonjs/loaders/SPLAT';

import {
  loadCdnLodMeta,
  loadLocalSogZip,
  type SogLodManifestSummary,
} from '@/storage/sogStreamLoader';

export type StorageDemoSource = 'cdn' | 'local';

export interface UseStorageAdapterDemo {
  readonly busy: Ref<boolean>;
  readonly clear: () => void;
  readonly errorMessage: Ref<string | null>;
  readonly fileCount: Ref<number | null>;
  readonly initScene: () => void;
  readonly loadCdn: (url: string) => Promise<void>;
  readonly loadZip: (file: File) => Promise<void>;
  readonly logs: Ref<readonly string[]>;
  readonly resize: () => void;
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

const configureFlyCamera = (camera: FreeCamera, canvas: HTMLCanvasElement): void => {
  camera.attachControl(canvas, true);
  camera.speed = DEFAULT_FLY_SPEED;
  camera.angularSensibility = DEFAULT_ANGULAR_SENSIBILITY;
  camera.minZ = 0.1;
  // WASD move / strafe; E up / Q down
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
 * Babylon scene + CDN / local-zip streamed SOG loading for the storage-adapter showcase.
 */
export const useStorageAdapterDemo = (
  canvasRef: Readonly<Ref<HTMLCanvasElement | null>>
): UseStorageAdapterDemo => {
  const busy = ref(false);
  const errorMessage = ref<string | null>(null);
  const fileCount = ref<number | null>(null);
  const logs = ref<string[]>([]);
  const statusMessage = ref('Ready — load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.');
  const summary = shallowRef<SogLodManifestSummary | null>(null);

  let engine: Engine | null = null;
  let scene: BabylonScene | null = null;
  let camera: FreeCamera | null = null;
  let localDispose: (() => void) | null = null;

  const addLog = (message: string): void => {
    logs.value = [...logs.value, message].slice(-80);
  };

  const clearLocalResources = (): void => {
    if (localDispose) {
      localDispose();
      localDispose = null;
    }
  };

  const initScene = (): void => {
    if (engine || !canvasRef.value) {
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

  const clear = (): void => {
    clearSceneStreams();
    summary.value = null;
    fileCount.value = null;
    errorMessage.value = null;
    statusMessage.value = 'Cleared. Load a CDN lod-meta.json URL or a SplatWalk SOD LOD zip.';
    addLog('Scene cleared');
  };

  const loadCdn = async (url: string): Promise<void> => {
    if (!scene || !camera) {
      throw new Error('Scene is not initialized.');
    }
    busy.value = true;
    errorMessage.value = null;
    statusMessage.value = 'Loading CDN lod-meta.json…';
    try {
      clearSceneStreams();
      const result = await loadCdnLodMeta({
        lodMetaUrl: url,
        scene,
      });
      summary.value = result.summary;
      fileCount.value = result.summary.filenameCount;
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
    if (!scene || !camera) {
      throw new Error('Scene is not initialized.');
    }
    busy.value = true;
    errorMessage.value = null;
    statusMessage.value = `Extracting ${file.name}…`;
    try {
      clearSceneStreams();
      const result = await loadLocalSogZip({
        file,
        scene,
      });
      localDispose = result.dispose;
      summary.value = result.summary;
      fileCount.value = result.fileCount;
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

  onBeforeUnmount(() => {
    window.removeEventListener('resize', resize);
    clearLocalResources();
    engine?.dispose();
    engine = null;
    scene = null;
    camera = null;
  });

  return {
    busy,
    clear,
    errorMessage,
    fileCount,
    initScene,
    loadCdn,
    loadZip,
    logs,
    resize,
    statusMessage,
    summary,
  };
};
