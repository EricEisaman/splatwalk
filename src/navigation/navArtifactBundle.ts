/**
 * In-memory nav artifact pack + zip download/upload parse for demos.
 * Filename contract: {@link NAV_ARTIFACT_FILES} in navArtifactContract.ts.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { downloadBytes } from '@/collision/voxelBoundary';
import {
  NAV_ARTIFACT_FILES,
  NAV_VOLUME_FORMAT,
  type ActiveNavigationModeArtifact,
  type NavSessionArtifactV1,
  type NavVolumeMetaV1,
} from '@/navigation/navArtifactContract';
import {
  volumeToSolidExteriorMesh,
  volumeToWalkableFloorMesh,
} from '@/navigation/voxelWalkRuntime';
import { splatwalk, type CollisionVoxelVolume } from '@/wasm/bridge';

/** Full or minimal pack (volume fields optional when `recast.navmesh.bin` is present). */
export interface NavArtifactBundle {
  readonly collisionGlb?: Uint8Array;
  readonly navSessionJson: string;
  readonly recastNavmeshBin?: Uint8Array;
  readonly volumeMetaJson?: string;
  readonly volumeNavRegionBin?: Uint8Array;
  readonly volumeSolidBin?: Uint8Array;
  readonly walkableFloorsGlb?: Uint8Array;
}

export interface ParsedNavArtifacts {
  readonly bundle: NavArtifactBundle;
  readonly session: NavSessionArtifactV1;
  readonly volume: CollisionVoxelVolume | null;
  readonly volumeMeta: NavVolumeMetaV1 | null;
}

export interface BuildNavArtifactBundleOptions {
  readonly activeNavigationMode?: ActiveNavigationModeArtifact;
  readonly carveDiagnosticsSummary?: string;
  readonly collisionGlb?: Uint8Array | null;
  readonly collisionMesh: {
    readonly indices: ArrayLike<number>;
    readonly vertices: ArrayLike<number>;
  };
  readonly locomotionMode: 'voxel_walk' | 'recast_crowd';
  readonly navMeshData?: Uint8Array | null;
  readonly onLog?: (message: string) => void;
  readonly playerSpawn?: readonly [number, number, number] | null;
  readonly regionMax?: readonly number[] | null;
  readonly regionMin?: readonly number[] | null;
  readonly seed?: readonly number[] | null;
  readonly volume: CollisionVoxelVolume;
  readonly voxelSettings?: Record<string, unknown>;
}

export interface BuildMinimalNavArtifactBundleOptions {
  readonly collisionGlb?: Uint8Array | null;
  readonly navMeshData: Uint8Array;
  readonly playerSpawn?: readonly [number, number, number] | null;
  readonly regionMax?: readonly number[] | null;
  readonly regionMin?: readonly number[] | null;
  readonly seed?: readonly number[] | null;
}

const meshHasGeometry = (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>
): boolean => positions.length >= 3 && indices.length >= 3;

const basenameOf = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? path;
};

/** Build the full downloadable pack after a successful voxel nav run. */
export const buildNavArtifactBundle = async (
  options: BuildNavArtifactBundleOptions
): Promise<NavArtifactBundle> => {
  const volume = options.volume;
  const log = options.onLog;
  const meta: NavVolumeMetaV1 = {
    dims: [volume.dims[0], volume.dims[1], volume.dims[2]],
    format: NAV_VOLUME_FORMAT,
    origin: [volume.origin[0], volume.origin[1], volume.origin[2]],
    voxel_size: volume.voxel_size,
  };

  const session: NavSessionArtifactV1 = {
    activeNavigationMode: options.activeNavigationMode,
    carveDiagnosticsSummary: options.carveDiagnosticsSummary,
    collisionSeed: options.seed ?? null,
    locomotionMode: options.locomotionMode,
    playerSpawn: options.playerSpawn ?? null,
    regionMax: options.regionMax ?? null,
    regionMin: options.regionMin ?? null,
    version: 1,
    voxelSettings: options.voxelSettings,
  };

  let collisionGlb =
    options.collisionGlb && options.collisionGlb.byteLength > 0
      ? options.collisionGlb
      : null;

  if (
    !collisionGlb &&
    meshHasGeometry(options.collisionMesh.vertices, options.collisionMesh.indices)
  ) {
    collisionGlb = await splatwalk.meshToGlb(
      new Float32Array(options.collisionMesh.vertices),
      new Uint32Array(options.collisionMesh.indices)
    );
  }

  if (!collisionGlb) {
    const exterior = volumeToSolidExteriorMesh(volume);
    if (!meshHasGeometry(exterior.positions, exterior.indices)) {
      throw new Error(
        'Nav artifacts: collision mesh empty and volume has no solid exterior faces.'
      );
    }
    log?.(
      '[INFO] Collision GLB: WASM boundary empty — emitting solid exterior faces from volume.'
    );
    collisionGlb = await splatwalk.meshToGlb(exterior.positions, exterior.indices);
  }

  const floorMesh = volumeToWalkableFloorMesh(volume);
  if (!meshHasGeometry(floorMesh.positions, floorMesh.indices)) {
    throw new Error(
      'Nav artifacts: walkable floor mesh empty (no nav floor cells or solid tops).'
    );
  }
  if (floorMesh.usedSolidTopFallback) {
    log?.(
      '[INFO] Walkable floor mesh: no nav floor cells — emitting solid tops for full volume.'
    );
  }
  const walkableFloorsGlb = await splatwalk.meshToGlb(
    floorMesh.positions,
    floorMesh.indices
  );

  const bundle: NavArtifactBundle = {
    collisionGlb,
    navSessionJson: `${JSON.stringify(session, null, 2)}\n`,
    volumeMetaJson: `${JSON.stringify(meta, null, 2)}\n`,
    volumeNavRegionBin: volume.nav_region,
    volumeSolidBin: volume.solid,
    walkableFloorsGlb,
  };

  // Include Recast whenever baked (dual-ready packs keep volume + bin even if live is voxel_walk).
  if (options.navMeshData && options.navMeshData.byteLength > 0) {
    return { ...bundle, recastNavmeshBin: options.navMeshData };
  }

  return bundle;
};

/** Minimal Fast Nav pack: session + Recast binary (+ optional collision GLB). */
export const buildMinimalNavArtifactBundle = (
  options: BuildMinimalNavArtifactBundleOptions
): NavArtifactBundle => {
  if (!options.navMeshData.byteLength) {
    throw new Error('Minimal nav artifacts require non-empty recast.navmesh.bin bytes.');
  }
  const session: NavSessionArtifactV1 = {
    collisionSeed: options.seed ?? null,
    locomotionMode: 'recast_crowd',
    playerSpawn: options.playerSpawn ?? null,
    regionMax: options.regionMax ?? null,
    regionMin: options.regionMin ?? null,
    version: 1,
  };
  return {
    collisionGlb:
      options.collisionGlb && options.collisionGlb.byteLength > 0
        ? options.collisionGlb
        : undefined,
    navSessionJson: `${JSON.stringify(session, null, 2)}\n`,
    recastNavmeshBin: options.navMeshData,
  };
};

/** Zip member map for {@link NAV_ARTIFACT_FILES} (omit empty optional members). */
export const navArtifactZipEntries = (
  bundle: NavArtifactBundle
): Record<string, Uint8Array> => {
  const entries: Record<string, Uint8Array> = {
    [NAV_ARTIFACT_FILES.navSessionJson]: strToU8(bundle.navSessionJson),
  };
  if (bundle.collisionGlb && bundle.collisionGlb.byteLength > 0) {
    entries[NAV_ARTIFACT_FILES.collisionGlb] = bundle.collisionGlb;
  }
  if (bundle.volumeMetaJson) {
    entries[NAV_ARTIFACT_FILES.volumeMetaJson] = strToU8(bundle.volumeMetaJson);
  }
  if (bundle.volumeNavRegionBin && bundle.volumeNavRegionBin.byteLength > 0) {
    entries[NAV_ARTIFACT_FILES.volumeNavRegionBin] = bundle.volumeNavRegionBin;
  }
  if (bundle.volumeSolidBin && bundle.volumeSolidBin.byteLength > 0) {
    entries[NAV_ARTIFACT_FILES.volumeSolidBin] = bundle.volumeSolidBin;
  }
  if (bundle.walkableFloorsGlb && bundle.walkableFloorsGlb.byteLength > 0) {
    entries[NAV_ARTIFACT_FILES.walkableFloorsGlb] = bundle.walkableFloorsGlb;
  }
  if (bundle.recastNavmeshBin && bundle.recastNavmeshBin.byteLength > 0) {
    entries[NAV_ARTIFACT_FILES.recastNavmeshBin] = bundle.recastNavmeshBin;
  }
  return entries;
};

/** Compress a {@link NavArtifactBundle} to a zip blob (deflate). */
export const zipNavArtifactBundle = (bundle: NavArtifactBundle): Uint8Array =>
  zipSync(navArtifactZipEntries(bundle), { level: 6 });

/** Trigger a browser download of `nav-artifacts-<slug>.zip`. */
export const downloadNavArtifactZip = ({
  bundle,
  slug = 'scene',
}: {
  readonly bundle: NavArtifactBundle;
  readonly slug?: string;
}): void => {
  const safe = slug.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
  downloadBytes({
    bytes: zipNavArtifactBundle(bundle),
    filename: `nav-artifacts-${safe}.zip`,
    type: 'application/zip',
  });
};

/** Derive a short zip slug from a CDN lod-meta URL or local label. */
export const navArtifactSlugFromSource = (sourceLabel: string | null | undefined): string => {
  if (!sourceLabel) {
    return 'scene';
  }
  try {
    const url = new URL(sourceLabel);
    const parts = url.pathname.split('/').filter(Boolean);
    const hashish = parts.find((p) => /^[a-f0-9]{6,}$/i.test(p));
    if (hashish) {
      return hashish.slice(0, 12);
    }
    const leaf = parts[parts.length - 2] ?? parts[parts.length - 1];
    if (leaf) {
      return leaf.slice(0, 24);
    }
  } catch {
    // not a URL
  }
  const trimmed = sourceLabel.replace(/\.[^.]+$/, '').slice(0, 24);
  return trimmed || 'scene';
};

const parseSessionJson = (text: string): NavSessionArtifactV1 => {
  const raw = JSON.parse(text) as NavSessionArtifactV1;
  if (raw.version !== 1) {
    throw new Error(`Unsupported nav_session.json version: ${String(raw.version)}`);
  }
  if (raw.locomotionMode !== 'voxel_walk' && raw.locomotionMode !== 'recast_crowd') {
    throw new Error(`Unsupported locomotionMode: ${String(raw.locomotionMode)}`);
  }
  if (
    raw.activeNavigationMode !== undefined &&
    raw.activeNavigationMode !== 'recast' &&
    raw.activeNavigationMode !== 'voxel_mesh' &&
    raw.activeNavigationMode !== 'recast_and_voxel_mesh'
  ) {
    throw new Error(
      `Unsupported activeNavigationMode: ${String(raw.activeNavigationMode)}`
    );
  }
  return raw;
};

const parseVolumeMetaJson = (text: string): NavVolumeMetaV1 => {
  const raw = JSON.parse(text) as NavVolumeMetaV1;
  if (raw.format !== NAV_VOLUME_FORMAT) {
    throw new Error(`Unsupported volume.meta.json format: ${String(raw.format)}`);
  }
  if (!raw.dims || raw.dims.length !== 3 || !Number.isFinite(raw.voxel_size)) {
    throw new Error('volume.meta.json missing dims or voxel_size.');
  }
  return raw;
};

const entriesToParsed = (entries: Record<string, Uint8Array>): ParsedNavArtifacts => {
  const byName: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    byName[basenameOf(path)] = bytes;
  }

  const sessionBytes = byName[NAV_ARTIFACT_FILES.navSessionJson];
  if (!sessionBytes) {
    throw new Error('Nav artifacts missing nav_session.json.');
  }
  const session = parseSessionJson(strFromU8(sessionBytes));

  const volumeMetaBytes = byName[NAV_ARTIFACT_FILES.volumeMetaJson];
  const solidBytes = byName[NAV_ARTIFACT_FILES.volumeSolidBin];
  const navRegionBytes = byName[NAV_ARTIFACT_FILES.volumeNavRegionBin];
  const hasVolumeTrio = Boolean(volumeMetaBytes && solidBytes && navRegionBytes);

  const recastBytes = byName[NAV_ARTIFACT_FILES.recastNavmeshBin];
  if (!hasVolumeTrio && !(recastBytes && recastBytes.byteLength > 0)) {
    throw new Error(
      'Nav artifacts need volume.meta.json + volume.solid.bin + volume.nav_region.bin, ' +
        'or recast.navmesh.bin.'
    );
  }

  let volumeMeta: NavVolumeMetaV1 | null = null;
  let volume: CollisionVoxelVolume | null = null;
  if (hasVolumeTrio && volumeMetaBytes && solidBytes && navRegionBytes) {
    volumeMeta = parseVolumeMetaJson(strFromU8(volumeMetaBytes));
    volume = {
      dims: [volumeMeta.dims[0], volumeMeta.dims[1], volumeMeta.dims[2]],
      origin: [volumeMeta.origin[0], volumeMeta.origin[1], volumeMeta.origin[2]],
      voxel_size: volumeMeta.voxel_size,
      solid: solidBytes,
      nav_region: navRegionBytes,
    };
  }

  const bundle: NavArtifactBundle = {
    collisionGlb: byName[NAV_ARTIFACT_FILES.collisionGlb],
    navSessionJson: strFromU8(sessionBytes),
    recastNavmeshBin: recastBytes,
    volumeMetaJson: volumeMetaBytes ? strFromU8(volumeMetaBytes) : undefined,
    volumeNavRegionBin: navRegionBytes,
    volumeSolidBin: solidBytes,
    walkableFloorsGlb: byName[NAV_ARTIFACT_FILES.walkableFloorsGlb],
  };

  return { bundle, session, volume, volumeMeta };
};

/** Parse a nav-artifacts zip into a validated {@link ParsedNavArtifacts}. */
export const parseNavArtifactZip = (bytes: Uint8Array): ParsedNavArtifacts => {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to unzip nav artifacts: ${detail}`);
  }
  return entriesToParsed(entries);
};

const readFileBytes = async (file: File): Promise<Uint8Array> =>
  new Uint8Array(await file.arrayBuffer());

/**
 * Parse one `.zip` **or** multi-select loose contract files into {@link ParsedNavArtifacts}.
 */
export const parseNavArtifactFiles = async (
  files: File[] | FileList
): Promise<ParsedNavArtifacts> => {
  const list = Array.from(files);
  if (list.length === 0) {
    throw new Error('No files selected for nav artifact upload.');
  }

  if (list.length === 1) {
    const only = list[0]!;
    const name = only.name.toLowerCase();
    if (name.endsWith('.zip') || only.type === 'application/zip') {
      return parseNavArtifactZip(await readFileBytes(only));
    }
  }

  const entries: Record<string, Uint8Array> = {};
  for (const file of list) {
    const base = basenameOf(file.name);
    if (base.toLowerCase().endsWith('.zip')) {
      throw new Error(
        'When uploading multiple files, do not include a .zip — upload the zip alone, or only loose members.'
      );
    }
    entries[base] = await readFileBytes(file);
  }
  return entriesToParsed(entries);
};
