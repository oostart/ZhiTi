<script setup lang="ts">
import { X } from 'lucide-vue-next'

defineProps<{ title?: string; width?: number; zIndex?: number }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <teleport to="body">
    <div class="modal-mask" :style="zIndex ? { zIndex } : undefined" @mousedown.self="emit('close')">
      <div class="modal" :style="{ width: width ? width + 'px' : undefined }">
        <div style="display: flex; align-items: flex-start; gap: 12px">
          <div style="flex: 1">
            <div class="modal-title">{{ title }}</div>
            <div class="hint"><slot name="description" /></div>
          </div>
          <button class="btn btn-ghost btn-icon" @click="emit('close')"><X :size="16" /></button>
        </div>
        <div style="margin-top: 14px"><slot /></div>
        <div class="modal-actions"><slot name="actions" /></div>
      </div>
    </div>
  </teleport>
</template>
