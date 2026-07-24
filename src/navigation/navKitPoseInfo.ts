/**
 * Shared live pose readout helpers for Camera / Player Information panels.
 * Formats match values Download NavKit writes into meta-nav.json.
 */

export interface NavKitPoseVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface NavKitCameraPoseInfo {
  readonly eulerDegrees: NavKitPoseVec3;
  readonly mode: string | null;
  readonly position: NavKitPoseVec3;
  readonly target: NavKitPoseVec3 | null;
}

export interface NavKitPlayerPoseInfo {
  readonly available: boolean;
  readonly eulerDegrees: NavKitPoseVec3;
  readonly position: NavKitPoseVec3;
}

const ZERO: NavKitPoseVec3 = { x: 0, y: 0, z: 0 };

export const emptyNavKitCameraPoseInfo = (): NavKitCameraPoseInfo => ({
  eulerDegrees: { ...ZERO },
  mode: null,
  position: { ...ZERO },
  target: null,
});

export const emptyNavKitPlayerPoseInfo = (): NavKitPlayerPoseInfo => ({
  available: false,
  eulerDegrees: { ...ZERO },
  position: { ...ZERO },
});

export const formatNavKitCameraCopyText = (info: NavKitCameraPoseInfo): string => {
  const p = info.position;
  const e = info.eulerDegrees;
  let text =
    `camPos=[${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}] ` +
    `camEulerDeg=[${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)}]`;
  if (info.target) {
    const t = info.target;
    text += ` camTarget=[${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}]`;
  }
  if (info.mode) {
    text += ` mode=${info.mode}`;
  }
  return text;
};

export const formatNavKitPlayerCopyText = (info: NavKitPlayerPoseInfo): string => {
  if (!info.available) {
    return 'playerPos=(none) playerEulerDeg=(none)';
  }
  const p = info.position;
  const e = info.eulerDegrees;
  return (
    `playerPos=[${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}] ` +
    `playerEulerDeg=[${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)}]`
  );
};

export const formatPosePositionLabel = (p: NavKitPoseVec3): string =>
  `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;

export const formatPoseEulerLabel = (e: NavKitPoseVec3): string =>
  `X ${e.x.toFixed(1)}° · Y ${e.y.toFixed(1)}° · Z ${e.z.toFixed(1)}°`;

/** Look-at distance when deriving a target from oriented Y-up euler (°). */
export const NAV_KIT_LOOK_DISTANCE = 10;

/** Pitch clamp for oriented euler (°); values beyond this are clamped. */
const MAX_ORIENTED_PITCH_DEG = 89;

export type NavKitCameraLookEncoding = 'explicit_target' | 'oriented_euler';

export interface NavKitCameraLook {
  readonly encoding: NavKitCameraLookEncoding;
  readonly position: NavKitPoseVec3;
  readonly target: NavKitPoseVec3;
}

/**
 * Resolve NavKit camera meta into a position/target pair for restore.
 * Prefers explicit `camTarget`; otherwise derives target from oriented Y-up euler.
 * Hosts map the resulting eye/look-at into their own camera type.
 */
export const resolveNavKitCameraLook = (options: {
  readonly eulerDegrees?: NavKitPoseVec3 | null;
  readonly lookDistance?: number;
  readonly position: NavKitPoseVec3;
  readonly target?: NavKitPoseVec3 | null;
}): NavKitCameraLook => {
  const p = options.position;
  if (
    options.target &&
    Number.isFinite(options.target.x) &&
    Number.isFinite(options.target.y) &&
    Number.isFinite(options.target.z)
  ) {
    return {
      encoding: 'explicit_target',
      position: { x: p.x, y: p.y, z: p.z },
      target: {
        x: options.target.x,
        y: options.target.y,
        z: options.target.z,
      },
    };
  }

  const e = options.eulerDegrees ?? ZERO;
  const dist = options.lookDistance ?? NAV_KIT_LOOK_DISTANCE;
  const degToRad = Math.PI / 180;
  const pitchDeg = Math.max(
    -MAX_ORIENTED_PITCH_DEG,
    Math.min(MAX_ORIENTED_PITCH_DEG, e.x)
  );
  const pitch = pitchDeg * degToRad;
  const yaw = e.y * degToRad;
  const fx = Math.sin(yaw) * Math.cos(pitch);
  const fy = -Math.sin(pitch);
  const fz = Math.cos(yaw) * Math.cos(pitch);
  return {
    encoding: 'oriented_euler',
    position: { x: p.x, y: p.y, z: p.z },
    target: {
      x: p.x + fx * dist,
      y: p.y + fy * dist,
      z: p.z + fz * dist,
    },
  };
};
