/**
 * Per-example and per-algo collision scene type for Fast Nav demos.
 */

import type { CollisionSceneType, NavGenerationMode } from '@/navigation/voxelNavSettings';

export type ExampleCollisionSceneType = Extract<CollisionSceneType, 'indoor' | 'outdoor'>;

/**
 * Resolve effective collision scene type for a nav algo.
 * Honors the demo/example selection for every algo (including SDF-MC).
 */
export const collisionSceneTypeForAlgo = (params: {
  readonly algo: NavGenerationMode;
  readonly exampleSceneType?: ExampleCollisionSceneType | null;
}): ExampleCollisionSceneType => params.exampleSceneType ?? 'indoor';
