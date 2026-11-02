<script setup lang="ts">
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-vue-next'
import { toastState } from '../composables/toast'

const icons = { success: CheckCircle2, error: AlertCircle, warning: AlertTriangle, info: Info }
</script>

<template>
  <teleport to="body">
    <div class="toast-stack">
      <transition-group name="toast">
        <div v-for="t in toastState.items" :key="t.id" class="toast" :class="t.type">
          <component :is="icons[t.type]" :size="16" />
          <span>{{ t.message }}</span>
        </div>
      </transition-group>
    </div>
  </teleport>
</template>
