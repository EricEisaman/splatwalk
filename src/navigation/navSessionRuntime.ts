/**
 * Freeze streamed SOG LOD work during an active nav session so explore does not
 * re-decode gigabytes of splats on every camera orbit. This targets
 * GaussianSplattingStream main-thread pressure only; it does not touch
 * collider/nav overlay visibility.
 */

import type { Scene } from '@babylonjs/core';
import type { GaussianSplattingStream } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

interface StreamPatchInternals {
  _lodBaseDistance?: number;
  _maxConcurrentDownloads?: number;
  _maxDecodesPerFrame?: number;
  _residentBudget?: number;
}

interface StreamSnapshot {
  lodBaseDistance: number;
  maxConcurrentDownloads: number;
  maxDecodesPerFrame: number;
  residentBudget: number;
}

export interface NavSessionRuntimeOptions {
  readonly onLog?: (message: string) => void;
  readonly scene: Scene;
}

/** Locate the live {@link GaussianSplattingStream} mesh in an adopted scene. */
export const findGaussianStreamInScene = (scene: Scene): GaussianSplattingStream | null => {
  for (const mesh of scene.meshes) {
    if (mesh.name === 'GaussianSplattingStream' || mesh.getClassName().includes('GaussianSplatting')) {
      return mesh as GaussianSplattingStream;
    }
  }
  return null;
};

const readStreamSnapshot = (stream: GaussianSplattingStream): StreamSnapshot => {
  const internals = stream as unknown as StreamPatchInternals;
  return {
    lodBaseDistance: internals._lodBaseDistance ?? 10,
    maxConcurrentDownloads: internals._maxConcurrentDownloads ?? 2,
    maxDecodesPerFrame: internals._maxDecodesPerFrame ?? 1,
    residentBudget: internals._residentBudget ?? 0,
  };
};

const applyStreamSnapshot = (stream: GaussianSplattingStream, snapshot: StreamSnapshot): void => {
  const internals = stream as unknown as StreamPatchInternals;
  internals._lodBaseDistance = snapshot.lodBaseDistance;
  internals._maxConcurrentDownloads = snapshot.maxConcurrentDownloads;
  internals._maxDecodesPerFrame = snapshot.maxDecodesPerFrame;
  if (snapshot.residentBudget > 0) {
    internals._residentBudget = snapshot.residentBudget;
  }
};

const freezeStreamForNavSession = (stream: GaussianSplattingStream): StreamSnapshot => {
  const original = readStreamSnapshot(stream);
  const internals = stream as unknown as StreamPatchInternals;
  internals._maxDecodesPerFrame = 0;
  internals._maxConcurrentDownloads = 0;
  internals._lodBaseDistance = original.lodBaseDistance * 3;
  return original;
};

export class NavSessionRuntimeController {
  private readonly options: NavSessionRuntimeOptions;
  private stream: GaussianSplattingStream | null = null;
  private streamOriginal: StreamSnapshot | null = null;

  constructor(options: NavSessionRuntimeOptions) {
    this.options = options;
  }

  attach(stream: GaussianSplattingStream | null): void {
    this.stream = stream;
    if (stream) {
      this.streamOriginal = freezeStreamForNavSession(stream);
      this.options.onLog?.(
        '[INFO] Nav session: stream LOD frozen (no decode/eviction while exploring).'
      );
    }
  }

  dispose(): void {
    if (this.stream && this.streamOriginal) {
      applyStreamSnapshot(this.stream, this.streamOriginal);
    }
    this.stream = null;
    this.streamOriginal = null;
  }

  /** Crowd always runs — freezes are not caused by Recast agent sync. */
  shouldSkipCrowdUpdate(): boolean {
    return false;
  }

  syncColliderVisibility(): void {
    // No-op: collider visibility is user-controlled only.
  }
}
