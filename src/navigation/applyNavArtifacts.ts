/**
 * Apply a parsed nav-artifact pack to Babylon {@link Viewer} or R3F {@link SplatNavController}.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';

import {
  type ParsedNavArtifacts,
} from '@/navigation/navArtifactBundle';
import {
  volumeToWalkableFloorMesh,
} from '@/navigation/voxelWalkRuntime';
import {
  recastNavmeshBinToOverlayMesh,
  walkableFloorsGlbToMesh,
} from '@/navigation/walkableFloorsGlb';
import type { SplatNavController } from '@/react/three/SplatNavController';
import type { Viewer } from '@/scene/Viewer';

export interface ApplyNavArtifactsToViewerOptions {
  /**
   * When false, skip {@link Viewer.focusOnPlayer} after spawn (NavKit restore
   * applies cam pose from meta afterward). Default true.
   */
  readonly focusCamera?: boolean;
  readonly onLog?: (message: string) => void;
  readonly parsed: ParsedNavArtifacts;
  /**
   * When false, session region AABB is returned for caching but the yellow box
   * is not shown. Default true (Workbench / Fast Nav restore-and-show).
   */
  readonly showSelectionRegion?: boolean;
  readonly viewer: Viewer;
}

export interface ApplyNavArtifactsToViewerResult {
  readonly locomotionMode: 'voxel_walk' | 'recast_crowd';
  readonly playerSpawn: Vector3 | null;
  /** Session region from nav_session.json, if present (shown or cache-only). */
  readonly restoredRegion: { min: number[]; max: number[] } | null;
}

const focusViewerTopDown = (
  viewer: Viewer,
  log: (message: string) => void
): void => {
  const framing = viewer.focusOnPlayer();
  if (framing) {
    log(
      `[SUCCESS] Top-down view above player at ` +
        `${framing.player.map((v) => v.toFixed(2)).join(', ')}.`
    );
    return;
  }
  log('[WARN] focusOnPlayer returned null; leaving current camera.');
};

/**
 * Prefer walkable_floors.glb, else volume floor, else reconstruct from
 * recast.navmesh.bin (legacy NavKits without an overlay member).
 */
const resolveWalkableOverlayMesh = async (
  parsed: ParsedNavArtifacts,
  log: (message: string) => void
): Promise<{ indices: Uint32Array; positions: Float32Array } | null> => {
  const glb = parsed.bundle.walkableFloorsGlb;
  if (glb && glb.byteLength > 0) {
    try {
      const mesh = await walkableFloorsGlbToMesh(glb);
      log(
        `[INFO] Walkable overlay from walkable_floors.glb ` +
          `(${mesh.positions.length / 3} verts, ${mesh.indices.length / 3} tris).`
      );
      return mesh;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`[WARN] walkable_floors.glb failed to parse (${detail}); trying fallbacks.`);
    }
  }
  if (parsed.volume) {
    const floor = volumeToWalkableFloorMesh(parsed.volume);
    if (floor.positions.length >= 9 && floor.indices.length >= 3) {
      log('[INFO] Walkable overlay from volume floor mesh.');
      return { positions: floor.positions, indices: floor.indices };
    }
  }
  const navBin = parsed.bundle.recastNavmeshBin;
  if (navBin && navBin.byteLength > 0) {
    const fromBin = await recastNavmeshBinToOverlayMesh(navBin);
    if (fromBin) {
      log(
        `[INFO] Walkable overlay reconstructed from recast.navmesh.bin ` +
          `(${fromBin.positions.length / 3} verts, ${fromBin.indices.length / 3} tris).`
      );
      return fromBin;
    }
  }
  return null;
};

/**
 * Restore nav session from artifacts onto an already-loaded splat Viewer.
 * Prefer volume + voxel_walk when present; else Recast from `recast.navmesh.bin`.
 */
export const applyNavArtifactsToViewer = async (
  options: ApplyNavArtifactsToViewerOptions
): Promise<ApplyNavArtifactsToViewerResult> => {
  const { parsed, viewer } = options;
  const focusCamera = options.focusCamera !== false;
  const showSelectionRegion = options.showSelectionRegion !== false;
  const log = options.onLog ?? ((message: string): void => console.log(message));
  const { session, volume, bundle } = parsed;
  log(
    `[INFO] Applying nav artifacts (locomotion=${session.locomotionMode}` +
      `${volume ? ', volume' : ''}` +
      `${bundle.recastNavmeshBin ? ', recast' : ''}` +
      `${bundle.walkableFloorsGlb ? ', walkable_floors' : ''})…`
  );

  let restoredRegion: { min: number[]; max: number[] } | null = null;
  if (session.regionMin && session.regionMax) {
    restoredRegion = {
      min: [...session.regionMin],
      max: [...session.regionMax],
    };
    if (showSelectionRegion) {
      viewer.enableRegionSelection({
        min: restoredRegion.min,
        max: restoredRegion.max,
      });
      log('[INFO] Restored selection region from nav_session.json.');
    } else {
      log(
        '[INFO] Selection region bounds from nav_session.json cached only ' +
          '(Selection region toggle is off — yellow box not shown).'
      );
    }
  }

  if (bundle.collisionGlb && bundle.collisionGlb.byteLength > 0) {
    const glbCopy = Uint8Array.from(bundle.collisionGlb);
    const file = new File([glbCopy], 'collision.glb', {
      type: 'model/gltf-binary',
    });
    await viewer.loadColliderMesh(file);
    viewer.setColliderVisible(true);
    log('[INFO] Collision GLB overlay restored from artifacts.');
  }

  const seed = session.collisionSeed
    ? ([...session.collisionSeed] as number[])
    : null;
  const spawnHint = session.playerSpawn
    ? ([...session.playerSpawn] as [number, number, number])
    : null;

  if (volume && session.locomotionMode === 'voxel_walk') {
    if (!seed || seed.length < 3) {
      throw new Error('nav_session.json missing collisionSeed for voxel_walk restore.');
    }
    const floor = volumeToWalkableFloorMesh(volume);
    await viewer.displayNavMesh(floor.positions, floor.indices, 0, seed, 0);
    const playerSpawn = viewer.initVoxelWalk(volume, seed, spawnHint);
    viewer.setPreferredNavSpawnPoints(
      [playerSpawn.x, playerSpawn.y, playerSpawn.z],
      null
    );
    viewer.setNavMeshVisible(true);
    log(
      `[SUCCESS] Voxel walk restored from artifacts at ` +
        `(${playerSpawn.x.toFixed(2)}, ${playerSpawn.y.toFixed(2)}, ${playerSpawn.z.toFixed(2)}).`
    );
    if (focusCamera) {
      focusViewerTopDown(viewer, log);
    }
    return { locomotionMode: 'voxel_walk', playerSpawn, restoredRegion };
  }

  const navBin = bundle.recastNavmeshBin;
  if (!navBin || navBin.byteLength === 0) {
    throw new Error(
      'Artifacts need recast.navmesh.bin (or volume trio + locomotionMode voxel_walk).'
    );
  }

  if (spawnHint) {
    const oriented = viewer.worldNavPointToOriented(
      new Vector3(spawnHint[0], spawnHint[1], spawnHint[2])
    );
    viewer.setPreferredNavSpawnPoints([oriented.x, oriented.y, oriented.z], null);
  } else if (seed && seed.length >= 3) {
    viewer.setPreferredNavSpawnPoints([seed[0]!, seed[1]!, seed[2]!], null);
  }

  const overlay = await resolveWalkableOverlayMesh(parsed, log);
  if (overlay) {
    await viewer.displayNavMesh(
      overlay.positions,
      overlay.indices,
      0,
      seed ?? (spawnHint ? [...spawnHint] : null),
      0.05
    );
  } else {
    log(
      '[WARN] Pack has no walkable overlay (glb / volume / recast debug) — Recast crowd will ' +
        'spawn, but there is no green navmesh overlay to click. Re-bake Fast Nav / re-download NavKit.'
    );
  }

  await viewer.initCrowd(navBin);
  viewer.addNPC();
  viewer.setNavMeshVisible(true);
  const playerSpawn = spawnHint
    ? new Vector3(spawnHint[0], spawnHint[1], spawnHint[2])
    : null;
  log(
    `[SUCCESS] Recast crowd restored from artifacts` +
      (playerSpawn
        ? ` (spawn hint ${playerSpawn.x.toFixed(2)}, ${playerSpawn.y.toFixed(2)}, ${playerSpawn.z.toFixed(2)})`
        : '') +
      '.'
  );
  if (focusCamera) {
    focusViewerTopDown(viewer, log);
  }
  return { locomotionMode: 'recast_crowd', playerSpawn, restoredRegion };
};

export interface ApplyNavArtifactsToR3FOptions {
  readonly controller: SplatNavController;
  /**
   * When false, skip {@link SplatNavController.focusOnPlayer} after spawn
   * (NavKit restore applies cam pose from meta afterward). Default true.
   */
  readonly focusCamera?: boolean;
  readonly onLog?: (message: string) => void;
  readonly parsed: ParsedNavArtifacts;
}

/**
 * R3F restore requires `recast.navmesh.bin` (volume walk is Babylon/Storage-first).
 */
export const applyNavArtifactsToR3F = async (
  options: ApplyNavArtifactsToR3FOptions
): Promise<void> => {
  const { controller, parsed } = options;
  const focusCamera = options.focusCamera !== false;
  const log = options.onLog ?? ((message: string): void => console.log(message));
  const navBin = parsed.bundle.recastNavmeshBin;
  if (!navBin || navBin.byteLength === 0) {
    throw new Error(
      'R3F upload requires recast.navmesh.bin in the pack (volume-only packs are Babylon/Storage).'
    );
  }
  const session = parsed.session;
  if (session.regionMin && session.regionMax) {
    controller.enableRegionSelection({
      min: [...session.regionMin],
      max: [...session.regionMax],
    });
    log('[INFO] Restored selection region from nav_session.json.');
  }

  const overlay = await resolveWalkableOverlayMesh(parsed, log);
  if (overlay) {
    controller.showNavMesh(overlay.positions, overlay.indices);
    controller.setNavMeshVisible(true);
  } else {
    log(
      '[WARN] Pack has no walkable overlay (glb / volume / recast debug) — crowd will spawn ' +
        'without a clickable green overlay. Re-bake Fast Nav / re-download NavKit.'
    );
  }

  const spawn = session.playerSpawn ?? session.collisionSeed;
  const playerSpawn: [number, number, number] | null =
    spawn && spawn.length >= 3 ? [spawn[0]!, spawn[1]!, spawn[2]!] : null;
  await controller.initCrowd(navBin, playerSpawn);
  controller.addNPC(
    playerSpawn ? [playerSpawn[0]! + 2, playerSpawn[1]!, playerSpawn[2]! + 2] : null
  );
  log('[SUCCESS] R3F Recast crowd restored from artifacts.');
  if (focusCamera) {
    controller.focusOnPlayer();
    log('[SUCCESS] Top-down view framed on player.');
  }
};
