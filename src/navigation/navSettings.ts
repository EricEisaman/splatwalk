/**
 * Shared Fast Nav override settings used by Storage Adapter, Vuetify, React, and playground.
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

export type DemoNavSceneType = 'indoor' | 'outdoor';

export type DemoNavSliderKey = Exclude<keyof DemoNavSettings, 'pruneFloaters'>;

export type DemoNavSliderSection = 'floor' | 'recast';

export type DemoNavSliderColor = 'primary' | 'secondary' | 'success' | 'warning';

/** Shared slider metadata for Floor coverage / Recast agent panels. */
export interface DemoNavSliderField {
  readonly color?: DemoNavSliderColor;
  readonly key: DemoNavSliderKey;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly section: DemoNavSliderSection;
  readonly step: number;
}

/**
 * Indoor defaults aligned with {@link FAST_NAV_PRESET} / floor.ts tight bands
 * (excludes furniture tops on PurplePad / Bedroom).
 */
export const DEFAULT_INDOOR_DEMO_NAV_SETTINGS: DemoNavSettings = {
  cellBandAbove: 0.45,
  cellBandBelow: 0.5,
  holeFillRadius: 2,
  /** Room-scale diagonal; outdoor merge still uses 80. */
  maxIslandSeedDistance: 20,
  maxLocalHeightVariance: 0.14,
  minRegionArea: 2,
  pruneFloaters: true,
  sameLevelAbove: 0.3,
  sameLevelBelow: 0.25,
  sdfCellSize: 0.14,
  sdfDensityThreshold: 0.06,
  walkableClimb: 0.5,
  walkableRadius: 0.35,
  walkableSlopeAngle: 45,
};

/** Outdoor-friendly defaults (wider height bands + steeper slopes than indoor). */
export const DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS: DemoNavSettings = {
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

/** @deprecated Prefer {@link DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS}. */
export const DEFAULT_DEMO_NAV_SETTINGS = DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS;

/** @deprecated Prefer {@link DemoNavSettings}. */
export type StreamedNavSettings = DemoNavSettings;

/** @deprecated Prefer {@link DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS}. */
export const DEFAULT_STREAMED_NAV_SETTINGS = DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS;

export const DEMO_NAV_SLIDER_FIELDS: readonly DemoNavSliderField[] = [
  { key: 'sameLevelBelow', label: 'Band below (m)', min: 0.25, max: 4, step: 0.05, section: 'floor' },
  { key: 'sameLevelAbove', label: 'Band above (m)', min: 0.3, max: 4, step: 0.05, section: 'floor' },
  { key: 'holeFillRadius', label: 'Hole fill (cells)', min: 0, max: 8, step: 1, section: 'floor' },
  {
    key: 'sdfCellSize',
    label: 'SDF cell (m)',
    min: 0.1,
    max: 0.4,
    step: 0.01,
    color: 'secondary',
    section: 'floor',
  },
  {
    key: 'sdfDensityThreshold',
    label: 'Density thresh',
    min: 0.01,
    max: 0.12,
    step: 0.005,
    color: 'secondary',
    section: 'floor',
  },
  {
    key: 'maxLocalHeightVariance',
    label: 'Height variance',
    min: 0.08,
    max: 0.6,
    step: 0.02,
    color: 'secondary',
    section: 'floor',
  },
  {
    key: 'walkableSlopeAngle',
    label: 'Max slope (°)',
    min: 30,
    max: 70,
    step: 1,
    color: 'success',
    section: 'recast',
  },
  {
    key: 'walkableRadius',
    label: 'Agent radius (m)',
    min: 0.15,
    max: 0.6,
    step: 0.05,
    color: 'success',
    section: 'recast',
  },
  {
    key: 'walkableClimb',
    label: 'Max climb (m)',
    min: 0.25,
    max: 1,
    step: 0.05,
    color: 'success',
    section: 'recast',
  },
  {
    key: 'minRegionArea',
    label: 'Min region',
    min: 0,
    max: 24,
    step: 1,
    color: 'success',
    section: 'recast',
  },
  {
    key: 'maxIslandSeedDistance',
    label: 'Island↔seed max (m)',
    min: 6,
    max: 200,
    step: 2,
    color: 'warning',
    section: 'recast',
  },
  { key: 'cellBandBelow', label: 'Cell band − (m)', min: 0.5, max: 4, step: 0.1, section: 'recast' },
  { key: 'cellBandAbove', label: 'Cell band + (m)', min: 0.45, max: 4, step: 0.1, section: 'recast' },
] as const;

export const DEMO_NAV_FLOOR_SLIDER_FIELDS = DEMO_NAV_SLIDER_FIELDS.filter(
  (field) => field.section === 'floor'
);

export const DEMO_NAV_RECAST_SLIDER_FIELDS = DEMO_NAV_SLIDER_FIELDS.filter(
  (field) => field.section === 'recast'
);

/**
 * Resolve indoor/outdoor demo NM preset.
 * @param sceneType - collision / example scene type
 * @param preservePrune - when set, keeps the caller's pruneFloaters flag
 */
export const demoNavSettingsForSceneType = (
  sceneType: DemoNavSceneType,
  options?: { readonly preservePrune?: boolean }
): DemoNavSettings => {
  const base =
    sceneType === 'indoor'
      ? { ...DEFAULT_INDOOR_DEMO_NAV_SETTINGS }
      : { ...DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS };
  if (options?.preservePrune !== undefined) {
    base.pruneFloaters = options.preservePrune;
  }
  return base;
};

/** Slice of {@link DemoNavSettings} passed into {@link runFastNav} tuning knobs. */
export interface FastNavTuningFromSettings {
  readonly floorMesh: {
    sameLevelBelow: number;
    sameLevelAbove: number;
    cellBandBelow: number;
    cellBandAbove: number;
  };
  readonly islandValidation: { maxSeedDistance: number; mergeNearbyIslands: boolean };
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
    mergeNearbyIslands:
      settings.maxIslandSeedDistance >= DEFAULT_OUTDOOR_DEMO_NAV_SETTINGS.maxIslandSeedDistance,
  },
});
