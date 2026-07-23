import {
  ArcRotateCamera,
  Camera,
  FreeCamera,
  Vector3,
  type Scene,
} from '@babylonjs/core';

export type DemoCameraMode = 'fly' | 'orbit';

/** View state preserved when switching fly ↔ orbit without reframing the scene. */
export interface PreservedCameraView {
  readonly orbit?: { alpha: number; beta: number; radius: number };
  readonly position: Vector3;
  readonly target: Vector3;
}

const KEY_W = 87;
const KEY_A = 65;
const KEY_S = 83;
const KEY_D = 68;
const KEY_E = 69;
const KEY_Q = 81;

/** Base WASD move speed (Babylon FreeCamera units/frame-scale). */
export const DEFAULT_FLY_SPEED = 0.3;
export const DEFAULT_ANGULAR_SENSIBILITY = 2000;
const SHIFT_SPEED_MULTIPLIER = 10;
/** Scene-extent scaling when auto-framing fly cam (`radius * factor`). */
const FLY_SPEED_FROM_RADIUS = 0.01;

type FlyCameraExtras = FreeCamera & {
  __splatwalkSetBaseFlySpeed?: (speed: number) => void;
};

export const configureFlyCamera = (camera: FreeCamera, canvas: HTMLCanvasElement): (() => void) => {
  camera.attachControl(canvas, true);
  camera.speed = DEFAULT_FLY_SPEED;
  camera.angularSensibility = DEFAULT_ANGULAR_SENSIBILITY;
  camera.minZ = 0.1;
  camera.keysUp = [KEY_W];
  camera.keysDown = [KEY_S];
  camera.keysLeft = [KEY_A];
  camera.keysRight = [KEY_D];
  camera.keysUpward = [KEY_E];
  camera.keysDownward = [KEY_Q];
  canvas.tabIndex = 0;

  let baseFlySpeed = DEFAULT_FLY_SPEED;
  let shiftHeld = false;

  const syncSpeed = (): void => {
    camera.speed = baseFlySpeed * (shiftHeld ? SHIFT_SPEED_MULTIPLIER : 1);
  };

  const onPointerDown = (): void => {
    canvas.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
      return;
    }
    if (shiftHeld) {
      return;
    }
    shiftHeld = true;
    syncSpeed();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
      return;
    }
    shiftHeld = false;
    syncSpeed();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  (camera as FlyCameraExtras).__splatwalkSetBaseFlySpeed = (speed: number): void => {
    baseFlySpeed = speed;
    syncSpeed();
  };

  return (): void => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    delete (camera as FlyCameraExtras).__splatwalkSetBaseFlySpeed;
  };
};

export const configureOrbitCamera = (camera: ArcRotateCamera, canvas: HTMLCanvasElement): (() => void) => {
  camera.attachControl(canvas, true);

  const baseWheelPrecision = 50;
  const basePanningSensibility = 1000;
  camera.wheelPrecision = baseWheelPrecision;
  camera.panningSensibility = basePanningSensibility;

  let shiftHeld = false;
  const syncOrbitSpeed = (): void => {
    const factor = shiftHeld ? SHIFT_SPEED_MULTIPLIER : 1;
    camera.wheelPrecision = baseWheelPrecision / factor;
    camera.panningSensibility = basePanningSensibility / factor;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
      return;
    }
    if (shiftHeld) {
      return;
    }
    shiftHeld = true;
    syncOrbitSpeed();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') {
      return;
    }
    shiftHeld = false;
    syncOrbitSpeed();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return (): void => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
};

export const frameFlyCameraToScene = (scene: Scene, camera: FreeCamera): void => {
  const worldExtends = scene.getWorldExtends();
  const center = worldExtends.min.add(worldExtends.max).scale(0.5);
  const radius = worldExtends.max.subtract(worldExtends.min).length() / 2;
  const distance = Math.max(6, radius * 1.3);
  camera.position = center.add(new Vector3(0, distance * 0.25, -distance));
  camera.setTarget(center);

  const setBase = (camera as FlyCameraExtras).__splatwalkSetBaseFlySpeed;
  if (setBase) {
    const baseSpeed = Math.max(DEFAULT_FLY_SPEED, radius * FLY_SPEED_FROM_RADIUS);
    setBase(baseSpeed);
    camera.speed = baseSpeed;
  }
};

export const frameOrbitCameraToScene = (scene: Scene, camera: ArcRotateCamera): void => {
  const worldExtends = scene.getWorldExtends();
  const center = worldExtends.min.add(worldExtends.max).scale(0.5);
  const radius = worldExtends.max.subtract(worldExtends.min).length() / 2;
  camera.setTarget(center);
  camera.radius = Math.max(2, radius * 2);
};

export const captureActiveCameraView = (camera: Camera): PreservedCameraView | null => {
  if (camera instanceof FreeCamera) {
    return {
      position: camera.position.clone(),
      target: camera.getTarget().clone(),
    };
  }
  if (camera instanceof ArcRotateCamera) {
    return {
      orbit: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius },
      position: camera.position.clone(),
      target: camera.target.clone(),
    };
  }
  return null;
};

export const createFlyCameraFromView = (
  scene: Scene,
  name: string,
  view: PreservedCameraView
): FreeCamera => {
  const fly = new FreeCamera(name, view.position.clone(), scene);
  fly.setTarget(view.target.clone());
  return fly;
};

export const createOrbitCameraFromView = (
  scene: Scene,
  name: string,
  view: PreservedCameraView
): ArcRotateCamera => {
  if (view.orbit) {
    return new ArcRotateCamera(
      name,
      view.orbit.alpha,
      view.orbit.beta,
      view.orbit.radius,
      view.target.clone(),
      scene
    );
  }

  const offset = view.position.subtract(view.target);
  const radius = Math.max(0.5, offset.length());
  const beta = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));
  const alpha = Math.atan2(offset.x, offset.z);
  return new ArcRotateCamera(name, alpha, beta, radius, view.target.clone(), scene);
};

export const demoCameraModeLabel = (mode: DemoCameraMode): string =>
  mode === 'fly' ? 'Fly (WASD)' : 'Orbit (drag / scroll)';
