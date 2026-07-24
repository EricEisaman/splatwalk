/**
 * Apply NavKit meta pose / controls after nav artifacts are restored.
 * Meta poses are oriented / nav-world (engine-agnostic); hosts map to their camera.
 */

import {
  DEFAULT_NAV_KIT_CONTROLS_MODE_NEW,
  type NavKitControlsMode,
  type NavKitMetaV1,
} from '@/navigation/navKitContract';
import type { ParsedNavArtifacts } from '@/navigation/navArtifactBundle';
import type { SplatNavController } from '@/react/three/SplatNavController';
import type { Viewer } from '@/scene/Viewer';

export interface ApplyNavKitMetaResult {
  readonly controlsMode: NavKitControlsMode;
  /** True when focusOnPlayer ran (no camPos + target/euler). */
  readonly topDownViewApplied: boolean;
}

const resolveControlsMode = (meta: NavKitMetaV1): NavKitControlsMode =>
  meta.controls?.mode ?? DEFAULT_NAV_KIT_CONTROLS_MODE_NEW;

/** Restore camera when camPos pairs with camTarget or camEulerDeg. */
const hasCameraPose = (meta: NavKitMetaV1): boolean =>
  Boolean(meta.camPos && (meta.camTarget || meta.camEulerDeg));

/**
 * Babylon host: region / player / camera / controls from meta with session fallbacks.
 */
export const applyNavKitMetaToViewer = (options: {
  readonly meta: NavKitMetaV1;
  readonly onLog?: (message: string) => void;
  readonly parsed: ParsedNavArtifacts;
  readonly viewer: Viewer;
}): ApplyNavKitMetaResult => {
  const { meta, parsed, viewer } = options;
  const log = options.onLog ?? ((message: string): void => console.log(message));
  const session = parsed.session;

  const region =
    meta.region ??
    (session.regionMin && session.regionMax
      ? {
          min: [...session.regionMin] as [number, number, number],
          max: [...session.regionMax] as [number, number, number],
        }
      : null);
  if (region) {
    viewer.enableRegionSelection({ min: [...region.min], max: [...region.max] });
    log('[INFO] NavKit region AABB applied.');
  }

  const playerPos =
    meta.playerPos ??
    (session.playerSpawn && session.playerSpawn.length >= 3
      ? {
          x: session.playerSpawn[0]!,
          y: session.playerSpawn[1]!,
          z: session.playerSpawn[2]!,
        }
      : session.collisionSeed && session.collisionSeed.length >= 3
        ? {
            x: session.collisionSeed[0]!,
            y: session.collisionSeed[1]!,
            z: session.collisionSeed[2]!,
          }
        : null);
  const playerEuler = meta.playerEulerDeg ?? { x: 0, y: 0, z: 0 };
  if (playerPos) {
    viewer.teleportPlayerTo({
      position: playerPos,
      yawDegrees: playerEuler.y,
    });
    log(
      `[INFO] NavKit player pose applied ` +
        `(${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)}, ` +
        `yaw=${playerEuler.y.toFixed(1)}°).`
    );
  }

  const controlsMode = resolveControlsMode(meta);

  let topDownViewApplied = false;
  if (hasCameraPose(meta)) {
    viewer.applyCameraPoseNavKit({
      position: meta.camPos!,
      eulerDegrees: meta.camEulerDeg ?? undefined,
      target: meta.camTarget ?? undefined,
    });
    log(
      meta.camTarget
        ? '[INFO] NavKit camera pose applied (camPos + camTarget → orbit).'
        : '[INFO] NavKit camera pose applied (camPos + camEulerDeg → orbit).'
    );
  } else {
    viewer.focusOnPlayer();
    topDownViewApplied = true;
    log('[INFO] NavKit camera: focusOnPlayer (no camPos + camTarget/euler).');
  }

  viewer.setControlsMode(controlsMode);
  log(`[INFO] NavKit controls mode: ${controlsMode}.`);

  return { controlsMode, topDownViewApplied };
};

/**
 * R3F host: region / player / camera / controls from meta with session fallbacks.
 */
export const applyNavKitMetaToR3F = (options: {
  readonly controller: SplatNavController;
  readonly meta: NavKitMetaV1;
  readonly onLog?: (message: string) => void;
  readonly parsed: ParsedNavArtifacts;
}): ApplyNavKitMetaResult => {
  const { controller, meta, parsed } = options;
  const log = options.onLog ?? ((message: string): void => console.log(message));
  const session = parsed.session;

  const region =
    meta.region ??
    (session.regionMin && session.regionMax
      ? {
          min: [...session.regionMin] as [number, number, number],
          max: [...session.regionMax] as [number, number, number],
        }
      : null);
  if (region) {
    controller.enableRegionSelection({
      min: [...region.min],
      max: [...region.max],
    });
    log('[INFO] NavKit region AABB applied.');
  }

  const playerPos =
    meta.playerPos ??
    (session.playerSpawn && session.playerSpawn.length >= 3
      ? {
          x: session.playerSpawn[0]!,
          y: session.playerSpawn[1]!,
          z: session.playerSpawn[2]!,
        }
      : session.collisionSeed && session.collisionSeed.length >= 3
        ? {
            x: session.collisionSeed[0]!,
            y: session.collisionSeed[1]!,
            z: session.collisionSeed[2]!,
          }
        : null);
  const playerEuler = meta.playerEulerDeg ?? { x: 0, y: 0, z: 0 };
  if (playerPos) {
    controller.teleportPlayerTo({
      position: [playerPos.x, playerPos.y, playerPos.z],
      yawDegrees: playerEuler.y,
    });
    log(
      `[INFO] NavKit player pose applied ` +
        `(${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)}, ` +
        `yaw=${playerEuler.y.toFixed(1)}°).`
    );
  }

  const controlsMode = resolveControlsMode(meta);

  let topDownViewApplied = false;
  if (hasCameraPose(meta)) {
    controller.applyCameraPoseNavKit({
      position: meta.camPos!,
      eulerDegrees: meta.camEulerDeg ?? undefined,
      target: meta.camTarget ?? undefined,
    });
    log(
      meta.camTarget
        ? '[INFO] NavKit camera pose applied (camPos + camTarget).'
        : '[INFO] NavKit camera pose applied (camPos + camEulerDeg).'
    );
  } else {
    controller.focusOnPlayer();
    topDownViewApplied = true;
    log('[INFO] NavKit camera: focusOnPlayer (no camPos + camTarget/euler).');
  }

  controller.setControlsMode(controlsMode);
  log(`[INFO] NavKit controls mode: ${controlsMode}.`);

  return { controlsMode, topDownViewApplied };
};
