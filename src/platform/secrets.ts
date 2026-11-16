// API keys and the ChatGPT sign-in, in IndexedDB on the extension's origin.
// chrome.storage.local would do as a store, but content scripts can read it, and
// its onChanged hands every new value to the content script in every open tab.
// Content scripts run in the page's origin, so they cannot open this database.
const DB = 'secrets';
const STORE = 'secrets';

const settled = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const opened = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function readSecret<T>(name: string, fallback: T): Promise<T> {
  const db = await opened();
  try {
    const found = await settled(db.transaction(STORE).objectStore(STORE).get(name));
    return found === undefined ? fallback : found as T;
  } finally {
    db.close();
  }
}

export async function writeSecret(name: string, value: unknown): Promise<void> {
  const db = await opened();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, name);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
