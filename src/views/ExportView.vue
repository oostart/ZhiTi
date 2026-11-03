<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  FileType2,
  GripVertical,
  Loader2,
  Package,
  Plus,
  Presentation,
  Search,
  Sparkles,
  Trash2,
  X
} from 'lucide-vue-next'
import { exportQuestions, FORMAT_LABELS, type ExportFormat } from '../utils/exporters'
import { downloadBlob } from '../utils/image'
import { blobToBase64 } from '../utils/base64'
import { writeFileAt } from '../utils/storage'
import { save } from '@tauri-apps/plugin-dialog'
import { isTauri } from '@tauri-apps/api/core'
import { paperOf, state, ui, updateQuestion } from '../store'
import { generateAnswer } from '../utils/ai'
import { toast } from '../composables/toast'
import AppModal from '../components/AppModal.vue'
import type { ExportOptions, Question } from '../types'

const format = ref<ExportFormat>('pdf')
const exporting = ref(false)
const exportingLabel = ref('')
const dragIndex = ref<number | null>(null)
const showLibrary = ref(false)
const libraryKeyword = ref('')
const missingOpen = ref(false)
const missingDrafts = reactive<Record<number, string>>({})
const missingSaving = ref(false)
const missingAiId = ref<number | null>(null)
const missingPreviewId = ref<number | null>(null)

const options = reactive<ExportOptions>({
  title: '',
  subtitle: '',
  showAnswer: false,
  onePerPage: false,
  showNumber: false,
  pageSize: 'a4',
  margin: 18,
  scale: 1,
  fileName: ''
})

const formats: { key: ExportFormat; label: string; desc: string; icon: typeof FileText }[] = [
  { key: 'pdf', label: FORMAT_LABELS.pdf, desc: '高清排版，是否带答案由下方开关决定', icon: FileText },
  { key: 'docx', label: FORMAT_LABELS.docx, desc: '可二次编辑，图片与文字均保留', icon: FileType2 },
  { key: 'pptx', label: FORMAT_LABELS.pptx, desc: '一题一页，适合课堂投屏讲解', icon: Presentation },
  { key: 'zip', label: FORMAT_LABELS.zip, desc: '全部题目图片 + 清单，便于归档', icon: Package }
]

const selectedQuestions = computed(() =>
  ui.exportIds.map((id) => state.questions.find((q) => q.id === id)).filter((q): q is NonNullable<typeof q> => !!q)
)

const libraryQuestions = computed(() => {
  const kw = libraryKeyword.value.trim().toLowerCase()
  return state.questions
    .filter((q) => !ui.exportIds.includes(q.id))
    .filter((q) => {
      if (!kw) return true
      return [q.ocr_text, q.knowledge.join(' '), paperOf(q)?.title ?? ''].join(' ').toLowerCase().includes(kw)
    })
    .slice(0, 80)
})

const missingQuestions = computed(() => selectedQuestions.value.filter((q) => !q.answer.trim()))
const totalQuestions = computed(() => state.questions.length)

const defaultTitle = computed(() => {
  const papers = new Set(selectedQuestions.value.map((q) => q.paper_id))
  if (papers.size === 1) {
    const paper = state.papers.find((p) => p.id === selectedQuestions.value[0]?.paper_id)
    return paper?.title ?? ''
  }
  return selectedQuestions.value.length ? '题目精选卷' : ''
})

const defaultSubtitle = computed(() => {
  const papers = selectedQuestions.value.map((q) => paperOf(q)).filter(Boolean)
  const unique = Array.from(new Set(papers.map((p) => `${p!.subject} · ${p!.grade}`)))
  return unique.length === 1 ? unique[0] : ''
})

watch(
  defaultTitle,
  (value) => {
    if (!options.title) options.title = value
  },
  { immediate: true }
)

watch(
  defaultSubtitle,
  (value) => {
    if (!options.subtitle) options.subtitle = value
  },
  { immediate: true }
)

function toggleAnswers() {
  options.showAnswer = !options.showAnswer
  if (options.showAnswer) openMissingAnswers()
}

function openMissingAnswers() {
  if (!missingQuestions.value.length) return
  for (const q of missingQuestions.value) {
    if (missingDrafts[q.id] == null) missingDrafts[q.id] = q.answer
  }
  missingOpen.value = true
}

async function saveMissingAnswers() {
  const targets = missingQuestions.value.filter((q) => (missingDrafts[q.id] ?? '').trim())
  if (!targets.length) {
    missingOpen.value = false
    return
  }
  missingSaving.value = true
  try {
    for (const q of targets) {
      await updateQuestion(q.id, { answer: missingDrafts[q.id].trim() })
    }
    toast(`已保存 ${targets.length} 道题的参考答案`, 'success')
    missingOpen.value = false
  } catch (error) {
    toast('保存答案失败：' + ((error as Error).message || '未知错误'), 'error', 5200)
  } finally {
    missingSaving.value = false
  }
}

async function generateMissingAnswer(question: Question) {
  const text = question.ocr_text.trim()
  if (!text) {
    toast('该题还没有识别文字，无法生成答案，可先在题库中 OCR', 'warning')
    return
  }
  missingAiId.value = question.id
  try {
    const paper = paperOf(question)
    missingDrafts[question.id] = await generateAnswer(state.settings.ai, {
      text,
      subject: paper?.subject ?? '',
      grade: paper?.grade ?? '',
      type: question.question_type,
      answer: missingDrafts[question.id] || ''
    })
    toast('AI 已生成答案，请核对后保存', 'success')
  } catch (error) {
    toast((error as Error).message || 'AI 调用失败', 'error', 5200)
  } finally {
    missingAiId.value = null
  }
}

function addQuestion(id: number) {
  if (!ui.exportIds.includes(id)) ui.exportIds = [...ui.exportIds, id]
}

function removeQuestion(id: number) {
  ui.exportIds = ui.exportIds.filter((x) => x !== id)
}

function addAll() {
  ui.exportIds = state.questions.map((q) => q.id)
  toast(`已添加全部 ${ui.exportIds.length} 道题目`, 'success', 1800)
}

function clearAll() {
  ui.exportIds = []
}

function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= ui.exportIds.length) return
  const list = [...ui.exportIds]
  const [item] = list.splice(index, 1)
  list.splice(target, 0, item)
  ui.exportIds = list
}

function onDragStart(index: number) {
  dragIndex.value = index
}

function onDrop(index: number) {
  if (dragIndex.value == null || dragIndex.value === index) {
    dragIndex.value = null
    return
  }
  const list = [...ui.exportIds]
  const [item] = list.splice(dragIndex.value, 1)
  list.splice(index, 0, item)
  ui.exportIds = list
  dragIndex.value = null
}

async function doExport() {
  if (!selectedQuestions.value.length) {
    toast('请先选择需要导出的题目', 'warning')
    return
  }
  exporting.value = true
  exportingLabel.value = '正在生成排版…'
  try {
    const finalOptions: ExportOptions = {
      ...options,
      title: options.title || '试卷',
      fileName: options.fileName || options.title || '试卷'
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    exportingLabel.value = '正在渲染题目图片与版式…'
    const { blob, filename } = await exportQuestions(format.value, selectedQuestions.value, finalOptions)
    if (isTauri()) {
      exportingLabel.value = '请选择保存位置…'
      const ext = filename.split('.').pop()?.toLowerCase() || 'pdf'
      const path = await save({
        defaultPath: filename,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      })
      if (!path) return
      exportingLabel.value = '正在写入文件…'
      await writeFileAt(path, await blobToBase64(blob))
      toast(`已导出到：${path}`, 'success', 5000)
    } else {
      exportingLabel.value = '正在写入文件…'
      downloadBlob(blob, filename)
      toast(`已导出「${filename}」`, 'success', 4000)
    }
  } catch (error) {
    toast('导出失败：' + ((error as Error).message || '未知错误'), 'error', 5200)
  } finally {
    exporting.value = false
    exportingLabel.value = ''
  }
}
</script>

<template>
  <div class="view">
    <div class="export-main">
      <div class="export-toolbar">
        <span class="hint">已选 <strong style="color: var(--text)">{{ selectedQuestions.length }}</strong> 道题</span>
        <button class="btn btn-ghost btn-sm" @click="ui.view = 'bank'"><ArrowLeft :size="13" /> 返回题库挑选</button>
        <button class="btn btn-ghost btn-sm" :disabled="!totalQuestions || ui.exportIds.length === totalQuestions" @click="addAll">全选题库</button>
        <button v-if="ui.exportIds.length" class="btn btn-ghost btn-sm" @click="clearAll">清空</button>
        <div class="toolbar-spacer" />
        <button class="btn btn-sm" :class="{ 'btn-primary': showLibrary }" @click="showLibrary = !showLibrary">
          <Plus :size="13" /> 从题库添加
          <ChevronUp v-if="showLibrary" :size="13" />
          <ChevronDown v-else :size="13" />
        </button>
      </div>

      <div v-if="showLibrary" class="library-panel">
        <div class="search-box" style="width: 100%; max-width: 420px">
          <Search :size="14" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-3)" />
          <input v-model="libraryKeyword" class="input" style="padding-left: 30px" placeholder="搜索题干或知识点，快速添加题目…" />
        </div>
        <div v-if="!libraryQuestions.length" class="hint" style="padding: 10px 0">没有可添加的题目，或题库已全部选中。</div>
        <div v-else class="library-grid">
          <div v-for="q in libraryQuestions" :key="q.id" class="library-item">
            <img v-if="q.image" :src="q.image" loading="lazy" />
            <div style="flex: 1; min-width: 0">
              <div class="library-text">{{ q.ocr_text || '（无识别文字）' }}</div>
              <div class="hint" style="font-size: 11px">{{ q.question_type }} · 难度 {{ q.difficulty }}</div>
            </div>
            <button class="btn btn-sm btn-primary" @click="addQuestion(q.id)"><Plus :size="12" /> 添加</button>
          </div>
        </div>
      </div>

      <div class="selected-area">
        <div v-if="!selectedQuestions.length" class="empty">
          <div class="empty-icon"><Package :size="24" /></div>
          <div class="empty-title">还没有选择题目</div>
          <div class="empty-desc">到题库勾选题目，或使用上方「从题库添加」快速挑选。选中的题目会按下面的顺序排版。</div>
          <div style="display: flex; gap: 8px; margin-top: 6px">
            <button class="btn btn-primary" @click="ui.view = 'bank'">去题库挑选</button>
            <button class="btn" @click="showLibrary = true"><Plus :size="14" /> 从题库添加</button>
          </div>
        </div>

        <template v-else>
          <div class="selected-head">
            <div class="hint">拖动左侧手柄可调整题目顺序，导出时按此顺序编号。</div>
            <div class="hint">共 {{ selectedQuestions.length }} 题</div>
          </div>
          <div class="selected-list">
            <div
              v-for="(q, index) in selectedQuestions"
              :key="q.id"
              class="selected-row"
              :class="{ dragging: dragIndex === index }"
              draggable="true"
              @dragstart="onDragStart(index)"
              @dragover.prevent
              @drop.prevent="onDrop(index)"
              @dragend="dragIndex = null"
            >
              <div class="drag-handle"><GripVertical :size="15" /></div>
              <div class="order-badge">{{ index + 1 }}</div>
              <div class="thumb"><img v-if="q.image" :src="q.image" loading="lazy" /></div>
              <div style="flex: 1; min-width: 0">
                <div class="row-text">{{ q.ocr_text || '（无识别文字，可在题库中 OCR）' }}</div>
                <div class="row-meta">
                  <span class="badge badge-gray">{{ q.question_type }}</span>
                  <span class="hint" style="font-size: 11px">难度 {{ q.difficulty }}</span>
                  <span v-if="q.knowledge.length" class="hint" style="font-size: 11px">· {{ q.knowledge.slice(0, 2).join(' / ') }}</span>
                  <span class="hint" style="font-size: 11px">· {{ paperOf(q)?.title }}</span>
                </div>
              </div>
              <div class="row-actions">
                <button class="btn btn-ghost btn-icon" title="上移" :disabled="index === 0" @click="move(index, -1)"><ChevronUp :size="14" /></button>
                <button class="btn btn-ghost btn-icon" title="下移" :disabled="index === selectedQuestions.length - 1" @click="move(index, 1)"><ChevronDown :size="14" /></button>
                <button class="btn btn-ghost btn-icon" title="移出" @click="removeQuestion(q.id)"><X :size="14" /></button>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <aside class="inspector">
      <div class="section-title" style="margin-bottom: 10px">导出格式</div>
      <div class="format-list">
        <button
          v-for="item in formats"
          :key="item.key"
          class="format-card"
          :class="{ active: format === item.key }"
          @click="format = item.key"
        >
          <div class="format-icon"><component :is="item.icon" :size="17" /></div>
          <div style="flex: 1; min-width: 0">
            <div class="format-title">{{ item.label }}</div>
            <div class="format-desc">{{ item.desc }}</div>
          </div>
          <span v-if="format === item.key" class="format-check"><Check :size="13" /></span>
        </button>
      </div>

      <div class="divider" />

      <div class="section-title" style="margin-bottom: 10px">排版设置</div>
      <div class="field">
        <label class="label">试卷标题</label>
        <input v-model="options.title" class="input" placeholder="导出文件中的标题" />
      </div>
      <div class="field">
        <label class="label">副标题 / 说明</label>
        <input v-model="options.subtitle" class="input" placeholder="例如：初三物理 · 第一轮复习" />
      </div>

      <div class="switch-row">
        <div>
          包含参考答案
          <div class="hint" style="margin-top: 2px">
            {{ format === 'zip' ? '答案写入题目清单' : '答案显示在每题下方' }}
          </div>
        </div>
        <button class="switch" :class="{ on: options.showAnswer }" @click="toggleAnswers()" />
      </div>
      <div class="switch-row">
        <div>每题独立一页</div>
        <button class="switch" :class="{ on: options.onePerPage }" @click="options.onePerPage = !options.onePerPage" />
      </div>
      <div class="switch-row">
        <div>
          新加题目编号
          <div class="hint" style="margin-top: 2px">题目无编号可勾选</div>
        </div>
        <button class="switch" :class="{ on: options.showNumber }" @click="options.showNumber = !options.showNumber" />
      </div>

      <div class="row-2" style="margin-top: 12px">
        <div class="field">
          <label class="label">纸张</label>
          <select v-model="options.pageSize" class="select">
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </select>
        </div>
        <div class="field">
          <label class="label">页边距 · {{ options.margin }} mm</label>
          <input v-model.number="options.margin" type="range" min="8" max="30" step="2" style="width: 100%; accent-color: var(--accent)" />
        </div>
      </div>

      <div class="field">
        <label class="label">题目图片宽度 · {{ Math.round(options.scale * 100) }}%</label>
        <input v-model.number="options.scale" type="range" min="0.6" max="1" step="0.05" style="width: 100%; accent-color: var(--accent)" />
      </div>

      <div class="field">
        <label class="label">文件名</label>
        <input v-model="options.fileName" class="input" placeholder="默认与标题一致" />
      </div>

      <button class="btn btn-primary btn-lg" style="width: 100%; margin-top: 4px" :disabled="!selectedQuestions.length || exporting" @click="doExport">
        <Loader2 v-if="exporting" :size="16" class="spin" />
        <Download v-else :size="16" />
        {{ exporting ? '正在导出…' : `导出 ${selectedQuestions.length} 道题` }}
      </button>
      <div v-if="exporting" class="hint" style="text-align: center; margin-top: 8px">{{ exportingLabel }}</div>

      <div v-if="selectedQuestions.length > 100" class="export-warning">
        <AlertTriangle :size="13" /> 题目超过 100 道，导出与排版可能需要较长时间。
      </div>

      <div class="hint" style="margin-top: 12px; line-height: 1.7">
        导出说明：点击导出会弹出保存位置选择窗口。PDF 采用高清排版图输出，中文显示稳定；Word 中题目为图片，可继续编辑标题与答案；PPT 为 16:9 一题一页。
      </div>
    </aside>
  </div>

  <AppModal v-if="missingOpen" title="有题目还没有填写参考答案" :width="680" @close="missingOpen = false">
    <template #description>
      已勾选「包含参考答案」，以下 {{ missingQuestions.length }} 道题没有答案，导出时会跳过它们的答案。可在下方补写，或用 AI 生成后核对保存。
    </template>

    <div class="missing-list">
      <div v-for="q in missingQuestions" :key="q.id" class="missing-row">
        <div class="missing-head">
          <button
            class="missing-thumb"
            title="查看题目图片"
            @click="missingPreviewId = missingPreviewId === q.id ? null : q.id"
          >
            <img v-if="q.image" :src="q.image" loading="lazy" />
          </button>
          <div style="flex: 1; min-width: 0">
            <div class="missing-text">{{ q.ocr_text || '（无识别文字）' }}</div>
            <div class="hint" style="font-size: 11px">{{ q.question_type }} · {{ paperOf(q)?.title }}</div>
          </div>
          <button class="btn btn-sm" :disabled="missingAiId != null" @click="generateMissingAnswer(q)">
            <Loader2 v-if="missingAiId === q.id" :size="12" class="spin" />
            <Sparkles v-else :size="12" /> AI 生成
          </button>
        </div>
        <img v-if="missingPreviewId === q.id && q.image" class="missing-preview" :src="q.image" />
        <textarea v-model="missingDrafts[q.id]" class="textarea" rows="2" placeholder="填写参考答案…" />
      </div>
    </div>

    <template #actions>
      <button class="btn" @click="missingOpen = false">暂不处理</button>
      <button class="btn btn-primary" :disabled="missingSaving" @click="saveMissingAnswers">
        <Loader2 v-if="missingSaving" :size="14" class="spin" />
        保存并关闭
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.export-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.export-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.library-panel {
  border-bottom: 1px solid var(--border);
  background: #fbfcff;
  padding: 12px 16px;
  max-height: 260px;
  overflow: auto;
}
.library-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.library-item {
  display: flex;
  align-items: center;
  gap: 9px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 9px;
}
.library-item img {
  width: 40px;
  height: 44px;
  object-fit: cover;
  object-position: top;
  border-radius: 4px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.library-text {
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-area {
  flex: 1;
  overflow: auto;
  padding: 14px 18px 28px;
  display: flex;
  flex-direction: column;
}
.selected-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 0 2px;
}
.selected-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.selected-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  transition: box-shadow 0.15s, border 0.15s, opacity 0.15s;
}
.selected-row:hover {
  border-color: #c9cdf5;
  box-shadow: 0 3px 12px rgba(22, 28, 45, 0.06);
}
.selected-row.dragging {
  opacity: 0.45;
}
.drag-handle {
  color: #b9c0cf;
  cursor: grab;
  display: grid;
  place-items: center;
  padding: 2px;
}
.order-badge {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-size: 11.5px;
  font-weight: 700;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.thumb {
  width: 48px;
  height: 54px;
  border-radius: 5px;
  overflow: hidden;
  background: #f5f6fb;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.row-text {
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.row-actions {
  display: flex;
  gap: 0;
  opacity: 0.5;
  transition: opacity 0.15s;
}
.selected-row:hover .row-actions {
  opacity: 1;
}
.format-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.format-card {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 9px;
  padding: 9px 10px;
  transition: all 0.15s;
}
.format-card:hover {
  border-color: #c9cdf5;
  background: #fafbff;
}
.format-card.active {
  border-color: #8b84f2;
  background: #f6f5ff;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}
.format-icon {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: #f1f3fa;
  color: #5a6478;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.format-card.active .format-icon {
  background: #e6e4ff;
  color: #4f46e5;
}
.format-title {
  font-size: 12.5px;
  font-weight: 600;
}
.format-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.45;
}
.format-check {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.export-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  background: var(--warning-soft);
  border: 1px solid #f2dfba;
  border-radius: 8px;
  font-size: 11.5px;
  color: #92400e;
}
.search-box {
  position: relative;
}
.spin {
  animation: spin 0.8s linear infinite;
}
.missing-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 56vh;
  overflow: auto;
  padding-right: 2px;
}
.missing-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  background: #fff;
}
.missing-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 8px;
}
.missing-thumb {
  width: 48px;
  height: 54px;
  border-radius: 5px;
  overflow: hidden;
  background: #f5f6fb;
  border: 1px solid var(--border);
  flex-shrink: 0;
  padding: 0;
  cursor: zoom-in;
}
.missing-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.missing-text {
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.missing-preview {
  display: block;
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f8f9fc;
}
</style>
