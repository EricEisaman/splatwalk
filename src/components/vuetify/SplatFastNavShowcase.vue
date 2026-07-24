<script lang="ts">
import { DEFAULT_FAST_NAV_RECOVERY, type FastNavRecoveryConfig, type StrayTrimOptions, type PruneFloatersOptions } from '@/navigation/fastNav';

/** A selectable example splat scene shown in the "Example scenes" menu. */
export interface ExampleScene {
  readonly collisionSceneType: 'indoor' | 'outdoor';
  readonly title: string;
  readonly url: string;
}

/** Built-in example scenes; override via the `exampleScenes` prop. */
export const DEFAULT_EXAMPLE_SCENES: readonly ExampleScene[] = [
  {
    collisionSceneType: 'indoor',
    title: 'Bedroom',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/bedroom.ply',
  },
  {
    collisionSceneType: 'indoor',
    title: 'PurplePad',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/PurplePad.spz',
  },
  {
    collisionSceneType: 'outdoor',
    title: 'Bridge',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/Bridge.spz',
  },
  {
    collisionSceneType: 'outdoor',
    title: 'Meadow',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/meadow.spz',
  },
  {
    collisionSceneType: 'outdoor',
    title: 'Tropical Compound',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/tropical_compound.ply',
  },
  {
    collisionSceneType: 'indoor',
    title: 'Industrial Warehouse',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/industrial_warehouse.ply',
  },
  {
    collisionSceneType: 'indoor',
    title: 'Stairs',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/stairs.spz',
  },
];

// Re-exported so integrators can extend the built-in recovery ladder.
export { DEFAULT_FAST_NAV_RECOVERY };
export type { FastNavRecoveryConfig, StrayTrimOptions, PruneFloatersOptions };
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance } from 'vue';

import { useBabylonViewer } from '@/composables/useBabylonViewer';
import { useSplatFastNav, type LogTag, type SogExportMode } from '@/composables/useSplatFastNav';
import {
  ACTIVE_NAVIGATION_MODE_OPTIONS,
  activeNavigationModeLabel,
  liveNavBackendLabel,
  type ActiveNavigationMode,
} from '@/navigation/activeNavigation';
import {
  DEMO_NAV_FLOOR_SLIDER_FIELDS,
  DEMO_NAV_RECAST_SLIDER_FIELDS,
} from '@/navigation/navSettings';
import type { BabylonRendererPreference } from '@/scene/createBabylonEngine';
import { downloadIntegrationKit } from '@/utils/downloadIntegrationKit';
import {
  clampSliceSettingsForScene,
  DEFAULT_AUTO_SLICE_THRESHOLD,
  DEFAULT_SLICE_SETTINGS,
  type SliceSettings,
} from '@/wasm/sogTypes';

const props = withDefaults(
  defineProps<{
    /** Override/extend the built-in adaptive FAST NAV recovery ladder. */
    recovery?: Partial<FastNavRecoveryConfig>;
    /** Override stray-floater trimming of the detected floor (on by default). */
    strayTrim?: StrayTrimOptions;
    /** Override WASM-side floater pruning / statistical outlier removal (on by default). */
    prune?: PruneFloatersOptions;
    /** Override the example scenes shown in the "Example scenes" menu. */
    exampleScenes?: readonly ExampleScene[];
    /** Override the default SOG export / streamed-slice settings. */
    slice?: SliceSettings;
    /**
     * Splat count above which streamed (LOD) export is recommended by default.
     * Defaults to {@link DEFAULT_AUTO_SLICE_THRESHOLD} (1,000,000).
     */
    autoSliceThreshold?: number;
  }>(),
  {
    // Empty object resolves to DEFAULT_FAST_NAV_RECOVERY inside the pipeline,
    // so adaptive recovery is built-in even when no prop is supplied.
    recovery: () => ({}),
    strayTrim: undefined,
    prune: undefined,
    exampleScenes: () => DEFAULT_EXAMPLE_SCENES,
    slice: () => ({}),
    autoSliceThreshold: DEFAULT_AUTO_SLICE_THRESHOLD,
  }
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const cardRef = ref<ComponentPublicInstance | null>(null);
const isDragging = ref(false);
const isFullscreen = ref(false);

// Babylon is left-handed by default - the one correct setting for everyday use.
// A right-handed scene (scene.useRightHandedSystem, the PR #18606 counterpart) is
// a conformance/regression path only, so it is gated behind a hidden `?rh=1` URL
// flag (the handedness regression scene) rather than a user-facing toggle.
const rightHanded = new URLSearchParams(window.location.search).get('rh') === '1';

const babylon = useBabylonViewer(canvasRef, { rightHanded });
const { activeRenderer, rendererPreference, setRendererPreference } = babylon;
const {
  status,
  statusMessage,
  errorMessage,
  logs,
  isBusy,
  phase,
  progress,
  splatCount,
  maxShDegree,
  maxChunkExtent,
  loadAndProcess,
  loadExample,
  exportSog,
  exportNavmesh,
  downloadNavKit,
  downloadNavArtifacts,
  uploadNavArtifacts,
  hasNavArtifactBundle,
  hasNavKit,
  navArtifactUploadHint,
  navKitUploadHint,
  cameraSelectOffsets,
  resetCameraSelectOffsets,
  cameraInfo,
  cameraInfoCopyText,
  copyCameraPose,
  setCameraInfoPanelOpen,
  playerInfo,
  playerInfoCopyText,
  copyPlayerPose,
  setPlayerInfoPanelOpen,
  applySelectRegionFromCamera,
  generateCollisionBoundary,
  exportCollisionMesh,
  setCollisionBoundaryVisible,
  hasCollisionBoundary,
  setNavMeshVisible,
  setNavMeshEditorEnabled,
  setNavMeshEditorMode,
  navMeshEditorGlobalY,
  navMeshEditorFillHole,
  navMeshEditorDeleteVertices,
  applyNavMeshEditorToLive,
  onNavMeshEditorStatus,
  goToPlayer,
  topDownViewApplied,
  navSettings,
  resetNavSettings,
  hasNavMesh,
  pruneFloaters,
  hasLoadedSplat,
  selectionRegionVisible,
  setSelectionRegionVisible,
  rerunFastNav,
  navGenerationMode,
  collisionSceneType,
  setCollisionSceneType,
  activeNavigationMode,
  setActiveNavigationMode,
  activeNavigationModeDisabledReason,
  liveBackend,
  controlsMode,
  setControlsMode,
  controlsWasdLegend,
  applyEnvironmentScale,
  applyScaleMultiplier,
  sessionEnvironmentScale,
  reset,
} = useSplatFastNav(babylon, { recovery: props.recovery, strayTrim: props.strayTrim, prune: props.prune });

const collisionSceneTypeOptions = [
  { title: 'Indoor (sealed rooms, stairs)', value: 'indoor' },
  { title: 'Outdoor (floor fill)', value: 'outdoor' },
] as const;

const activeModeOptions = ACTIVE_NAVIGATION_MODE_OPTIONS;

const onCollisionSceneType = (sceneType: 'indoor' | 'outdoor' | null): void => {
  if (!sceneType) {
    return;
  }
  setCollisionSceneType(sceneType);
};

const onActiveNavigationMode = (mode: ActiveNavigationMode | null): void => {
  if (!mode) {
    return;
  }
  void setActiveNavigationMode(mode).catch(() => undefined);
};

const navMeshEditorEnabled = ref(false);
const navMeshEditorMode = ref<'vertex' | 'circle' | 'global'>('circle');
const navMeshEditorStatusText = ref('Off');
const navMeshEditorHoleReady = ref(false);
const navMeshEditorDeleteReady = ref(false);
const navMeshEditorPendingApply = ref(false);
const navMeshEditorApplying = ref(false);

/** Camera / Player Information collapsed by default; sampling runs only while open. */
const cameraInfoPanels = ref<number[]>([]);
const playerInfoPanels = ref<number[]>([]);
const cameraInfoCopied = ref(false);
const playerInfoCopied = ref(false);

const cameraPositionLabel = computed(() => {
  const p = cameraInfo.value.position;
  return `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;
});

const cameraEulerLabel = computed(() => {
  const e = cameraInfo.value.eulerDegrees;
  return `X ${e.x.toFixed(1)}° · Y ${e.y.toFixed(1)}° · Z ${e.z.toFixed(1)}°`;
});

const playerPositionLabel = computed(() => {
  if (!playerInfo.value.available) {
    return '—';
  }
  const p = playerInfo.value.position;
  return `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;
});

const playerYawLabel = computed(() => {
  if (!playerInfo.value.available) {
    return '—';
  }
  return `${playerInfo.value.eulerDegrees.y.toFixed(1)}°`;
});

watch(
  cameraInfoPanels,
  (panels) => {
    setCameraInfoPanelOpen(panels.includes(0));
  },
  { deep: true }
);

watch(
  playerInfoPanels,
  (panels) => {
    setPlayerInfoPanelOpen(panels.includes(0));
  },
  { deep: true }
);

const flashCopied = (flag: typeof cameraInfoCopied): void => {
  flag.value = true;
  window.setTimeout(() => {
    flag.value = false;
  }, 1600);
};

const onCopyCameraPose = async (): Promise<void> => {
  const ok = await copyCameraPose();
  if (ok) {
    flashCopied(cameraInfoCopied);
  }
};

const onCopyPlayerPose = async (): Promise<void> => {
  const ok = await copyPlayerPose();
  if (ok) {
    flashCopied(playerInfoCopied);
  }
};

watch(navMeshEditorEnabled, (on) => {
  setNavMeshEditorEnabled(on);
});

const onNavMeshEditorModeChange = (mode: 'vertex' | 'circle' | 'global' | null): void => {
  if (!mode) {
    return;
  }
  navMeshEditorMode.value = mode;
  setNavMeshEditorMode(mode);
};

let unsubNavMeshEditorStatus: (() => void) | null = null;
onMounted(() => {
  unsubNavMeshEditorStatus = onNavMeshEditorStatus((st) => {
    if (!st.enabled) {
      navMeshEditorStatusText.value = 'Off';
      navMeshEditorHoleReady.value = false;
      navMeshEditorDeleteReady.value = false;
      navMeshEditorPendingApply.value = false;
      navMeshEditorApplying.value = false;
      return;
    }
    if (navMeshEditorMode.value !== st.mode) {
      navMeshEditorMode.value = st.mode;
    }
    const parts = [
      st.mode,
      st.brushFollow ? 'follow' : 'pinned',
      `${st.selectedCount} sel`,
      `r=${st.brushRadius.toFixed(2)}`,
    ];
    if (st.holeDetected) {
      parts.push('hole');
    }
    if (st.hasPendingLiveApply) {
      parts.push('pending apply');
    }
    if (st.rebaking) {
      parts.push('applying…');
    }
    if (st.message) {
      parts.push(st.message);
    }
    navMeshEditorStatusText.value = parts.join(' · ');
    navMeshEditorHoleReady.value =
      st.mode === 'circle' && st.holeDetected && !st.rebaking;
    navMeshEditorDeleteReady.value =
      (st.mode === 'vertex' || st.mode === 'circle') &&
      st.selectedCount > 0 &&
      !st.rebaking;
    navMeshEditorPendingApply.value = st.hasPendingLiveApply;
    navMeshEditorApplying.value = st.rebaking;
  });
});

const onApplyNavMeshEditorToLive = (): void => {
  void applyNavMeshEditorToLive();
};
const onDeleteNavMeshEditorVertices = (): void => {
  void navMeshEditorDeleteVertices();
};
const isActiveNavigationModeEnabled = (mode: ActiveNavigationMode): boolean => {
  if (isBusy.value) {
    return false;
  }
  if (navGenerationMode.value === 'floor_field') {
    return mode === 'recast';
  }
  return true;
};

const navArtifactsInputRef = ref<HTMLInputElement | null>(null);

const onApplySelectRegionFromCamera = async (): Promise<void> => {
  try {
    await applySelectRegionFromCamera();
  } catch {
    // logged in composable
  }
};

const onNavArtifactsSelected = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  input.value = '';
  if (files.length === 0) {
    return;
  }
  try {
    await uploadNavArtifacts(files);
  } catch {
    // errorMessage set in composable
  }
};

const onDownloadFastNavKit = (): void => {
  downloadIntegrationKit('vuetify');
};

const onRendererPreferenceChange = (value: unknown): void => {
  if (value !== 'webgl' && value !== 'webgpu') {
    return;
  }
  const preference = value as BabylonRendererPreference;
  void (async () => {
    reset();
    await setRendererPreference(preference);
  })();
};

// --- Streamed SOG export -------------------------------------------------
// Reactive slice settings seeded from the defaults + any `slice` prop override.
const sliceForm = reactive({
  sh_degree: props.slice.sh_degree ?? DEFAULT_SLICE_SETTINGS.sh_degree,
  sh_cluster_count: props.slice.sh_cluster_count ?? DEFAULT_SLICE_SETTINGS.sh_cluster_count,
  sh_iterations: props.slice.sh_iterations ?? DEFAULT_SLICE_SETTINGS.sh_iterations,
  chunk_count: props.slice.chunk_count ?? DEFAULT_SLICE_SETTINGS.chunk_count,
  chunk_extent: props.slice.chunk_extent ?? DEFAULT_SLICE_SETTINGS.chunk_extent,
  lod_levels: props.slice.lod_levels ?? DEFAULT_SLICE_SETTINGS.lod_levels,
});

const isLargeScene = computed(
  () => splatCount.value !== null && splatCount.value > props.autoSliceThreshold
);
// Default to streamed export for large scenes (>1M splats), single otherwise.
const sogMode = ref<SogExportMode>('streamed');
const sogExporting = ref(false);
const sogSummary = ref<string | null>(null);
const collisionBoundaryVisible = ref(true);
const collisionExporting = ref(false);
const navMeshVisible = ref(true);
const collisionSummary = ref<string | null>(null);
const navExporting = ref(false);
const navSummary = ref<string | null>(null);
const environmentScale = ref(1);
const scaleApplying = ref(false);
const scaleSummary = ref<string | null>(null);
/** Expand Navmesh settings on load (Scale Environment visible before Fast Nav). */
const navSettingsPanels = ref<number[]>([0]);

// Auto-pick the recommended mode whenever a new scene's count resolves; the
// user can still flip it before exporting.
watch(splatCount, () => {
  collisionSummary.value = null;
  navSummary.value = null;
  sogSummary.value = null;
  scaleSummary.value = null;
  navMeshVisible.value = true;
  sogMode.value = isLargeScene.value ? 'streamed' : 'single';
});

watch([maxShDegree, maxChunkExtent], () => {
  sliceForm.sh_degree = Math.min(sliceForm.sh_degree, maxShDegree.value);
  sliceForm.chunk_extent = Math.min(sliceForm.chunk_extent, maxChunkExtent.value);
});

const sogStatusText = computed(() => {
  if (sogSummary.value) return sogSummary.value;
  if (splatCount.value === null) return null;
  return isLargeScene.value
    ? `${splatCount.value.toLocaleString()} splats — large scene. Streamed LOD export recommended.`
    : `${splatCount.value.toLocaleString()} splats. Streamed or single SOG export available.`;
});

const showLodLevelsWarning = computed(
  () => sogMode.value === 'streamed' && sliceForm.lod_levels === 1,
);

const sogExportButtonLabel = computed(() =>
  sogMode.value === 'streamed' ? 'Export streamed SOG (.zip)' : 'Export single SOG (.zip)',
);

async function runSogExport(): Promise<void> {
  if (sogExporting.value) return;
  sogExporting.value = true;
  sogSummary.value = null;
  try {
    const archive = await exportSog(
      sogMode.value,
      clampSliceSettingsForScene(sliceForm, {
        maxShDegree: maxShDegree.value,
        maxChunkExtent: maxChunkExtent.value,
      })
    );
    const mb = (archive.byteLength / 1e6).toFixed(1);
    sogSummary.value = `Exported ${archive.chunkCount} chunk(s), ${archive.fileCount} files (${mb} MB).`;
  } catch (error) {
    sogSummary.value = `Export failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    sogExporting.value = false;
  }
}

async function runCollisionGenerate(): Promise<void> {
  if (collisionExporting.value) return;
  collisionExporting.value = true;
  collisionSummary.value = null;
  try {
    const artifact = await generateCollisionBoundary();
    collisionBoundaryVisible.value = true;
    collisionSummary.value = `Collision boundary: ${artifact.result.mesh.vertex_count} vertices, ${artifact.result.mesh.face_count} faces.`;
  } catch (error) {
    collisionSummary.value = `Collision generation failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    collisionExporting.value = false;
  }
}

async function runCollisionExport(): Promise<void> {
  if (collisionExporting.value) return;
  collisionExporting.value = true;
  try {
    const bytes = await exportCollisionMesh();
    collisionSummary.value = `Exported collision mesh (${(bytes.byteLength / 1e6).toFixed(1)} MB).`;
  } catch (error) {
    collisionSummary.value = `Collision export failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    collisionExporting.value = false;
  }
}

async function runNavmeshExport(): Promise<void> {
  if (navExporting.value) return;
  navExporting.value = true;
  try {
    await exportNavmesh();
    navSummary.value = 'Navmesh export started.';
  } catch (error) {
    navSummary.value = `Navmesh export failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    navExporting.value = false;
  }
}

function onNavMeshVisible(visible: boolean): void {
  navMeshVisible.value = visible;
  setNavMeshVisible(visible);
}

async function runApplyEnvironmentScale(): Promise<void> {
  if (scaleApplying.value || isBusy.value) return;
  const factor = Number(environmentScale.value);
  if (!Number.isFinite(factor) || factor <= 0) {
    scaleSummary.value = 'Scale multiplier must be a positive number.';
    return;
  }
  scaleApplying.value = true;
  scaleSummary.value = null;
  try {
    await applyEnvironmentScale(factor);
    environmentScale.value = 1;
    scaleSummary.value =
      status.value === 'done'
        ? `Session scale: ${sessionEnvironmentScale.value}.`
        : `Session scale: ${sessionEnvironmentScale.value} — applies on next Fast Nav.`;
  } catch (error) {
    scaleSummary.value = `Scale failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    scaleApplying.value = false;
  }
}

// Human-readable progress suffix (e.g. "Pruning floaters 42%") when the worker
// reports a real fraction during the prune pass.
const progressText = computed(() => {
  const p = progress.value;
  if (!p) return null;
  const labels: Record<string, string> = {
    parse: 'Parsing splat',
    prune: pruneFloaters.value ? 'Pruning floaters' : 'Ingesting splat',
    field: 'Building floor field',
  };
  const base = labels[p.stage] ?? 'Processing';
  return p.fraction !== null ? `${base} ${Math.round(p.fraction * 100)}%` : base;
});

const showSnackbar = computed({
  get: () => errorMessage.value !== null,
  set: (value: boolean) => {
    if (!value) {
      errorMessage.value = null;
    }
  },
});

const showDropZone = computed(() => !hasLoadedSplat.value && (status.value === 'idle' || status.value === 'error'));

/** Selection region after splat load + Fast Nav attempt finished (ok or fail). */
const canUseSelectionRegion = computed(
  () => hasLoadedSplat.value && (status.value === 'done' || status.value === 'error') && !isBusy.value
);

const steps = computed(() => {
  const loadDone = status.value === 'processing' || status.value === 'done';
  const navDone = status.value === 'done';
  const p = phase.value;
  const pruneActive = status.value === 'processing' && p === 'prune';
  const pruneDone = p === 'floor' || p === 'navmesh' || p === 'done';
  const navActive = status.value === 'processing' && (p === 'floor' || p === 'navmesh');
  const pruneLabel = pruneActive && progressText.value
    ? progressText.value
    : pruneFloaters.value
      ? 'Prune outliers'
      : 'Ingest splat';
  return [
    { label: 'Load splat', active: status.value === 'loading', done: loadDone },
    { label: pruneLabel, active: pruneActive, done: pruneDone || navDone },
    { label: 'FAST NAV', active: navActive, done: navDone },
    { label: 'Top-down view', active: false, done: topDownViewApplied.value },
  ];
});

const tagColor: Record<LogTag, string> = {
  info: 'info',
  wait: 'warning',
  warn: 'warning',
  error: 'error',
  success: 'success',
  worker: 'accent',
};

function pickFile(file: File | null | undefined): void {
  if (file) {
    const factor = Number(environmentScale.value);
    if (Number.isFinite(factor) && factor > 0) {
      applyScaleMultiplier(factor);
      environmentScale.value = 1;
    }
    void loadAndProcess(file);
  }
}

function onBrowse(): void {
  fileInputRef.value?.click();
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  pickFile(input.files?.[0]);
  input.value = '';
}

function onDrop(event: DragEvent): void {
  isDragging.value = false;
  pickFile(event.dataTransfer?.files?.[0]);
}

function onLoadExample(
  url: string,
  title: string,
  collisionSceneType: 'indoor' | 'outdoor' = 'indoor'
): void {
  const factor = Number(environmentScale.value);
  if (Number.isFinite(factor) && factor > 0) {
    applyScaleMultiplier(factor);
    environmentScale.value = 1;
  }
  void loadExample(url, title, collisionSceneType);
}

function onReset(): void {
  environmentScale.value = 1;
  scaleSummary.value = null;
  reset();
}

function onSelectionRegionVisible(visible: boolean): void {
  void setSelectionRegionVisible(visible).catch(() => {
    // Error surfaced via errorMessage / snackbar in the composable.
  });
}

const rerunApplying = ref(false);

async function runRerunFastNav(): Promise<void> {
  if (rerunApplying.value || isBusy.value) {
    return;
  }
  const factor = Number(environmentScale.value);
  if (!Number.isFinite(factor) || factor <= 0) {
    scaleSummary.value = 'Scale multiplier must be a positive number.';
    return;
  }
  rerunApplying.value = true;
  try {
    // Factor 1 keeps session scale; factor ≠ 1 multiplies then bakes.
    await rerunFastNav({ scaleMultiplier: factor });
    environmentScale.value = 1;
    scaleSummary.value = `Session scale: ${sessionEnvironmentScale.value}.`;
  } catch {
    // Error surfaced via errorMessage / snackbar.
  } finally {
    rerunApplying.value = false;
  }
}

async function toggleFullscreen(): Promise<void> {
  const el = cardRef.value?.$el as HTMLElement | undefined;
  if (!el) {
    return;
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await el.requestFullscreen();
  }
}

function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement !== null;
  // Let the browser settle the new layout before resizing the Babylon engine.
  window.setTimeout(() => babylon.viewer.value?.resize(), 60);
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange));
onBeforeUnmount(() => {
  setCameraInfoPanelOpen(false);
  setPlayerInfoPanelOpen(false);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  unsubNavMeshEditorStatus?.();
  unsubNavMeshEditorStatus = null;
});
</script>

<template>
  <v-container fluid class="pa-4">
    <v-row justify="center">
      <v-col cols="12" md="10" lg="9">
        <div class="text-h5 font-weight-black text-uppercase mb-1">
          Gaussian Splat <span class="text-primary">FAST NAV</span>
        </div>
        <p class="text-body-2 text-medium-emphasis mb-3">
          Drop a <strong>.ply</strong>, <strong>.spz</strong>, <strong>.splat</strong>, or a
          <strong>navkit.zip</strong> (model + baked nav). Splats load into Babylon.js and
          auto-run Fast Nav (default <strong>floor field</strong>; or
          <strong>voxel collision</strong> / <strong>SDF Marching Cubes</strong> via Navmesh settings)
          → navmesh → crowd → NPC, then frame the player top-down. NavKit restore keeps the saved
          camera pose (no forced top-down).
        </p>

        <div class="d-flex flex-wrap align-center ga-3 mb-3">
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-download"
            :disabled="isBusy"
            @click="onDownloadFastNavKit"
          >
            Download FastNav Component Pack
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-package-down"
            :disabled="!hasNavKit || isBusy"
            :title="navKitUploadHint"
            @click="downloadNavKit"
          >
            Download NavKit
          </v-btn>
          <div class="d-flex align-center flex-wrap ga-2">
            <v-btn-toggle
              :model-value="rendererPreference"
              mandatory
              density="comfortable"
              color="primary"
              :disabled="isBusy"
              @update:model-value="onRendererPreferenceChange"
            >
              <v-btn value="webgpu" prepend-icon="mdi-memory">WebGPU</v-btn>
              <v-btn value="webgl" prepend-icon="mdi-video-3d">WebGL</v-btn>
            </v-btn-toggle>
            <v-chip
              v-if="activeRenderer"
              size="small"
              variant="tonal"
              :color="activeRenderer === 'webgpu' ? 'success' : 'secondary'"
            >
              active: {{ activeRenderer }}
            </v-chip>
          </div>
        </div>
        <p class="text-caption text-medium-emphasis mb-4">
          Renderer recreates the GPU context (clears the scene). WebGPU raises color-attachment
          limits for the GS work buffer and falls back to WebGL if unsupported.
          Override with <code>?renderer=webgl</code> or <code>?renderer=webgpu</code>.
        </p>

        <div class="d-flex flex-wrap ga-2 mb-4">
          <v-chip
            v-for="step in steps"
            :key="step.label"
            :color="step.done ? 'success' : step.active ? 'primary' : undefined"
            :variant="step.done || step.active ? 'flat' : 'outlined'"
            size="small"
          >
            <v-icon start :icon="step.done ? 'mdi-check-circle' : step.active ? 'mdi-loading mdi-spin' : 'mdi-circle-outline'" />
            {{ step.label }}
          </v-chip>
        </div>

        <v-card
          ref="cardRef"
          border
          color="surface"
          class="position-relative overflow-hidden canvas-card"
          :class="{ 'drop-active': isDragging }"
          @dragenter.prevent="isDragging = true"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="onDrop"
        >
          <canvas ref="canvasRef" class="showcase-canvas" />

          <v-btn
            v-if="hasLoadedSplat"
            class="fullscreen-btn"
            :icon="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'"
            :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
            color="primary"
            variant="flat"
            size="small"
            @click="toggleFullscreen"
          />

          <v-overlay
            :model-value="showDropZone"
            contained
            persistent
            scrim="rgba(5, 5, 5, 0.82)"
            class="align-center justify-center"
          >
            <div class="text-center pa-8">
              <v-icon icon="mdi-cloud-upload-outline" size="72" color="primary" class="mb-3" />
              <div class="text-h6 font-weight-bold mb-2">Drop your splat here</div>
              <div class="text-body-2 text-medium-emphasis mb-5">.ply, .spz, or .splat · drag &amp; drop, browse, or pick an example</div>
              <div class="d-flex flex-wrap justify-center align-center ga-3">
                <v-btn color="primary" size="large" prepend-icon="mdi-folder-open" @click="onBrowse">
                  Browse files
                </v-btn>
                <v-menu>
                  <template #activator="{ props: menuProps }">
                    <v-btn
                      v-bind="menuProps"
                      color="secondary"
                      size="large"
                      prepend-icon="mdi-cube-scan"
                      append-icon="mdi-menu-down"
                    >
                      Example scenes
                    </v-btn>
                  </template>
                  <v-list>
                    <v-list-item
                      v-for="scene in props.exampleScenes"
                      :key="scene.url"
                      :title="scene.title"
                      prepend-icon="mdi-cube-outline"
                      @click="onLoadExample(scene.url, scene.title, scene.collisionSceneType)"
                    />
                  </v-list>
                </v-menu>
              </div>
            </div>
          </v-overlay>

          <v-overlay
            :model-value="isBusy"
            contained
            persistent
            scrim="rgba(5, 5, 5, 0.6)"
            class="align-center justify-center"
          >
            <div class="text-center">
              <v-progress-circular
                :indeterminate="!progress || progress.fraction === null"
                :model-value="progress && progress.fraction !== null ? progress.fraction * 100 : undefined"
                color="primary"
                size="64"
                width="5"
                class="mb-3"
              />
              <div class="text-body-1">{{ statusMessage }}</div>
              <div v-if="progressText" class="text-caption text-medium-emphasis mt-1">{{ progressText }}</div>
            </div>
          </v-overlay>
        </v-card>

        <div class="d-flex align-center justify-space-between flex-wrap ga-2 mt-3">
          <div class="text-body-2 text-medium-emphasis">{{ statusMessage }}</div>
          <v-btn
            v-if="status === 'done' || status === 'error'"
            variant="text"
            color="secondary"
            prepend-icon="mdi-refresh"
            @click="onReset"
          >
            Load another
          </v-btn>
        </div>

        <v-expansion-panels v-model="navSettingsPanels" class="mt-4" variant="accordion" multiple>
          <v-expansion-panel>
            <template #title>
              <div class="d-flex align-center ga-2">
                <v-icon icon="mdi-tune-vertical" size="small" color="primary" />
                <span>Navmesh settings</span>
                <v-chip size="x-small" variant="tonal" color="primary">overrides</v-chip>
              </div>
            </template>
            <template #text>
              <p class="text-caption text-medium-emphasis mb-3">
                Scale Environment is a multiplier on the current session scale (starts at 1).
                After Apply / Recompute it resets to 1; the absolute session scale is shown below.
                Orbit: hold <strong class="text-primary">SHIFT</strong> for 10× pan / drive (wheel).
              </p>

              <v-select
                v-model="navGenerationMode"
                :items="[
                  { title: 'Floor field', value: 'floor_field' },
                  { title: 'Voxel collision', value: 'voxel_collision' },
                  { title: 'SDF Marching Cubes', value: 'sdf_marching_cubes' },
                ]"
                item-title="title"
                item-value="value"
                label="Nav generation technique"
                density="compact"
                hide-details
                class="mb-3"
                :disabled="isBusy"
              />
              <v-select
                :model-value="collisionSceneType"
                :items="collisionSceneTypeOptions"
                item-title="title"
                item-value="value"
                label="Scene type"
                density="compact"
                hide-details
                class="mb-3"
                :disabled="isBusy || navGenerationMode === 'floor_field'"
                @update:model-value="onCollisionSceneType"
              />
              <p
                v-if="navGenerationMode !== 'floor_field'"
                class="text-caption text-medium-emphasis mb-3"
              >
                Indoor seals rooms; outdoor keeps open sky / floor fill. Example scenes seed this;
                change it before load or Recompute (applies matching DemoNavSettings bands).
              </p>

              <div class="d-flex align-center flex-wrap ga-2 mb-2">
                <div class="text-subtitle-2">Active navigation mode</div>
                <v-chip size="x-small" variant="tonal" color="secondary">
                  Live: {{ liveNavBackendLabel(liveBackend) }}
                </v-chip>
              </div>
              <v-btn-toggle
                :model-value="activeNavigationMode"
                mandatory
                density="comfortable"
                color="secondary"
                class="mb-2"
                :disabled="isBusy"
                @update:model-value="onActiveNavigationMode"
              >
                <v-btn
                  v-for="option in activeModeOptions"
                  :key="option.value"
                  :value="option.value"
                  :disabled="!isActiveNavigationModeEnabled(option.value)"
                  :title="activeNavigationModeDisabledReason(option.value) ?? option.subtitle"
                >
                  {{ option.title }}
                </v-btn>
              </v-btn-toggle>
              <p class="text-caption text-medium-emphasis mb-4">
                {{ activeModeOptions.find((o) => o.value === activeNavigationMode)?.subtitle }}
                Active: {{ activeNavigationModeLabel(activeNavigationMode) }}.
                The Live chip is what click-to-move uses right now.
              </p>

              <div class="text-subtitle-2 mb-2">Controls</div>
              <v-btn-toggle
                :model-value="controlsMode"
                mandatory
                density="comfortable"
                color="primary"
                class="mb-2"
                :disabled="isBusy || !hasNavMesh"
                @update:model-value="(mode) => mode && setControlsMode(mode)"
              >
                <v-btn value="click_to_move">Click to move</v-btn>
                <v-btn value="wasdqe">WASDQE</v-btn>
                <v-btn value="both">Both</v-btn>
              </v-btn-toggle>
              <p class="text-caption text-medium-emphasis mb-4">
                <template v-if="!hasNavMesh">
                  Run Fast Nav or load a NavKit to enable player controls.
                </template>
                <template v-else-if="controlsMode === 'wasdqe' || controlsMode === 'both'">
                  {{ controlsWasdLegend
                  }}{{ controlsMode === 'both' ? ' · click navmesh also works' : '' }}
                </template>
                <template v-else>Click the green navmesh to move.</template>
              </p>

              <v-expansion-panels v-model="cameraInfoPanels" class="mb-2" variant="accordion" multiple>
                <v-expansion-panel>
                  <template #title>
                    <div class="d-flex align-center ga-2">
                      <v-icon icon="mdi-camera-control" size="small" color="primary" />
                      <span>Camera Information</span>
                    </div>
                  </template>
                  <template #text>
                    <p class="text-caption text-medium-emphasis mb-3">
                      Live camera pose. Values refresh only while this section is open.
                      Download NavKit writes the live pose at click time into
                      <code>meta-nav.json</code> (<code>camPos</code> /
                      <code>camTarget</code> / <code>camEulerDeg</code>).
                    </p>
                    <div class="text-body-2 mb-2 font-monospace">
                      <span class="text-medium-emphasis">Position:</span>
                      {{ cameraPositionLabel }}
                    </div>
                    <div class="text-body-2 mb-3 font-monospace">
                      <span class="text-medium-emphasis">Orientation (euler °):</span>
                      {{ cameraEulerLabel }}
                    </div>
                    <v-btn
                      size="small"
                      variant="tonal"
                      color="primary"
                      prepend-icon="mdi-content-copy"
                      @click="onCopyCameraPose"
                    >
                      {{ cameraInfoCopied ? 'Copied' : 'Copy pose' }}
                    </v-btn>
                    <div class="text-caption text-medium-emphasis mt-2 font-monospace text-wrap">
                      {{ cameraInfoCopyText }}
                    </div>
                  </template>
                </v-expansion-panel>
              </v-expansion-panels>

              <v-expansion-panels v-model="playerInfoPanels" class="mb-4" variant="accordion" multiple>
                <v-expansion-panel>
                  <template #title>
                    <div class="d-flex align-center ga-2">
                      <v-icon icon="mdi-account" size="small" color="primary" />
                      <span>Player Information</span>
                    </div>
                  </template>
                  <template #text>
                    <p class="text-caption text-medium-emphasis mb-3">
                      Live player pose. Values refresh only while this section is open.
                      Download NavKit writes <code>playerPos</code> /
                      <code>playerEulerDeg</code> at click time.
                    </p>
                    <div class="text-body-2 mb-2 font-monospace">
                      <span class="text-medium-emphasis">Position:</span>
                      {{ playerPositionLabel }}
                    </div>
                    <div class="text-body-2 mb-3 font-monospace">
                      <span class="text-medium-emphasis">Yaw °:</span>
                      {{ playerYawLabel }}
                    </div>
                    <div class="d-flex flex-wrap ga-2">
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        prepend-icon="mdi-content-copy"
                        :disabled="!playerInfo.available"
                        @click="onCopyPlayerPose"
                      >
                        {{ playerInfoCopied ? 'Copied' : 'Copy pose' }}
                      </v-btn>
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="secondary"
                        prepend-icon="mdi-account-arrow-down"
                        :disabled="isBusy || !hasNavMesh"
                        @click="goToPlayer"
                      >
                        Go to Player
                      </v-btn>
                    </div>
                    <div class="text-caption text-medium-emphasis mt-2 font-monospace text-wrap">
                      {{ playerInfoCopyText }}
                    </div>
                  </template>
                </v-expansion-panel>
              </v-expansion-panels>

              <div class="d-flex flex-wrap align-center ga-3 mb-4">
                <v-btn
                  color="primary"
                  :loading="rerunApplying"
                  :disabled="isBusy || !canUseSelectionRegion"
                  prepend-icon="mdi-refresh"
                  @click="runRerunFastNav"
                >
                  Recompute
                </v-btn>
                <span class="text-caption text-medium-emphasis">
                  Re-runs the selected technique with current prune, selection region, and session scale
                  (Scale multiplier × session when not 1).
                </span>
              </div>

              <div class="text-subtitle-2 mb-2">Region and prune</div>
              <div class="d-flex flex-wrap align-center ga-6 mb-2">
                <v-switch
                  v-model="navSettings.pruneFloaters"
                  color="primary"
                  density="compact"
                  hide-details
                  label="Prune floaters"
                  :disabled="isBusy"
                />
                <v-switch
                  :model-value="selectionRegionVisible"
                  color="warning"
                  density="compact"
                  hide-details
                  label="Selection region"
                  :disabled="!canUseSelectionRegion"
                  @update:model-value="onSelectionRegionVisible(Boolean($event))"
                />
              </div>
              <p class="text-caption text-medium-emphasis mb-2">
                Prune overrides WASM floater removal for Fast Nav and collision (set before load or before Recompute).
                When Selection region is shown, the yellow box is the pinned consideration
                region (drag/scale with gizmos); when hidden, Fast Nav auto-selects a boxed region.
                Selection region unlocks after the splat loads and Fast Nav finishes (success or fail).
              </p>
              <div class="text-caption text-medium-emphasis mb-2">Camera select AABB (m)</div>
              <v-row density="comfortable" class="mb-1">
                <v-col cols="6" sm="4" md="2">
                  <v-text-field v-model.number="cameraSelectOffsets.left" type="number" label="Left" density="compact" hide-details :min="0" :step="0.5" :disabled="isBusy" />
                </v-col>
                <v-col cols="6" sm="4" md="2">
                  <v-text-field v-model.number="cameraSelectOffsets.right" type="number" label="Right" density="compact" hide-details :min="0" :step="0.5" :disabled="isBusy" />
                </v-col>
                <v-col cols="6" sm="4" md="2">
                  <v-text-field v-model.number="cameraSelectOffsets.forward" type="number" label="Forward" density="compact" hide-details :min="0" :step="0.5" :disabled="isBusy" />
                </v-col>
                <v-col cols="6" sm="4" md="2">
                  <v-text-field v-model.number="cameraSelectOffsets.behind" type="number" label="Behind" density="compact" hide-details :min="0" :step="0.5" :disabled="isBusy" />
                </v-col>
                <v-col cols="6" sm="4" md="2">
                  <v-text-field v-model.number="cameraSelectOffsets.below" type="number" label="Below" density="compact" hide-details :min="0" :step="0.5" :disabled="isBusy" />
                </v-col>
                <v-col cols="6" sm="4" md="2">
                  <v-text-field v-model.number="cameraSelectOffsets.above" type="number" label="Above" density="compact" hide-details :min="0" :step="0.5" :disabled="isBusy" />
                </v-col>
              </v-row>
              <div class="d-flex flex-wrap align-center ga-3 mb-4">
                <v-btn color="warning" variant="tonal" size="small" :disabled="isBusy || !hasLoadedSplat" @click="onApplySelectRegionFromCamera">
                  Apply select region from camera
                </v-btn>
                <v-btn variant="text" size="small" :disabled="isBusy" @click="resetCameraSelectOffsets">
                  Reset offsets
                </v-btn>
              </div>

              <div class="text-subtitle-2 mb-2">Floor coverage</div>
              <v-row density="comfortable">
                <v-col
                  v-for="field in DEMO_NAV_FLOOR_SLIDER_FIELDS"
                  :key="field.key"
                  cols="12"
                  sm="6"
                  md="4"
                >
                  <v-slider
                    v-model="navSettings[field.key]"
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :color="field.color ?? 'primary'"
                    density="compact"
                    thumb-label
                    hide-details
                    :disabled="isBusy"
                  >
                    <template #prepend>
                      <span class="text-caption text-medium-emphasis settings-label">{{ field.label }}</span>
                    </template>
                  </v-slider>
                </v-col>
              </v-row>

              <v-divider class="my-4" />
              <div class="text-subtitle-2 mb-2">Recast agent</div>
              <v-row density="comfortable">
                <v-col
                  v-for="field in DEMO_NAV_RECAST_SLIDER_FIELDS"
                  :key="field.key"
                  cols="12"
                  sm="6"
                  md="4"
                >
                  <v-slider
                    v-model="navSettings[field.key]"
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :color="field.color ?? 'primary'"
                    density="compact"
                    thumb-label
                    hide-details
                    :disabled="isBusy"
                  >
                    <template #prepend>
                      <span class="text-caption text-medium-emphasis settings-label">{{ field.label }}</span>
                    </template>
                  </v-slider>
                </v-col>
              </v-row>

              <div class="d-flex flex-wrap ga-2 mt-4 mb-4">
                <v-btn
                  variant="tonal"
                  color="secondary"
                  prepend-icon="mdi-restore"
                  :disabled="isBusy"
                  @click="resetNavSettings"
                >
                  Reset defaults
                </v-btn>
                <span class="text-caption text-medium-emphasis align-self-center">
                  Recompute to apply floor / Recast changes
                </span>
              </div>

              <v-sheet
                v-if="hasNavMesh"
                border
                rounded="lg"
                class="d-flex align-center flex-wrap ga-4 pa-3 mb-4 navmesh-toggle-bar"
                color="surface"
              >
                <v-icon
                  :icon="navMeshVisible ? 'mdi-layers' : 'mdi-layers-off'"
                  :color="navMeshVisible ? 'success' : 'medium-emphasis'"
                  size="22"
                />
                <div class="flex-grow-1">
                  <div class="text-body-2 font-weight-medium">Navmesh overlay</div>
                  <div class="text-caption text-medium-emphasis">
                    {{
                      navMeshVisible
                        ? 'Green walkable mesh visible — click it to move the player'
                        : 'Hidden — splat view only; click-to-move is off'
                    }}
                  </div>
                </div>
                <v-switch
                  :model-value="navMeshVisible"
                  color="success"
                  density="comfortable"
                  hide-details
                  inset
                  :disabled="isBusy"
                  :label="navMeshVisible ? 'Shown' : 'Hidden'"
                  @update:model-value="onNavMeshVisible(Boolean($event))"
                />
              </v-sheet>

              <v-sheet
                v-if="hasNavMesh"
                border
                rounded="lg"
                class="pa-3 mb-4"
                color="surface"
              >
                <div class="text-body-2 font-weight-medium mb-1">NavMesh Editor</div>
                <div class="text-caption text-medium-emphasis mb-3">
                  Modes: <kbd>1</kbd> Vertex · <kbd>2</kbd> Circle · <kbd>3</kbd> Global Y (0.1 m).
                  Circle: click pin · click/+Shift ±0.1 m · <kbd>2</kbd> resume · <kbd>T</kbd> gizmo ·
                  <kbd>F</kbd> fill · <kbd>X</kbd> delete. Then Apply when needed.
                </div>
                <v-switch
                  v-model="navMeshEditorEnabled"
                  color="pink"
                  density="comfortable"
                  hide-details
                  inset
                  class="mb-3"
                  :disabled="isBusy"
                  :label="navMeshEditorEnabled ? 'Editor on' : 'Editor off'"
                />
                <v-select
                  :model-value="navMeshEditorMode"
                  :items="[
                    { title: '1 Vertex', value: 'vertex' },
                    { title: '2 Circle', value: 'circle' },
                    { title: '3 Global Y', value: 'global' },
                  ]"
                  label="Mode"
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="mb-2"
                  style="max-width: 12rem"
                  :disabled="isBusy || !navMeshEditorEnabled"
                  @update:model-value="onNavMeshEditorModeChange"
                />
                <div v-if="navMeshEditorMode === 'global'" class="mb-2">
                  <div class="text-caption text-medium-emphasis mb-2">Keys: ↑ / ↓ (0.1 m)</div>
                  <div class="d-flex ga-2">
                    <v-btn size="small" variant="tonal" :disabled="!navMeshEditorEnabled" @click="navMeshEditorGlobalY(1)">Up 0.1</v-btn>
                    <v-btn size="small" variant="tonal" :disabled="!navMeshEditorEnabled" @click="navMeshEditorGlobalY(-1)">Down 0.1</v-btn>
                  </div>
                </div>
                <div v-if="navMeshEditorMode === 'circle'" class="mb-2">
                  <div class="text-caption text-medium-emphasis mb-2">
                    Pin circle, grow until pink, then <kbd>F</kbd>
                  </div>
                  <v-btn
                    size="small"
                    color="pink"
                    class="me-2"
                    :disabled="!navMeshEditorHoleReady"
                    @click="navMeshEditorFillHole()"
                  >
                    {{ navMeshEditorHoleReady ? 'Fill gap (F)' : 'Fill gap (waiting for pink / F)' }}
                  </v-btn>
                </div>
                <div v-if="navMeshEditorMode === 'vertex' || navMeshEditorMode === 'circle'" class="mb-2">
                  <v-btn
                    size="small"
                    color="error"
                    :loading="navMeshEditorApplying"
                    :disabled="!navMeshEditorDeleteReady"
                    @click="onDeleteNavMeshEditorVertices"
                  >
                    {{ navMeshEditorDeleteReady ? 'Delete (X)' : 'Delete (select verts / X)' }}
                  </v-btn>
                </div>
                <div v-if="navMeshEditorPendingApply" class="mb-2">
                  <div class="text-caption text-medium-emphasis mb-2">
                    Updates pathfinding and downloadable nav artifacts
                  </div>
                  <v-btn
                    size="small"
                    color="primary"
                    :loading="navMeshEditorApplying"
                    :disabled="navMeshEditorApplying"
                    @click="onApplyNavMeshEditorToLive"
                  >
                    Apply to Live Navmesh
                  </v-btn>
                </div>
                <div class="text-caption">{{ navMeshEditorStatusText }}</div>
              </v-sheet>

              <v-sheet
                v-if="hasCollisionBoundary"
                border
                rounded="lg"
                class="d-flex align-center flex-wrap ga-4 pa-3 mb-4 navmesh-toggle-bar"
                color="surface"
              >
                <v-icon
                  :icon="collisionBoundaryVisible ? 'mdi-cube-outline' : 'mdi-cube-off-outline'"
                  :color="collisionBoundaryVisible ? 'info' : 'medium-emphasis'"
                  size="22"
                />
                <div class="flex-grow-1">
                  <div class="text-body-2 font-weight-medium">
                    {{
                      navGenerationMode === 'sdf_marching_cubes'
                        ? 'MC shell (cyan)'
                        : 'Collision boundary'
                    }}
                  </div>
                  <div class="text-caption text-medium-emphasis">
                    {{
                      collisionBoundaryVisible
                        ? navGenerationMode === 'sdf_marching_cubes'
                          ? 'Cyan interior MC shell visible'
                          : 'Cyan collision boundary visible'
                        : 'Hidden — toggle on to show the cyan overlay'
                    }}
                  </div>
                </div>
                <v-switch
                  v-model="collisionBoundaryVisible"
                  color="info"
                  density="comfortable"
                  hide-details
                  inset
                  :disabled="isBusy"
                  :label="collisionBoundaryVisible ? 'Shown' : 'Hidden'"
                  @update:model-value="setCollisionBoundaryVisible(Boolean($event))"
                />
              </v-sheet>

              <div class="text-subtitle-2 mb-2">Scale</div>
              <div class="d-flex align-center flex-wrap ga-3">
                <v-text-field
                  v-model.number="environmentScale"
                  type="number"
                  min="0.01"
                  step="0.1"
                  label="Scale multiplier"
                  density="compact"
                  variant="outlined"
                  hide-details
                  style="max-width: 11rem"
                  :disabled="isBusy || scaleApplying"
                />
                <v-btn
                  color="secondary"
                  size="small"
                  :loading="scaleApplying"
                  :disabled="isBusy"
                  @click="runApplyEnvironmentScale"
                >
                  Apply
                </v-btn>
                <div class="text-caption text-medium-emphasis">
                  Session scale: {{ sessionEnvironmentScale }}
                  <span v-if="scaleSummary"> · {{ scaleSummary }}</span>
                </div>
              </div>
            </template>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-expansion-panels v-if="status === 'done'" class="mt-4" variant="accordion">
          <v-expansion-panel title="Navigation and collision exports">
            <template #text>
              <div v-if="navSummary" class="text-caption text-medium-emphasis mb-3">{{ navSummary }}</div>
              <div class="d-flex flex-wrap ga-3 mb-4">
                <v-btn
                  color="primary"
                  :loading="navExporting"
                  prepend-icon="mdi-download"
                  @click="runNavmeshExport"
                >
                  Export navmesh (.nav)
                </v-btn>
                <v-btn
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-package-down"
                  :disabled="!hasNavKit || isBusy"
                  :title="navKitUploadHint"
                  @click="downloadNavKit"
                >
                  Download NavKit
                </v-btn>
                <v-btn
                  variant="outlined"
                  color="primary"
                  prepend-icon="mdi-download"
                  :disabled="!hasNavArtifactBundle || isBusy"
                  @click="downloadNavArtifacts"
                >
                  Download nav artifacts (legacy)
                </v-btn>
                <div
                  class="nav-artifacts-upload-wrap"
                  :class="{ 'nav-artifacts-upload-wrap--disabled': !hasLoadedSplat || isBusy }"
                  :title="navArtifactUploadHint"
                >
                  <v-btn
                    variant="outlined"
                    color="secondary"
                    prepend-icon="mdi-upload"
                    tabindex="-1"
                    :disabled="!hasLoadedSplat || isBusy"
                  >
                    Upload nav artifacts (legacy)
                  </v-btn>
                  <input
                    v-if="hasLoadedSplat && !isBusy"
                    ref="navArtifactsInputRef"
                    type="file"
                    multiple
                    accept=".zip,application/zip,.glb,.bin,.json,application/json"
                    class="nav-artifacts-file-hit"
                    :title="navArtifactUploadHint"
                    @change="onNavArtifactsSelected"
                  >
                </div>
              </div>
              <p class="text-caption text-medium-emphasis mb-2">{{ navKitUploadHint }}</p>
              <p class="text-caption text-medium-emphasis mb-4">{{ navArtifactUploadHint }}</p>

              <v-sheet
                border
                rounded="lg"
                class="d-flex align-center flex-wrap ga-4 pa-3 mb-4 navmesh-toggle-bar"
                color="surface"
              >
                <v-icon
                  :icon="navMeshVisible ? 'mdi-layers' : 'mdi-layers-off'"
                  :color="navMeshVisible ? 'success' : 'medium-emphasis'"
                  size="22"
                />
                <div class="flex-grow-1">
                  <div class="text-body-2 font-weight-medium">Navmesh overlay</div>
                  <div class="text-caption text-medium-emphasis">
                    {{
                      navMeshVisible
                        ? 'Green walkable mesh visible — click it to move the player'
                        : 'Hidden — splat view only; click-to-move is off'
                    }}
                  </div>
                </div>
                <v-switch
                  :model-value="navMeshVisible"
                  color="success"
                  density="comfortable"
                  hide-details
                  inset
                  :disabled="isBusy"
                  :label="navMeshVisible ? 'Shown' : 'Hidden'"
                  @update:model-value="onNavMeshVisible(Boolean($event))"
                />
              </v-sheet>

              <v-divider class="mb-4" />

              <div v-if="collisionSummary" class="text-caption text-medium-emphasis mb-3">{{ collisionSummary }}</div>
              <div class="d-flex flex-wrap align-center ga-3">
                <v-btn
                  color="secondary"
                  :loading="collisionExporting"
                  prepend-icon="mdi-cube-outline"
                  @click="runCollisionGenerate"
                >
                  Generate collision boundary
                </v-btn>
                <v-switch
                  v-model="collisionBoundaryVisible"
                  color="info"
                  density="compact"
                  hide-details
                  :label="
                    navGenerationMode === 'sdf_marching_cubes'
                      ? 'Show MC shell (cyan)'
                      : 'Show collision boundary'
                  "
                  @update:model-value="setCollisionBoundaryVisible(Boolean($event))"
                />
                <v-btn
                  variant="tonal"
                  :loading="collisionExporting"
                  prepend-icon="mdi-download"
                  @click="runCollisionExport"
                >
                  Export collision mesh (.glb)
                </v-btn>
              </div>
            </template>
          </v-expansion-panel>

          <v-expansion-panel title="Streamed SOG export">
            <template #text>
              <div v-if="sogStatusText" class="text-caption mb-3" :class="isLargeScene ? 'text-primary' : 'text-medium-emphasis'">
                {{ sogStatusText }}
              </div>

              <v-btn-toggle v-model="sogMode" mandatory density="comfortable" color="primary" class="mb-4">
                <v-btn value="streamed" prepend-icon="mdi-layers-triple">Streamed LOD</v-btn>
                <v-btn value="single" prepend-icon="mdi-file-outline">Single SOG</v-btn>
              </v-btn-toggle>

              <v-row dense>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model.number="sliceForm.sh_degree"
                    type="number" min="0" :max="maxShDegree" step="1"
                    label="SH Degree" density="compact" variant="outlined"
                    hint="0 = base color only (smaller/faster). Higher degrees keep more view-dependent color."
                    persistent-hint
                  />
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model.number="sliceForm.sh_cluster_count"
                    type="number" min="1" max="65536" step="256"
                    label="SH Palette Size" density="compact" variant="outlined" hide-details
                  />
                </v-col>
                <v-col cols="12" sm="4">
                  <v-text-field
                    v-model.number="sliceForm.sh_iterations"
                    type="number" min="1" max="50" step="1"
                    label="SH Iterations" density="compact" variant="outlined" hide-details
                  />
                </v-col>
                <template v-if="sogMode === 'streamed'">
                  <v-col cols="12" sm="4">
                    <v-text-field
                      v-model.number="sliceForm.chunk_count"
                      type="number" min="1000" max="4000000" step="16000"
                      label="Splats / Chunk" density="compact" variant="outlined" hide-details
                    />
                  </v-col>
                  <v-col cols="12" sm="4">
                    <v-text-field
                      v-model.number="sliceForm.chunk_extent"
                      type="number" min="0" :max="maxChunkExtent" step="1"
                      label="Chunk Extent (m)" density="compact" variant="outlined" hide-details
                    />
                  </v-col>
                  <v-col cols="12" sm="4">
                    <v-text-field
                      v-model.number="sliceForm.lod_levels"
                      type="number" min="1" max="6" step="1"
                      label="LOD Levels" density="compact" variant="outlined"
                      hint="2+ recommended for streaming (coarse base + full detail). 1 = full detail only, no multi-LOD."
                      persistent-hint
                    />
                  </v-col>
                </template>
              </v-row>

              <v-alert
                v-if="showLodLevelsWarning"
                class="mt-3"
                type="warning"
                density="compact"
                variant="tonal"
              >
                LOD Levels is 1 — this export is a single detail level and will not stream coarse→fine.
              </v-alert>

              <v-btn
                class="mt-4"
                color="primary"
                :loading="sogExporting"
                prepend-icon="mdi-download"
                @click="runSogExport"
              >
                {{ sogExportButtonLabel }}
              </v-btn>
            </template>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-expansion-panels v-if="logs.length" class="mt-4" variant="accordion">
          <v-expansion-panel title="System logs">
            <template #text>
              <div class="logs-scroll font-monospace text-caption">
                <div v-for="entry in logs" :key="entry.id" class="py-1">
                  <v-chip :color="tagColor[entry.tag]" size="x-small" label class="mr-2 text-uppercase">
                    {{ entry.tag }}
                  </v-chip>
                  <span>{{ entry.message }}</span>
                </div>
              </div>
            </template>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-col>
    </v-row>

    <input
      ref="fileInputRef"
      type="file"
      accept=".ply,.spz,.splat,.zip,application/zip"
      class="d-none"
      @change="onFileChange"
    >

    <v-snackbar v-model="showSnackbar" color="error" :timeout="6000" location="bottom">
      {{ errorMessage }}
      <template #actions>
        <v-btn variant="text" @click="showSnackbar = false">Close</v-btn>
      </template>
    </v-snackbar>
  </v-container>
</template>

<style scoped>
.showcase-canvas {
  display: block;
  width: 100%;
  height: clamp(360px, 68vh, 760px);
  background-color: #000;
  outline: none;
  touch-action: none;
}

.drop-active {
  outline: 2px dashed rgb(var(--v-theme-primary));
  outline-offset: -6px;
}

.fullscreen-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 5;
}

.canvas-card:fullscreen {
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #000;
}

.canvas-card:fullscreen .showcase-canvas {
  width: 100vw;
  height: 100vh;
}

.logs-scroll {
  max-height: 240px;
  overflow-y: auto;
}

.nav-artifacts-upload-wrap {
  position: relative;
  display: inline-flex;
}

.nav-artifacts-upload-wrap--disabled {
  pointer-events: none;
}

.nav-artifacts-file-hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  opacity: 0;
  cursor: pointer;
  font-size: 0;
}

.navmesh-toggle-bar {
  background: linear-gradient(
    120deg,
    rgba(var(--v-theme-success), 0.08),
    rgba(var(--v-theme-surface), 1) 42%
  );
}

.settings-label {
  display: inline-block;
  min-width: 7.5rem;
}
</style>
