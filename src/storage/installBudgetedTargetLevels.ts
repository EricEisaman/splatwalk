/**
 * After distance LOD targets are computed, degrade farthest nodes until the
 * unique resident file set fits under the stream resident budget.
 */

import type { GaussianSplattingStream } from '@babylonjs/loaders/SPLAT/gaussianSplattingStream';

interface LodEntry {
  file?: number;
}

interface LeafNode {
  availableLevels?: number[];
  baseLod?: number;
  bound?: { max: number[]; min: number[] };
  lods?: Record<string, LodEntry>;
  optimalLod?: number;
  targetLevel?: number;
}

interface StreamBudgetInternals {
  _computeTargetLevels?: () => void;
  _fileCounts?: Map<number, number>;
  _frameBudgetedTargetsInstalled?: boolean;
  _leafNodes?: LeafNode[];
  _residentBudget?: number;
  _cappedLevelForNode?: (node: LeafNode, desired: number) => number;
}

const nodeCenterDistanceSq = (node: LeafNode, cx: number, cy: number, cz: number): number => {
  const mn = node.bound?.min;
  const mx = node.bound?.max;
  if (!mn || !mx) {
    return 0;
  }
  const px = (mn[0]! + mx[0]!) * 0.5;
  const py = (mn[1]! + mx[1]!) * 0.5;
  const pz = (mn[2]! + mx[2]!) * 0.5;
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return dx * dx + dy * dy + dz * dz;
};

const fileForLevel = (node: LeafNode, level: number): number | undefined =>
  node.lods?.[String(level)]?.file;

const estimateUniqueSplatCount = (
  nodes: readonly LeafNode[],
  fileCounts: Map<number, number>
): number => {
  const files = new Set<number>();
  for (const node of nodes) {
    const level = node.targetLevel ?? node.baseLod ?? 0;
    const fileId = fileForLevel(node, level);
    if (fileId !== undefined) {
      files.add(fileId);
    }
  }
  let total = 0;
  for (const fileId of files) {
    total += fileCounts.get(fileId) ?? 0;
  }
  return total;
};

const coarsenNodeOneStep = (
  stream: StreamBudgetInternals,
  node: LeafNode
): boolean => {
  const levels = node.availableLevels;
  if (!levels?.length) {
    return false;
  }
  const current = node.targetLevel ?? node.baseLod ?? 0;
  let next: number | null = null;
  for (const level of levels) {
    if (level > current && (next === null || level < next)) {
      next = level;
    }
  }
  if (next === null) {
    return false;
  }
  node.targetLevel = stream._cappedLevelForNode
    ? stream._cappedLevelForNode(node, next)
    : next;
  return (node.targetLevel ?? current) !== current;
};

/**
 * Wrap `_computeTargetLevels` so drawn LOD stays under `_residentBudget`.
 */
export const installBudgetedTargetLevels = (stream: GaussianSplattingStream): void => {
  const internals = stream as unknown as StreamBudgetInternals;
  if (internals._frameBudgetedTargetsInstalled) {
    return;
  }
  const original = internals._computeTargetLevels?.bind(stream);
  if (!original) {
    console.warn(
      '[Stream] Missing _computeTargetLevels; cannot install budgeted target selection.'
    );
    return;
  }
  internals._frameBudgetedTargetsInstalled = true;
  internals._computeTargetLevels = () => {
    original();
    const nodes = internals._leafNodes;
    const fileCounts = internals._fileCounts;
    const budget = internals._residentBudget ?? 0;
    if (!nodes?.length || !fileCounts || budget <= 0) {
      return;
    }
    let total = estimateUniqueSplatCount(nodes, fileCounts);
    if (total <= budget) {
      return;
    }
    const camera = stream.getScene().activeCamera;
    const cx = camera?.globalPosition.x ?? 0;
    const cy = camera?.globalPosition.y ?? 0;
    const cz = camera?.globalPosition.z ?? 0;
    const ranked = nodes
      .map((node, index) => ({
        index,
        distSq: nodeCenterDistanceSq(node, cx, cy, cz),
      }))
      .sort((a, b) => b.distSq - a.distSq);
    let guard = nodes.length * 8;
    while (total > budget && guard > 0) {
      guard -= 1;
      let progressed = false;
      for (const entry of ranked) {
        if (total <= budget) {
          break;
        }
        const node = nodes[entry.index]!;
        if (!coarsenNodeOneStep(internals, node)) {
          continue;
        }
        progressed = true;
        total = estimateUniqueSplatCount(nodes, fileCounts);
      }
      if (!progressed) {
        break;
      }
    }
  };
};
