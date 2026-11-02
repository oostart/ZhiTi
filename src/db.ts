import type { AppSettings, KnowledgePoint, Paper, Question, StoredFile } from './types'

const DB_NAME = 'study-si'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('papers')) {
        db.createObjectStore('papers', { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('questions')) {
        const s = db.createObjectStore('questions', { keyPath: 'id', autoIncrement: true })
        s.createIndex('paper_id', 'paper_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('knowledge')) {
        db.createObjectStore('knowledge', { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'paper_id' })
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const request = run(transaction.objectStore(storeName))
        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error)
      })
  )
}

export const db = {
  async getAll<T>(storeName: string): Promise<T[]> {
    return (await tx<T[]>(storeName, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? []
  },
  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return await tx<T | undefined>(storeName, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  },
  async put<T>(storeName: string, value: T): Promise<number> {
    return await tx<number>(storeName, 'readwrite', (s) => s.put(value) as IDBRequest<number>)
  },
  async remove(storeName: string, key: IDBValidKey): Promise<void> {
    await tx(storeName, 'readwrite', (s) => s.delete(key))
  },
  async clear(storeName: string): Promise<void> {
    await tx(storeName, 'readwrite', (s) => s.clear())
  }
}

export const repositories = {
  papers: () => db.getAll<Paper>('papers'),
  questions: () => db.getAll<Question>('questions'),
  knowledge: () => db.getAll<KnowledgePoint>('knowledge'),
  savedFile: (paperId: number) => db.get<StoredFile>('files', paperId),
  saveFile: (file: StoredFile) => db.put('files', file),
  removeFile: (paperId: number) => db.remove('files', paperId),
  settings: async (): Promise<AppSettings | undefined> => {
    const row = await db.get<{ key: string; value: AppSettings }>('settings', 'app')
    return row?.value
  },
  saveSettings: (value: AppSettings) => db.put('settings', { key: 'app', value })
}
