/**
 * Minimal, dependency-free store-only (no compression) ZIP writer.
 *
 * SOG bundles are already WebP-compressed, so storing them uncompressed keeps
 * the writer tiny and fast while producing a standard `.zip` any tool can open.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS time/date stamp for a fixed, reproducible epoch (1980-01-01 00:00). */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

interface PreparedEntry {
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly offset: number;
}

/**
 * Build a store-only ZIP archive from a path-keyed map of file bytes.
 * @param files bundle files keyed by their archive-relative path
 * @returns the complete `.zip` as a single byte buffer
 */
export function zipStore(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const entries: PreparedEntry[] = [];

  let localSize = 0;
  for (const [name, data] of files) {
    const nameBytes = encoder.encode(name);
    // 30-byte local header + name + data.
    localSize += 30 + nameBytes.length + data.length;
  }

  let centralSize = 0;
  for (const [name] of files) {
    centralSize += 46 + encoder.encode(name).length;
  }

  const total = localSize + centralSize + 22; // + end-of-central-directory
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const [name, data] of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    entries.push({ nameBytes, data, crc, offset });

    view.setUint32(offset, 0x04034b50, true); // local file header signature
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0, true); // flags
    view.setUint16(offset + 8, 0, true); // method: store
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, crc, true);
    view.setUint32(offset + 18, data.length, true); // compressed size
    view.setUint32(offset + 22, data.length, true); // uncompressed size
    view.setUint16(offset + 26, nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra length
    offset += 30;
    out.set(nameBytes, offset);
    offset += nameBytes.length;
    out.set(data, offset);
    offset += data.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    view.setUint32(offset, 0x02014b50, true); // central directory signature
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0, true); // flags
    view.setUint16(offset + 10, 0, true); // method: store
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra length
    view.setUint16(offset + 32, 0, true); // comment length
    view.setUint16(offset + 34, 0, true); // disk number
    view.setUint16(offset + 36, 0, true); // internal attrs
    view.setUint32(offset + 38, 0, true); // external attrs
    view.setUint32(offset + 42, entry.offset, true); // local header offset
    offset += 46;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  const centralLength = offset - centralStart;
  view.setUint32(offset, 0x06054b50, true); // end of central directory
  view.setUint16(offset + 4, 0, true); // disk number
  view.setUint16(offset + 6, 0, true); // central dir disk
  view.setUint16(offset + 8, entries.length, true); // entries on disk
  view.setUint16(offset + 10, entries.length, true); // total entries
  view.setUint32(offset + 12, centralLength, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true); // comment length

  return out;
}
