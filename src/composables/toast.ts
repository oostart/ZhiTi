import { reactive } from 'vue'

export interface ToastItem {
  id: number
  message: string
  type: 'info' | 'success' | 'error' | 'warning'
}

let seq = 0
export const toastState = reactive<{ items: ToastItem[] }>({ items: [] })

export function toast(message: string, type: ToastItem['type'] = 'info', duration = 3200): void {
  const id = ++seq
  toastState.items.push({ id, message, type })
  if (toastState.items.length > 3) toastState.items.splice(0, toastState.items.length - 3)
  setTimeout(() => {
    const index = toastState.items.findIndex((t) => t.id === id)
    if (index >= 0) toastState.items.splice(index, 1)
  }, duration)
}
