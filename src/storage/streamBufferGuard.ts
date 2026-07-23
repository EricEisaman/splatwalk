/**
 * Hard-fail when {@link GaussianSplattingStream} allocates an unbounded work buffer.
 */

import type { GaussianSplattingStream } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';
import {
  readStreamResidencyStats,
  type StreamResidencyStats,
} from './streamResidency';

const CAPACITY_OVER_BUDGET_RATIO = 1.25;

export class UnboundedStreamBufferError extends Error {
  readonly stats: StreamResidencyStats;

  constructor(stats: StreamResidencyStats) {
    super(
      `Stream work buffer unbounded: capacity ${stats.bufferCapacity.toLocaleString()} · ` +
        `budget ${stats.maxResidentSplats.toLocaleString()} · eviction ${
          stats.evictionEnabled ? 'on' : 'off'
        }. Refuse to fly — reload with a non-zero resident budget.`
    );
    this.name = 'UnboundedStreamBufferError';
    this.stats = stats;
  }
}

/**
 * Throw when eviction is off or capacity far exceeds the resident budget.
 */
export const assertStreamBufferBounded = (
  stream: GaussianSplattingStream,
  catalogFiles: number,
  skippedBudgetWarnings = 0
): StreamResidencyStats => {
  const stats = readStreamResidencyStats(stream, catalogFiles, skippedBudgetWarnings);
  const budget = stats.maxResidentSplats;
  if (budget <= 0) {
    throw new UnboundedStreamBufferError(stats);
  }
  if (stats.bufferCapacity <= 0 && stats.catalogSplatEstimate > 0) {
    throw new UnboundedStreamBufferError(stats);
  }
  if (!stats.evictionEnabled && stats.catalogSplatEstimate > budget) {
    throw new UnboundedStreamBufferError(stats);
  }
  if (stats.bufferCapacity > budget * CAPACITY_OVER_BUDGET_RATIO) {
    throw new UnboundedStreamBufferError(stats);
  }
  return stats;
};
