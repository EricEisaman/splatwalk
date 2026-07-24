/**
 * Global vertical shift of all navmesh vertices.
 */

import { NAVMESH_EDITOR_GLOBAL_Y_STEP_M } from './types';

export const shiftAllVerticesY = (
  positions: Float32Array,
  deltaY: number
): void => {
  for (let i = 1; i < positions.length; i += 3) {
    positions[i]! += deltaY;
  }
};

export const shiftAllVerticesYByStep = (
  positions: Float32Array,
  steps: number,
  stepM: number = NAVMESH_EDITOR_GLOBAL_Y_STEP_M
): void => {
  shiftAllVerticesY(positions, steps * stepM);
};
