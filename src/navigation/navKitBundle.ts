/**
 * Build / peek / parse / download Splatwalk NavKit zips (core product).
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { downloadBytes } from '@/collision/voxelBoundary';
import {
  type NavArtifactBundle,
  type ParsedNavArtifacts,
  navArtifactSlugFromSource,
  navArtifactZipEntries,
  parseNavArtifactEntries,
} from '@/navigation/navArtifactBundle';
import type { ActiveNavigationModeArtifact } from '@/navigation/navArtifactContract';
import {
  DEFAULT_NAV_KIT_CONTROLS_MODE_NEW,
  NAV_KIT_CONTROLS_MODES,
  NAV_KIT_FORMAT,
  NAV_KIT_META_FILE,
  NAV_KIT_MODEL_PREFIX,
  NAV_KIT_NAV_PREFIX,
  type NavKitControlsMode,
  type NavKitControlsV1,
  type NavKitMetaV1,
  type NavKitModelExtension,
  type NavKitRegionV1,
  type NavKitVec3V1,
} from '@/navigation/navKitContract';
import type { NavGenerationMode } from '@/navigation/voxelNavSettings';

export interface ParsedNavKit {
  readonly meta: NavKitMetaV1;
  readonly modelBytes: Uint8Array;
  readonly modelFile: File;
  readonly navParsed: ParsedNavArtifacts;
}

export interface BuildNavKitMetaOptions {
  readonly activeNavigationMode: ActiveNavigationModeArtifact;
  readonly camEulerDeg?: NavKitVec3V1 | null;
  readonly camPos?: NavKitVec3V1 | null;
  readonly camTarget?: NavKitVec3V1 | null;
  readonly controlsMode?: NavKitControlsMode;
  readonly locomotionMode: 'recast_crowd' | 'voxel_walk';
  readonly modelFilename: string;
  readonly navTechnique: NavGenerationMode;
  readonly playerEulerDeg?: NavKitVec3V1 | null;
  readonly playerPos?: NavKitVec3V1 | null;
  readonly region?: NavKitRegionV1 | null;
  readonly slug?: string;
  readonly title?: string;
}

export interface BuildNavKitZipOptions {
  readonly meta?: NavKitMetaV1;
  readonly modelBytes: Uint8Array;
  readonly modelFilename: string;
  readonly navBundle: NavArtifactBundle;
  readonly activeNavigationMode?: ActiveNavigationModeArtifact;
  readonly camEulerDeg?: NavKitVec3V1 | null;
  readonly camPos?: NavKitVec3V1 | null;
  readonly camTarget?: NavKitVec3V1 | null;
  readonly controlsMode?: NavKitControlsMode;
  readonly locomotionMode?: 'recast_crowd' | 'voxel_walk';
  readonly navTechnique?: NavGenerationMode;
  readonly playerEulerDeg?: NavKitVec3V1 | null;
  readonly playerPos?: NavKitVec3V1 | null;
  readonly region?: NavKitRegionV1 | null;
  readonly slug?: string;
  readonly title?: string;
}

const MODEL_EXTENSIONS = new Set<NavKitModelExtension>(['ply', 'spz', 'splat']);
const CONTROLS_MODE_SET = new Set<string>(NAV_KIT_CONTROLS_MODES);

const basenameOf = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? path;
};

const sanitizeFilename = (name: string): string => {
  const base = basenameOf(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return base || 'model.ply';
};

const extensionOf = (filename: string): NavKitModelExtension => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.spz')) {
    return 'spz';
  }
  if (lower.endsWith('.splat')) {
    return 'splat';
  }
  if (lower.endsWith('.ply')) {
    return 'ply';
  }
  throw new Error(
    `NavKit model must be .ply, .spz, or .splat (got ${filename}).`
  );
};

const mimeForExtension = (extension: NavKitModelExtension): string => {
  if (extension === 'spz') {
    return 'application/octet-stream';
  }
  if (extension === 'splat') {
    return 'application/octet-stream';
  }
  return 'application/x-ply';
};

const safeSlug = (slug: string): string =>
  slug.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseVec3 = (raw: unknown): NavKitVec3V1 | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (!isFiniteNumber(o.x) || !isFiniteNumber(o.y) || !isFiniteNumber(o.z)) {
    return null;
  }
  return { x: o.x, y: o.y, z: o.z };
};

const parseRegion = (raw: unknown): NavKitRegionV1 | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const min = o.min;
  const max = o.max;
  if (!Array.isArray(min) || !Array.isArray(max) || min.length < 3 || max.length < 3) {
    return null;
  }
  const minT: [number, number, number] = [
    Number(min[0]),
    Number(min[1]),
    Number(min[2]),
  ];
  const maxT: [number, number, number] = [
    Number(max[0]),
    Number(max[1]),
    Number(max[2]),
  ];
  if (
    !minT.every(Number.isFinite) ||
    !maxT.every(Number.isFinite) ||
    minT[0] >= maxT[0] ||
    minT[1] >= maxT[1] ||
    minT[2] >= maxT[2]
  ) {
    return null;
  }
  return { min: minT, max: maxT };
};

const parseControls = (raw: unknown): NavKitControlsV1 | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (typeof mode !== 'string' || !CONTROLS_MODE_SET.has(mode)) {
    return undefined;
  }
  return { mode: mode as NavKitControlsMode };
};

/** Build a validated {@link NavKitMetaV1} envelope. */
export const buildNavKitMeta = (options: BuildNavKitMetaOptions): NavKitMetaV1 => {
  const filename = sanitizeFilename(options.modelFilename);
  const extension = extensionOf(filename);
  const slug = safeSlug(options.slug ?? navArtifactSlugFromSource(filename));
  const controlsMode = options.controlsMode ?? DEFAULT_NAV_KIT_CONTROLS_MODE_NEW;
  return {
    camEulerDeg: options.camEulerDeg ?? null,
    camPos: options.camPos ?? null,
    camTarget: options.camTarget ?? null,
    controls: { mode: controlsMode },
    createdAt: new Date().toISOString(),
    defaultActiveNavigationMode: options.activeNavigationMode,
    defaultLocomotionMode: options.locomotionMode,
    defaultNavTechnique: options.navTechnique,
    format: NAV_KIT_FORMAT,
    model: {
      extension,
      filename,
      path: `${NAV_KIT_MODEL_PREFIX}${filename}`,
    },
    navPrefix: NAV_KIT_NAV_PREFIX,
    playerEulerDeg: options.playerEulerDeg ?? null,
    playerPos: options.playerPos ?? null,
    region: options.region ?? null,
    slug,
    title: options.title ?? slug,
    version: 1,
  };
};

const parseNavKitMetaJson = (text: string): NavKitMetaV1 => {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.format !== NAV_KIT_FORMAT) {
    throw new Error(`Unsupported meta-nav.json format: ${String(raw.format)}`);
  }
  if (raw.version !== 1) {
    throw new Error(`Unsupported meta-nav.json version: ${String(raw.version)}`);
  }
  const model = raw.model as NavKitMetaV1['model'] | undefined;
  if (!model?.path || !model.filename || !model.extension) {
    throw new Error('meta-nav.json missing model.path / filename / extension.');
  }
  if (!MODEL_EXTENSIONS.has(model.extension)) {
    throw new Error(`Unsupported model extension: ${String(model.extension)}`);
  }
  if (
    raw.defaultNavTechnique !== 'floor_field' &&
    raw.defaultNavTechnique !== 'voxel_collision' &&
    raw.defaultNavTechnique !== 'sdf_marching_cubes'
  ) {
    throw new Error(
      `Unsupported defaultNavTechnique: ${String(raw.defaultNavTechnique)}`
    );
  }
  if (
    raw.defaultActiveNavigationMode !== 'recast' &&
    raw.defaultActiveNavigationMode !== 'voxel_mesh' &&
    raw.defaultActiveNavigationMode !== 'recast_and_voxel_mesh'
  ) {
    throw new Error(
      `Unsupported defaultActiveNavigationMode: ${String(raw.defaultActiveNavigationMode)}`
    );
  }
  if (
    raw.defaultLocomotionMode !== 'recast_crowd' &&
    raw.defaultLocomotionMode !== 'voxel_walk'
  ) {
    throw new Error(
      `Unsupported defaultLocomotionMode: ${String(raw.defaultLocomotionMode)}`
    );
  }
  if (raw.navPrefix !== NAV_KIT_NAV_PREFIX) {
    throw new Error(`Unsupported navPrefix: ${String(raw.navPrefix)}`);
  }
  const controls =
    parseControls(raw.controls) ?? { mode: DEFAULT_NAV_KIT_CONTROLS_MODE_NEW };
  return {
    camEulerDeg: parseVec3(raw.camEulerDeg),
    camPos: parseVec3(raw.camPos),
    camTarget: parseVec3(raw.camTarget),
    controls,
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    defaultActiveNavigationMode: raw.defaultActiveNavigationMode as NavKitMetaV1['defaultActiveNavigationMode'],
    defaultLocomotionMode: raw.defaultLocomotionMode as NavKitMetaV1['defaultLocomotionMode'],
    defaultNavTechnique: raw.defaultNavTechnique as NavKitMetaV1['defaultNavTechnique'],
    format: NAV_KIT_FORMAT,
    model,
    navPrefix: NAV_KIT_NAV_PREFIX,
    playerEulerDeg: parseVec3(raw.playerEulerDeg),
    playerPos: parseVec3(raw.playerPos),
    region: parseRegion(raw.region),
    slug: String(raw.slug ?? 'scene'),
    title: String(raw.title ?? raw.slug ?? 'scene'),
    version: 1,
  };
};

/** Unzip bytes (throws a clear error on failure). */
const unzipEntries = (bytes: Uint8Array): Record<string, Uint8Array> => {
  try {
    return unzipSync(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to unzip NavKit: ${detail}`);
  }
};

/** True when zip bytes contain a valid NavKit `meta-nav.json`. */
export const isNavKitZipBytes = (bytes: Uint8Array): boolean => {
  try {
    const entries = unzipEntries(bytes);
    const metaBytes = entries[NAV_KIT_META_FILE];
    if (!metaBytes) {
      return false;
    }
    parseNavKitMetaJson(strFromU8(metaBytes));
    return true;
  } catch {
    return false;
  }
};

/** Peek and validate `meta-nav.json` from zip bytes (throws if invalid). */
export const peekNavKitMetaFromBytes = (bytes: Uint8Array): NavKitMetaV1 => {
  const entries = unzipEntries(bytes);
  const metaBytes = entries[NAV_KIT_META_FILE];
  if (!metaBytes) {
    throw new Error(`NavKit missing ${NAV_KIT_META_FILE}.`);
  }
  return parseNavKitMetaJson(strFromU8(metaBytes));
};

/** Peek meta from a File; returns null when not a NavKit zip. */
export const peekNavKitMeta = async (file: File): Promise<NavKitMetaV1 | null> => {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.zip') && file.type !== 'application/zip') {
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isNavKitZipBytes(bytes)) {
    return null;
  }
  return peekNavKitMetaFromBytes(bytes);
};

/** Build zip member map for a NavKit pack. */
export const navKitZipEntries = (options: {
  readonly meta: NavKitMetaV1;
  readonly modelBytes: Uint8Array;
  readonly navBundle: NavArtifactBundle;
}): Record<string, Uint8Array> => {
  const entries: Record<string, Uint8Array> = {
    [NAV_KIT_META_FILE]: strToU8(`${JSON.stringify(options.meta, null, 2)}\n`),
    [options.meta.model.path]: options.modelBytes,
  };
  for (const [name, bytes] of Object.entries(navArtifactZipEntries(options.navBundle))) {
    entries[`${NAV_KIT_NAV_PREFIX}${name}`] = bytes;
  }
  return entries;
};

/** Compress a NavKit pack to zip bytes. */
export const zipNavKit = (options: {
  readonly meta: NavKitMetaV1;
  readonly modelBytes: Uint8Array;
  readonly navBundle: NavArtifactBundle;
}): Uint8Array => zipSync(navKitZipEntries(options), { level: 6 });

const metaFromZipOptions = (options: BuildNavKitZipOptions): NavKitMetaV1 =>
  options.meta ??
  buildNavKitMeta({
    activeNavigationMode: options.activeNavigationMode ?? 'recast',
    camEulerDeg: options.camEulerDeg,
    camPos: options.camPos,
    camTarget: options.camTarget,
    controlsMode: options.controlsMode,
    locomotionMode: options.locomotionMode ?? 'recast_crowd',
    modelFilename: options.modelFilename,
    navTechnique: options.navTechnique ?? 'floor_field',
    playerEulerDeg: options.playerEulerDeg,
    playerPos: options.playerPos,
    region: options.region,
    slug: options.slug,
    title: options.title,
  });

/** Build NavKit zip bytes from model + nav artifact bundle (+ optional meta overrides). */
export const buildNavKitZip = (options: BuildNavKitZipOptions): Uint8Array => {
  if (!options.modelBytes.byteLength) {
    throw new Error('NavKit requires non-empty model bytes.');
  }
  const meta = metaFromZipOptions(options);
  return zipNavKit({
    meta,
    modelBytes: options.modelBytes,
    navBundle: options.navBundle,
  });
};

/** Trigger a browser download of `navkit-<slug>.zip`. */
export const downloadNavKitZip = (options: BuildNavKitZipOptions): void => {
  const meta = metaFromZipOptions(options);
  const bytes = zipNavKit({
    meta,
    modelBytes: options.modelBytes,
    navBundle: options.navBundle,
  });
  downloadBytes({
    bytes,
    filename: `navkit-${safeSlug(meta.slug)}.zip`,
    type: 'application/zip',
  });
};

/** Parse a NavKit zip into meta, model File, and nested nav artifacts. */
export const parseNavKitZip = (bytes: Uint8Array): ParsedNavKit => {
  const entries = unzipEntries(bytes);
  const metaBytes = entries[NAV_KIT_META_FILE];
  if (!metaBytes) {
    throw new Error(`NavKit missing ${NAV_KIT_META_FILE}.`);
  }
  const meta = parseNavKitMetaJson(strFromU8(metaBytes));
  const modelPath = meta.model.path.replace(/\\/g, '/');
  let modelBytes = entries[modelPath];
  if (!modelBytes) {
    const alt = `${NAV_KIT_MODEL_PREFIX}${meta.model.filename}`;
    modelBytes = entries[alt];
  }
  if (!modelBytes || modelBytes.byteLength === 0) {
    throw new Error(`NavKit missing model member at ${meta.model.path}.`);
  }
  const navParsed = parseNavArtifactEntries(entries, {
    preferPrefix: meta.navPrefix,
  });
  const modelFile = new File([modelBytes as BlobPart], meta.model.filename, {
    type: mimeForExtension(meta.model.extension),
  });
  return { meta, modelBytes, modelFile, navParsed };
};

/** Parse a NavKit `.zip` File. */
export const parseNavKitFile = async (file: File): Promise<ParsedNavKit> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseNavKitZip(bytes);
};
