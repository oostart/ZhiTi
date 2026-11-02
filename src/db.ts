import { invoke, isTauri } from '@tauri-apps/api/core'
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils/base64'
import type { AppSettings, KnowledgePoint, Paper, Question, StoredFile } from './types'

const DB_NAME = 'study-si'
const DB_VERSION = 1
const desktop = isTauri()

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

interface FileRecord {
  paperId: number
  name: string
  data: string
}

export const db = {
  async getAll<T>(storeName: string): Promise<T[]> {
    if (desktop) return invoke<T[]>('store_get_all', { store: storeName })
    return (await tx<T[]>(storeName, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? []
  },
  async get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    if (desktop) {
      const row = await invoke<T | null>('store_get', { store: storeName, key })
      return row ?? undefined
    }
    return await tx<T | undefined>(storeName, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  },
  async put<T>(storeName: string, value: T): Promise<number> {
    if (desktop) return invoke<number>('store_put', { store: storeName, value })
    return await tx<number>(storeName, 'readwrite', (s) => s.put(value) as IDBRequest<number>)
  },
  async remove(storeName: string, key: IDBValidKey): Promise<void> {
    if (desktop) {
      await invoke<void>('store_remove', { store: storeName, key })
      return
    }
    await tx(storeName, 'readwrite', (s) => s.delete(key))
  },
  async clear(storeName: string): Promise<void> {
    if (desktop) {
      await invoke<void>('store_clear', { store: storeName })
      return
    }
    await tx(storeName, 'readwrite', (s) => s.clear())
  }
}

export const repositories = {
  papers: () => db.getAll<Paper>('papers'),
  questions: () => db.getAll<Question>('questions'),
  knowledge: () => db.getAll<KnowledgePoint>('knowledge'),
  savedFile: async (paperId: number): Promise<StoredFile | undefined> => {
    if (desktop) {
      const row = await invoke<FileRecord | null>('file_read', { paperId })
      if (!row) return undefined
      return { paper_id: row.paperId, name: row.name, data: base64ToArrayBuffer(row.data) }
    }
    return db.get<StoredFile>('files', paperId)
  },
  saveFile: async (file: StoredFile): Promise<void> => {
    if (desktop) {
      await invoke<void>('file_save', {
        paperId: file.paper_id,
        name: file.name,
        dataBase64: arrayBufferToBase64(file.data)
      })
      return
    }
    await db.put('files', file)
  },
  removeFile: async (paperId: number): Promise<void> => {
    if (desktop) {
      await invoke<void>('file_remove', { paperId })
      return
    }
    await db.remove('files', paperId)
  },
  settings: async (): Promise<AppSettings | undefined> => {
    const row = await db.get<{ key: string; value: AppSettings }>('settings', 'app')
    return row?.value
  },
  saveSettings: (value: AppSettings) => db.put('settings', { key: 'app', value })
}
