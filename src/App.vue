<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, FilePlus2, Library, Scissors, Settings } from 'lucide-vue-next'
import { isTauri } from '@tauri-apps/api/core'
import ToastHost from './components/ToastHost.vue'
import ImportView from './views/ImportView.vue'
import CutView from './views/CutView.vue'
import BankView from './views/BankView.vue'
import ExportView from './views/ExportView.vue'
import SettingsView from './views/SettingsView.vue'
import { initStore, state, ui, type ViewKey } from './store'
import { changeDataDir, getStorageState } from './utils/storage'
import { toast } from './composables/toast'
import logoUrl from './assets/logo.png'

const desktop = isTauri()
const bootError = ref('')
const views = {
  import: ImportView,
  cut: CutView,
  bank: BankView,
  export: ExportView,
  settings: SettingsView
}

const navItems: { key: ViewKey; label: string; icon: typeof FilePlus2 }[] = [
  { key: 'import', label: '试卷导入', icon: FilePlus2 },
  { key: 'cut', label: '题目切割', icon: Scissors },
  { key: 'bank', label: '题库管理', icon: Library },
  { key: 'export', label: '题目导出', icon: Download }
]

const activePaper = computed(() => state.papers.find((p) => p.id === ui.activePaperId))

const topbar = computed<{ title: string; subtitle: string }>(() => {
  switch (ui.view) {
    case 'import':
      return { title: '试卷导入', subtitle: '把纸质或电子试卷转化为可检索、可复用的数字题库' }
    case 'cut':
      return {
        title: activePaper.value?.title || '题目切割',
        subtitle: activePaper.value
          ? `${activePaper.value.subject} · ${activePaper.value.grade} · 共 ${activePaper.value.page_count} 页 · 已切割 ${state.questions.filter((q) => q.paper_id === activePaper.value!.id).length} 题`
          : '请先导入一份 PDF 试卷'
      }
    case 'bank':
      return {
        title: '题库管理',
        subtitle: `共 ${state.questions.length} 道题 · 来自 ${state.papers.length} 份试卷 · 覆盖 ${new Set(state.questions.flatMap((q) => q.knowledge)).size} 个知识点`
      }
    case 'export':
      return { title: '题目导出', subtitle: ui.exportIds.length ? `已选择 ${ui.exportIds.length} 道题` : '勾选需要导出的题目，选择排版格式' }
    case 'settings':
      return { title: '设置', subtitle: '配置 AI 接口与 OCR 文字识别' }
  }
})

function badgeFor(key: ViewKey): number | string | null {
  if (key === 'bank') return state.questions.length || null
  if (key === 'cut') return state.papers.length || null
  return null
}

function go(key: ViewKey) {
  if (key === 'cut' && !ui.activePaperId) {
    ui.activePaperId = state.papers[0]?.id ?? null
  }
  ui.view = key
}

onMounted(async () => {
  try {
    if (desktop) {
      const storage = await getStorageState()
      // 首次启动不再弹窗询问，直接以默认目录作为数据目录（静默写入配置，便于后续在设置中切换时迁移数据）
      if (!storage.configured) await changeDataDir(storage.defaultDir)
    }
    await initStore()
    if (!ui.activePaperId) ui.activePaperId = state.papers[0]?.id ?? null
  } catch (error) {
    bootError.value = (error as Error).message || '数据库初始化失败'
    toast('本地数据库初始化失败：' + bootError.value, 'error')
  }
})
</script>

<template>
  <div v-if="!state.ready" class="boot-screen">
    <img class="brand-mark" :src="logoUrl" alt="知题" style="width: 46px; height: 46px" />
    <div>
      <div style="font-size: 16px; font-weight: 650">知题 · AI 智能题库</div>
      <div class="hint" style="margin-top: 4px">{{ bootError || '正在加载本地题库…' }}</div>
    </div>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="nav-section-label">工作台</div>
      <nav>
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: ui.view === item.key }"
          @click="go(item.key)"
        >
          <component :is="item.icon" :size="17" />
          <span>{{ item.label }}</span>
          <span v-if="badgeFor(item.key)" class="nav-badge">{{ badgeFor(item.key) }}</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <button class="nav-item" :class="{ active: ui.view === 'settings' }" @click="go('settings')">
          <Settings :size="17" />
          <span>设置</span>
        </button>
      </div>
    </aside>

    <div class="main-area">
      <header class="topbar">
        <div>
          <div class="topbar-title">{{ topbar.title }}</div>
          <div class="topbar-sub">{{ topbar.subtitle }}</div>
        </div>
        <div class="topbar-actions">
          <button v-if="ui.view !== 'import'" class="btn btn-ghost btn-sm" @click="go('import')">
            <FilePlus2 :size="14" /> 导入新试卷
          </button>
          <button v-if="ui.view === 'settings'" class="btn btn-ghost btn-sm" @click="go('bank')">
            <Library :size="14" /> 返回题库
          </button>
        </div>
      </header>

      <component :is="views[ui.view]" />
    </div>
  </div>

  <ToastHost />
</template>

<style scoped>
.boot-screen {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-2);
}
</style>
