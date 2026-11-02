import { invoke } from '@tauri-apps/api/core'

export interface StorageState {
  dataDir: string
  defaultDir: string
  configured: boolean
  exists: boolean
}

export function getStorageState(): Promise<StorageState> {
  return invoke<StorageState>('storage_state')
}

export function changeDataDir(newDir: string): Promise<StorageState> {
  return invoke<StorageState>('storage_change_dir', { newDir })
}

export function getStorageSize(): Promise<number> {
  return invoke<number>('storage_size')
}

export function openDataDir(): Promise<void> {
  return invoke<void>('storage_open_dir')
}

export function writeFileAt(path: string, dataBase64: string): Promise<void> {
  return invoke<void>('write_file_at', { path, dataBase64 })
}
