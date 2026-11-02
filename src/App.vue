<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, FilePlus2, Library, Scissors, Settings, Sparkles } from 'lucide-vue-next'
import ToastHost from './components/ToastHost.vue'
import ImportView from './views/ImportView.vue'
import CutView from './views/CutView.vue'
import BankView from './views/BankView.vue'
import ExportView from './views/ExportView.vue'
import SettingsView from './views/SettingsView.vue'
import { initStore, state, ui, type ViewKey } from './store'
import { toast } from './composables/toast'

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
  { key: 'export', label: '题目导出', icon: Download },
  { key: 'settings', label: '设置', icon: Settings }
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
        subtitle: `共 ${state.questions.length} 道题 · 来自 ${state.papers.length} 份试卷 · 覆盖 ${new Set(state.questions.map((q) => q.knowledge.join())).size} 组知识点`
      }
    case 'export':
      return { title: '题目导出', subtitle: ui.exportIds.length ? `已选择 ${ui.exportIds.length} 道题` : '勾选需要导出的题目，选择排版格式' }
    case 'settings':
      return { title: '设置', subtitle: '配置 AI 接口、OCR 语言与知识点体系' }
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
    <div class="brand-mark" style="width: 46px; height: 46px; font-size: 20px">知</div>
    <div>
      <div style="font-size: 16px; font-weight: 650">知题 · AI 智能题库</div>
      <div class="hint" style="margin-top: 4px">{{ bootError || '正在加载本地题库…' }}</div>
    </div>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">知</div>
        <div>
          <div class="brand-name">知题</div>
          <div class="brand-sub">AI 智能题库 · v1.0</div>
        </div>
      </div>

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
        <div style="display: flex; align-items: center; gap: 5px; color: #6366f1; margin-bottom: 4px">
          <Sparkles :size="12" /> 本地存储 · 数据不出本机
        </div>
        试卷与题目保存在浏览器本地数据库，AI 调用仅在你主动操作时发生。
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

    <ToastHost />
  </div>
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
