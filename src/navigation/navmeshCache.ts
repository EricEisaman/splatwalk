/**
 * Persistent, content-and-settings-addressed cache of the FAST NAV navmesh
 * artifact.
 *
 * The FAST NAV pipeline (`fetch -> WASM parse+prune -> walkable ground field ->
 * floor mesh -> Recast navmesh`) is expensive, and its final product — the
 * serialized Recast navmesh plus the debug overlay geometry — is fully
 * reproducible from the splat bytes and the settings that produced it. So when a
 * user revisits a splat without changing any parameters, we can skip the entire
 * computation and restore the navmesh directly.
 *
 * Storage is IndexedDB (survives reloads and route changes, unlike the in-WASM
 * `thread_local` prune cache and unlike localStorage which is far too small for
 * binary blobs). Entries are evicted LRU-style against a byte budget derived from
 * {@link https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory
 * navigator.deviceMemory}.
 *
 * Every operation is defensive: any IndexedDB failure (private mode, quota,
 * unsupported environment) degrades silently to "no cache" so the caller simply
 * recomputes. The cache is never allowed to throw into the pipeline.
 */

const DB_NAME = 'splatwalk-navcache';
const DB_VERSION = 1;
/** Small per-entry metadata, kept separate from the (large) payload blobs. */
const INDEX_STORE = 'index';
/** The cached navmesh payload, keyed identically to its index record. */
const DATA_STORE = 'data';

/** The navmesh artifact restored from / stored into the cache. */
export interface CachedNavmesh {
  readonly navMeshData: Uint8Array;
  readonly debugPositions: Float32Array;
  readonly debugIndices: Uint32Array;
  /**
   * FAST NAV replay metadata. The seed and expected floor height are cheap
   * scalars computed during the (skipped) pipeline, so we persist them to
   * reproduce the exact spawn/validation tail on a cache hit. Optional so the
   * generic navmesh consumers can store/restore without them.
   */
  readonly effectiveSeed?: number[] | null;
  readonly expectedFloorY?: number | null;
}

interface IndexRecord {
  key: string;
  bytes: number;
  lastAccess: number;
  createdAt: number;
}

interface DataRecord {
  key: string;
  navMeshData: ArrayBuffer;
  debugPositions: ArrayBuffer;
  debugIndices: ArrayBuffer;
  effectiveSeed: number[] | null;
  expectedFloorY: number | null;
}

const MiB = 1024 * 1024;
const MIN_BUDGET_BYTES = 50 * MiB;
const MAX_BUDGET_BYTES = 500 * MiB;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/**
 * Byte budget for the cache. `navigator.deviceMemory` is an approximate RAM size
 * in GiB (coarsened to a power of two for privacy, and absent on some browsers).
 * We dedicate an eighth of it to the navmesh cache, clamped to a sane window so
 * low-memory devices are not starved and high-memory devices do not hoard.
 */
function cacheBudgetBytes(): number {
  const deviceMemoryGiB =
    typeof navigator !== 'undefined' && typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory!
      : 4;
  return clamp(Math.round((deviceMemoryGiB * 1024 ** 3) / 8), MIN_BUDGET_BYTES, MAX_BUDGET_BYTES);
}

// ---------------------------------------------------------------------------
// Hashing / key derivation
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a over the byte length plus a strided sample of the bytes (~4096 samples).
 * Mirrors the Rust `fingerprint` in `wasm-splatwalk/src/lib.rs`: full hashing of
 * tens of MB on every visit would itself be costly, and a sampled hash is more
 * than enough to recognise "same file".
 */
function contentHash(bytes: Uint8Array): string {
  let hash = (FNV_OFFSET ^ BigInt(bytes.length)) & U64_MASK;
  const stride = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += stride) {
    hash = ((hash ^ BigInt(bytes[i])) * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16);
}

/** FNV-1a over a string (the JSON-serialized settings signature). */
function stringHash(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i) & 0xff)) * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16);
}

/**
 * Build the cache key from the splat bytes and a signature of everything that
 * affects the resulting navmesh (mesh/field settings, recovery + trim options,
 * and the Recast attempt ladder). `signature` is JSON-serialized, so pass plain
 * data. The seed and orientation are deterministic functions of the bytes plus
 * these settings, so they need not be included explicitly.
 */
export function buildNavmeshKey(bytes: Uint8Array, signature: unknown): string {
  return `${contentHash(bytes)}:${stringHash(JSON.stringify(signature))}`;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(INDEX_STORE)) {
          db.createObjectStore(INDEX_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(DATA_STORE)) {
          db.createObjectStore(DATA_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => resolve(null);
      request.onblocked = (): void => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onabort = (): void => reject(tx.error);
    tx.onerror = (): void => reject(tx.error);
  });
}

/** Copy a typed array into a standalone ArrayBuffer sized exactly to its view. */
function toExactBuffer(view: ArrayBufferView): ArrayBuffer {
  // `ArrayBufferView.buffer` is `ArrayBufferLike` (could be a SharedArrayBuffer in
  // the type system); navmesh buffers are always plain ArrayBuffers, so copy into
  // a fresh one to satisfy the structured-clone storage type.
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

// ---------------------------------------------------------------------------
// Public cache API
// ---------------------------------------------------------------------------

/**
 * Look up a cached navmesh. Returns `null` on a miss or any storage failure. On a
 * hit, the entry's `lastAccess` is bumped (best-effort) for LRU eviction, and
 * fresh typed-array views over copied buffers are returned.
 */
export async function getNavmesh(key: string): Promise<CachedNavmesh | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(DATA_STORE, 'readonly');
    const record = await promisifyRequest<DataRecord | undefined>(tx.objectStore(DATA_STORE).get(key));
    if (!record) {
      db.close();
      return null;
    }
    // Best-effort LRU touch in a separate transaction; failure is non-fatal.
    void touchEntry(db, key).catch(() => undefined);
    const result: CachedNavmesh = {
      navMeshData: new Uint8Array(record.navMeshData),
      debugPositions: new Float32Array(record.debugPositions),
      debugIndices: new Uint32Array(record.debugIndices),
      effectiveSeed: record.effectiveSeed ?? null,
      expectedFloorY: record.expectedFloorY ?? null,
    };
    return result;
  } catch {
    return null;
  } finally {
    // `db.close()` is safe to call after the transaction has been created.
    try {
      db.close();
    } catch {
      /* already closing */
    }
  }
}

async function touchEntry(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction(INDEX_STORE, 'readwrite');
  const store = tx.objectStore(INDEX_STORE);
  const record = await promisifyRequest<IndexRecord | undefined>(store.get(key));
  if (record) {
    record.lastAccess = Date.now();
    store.put(record);
  }
  await txDone(tx);
}

/**
 * Store a navmesh artifact, then evict LRU entries until the total fits the
 * device-memory budget. Any storage failure is swallowed (the caller already has
 * the freshly computed result).
 */
export async function putNavmesh(key: string, payload: CachedNavmesh): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const navMeshData = toExactBuffer(payload.navMeshData);
    const debugPositions = toExactBuffer(payload.debugPositions);
    const debugIndices = toExactBuffer(payload.debugIndices);
    const bytes = navMeshData.byteLength + debugPositions.byteLength + debugIndices.byteLength;
    const now = Date.now();

    const tx = db.transaction([INDEX_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(DATA_STORE).put({
      key,
      navMeshData,
      debugPositions,
      debugIndices,
      effectiveSeed: payload.effectiveSeed ?? null,
      expectedFloorY: payload.expectedFloorY ?? null,
    } satisfies DataRecord);
    tx.objectStore(INDEX_STORE).put({ key, bytes, lastAccess: now, createdAt: now } satisfies IndexRecord);
    await txDone(tx);

    await evictToBudget(db);
  } catch {
    /* degrade to no-cache */
  } finally {
    try {
      db.close();
    } catch {
      /* already closing */
    }
  }
}

/** Delete oldest-accessed entries until the cached total is within budget. */
async function evictToBudget(db: IDBDatabase): Promise<void> {
  const budget = cacheBudgetBytes();
  const tx = db.transaction(INDEX_STORE, 'readonly');
  const records = await promisifyRequest<IndexRecord[]>(tx.objectStore(INDEX_STORE).getAll());
  await txDone(tx).catch(() => undefined);

  let total = records.reduce((sum, r) => sum + r.bytes, 0);
  if (total <= budget) return;

  const oldestFirst = [...records].sort((a, b) => a.lastAccess - b.lastAccess);
  const evictTx = db.transaction([INDEX_STORE, DATA_STORE], 'readwrite');
  const indexStore = evictTx.objectStore(INDEX_STORE);
  const dataStore = evictTx.objectStore(DATA_STORE);
  for (const record of oldestFirst) {
    if (total <= budget) break;
    indexStore.delete(record.key);
    dataStore.delete(record.key);
    total -= record.bytes;
  }
  await txDone(evictTx);
}

/** Remove every cached navmesh (e.g. for a manual reset). Best-effort. */
export async function clearNavmeshCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([INDEX_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(DATA_STORE).clear();
    await txDone(tx);
  } catch {
    /* ignore */
  } finally {
    try {
      db.close();
    } catch {
      /* already closing */
    }
  }
}
