<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';

import {
  useStorageAdapterDemo,
  type StorageDemoSource,
} from '@/composables/useStorageAdapterDemo';

const PLAYCANVAS_SKATEPARK_LOD_META =
  'https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const cardRef = ref<ComponentPublicInstance | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isDragging = ref(false);
const isFullscreen = ref(false);
const sourceMode = ref<StorageDemoSource>('cdn');
const cdnUrl = ref(PLAYCANVAS_SKATEPARK_LOD_META);
const selectedZipName = ref<string | null>(null);
const showSnackbar = ref(false);

const {
  busy,
  clear,
  clearNavArtifacts,
  debugShowingNavPly,
  errorMessage,
  fileCount,
  generateCollision,
  hasNavMesh,
  hasNavSession,
  hasStream,
  initScene,
  loadCdn,
  loadZip,
  logs,
  navMeshVisible,
  navPhase,
  resize,
  restoreStreamVisual,
  runFastNavFromStream,
  setNavMeshVisible,
  showDebugNavPly,
  statusMessage,
  summary,
} = useStorageAdapterDemo(canvasRef);

const onFullscreenChange = (): void => {
  isFullscreen.value = document.fullscreenElement !== null;
  window.setTimeout(() => resize(), 60);
};

onMounted(() => {
  initScene();
  resize();
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});

watch(errorMessage, (value) => {
  showSnackbar.value = Boolean(value);
});

const showDropZone = computed(
  () => sourceMode.value === 'local' && !busy.value && !summary.value
);

const showFullscreenBtn = computed(() => !showDropZone.value && !busy.value);

const canRunNav = computed(() => (hasStream.value || hasNavSession.value) && !busy.value);

const navSteps = computed(() => {
  const order = ['materialize', 'prune', 'floor', 'navmesh', 'done'] as const;
  const current = navPhase.value;
  const curIdx = (order as readonly string[]).indexOf(current);
  return [
    { label: 'Materialize PLY', key: 'materialize' },
    { label: 'Prune', key: 'prune' },
    { label: 'Floor', key: 'floor' },
    { label: 'Navmesh', key: 'navmesh' },
    { label: 'Done', key: 'done' },
  ].map((step) => {
    const idx = (order as readonly string[]).indexOf(step.key);
    const done = curIdx > idx || current === 'done';
    const active = current === step.key;
    return { ...step, done, active };
  });
});

const manifestLines = computed(() => {
  const s = summary.value;
  if (!s) {
    return [] as string[];
  }
  const lines = [
    `lodLevels: ${s.lodLevels}`,
    `filenames: ${s.filenameCount}`,
    ...(fileCount.value !== null && sourceMode.value === 'local'
      ? [`bundle files: ${fileCount.value}`]
      : []),
  ];
  if (s.environment) {
    lines.push(`environment: ${s.environment}`);
  }
  if (s.filenamesSample.length > 0) {
    lines.push(`sample: ${s.filenamesSample.join(', ')}`);
  }
  return lines;
});

const toggleFullscreen = async (): Promise<void> => {
  const el = cardRef.value?.$el as HTMLElement | undefined;
  if (!el) {
    return;
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await el.requestFullscreen();
  }
};

const onBrowse = (): void => {
  fileInputRef.value?.click();
};

const onFileChange = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) {
    return;
  }
  await runZipLoad(file);
};

const onDrop = async (event: DragEvent): Promise<void> => {
  isDragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  sourceMode.value = 'local';
  await runZipLoad(file);
};

const runZipLoad = async (file: File): Promise<void> => {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    errorMessage.value = 'Please drop a .zip file exported from SplatWalk SOD LOD.';
    showSnackbar.value = true;
    return;
  }
  selectedZipName.value = file.name;
  try {
    await loadZip(file);
  } catch {
    // errorMessage set in composable
  }
};

const runCdnLoad = async (): Promise<void> => {
  try {
    await loadCdn(cdnUrl.value);
  } catch {
    // errorMessage set in composable
  }
};

const useSkateparkExample = (): void => {
  cdnUrl.value = PLAYCANVAS_SKATEPARK_LOD_META;
  sourceMode.value = 'cdn';
};

const onClear = (): void => {
  selectedZipName.value = null;
  clear();
};

const onGenerateCollision = async (): Promise<void> => {
  try {
    await generateCollision();
  } catch {
    // errorMessage set in composable
  }
};

const onRunFastNav = async (): Promise<void> => {
  try {
    await runFastNavFromStream();
  } catch {
    // errorMessage set in composable
  }
};

const onShowDebugNavPly = async (): Promise<void> => {
  try {
    await showDebugNavPly();
  } catch {
    // errorMessage set in composable
  }
};

const onRestoreStream = (): void => {
  restoreStreamVisual();
};
</script>

<template>
  <v-container class="py-6" fluid>
    <v-row justify="center">
      <v-col cols="12" lg="10" xl="8">
        <h1 class="text-h5 font-weight-bold mb-1">Storage Adapter Playground</h1>
        <p class="text-body-2 text-medium-emphasis mb-4">
          Stream PlayCanvas / Babylon SOD LOD from a CDN
          <code class="text-primary">lod-meta.json</code>
          URL or a local SplatWalk store-only zip — same
          <code class="text-primary">AppendSceneAsync</code>
          / GaussianSplattingStream path as Babylon 9.16.
        </p>

        <v-btn-toggle
          v-model="sourceMode"
          mandatory
          density="comfortable"
          color="primary"
          class="mb-4"
        >
          <v-btn value="cdn" prepend-icon="mdi-cloud-outline">CDN lod-meta</v-btn>
          <v-btn value="local" prepend-icon="mdi-folder-zip-outline">Local ZIP</v-btn>
        </v-btn-toggle>

        <v-card v-if="sourceMode === 'cdn'" border color="surface" class="mb-4 pa-4">
          <v-text-field
            v-model="cdnUrl"
            label="CDN lod-meta.json URL"
            placeholder="https://…/lod-meta.json"
            density="comfortable"
            variant="outlined"
            hide-details="auto"
            prepend-inner-icon="mdi-link-variant"
            class="mb-3"
            @keyup.enter="runCdnLoad"
          />
          <div class="d-flex flex-wrap ga-2">
            <v-btn
              color="primary"
              prepend-icon="mdi-play"
              :loading="busy"
              :disabled="busy"
              @click="runCdnLoad"
            >
              Load stream
            </v-btn>
            <v-btn
              variant="tonal"
              color="secondary"
              prepend-icon="mdi-skateboarding"
              :disabled="busy"
              @click="useSkateparkExample"
            >
              PlayCanvas skatepark
            </v-btn>
            <v-btn
              variant="text"
              color="secondary"
              prepend-icon="mdi-close"
              :disabled="busy"
              @click="onClear"
            >
              Clear
            </v-btn>
          </div>
        </v-card>

        <v-card v-else border color="surface" class="mb-4 pa-4">
          <div class="text-body-2 text-medium-emphasis mb-3">
            Upload a streamed SOD LOD zip from SplatWalk FastNav export
            (<span class="text-primary">(store-only)</span>.
          </div>
          <div class="d-flex flex-wrap align-center ga-2">
            <v-btn
              color="primary"
              prepend-icon="mdi-folder-open"
              :disabled="busy"
              @click="onBrowse"
            >
              Select ZIP
            </v-btn>
            <v-btn
              variant="text"
              color="secondary"
              prepend-icon="mdi-close"
              :disabled="busy"
              @click="onClear"
            >
              Clear
            </v-btn>
            <span v-if="selectedZipName" class="text-caption text-medium-emphasis">
              {{ selectedZipName }}
            </span>
          </div>
        </v-card>

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
            v-if="showFullscreenBtn"
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
              <v-icon icon="mdi-folder-zip-outline" size="72" color="primary" class="mb-3" />
              <div class="text-h6 font-weight-bold mb-2">Drop a SOD LOD zip</div>
              <div class="text-body-2 text-medium-emphasis mb-5">
                SplatWalk streamed export · store-only .zip
              </div>
              <v-btn color="primary" size="large" prepend-icon="mdi-folder-open" @click="onBrowse">
                Browse files
              </v-btn>
            </div>
          </v-overlay>

          <v-overlay
            :model-value="busy"
            contained
            persistent
            scrim="rgba(5, 5, 5, 0.6)"
            class="align-center justify-center"
          >
            <div class="text-center">
              <v-progress-circular indeterminate color="primary" size="64" width="5" class="mb-3" />
              <div class="text-body-1">{{ statusMessage }}</div>
            </div>
          </v-overlay>
        </v-card>

        <div class="d-flex align-center justify-space-between flex-wrap ga-2 mt-3">
          <div class="text-body-2 text-medium-emphasis">{{ statusMessage }}</div>
          <div class="text-caption text-medium-emphasis">
            Fly: <strong class="text-primary">WASD</strong>
            · Up/Down: <strong class="text-primary">E/Q</strong>
            · Look: mouse (click canvas first)
          </div>
        </div>

        <v-expansion-panels class="mt-4" variant="accordion">
          <v-expansion-panel title="Navigation from stream">
            <template #text>
              <p class="text-body-2 text-medium-emphasis mb-3">
                Materialize a denser LOD PLY from the streamed SOG as a WASM
                intermediary only (stream visual stays on canvas), then reuse
                SplatWalk collision / Fast Nav overlays (same end flow as
                <code class="text-primary">/vuetify</code>).
                Navmesh, player, and NPC draw on top of the live stream.
              </p>

              <div class="d-flex flex-wrap ga-2 mb-3">
                <v-chip
                  v-for="step in navSteps"
                  :key="step.key"
                  :color="step.done ? 'success' : step.active ? 'primary' : undefined"
                  :variant="step.done || step.active ? 'flat' : 'outlined'"
                  size="small"
                >
                  <v-icon
                    start
                    :icon="step.done ? 'mdi-check-circle' : step.active ? 'mdi-loading mdi-spin' : 'mdi-circle-outline'"
                  />
                  {{ step.label }}
                </v-chip>
              </div>

              <div class="d-flex flex-wrap ga-2">
                <v-btn
                  color="secondary"
                  prepend-icon="mdi-cube-outline"
                  :loading="busy && navPhase === 'materialize'"
                  :disabled="!canRunNav"
                  @click="onGenerateCollision"
                >
                  Generate collision
                </v-btn>
                <v-btn
                  color="primary"
                  prepend-icon="mdi-navigation-variant"
                  :loading="busy && ['prune', 'floor', 'navmesh', 'materialize'].includes(navPhase)"
                  :disabled="!canRunNav"
                  @click="onRunFastNav"
                >
                  Run Fast Nav
                </v-btn>
                <v-btn
                  variant="text"
                  color="secondary"
                  prepend-icon="mdi-close"
                  :disabled="busy"
                  @click="clearNavArtifacts"
                >
                  Clear nav artifacts
                </v-btn>
                <v-btn
                  v-if="!debugShowingNavPly"
                  variant="outlined"
                  color="warning"
                  prepend-icon="mdi-bug"
                  :disabled="!hasNavSession || busy"
                  @click="onShowDebugNavPly"
                >
                  Show nav PLY (debug)
                </v-btn>
                <v-btn
                  v-else
                  variant="flat"
                  color="warning"
                  prepend-icon="mdi-eye"
                  :disabled="busy"
                  @click="onRestoreStream"
                >
                  Restore stream
                </v-btn>
              </div>

              <v-sheet
                v-if="hasNavMesh"
                border
                rounded="lg"
                class="d-flex align-center flex-wrap ga-4 pa-3 mt-3 navmesh-toggle-bar"
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
                    {{ navMeshVisible ? 'Green walkable mesh visible — click it to move the player' : 'Hidden — stream view only; click-to-move is off' }}
                  </div>
                </div>
                <v-switch
                  :model-value="navMeshVisible"
                  color="success"
                  density="comfortable"
                  hide-details
                  inset
                  :disabled="busy"
                  :label="navMeshVisible ? 'Shown' : 'Hidden'"
                  @update:model-value="setNavMeshVisible(Boolean($event))"
                />
              </v-sheet>

              <div v-if="!hasStream && !hasNavSession && navPhase === 'idle'" class="text-caption text-medium-emphasis mt-3">
                Load a CDN lod-meta or local SOD LOD zip first.
              </div>
            </template>
          </v-expansion-panel>

          <v-expansion-panel title="Manifest">
            <template #text>
              <div v-if="manifestLines.length === 0" class="text-caption text-medium-emphasis">
                No manifest loaded
              </div>
              <pre v-else class="manifest-pre text-caption">{{ manifestLines.join('\n') }}</pre>
            </template>
          </v-expansion-panel>
          <v-expansion-panel title="Status log">
            <template #text>
              <div class="logs-scroll font-monospace text-caption">
                <div v-for="(entry, index) in logs" :key="index" class="py-1">
                  {{ entry }}
                </div>
              </div>
            </template>
          </v-expansion-panel>
          <v-expansion-panel title="Babylon Playground TypeScript">
            <template #text>
              <div class="text-caption text-medium-emphasis mb-2">
                Paste into playground.babylonjs.com (TypeScript mode). See
                <code>public/playground/storage-adapter.ts</code>.
              </div>
              <pre class="manifest-pre text-caption">class Playground {
  public static CreateScene(engine: BABYLON.Engine, canvas: HTMLCanvasElement): BABYLON.Scene {
    var scene = new BABYLON.Scene(engine);
    var camera = new BABYLON.FreeCamera("camera1", new BABYLON.Vector3(0, 5, -10), scene);
    camera.setTarget(BABYLON.Vector3.Zero());
    camera.attachControl(canvas, true);
    var light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
    light.intensity = 0.7;
    void BABYLON.AppendSceneAsync(
      "https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json",
      scene
    );
    return scene;
  }
}
export { Playground };</pre>
            </template>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-col>
    </v-row>

    <input
      ref="fileInputRef"
      type="file"
      accept=".zip,application/zip"
      class="d-none"
      @change="onFileChange"
    >

    <v-snackbar v-model="showSnackbar" color="error" :timeout="8000" location="bottom">
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

.manifest-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: rgba(var(--v-theme-on-surface), 0.85);
}

.navmesh-toggle-bar {
  background: linear-gradient(
    120deg,
    rgba(var(--v-theme-success), 0.08),
    rgba(var(--v-theme-surface), 1) 42%
  );
}
</style>
