// The device that renders an export already holds the finished MP4. Sharing
// it was fetching the whole file back from the server over the same
// connection that had just uploaded it -- minutes of "Preparing MP4" on a
// phone for bytes that never needed to move.
//
// Keeping it in a plain Map fixed that only until the page reloaded, which is
// why sharing an export from an earlier session was still slow. IndexedDB
// holds Blobs on disk rather than in memory, so an export made on this device
// stays instant to share for as long as it's kept.
const DB_NAME = "frame-exports";
const STORE = "blobs";
// Three is enough that the last few exports stay instant without a session
// parking hundreds of megabytes on someone's phone indefinitely.
const KEEP = 3;

// Same-session fast path, so a share right after an export doesn't wait on a
// database round trip at all.
const memory = new Map<string, Blob>();

function openDb() {
  return new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "id" }).createIndex(
          "savedAt",
          "savedAt",
        );
    };
    request.onsuccess = () => resolve(request.result);
    // Private windows, blocked site data and quota refusals all land here.
    // None of them are worth failing a share over: the fetch still works.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function rememberExport(id: string, blob: Blob) {
  memory.set(id, blob);
  const db = await openDb();
  if (!db) return;
  try {
    tx(db, "readwrite").put({ id, blob, savedAt: Date.now() });
    // Trim on write rather than on a timer: the only moment the store can
    // grow is right here.
    const store = tx(db, "readwrite");
    const keys = store.index("savedAt").getAllKeys();
    keys.onsuccess = () => {
      const stale = keys.result.slice(0, Math.max(0, keys.result.length - KEEP));
      for (const key of stale) store.delete(key);
    };
  } catch {
    // Out of quota, or the store vanished. The server copy still exists.
  }
}

// Synchronous on purpose: navigator.share() has to be called inside the tap
// that asked for it, so the share button needs an answer with no await in
// between. Anything pre-warmed below is already here.
export function rememberedExportSync(id: string) {
  return memory.get(id) ?? null;
}
export async function rememberedExport(id: string) {
  const cached = memory.get(id);
  if (cached) return cached;
  const db = await openDb();
  if (!db) return null;
  return new Promise<Blob | null>((resolve) => {
    try {
      const request = tx(db, "readonly").get(id);
      request.onsuccess = () => {
        const blob = request.result?.blob ?? null;
        if (blob) memory.set(id, blob);
        resolve(blob);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function forgetExport(id: string) {
  memory.delete(id);
  const db = await openDb();
  if (!db) return;
  try {
    tx(db, "readwrite").delete(id);
  } catch {
    // Nothing to do -- it expires out of the store on its own.
  }
}
