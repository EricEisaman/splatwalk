/**
 * Voxel collision navigation: collision boundary → volume → voxel walk | Recast.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  collisionBoundaryDiagnosticsSummary,
  generateCollisionBoundary,
  type CollisionBoundaryArtifact,
} from '@/collision/voxelBoundary';
import {
  finishFastNav,
  generateNavmeshInWorker,
  VOXEL_COLLIDER_RECAST_ATTEMPTS,
  type FastNavPhase,
  type FastNavPhaseListener,
  type FastNavLogger,
  type FastNavResult,
  type RecastParams,
} from '@/navigation/fastNav';
import {
  buildNavArtifactBundle,
  type NavArtifactBundle,
} from '@/navigation/navArtifactBundle';
import {
  initialLiveBackendForActiveMode,
  shouldBakeRecastForActiveMode,
  type ActiveNavigationMode,
} from '@/navigation/activeNavigation';
import type { VoxelCollisionNavSettings, VoxelLocomotionMode } from '@/navigation/voxelNavSettings';
import {
  volumeToConnectedWalkableMesh,
  volumeToWalkableFloorMesh,
  VoxelWalkRuntime,
} from '@/navigation/voxelWalkRuntime';
import type { Viewer } from '@/scene/Viewer';
import {
  splatwalk,
  type CollisionVoxelBoundarySettings,
  type CollisionVoxelVolume,
  type MeshSettings,
} from '@/wasm/bridge';

/** Options for {@link runNavFromVoxelCollider}. */
export interface RunNavFromVoxelColliderOptions {
  readonly bytes: Uint8Array;
  readonly collisionSettings: CollisionVoxelBoundarySettings;
  readonly onLog?: FastNavLogger;
  readonly onPhase?: FastNavPhaseListener;
  readonly onProgress?: (stage: string, fraction: number | null) => void;
  readonly recastAttempts?: ReadonlyArray<{ label: string; params: RecastParams }>;
  readonly recastOverrides?: Partial<RecastParams>;
  readonly showColliderOverlay?: boolean;
  /** Initial cyan collider overlay visibility (default true). */
  readonly colliderVisible?: boolean;
  /**
   * Active navigation mode (preferred). Controls bake intent + initial live backend.
   * When omitted, falls back to {@link locomotionMode}.
   */
  readonly activeNavigationMode?: ActiveNavigationMode;
  /**
   * @deprecated Prefer {@link activeNavigationMode}.
   * `voxel_walk` → voxel_mesh; `recast_crowd` → recast.
   */
  readonly locomotionMode?: VoxelLocomotionMode;
  /** Optional settings snapshot stored in `nav_session.json`. */
  readonly voxelSettingsSnapshot?: Record<string, unknown>;
  readonly viewer: Viewer;
}

/** Result of voxel collision nav, including downloadable artifacts. */
export interface VoxelNavResult extends FastNavResult {
  readonly artifactBundle: NavArtifactBundle;
  /** UI tip when carve may have missed upper stairs/landing. */
  readonly carveReachTip: string | null;
}

const CARVE_REACH_TIP =
  'Expand selection to include upper landing (nav carve did not reach the box top).';

const WASM_PROGRESS_LABELS: Record<string, string> = {
  collision_carve: 'Carving walkable capsule volume',
  collision_cluster: 'Filter-cluster splats (coarse)',
  collision_fill: 'Applying collision fill',
  collision_grid: 'Sizing collision grid',
  collision_mesh: 'Building collision surface mesh',
  collision_voxelize: 'Voxelizing splats into grid',
  parse: 'Parsing PLY',
  prune: 'Pruning floaters',
};

const formatWasmProgressLine = (stage: string, fraction: number | null): string => {
  const label = WASM_PROGRESS_LABELS[stage] ?? stage;
  const pct =
    fraction !== null && Number.isFinite(fraction) ? ` (${Math.round(fraction * 100)}%)` : '';
  return `[WAIT] ${label}${pct}…`;
};

const shouldForwardWasmWorkerLog = (message: string): boolean =>
  message.startsWith('Parsed ') ||
  message.startsWith('Pruned ') ||
  message.startsWith('Floater prune skipped') ||
  message.startsWith('Reusing cached splats') ||
  message.startsWith('Collision grid:') ||
  message.startsWith('Collision carve:') ||
  message.startsWith('PlayCanvas-style collision:');

const logCollisionPreflight = (
  settings: CollisionVoxelBoundarySettings,
  bytes: Uint8Array,
  log: FastNavLogger
): void => {
  const mb = (bytes.byteLength / (1024 * 1024)).toFixed(2);
  const pruneOn = settings.prune_floaters !== false;
  log(
    `[INFO] Collision WASM input: ${mb} MB PLY · prune=${pruneOn ? 'on' : 'off'} · ` +
      `scene=${settings.collision_scene_type ?? 'indoor'} · ` +
      `voxel=${(settings.collision_voxel_size ?? 0.05).toFixed(2)}m · ` +
      `fill=${(settings.collision_fill_size ?? 1.6).toFixed(1)}m · ` +
      `opacity=${settings.collision_opacity_threshold ?? 0.1}`
  );
  if (settings.region_min && settings.region_max) {
    log(
      `[INFO] Collision WASM region: ` +
        `[${settings.region_min.map((v) => v.toFixed(1)).join(', ')}]–` +
        `[${settings.region_max.map((v) => v.toFixed(1)).join(', ')}]`
    );
  }
  if (settings.collision_seed) {
    log(
      `[INFO] Collision WASM seed: ${settings.collision_seed.map((v) => v.toFixed(3)).join(', ')}`
    );
  }
  log('[WAIT] build_collision_voxel_boundary: parse → prune → voxelize → fill → carve → mesh…');
};

const mergeRecastAttempts = (
  baseAttempts: ReadonlyArray<{ label: string; params: RecastParams }>,
  overrides?: Partial<RecastParams>
): ReadonlyArray<{ label: string; params: RecastParams }> => {
  if (!overrides) {
    return baseAttempts;
  }
  return baseAttempts.map((attempt) => ({
    label: attempt.label,
    params: { ...attempt.params, ...overrides },
  }));
};

const formatEmptyColliderError = (
  diagnostics: CollisionBoundaryArtifact['result']['diagnostics'],
  hadPinnedRegion: boolean
): string => {
  const parts = ['Collider mesh is empty.'];
  if (diagnostics.collision_failure_reason) {
    parts.push(`Reason: ${diagnostics.collision_failure_reason}.`);
  }
  const discarded = diagnostics.points_region_discarded ?? 0;
  const afterFilter = diagnostics.points_after_filter ?? 0;
  if (discarded > 0) {
    parts.push(`${discarded} splats fell outside the WASM region box.`);
  }
  if (afterFilter === 0 && discarded === 0) {
    parts.push('No splats passed opacity, scale, or prune filters.');
  }
  if (diagnostics.oriented_min && diagnostics.oriented_max) {
    parts.push(
      `Materialized PLY oriented bounds ` +
        `[${diagnostics.oriented_min.map((v) => v.toFixed(2)).join(', ')}]–` +
        `[${diagnostics.oriented_max.map((v) => v.toFixed(2)).join(', ')}].`
    );
  }
  if (hadPinnedRegion && diagnostics.region_min && diagnostics.region_max) {
    parts.push(
      `Pinned WASM region ` +
        `[${diagnostics.region_min.map((v) => v.toFixed(2)).join(', ')}]–` +
        `[${diagnostics.region_max.map((v) => v.toFixed(2)).join(', ')}].`
    );
  }
  if (diagnostics.collision_seed_state) {
    parts.push(`Seed state: ${diagnostics.collision_seed_state}.`);
  }
  if (diagnostics.collision_seed_used) {
    parts.push(
      `Seed: [${diagnostics.collision_seed_used.map((v) => v.toFixed(2)).join(', ')}].`
    );
  }
  if (diagnostics.collision_failure_reason === 'seed_not_reachable_or_capsule_blocked') {
    parts.push(
      'The walk agent could not fit at the collision seed after voxel fill/carve — floor height or fill mode may need adjustment.'
    );
  }
  if (diagnostics.collision_failure_reason === 'region_too_large') {
    parts.push(
      'Shrink the yellow Selection region (target footprint ≲ 18–25 m for ~0.05 m voxels). ' +
        'Full-scene dense collision is not supported at this size — Selection region is required.'
    );
  } else {
    parts.push('Try indoor scene type, lower opacity threshold, or larger fill size.');
  }
  return parts.join(' ');
};

const logCollisionArtifact = (
  artifact: CollisionBoundaryArtifact,
  log: FastNavLogger
): void => {
  const boundary = artifact.result;
  log(
    `[INFO] Collision boundary: ${boundary.mesh.vertex_count} vertices, ${boundary.mesh.face_count} faces.`
  );
  log(`[INFO] Collision diagnostics: ${collisionBoundaryDiagnosticsSummary(boundary.diagnostics)}`);
  const kept = boundary.diagnostics.collision_cluster_kept_voxels ?? 0;
  const discarded = boundary.diagnostics.collision_cluster_discarded_voxels ?? 0;
  if (kept > 0 || discarded > 0) {
    log(
      `[INFO] Filter-cluster (seed component): kept=${kept} voxels, discarded=${discarded} voxels.`
    );
  }
  if (boundary.diagnostics.collision_seed_state) {
    log(`[INFO] Collision seed state: ${boundary.diagnostics.collision_seed_state}`);
  }
  if (boundary.diagnostics.collision_seed_used) {
    log(
      `[INFO] Collision seed: ${boundary.diagnostics.collision_seed_used.map((v) => v.toFixed(3)).join(', ')}`
    );
  }
  if (boundary.diagnostics.collision_external_fill_leaked) {
    log(
      '[WARN] Indoor external fill skipped because the seed leaked to exterior. ' +
        'Carve will use the unfilled grid.'
    );
  }
};

/** Resolve a walkable collision seed from the pinned region or auto floor suggestion. */
export const resolveVoxelCollisionSeed = async ({
  bytes,
  carveHeight,
  ignorePinnedRegion = false,
  meshSettingsBase,
  viewer,
}: {
  readonly bytes: Uint8Array;
  readonly carveHeight: number;
  /** When true, skip yellow-box mid-capsule seed (e.g. empty-region → global fallback). */
  readonly ignorePinnedRegion?: boolean;
  readonly meshSettingsBase: MeshSettings;
  readonly viewer: Viewer;
}): Promise<number[]> => {
  const regionBounds = ignorePinnedRegion ? null : viewer.getWasmRegionBounds();

  if (regionBounds) {
    // Seed from selection box floor + half agent height.
    // Do not run suggestRegion on multi-million-splat materialized PLY — it can take many
    // minutes and the pinned box already defines floor Y.
    return [
      (regionBounds.min[0] + regionBounds.max[0]) * 0.5,
      regionBounds.min[1] + carveHeight * 0.5,
      (regionBounds.min[2] + regionBounds.max[2]) * 0.5,
    ];
  }

  const suggested = await splatwalk.suggestRegion(bytes, meshSettingsBase);
  const floorY = suggested.floor_y;

  return [
    (suggested.region_min[0] + suggested.region_max[0]) * 0.5,
    floorY + carveHeight * 0.5,
    (suggested.region_min[2] + suggested.region_max[2]) * 0.5,
  ];
};

const isSeedBlockedFailure = (reason: string | undefined): boolean =>
  reason === 'seed_not_reachable_or_capsule_blocked';

const buildCollisionRecoverySettings = async (
  settings: CollisionVoxelBoundarySettings,
  label: string,
  options: RunNavFromVoxelColliderOptions
): Promise<CollisionVoxelBoundarySettings> => {
  const carveHeight = settings.collision_carve_height ?? 1.6;
  const meshSettingsBase: MeshSettings = {
    ...settings,
    collision_seed: undefined,
  };
  const seed = await resolveVoxelCollisionSeed({
    bytes: options.bytes,
    carveHeight,
    meshSettingsBase,
    viewer: options.viewer,
  });
  options.viewer.displaySeedMarker(seed);

  if (label === 'pc indoor defaults') {
    return {
      ...settings,
      collision_carve_height: 1.6,
      collision_carve_radius: 0.2,
      collision_fill_size: 1.6,
      collision_scene_type: 'indoor',
      collision_seed: seed,
    };
  }

  if (label === 'indoor bridge gaps') {
    return {
      ...settings,
      collision_carve_height: 1.6,
      collision_carve_radius: 0.2,
      collision_fill_size: 2.0,
      collision_opacity_threshold: Math.min(settings.collision_opacity_threshold ?? 0.1, 0.06),
      collision_scene_type: 'indoor',
      collision_voxel_size: Math.min(settings.collision_voxel_size ?? 0.05, 0.04),
      collision_seed: seed,
    };
  }

  if (label === 'indoor smaller capsule') {
    return {
      ...settings,
      collision_carve_height: 1.4,
      collision_carve_radius: 0.15,
      collision_fill_size: Math.max(settings.collision_fill_size ?? 1.6, 1.6),
      collision_scene_type: 'indoor',
      collision_seed: seed,
    };
  }

  if (label === 'outdoor floor fill') {
    return {
      ...settings,
      collision_scene_type: 'outdoor',
      collision_seed: seed,
    };
  }

  if (label === 'outdoor + relaxed opacity') {
    return {
      ...settings,
      collision_carve_radius: Math.min(settings.collision_carve_radius ?? 0.35, 0.25),
      collision_opacity_threshold: Math.min(settings.collision_opacity_threshold ?? 0.1, 0.06),
      collision_scene_type: 'outdoor',
      collision_seed: seed,
    };
  }

  if (label === 'object mode (carve only)') {
    return {
      ...settings,
      collision_scene_type: 'object',
      collision_seed: seed,
    };
  }

  return { ...settings, collision_seed: seed };
};

const boundsFromPositions = (
  positions: Float32Array
): { min: number[]; max: number[] } | null => {
  if (positions.length < 3) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
};

/**
 * Build a walkable navmesh from a generated voxel collision mesh.
 */
export async function runNavFromVoxelCollider(
  options: RunNavFromVoxelColliderOptions
): Promise<VoxelNavResult> {
  const log: FastNavLogger = options.onLog ?? ((message: string): void => console.log(message));
  const phase: FastNavPhaseListener = options.onPhase ?? ((): void => undefined);

  log('[WAIT] Voxel collision path: splat -> collider -> navmesh -> NPC...');
  phase('floor');

  const previousProgress = splatwalk.onProgress;
  const previousWorkerLog = splatwalk.onWorkerLog;
  let lastProgressKey = '';

  const runCollisionPass = async (
    settings: CollisionVoxelBoundarySettings,
    passLabel?: string
  ): Promise<CollisionBoundaryArtifact> => {
    if (passLabel) {
      log(`[INFO] Collision retry: ${passLabel}.`);
    }
    logCollisionPreflight(settings, options.bytes, log);
    lastProgressKey = '';
    const artifact = await generateCollisionBoundary({
      bytes: options.bytes,
      settings,
    });
    logCollisionArtifact(artifact, log);
    return artifact;
  };

  splatwalk.onProgress = (stage, fraction): void => {
    options.onProgress?.(stage, fraction);
    const bucket = fraction !== null ? Math.floor(fraction * 10) : -1;
    const key = `${stage}:${bucket}`;
    if (key === lastProgressKey) {
      return;
    }
    lastProgressKey = key;
    log(formatWasmProgressLine(stage, fraction));
  };
  splatwalk.onWorkerLog = (message): void => {
    if (shouldForwardWasmWorkerLog(message)) {
      log(`[INFO] ${message}`);
    }
  };

  let collisionSettings = options.collisionSettings;
  let artifact: CollisionBoundaryArtifact;
  try {
    artifact = await runCollisionPass(collisionSettings);
    let boundary = artifact.result;
    let geometry = {
      positions: new Float32Array(boundary.mesh.vertices),
      indices: new Uint32Array(boundary.mesh.indices),
    };

    const isEmptyGeometry = (): boolean =>
      geometry.positions.length === 0 || geometry.indices.length === 0;

    const hadPinnedRegion = Boolean(
      collisionSettings.region_min && collisionSettings.region_max
    );

    const sceneType = collisionSettings.collision_scene_type ?? 'indoor';
    const indoorRecoveryLabels = [
      'object mode (carve only)',
      'pc indoor defaults',
      'indoor bridge gaps',
      'indoor smaller capsule',
    ] as const;
    const outdoorRecoveryLabels = ['outdoor floor fill', 'outdoor + relaxed opacity'] as const;
    const collisionRecoveryLabels =
      sceneType === 'outdoor' ? outdoorRecoveryLabels : indoorRecoveryLabels;
    const shouldRetryCollision = (): boolean => {
      if (!isEmptyGeometry()) {
        return false;
      }
      if (isSeedBlockedFailure(boundary.diagnostics.collision_failure_reason)) {
        return true;
      }
      return Boolean(boundary.diagnostics.collision_external_fill_leaked);
    };

    for (const label of collisionRecoveryLabels) {
      if (!shouldRetryCollision()) {
        break;
      }
      const reason = boundary.diagnostics.collision_external_fill_leaked
        ? 'exterior fill leaked'
        : 'collision seed blocked';
      log(`[WARN] ${reason} — retrying with ${label}.`);
      collisionSettings = await buildCollisionRecoverySettings(collisionSettings, label, options);
      artifact = await runCollisionPass(collisionSettings, label);
      boundary = artifact.result;
      geometry = {
        positions: new Float32Array(boundary.mesh.vertices),
        indices: new Uint32Array(boundary.mesh.indices),
      };
    }

    if (isEmptyGeometry() && hadPinnedRegion) {
      log(
        '[WARN] Collider still empty with pinned selection region — retrying without region clip as a fallback.'
      );
      collisionSettings = {
        ...collisionSettings,
        region_min: undefined,
        region_max: undefined,
      };
      artifact = await runCollisionPass(collisionSettings, 'without region clip');
      boundary = artifact.result;
      geometry = {
        positions: new Float32Array(boundary.mesh.vertices),
        indices: new Uint32Array(boundary.mesh.indices),
      };
    }

    if (isEmptyGeometry()) {
      throw new Error(formatEmptyColliderError(boundary.diagnostics, hadPinnedRegion));
    }

    const volume = normalizeCollisionVolume(boundary.volume);
    if (!volume) {
      throw new Error(
        'Collision result missing `volume` (emit_volume). Rebuild WASM 0.5.0+ with capability collision_voxel_volume.'
      );
    }

    if (options.showColliderOverlay !== false) {
      options.viewer.displayColliderMesh(boundary.mesh.vertices, boundary.mesh.indices, 0.35);
      options.viewer.setColliderVisible(options.colliderVisible ?? true);
      log(
        `[INFO] Cyan collider overlay shown (${boundary.mesh.vertex_count} verts). ` +
          `Volume ${volume.dims[0]}x${volume.dims[1]}x${volume.dims[2]} @ ${volume.voxel_size.toFixed(3)}m.`
      );
    }

    const splatBoundsVec = options.viewer.getSplatBoundsForDiagnostics();
    const splatBounds = splatBoundsVec
      ? { min: splatBoundsVec.min.asArray(), max: splatBoundsVec.max.asArray() }
      : null;

    const activeMode: ActiveNavigationMode =
      options.activeNavigationMode ??
      (options.locomotionMode === 'recast_crowd' ? 'recast' : 'voxel_mesh');
    const liveBackend = initialLiveBackendForActiveMode(activeMode);
    const bakeRecast = shouldBakeRecastForActiveMode(activeMode);
    const navSeed = boundary.diagnostics.collision_seed_used ?? null;
    if (!navSeed || navSeed.length < 3) {
      throw new Error('Collision seed missing — cannot spawn player.');
    }

    // Alignment guard (volume vs splat) before locomotion.
    options.viewer.assertVolumeAlignedWithSplat(new VoxelWalkRuntime({ volume }));
    assertSeedInsideSplat(options.viewer, navSeed, log);

    const regionBounds = options.viewer.getWasmRegionBounds();
    const extent = new VoxelWalkRuntime({ volume }).navExtentDiagnostics();
    const regionMaxY = regionBounds?.max[1];
    const carveSummary =
      `navY=[${extent.navMinY?.toFixed(2) ?? 'n/a'}, ${extent.navMaxY?.toFixed(2) ?? 'n/a'}] ` +
      `floorCellMaxY=${extent.floorCellMaxY?.toFixed(2) ?? 'n/a'} ` +
      `volumeY=[${extent.volumeMinY.toFixed(2)}, ${extent.volumeMaxY.toFixed(2)}] ` +
      `regionMaxY=${regionMaxY?.toFixed(2) ?? 'n/a'}`;
    log(`[INFO] Carve reachability: ${carveSummary}`);
    let carveReachTip: string | null = null;
    if (
      extent.navMaxY !== null &&
      regionMaxY !== undefined &&
      extent.navMaxY < regionMaxY - 1.5
    ) {
      carveReachTip = CARVE_REACH_TIP;
      log(
        '[WARN] nav_region max Y is well below the selection-box top — carve may not have ' +
          'reached upper stairs/landing. Expand the yellow box / check carve seed free cell.'
      );
      log(`[TIP] ${CARVE_REACH_TIP}`);
    }

    log(
      `[INFO] Active navigation mode: ${activeMode} → live ${liveBackend}` +
        (bakeRecast ? ', bake Recast' : ', volume only') +
        '.'
    );

    let recastArtifact: {
      navMeshData: Uint8Array;
      debugPositions: Float32Array;
      debugIndices: Uint32Array;
    } | null = null;

    if (bakeRecast) {
      if (boundary.diagnostics.collision_seed_used) {
        options.viewer.displaySeedMarker(boundary.diagnostics.collision_seed_used);
      }
      log('[INFO] Baking Recast from voxel volume spans (`generated_voxel_volume`)…');
      const connected = volumeToConnectedWalkableMesh(volume, 0.75);
      geometry = {
        positions: new Float32Array(connected.positions),
        indices: new Uint32Array(connected.indices),
      };
      if (geometry.indices.length < 3) {
        throw new Error('Voxel volume produced no walkable floor spans for Recast.');
      }

      const colliderBounds = boundsFromPositions(geometry.positions);
      if (colliderBounds) {
        const width = colliderBounds.max[0]! - colliderBounds.min[0]!;
        const height = colliderBounds.max[1]! - colliderBounds.min[1]!;
        const depth = colliderBounds.max[2]! - colliderBounds.min[2]!;
        log(
          `[INFO] Voxel-span mesh for Recast: ${width.toFixed(2)}x${height.toFixed(2)}x${depth.toFixed(2)}m ` +
            `(${geometry.indices.length / 3} tris).`
        );
      }

      let recastOverrides = options.recastOverrides;
      if (colliderBounds && recastOverrides?.walkableRadius !== undefined) {
        const footprint = Math.min(
          colliderBounds.max[0]! - colliderBounds.min[0]!,
          colliderBounds.max[2]! - colliderBounds.min[2]!
        );
        const maxRadius = Math.max(0.05, footprint * 0.35);
        if (recastOverrides.walkableRadius > maxRadius) {
          log(
            `[WARN] Clamping Recast walkableRadius ${recastOverrides.walkableRadius.toFixed(2)}m -> ` +
              `${maxRadius.toFixed(2)}m for ${footprint.toFixed(2)}m collider footprint.`
          );
          recastOverrides = { ...recastOverrides, walkableRadius: maxRadius };
        }
      }

      const attempts = mergeRecastAttempts(
        options.recastAttempts ?? VOXEL_COLLIDER_RECAST_ATTEMPTS,
        recastOverrides
      );

      phase('navmesh');
      let result: Awaited<ReturnType<typeof generateNavmeshInWorker>> | null = null;
      let lastError: unknown = null;
      for (const attempt of attempts) {
        log(`[WAIT] Spawning NavMesh worker (${attempt.label})…`);
        try {
          result = await generateNavmeshInWorker(
            geometry,
            attempt.params,
            'generated_voxel_volume',
            splatBounds,
            colliderBounds
          );
          if (attempt.label !== 'strict') {
            log(`[WARN] Voxel nav recovered with ${attempt.label} Recast settings.`);
          }
          break;
        } catch (error) {
          lastError = error;
          if (attempt === attempts[attempts.length - 1]) {
            break;
          }
          log(
            `[WARN] Voxel nav ${attempt.label} attempt failed; retrying with relaxed Recast settings.`
          );
        }
      }

      if (!result) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
      if (result.debugIndices.length < 3) {
        throw new Error(
          'Recast produced an empty navmesh from the voxel volume. Try indoor scene type, a smaller voxel size, or a tighter selection region on walkable floor.'
        );
      }
      recastArtifact = {
        navMeshData: result.navMeshData,
        debugPositions: result.debugPositions,
        debugIndices: result.debugIndices,
      };
      log('[SUCCESS] Recast bake from voxel volume ready.');
    }

    phase('navmesh');
    let playerSpawn: Vector3 | null = null;
    let keptCameraSelectView = false;
    let navMeshData = new Uint8Array(0);

    if (liveBackend === 'recast_crowd') {
      if (!recastArtifact) {
        throw new Error('Recast live backend requires a successful Recast bake.');
      }
      const finished = await finishFastNav(
        options.viewer,
        recastArtifact,
        log,
        'Voxel collision nav',
        navSeed
      );
      playerSpawn = finished.playerSpawn;
      keptCameraSelectView = finished.keptCameraSelectView;
      navMeshData = new Uint8Array(finished.navMeshData);
      phase('done');
      log('[SUCCESS] Voxel collision: volume → Recast crowd (live).');
    } else {
      log('[INFO] Locomotion: voxel walk (cylinder spawn + solid ground probes).');
      const debugMesh = volumeToWalkableFloorMesh(volume);
      if (debugMesh.usedSolidTopFallback) {
        log(
          '[INFO] Walkable floor mesh: no nav floor cells — emitting solid tops for full volume.'
        );
      }
      await options.viewer.displayNavMesh(debugMesh.positions, debugMesh.indices, 0, navSeed, 0);
      playerSpawn = options.viewer.initVoxelWalk(volume, navSeed);
      options.viewer.setPreferredNavSpawnPoints(
        [playerSpawn.x, playerSpawn.y, playerSpawn.z],
        null
      );
      if (recastArtifact) {
        navMeshData = new Uint8Array(recastArtifact.navMeshData);
        log(
          '[INFO] Dual-ready: Recast bin kept in pack for Active hot-swap (live remains voxel walk).'
        );
      }
      phase('done');
      log(
        `[SUCCESS] Voxel collision: volume → voxel walk. Spawn (${playerSpawn.x.toFixed(2)}, ` +
          `${playerSpawn.y.toFixed(2)}, ${playerSpawn.z.toFixed(2)}). Click to climb stairs.`
      );
    }

    const locomotionMode: VoxelLocomotionMode =
      liveBackend === 'recast_crowd' ? 'recast_crowd' : 'voxel_walk';
    const artifactBundle = await buildNavArtifactBundle({
      activeNavigationMode: activeMode,
      carveDiagnosticsSummary: carveSummary,
      collisionGlb: boundary.glb ?? null,
      collisionMesh: boundary.mesh,
      locomotionMode,
      navMeshData: navMeshData.byteLength > 0 ? navMeshData : null,
      onLog: log,
      playerSpawn: playerSpawn
        ? [playerSpawn.x, playerSpawn.y, playerSpawn.z]
        : null,
      regionMax: regionBounds?.max ?? null,
      regionMin: regionBounds?.min ?? null,
      seed: navSeed,
      volume,
      voxelSettings: options.voxelSettingsSnapshot,
    });
    return {
      artifactBundle,
      carveReachTip,
      keptCameraSelectView,
      navMeshData,
      playerSpawn,
    };
  } finally {
    splatwalk.onProgress = previousProgress;
    splatwalk.onWorkerLog = previousWorkerLog;
  }
}

/** Human-readable summary for UI logs. */
export const formatVoxelNavSettingsLog = (settings: VoxelCollisionNavSettings): string =>
  `scene=${settings.collisionSceneType} voxel=${settings.collisionVoxelSize}m ` +
  `opacity=${settings.collisionOpacityThreshold} fill=${settings.collisionFillSize}m ` +
  `carve=${settings.collisionCarveHeight}/${settings.collisionCarveRadius}m ` +
  `locomotion=${settings.locomotionMode}`;

const assertSeedInsideSplat = (
  viewer: Viewer,
  seedOriented: readonly number[],
  log: FastNavLogger
): void => {
  const seedWorld = viewer.orientedNavPointToWorld(
    new Vector3(seedOriented[0]!, seedOriented[1]!, seedOriented[2]!)
  );
  const splat = viewer.getSplatBoundsForDiagnostics();
  if (!splat) {
    return;
  }
  const pad = 1.0;
  const inside =
    seedWorld.x >= splat.min.x - pad &&
    seedWorld.x <= splat.max.x + pad &&
    seedWorld.y >= splat.min.y - pad &&
    seedWorld.y <= splat.max.y + pad &&
    seedWorld.z >= splat.min.z - pad &&
    seedWorld.z <= splat.max.z + pad;
  if (!inside) {
    throw new Error(
      `Collision seed world (${seedWorld.x.toFixed(2)}, ${seedWorld.y.toFixed(2)}, ${seedWorld.z.toFixed(2)}) ` +
        `is outside splat bounds — refusing void spawn. ` +
        `splat Y [${splat.min.y.toFixed(2)}, ${splat.max.y.toFixed(2)}]. Check flip_y / rotation.`
    );
  }
  log(
    `[INFO] Seed world (${seedWorld.x.toFixed(2)}, ${seedWorld.y.toFixed(2)}, ${seedWorld.z.toFixed(2)}) inside splat.`
  );
};

/** Coerce WASM/serde volume payloads into typed {@link CollisionVoxelVolume}. */
const normalizeCollisionVolume = (raw: unknown): CollisionVoxelVolume | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const v = raw as Partial<CollisionVoxelVolume> & {
    solid?: Uint8Array | number[] | ArrayBuffer;
    nav_region?: Uint8Array | number[] | ArrayBuffer;
  };
  if (!v.origin || !v.dims || !v.voxel_size || !v.solid || !v.nav_region) {
    return null;
  }
  const toU8 = (data: Uint8Array | number[] | ArrayBuffer): Uint8Array => {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    return new Uint8Array(data);
  };
  return {
    origin: [Number(v.origin[0]), Number(v.origin[1]), Number(v.origin[2])],
    dims: [Number(v.dims[0]), Number(v.dims[1]), Number(v.dims[2])],
    voxel_size: Number(v.voxel_size),
    solid: toU8(v.solid),
    nav_region: toU8(v.nav_region),
  };
};

export type { FastNavPhase };
