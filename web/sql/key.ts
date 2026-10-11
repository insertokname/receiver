// SPDX-License-Identifier: AGPL-3.0-only
//
// The database key, in place of Electron's safeStorage (app/main.main.ts
// getSQLKey): 32 random bytes, kept in IndexedDB encrypted (AES-GCM) with a
// non-extractable WebCrypto key stored next to it. Script can use the
// wrapping key but never read it; the raw database key only exists in this
// worker's memory. Never logged.

const DB_NAME = 'receiver-sql-key';
const STORE = 'keys';
const RECORD = 'database';
const AAD = new TextEncoder().encode('receiver: SQLCipher database key, v1');

type KeyRecord = {
  version: 1;
  wrappingKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  wrapped: ArrayBuffer;
};

export class DatabaseKeyError extends Error {
  override name = 'DatabaseKeyError';
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openVersion(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(
        new DatabaseKeyError(
          `cannot open the key store (IndexedDB): ${req.error?.name ?? 'unknown error'}`
        )
      );
    req.onblocked = () =>
      reject(new DatabaseKeyError('the key store (IndexedDB) is blocked by another tab'));
  });
}

async function openKeyStore(): Promise<IDBDatabase> {
  const db = await openVersion();
  if (db.objectStoreNames.contains(STORE)) {
    return db;
  }
  // Created without the store (e.g. opened elsewhere before first use).
  const version = db.version + 1;
  db.close();
  return openVersion(version);
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openKeyStore();
  try {
    const tx = db.transaction(STORE, mode, { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    const result = await fn(tx.objectStore(STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** The stored key (hex), or undefined if there is none. */
export async function loadKey(): Promise<string | undefined> {
  const record = await withStore('readonly', store =>
    request(store.get(RECORD) as IDBRequest<KeyRecord | undefined>)
  );
  if (record === undefined) {
    return undefined;
  }
  if (record.version !== 1 || !(record.wrappingKey instanceof CryptoKey)) {
    throw new DatabaseKeyError('the stored database key has an unknown format');
  }
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: AAD },
      record.wrappingKey,
      record.wrapped
    );
  } catch {
    throw new DatabaseKeyError('the stored database key cannot be decrypted');
  }
  if (raw.byteLength !== 32) {
    throw new DatabaseKeyError('the stored database key has the wrong length');
  }
  return toHex(new Uint8Array(raw));
}

/** Creates and stores a new key; returns it (hex). */
export async function createKey(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrappingKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    wrappingKey,
    raw
  );
  const record: KeyRecord = { version: 1, wrappingKey, iv, wrapped };
  await withStore('readwrite', store => request(store.put(record, RECORD)));
  const hex = toHex(raw);
  raw.fill(0);
  return hex;
}

/** Deletes the stored key (wrapped key and wrapping key). */
export async function eraseKey(): Promise<void> {
  await withStore('readwrite', store => request(store.delete(RECORD)));
}
