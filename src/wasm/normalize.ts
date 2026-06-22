import { splatwalk } from './bridge';

/** Lowercased file extensions accepted by the splat ingest seam. */
export const SUPPORTED_SPLAT_EXTENSIONS = ['.ply', '.spz', '.splat'] as const;

/** True when `name` ends with a supported splat extension (case-insensitive). */
export function isSupportedSplatFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_SPLAT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Normalize any supported splat file to full-fidelity binary 3DGS `.ply` bytes,
 * so the rest of the app (Babylon viewer + WASM nav pipeline) only ever deals
 * with PLY. This is the single ingest seam:
 *
 * - `.ply`   -> returned unchanged.
 * - `.spz`   -> gunzipped in-browser (`DecompressionStream`) then converted via WASM.
 * - `.splat` -> converted via WASM (antimatter15 fixed 32-byte records).
 *
 * `.spz` / `.splat` require the WASM core to be initialized.
 */
export async function normalizeSplatToPly(file: File): Promise<Uint8Array> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.spz')) {
    if (!('DecompressionStream' in globalThis)) {
      throw new Error('Browser does not support DecompressionStream; cannot read .spz files.');
    }
    const ds = new DecompressionStream('gzip');
    const stream = file.stream().pipeThrough(ds);
    const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return splatwalk.spzToPly(decompressed);
  }

  if (name.endsWith('.splat')) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return splatwalk.splatToPly(bytes);
  }

  return new Uint8Array(await file.arrayBuffer());
}
