<script lang="ts">
import { DEFAULT_FAST_NAV_RECOVERY, type FastNavRecoveryConfig, type StrayTrimOptions, type PruneFloatersOptions } from '@/navigation/fastNav';

/** A selectable example splat scene shown in the "Example scenes" menu. */
export interface ExampleScene {
  readonly title: string;
  readonly url: string;
}

/** Built-in example scenes; override via the `exampleScenes` prop. */
export const DEFAULT_EXAMPLE_SCENES: readonly ExampleScene[] = [
  { title: 'Bedroom', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/bedroom.ply' },
  { title: 'PurplePad', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/PurplePad.spz' },
  { title: 'Bridge', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/Bridge.spz' },
  { title: 'Meadow', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/meadow.spz' },
  { title: 'Tropical Compound', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/tropical_compound.ply' },
  { title: 'Industrial Warehouse', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/industrial_warehouse.ply' },
  { title: 'Stairs', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/stairs.spz' },
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
const { status, statusMessage, errorMessage, logs, isBusy, phase, progress, splatCount, maxShDegree, maxChunkExtent, loadAndProcess, loadExample, exportSog, exportNavmesh, generateCollisionBoundary, exportCollisionMesh, setCollisionBoundaryVisible, setNavMeshVisible, applyEnvironmentScale, reset } =
  useSplatFastNav(babylon, { recovery: props.recovery, strayTrim: props.strayTrim, prune: props.prune });

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

// Auto-pick the recommended mode whenever a new scene's count resolves; the
// user can still flip it before exporting.
watch(splatCount, () => {
  collisionSummary.value = null;
  navSummary.value = null;
  sogSummary.value = null;
  scaleSummary.value = null;
  environmentScale.value = 1;
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
  const scale = Number(environmentScale.value);
  if (!Number.isFinite(scale) || scale <= 0) {
    scaleSummary.value = 'Scale Environment must be a positive number.';
    return;
  }
  scaleApplying.value = true;
  scaleSummary.value = null;
  try {
    await applyEnvironmentScale(scale);
    scaleSummary.value = `Environment scale applied: ${scale}.`;
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
    prune: 'Pruning floaters',
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

const showDropZone = computed(() => status.value === 'idle' || status.value === 'error');

const steps = computed(() => {
  const loadDone = status.value === 'processing' || status.value === 'done';
  const navDone = status.value === 'done';
  const p = phase.value;
  const pruneActive = status.value === 'processing' && p === 'prune';
  const pruneDone = p === 'floor' || p === 'navmesh' || p === 'done';
  const navActive = status.value === 'processing' && (p === 'floor' || p === 'navmesh');
  const pruneLabel = pruneActive && progressText.value ? progressText.value : 'Prune outliers';
  return [
    { label: 'Load splat', active: status.value === 'loading', done: loadDone },
    { label: pruneLabel, active: pruneActive, done: pruneDone || navDone },
    { label: 'FAST NAV', active: navActive, done: navDone },
    { label: 'Top-down view', active: false, done: navDone },
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
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
</script>

<template>
  <v-container fluid class="pa-4">
    <v-row justify="center">
      <v-col cols="12" md="10" lg="9">
        <div class="text-h5 font-weight-black text-uppercase mb-1">
          Gaussian Splat <span class="text-primary">FAST NAV</span>
        </div>
        <p class="text-body-2 text-medium-emphasis mb-4">
          Drop a <strong>.ply</strong>, <strong>.spz</strong>, or <strong>.splat</strong> 3D Gaussian Splat. It loads into Babylon.js, auto-runs
          the FAST NAV pipeline (collider &rarr; navmesh &rarr; crowd &rarr; NPC), then frames the player top-down.
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
            v-if="status === 'done'"
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
                      @click="loadExample(scene.url, scene.title)"
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
            @click="reset"
          >
            Load another
          </v-btn>
        </div>

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
              </div>

              <div class="d-flex align-center flex-wrap ga-3 mb-4">
                <v-text-field
                  v-model.number="environmentScale"
                  type="number"
                  min="0.01"
                  step="0.1"
                  label="Scale Environment"
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
                <div v-if="scaleSummary" class="text-caption text-medium-emphasis">{{ scaleSummary }}</div>
              </div>

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
                  color="primary"
                  density="compact"
                  hide-details
                  label="Show collision boundary"
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
      accept=".ply,.spz,.splat"
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

.navmesh-toggle-bar {
  background: linear-gradient(
    120deg,
    rgba(var(--v-theme-success), 0.08),
    rgba(var(--v-theme-surface), 1) 42%
  );
}
</style>
