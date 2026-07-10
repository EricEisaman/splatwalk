/**
 * Shared Fast Nav override settings used by Storage Adapter, Vuetify, and React demos.
 */

/** User-tunable Fast Nav overrides (floor field + Recast agent). */
export interface DemoNavSettings {
  /** Per-cell height band above reference floor (m). */
  cellBandAbove: number;
  /** Per-cell height band below reference floor (m). */
  cellBandBelow: number;
  /** Hole-fill radius in field cells. */
  holeFillRadius: number;
  /** Max horizontal distance (m) from seed to accepted nav island centroid. */
  maxIslandSeedDistance: number;
  /** Max local height variance for floor field (m). */
  maxLocalHeightVariance: number;
  /** Recast min region area (cells before squaring). */
  minRegionArea: number;
  /** WASM statistical outlier removal before Fast Nav / collision bake. */
  pruneFloaters: boolean;
  /** Component-median band above seed floor (m) — widen for bowls/ramps. */
  sameLevelAbove: number;
  /** Component-median band below seed floor (m). */
  sameLevelBelow: number;
  /** SDF cell size (m); larger = coarser outdoor coverage. */
  sdfCellSize: number;
  /** SDF density threshold; lower accepts sparser ground. */
  sdfDensityThreshold: number;
  /** Recast max climb (m). */
  walkableClimb: number;
  /** Recast agent radius (m); smaller = less erosion. */
  walkableRadius: number;
  /** Recast max slope (degrees); higher for bowls/ramps. */
  walkableSlopeAngle: number;
}

/** Outdoor-friendly defaults (wider height bands + steeper slopes than indoor). */
export const DEFAULT_DEMO_NAV_SETTINGS: DemoNavSettings = {
  cellBandAbove: 2.5,
  cellBandBelow: 2.0,
  holeFillRadius: 4,
  maxIslandSeedDistance: 80,
  maxLocalHeightVariance: 0.35,
  minRegionArea: 2,
  pruneFloaters: true,
  sameLevelAbove: 2.0,
  sameLevelBelow: 1.5,
  sdfCellSize: 0.2,
  sdfDensityThreshold: 0.03,
  walkableClimb: 0.65,
  walkableRadius: 0.35,
  walkableSlopeAngle: 55,
};

/** @deprecated Prefer {@link DemoNavSettings}. */
export type StreamedNavSettings = DemoNavSettings;

/** @deprecated Prefer {@link DEFAULT_DEMO_NAV_SETTINGS}. */
export const DEFAULT_STREAMED_NAV_SETTINGS = DEFAULT_DEMO_NAV_SETTINGS;

/** Slice of {@link DemoNavSettings} passed into {@link runFastNav} tuning knobs. */
export interface FastNavTuningFromSettings {
  readonly floorMesh: {
    sameLevelBelow: number;
    sameLevelAbove: number;
    cellBandBelow: number;
    cellBandAbove: number;
  };
  readonly islandValidation: { maxSeedDistance: number };
  readonly meshSettings: {
    sdf_cell_size: number;
    sdf_density_threshold: number;
    max_local_height_variance: number;
    hole_fill_radius: number;
  };
  readonly prune: { enabled: boolean };
  readonly recastOverrides: {
    walkableSlopeAngle: number;
    walkableRadius: number;
    walkableClimb: number;
    minRegionArea: number;
  };
}

/** Map demo NM settings into {@link runFastNav} option fragments. */
export const demoNavSettingsToFastNavTuning = (
  settings: DemoNavSettings
): FastNavTuningFromSettings => ({
  prune: { enabled: settings.pruneFloaters },
  meshSettings: {
    sdf_cell_size: settings.sdfCellSize,
    sdf_density_threshold: settings.sdfDensityThreshold,
    max_local_height_variance: settings.maxLocalHeightVariance,
    hole_fill_radius: settings.holeFillRadius,
  },
  floorMesh: {
    sameLevelBelow: settings.sameLevelBelow,
    sameLevelAbove: settings.sameLevelAbove,
    cellBandBelow: settings.cellBandBelow,
    cellBandAbove: settings.cellBandAbove,
  },
  recastOverrides: {
    walkableSlopeAngle: settings.walkableSlopeAngle,
    walkableRadius: settings.walkableRadius,
    walkableClimb: settings.walkableClimb,
    minRegionArea: settings.minRegionArea,
  },
  islandValidation: {
    maxSeedDistance: settings.maxIslandSeedDistance,
  },
});
