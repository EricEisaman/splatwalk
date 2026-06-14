<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue';

import { useBabylonViewer } from '@/composables/useBabylonViewer';
import { useSplatFastNav, type LogTag } from '@/composables/useSplatFastNav';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const cardRef = ref<ComponentPublicInstance | null>(null);
const isDragging = ref(false);
const isFullscreen = ref(false);

const babylon = useBabylonViewer(canvasRef);
const { status, statusMessage, errorMessage, logs, isBusy, loadAndProcess, loadExample, reset } =
  useSplatFastNav(babylon);

interface ExampleScene {
  readonly title: string;
  readonly url: string;
}

const EXAMPLE_SCENES: readonly ExampleScene[] = [
  { title: 'Bedroom', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/bedroom.ply' },
  { title: 'Tropical Compound', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/tropical_compound.ply' },
  { title: 'Industrial Warehouse', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/industrial_warehouse.ply' },
] as const;

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
  const navActive = status.value === 'processing';
  const navDone = status.value === 'done';
  return [
    { label: 'Load splat', active: status.value === 'loading', done: loadDone },
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
          Drop a <strong>.ply</strong> or <strong>.spz</strong> 3D Gaussian Splat. It loads into Babylon.js, auto-runs
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
              <div class="text-body-2 text-medium-emphasis mb-5">.ply or .spz · drag &amp; drop, browse, or pick an example</div>
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
                      v-for="scene in EXAMPLE_SCENES"
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
              <v-progress-circular indeterminate color="primary" size="64" width="5" class="mb-3" />
              <div class="text-body-1">{{ statusMessage }}</div>
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
      accept=".ply,.spz"
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
</style>
