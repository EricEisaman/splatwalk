/**
 * Canonical IndexedDB navmesh cache signature for Fast Nav.
 *
 * Every field that changes baked nav geometry or post-Recast island selection
 * must appear here so UI knobs (scale, prune, region, floor bands, Recast, …)
 * cannot hit a stale entry.
 */

import type { MeshSettings } from '@/wasm/bridge';

/** Bump when the signature shape changes so incomplete historical keys never collide. */
export const FAST_NAV_CACHE_SCHEMA_VERSION = 1;

/** Floor-field host pipeline id (TS extract, not WASM floor_field height strip). */
export const FAST_NAV_FLOOR_PIPELINE = 'ts-extract-v1';

export interface FastNavCacheSignatureInput {
  readonly algo: string;
  /**
   * MeshSettings after region pin / prune / mesh overrides.
   * `collision_seed` and `camera_position` are stripped (derived / view-only).
   */
  readonly base: MeshSettings;
  readonly recovery: unknown;
  readonly recastAttempts: unknown;
  readonly denseSeed?: unknown;
  /** Caller-specific extras (e.g. R3F active mode) merged under `extras`. */
  readonly extras?: Record<string, unknown> | null;
  readonly floorMesh?: unknown;
  readonly floorPipeline?: string | null;
  readonly islandValidation?: unknown;
  readonly seedCenteredOutdoor?: boolean;
  readonly strayTrim?: unknown;
}

/**
 * Strip non-geometry / derived fields from MeshSettings before hashing.
 * Region AABB stays; camera view pose and collision seed do not.
 */
export const meshSettingsForCacheSignature = (
  settings: MeshSettings
): Record<string, unknown> => {
  const {
    camera_position: _cameraPosition,
    collision_seed: _collisionSeed,
    ...rest
  } = settings as MeshSettings & {
    camera_position?: unknown;
    collision_seed?: unknown;
  };
  return { ...rest };
};

/**
 * Build a stable plain-object signature for {@link buildNavmeshKey}.
 */
export const buildFastNavCacheSignature = (
  input: FastNavCacheSignatureInput
): Record<string, unknown> => {
  const signature: Record<string, unknown> = {
    schemaVersion: FAST_NAV_CACHE_SCHEMA_VERSION,
    algo: input.algo,
    floorPipeline: input.floorPipeline ?? null,
    base: meshSettingsForCacheSignature(input.base),
    recovery: input.recovery ?? null,
    strayTrim: input.strayTrim ?? null,
    denseSeed: input.denseSeed ?? null,
    floorMesh: input.floorMesh ?? null,
    seedCenteredOutdoor: input.seedCenteredOutdoor === true,
    islandValidation: input.islandValidation ?? null,
    recastAttempts: input.recastAttempts ?? null,
  };
  if (input.extras && Object.keys(input.extras).length > 0) {
    signature.extras = input.extras;
  }
  return signature;
};
