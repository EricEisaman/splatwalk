<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';

import {
  activeNavigationModeLabel,
  liveNavBackendLabel,
  useStorageAdapterDemo,
  type ActiveNavigationMode,
  type NavGenerationMode,
  type StorageDemoCameraType,
  type StorageDemoInitialFlyPose,
  type StorageDemoSource,
  type StreamQualityPreset,
} from '@/composables/useStorageAdapterDemo';
import { resolveLodMetaCdnUrl } from '@/storage/sogStreamLoader';
import {
  parseCameraModeQuery,
  parseTruthyQuery,
  parseVec3Bracket,
} from '@/storage/storageAdapterDeepLink';
import {
  STREAM_QUALITY_PRESETS,
  streamQualityPresetLabel,
} from '@/storage/streamMemoryBudget';
import { downloadIntegrationKit } from '@/utils/downloadIntegrationKit';

const PLAYCANVAS_SKATEPARK_LOD_META =
  'https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json';
const PLAYCANVAS_CHURCH_LOD_META =
  'https://code.playcanvas.com/examples_data/example_roman_parish_02/lod-meta.json';
const OVAL_INTERIOR_LOD_META =
  'https://d28zzqy0iyovbz.cloudfront.net/b7c8d8c5/v1/lod-meta.json';
/** Captured stairs framing — applied instead of auto-frame after Oval CDN load. */
const OVAL_INTERIOR_INITIAL_FLY_POSE: StorageDemoInitialFlyPose = {
  position: { x: -329.834, y: 4.212, z: 148.185 },
  eulerDegrees: { x: 28.5, y: 79.2, z: 0.0 },
};

const CAMERA_TYPE_OPTIONS: ReadonlyArray<{ title: string; value: StorageDemoCameraType }> = [
  { title: 'Fly (WASD)', value: 'fly' },
  { title: 'Orbit (drag / scroll)', value: 'orbit' },
];

const canvasRef = ref<HTMLCanvasElement | null>(null);
const cardRef = ref<ComponentPublicInstance | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const navArtifactsInputRef = ref<HTMLInputElement | null>(null);
const isDragging = ref(false);
const isFullscreen = ref(false);
const sourceMode = ref<StorageDemoSource>('cdn');
const cdnUrl = ref(PLAYCANVAS_SKATEPARK_LOD_META);
const selectedZipName = ref<string | null>(null);
const showSnackbar = ref(false);

const {
  activeNavigationMode,
  activeNavigationModeDisabledReason,
  busy,
  cameraInfo,
  cameraInfoCopyText,
  cameraType,
  clear,
  clearNavArtifacts,
  colliderVisible,
  debugShowingNavPly,
  downloadNavArtifacts,
  errorMessage,
  fileCount,
  generateCollision,
  goToPlayer,
  hasColliderMesh,
  hasNavArtifactBundle,
  hasNavMesh,
  hasNavSession,
  hasStream,
  initScene,
  isActiveNavigationModeEnabled,
  liveBackend,
  loadCdn,
  loadZip,
  logs,
  navArtifactUploadHint,
  navCapabilities,
  navMeshVisible,
  navMode,
  navPhase,
  navPlyRotationLabel,
  navSettings,
  resetNavSettings,
  resetVoxelNavSettings,
  resetStreamSettings,
  resize,
  restoreStreamVisual,
  rotateNavPly,
  rotateStreamVisual,
  runFastNavFromStream,
  runNavFromStream,
  selectionRegionVisible,
  setActiveNavigationMode,
  setColliderVisible,
  setNavGenerationMode,
  setNavMeshVisible,
  setSelectionRegionVisible,
  setCameraInfoPanelOpen,
  setCameraType,
  applySelectRegionFromCamera,
  cameraSelectOffsets,
  resetCameraSelectOffsets,
  setPendingInitialFlyPose,
  setPendingCameraSelect,
  setPendingStreamOrientation,
  setRendererPreference,
  setStreamPerformanceMode,
  setStreamQualityPreset,
  showDebugNavPly,
  statusMessage,
  streamPerformanceMode,
  streamQualityPreset,
  streamResidency,
  streamSettings,
  streamVisualRotationLabel,
  summary,
  uploadNavArtifacts,
  voxelNavSettings,
  activeRenderer,
  rendererPreference,
} = useStorageAdapterDemo(canvasRef);

/** Camera Information collapsed by default; sampling runs only while open. */
const cameraInfoPanels = ref<number[]>([]);
/** Expand Navigation + nested Navmesh settings on load (prune + orientation visible). */
const navSectionPanels = ref<number[]>([0]);
const navSettingsPanels = ref<number[]>([0]);
const canAdjustOrientation = computed(() => hasStream.value || hasNavSession.value);
const cameraInfoCopied = ref(false);

const onDownloadStorageKit = (): void => {
  downloadIntegrationKit('storage-adapter');
};

const cameraPositionLabel = computed(() => {
  const p = cameraInfo.value.position;
  return `${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}`;
});

const cameraEulerLabel = computed(() => {
  const e = cameraInfo.value.eulerDegrees;
  return `X ${e.x.toFixed(1)}° · Y ${e.y.toFixed(1)}° · Z ${e.z.toFixed(1)}°`;
});

const cameraOrbitLabel = computed(() => {
  const orbit = cameraInfo.value.orbit;
  if (!orbit) {
    return null;
  }
  return (
    `α ${orbit.alpha.toFixed(4)} · β ${orbit.beta.toFixed(4)} · r ${orbit.radius.toFixed(3)}`
  );
});

watch(
  cameraInfoPanels,
  (panels) => {
    setCameraInfoPanelOpen(panels.includes(0));
  },
  { deep: true }
);

const copyCameraInfo = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(cameraInfoCopyText.value);
    cameraInfoCopied.value = true;
    window.setTimeout(() => {
      cameraInfoCopied.value = false;
    }, 1600);
  } catch {
    cameraInfoCopied.value = false;
  }
};

const onStreamQualityChange = (value: unknown): void => {
  if (typeof value !== 'string') {
    return;
  }
  if (!(STREAM_QUALITY_PRESETS as readonly string[]).includes(value)) {
    return;
  }
  setStreamQualityPreset(value as StreamQualityPreset);
};

const onStreamPerformanceModeChange = (value: unknown): void => {
  setStreamPerformanceMode(Boolean(value));
};

const onSelectionRegionVisible = (visible: boolean): void => {
  void setSelectionRegionVisible(visible).catch(() => {
    // Error surfaced via errorMessage / snackbar in the composable.
  });
};

const onFullscreenChange = (): void => {
  isFullscreen.value = document.fullscreenElement !== null;
  window.setTimeout(() => resize(), 60);
};

const applyStreamQueryParams = async (): Promise<void> => {
  const params = new URLSearchParams(window.location.search);
  const streamRaw = params.get('stream')?.trim() ?? '';
  if (!streamRaw) {
    return;
  }
  try {
    const resolved = resolveLodMetaCdnUrl(streamRaw);
    cdnUrl.value = resolved;
    sourceMode.value = 'cdn';

    const pos = parseVec3Bracket(params.get('pos'));
    const eulerDeg = parseVec3Bracket(params.get('eulerDeg'));
    const hasPoseParams =
      params.get('pos') != null || params.get('eulerDeg') != null;
    const poseOk = pos !== null && eulerDeg !== null;
    if (hasPoseParams && !poseOk) {
      console.warn(
        '[storage-adapter] Deep-link pos/eulerDeg ignored — need both as [x,y,z] finite triples.'
      );
    }

    let mode = parseCameraModeQuery(params.get('mode'));
    if (poseOk && mode === null) {
      mode = 'fly';
    }
    if (mode) {
      setCameraType(mode);
    }

    if (poseOk) {
      if (mode === 'orbit') {
        console.warn(
          '[storage-adapter] Deep-link pos/eulerDeg ignored when mode=orbit (fly pose only).'
        );
      } else {
        const flyPose: StorageDemoInitialFlyPose = {
          position: pos,
          eulerDegrees: eulerDeg,
        };
        setPendingInitialFlyPose(flyPose);
        setPendingCameraSelect({
          view: {
            position: { ...pos },
            eulerDegrees: { ...eulerDeg },
          },
        });
      }
    }

    if (!parseTruthyQuery(params.get('autoload'))) {
      return;
    }

    await runCdnLoad();

    if (parseTruthyQuery(params.get('fastNav'))) {
      try {
        await runFastNavFromStream();
      } catch {
        // errorMessage set in composable
      }
    }
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
    showSnackbar.value = true;
  }
};

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  void initScene()
    .then(() => {
      resize();
      return applyStreamQueryParams();
    })
    .catch(() => {
      // errorMessage / snackbar set by load path or applyStreamQueryParams
    });
});

const onRendererPreferenceChange = (value: unknown): void => {
  if (value !== 'webgl' && value !== 'webgpu') {
    return;
  }
  void setRendererPreference(value).catch(() => {
    // errorMessage / snackbar
  });
};

onBeforeUnmount(() => {
  setCameraInfoPanelOpen(false);
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

const cameraControlsHint = computed(() =>
  cameraType.value === 'fly'
    ? 'Fly: WASD · Up/Down: E/Q · SHIFT = 10× speed · Look: mouse (click canvas first)'
    : 'Orbit: drag to rotate · scroll to zoom · SHIFT = 10× pan/zoom · right-drag to pan'
);

const navSteps = computed(() => {
  const order =
    navMode.value === 'voxel_collision'
      ? (['materialize', 'floor', 'navmesh', 'done'] as const)
      : (['materialize', 'prune', 'floor', 'navmesh', 'done'] as const);
  const current = navPhase.value;
  const curIdx = (order as readonly string[]).indexOf(current);
  const steps =
    navMode.value === 'voxel_collision'
      ? [
          { label: 'Materialize PLY', key: 'materialize' },
          { label: 'Voxel collider', key: 'floor' },
          { label: 'Navmesh', key: 'navmesh' },
          { label: 'Done', key: 'done' },
        ]
      : [
          { label: 'Materialize PLY', key: 'materialize' },
          { label: 'Prune', key: 'prune' },
          { label: 'Floor field', key: 'floor' },
          { label: 'Navmesh', key: 'navmesh' },
          { label: 'Done', key: 'done' },
        ];
  return steps.map((step) => {
    const idx = (order as readonly string[]).indexOf(step.key);
    const done = curIdx > idx || current === 'done';
    const active = current === step.key;
    return { ...step, done, active };
  });
});

const navModeOptions: { value: NavGenerationMode; title: string; subtitle: string }[] = [
  {
    value: 'floor_field',
    title: 'Floor field (Fast Nav)',
    subtitle: 'Flat floors and large outdoor streams — 2.5D walkable ground field.',
  },
  {
    value: 'voxel_collision',
    title: 'Voxel collision',
    subtitle: 'Indoor stairs and multi-level spaces — voxel fill/carve collision mesh.',
  },
];

const activeModeOptions: {
  value: ActiveNavigationMode;
  title: string;
  subtitle: string;
}[] = [
  {
    value: 'recast',
    title: 'Recast',
    subtitle: 'Recast crowd on green navmesh (NPCs). Floor field always uses this.',
  },
  {
    value: 'voxel_mesh',
    title: 'Voxel mesh',
    subtitle: 'Voxel walk — solid-ray picks for stairs (needs carved volume).',
  },
  {
    value: 'recast_and_voxel_mesh',
    title: 'Recast + voxel mesh',
    subtitle:
      'Dual-ready pack (volume + Recast). Starts on voxel walk; hot-swap to Recast without re-carve.',
  },
];

const collisionSceneTypeOptions = [
  { title: 'Indoor (sealed rooms, stairs)', value: 'indoor' },
  { title: 'Outdoor (floor fill)', value: 'outdoor' },
  { title: 'Object (local mesh)', value: 'object' },
] as const;

const onNavGenerationMode = (mode: NavGenerationMode | null): void => {
  if (!mode) {
    return;
  }
  setNavGenerationMode(mode);
};

const onActiveNavigationMode = (mode: ActiveNavigationMode | null): void => {
  if (!mode) {
    return;
  }
  void setActiveNavigationMode(mode).catch(() => undefined);
};

const activeModeCaption = computed(() => {
  const option = activeModeOptions.find((o) => o.value === activeNavigationMode.value);
  const caps = navCapabilities.value;
  const dual =
    caps.hasVolume && caps.hasRecast
      ? 'dual-ready'
      : caps.hasRecast
        ? 'Recast only'
        : caps.hasVolume
          ? 'volume only'
          : 'no pack yet';
  return `${option?.subtitle ?? ''} Pack: ${dual}. Live: ${liveNavBackendLabel(liveBackend.value)}.`;
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
    const resolved = resolveLodMetaCdnUrl(cdnUrl.value);
    cdnUrl.value = resolved;
    await loadCdn(resolved);
  } catch (error) {
    if (!errorMessage.value) {
      errorMessage.value =
        error instanceof Error ? error.message : String(error);
    }
  }
};

const useSkateparkExample = (): void => {
  cdnUrl.value = PLAYCANVAS_SKATEPARK_LOD_META;
  sourceMode.value = 'cdn';
  setPendingStreamOrientation(null);
  setPendingInitialFlyPose(null);
  setPendingCameraSelect(null);
  setNavGenerationMode('floor_field');
};

const useChurchExample = (): void => {
  cdnUrl.value = PLAYCANVAS_CHURCH_LOD_META;
  sourceMode.value = 'cdn';
  setPendingStreamOrientation(null);
  setPendingInitialFlyPose(null);
  setPendingCameraSelect(null);
  setNavGenerationMode('floor_field');
};

const useOvalInteriorExample = (): void => {
  cdnUrl.value = OVAL_INTERIOR_LOD_META;
  sourceMode.value = 'cdn';
  setCameraType('fly');
  setPendingStreamOrientation({ x: 0, y: 0, z: 0 });
  setPendingInitialFlyPose(OVAL_INTERIOR_INITIAL_FLY_POSE);
  setNavGenerationMode('voxel_collision');
  void setActiveNavigationMode('recast_and_voxel_mesh').catch(() => undefined);
  // After mode clear — arm camera AABB + keep view for Fast Nav / voxel nav.
  setPendingCameraSelect({
    view: {
      position: { ...OVAL_INTERIOR_INITIAL_FLY_POSE.position },
      eulerDegrees: { ...OVAL_INTERIOR_INITIAL_FLY_POSE.eulerDegrees },
    },
  });
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

const onRunNav = async (): Promise<void> => {
  try {
    await runNavFromStream();
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

const onApplySelectRegionFromCamera = async (): Promise<void> => {
  try {
    await applySelectRegionFromCamera();
  } catch {
    // errorMessage / log set in composable
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
</script>

<template>
  <v-container class="py-6" fluid>
    <v-row justify="center">
      <v-col cols="12" lg="10" xl="8">
        <h1 class="text-h5 font-weight-bold mb-1">Storage Adapter Playground</h1>
        <p class="text-body-2 text-medium-emphasis mb-3">
          Stream SOD LOD from a CDN
          <code class="text-primary">lod-meta.json</code>
          URL or a local SplatWalk store-only zip via a budgeted
          <code class="text-primary">GaussianSplattingStream</code>
          (fixed resident GPU budget — safe for city-scale catalogs up to 200M+ splats).
          Prefer CDN for large scenes; local zip materializes the full bundle in memory.
          Deep-link:
          <code class="text-primary"
            >/storage-adapter?stream=…&amp;autoload=true&amp;pos=[x,y,z]&amp;eulerDeg=[x,y,z]&amp;mode=fly&amp;fastNav=true</code
          >
          (Copy pose → query params; chain is mode → pose → load → Fast Nav).
        </p>

        <v-btn
          class="mb-4"
          color="primary"
          variant="tonal"
          prepend-icon="mdi-download"
          :disabled="busy"
          @click="onDownloadStorageKit"
        >
          Download Storage Adapter kit
        </v-btn>

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

        <v-card border color="surface" class="mb-4 pa-4">
          <div class="d-flex align-center flex-wrap ga-2 mb-2">
            <v-icon icon="mdi-tune-vertical" size="small" color="primary" />
            <span class="text-subtitle-2">Stream settings</span>
            <v-chip size="x-small" variant="tonal" color="primary">pre-load</v-chip>
            <v-spacer />
            <v-btn
              size="small"
              variant="text"
              color="secondary"
              :disabled="busy"
              @click="resetStreamSettings"
            >
              Reset defaults
            </v-btn>
          </div>
          <p class="text-caption text-medium-emphasis mb-3">
            Defaults match desktop Performance Mode (2M on / 4M off). Advanced quality
            presets override the budget. Tweaks apply on the next
            <strong>Load stream</strong> — work-buffer size is fixed at construct time.
            Renderer preference recreates the GPU context immediately. WebGPU uses raised
            color-attachment limits for the GS work buffer and falls back to WebGL when
            unsupported or below the MRT budget. Override with
            <code>?renderer=webgl</code> or <code>?renderer=webgpu</code>.
          </p>

          <div class="text-caption text-medium-emphasis mb-1">Renderer</div>
          <div class="d-flex align-center flex-wrap ga-2 mb-3">
            <v-btn-toggle
              :model-value="rendererPreference"
              mandatory
              density="comfortable"
              color="primary"
              :disabled="busy"
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

          <div class="d-flex align-center flex-wrap ga-3 mb-3">
            <v-switch
              :model-value="streamPerformanceMode"
              color="primary"
              density="compact"
              hide-details
              inset
              label="Performance Mode"
              :disabled="busy"
              @update:model-value="onStreamPerformanceModeChange"
            />
            <span class="text-caption text-medium-emphasis">
              Desktop: on = 2M / 192&nbsp;MB · off = 4M / 384&nbsp;MB
            </span>
          </div>

          <div class="text-caption text-medium-emphasis mb-1">Quality (advanced budget)</div>
          <v-btn-toggle
            :model-value="streamQualityPreset"
            mandatory
            density="comfortable"
            color="success"
            class="mb-3"
            :disabled="busy"
            @update:model-value="onStreamQualityChange"
          >
            <v-btn
              v-for="preset in STREAM_QUALITY_PRESETS"
              :key="preset"
              :value="preset"
            >
              {{ streamQualityPresetLabel(preset) }}
            </v-btn>
          </v-btn-toggle>
          <p class="text-caption text-medium-emphasis mb-4">
            Current:
            budget {{ streamSettings.maxResidentSplats.toLocaleString() }} ·
            {{ streamSettings.memoryBudgetMb }} MB · behindPenalty={{ streamSettings.lodBehindPenalty }} ·
            maxDetailLod={{ streamSettings.maxDetailLod }}
            (0 = full detail allowed; distance LOD still coarsens far nodes).
            <template v-if="streamResidency">
              · decoded {{ streamResidency.decodedFiles }}/{{ streamResidency.catalogFiles }}
              · buffer {{ streamResidency.bufferCapacity.toLocaleString() }}
              · eviction {{ streamResidency.evictionEnabled ? 'on' : 'off' }}
              <template v-if="streamResidency.skippedBudgetWarnings > 0">
                · {{ streamResidency.skippedBudgetWarnings }} budget skips
              </template>
            </template>
          </p>

          <v-expansion-panels variant="accordion" class="mb-0">
            <v-expansion-panel title="Advanced stream overrides">
              <template #text>
                <div class="text-subtitle-2 mb-2">Memory</div>
                <v-row density="comfortable">
                  <v-col cols="12" sm="6">
                    <v-slider
                      v-model="streamSettings.maxResidentSplats"
                      :min="500000"
                      :max="16000000"
                      :step="250000"
                      color="success"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Max resident</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6">
                    <v-slider
                      v-model="streamSettings.memoryBudgetMb"
                      :min="64"
                      :max="1536"
                      :step="32"
                      color="success"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Budget MB</span>
                      </template>
                    </v-slider>
                  </v-col>
                </v-row>

                <div class="text-subtitle-2 mb-2 mt-4">LOD / visibility</div>
                <v-row density="comfortable">
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.lodBaseDistance"
                      :min="1"
                      :max="40"
                      :step="0.5"
                      color="primary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">LOD base dist</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.lodMultiplier"
                      :min="1.5"
                      :max="6"
                      :step="0.1"
                      color="primary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">LOD multiplier</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.lodBehindPenalty"
                      :min="0"
                      :max="8"
                      :step="0.25"
                      color="primary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Behind penalty</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.maxDetailLod"
                      :min="0"
                      :max="6"
                      :step="1"
                      color="primary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Max detail LOD</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6" md="4">
                    <v-switch
                      v-model="streamSettings.frustumCulling"
                      color="primary"
                      density="compact"
                      hide-details
                      label="Frustum LOD bias"
                      :disabled="busy"
                    />
                  </v-col>
                </v-row>

                <div class="text-subtitle-2 mb-2 mt-4">Streaming throughput</div>
                <v-row density="comfortable">
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.maxConcurrentDownloads"
                      :min="1"
                      :max="8"
                      :step="1"
                      color="secondary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Downloads</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.maxDecodesPerFrame"
                      :min="1"
                      :max="4"
                      :step="1"
                      color="secondary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Decodes / frame</span>
                      </template>
                    </v-slider>
                  </v-col>
                  <v-col cols="12" sm="6" md="4">
                    <v-slider
                      v-model="streamSettings.evictionCooldownFrames"
                      :min="0"
                      :max="300"
                      :step="10"
                      color="secondary"
                      density="compact"
                      thumb-label
                      hide-details
                      :disabled="busy"
                    >
                      <template #prepend>
                        <span class="text-caption text-medium-emphasis settings-label">Evict cooldown</span>
                      </template>
                    </v-slider>
                  </v-col>
                </v-row>
              </template>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card>

        <v-card v-if="sourceMode === 'cdn'" border color="surface" class="mb-4 pa-4">
          <v-text-field
            v-model="cdnUrl"
            label="CDN lod-meta.json URL"
            :placeholder="PLAYCANVAS_SKATEPARK_LOD_META"
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
              Skatepark example
            </v-btn>
            <v-btn
              variant="tonal"
              color="secondary"
              prepend-icon="mdi-church"
              :disabled="busy"
              @click="useChurchExample"
            >
              Church example (~35M)
            </v-btn>
            <v-btn
              variant="tonal"
              color="warning"
              prepend-icon="mdi-stairs"
              :disabled="busy"
              @click="useOvalInteriorExample"
            >
              Oval interior (stairs)
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
            <v-select
              :model-value="cameraType"
              :items="CAMERA_TYPE_OPTIONS"
              item-title="title"
              item-value="value"
              label="Camera"
              density="compact"
              variant="outlined"
              hide-details
              class="camera-type-select"
              :disabled="busy"
              @update:model-value="setCameraType"
            />
          </div>
        </v-card>

        <v-card v-else border color="surface" class="mb-4 pa-4">
          <div class="text-body-2 text-medium-emphasis mb-3">
            Upload a streamed SOD LOD zip from SplatWalk FastNav export
            (<span class="text-primary">store-only</span>).
            Fine for small demos — city-scale catalogs should use CDN lod-meta so chunks
            stay on the network, not fully in RAM.
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
            <v-select
              :model-value="cameraType"
              :items="CAMERA_TYPE_OPTIONS"
              item-title="title"
              item-value="value"
              label="Camera"
              density="compact"
              variant="outlined"
              hide-details
              class="camera-type-select"
              :disabled="busy"
              @update:model-value="setCameraType"
            />
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
            {{ cameraControlsHint }}
          </div>
        </div>

        <v-expansion-panels v-model="cameraInfoPanels" class="mt-4" variant="accordion" multiple>
          <v-expansion-panel>
            <template #title>
              <div class="d-flex align-center ga-2">
                <v-icon icon="mdi-camera-control" size="small" color="primary" />
                <span>Camera Information</span>
              </div>
            </template>
            <template #text>
              <p class="text-caption text-medium-emphasis mb-3">
                Live pose for capturing a default view (e.g. Oval stairs). Values refresh only
                while this section is open.
              </p>
              <div class="text-body-2 mb-2">
                <span class="text-medium-emphasis">Mode:</span>
                {{ cameraInfo.mode === 'fly' ? 'Fly' : 'Orbit' }}
              </div>
              <div class="text-body-2 mb-2 font-monospace">
                <span class="text-medium-emphasis">Position:</span>
                {{ cameraPositionLabel }}
              </div>
              <div class="text-body-2 mb-2 font-monospace">
                <span class="text-medium-emphasis">Orientation (euler °):</span>
                {{ cameraEulerLabel }}
              </div>
              <div v-if="cameraOrbitLabel" class="text-body-2 mb-3 font-monospace">
                <span class="text-medium-emphasis">Orbit α / β / r:</span>
                {{ cameraOrbitLabel }}
              </div>
              <div class="d-flex flex-wrap ga-2">
                <v-btn
                  size="small"
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-content-copy"
                  @click="copyCameraInfo"
                >
                  {{ cameraInfoCopied ? 'Copied' : 'Copy pose' }}
                </v-btn>
                <v-tooltip
                  :text="
                    liveBackend === 'none'
                      ? 'Run Nav or upload artifacts to spawn a player'
                      : 'Frame top-down on the player agent'
                  "
                  location="top"
                >
                  <template #activator="{ props: tipProps }">
                    <v-btn
                      v-bind="tipProps"
                      size="small"
                      variant="tonal"
                      color="secondary"
                      prepend-icon="mdi-account-arrow-down"
                      :disabled="liveBackend === 'none' || busy"
                      @click="goToPlayer"
                    >
                      Go to Player
                    </v-btn>
                  </template>
                </v-tooltip>
              </div>
              <div class="text-caption text-medium-emphasis mt-2 font-monospace text-wrap">
                {{ cameraInfoCopyText }}
              </div>
            </template>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-expansion-panels v-model="navSectionPanels" class="mt-2" variant="accordion" multiple>
          <v-expansion-panel title="Navigation from stream">
            <template #text>
              <p class="text-body-2 text-medium-emphasis mb-3">
                Materialize a denser LOD PLY from the streamed SOG as a WASM
                intermediary only (stream visual stays on canvas), then build a
                walkable navmesh with click-to-move. Choose
                <strong>floor field</strong> for flat outdoor scenes or
                <strong>voxel collision</strong> for indoor stairs and multi-level spaces.
              </p>

              <div class="text-subtitle-2 mb-2">Nav generation mode</div>
              <v-btn-toggle
                :model-value="navMode"
                mandatory
                density="comfortable"
                color="primary"
                class="mb-2"
                :disabled="busy"
                @update:model-value="onNavGenerationMode"
              >
                <v-btn
                  v-for="option in navModeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.title }}
                </v-btn>
              </v-btn-toggle>
              <p class="text-caption text-medium-emphasis mb-3">
                {{
                  navModeOptions.find((option) => option.value === navMode)?.subtitle
                }}
                <template v-if="navMode === 'voxel_collision'">
                  Island filtering is skipped when baking Recast from the voxel collider
                  (better for stairs and multi-level spaces).
                </template>
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
                :disabled="busy"
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
                {{ activeModeCaption }}
              </p>

              <v-expansion-panels v-model="navSettingsPanels" class="mb-4" variant="accordion" multiple>
                <v-expansion-panel>
                  <template #title>
                    <div class="d-flex align-center ga-2">
                      <v-icon icon="mdi-tune-vertical" size="small" color="primary" />
                      <span>Navmesh settings</span>
                      <v-chip size="x-small" variant="tonal" color="primary">overrides</v-chip>
                    </div>
                  </template>
                  <template #text>
                    <p class="text-caption text-medium-emphasis mb-4">
                      <template v-if="navMode === 'floor_field'">
                        Fast Nav runs on a materialized nav PLY (not the full stream).
                        If coverage is a small local patch while the visual shows the whole
                        park, the nav source was spatially truncated — re-run after this
                        fix, or raise max slope for steep bowls.
                      </template>
                      <template v-else>
                        Voxel collision exports a carved volume
                        (<code class="text-primary">emit_volume</code>). Live backend and dual-ready
                        bake follow <strong>Active navigation mode</strong> above. Cyan collider on by default.
                      </template>
                    </p>

                    <template v-if="navMode === 'voxel_collision'">
                      <div class="text-subtitle-2 mb-2">Voxel collision</div>
                      <p class="text-caption text-medium-emphasis mb-3">
                        Active: {{ activeNavigationModeLabel(activeNavigationMode) }} ·
                        Live: {{ liveNavBackendLabel(liveBackend) }}
                      </p>
                      <v-row density="comfortable" class="mb-2">
                        <v-col cols="12" sm="6" md="4">
                          <v-select
                            v-model="voxelNavSettings.collisionSceneType"
                            :items="collisionSceneTypeOptions"
                            item-title="title"
                            item-value="value"
                            label="Scene type"
                            density="compact"
                            hide-details
                            :disabled="busy"
                          />
                        </v-col>
                        <v-col cols="12" sm="6" md="4">
                          <v-slider
                            v-model="voxelNavSettings.collisionVoxelSize"
                            :min="0.03"
                            :max="0.12"
                            :step="0.005"
                            color="cyan"
                            density="compact"
                            thumb-label
                            hide-details
                          >
                            <template #prepend>
                              <span class="text-caption text-medium-emphasis settings-label">Voxel (m)</span>
                            </template>
                          </v-slider>
                        </v-col>
                        <v-col cols="12" sm="6" md="4">
                          <v-slider
                            v-model="voxelNavSettings.collisionOpacityThreshold"
                            :min="0.02"
                            :max="0.3"
                            :step="0.01"
                            color="cyan"
                            density="compact"
                            thumb-label
                            hide-details
                          >
                            <template #prepend>
                              <span class="text-caption text-medium-emphasis settings-label">Opacity thresh</span>
                            </template>
                          </v-slider>
                        </v-col>
                        <v-col cols="12" sm="6" md="4">
                          <v-slider
                            v-model="voxelNavSettings.collisionFillSize"
                            :min="0.5"
                            :max="2.5"
                            :step="0.1"
                            color="cyan"
                            density="compact"
                            thumb-label
                            hide-details
                          >
                            <template #prepend>
                              <span class="text-caption text-medium-emphasis settings-label">Fill size (m)</span>
                            </template>
                          </v-slider>
                        </v-col>
                        <v-col cols="12" sm="6" md="4">
                          <v-slider
                            v-model="voxelNavSettings.collisionCarveHeight"
                            :min="1.2"
                            :max="2.2"
                            :step="0.05"
                            color="cyan"
                            density="compact"
                            thumb-label
                            hide-details
                          >
                            <template #prepend>
                              <span class="text-caption text-medium-emphasis settings-label">Carve height (m)</span>
                            </template>
                          </v-slider>
                        </v-col>
                        <v-col cols="12" sm="6" md="4">
                          <v-slider
                            v-model="voxelNavSettings.collisionCarveRadius"
                            :min="0.15"
                            :max="0.45"
                            :step="0.05"
                            color="cyan"
                            density="compact"
                            thumb-label
                            hide-details
                          >
                            <template #prepend>
                              <span class="text-caption text-medium-emphasis settings-label">Carve radius (m)</span>
                            </template>
                          </v-slider>
                        </v-col>
                      </v-row>
                      <div class="d-flex flex-wrap align-center ga-2 mb-4">
                        <v-btn
                          size="small"
                          variant="tonal"
                          color="secondary"
                          prepend-icon="mdi-restore"
                          :disabled="busy"
                          @click="resetVoxelNavSettings"
                        >
                          Reset voxel defaults
                        </v-btn>
                      </div>
                      <v-divider class="my-4" />
                    </template>

                    <div class="text-subtitle-2 mb-2">Orientation</div>
                    <p class="text-caption text-medium-emphasis mb-2">
                      CDN example streams (skatepark, church) inherit the
                      GaussianSplattingStream mesh rotation — nav PLY matches by
                      default. Some exported scenes need a separate nav-PLY offset
                      (often −90° X on nav only).
                    </p>
                    <div class="d-flex flex-wrap align-center ga-2 mb-1">
                      <span class="text-caption text-medium-emphasis me-2">Stream</span>
                      <v-btn
                        size="small"
                        variant="tonal"
                        :disabled="busy || !canAdjustOrientation"
                        @click="rotateStreamVisual('x')"
                      >
                        X+90°
                      </v-btn>
                      <v-btn
                        size="small"
                        variant="tonal"
                        :disabled="busy || !canAdjustOrientation"
                        @click="rotateStreamVisual('y')"
                      >
                        Y+90°
                      </v-btn>
                      <v-btn
                        size="small"
                        variant="tonal"
                        :disabled="busy || !canAdjustOrientation"
                        @click="rotateStreamVisual('z')"
                      >
                        Z+90°
                      </v-btn>
                    </div>
                    <p class="text-caption text-medium-emphasis mb-3">{{ streamVisualRotationLabel }}</p>
                    <div class="d-flex flex-wrap align-center ga-2 mb-1">
                      <span class="text-caption text-medium-emphasis me-2">Nav PLY</span>
                      <v-btn
                        size="small"
                        variant="tonal"
                        :disabled="busy || !canAdjustOrientation"
                        @click="rotateNavPly('x')"
                      >
                        X+90°
                      </v-btn>
                      <v-btn
                        size="small"
                        variant="tonal"
                        :disabled="busy || !canAdjustOrientation"
                        @click="rotateNavPly('y')"
                      >
                        Y+90°
                      </v-btn>
                      <v-btn
                        size="small"
                        variant="tonal"
                        :disabled="busy || !canAdjustOrientation"
                        @click="rotateNavPly('z')"
                      >
                        Z+90°
                      </v-btn>
                    </div>
                    <p class="text-caption text-medium-emphasis mb-4">{{ navPlyRotationLabel }}</p>

                    <div class="text-subtitle-2 mb-2">Region and prune</div>
                    <div class="d-flex flex-wrap align-center ga-6 mb-2">
                      <v-switch
                        v-model="navSettings.pruneFloaters"
                        color="primary"
                        density="compact"
                        hide-details
                        label="Prune floaters"
                        :disabled="busy"
                      />
                      <v-switch
                        :model-value="selectionRegionVisible"
                        color="warning"
                        density="compact"
                        hide-details
                        label="Selection region"
                        :disabled="busy || !hasStream"
                        @update:model-value="onSelectionRegionVisible(Boolean($event))"
                      />
                    </div>
                    <p class="text-caption text-medium-emphasis mb-2">
                      Prune applies to both nav modes. Selection region pins WASM to the yellow
                      box. For voxel collision, enabling the region expands Y for stairs/landing;
                      leave it off only for small scenes (large footprints may coarsen voxels).
                    </p>

                    <div class="text-caption text-medium-emphasis mb-2">Camera select AABB (m)</div>
                    <v-row density="comfortable" class="mb-1">
                      <v-col cols="6" sm="4" md="2">
                        <v-text-field
                          v-model.number="cameraSelectOffsets.left"
                          type="number"
                          label="Left"
                          density="compact"
                          hide-details
                          :min="0"
                          :step="0.5"
                          :disabled="busy || !hasStream"
                        />
                      </v-col>
                      <v-col cols="6" sm="4" md="2">
                        <v-text-field
                          v-model.number="cameraSelectOffsets.right"
                          type="number"
                          label="Right"
                          density="compact"
                          hide-details
                          :min="0"
                          :step="0.5"
                          :disabled="busy || !hasStream"
                        />
                      </v-col>
                      <v-col cols="6" sm="4" md="2">
                        <v-text-field
                          v-model.number="cameraSelectOffsets.forward"
                          type="number"
                          label="Forward"
                          density="compact"
                          hide-details
                          :min="0"
                          :step="0.5"
                          :disabled="busy || !hasStream"
                        />
                      </v-col>
                      <v-col cols="6" sm="4" md="2">
                        <v-text-field
                          v-model.number="cameraSelectOffsets.behind"
                          type="number"
                          label="Behind"
                          density="compact"
                          hide-details
                          :min="0"
                          :step="0.5"
                          :disabled="busy || !hasStream"
                        />
                      </v-col>
                      <v-col cols="6" sm="4" md="2">
                        <v-text-field
                          v-model.number="cameraSelectOffsets.below"
                          type="number"
                          label="Below"
                          density="compact"
                          hide-details
                          :min="0"
                          :step="0.5"
                          :disabled="busy || !hasStream"
                        />
                      </v-col>
                      <v-col cols="6" sm="4" md="2">
                        <v-text-field
                          v-model.number="cameraSelectOffsets.above"
                          type="number"
                          label="Above"
                          density="compact"
                          hide-details
                          :min="0"
                          :step="0.5"
                          :disabled="busy || !hasStream"
                        />
                      </v-col>
                    </v-row>
                    <div class="d-flex flex-wrap align-center ga-3 mb-4">
                      <v-btn
                        color="warning"
                        variant="tonal"
                        size="small"
                        :disabled="busy || !hasStream || cameraType !== 'fly'"
                        @click="onApplySelectRegionFromCamera"
                      >
                        Apply select region from camera
                      </v-btn>
                      <v-btn
                        variant="text"
                        size="small"
                        :disabled="busy"
                        @click="resetCameraSelectOffsets"
                      >
                        Reset offsets
                      </v-btn>
                      <span class="text-caption text-medium-emphasis">
                        Uses the live fly view + offsets above to pin the yellow box (Fly mode).
                      </span>
                    </div>

                    <div v-if="navMode === 'floor_field'" class="text-subtitle-2 mb-2">Floor coverage</div>
                    <v-row v-if="navMode === 'floor_field'" density="comfortable">
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.sameLevelBelow"
                          :min="0.25"
                          :max="4"
                          :step="0.05"
                          color="primary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Band below (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.sameLevelAbove"
                          :min="0.3"
                          :max="4"
                          :step="0.05"
                          color="primary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Band above (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.holeFillRadius"
                          :min="0"
                          :max="8"
                          :step="1"
                          color="primary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Hole fill (cells)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.sdfCellSize"
                          :min="0.1"
                          :max="0.4"
                          :step="0.01"
                          color="secondary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">SDF cell (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.sdfDensityThreshold"
                          :min="0.01"
                          :max="0.12"
                          :step="0.005"
                          color="secondary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Density thresh</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.maxLocalHeightVariance"
                          :min="0.08"
                          :max="0.6"
                          :step="0.02"
                          color="secondary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Height variance</span>
                          </template>
                        </v-slider>
                      </v-col>
                    </v-row>

                    <v-divider class="my-4" />
                    <div class="text-subtitle-2 mb-2">Recast agent</div>
                    <v-row density="comfortable">
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.walkableSlopeAngle"
                          :min="30"
                          :max="70"
                          :step="1"
                          color="success"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Max slope (°)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.walkableRadius"
                          :min="0.15"
                          :max="0.6"
                          :step="0.05"
                          color="success"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Agent radius (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.walkableClimb"
                          :min="0.25"
                          :max="1"
                          :step="0.05"
                          color="success"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Max climb (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.minRegionArea"
                          :min="0"
                          :max="24"
                          :step="1"
                          color="success"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Min region</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.maxIslandSeedDistance"
                          :min="6"
                          :max="200"
                          :step="2"
                          color="warning"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Island↔seed max (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.cellBandBelow"
                          :min="0.5"
                          :max="4"
                          :step="0.1"
                          color="primary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Cell band − (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                      <v-col cols="12" sm="6" md="4">
                        <v-slider
                          v-model="navSettings.cellBandAbove"
                          :min="0.45"
                          :max="4"
                          :step="0.1"
                          color="primary"
                          density="compact"
                          thumb-label
                          hide-details
                        >
                          <template #prepend>
                            <span class="text-caption text-medium-emphasis settings-label">Cell band + (m)</span>
                          </template>
                        </v-slider>
                      </v-col>
                    </v-row>

                    <div class="d-flex flex-wrap ga-2 mt-4">
                      <v-btn
                        variant="tonal"
                        color="secondary"
                        prepend-icon="mdi-restore"
                        :disabled="busy"
                        @click="resetNavSettings"
                      >
                        Reset defaults
                      </v-btn>
                      <span class="text-caption text-medium-emphasis align-self-center">
                        Re-run Nav to apply changes
                      </span>
                    </div>
                  </template>
                </v-expansion-panel>
              </v-expansion-panels>

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
                  @click="onRunNav"
                >
                  Run Nav
                </v-btn>
                <v-btn
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-download"
                  :disabled="busy || !hasNavArtifactBundle"
                  @click="downloadNavArtifacts"
                >
                  Download nav artifacts
                </v-btn>
                <div
                  class="nav-artifacts-upload-wrap"
                  :class="{ 'nav-artifacts-upload-wrap--disabled': busy || !hasStream }"
                  :title="navArtifactUploadHint"
                >
                  <v-btn
                    variant="outlined"
                    color="secondary"
                    prepend-icon="mdi-upload"
                    tabindex="-1"
                    :disabled="busy || !hasStream"
                  >
                    Upload nav artifacts
                  </v-btn>
                  <input
                    v-if="hasStream && !busy"
                    ref="navArtifactsInputRef"
                    type="file"
                    multiple
                    accept=".zip,application/zip,.glb,.bin,.json,application/json"
                    class="nav-artifacts-file-hit"
                    :title="navArtifactUploadHint"
                    @change="onNavArtifactsSelected"
                  >
                </div>
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
              <p
                v-if="navMode === 'voxel_collision'"
                class="text-caption text-medium-emphasis mt-2 mb-0"
              >
                {{ navArtifactUploadHint }}
              </p>

              <v-sheet
                v-if="hasColliderMesh"
                border
                rounded="lg"
                class="d-flex align-center flex-wrap ga-4 pa-3 mt-3 navmesh-toggle-bar"
                color="surface"
              >
                <v-icon
                  :icon="colliderVisible ? 'mdi-cube-outline' : 'mdi-cube-off-outline'"
                  :color="colliderVisible ? 'info' : 'medium-emphasis'"
                  size="22"
                />
                <div class="flex-grow-1">
                  <div class="text-body-2 font-weight-medium">Voxel collider overlay</div>
                  <div class="text-caption text-medium-emphasis">
                    {{
                      colliderVisible
                        ? 'Cyan collision boundary visible — walk surfaces for Recast or voxel walk'
                        : 'Toggle on to show the cyan voxel collider overlay'
                    }}
                  </div>
                </div>
                <v-switch
                  :model-value="colliderVisible"
                  color="info"
                  density="comfortable"
                  hide-details
                  inset
                  :disabled="busy"
                  :label="colliderVisible ? 'Shown' : 'Hidden'"
                  @update:model-value="setColliderVisible(Boolean($event))"
                />
              </v-sheet>

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
              <div class="logs-scroll font-monospacespace text-caption">
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
    // City-scale: always pass a resident budget. AppendSceneAsync cannot.
    // Desktop Performance Mode on: 2M / 192MB, behindPenalty 5, coarse-first.
    const rootUrl = "https://code.playcanvas.com/examples_data/example_roman_parish_02/";
    void fetch(rootUrl + "lod-meta.json")
      .then((r) => r.json())
      .then((meta) => {
        const worstLod = Math.max(0, (meta.lodLevels ?? 1) - 1);
        new BABYLON.GaussianSplattingStream("GaussianSplattingStream", meta, rootUrl, scene, {
          maxResidentSplats: 2_000_000,
          memoryBudgetMb: 192,
          maxDetailLod: 0,
          lodBaseDistance: 5,
          lodMultiplier: 3,
          lodBehindPenalty: 5,
          lodRangeMin: worstLod,
          lodRangeMax: worstLod,
          frustumCulling: true,
          maxConcurrentDownloads: 2,
          maxDecodesPerFrame: 1,
          evictionCooldownFrames: 100,
        });
      });
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
.camera-type-select {
  max-width: 220px;
  min-width: 180px;
}

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

.settings-label {
  display: inline-block;
  min-width: 7.5rem;
}
</style>
