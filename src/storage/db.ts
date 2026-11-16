/**
 * Envoltura mínima de IndexedDB. Todo se queda en el navegador del usuario.
 */
const DB_NAME = 'proyectox'
const DB_VERSION = 1

export type StoreName = 'audio' | 'projects'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio')
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('No se pudo abrir IndexedDB'))
  })
  return dbPromise
}

function request<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = run(tx.objectStore(store))
        tx.oncomplete = () => resolve(req.result as T)
        tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB'))
        tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada'))
      }),
  )
}

export function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return request<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export function dbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  return request<unknown>(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined)
}

export function dbDelete(store: StoreName, key: string): Promise<void> {
  return request<unknown>(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
}
