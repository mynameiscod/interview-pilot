/**
 * Where recorded segments wait until the server has them. IndexedDB keeps
 * them across a reload or a crash, so the upload queue can resume; browsers
 * without it (or with storage blocked) fall back to memory, which still
 * survives reconnects within the page.
 */

export interface StoredSegment {
  sessionId: string;
  idx: number;
  blob: Blob;
  /** The container without codecs (the upload's Content-Type). */
  contentType: string;
}

export interface RecordingMeta {
  sessionId: string;
  /** The next segment index: also the number of segments produced so far. */
  nextIdx: number;
  /** Time recorded so far, across page loads. */
  durationMs: number;
  /** Recording has ended: finalize once every segment is uploaded. */
  ended: boolean;
}

export interface SegmentStore {
  putSegment(segment: StoredSegment): Promise<void>;
  deleteSegment(sessionId: string, idx: number): Promise<void>;
  /** A session's stored segments, lowest index first. */
  segments(sessionId: string): Promise<StoredSegment[]>;
  getMeta(sessionId: string): Promise<RecordingMeta | null>;
  putMeta(meta: RecordingMeta): Promise<void>;
  /** Forgets a session's segments and meta (finalized, or uploads closed). */
  clear(sessionId: string): Promise<void>;
}

export function createMemorySegmentStore(): SegmentStore {
  const segments = new Map<string, StoredSegment>();
  const metas = new Map<string, RecordingMeta>();
  const key = (sessionId: string, idx: number) => `${sessionId}:${idx}`;
  return {
    async putSegment(segment) {
      segments.set(key(segment.sessionId, segment.idx), segment);
    },
    async deleteSegment(sessionId, idx) {
      segments.delete(key(sessionId, idx));
    },
    async segments(sessionId) {
      return [...segments.values()]
        .filter((s) => s.sessionId === sessionId)
        .sort((a, b) => a.idx - b.idx);
    },
    async getMeta(sessionId) {
      const meta = metas.get(sessionId);
      return meta ? { ...meta } : null;
    },
    async putMeta(meta) {
      metas.set(meta.sessionId, { ...meta });
    },
    async clear(sessionId) {
      for (const [k, s] of segments) if (s.sessionId === sessionId) segments.delete(k);
      metas.delete(sessionId);
    },
  };
}

const DB_NAME = 'cbi-recordings';
const DB_VERSION = 1;
const SEGMENTS = 'segments';
const META = 'meta';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SEGMENTS)) {
        const store = db.createObjectStore(SEGMENTS, { keyPath: ['sessionId', 'idx'] });
        store.createIndex('bySession', 'sessionId');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'sessionId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

/** IndexedDB-backed store; any failure to open it falls back to memory for this page. */
export function createIndexedDbSegmentStore(factory: IDBFactory): SegmentStore {
  const memory = createMemorySegmentStore();
  let db: Promise<IDBDatabase | null> | null = null;
  const database = () => (db ??= openDb(factory).catch(() => null));

  async function run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const conn = await database();
    if (!conn) return fallback();
    try {
      const tx = conn.transaction(stores, mode);
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
      });
      const result = await fn(tx);
      await done;
      return result;
    } catch {
      // Quota exceeded or storage cleared: keep going in memory.
      return fallback();
    }
  }

  return {
    putSegment: (segment) =>
      run(
        [SEGMENTS],
        'readwrite',
        async (tx) => void (await request(tx.objectStore(SEGMENTS).put(segment))),
        () => memory.putSegment(segment),
      ),
    deleteSegment: (sessionId, idx) =>
      run(
        [SEGMENTS],
        'readwrite',
        async (tx) => void (await request(tx.objectStore(SEGMENTS).delete([sessionId, idx]))),
        () => memory.deleteSegment(sessionId, idx),
      ),
    segments: (sessionId) =>
      run(
        [SEGMENTS],
        'readonly',
        async (tx) => {
          const rows = await request<StoredSegment[]>(
            tx.objectStore(SEGMENTS).index('bySession').getAll(sessionId),
          );
          return rows.sort((a, b) => a.idx - b.idx);
        },
        () => memory.segments(sessionId),
      ),
    getMeta: (sessionId) =>
      run(
        [META],
        'readonly',
        async (tx) =>
          ((await request(tx.objectStore(META).get(sessionId))) as RecordingMeta | undefined) ??
          null,
        () => memory.getMeta(sessionId),
      ),
    putMeta: (meta) =>
      run(
        [META],
        'readwrite',
        async (tx) => void (await request(tx.objectStore(META).put(meta))),
        () => memory.putMeta(meta),
      ),
    clear: (sessionId) =>
      run(
        [SEGMENTS, META],
        'readwrite',
        async (tx) => {
          const segments = tx.objectStore(SEGMENTS);
          const keys = await request(segments.index('bySession').getAllKeys(sessionId));
          await Promise.all(keys.map((k) => request(segments.delete(k))));
          await request(tx.objectStore(META).delete(sessionId));
        },
        () => memory.clear(sessionId),
      ),
  };
}

let shared: SegmentStore | null = null;
let override: SegmentStore | null = null;

/** The page's segment store: IndexedDB when the browser has it, memory otherwise. */
export function defaultSegmentStore(): SegmentStore {
  if (override) return override;
  shared ??=
    typeof indexedDB !== 'undefined' && indexedDB
      ? createIndexedDbSegmentStore(indexedDB)
      : createMemorySegmentStore();
  return shared;
}

/** Tests: use this store instead (null restores the default). */
export function setSegmentStoreForTests(store: SegmentStore | null) {
  override = store;
}
