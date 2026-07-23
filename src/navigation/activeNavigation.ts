/**
 * Active navigation mode: Recast / Voxel mesh / Recast + voxel mesh (dual-ready hot-swap).
 * One live backend at a time — hybrid means both assets ready, not dual-drive.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';

import type { NavArtifactBundle } from '@/navigation/navArtifactBundle';
import { NAV_VOLUME_FORMAT, type NavVolumeMetaV1 } from '@/navigation/navArtifactContract';
import {
  volumeToWalkableFloorMesh,
} from '@/navigation/voxelWalkRuntime';
import type { Viewer } from '@/scene/Viewer';
import type { CollisionVoxelVolume } from '@/wasm/bridge';

/** UI Active navigation mode (always offered; gate by capabilities). */
export type ActiveNavigationMode = 'recast' | 'voxel_mesh' | 'recast_and_voxel_mesh';

/** What the Viewer is actually running right now. */
export type LiveNavBackend = 'none' | 'voxel_walk' | 'recast_crowd';

export interface NavCapabilities {
  readonly hasRecast: boolean;
  readonly hasVolume: boolean;
}

export interface ActivateNavBackendOptions {
  readonly backend: Exclude<LiveNavBackend, 'none'>;
  readonly onLog?: (message: string) => void;
  readonly recastBin?: Uint8Array | null;
  readonly seed?: readonly number[] | null;
  /** Preferred player feet in world space (voxel walk / converted to oriented for Recast). */
  readonly spawnHint?: readonly [number, number, number] | null;
  readonly viewer: Viewer;
  readonly volume?: CollisionVoxelVolume | null;
}

export interface ActivateNavBackendResult {
  readonly liveBackend: Exclude<LiveNavBackend, 'none'>;
  readonly playerSpawn: Vector3 | null;
}

/** Matches default Nav generation mode (`floor_field`). Oval example switches to dual-ready. */
export const DEFAULT_ACTIVE_NAVIGATION_MODE: ActiveNavigationMode = 'recast';

export const activeNavigationModeLabel = (mode: ActiveNavigationMode): string => {
  switch (mode) {
    case 'recast':
      return 'Recast';
    case 'voxel_mesh':
      return 'Voxel mesh';
    case 'recast_and_voxel_mesh':
      return 'Recast + voxel mesh';
  }
};

export const liveNavBackendLabel = (backend: LiveNavBackend): string => {
  switch (backend) {
    case 'none':
      return 'none';
    case 'voxel_walk':
      return 'Voxel walk';
    case 'recast_crowd':
      return 'Recast crowd';
  }
};

/** Initial live backend after a successful Run Nav for the given Active mode. */
export const initialLiveBackendForActiveMode = (
  mode: ActiveNavigationMode
): Exclude<LiveNavBackend, 'none'> => {
  if (mode === 'recast') {
    return 'recast_crowd';
  }
  return 'voxel_walk';
};

/** Whether voxel Run Nav should bake Recast into the pack. */
export const shouldBakeRecastForActiveMode = (mode: ActiveNavigationMode): boolean =>
  mode === 'recast' || mode === 'recast_and_voxel_mesh';

/** Whether voxel Run Nav should keep/emit volume in the pack. */
export const shouldKeepVolumeForActiveMode = (mode: ActiveNavigationMode): boolean =>
  mode === 'voxel_mesh' || mode === 'recast_and_voxel_mesh';

export const navCapabilitiesFromBundle = (
  bundle: NavArtifactBundle | null | undefined
): NavCapabilities => {
  if (!bundle) {
    return { hasRecast: false, hasVolume: false };
  }
  const hasRecast = Boolean(bundle.recastNavmeshBin && bundle.recastNavmeshBin.byteLength > 0);
  const hasVolume = Boolean(
    bundle.volumeMetaJson &&
      bundle.volumeSolidBin &&
      bundle.volumeSolidBin.byteLength > 0 &&
      bundle.volumeNavRegionBin &&
      bundle.volumeNavRegionBin.byteLength > 0
  );
  return { hasRecast, hasVolume };
};

/** Rebuild a {@link CollisionVoxelVolume} from pack members for hot-swap. */
export const volumeFromNavArtifactBundle = (
  bundle: NavArtifactBundle | null | undefined
): CollisionVoxelVolume | null => {
  if (
    !bundle?.volumeMetaJson ||
    !bundle.volumeSolidBin ||
    !bundle.volumeNavRegionBin ||
    bundle.volumeSolidBin.byteLength === 0 ||
    bundle.volumeNavRegionBin.byteLength === 0
  ) {
    return null;
  }
  try {
    const meta = JSON.parse(bundle.volumeMetaJson) as NavVolumeMetaV1;
    if (meta.format !== NAV_VOLUME_FORMAT || !meta.dims || meta.dims.length !== 3) {
      return null;
    }
    return {
      dims: [meta.dims[0], meta.dims[1], meta.dims[2]],
      origin: [meta.origin[0], meta.origin[1], meta.origin[2]],
      voxel_size: meta.voxel_size,
      solid: bundle.volumeSolidBin,
      nav_region: bundle.volumeNavRegionBin,
    };
  } catch {
    return null;
  }
};

export const navCapabilitiesFromParts = ({
  recastBin,
  volume,
}: {
  readonly recastBin?: Uint8Array | null;
  readonly volume?: CollisionVoxelVolume | null;
}): NavCapabilities => ({
  hasRecast: Boolean(recastBin && recastBin.byteLength > 0),
  hasVolume: Boolean(volume),
});

/** Pick Active mode from pack capabilities (upload sync). */
export const activeModeFromCapabilities = (
  caps: NavCapabilities,
  liveFromSession?: 'voxel_walk' | 'recast_crowd' | null
): ActiveNavigationMode => {
  if (caps.hasVolume && caps.hasRecast) {
    return 'recast_and_voxel_mesh';
  }
  if (caps.hasVolume) {
    return 'voxel_mesh';
  }
  if (caps.hasRecast) {
    return 'recast';
  }
  if (liveFromSession === 'voxel_walk') {
    return 'voxel_mesh';
  }
  return 'recast';
};

export const isActiveModeAvailable = (
  mode: ActiveNavigationMode,
  caps: NavCapabilities
): boolean => {
  switch (mode) {
    case 'recast':
      return caps.hasRecast;
    case 'voxel_mesh':
      return caps.hasVolume;
    case 'recast_and_voxel_mesh':
      return caps.hasVolume && caps.hasRecast;
  }
};

export const activeModeUnavailableReason = (
  mode: ActiveNavigationMode,
  caps: NavCapabilities
): string | null => {
  if (isActiveModeAvailable(mode, caps)) {
    return null;
  }
  switch (mode) {
    case 'recast':
      return 'Needs Recast bake (Run Nav with Recast, or upload a pack with recast.navmesh.bin).';
    case 'voxel_mesh':
      return 'Needs voxel volume (Run Nav with Voxel mesh / Recast + voxel mesh, or upload a volume pack).';
    case 'recast_and_voxel_mesh':
      return 'Needs dual-ready pack (volume + Recast). Run Nav with Recast + voxel mesh under voxel collision.';
  }
};

/**
 * Hot-swap live locomotion from cached volume / Recast bytes.
 * Destroys the previous backend first (Viewer init* already does this).
 */
export const activateNavBackend = async (
  options: ActivateNavBackendOptions
): Promise<ActivateNavBackendResult> => {
  const log = options.onLog ?? ((message: string): void => console.log(message));
  const { viewer, backend } = options;
  const seed = options.seed ? ([...options.seed] as number[]) : null;
  const spawnHint = options.spawnHint ?? null;

  if (backend === 'voxel_walk') {
    const volume = options.volume;
    if (!volume) {
      throw new Error('Voxel mesh mode requires a carved volume in the session/pack.');
    }
    if (!seed || seed.length < 3) {
      throw new Error('Voxel mesh mode requires a collision seed.');
    }
    const floor = volumeToWalkableFloorMesh(volume);
    await viewer.displayNavMesh(floor.positions, floor.indices, 0, seed, 0);
    const playerSpawn = viewer.initVoxelWalk(volume, seed, spawnHint);
    viewer.setPreferredNavSpawnPoints(
      [playerSpawn.x, playerSpawn.y, playerSpawn.z],
      null
    );
    log(
      `[SUCCESS] Active → Voxel mesh (voxel walk) at ` +
        `(${playerSpawn.x.toFixed(2)}, ${playerSpawn.y.toFixed(2)}, ${playerSpawn.z.toFixed(2)}).`
    );
    return { liveBackend: 'voxel_walk', playerSpawn };
  }

  const navBin = options.recastBin;
  if (!navBin || navBin.byteLength === 0) {
    throw new Error('Recast mode requires recast.navmesh.bin in the session/pack.');
  }

  if (spawnHint) {
    const oriented = viewer.worldNavPointToOriented(
      new Vector3(spawnHint[0], spawnHint[1], spawnHint[2])
    );
    viewer.setPreferredNavSpawnPoints([oriented.x, oriented.y, oriented.z], null);
  } else if (seed && seed.length >= 3) {
    viewer.setPreferredNavSpawnPoints([seed[0]!, seed[1]!, seed[2]!], null);
  }

  if (options.volume) {
    const floor = volumeToWalkableFloorMesh(options.volume);
    await viewer.displayNavMesh(
      floor.positions,
      floor.indices,
      0,
      seed ?? (spawnHint ? [...spawnHint] : null),
      0
    );
  }

  await viewer.initCrowd(navBin);
  viewer.addNPC();
  viewer.setNavMeshVisible(true);
  const playerSpawn = spawnHint
    ? new Vector3(spawnHint[0], spawnHint[1], spawnHint[2])
    : viewer.getPlayerFeetWorld();
  log('[SUCCESS] Active → Recast (crowd). Click the green navmesh to move.');
  return { liveBackend: 'recast_crowd', playerSpawn };
};
