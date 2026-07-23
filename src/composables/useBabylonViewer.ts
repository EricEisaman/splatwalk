import { onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue';

import {
  parseRendererPreference,
  type BabylonRendererActual,
  type BabylonRendererPreference,
} from '@/scene/createBabylonEngine';
import { Viewer } from '@/scene/Viewer';

/** Options forwarded to the {@link Viewer} on creation. */
export interface UseBabylonViewerOptions {
  /** Preferred renderer (WebGPU falls back to WebGL). Default from `?renderer=`. */
  readonly renderer?: BabylonRendererPreference;
  /** Render in a right-handed scene (`scene.useRightHandedSystem`). Off by default. */
  readonly rightHanded?: boolean;
}

/** Reactive handle around a {@link Viewer} bound to a canvas element. */
export interface UseBabylonViewer {
  /** Active backend after engine create (`webgl` / `webgpu`), or null before init. */
  readonly activeRenderer: Ref<BabylonRendererActual | null>;
  /** Create the viewer on the bound canvas (async — may init WebGPU). */
  readonly initViewer: () => Promise<Viewer>;
  /** Tear down the Babylon engine and release the viewer. */
  readonly dispose: () => void;
  /** Preferred backend; changing via {@link setRendererPreference} recreates the engine. */
  readonly rendererPreference: Ref<BabylonRendererPreference>;
  /** Dispose and recreate with a new renderer preference (clears the scene). */
  readonly setRendererPreference: (preference: BabylonRendererPreference) => Promise<void>;
  /** The live viewer instance, or `null` until {@link initViewer} runs. */
  readonly viewer: ShallowRef<Viewer | null>;
}

/**
 * Manage the lifecycle of a Babylon {@link Viewer} for the given canvas ref.
 * The engine is disposed automatically when the host component unmounts.
 */
export function useBabylonViewer(
  canvasRef: Readonly<Ref<HTMLCanvasElement | null>>,
  options: UseBabylonViewerOptions = {}
): UseBabylonViewer {
  const viewer = shallowRef<Viewer | null>(null);
  const rendererPreference = ref<BabylonRendererPreference>(
    options.renderer ?? parseRendererPreference()
  );
  const activeRenderer = ref<BabylonRendererActual | null>(null);
  let initInFlight: Promise<Viewer> | null = null;

  const dispose = (): void => {
    const instance = viewer.value;
    if (!instance) {
      return;
    }
    instance.getScene().getEngine().dispose();
    viewer.value = null;
    activeRenderer.value = null;
  };

  const initViewer = async (): Promise<Viewer> => {
    if (viewer.value) {
      return viewer.value;
    }
    if (initInFlight) {
      return initInFlight;
    }
    const canvas = canvasRef.value;
    if (!canvas) {
      throw new Error('Cannot initialize viewer: canvas element is not mounted yet.');
    }
    const preference = rendererPreference.value;
    initInFlight = Viewer.create(canvas, {
      renderer: preference,
      rightHanded: options.rightHanded ?? false,
    }).then((instance) => {
      viewer.value = instance;
      const engine = instance.getScene().getEngine();
      activeRenderer.value = engine.isWebGPU ? 'webgpu' : 'webgl';
      if (import.meta.env.DEV) {
        (globalThis as unknown as { __splatViewer?: Viewer }).__splatViewer = instance;
      }
      initInFlight = null;
      return instance;
    });
    try {
      return await initInFlight;
    } catch (error) {
      initInFlight = null;
      throw error;
    }
  };

  const setRendererPreference = async (
    preference: BabylonRendererPreference
  ): Promise<void> => {
    if (rendererPreference.value === preference && viewer.value) {
      return;
    }
    rendererPreference.value = preference;
    dispose();
    await initViewer();
  };

  onBeforeUnmount(dispose);

  return {
    activeRenderer,
    initViewer,
    dispose,
    rendererPreference,
    setRendererPreference,
    viewer,
  };
}
