<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  PlugZap,
  Plus,
  Save,
  ScanText,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  X
} from 'lucide-vue-next'
import AppModal from '../components/AppModal.vue'
import { addKnowledgePoint, deleteKnowledgePoint, saveSettings, state, ui } from '../store'
import { db } from '../db'
import { PROVIDER_PRESETS, testConnection } from '../utils/ai'
import { toast } from '../composables/toast'
import { SUBJECTS } from '../types'

const ai = reactive({ ...state.settings.ai })
const ocrLang = ref(state.settings.ocr.lang)
const showKey = ref(false)
const saving = ref(false)
const testing = ref(false)
const storageText = ref('')

const knowledgeSubject = ref(SUBJECTS[0])
const knowledgeName = ref('')
const knowledgeFilter = ref('')
const knowledgeSubjectFilter = ref('')
const pendingDelete = ref<{ id: number; name: string } | null>(null)
const confirmClear = ref(false)

const providerOptions: { key: 'deepseek' | 'qwen' | 'custom'; label: string }[] = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'qwen', label: '通义千问' },
  { key: 'custom', label: '自定义（OpenAI 兼容）' }
]

const filteredKnowledge = computed(() => {
  const kw = knowledgeFilter.value.trim().toLowerCase()
  return state.knowledge
    .filter((k) => (!knowledgeSubjectFilter.value || k.subject === knowledgeSubjectFilter.value) && (!kw || k.name.toLowerCase().includes(kw)))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'))
})

const subjectKnowledgeCount = computed(() => {
  const map = new Map<string, number>()
  state.knowledge.forEach((k) => map.set(k.subject, (map.get(k.subject) ?? 0) + 1))
  return map
})

function usageOf(name: string): number {
  return state.questions.filter((q) => q.knowledge.includes(name)).length
}

function onProviderChange() {
  if (ai.provider === 'custom') return
  const preset = PROVIDER_PRESETS[ai.provider]
  ai.baseUrl = preset.baseUrl
  ai.model = preset.model
}

async function saveAll() {
  saving.value = true
  try {
    await saveSettings({ ai: { ...ai }, ocr: { lang: ocrLang.value } })
    toast('设置已保存到本地', 'success')
  } catch (error) {
    toast('保存失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    saving.value = false
  }
}

async function runTest() {
  if (!ai.apiKey.trim()) {
    toast('请先填写 API 密钥', 'warning')
    return
  }
  testing.value = true
  try {
    const reply = await testConnection({ ...ai })
    toast(`连接成功：${reply.slice(0, 40)}`, 'success', 4200)
  } catch (error) {
    toast((error as Error).message || '连接失败', 'error', 5600)
  } finally {
    testing.value = false
  }
}

async function addKnowledge() {
  const name = knowledgeName.value.trim()
  if (!name) {
    toast('请输入知识点名称', 'warning')
    return
  }
  await addKnowledgePoint(name, knowledgeSubject.value)
  knowledgeName.value = ''
  toast(`已添加知识点「${name}」`, 'success', 1800)
}

async function confirmDeleteKnowledge() {
  if (!pendingDelete.value) return
  const { id, name } = pendingDelete.value
  await deleteKnowledgePoint(id)
  pendingDelete.value = null
  toast(`已删除知识点「${name}」，相关题目标注已同步移除`, 'success', 2600)
}

async function refreshStorage() {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.usage != null) storageText.value = `${(estimate.usage / 1024 / 1024).toFixed(2)} MB`
    else storageText.value = '未知'
  } catch {
    storageText.value = '未知'
  }
}

async function clearAllData() {
  await db.clear('questions')
  await db.clear('papers')
  await db.clear('files')
  state.questions = []
  state.papers = []
  ui.activePaperId = null
  ui.activeQuestionId = null
  ui.exportIds = []
  ui.view = 'import'
  confirmClear.value = false
  await refreshStorage()
  toast('题库数据已清空，设置与知识点保留', 'success', 3000)
}

onMounted(() => {
  void refreshStorage()
})
</script>

<template>
  <div class="view">
    <div class="workspace settings-page">
      <div class="settings-grid">
        <div>
          <div class="card card-pad" style="margin-bottom: 16px">
            <div class="section-title"><Sparkles :size="16" style="color: var(--accent)" /> AI 辅助接口</div>
            <div class="hint" style="margin-bottom: 14px">
              用于「答案生成」「知识点推荐」「题目理解」。接口采用 OpenAI 兼容格式，密钥只保存在本机数据库中。
            </div>

            <div class="field">
              <label class="label">服务商</label>
              <div class="segmented" style="width: 100%">
                <button
                  v-for="item in providerOptions"
                  :key="item.key"
                  style="flex: 1"
                  :class="{ active: ai.provider === item.key }"
                  @click="ai.provider = item.key; onProviderChange()"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>

            <div class="field">
              <label class="label">接口地址 Base URL</label>
              <input v-model="ai.baseUrl" class="input" placeholder="https://api.deepseek.com/v1" spellcheck="false" />
            </div>

            <div class="row-2">
              <div class="field">
                <label class="label">模型</label>
                <input v-model="ai.model" class="input" placeholder="deepseek-chat" spellcheck="false" />
              </div>
              <div class="field">
                <label class="label">温度 · {{ ai.temperature.toFixed(2) }}</label>
                <input v-model.number="ai.temperature" type="range" min="0" max="1" step="0.05" style="width: 100%; accent-color: var(--accent); margin-top: 8px" />
              </div>
            </div>

            <div class="field">
              <label class="label">API 密钥</label>
              <div style="position: relative">
                <input
                  v-model="ai.apiKey"
                  class="input"
                  :type="showKey ? 'text' : 'password'"
                  placeholder="sk-…"
                  spellcheck="false"
                  style="padding-right: 36px; font-family: ui-monospace, monospace"
                />
                <button class="key-toggle" @click="showKey = !showKey">
                  <EyeOff v-if="showKey" :size="15" />
                  <Eye v-else :size="15" />
                </button>
              </div>
              <div class="hint" style="margin-top: 5px">
                <KeyRound :size="11" style="vertical-align: -1px" /> 密钥不会上传，仅用于本机发起的 HTTPS 请求。
              </div>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 16px">
              <button class="btn btn-primary" :disabled="saving" @click="saveAll">
                <Loader2 v-if="saving" :size="14" class="spin" />
                <Save v-else :size="14" /> 保存设置
              </button>
              <button class="btn" :disabled="testing" @click="runTest">
                <Loader2 v-if="testing" :size="14" class="spin" />
                <PlugZap v-else :size="14" /> 测试连接
              </button>
            </div>

            <div class="notice" style="margin-top: 14px">
              <ShieldCheck :size="14" />
              <div>
                浏览器环境下，部分 AI 服务会因跨域（CORS）限制而无法直接调用；打包为桌面版（Tauri）后不受此限制。若调用失败，可改用支持跨域的服务或部署本地代理。
              </div>
            </div>
          </div>

          <div class="card card-pad" style="margin-bottom: 16px">
            <div class="section-title"><ScanText :size="16" style="color: var(--accent)" /> OCR 文字识别</div>
            <div class="field">
              <label class="label">识别语言</label>
              <select v-model="ocrLang" class="select" style="max-width: 300px">
                <option value="chi_sim+eng">简体中文 + 英文（推荐）</option>
                <option value="chi_sim">仅简体中文</option>
                <option value="eng">仅英文</option>
              </select>
            </div>
            <div class="hint">
              数字版 PDF 会优先直接读取文本层（准确率最高）；扫描件可在题目编辑面板点击「OCR 识别」，由 Tesseract.js 在本地完成识别，首次使用需联网下载语言模型。
            </div>
            <button class="btn" style="margin-top: 12px" :disabled="saving" @click="saveAll"><Save :size="14" /> 保存 OCR 设置</button>
          </div>
        </div>

        <div>
          <div class="card card-pad" style="margin-bottom: 16px">
            <div class="section-title"><Tag :size="16" style="color: var(--accent)" /> 知识点体系</div>
            <div class="hint" style="margin-bottom: 12px">维护各学科知识点，可在题目编辑时快速标注，也用于 AI 推荐的候选词。</div>

            <div class="knowledge-form">
              <select v-model="knowledgeSubject" class="select" style="width: 100px">
                <option v-for="s in SUBJECTS" :key="s">{{ s }}</option>
              </select>
              <input v-model="knowledgeName" class="input" placeholder="知识点名称，例如：牛顿第二定律" @keydown.enter.prevent="addKnowledge" />
              <button class="btn btn-primary btn-sm" @click="addKnowledge"><Plus :size="13" /> 添加</button>
            </div>

            <div class="knowledge-filter">
              <input v-model="knowledgeFilter" class="input" placeholder="筛选知识点…" />
              <select v-model="knowledgeSubjectFilter" class="select" style="width: 110px">
                <option value="">全部学科</option>
                <option v-for="(count, subject) in Object.fromEntries(subjectKnowledgeCount.entries())" :key="subject" :value="subject">
                  {{ subject }} ({{ count }})
                </option>
              </select>
            </div>

            <div class="knowledge-list">
              <div v-for="k in filteredKnowledge" :key="k.id" class="knowledge-row">
                <div style="flex: 1; min-width: 0">
                  <div style="font-size: 12.5px; font-weight: 550">{{ k.name }}</div>
                  <div class="hint" style="font-size: 11px">{{ k.subject }} · 已用于 {{ usageOf(k.name) }} 道题</div>
                </div>
                <button class="btn btn-ghost btn-icon" title="删除知识点" @click="pendingDelete = { id: k.id, name: k.name }">
                  <Trash2 :size="13" />
                </button>
              </div>
              <div v-if="!filteredKnowledge.length" class="hint" style="text-align: center; padding: 16px 0">没有匹配的知识点</div>
            </div>
          </div>

          <div class="card card-pad" style="margin-bottom: 16px">
            <div class="section-title"><Database :size="16" style="color: var(--accent)" /> 本地数据</div>
            <div class="stat-grid">
              <div class="stat">
                <div class="stat-value">{{ state.papers.length }}</div>
                <div class="stat-label">份试卷</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ state.questions.length }}</div>
                <div class="stat-label">道题目</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ state.knowledge.length }}</div>
                <div class="stat-label">个知识点</div>
              </div>
              <div class="stat">
                <div class="stat-value">{{ storageText || '—' }}</div>
                <div class="stat-label">本地占用</div>
              </div>
            </div>
            <div class="hint" style="margin-top: 10px">
              所有数据保存在当前设备的浏览器本地数据库（IndexedDB）中，不上传云端。清理浏览器数据会导致题库丢失。
            </div>
            <div class="divider" />
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
              <div>
                <div style="font-size: 12.5px; font-weight: 600">清空题库数据</div>
                <div class="hint" style="margin-top: 2px">删除全部试卷与题目，保留知识点与 AI 设置</div>
              </div>
              <button class="btn btn-danger btn-sm" :disabled="!state.questions.length && !state.papers.length" @click="confirmClear = true">
                <Trash2 :size="13" /> 清空
              </button>
            </div>
          </div>

          <div class="card card-pad">
            <div class="section-title">关于知题</div>
            <div class="hint" style="line-height: 1.8">
              知题 v1.0 · 面向中小学教师的 AI 智能题库工具。<br />
              核心能力：PDF 试卷导入、切线/框选切割、跨页合并、OCR 校对、AI 答案与知识点辅助、多维检索、五种格式导出。<br />
              <span style="color: var(--text-3)">数据仅在本机处理，AI 调用需自行配置接口。</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AppModal v-if="pendingDelete" title="删除知识点？" @close="pendingDelete = null">
      <template #description>所有题目上对该知识点的标注会一并移除。</template>
      <div class="hint">知识点：<strong>{{ pendingDelete.name }}</strong></div>
      <template #actions>
        <button class="btn" @click="pendingDelete = null">取消</button>
        <button class="btn btn-danger" @click="confirmDeleteKnowledge"><Trash2 :size="14" /> 确认删除</button>
      </template>
    </AppModal>

    <AppModal v-if="confirmClear" title="清空全部题库数据？" @close="confirmClear = false">
      <template #description>此操作不可撤销，请确认已备份需要的题目。</template>
      <div class="hint">
        将删除 {{ state.papers.length }} 份试卷、{{ state.questions.length }} 道题目及原始 PDF 缓存，知识点与 AI 设置会保留。
      </div>
      <template #actions>
        <button class="btn" @click="confirmClear = false">取消</button>
        <button class="btn btn-danger" @click="clearAllData"><Trash2 :size="14" /> 确认清空</button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.settings-page {
  overflow: auto;
}
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  max-width: 1180px;
  margin: 0 auto;
  align-items: start;
}
.key-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  border: 0;
  background: transparent;
  color: var(--text-3);
  padding: 4px;
  border-radius: 5px;
  display: grid;
  place-items: center;
}
.key-toggle:hover {
  background: #f2f4fa;
}
.notice {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  background: #f7f9fd;
  border: 1px solid #e3e8f2;
  border-radius: 9px;
  padding: 10px 11px;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.65;
}
.knowledge-form {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.knowledge-filter {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.knowledge-list {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.knowledge-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid #f1f3f8;
}
.knowledge-row:last-child {
  border-bottom: 0;
}
.knowledge-row:hover {
  background: #fafbfe;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.stat {
  background: #f8f9fd;
  border: 1px solid #eef0f6;
  border-radius: 9px;
  padding: 10px;
  text-align: center;
}
.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.3px;
}
.stat-label {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@media (max-width: 1100px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
