/**
 * Player-agent WASDQE input (not FreeCamera fly).
 *
 * W/S forward/back, A/D yaw, Q/E strafe — relative to facing yaw (Y).
 */

import type { NavKitControlsMode } from '@/navigation/navKitContract';

const KEY_A = 'KeyA';
const KEY_D = 'KeyD';
const KEY_E = 'KeyE';
const KEY_Q = 'KeyQ';
const KEY_S = 'KeyS';
const KEY_W = 'KeyW';

/** Horizontal move speed (m/s) for W/S/Q/E. */
export const PLAYER_WASD_MOVE_SPEED_MPS = 3.5;

/** Yaw rate (rad/s) for A/D. */
export const PLAYER_WASD_TURN_SPEED_RAD_S = 2.2;

/** Look-ahead distance for Recast `requestMoveTarget` while holding move keys. */
export const PLAYER_WASD_LOOKAHEAD_METERS = 1.25;

export interface PlayerWasdSample {
  readonly forward: number;
  readonly strafe: number;
  readonly turn: number;
}

export interface PlayerWasdMoveResult {
  readonly moveX: number;
  readonly moveZ: number;
  readonly yawRadians: number;
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.isContentEditable;
};

/**
 * Window key tracker for WASDQE. Call {@link attach} / {@link detach} with the
 * scene lifecycle. Ignores key events while focus is in form fields.
 */
export class PlayerWasdKeyTracker {
  private readonly _down = new Set<string>();
  private _attached = false;

  private readonly _onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) {
      return;
    }
    this._down.add(event.code);
  };

  private readonly _onKeyUp = (event: KeyboardEvent): void => {
    this._down.delete(event.code);
  };

  private readonly _onBlur = (): void => {
    this._down.clear();
  };

  public attach(): void {
    if (this._attached || typeof window === 'undefined') {
      return;
    }
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this._attached = true;
  }

  public detach(): void {
    if (!this._attached || typeof window === 'undefined') {
      return;
    }
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this._down.clear();
    this._attached = false;
  }

  public sample(): PlayerWasdSample {
    let forward = 0;
    let strafe = 0;
    let turn = 0;
    if (this._down.has(KEY_W)) {
      forward += 1;
    }
    if (this._down.has(KEY_S)) {
      forward -= 1;
    }
    if (this._down.has(KEY_Q)) {
      strafe -= 1;
    }
    if (this._down.has(KEY_E)) {
      strafe += 1;
    }
    // Positive yaw (Y-up, forward +Z) turns toward +X (right). A = left, D = right.
    if (this._down.has(KEY_A)) {
      turn -= 1;
    }
    if (this._down.has(KEY_D)) {
      turn += 1;
    }
    return { forward, strafe, turn };
  }
}

export const controlsModeAllowsClick = (mode: NavKitControlsMode): boolean =>
  mode === 'click_to_move' || mode === 'both';

export const controlsModeAllowsWasd = (mode: NavKitControlsMode): boolean =>
  mode === 'wasdqe' || mode === 'both';

/** True when any WASDQE axis is non-zero (blocks click travel-facing ownership). */
export const isPlayerWasdSampleActive = (sample: PlayerWasdSample): boolean =>
  sample.forward !== 0 || sample.strafe !== 0 || sample.turn !== 0;

/**
 * Integrate one frame of WASDQE into yaw + XZ displacement (oriented space).
 * Yaw 0 faces +Z (Babylon camera-select convention).
 */
export const integratePlayerWasdMove = (options: {
  readonly dt: number;
  readonly sample: PlayerWasdSample;
  readonly yawRadians: number;
}): PlayerWasdMoveResult => {
  const dt = Math.max(0, Math.min(options.dt, 0.1));
  const yaw =
    options.yawRadians + options.sample.turn * PLAYER_WASD_TURN_SPEED_RAD_S * dt;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Forward = +Z at yaw 0; strafe = +X to the right.
  const fx = sin;
  const fz = cos;
  const rx = cos;
  const rz = -sin;
  const speed = PLAYER_WASD_MOVE_SPEED_MPS * dt;
  const moveX =
    (fx * options.sample.forward + rx * options.sample.strafe) * speed;
  const moveZ =
    (fz * options.sample.forward + rz * options.sample.strafe) * speed;
  return { moveX, moveZ, yawRadians: yaw };
};
