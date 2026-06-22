declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Object3D } from 'three';

  export enum SceneFormat {
    Splat = 0,
    KSplat = 1,
    Ply = 2,
    Spz = 3,
  }

  export interface AddSplatSceneOptions {
    format?: SceneFormat;
    showLoadingUI?: boolean;
    progressiveLoad?: boolean;
    position?: number[];
    rotation?: number[];
    scale?: number[];
    splatAlphaRemovalThreshold?: number;
  }

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
    dynamicScene?: boolean;
    [key: string]: unknown;
  }

  export class DropInViewer extends Object3D {
    constructor(options?: DropInViewerOptions);
    addSplatScene(url: string, options?: AddSplatSceneOptions): Promise<void>;
    addSplatScenes(scenes: Array<{ path: string } & AddSplatSceneOptions>, showLoadingUI?: boolean): Promise<void>;
    removeSplatScene(index: number): Promise<void>;
    dispose(): Promise<void>;
  }
}
