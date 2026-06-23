import { onBeforeUnmount, shallowRef, type Ref, type ShallowRef } from 'vue';

import { Viewer } from '@/scene/Viewer';

/** Options forwarded to the {@link Viewer} on creation. */
export interface UseBabylonViewerOptions {
  /** Render in a right-handed scene (`scene.useRightHandedSystem`). Off by default. */
  readonly rightHanded?: boolean;
}

/** Reactive handle around a {@link Viewer} bound to a canvas element. */
export interface UseBabylonViewer {
  /** The live viewer instance, or `null` until {@link initViewer} runs. */
  readonly viewer: ShallowRef<Viewer | null>;
  /** Create the viewer on the bound canvas. Safe to call once the canvas is mounted. */
  readonly initViewer: () => Viewer;
  /** Tear down the Babylon engine and release the viewer. */
  readonly dispose: () => void;
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

  const initViewer = (): Viewer => {
    if (viewer.value) {
      return viewer.value;
    }
    const canvas = canvasRef.value;
    if (!canvas) {
      throw new Error('Cannot initialize viewer: canvas element is not mounted yet.');
    }
    const instance = new Viewer(canvas, { rightHanded: options.rightHanded ?? false });
    viewer.value = instance;
    // Dev-only handle so the handedness regression scene can be verified from the
    // page (splat vs navmesh world bounds). Never exposed in production builds.
    if (import.meta.env.DEV) {
      (globalThis as unknown as { __splatViewer?: Viewer }).__splatViewer = instance;
    }
    return instance;
  };

  const dispose = (): void => {
    const instance = viewer.value;
    if (!instance) {
      return;
    }
    instance.getScene().getEngine().dispose();
    viewer.value = null;
  };

  onBeforeUnmount(dispose);

  return { viewer, initViewer, dispose };
}
