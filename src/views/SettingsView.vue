<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import {
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  PlugZap,
  Save,
  ScanText,
  Sparkles,
  Trash2
} from 'lucide-vue-next'
import { isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import AppModal from '../components/AppModal.vue'
import { reloadStore, saveSettings, state, ui } from '../store'
import { db } from '../db'
import { PROVIDER_PRESETS, testConnection } from '../utils/ai'
import { disposeAllDocuments } from '../utils/pdf'
import { changeDataDir, getStorageState, openDataDir } from '../utils/storage'
import { toast } from '../composables/toast'

const desktop = isTauri()
const ai = reactive({ ...state.settings.ai })
const ocrLang = ref(state.settings.ocr.lang)
const showKey = ref(false)
const saving = ref(false)
const testing = ref(false)
const dataDir = ref('')
const pendingDir = ref('')
const applyingDir = ref(false)
const confirmClear = ref(false)

const providerOptions: { key: 'deepseek' | 'qwen' | 'custom'; label: string }[] = [
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'qwen', label: '通义千问' },
  { key: 'custom', label: '自定义（OpenAI 兼容）' }
]

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

async function loadStorageInfo() {
  if (!desktop) {
    dataDir.value = '浏览器 IndexedDB（开发模式）'
    return
  }
  try {
    dataDir.value = (await getStorageState()).dataDir
  } catch (error) {
    toast('读取数据目录失败：' + ((error as Error).message || '未知错误'), 'error', 4200)
  }
}

async function openStorageDir() {
  try {
    await openDataDir()
  } catch (error) {
    toast('打开目录失败：' + ((error as Error).message || '未知错误'), 'error', 4200)
  }
}

async function pickStorageDir() {
  const dir = await open({ directory: true, multiple: false, defaultPath: dataDir.value })
  if (typeof dir === 'string' && dir !== dataDir.value) pendingDir.value = dir
}

async function applyDirChange() {
  if (!pendingDir.value) return
  applyingDir.value = true
  try {
    const info = await changeDataDir(pendingDir.value)
    dataDir.value = info.dataDir
    pendingDir.value = ''
    await reloadStore()
    Object.assign(ai, state.settings.ai)
    ocrLang.value = state.settings.ocr.lang
    toast('数据目录已切换到：' + info.dataDir, 'success', 4200)
  } catch (error) {
    toast('切换数据目录失败：' + ((error as Error).message || '未知错误'), 'error', 5200)
  } finally {
    applyingDir.value = false
  }
}

async function clearAllData() {
  await disposeAllDocuments()
  await db.clear('questions')
  await db.clear('papers')
  await db.clear('files')
  await db.clear('knowledge')
  state.questions = []
  state.papers = []
  state.knowledge = []
  ui.activePaperId = null
  ui.activeQuestionId = null
  ui.exportIds = []
  ui.bankKeyword = ''
  ui.cutPageByPaper = {}
  ui.view = 'import'
  confirmClear.value = false
  toast('题库数据已清空，AI 设置已保留', 'success', 3000)
}

onMounted(() => {
  void loadStorageInfo()
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
          </div>
        </div>

        <div>
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
            </div>
            <div v-if="desktop" class="hint" style="margin-top: 10px">
              所有数据保存在本地文件夹中，不上传云端。备份或迁移时直接复制该目录即可。
            </div>
            <div class="divider" />
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
              <div>
                <div style="font-size: 12.5px; font-weight: 600">数据存放目录</div>
                <div class="hint" style="margin-top: 2px">题库、原始 PDF 与设置都保存在这里</div>
              </div>
              <div v-if="desktop" style="display: flex; gap: 6px">
                <button class="btn btn-sm" @click="openStorageDir"><FolderOpen :size="13" /> 打开目录</button>
                <button class="btn btn-sm" @click="pickStorageDir">更改位置</button>
              </div>
            </div>
            <div class="dir-box">{{ dataDir || '—' }}</div>
            <div class="divider" />
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
              <div>
                <div style="font-size: 12.5px; font-weight: 600">清空题库数据</div>
                <div class="hint" style="margin-top: 2px">删除全部试卷，题目和知识点（谨慎使用）</div>
              </div>
              <button class="btn btn-danger btn-sm" :disabled="!state.questions.length && !state.papers.length && !state.knowledge.length" @click="confirmClear = true">
                <Trash2 :size="13" /> 清空
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AppModal v-if="pendingDir" title="更改数据存放位置？" @close="pendingDir = ''">
      <template #description>切换后会重新加载该目录中的题库数据。</template>
      <div class="hint" style="line-height: 1.8">
        新目录：<strong style="word-break: break-all">{{ pendingDir }}</strong><br />
        若新目录为空，当前题库与设置会复制过去；若已有知题数据，则切换并加载该目录，原目录数据保留。
      </div>
      <template #actions>
        <button class="btn" :disabled="applyingDir" @click="pendingDir = ''">取消</button>
        <button class="btn btn-primary" :disabled="applyingDir" @click="applyDirChange">
          <Loader2 v-if="applyingDir" :size="14" class="spin" />
          {{ applyingDir ? '正在切换…' : '确认切换' }}
        </button>
      </template>
    </AppModal>

    <AppModal v-if="confirmClear" title="清空全部题库数据？" @close="confirmClear = false">
      <template #description>此操作不可撤销，请确认已备份需要的题目和知识点。</template>
      <div class="hint">
        将删除 {{ state.papers.length }} 份试卷、{{ state.questions.length }} 道题目、{{ state.knowledge.length }} 个知识点及原始 PDF 缓存，AI 设置会保留。
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
.dir-box {
  margin-top: 8px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  border-radius: 8px;
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.6;
  word-break: break-all;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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
