/**
 * Click-to-move facing: on click, swiftly (not instantly) rotate toward the click
 * target *before* pathing starts; while moving, follow Recast travel (velocity,
 * else next path corner) with a rate-limited shortest-angle blend.
 *
 * Yaw 0 faces +Z (same as {@link integratePlayerWasdMove} / player wedge tip).
 */

/** Ignore near-zero horizontal travel when choosing a desired facing (m/s or m). */
export const PLAYER_TRAVEL_FACING_MIN_SPEED_MPS = 0.08;

/** Max yaw change rate while following the path (rad/s). */
export const PLAYER_TRAVEL_FACING_TURN_RAD_S = 2.0;

/**
 * Max yaw change rate for the initial click-face turn (rad/s).
 * ~π at 7 rad/s ≈ 0.45 s for a full about-face — swift, not a snap.
 */
export const PLAYER_CLICK_FACE_TURN_RAD_S = 7.0;

/** Treat click-face as finished when within this angle of the goal (rad). */
export const PLAYER_CLICK_FACE_ARRIVE_RAD = 0.06;

const TWO_PI = Math.PI * 2;

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Min XZ separation (m) for a click-face goal. */
const CLICK_FACE_MIN_LENGTH_M = 1e-3;

/**
 * Desired yaw from a flat XZ direction, or null when below the length threshold.
 * @param dx - World/nav X component of travel
 * @param dz - World/nav Z component of travel
 */
export const yawFromFlatDirection = (
  dx: number,
  dz: number,
  minLength: number = PLAYER_TRAVEL_FACING_MIN_SPEED_MPS
): number | null => {
  const len = Math.hypot(dx, dz);
  if (len < minLength) {
    return null;
  }
  return Math.atan2(dx, dz);
};

/**
 * Desired facing yaw from `from` toward `to` on the ground plane (click goal).
 * Returns null when the points are essentially coincident.
 */
export const yawTowardPoint = (
  from: Vec3Like,
  to: Vec3Like,
  minLength: number = CLICK_FACE_MIN_LENGTH_M
): number | null =>
  yawFromFlatDirection(to.x - from.x, to.z - from.z, minLength);

/** Shortest signed delta from `fromYaw` to `toYaw` in (−π, π]. */
export const shortestYawDelta = (fromYaw: number, toYaw: number): number => {
  let delta = toYaw - fromYaw;
  while (delta > Math.PI) {
    delta -= TWO_PI;
  }
  while (delta < -Math.PI) {
    delta += TWO_PI;
  }
  return delta;
};

/**
 * Shortest-arc yaw step toward `desiredYaw`, capped at `turnSpeed * dt`.
 */
export const smoothYawToward = (options: {
  readonly currentYaw: number;
  readonly desiredYaw: number;
  readonly dt: number;
  readonly turnSpeed?: number;
}): number => {
  const turnSpeed = options.turnSpeed ?? PLAYER_TRAVEL_FACING_TURN_RAD_S;
  const dt = Math.max(0, Math.min(options.dt, 0.1));
  const maxStep = turnSpeed * dt;
  if (maxStep <= 0) {
    return options.currentYaw;
  }
  const delta = shortestYawDelta(options.currentYaw, options.desiredYaw);
  if (Math.abs(delta) <= maxStep) {
    return options.desiredYaw;
  }
  return options.currentYaw + Math.sign(delta) * maxStep;
};

export interface TravelFacingResult {
  readonly yawRadians: number;
  /**
   * When a click-face goal was supplied, true once the swift turn has arrived.
   * Hosts should then start `requestMoveTarget` and clear the pending click yaw.
   */
  readonly clearClickFace: boolean;
}

/**
 * Pick desired facing: optional swift click-face first (in place, before pathing),
 * else velocity, else next path point − position. Smoothly rotates toward the choice.
 */
export const travelFacingYawFromAgent = (options: {
  readonly velocity: Vec3Like;
  readonly position: Vec3Like;
  readonly nextTarget: Vec3Like | null | undefined;
  readonly currentYaw: number;
  readonly dt: number;
  /** Pending click-face goal; drives a swift in-place turn until arrived. */
  readonly clickFaceYaw?: number | null;
  readonly minSpeed?: number;
  readonly turnSpeed?: number;
  readonly clickTurnSpeed?: number;
  readonly clickArriveRad?: number;
}): TravelFacingResult => {
  const minSpeed = options.minSpeed ?? PLAYER_TRAVEL_FACING_MIN_SPEED_MPS;
  const clickArrive = options.clickArriveRad ?? PLAYER_CLICK_FACE_ARRIVE_RAD;

  if (options.clickFaceYaw != null && Number.isFinite(options.clickFaceYaw)) {
    const yaw = smoothYawToward({
      currentYaw: options.currentYaw,
      desiredYaw: options.clickFaceYaw,
      dt: options.dt,
      turnSpeed: options.clickTurnSpeed ?? PLAYER_CLICK_FACE_TURN_RAD_S,
    });
    const arrived =
      Math.abs(shortestYawDelta(yaw, options.clickFaceYaw)) <= clickArrive;
    return { yawRadians: yaw, clearClickFace: arrived };
  }

  let desired =
    yawFromFlatDirection(options.velocity.x, options.velocity.z, minSpeed) ??
    null;
  if (desired === null && options.nextTarget) {
    desired = yawFromFlatDirection(
      options.nextTarget.x - options.position.x,
      options.nextTarget.z - options.position.z,
      minSpeed
    );
  }
  if (desired === null) {
    return { yawRadians: options.currentYaw, clearClickFace: false };
  }
  return {
    yawRadians: smoothYawToward({
      currentYaw: options.currentYaw,
      desiredYaw: desired,
      dt: options.dt,
      turnSpeed: options.turnSpeed,
    }),
    clearClickFace: false,
  };
};
