/**
 * Stable filename contract for nav artifact zip packs.
 *
 * Download producer: {@link buildNavArtifactBundle} / demos “Download nav artifacts”.
 * Upload consumer: unzip or multi-select these members and either:
 *   A) load `volume.meta.json` + `volume.solid.bin` + `volume.nav_region.bin` → VoxelWalkRuntime
 *   B) load `recast.navmesh.bin` → Recast crowd
 *   C) read `nav_session.json` to restore seed / region / settings in the UI
 *   D) optional `collision.glb` / `walkable_floors.glb` for overlays
 */

/** Zip member names — do not rename without bumping format. */
export const NAV_ARTIFACT_FILES = {
  collisionGlb: 'collision.glb',
  navSessionJson: 'nav_session.json',
  recastNavmeshBin: 'recast.navmesh.bin',
  volumeMetaJson: 'volume.meta.json',
  volumeNavRegionBin: 'volume.nav_region.bin',
  volumeSolidBin: 'volume.solid.bin',
  walkableFloorsGlb: 'walkable_floors.glb',
} as const;

export type NavArtifactFileName =
  (typeof NAV_ARTIFACT_FILES)[keyof typeof NAV_ARTIFACT_FILES];

export const NAV_VOLUME_FORMAT = 'splatwalk_volume_v1';

export interface NavVolumeMetaV1 {
  readonly dims: readonly [number, number, number];
  readonly format: typeof NAV_VOLUME_FORMAT;
  readonly origin: readonly [number, number, number];
  readonly voxel_size: number;
}

export type ActiveNavigationModeArtifact =
  | 'recast'
  | 'voxel_mesh'
  | 'recast_and_voxel_mesh';

export interface NavSessionArtifactV1 {
  /** Desired Active navigation mode when the pack was built (optional; restore hint). */
  readonly activeNavigationMode?: ActiveNavigationModeArtifact;
  readonly carveDiagnosticsSummary?: string;
  readonly collisionSeed?: readonly number[] | null;
  readonly locomotionMode: 'voxel_walk' | 'recast_crowd';
  readonly playerSpawn?: readonly [number, number, number] | null;
  readonly regionMax?: readonly number[] | null;
  readonly regionMin?: readonly number[] | null;
  readonly version: 1;
  readonly voxelSettings?: Record<string, unknown>;
}

/** Expected members for upload (zip or multi-select of the same basenames). */
export const NAV_ARTIFACT_UPLOAD_HINT =
  'Upload a nav-artifacts .zip or multi-select files named: nav_session.json plus either ' +
  '(volume.meta.json + volume.solid.bin + volume.nav_region.bin) or recast.navmesh.bin. ' +
  'Optional: collision.glb, walkable_floors.glb.';
