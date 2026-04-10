/**
 * IndexedDB-backed store for the developer's ML-KEM-768 keypair.
 *
 * The private key never leaves the client. We persist it in IndexedDB so it
 * survives a page reload without going through sessionStorage (which is
 * capped in size and readable by any script on the origin — IndexedDB is
 * also same-origin but is structured binary storage and avoids string
 * marshalling of ~2.4 KB secret keys).
 *
 * Schema: database 'pqdb', object store 'keypairs', keyed by developer id.
 * Stored records hold raw Uint8Array publicKey and secretKey bytes.
 */

const DB_NAME = "pqdb";
const DB_VERSION = 1;
const STORE_NAME = "keypairs";

export interface StoredKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

interface KeypairRecord {
  developerId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "developerId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export async function saveKeypair(
  developerId: string,
  keypair: StoredKeypair,
): Promise<void> {
  const record: KeypairRecord = {
    developerId,
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
  };
  await runTx("readwrite", (store) => store.put(record));
}

export async function loadKeypair(
  developerId: string,
): Promise<StoredKeypair | null> {
  const record = await runTx<KeypairRecord | undefined>("readonly", (store) =>
    store.get(developerId) as IDBRequest<KeypairRecord | undefined>,
  );
  if (!record) return null;
  // Normalize to a Uint8Array owned by this realm — structured-clone results
  // from IndexedDB can come back as a foreign-realm Uint8Array view, which
  // trips `instanceof Uint8Array` and deep-equality in tests.
  return {
    publicKey: new Uint8Array(record.publicKey),
    secretKey: new Uint8Array(record.secretKey),
  };
}

export async function deleteKeypair(developerId: string): Promise<void> {
  await runTx("readwrite", (store) => store.delete(developerId));
}
