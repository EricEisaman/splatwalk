/**
 * Public entry point for integrators consuming the SplatWalk FAST NAV showcase.
 *
 * The adaptive floor-field recovery ladder is built-in and on by default at every
 * layer (component, composable, and `runFastNav`). Override it by passing a
 * `recovery` prop/option; extend the default ladder via {@link DEFAULT_FAST_NAV_RECOVERY}.
 */
export { default as SplatFastNavShowcase } from '@/components/vuetify/SplatFastNavShowcase.vue';
export { DEFAULT_EXAMPLE_SCENES, type ExampleScene } from '@/components/vuetify/SplatFastNavShowcase.vue';

export {
  useSplatFastNav,
  type UseSplatFastNav,
  type UseSplatFastNavOptions,
  type FastNavStatus,
  type FastNavUiPhase,
  type FastNavProgress,
  type LogTag,
  type LogEntry,
} from '@/composables/useSplatFastNav';

export {
  runFastNav,
  readSplatBytes,
  buildFastFloorMesh,
  trimStrayFloorCells,
  estimateDenseFloorSeed,
  estimateDenseFloorRegion,
  extractFloorFieldWithRecovery,
  resolveRecovery,
  defaultFastMeshSettings,
  FastNavFloorError,
  DEFAULT_FAST_NAV_RECOVERY,
  FAST_NAV_PRESET,
  type FastNavOptions,
  type FastNavResult,
  type FastNavLogger,
  type FastNavPhase,
  type FastNavPhaseListener,
  type FastNavRecoveryConfig,
  type FastNavRecoveryStep,
  type FastNavFloorReason,
  type FastNavFloorDiagnostics,
  type FastFloorMesh,
  type StrayTrimOptions,
  type StrayTrimResult,
  type DenseSeedOptions,
  type PruneFloatersOptions,
  type ExtractFloorFieldArgs,
  type ExtractFloorFieldResult,
  type WalkableGroundFieldBuilder,
} from '@/navigation/fastNav';

/**
 * The framework-agnostic floor module is the published, binary-friendly surface.
 * It re-exports the same floor logic without any Babylon dependency, so non-Babylon
 * and binary-only integrators can import just this module.
 */
export * as floor from '@/navigation/floor';

/** Camera-pose → AABB select region (host toolset; WASM still uses region_min/max). */
export {
  DEFAULT_CAMERA_SELECT_REGION_OFFSETS,
  poseFromCameraSelectView,
  regionBoundsFromCameraPose,
  regionBoundsFromCameraSelect,
  type CameraSelectRegionInput,
  type CameraSelectRegionOffsets,
  type CameraSelectRegionPose,
  type CameraSelectView,
  type RegionBoundsAabb,
} from '@/navigation/cameraSelectRegion';

/** WASM core data-contract types, published so binary-only integrators get real types. */
export type {
  MeshSettings,
  OutputSpaceSettings,
  MeshBuffers,
  CoordinateSpace,
  FloorPlane,
  FieldBasis,
  GroundFieldCell,
  GroundFieldCellState,
  ReconstructionDiagnostics,
  ReconstructionResult,
  SplatBounds,
  SuggestedRegion,
  NavmeshBasisResult,
  WalkableGroundFieldResult,
  ResultContract,
} from '@/wasm/bridge';
