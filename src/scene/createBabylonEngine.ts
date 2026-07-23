/**
 * Create a Babylon engine with WebGPU preference and automatic WebGL fallback.
 *
 * WebGPU + Babylon Gaussian work-buffer MRT needs
 * `maxColorAttachmentBytesPerSample` ≥ {@link GS_WORK_BUFFER_COLOR_ATTACHMENT_BYTES_PER_SAMPLE}
 * (RGBA32Float + RGBA16Float + RGBA16Float + RGBA8Unorm = 40). CreateAsync must raise
 * device limits via `setMaximumLimits` (or equivalent `requiredLimits`); the WebGPU
 * default of 32 rejects the gsWorkBuffer pipeline.
 */

import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Engine } from '@babylonjs/core/Engines/engine';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';

export type BabylonRendererPreference = 'webgl' | 'webgpu';
export type BabylonRendererActual = 'webgl' | 'webgpu';

export interface CreateBabylonEngineParams {
  readonly canvas: HTMLCanvasElement;
  readonly preference?: BabylonRendererPreference;
}

export interface CreateBabylonEngineResult {
  readonly engine: AbstractEngine;
  readonly fallbackFromWebgpu: boolean;
  readonly renderer: BabylonRendererActual;
}

/** Bytes/sample required by Babylon GS `gsWorkBuffer` MRT color attachments. */
export const GS_WORK_BUFFER_COLOR_ATTACHMENT_BYTES_PER_SAMPLE = 40;

const createWebGlEngine = (canvas: HTMLCanvasElement): Engine => new Engine(canvas, true);

const fallbackWebGl = (canvas: HTMLCanvasElement): CreateBabylonEngineResult => ({
  engine: createWebGlEngine(canvas),
  fallbackFromWebgpu: true,
  renderer: 'webgl',
});

/**
 * Adapter limit for GS work-buffer MRT, or null if WebGPU/adapter is unavailable.
 */
const readAdapterMaxColorAttachmentBytesPerSample = async (): Promise<number | null> => {
  const gpu = navigator.gpu;
  if (!gpu) {
    return null;
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return null;
    }
    return adapter.limits.maxColorAttachmentBytesPerSample;
  } catch {
    return null;
  }
};

/**
 * Parse `?renderer=webgpu|webgl` from a search string. Invalid/missing → webgpu.
 */
export const parseRendererPreference = (
  search: string = typeof window !== 'undefined' ? window.location.search : ''
): BabylonRendererPreference => {
  const raw = new URLSearchParams(search).get('renderer')?.trim().toLowerCase();
  if (raw === 'webgl') {
    return 'webgl';
  }
  return 'webgpu';
};

/**
 * Create a Babylon engine. WebGPU preference falls back to WebGL when unsupported,
 * when the adapter cannot host the GS work-buffer MRT color-attachment budget, or
 * when {@link WebGPUEngine.CreateAsync} throws.
 *
 * WebGPU path uses `setMaximumLimits: true` so `maxColorAttachmentBytesPerSample`
 * matches the adapter (needed for Babylon `gsWorkBuffer`).
 */
export const createBabylonEngine = async (
  params: CreateBabylonEngineParams
): Promise<CreateBabylonEngineResult> => {
  const preference = params.preference ?? 'webgpu';
  if (preference === 'webgl') {
    return {
      engine: createWebGlEngine(params.canvas),
      fallbackFromWebgpu: false,
      renderer: 'webgl',
    };
  }

  const supported = await WebGPUEngine.IsSupportedAsync;
  if (!supported) {
    console.warn('[SplatWalk] WebGPU unsupported — falling back to WebGL');
    return fallbackWebGl(params.canvas);
  }

  const maxColorAttachmentBytes = await readAdapterMaxColorAttachmentBytesPerSample();
  if (
    maxColorAttachmentBytes !== null &&
    maxColorAttachmentBytes < GS_WORK_BUFFER_COLOR_ATTACHMENT_BYTES_PER_SAMPLE
  ) {
    console.warn(
      `[SplatWalk] WebGPU adapter maxColorAttachmentBytesPerSample=` +
        `${maxColorAttachmentBytes} < ${GS_WORK_BUFFER_COLOR_ATTACHMENT_BYTES_PER_SAMPLE} ` +
        `(Babylon GS work-buffer MRT) — falling back to WebGL`
    );
    return fallbackWebGl(params.canvas);
  }

  let webgpu: WebGPUEngine | null = null;
  try {
    webgpu = await WebGPUEngine.CreateAsync(params.canvas, {
      antialias: true,
      setMaximumLimits: true,
    });
    return {
      engine: webgpu,
      fallbackFromWebgpu: false,
      renderer: 'webgpu',
    };
  } catch (error) {
    try {
      webgpu?.dispose();
    } catch {
      // ignore dispose errors on a failed WebGPU init
    }
    console.warn('[SplatWalk] WebGPU init failed — falling back to WebGL', error);
    return fallbackWebGl(params.canvas);
  }
};
