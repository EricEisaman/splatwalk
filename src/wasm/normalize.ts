import { splatwalk } from './bridge';

/** Lowercased file extensions accepted by the splat ingest seam. */
export const SUPPORTED_SPLAT_EXTENSIONS = ['.ply', '.spz', '.splat'] as const;

/** True when `name` ends with a supported splat extension (case-insensitive). */
export function isSupportedSplatFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_SPLAT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const isGzipMagic = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

const isPlyAsciiMagic = (bytes: Uint8Array): boolean => {
  if (bytes.byteLength < 3) {
    return false;
  }
  return (
    bytes[0] === 0x70 && // p
    bytes[1] === 0x6c && // l
    bytes[2] === 0x79 // y
  );
};

/**
 * Infer splat container from filename + magic bytes.
 * NavKits occasionally mislabel gzip `.spz` payloads as `.ply` after a recompute
 * renamed the model filename — content sniffing keeps restore hosts consistent.
 */
export type SplatContainerKind = 'ply' | 'spz' | 'splat' | 'unknown';

export const detectSplatContainerKind = (
  bytes: Uint8Array,
  filenameHint?: string
): SplatContainerKind => {
  const name = (filenameHint ?? '').toLowerCase();
  if (isGzipMagic(bytes) || name.endsWith('.spz')) {
    return 'spz';
  }
  if (isPlyAsciiMagic(bytes) || name.endsWith('.ply')) {
    return 'ply';
  }
  if (name.endsWith('.splat')) {
    return 'splat';
  }
  return 'unknown';
};

/**
 * Align a NavKit model filename with payload magic (e.g. gzip → `.spz`).
 */
export const reconcileSplatModelFilename = (
  bytes: Uint8Array,
  filename: string
): string => {
  const kind = detectSplatContainerKind(bytes, filename);
  const base = filename.replace(/\.(ply|spz|splat)$/i, '') || 'model';
  if (kind === 'spz') {
    return `${base}.spz`;
  }
  if (kind === 'splat') {
    return `${base}.splat`;
  }
  if (kind === 'ply') {
    return `${base}.ply`;
  }
  return filename;
};

const gunzipToUint8Array = async (bytes: Uint8Array): Promise<Uint8Array> => {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('Browser does not support DecompressionStream; cannot read .spz files.');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes.slice() as BlobPart])
    .stream()
    .pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Normalize raw splat bytes to full-fidelity binary 3DGS `.ply`.
 * Sniffs gzip / `ply` magic so mislabeled NavKit members still convert.
 */
export async function normalizeSplatBytesToPly(
  bytes: Uint8Array,
  filenameHint?: string
): Promise<Uint8Array> {
  const kind = detectSplatContainerKind(bytes, filenameHint);
  if (kind === 'spz') {
    const decompressed = await gunzipToUint8Array(bytes);
    return splatwalk.spzToPly(decompressed);
  }
  if (kind === 'splat') {
    return splatwalk.splatToPly(bytes);
  }
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Normalize any supported splat file to full-fidelity binary 3DGS `.ply` bytes,
 * so the rest of the app (Babylon viewer + WASM nav pipeline) only ever deals
 * with PLY. This is the single ingest seam:
 *
 * - `.ply`   -> returned unchanged (unless magic is gzip → treat as `.spz`).
 * - `.spz`   -> gunzipped in-browser (`DecompressionStream`) then converted via WASM.
 * - `.splat` -> converted via WASM (antimatter15 fixed 32-byte records).
 *
 * `.spz` / `.splat` require the WASM core to be initialized.
 */
export async function normalizeSplatToPly(file: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return normalizeSplatBytesToPly(bytes, file.name);
}
