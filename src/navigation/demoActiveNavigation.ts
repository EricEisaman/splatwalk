/**
 * Shared Active-mode intent + hot-swap orchestration for demo hosts.
 */

import {
  activateNavBackend,
  activeNavigationModeLabel,
  initialLiveBackendForActiveMode,
  isActiveModeAvailable,
  liveNavBackendLabel,
  navCapabilitiesFromParts,
  type ActiveNavigationMode,
  type LiveNavBackend,
  type NavCapabilities,
} from '@/navigation/activeNavigation';
import type { Viewer } from '@/scene/Viewer';
import type { CollisionVoxelVolume } from '@/wasm/bridge';

/** Host-specific Live backend activator (Babylon Viewer or R3F controller). */
export type ActivateLiveNavBackend = (params: {
  readonly backend: Exclude<LiveNavBackend, 'none'>;
  readonly onLog: (message: string) => void;
  readonly recastBin?: Uint8Array | null;
  readonly seed?: readonly number[] | null;
  readonly spawnHint?: readonly [number, number, number] | null;
  readonly volume?: CollisionVoxelVolume | null;
}) => Promise<{ readonly liveBackend: Exclude<LiveNavBackend, 'none'> }>;

export interface ResolveActiveNavigationChangeParams {
  /** Optional host activator; when set, Viewer is not required for hot-swap. */
  readonly activateBackend?: ActivateLiveNavBackend;
  /** Optional; ignored for gating — caps are derived from volume / recastBin. */
  readonly caps?: NavCapabilities;
  readonly liveBackend: LiveNavBackend;
  readonly mode: ActiveNavigationMode;
  readonly onLog?: (message: string) => void;
  readonly previousMode: ActiveNavigationMode;
  readonly recastBin?: Uint8Array | null;
  readonly seed?: readonly number[] | null;
  readonly spawnHint?: readonly [number, number, number] | null;
  readonly viewer: Viewer | null;
  readonly volume?: CollisionVoxelVolume | null;
}

export interface ResolveActiveNavigationChangeResult {
  /** True when intent is stored or live locomotion matches the requested mode. */
  readonly applied: boolean;
  /** When {@link applied} is false, human-readable reason for UI snackbars. */
  readonly failureMessage?: string;
  readonly liveBackend: LiveNavBackend;
  readonly mode: ActiveNavigationMode;
  /** When {@link applied} is false, Active UI should revert to this mode. */
  readonly revertToMode?: ActiveNavigationMode;
}

/** Active UI mode that matches a live backend (for revert after failed swap). */
export const activeModeMatchingLiveBackend = (
  liveBackend: LiveNavBackend
): ActiveNavigationMode => {
  if (liveBackend === 'voxel_walk') {
    return 'voxel_mesh';
  }
  return 'recast';
};

/** Snackbar / warn copy when hot-swap cannot apply. */
export const activeNavigationHotSwapFailureMessage = (params: {
  readonly caps: NavCapabilities;
  readonly detail?: string;
  readonly mode: ActiveNavigationMode;
}): string => {
  if (params.detail) {
    return `Could not switch Live locomotion — ${params.detail}`;
  }
  const missing: string[] = [];
  if (
    (params.mode === 'voxel_mesh' || params.mode === 'recast_and_voxel_mesh') &&
    !params.caps.hasVolume
  ) {
    missing.push('volume');
  }
  if (
    (params.mode === 'recast' || params.mode === 'recast_and_voxel_mesh') &&
    !params.caps.hasRecast
  ) {
    missing.push('Recast navmesh');
  }
  if (missing.length > 0) {
    return (
      `Could not switch Live locomotion — missing ${missing.join(' and ')}. ` +
      'Re-run Nav under Voxel / SDF-MC with volume, then try again.'
    );
  }
  return (
    'Could not switch Live locomotion — missing volume or Recast assets. ' +
    'Re-run Nav under Voxel / SDF-MC with volume, then try again.'
  );
};

const failResult = (
  liveBackend: LiveNavBackend,
  previousMode: ActiveNavigationMode,
  failureMessage: string
): ResolveActiveNavigationChangeResult => ({
  applied: false,
  failureMessage,
  liveBackend,
  mode: previousMode,
  revertToMode: activeModeMatchingLiveBackend(liveBackend),
});

/**
 * Apply Active navigation mode intent and hot-swap when a live session exists.
 *
 * Recast → recast_crowd; Voxel mesh / Dual → voxel_walk (click surfaces → nearest floor cell).
 * Gates always use volume / recastBin (not a possibly-stale caller caps snapshot).
 */
export const resolveActiveNavigationChange = async (
  params: ResolveActiveNavigationChangeParams
): Promise<ResolveActiveNavigationChangeResult> => {
  const log = params.onLog ?? ((message: string): void => console.log(message));
  const caps = navCapabilitiesFromParts({
    recastBin: params.recastBin,
    volume: params.volume,
  });
  log(
    `[INFO] Active navigation mode → ${activeNavigationModeLabel(params.mode)}` +
      (params.previousMode !== params.mode
        ? ` (was ${activeNavigationModeLabel(params.previousMode)})`
        : '') +
      ` · session caps hasRecast=${caps.hasRecast} hasVolume=${caps.hasVolume}.`
  );

  const canHotSwap = Boolean(params.activateBackend) || Boolean(params.viewer);
  if (!canHotSwap || params.liveBackend === 'none') {
    log('[INFO] Applies on next Run Nav / upload.');
    return {
      applied: true,
      liveBackend: params.liveBackend,
      mode: params.mode,
    };
  }

  const targetLive = initialLiveBackendForActiveMode(params.mode);

  if (params.liveBackend === targetLive) {
    if (params.mode === 'recast_and_voxel_mesh') {
      log(
        `[INFO] Dual-ready (live ${liveNavBackendLabel(params.liveBackend)}). ` +
          'Click surfaces to walk; switch to Recast for crowd navmesh picks.'
      );
    } else {
      log(`[INFO] Already live on ${liveNavBackendLabel(targetLive)}.`);
    }
    return {
      applied: true,
      liveBackend: params.liveBackend,
      mode: params.mode,
    };
  }

  if (params.mode === 'recast_and_voxel_mesh') {
    if (!caps.hasVolume || !caps.hasRecast || !params.volume || !params.recastBin) {
      log(
        '[WARN] Dual-ready not in session yet — re-run Nav under voxel / SDF-MC to bake volume + Recast.'
      );
      return failResult(
        params.liveBackend,
        params.previousMode,
        activeNavigationHotSwapFailureMessage({ caps, mode: params.mode })
      );
    }
  } else if (!isActiveModeAvailable(params.mode, caps)) {
    log(
      `[WARN] Cannot hot-swap to ${activeNavigationModeLabel(params.mode)} — missing assets.`
    );
    return failResult(
      params.liveBackend,
      params.previousMode,
      activeNavigationHotSwapFailureMessage({ caps, mode: params.mode })
    );
  }

  if (targetLive === 'recast_crowd' && !params.recastBin) {
    log('[WARN] No Recast bin cached — re-run Nav with Recast (or Recast + voxel mesh).');
    return failResult(
      params.liveBackend,
      params.previousMode,
      activeNavigationHotSwapFailureMessage({ caps, mode: params.mode })
    );
  }
  if (targetLive === 'voxel_walk' && !params.volume) {
    log('[WARN] No volume cached — re-run Nav with Voxel mesh (or Recast + voxel mesh).');
    return failResult(
      params.liveBackend,
      params.previousMode,
      activeNavigationHotSwapFailureMessage({ caps, mode: params.mode })
    );
  }

  try {
    const activate =
      params.activateBackend ??
      (async (activateParams) => {
        if (!params.viewer) {
          throw new Error('Active hot-swap requires a Viewer or activateBackend.');
        }
        return activateNavBackend({
          backend: activateParams.backend,
          onLog: activateParams.onLog,
          recastBin: activateParams.recastBin,
          seed: activateParams.seed,
          spawnHint: activateParams.spawnHint,
          viewer: params.viewer,
          volume: activateParams.volume,
        });
      });
    const result = await activate({
      backend: targetLive,
      onLog: log,
      recastBin: params.recastBin,
      seed: params.seed,
      spawnHint: params.spawnHint,
      volume: params.volume,
    });
    if (params.mode === 'recast_and_voxel_mesh') {
      log(
        `[SUCCESS] Dual live → ${liveNavBackendLabel(result.liveBackend)}. ` +
          'Click surfaces — player walks to nearest floor cell.'
      );
    }
    return {
      applied: true,
      liveBackend: result.liveBackend,
      mode: params.mode,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[ERROR] Active hot-swap failed: ${detail}`);
    return failResult(
      params.liveBackend,
      params.previousMode,
      activeNavigationHotSwapFailureMessage({
        caps,
        detail,
        mode: params.mode,
      })
    );
  }
};
