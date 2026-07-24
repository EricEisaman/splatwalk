/**
 * Stable contract for Splatwalk NavKit zip packs (core product).
 * Engine-agnostic: hosts map oriented-space poses to their own camera / avatar.
 *
 * Layout:
 *   meta-nav.json
 *   model/<originalFileName>
 *   nav/<NAV_ARTIFACT_FILES members>
 */

import type { ActiveNavigationModeArtifact } from '@/navigation/navArtifactContract';
import type { NavGenerationMode } from '@/navigation/voxelNavSettings';

/** Root envelope filename — detection marker for NavKit zips. */
export const NAV_KIT_META_FILE = 'meta-nav.json';

/** Directory prefix for the original splat model member. */
export const NAV_KIT_MODEL_PREFIX = 'model/';

/** Directory prefix for nested nav artifact members (v1). */
export const NAV_KIT_NAV_PREFIX = 'nav/';

export const NAV_KIT_FORMAT = 'splatwalk_navkit_v1';

export type NavKitModelExtension = 'ply' | 'spz' | 'splat';

/** Initial player input mode after NavKit restore (and live demo Controls UI). */
export type NavKitControlsMode = 'click_to_move' | 'wasdqe' | 'both';

export interface NavKitModelRefV1 {
  readonly extension: NavKitModelExtension;
  readonly filename: string;
  /** Zip member path, e.g. `model/scene.ply`. */
  readonly path: string;
}

/** Oriented / nav-world XYZ (same space as nav_session spawn/region). */
export interface NavKitVec3V1 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Axis-aligned selection region in oriented space. */
export interface NavKitRegionV1 {
  readonly max: readonly [number, number, number];
  readonly min: readonly [number, number, number];
}

export interface NavKitControlsV1 {
  /** Initial input mode after restore. */
  readonly mode: NavKitControlsMode;
}

/** Default Controls UI / Download NavKit / missing meta.controls. */
export const DEFAULT_NAV_KIT_CONTROLS_MODE_NEW: NavKitControlsMode = 'both';

export const NAV_KIT_CONTROLS_MODES: readonly NavKitControlsMode[] = [
  'click_to_move',
  'wasdqe',
  'both',
] as const;

/**
 * Root `meta-nav.json` envelope for a NavKit pack.
 * Optional pose/controls fields are additive within v1.
 * Camera restore uses oriented-space {@link camPos}+{@link camTarget} (engine-neutral).
 */
export interface NavKitMetaV1 {
  /**
   * Optional Y-up pitch/yaw/roll (°). Restore prefers {@link camPos}+{@link camTarget};
   * euler is a fallback only.
   */
  readonly camEulerDeg?: NavKitVec3V1 | null;
  readonly camPos?: NavKitVec3V1 | null;
  /** Look-at point paired with {@link camPos} (preferred restore path). */
  readonly camTarget?: NavKitVec3V1 | null;
  readonly controls?: NavKitControlsV1;
  readonly createdAt: string;
  readonly defaultActiveNavigationMode: ActiveNavigationModeArtifact;
  readonly defaultLocomotionMode: 'recast_crowd' | 'voxel_walk';
  /** UI Nav generation technique used when the kit was built. */
  readonly defaultNavTechnique: NavGenerationMode;
  readonly format: typeof NAV_KIT_FORMAT;
  readonly model: NavKitModelRefV1;
  /** Fixed `nav/` for v1; allows future layout bumps. */
  readonly navPrefix: typeof NAV_KIT_NAV_PREFIX;
  readonly playerEulerDeg?: NavKitVec3V1 | null;
  readonly playerPos?: NavKitVec3V1 | null;
  readonly region?: NavKitRegionV1 | null;
  readonly slug: string;
  readonly title: string;
  readonly version: 1;
}

/** Hint for drop / upload UI. */
export const NAV_KIT_UPLOAD_HINT =
  'Drop or upload a navkit-<slug>.zip (meta-nav.json + model/ + nav/ artifacts). ' +
  'Legacy nav-artifacts zips still work via Upload nav artifacts when a splat is already loaded.';

/** One-line legend for WASDQE / Both modes. */
export const NAV_KIT_WASDQE_LEGEND =
  'W/S move · A/D turn · Q/E strafe';
