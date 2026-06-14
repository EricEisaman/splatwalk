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
} from '@/navigation/fastNav';
