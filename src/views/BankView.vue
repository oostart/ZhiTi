<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  ArrowRight,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  Loader2,
  Maximize2,
  RotateCcw,
  Save,
  ScanText,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X
} from 'lucide-vue-next'
import AppModal from '../components/AppModal.vue'
import ContentEditor from '../components/ContentEditor.vue'
import QuestionPaperView from '../components/QuestionPaperView.vue'
import { addKnowledgePoint, deleteQuestion, paperOf, state, ui, updateQuestion } from '../store'
import { toast } from '../composables/toast'
import { analyzeQuestion, generateAnswer, recommendKnowledge } from '../utils/ai'
import { recognizeImage } from '../utils/ocr'
import { canvasToDataUrl, composeDataUrls, cropCanvas } from '../utils/image'
import { docToPlainText, recognizeQuestionLayout, summarizeContent } from '../utils/layout'
import { getPaperDocument, renderPageToCanvas } from '../utils/pdf'
import { mergeContinuationLines } from '../utils/reflow'
import { DIFFICULTY_LABELS, QUESTION_TYPES, SUBJECTS, TYPE_BADGE_CLASS, GRADES, type ContentDoc, type Question } from '../types'

const keyword = ref(ui.bankKeyword || '')
const filterSubject = ref('')
const filterGrade = ref('')
const filterYear = ref('')
const filterType = ref('')
const filterDifficulty = ref('')
const filterKnowledge = ref('')
const filterPaper = ref('')
const sortBy = ref<'order' | 'new' | 'difficulty'>('order')

const pageIndex = ref(1)
const pageSize = 24
const draft = ref<Question | null>(null)
const dirty = ref(false)
const saving = ref(false)
const aiBusy = ref<'' | 'answer' | 'knowledge' | 'analysis'>('')
const knowledgeInput = ref('')
const pendingDelete = ref<Question | null>(null)
const imagePreview = ref('')
const ocrBusy = ref(false)
const ocrProgress = ref(0)
const ocrStatus = ref('')
const editorTab = ref<'image' | 'content'>('image')
const layoutBusy = ref(false)
const layoutStatus = ref('')
const pendingLayout = ref(false)
const paperOpen = ref(false)
let suppressDirty = false

const activePaper = computed(() => (draft.value ? paperOf(draft.value) : undefined))
const contentStats = computed(() => (draft.value?.content ? summarizeContent(draft.value.content) : null))
const editorContent = computed<ContentDoc>(() => draft.value?.content ?? { type: 'doc', content: [] })
const paperImage = computed(() => draft.value?.image ?? '')
const paperTitle = computed(() => {
  if (!draft.value) return '题目文档'
  const index = state.questions.findIndex((q) => q.id === draft.value!.id) + 1
  return index > 0 ? `第 ${index} 题 · 题目文档` : '题目文档'
})

watch(draft, () => {
  if (!suppressDirty) dirty.value = true
}, { deep: true })

watch(keyword, (value) => {
  ui.bankKeyword = value
  pageIndex.value = 1
})

const years = computed(() => Array.from(new Set(state.papers.map((p) => p.year))).sort((a, b) => b - a))
const knowledgeOptions = computed(() => Array.from(new Set(state.questions.flatMap((q) => q.knowledge))).sort((a, b) => a.localeCompare(b, 'zh-CN')))

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = state.questions.filter((q) => {
    const paper = paperOf(q)
    if (filterSubject.value && paper?.subject !== filterSubject.value) return false
    if (filterGrade.value && paper?.grade !== filterGrade.value) return false
    if (filterYear.value && String(paper?.year) !== filterYear.value) return false
    if (filterPaper.value && String(q.paper_id) !== filterPaper.value) return false
    if (filterType.value && q.question_type !== filterType.value) return false
    if (filterDifficulty.value && String(q.difficulty) !== filterDifficulty.value) return false
    if (filterKnowledge.value && !q.knowledge.includes(filterKnowledge.value)) return false
    if (kw) {
      const haystack = [q.ocr_text, q.answer, q.question_type, q.knowledge.join(' '), paper?.title ?? '', paper?.subject ?? '']
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(kw)) return false
    }
    return true
  })
  if (sortBy.value === 'new') return [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))
  if (sortBy.value === 'difficulty') return [...list].sort((a, b) => b.difficulty - a.difficulty || a.order - b.order)
  return [...list].sort((a, b) => a.order - b.order)
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const paged = computed(() => filtered.value.slice((pageIndex.value - 1) * pageSize, pageIndex.value * pageSize))
const hasFilters = computed(
  () =>
    !!(keyword.value || filterSubject.value || filterGrade.value || filterYear.value || filterType.value || filterDifficulty.value || filterKnowledge.value || filterPaper.value)
)

watch(filtered, () => {
  pageIndex.value = Math.min(pageIndex.value, totalPages.value)
})

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function highlight(text: string): string {
  const kw = keyword.value.trim()
  if (!kw) return escapeHtml(text)
  const pattern = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escapeHtml(text).replace(pattern, '<mark>$1</mark>')
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 110 ? `${clean.slice(0, 110)}…` : clean
}

function resetFilters() {
  keyword.value = ''
  filterSubject.value = ''
  filterGrade.value = ''
  filterYear.value = ''
  filterType.value = ''
  filterDifficulty.value = ''
  filterKnowledge.value = ''
  filterPaper.value = ''
  sortBy.value = 'order'
  pageIndex.value = 1
}

function toggleSelect(id: number) {
  ui.exportIds = ui.exportIds.includes(id) ? ui.exportIds.filter((x) => x !== id) : [...ui.exportIds, id]
}

function selectAllVisible() {
  const ids = new Set(ui.exportIds)
  filtered.value.forEach((q) => ids.add(q.id))
  ui.exportIds = Array.from(ids)
  toast(`已选中 ${ui.exportIds.length} 道题`, 'success', 1800)
}

function clearSelection() {
  ui.exportIds = []
}

function goExport() {
  if (!ui.exportIds.length) {
    toast('请先勾选需要导出的题目', 'warning')
    return
  }
  ui.view = 'export'
}

async function flushDraft(silent = true): Promise<void> {
  if (!draft.value || !dirty.value) return
  await saveDraft(silent)
}

async function openQuestion(question: Question) {
  if (draft.value && dirty.value) await flushDraft(true)
  ui.activeQuestionId = question.id
  suppressDirty = true
  draft.value = {
    ...question,
    knowledge: [...question.knowledge],
    regions: [...question.regions],
    content: question.content ? (JSON.parse(JSON.stringify(question.content)) as ContentDoc) : undefined
  }
  editorTab.value = question.content ? 'content' : 'image'
  paperOpen.value = false
  await nextTick()
  suppressDirty = false
  dirty.value = false
}

async function saveDraft(silent = false) {
  if (!draft.value) return
  saving.value = true
  try {
    const current = draft.value
    await updateQuestion(current.id, {
      ocr_text: current.content ? docToPlainText(current.content) : current.ocr_text,
      content: current.content,
      answer: current.answer,
      difficulty: current.difficulty,
      question_type: current.question_type,
      knowledge: [...current.knowledge],
      analysis: current.analysis
    })
    for (const name of current.knowledge) {
      await addKnowledgePoint(name, paperOf(current)?.subject ?? '')
    }
    dirty.value = false
    if (!silent) toast('已保存题目修改', 'success')
  } catch (error) {
    toast('保存失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    saving.value = false
  }
}

function addKnowledge(name?: string) {
  if (!draft.value) return
  const raw = (name ?? knowledgeInput.value).trim()
  if (!raw) return
  if (!draft.value.knowledge.includes(raw)) draft.value.knowledge.push(raw)
  knowledgeInput.value = ''
}

function removeKnowledge(name: string) {
  if (!draft.value) return
  draft.value.knowledge = draft.value.knowledge.filter((k) => k !== name)
}

function setDifficulty(level: number) {
  if (!draft.value) return
  draft.value.difficulty = level
}

async function runAi(kind: 'answer' | 'knowledge' | 'analysis') {
  if (!draft.value) return
  const text = draft.value.ocr_text.trim()
  if (!text) {
    toast('题目还没有文字内容，请先 OCR 识别或手动填写题干', 'warning')
    return
  }
  aiBusy.value = kind
  try {
    const config = state.settings.ai
    if (kind === 'answer') {
      const result = await generateAnswer(state.settings.ai, {
        text,
        subject: activePaper.value?.subject ?? '',
        grade: activePaper.value?.grade ?? '',
        type: draft.value.question_type,
        answer: draft.value.answer
      })
      draft.value.answer = result
      dirty.value = true
      toast('AI 已生成参考答案，请核对后保存', 'success')
    } else if (kind === 'knowledge') {
      const result = await recommendKnowledge(
        config,
        { text, subject: activePaper.value?.subject ?? '', grade: activePaper.value?.grade ?? '' },
        state.knowledge.map((k) => k.name)
      )
      const subject = activePaper.value?.subject ?? ''
      for (const name of result) {
        await addKnowledgePoint(name, subject)
      }
      for (const name of result) {
        if (!draft.value.knowledge.includes(name)) draft.value.knowledge.push(name)
      }
      dirty.value = true
      toast(`AI 推荐了 ${result.length} 个知识点：${result.join('、')}`, 'success', 4200)
    } else {
      const result = await analyzeQuestion(config, {
        text,
        subject: activePaper.value?.subject ?? '',
        grade: activePaper.value?.grade ?? '',
        answer: draft.value.answer
      })
      draft.value.analysis = result
      dirty.value = true
      toast('AI 已生成题目理解，请核对后保存', 'success')
    }
  } catch (error) {
    toast((error as Error).message || 'AI 调用失败', 'error', 5200)
  } finally {
    aiBusy.value = ''
  }
}

async function runOcr() {
  if (!draft.value) return
  ocrBusy.value = true
  ocrProgress.value = 0.01
  ocrStatus.value = '正在准备 OCR…'
  try {
    const text = await recognizeImage(draft.value.image, state.settings.ocr.lang || 'chi_sim+eng', (progress, status) => {
      ocrProgress.value = progress
      ocrStatus.value = status
    })
    draft.value.ocr_text = text
    dirty.value = true
    toast('OCR 识别完成，请校对后保存', 'success')
  } catch (error) {
    toast('OCR 识别失败：' + ((error as Error).message || '请检查网络连接'), 'error', 5000)
  } finally {
    ocrBusy.value = false
    ocrProgress.value = 0
    ocrStatus.value = ''
  }
}

function updateContent(doc: ContentDoc) {
  if (!draft.value) return
  draft.value.content = doc
  draft.value.ocr_text = docToPlainText(doc)
  dirty.value = true
}

function updateAnswer(value: string) {
  if (!draft.value) return
  draft.value.answer = value
  dirty.value = true
}

function updateAnalysis(value: string) {
  if (!draft.value) return
  draft.value.analysis = value
  dirty.value = true
}

function updateKnowledge(value: string[]) {
  if (!draft.value) return
  draft.value.knowledge = value
  dirty.value = true
}

/** 识别时重新按高分辨率渲染题目区域，避免小下标、分数线丢失 */
async function buildLayoutImage(question: Question): Promise<string> {
  if (!question.paper_id || !question.regions.length) return question.image
  try {
    const doc = await getPaperDocument(question.paper_id)
    const ordered = [...question.regions].sort((a, b) => a.page - b.page || a.y - b.y)
    const pageCanvases = new Map<number, HTMLCanvasElement>()
    const parts: string[] = []
    for (const region of ordered) {
      let canvas = pageCanvases.get(region.page)
      if (!canvas) {
        canvas = await renderPageToCanvas(doc, region.page, 2400)
        pageCanvases.set(region.page, canvas)
      }
      parts.push(canvasToDataUrl(cropCanvas(canvas, region), 0.95))
    }
    if (parts.length === 1) return parts[0]
    return await composeDataUrls(parts, 14, 2200)
  } catch {
    return question.image
  }
}

function requestLayout() {
  if (!draft.value) return
  if (draft.value.content) {
    pendingLayout.value = true
    return
  }
  void runLayout()
}

function relayoutFromPaper() {
  paperOpen.value = false
  requestLayout()
}

function openPaper() {
  if (!draft.value?.content) return
  const merged = mergeContinuationLines(draft.value.content)
  if (merged.changed) {
    draft.value.content = merged.doc
    draft.value.ocr_text = docToPlainText(merged.doc)
    dirty.value = true
    toast('已合并断行，保存后生效', 'success', 2400)
  }
  paperOpen.value = true
}

async function runLayout() {
  pendingLayout.value = false
  if (!draft.value) return
  if (!state.settings.ai.apiKey.trim()) {
    toast('请先在「设置」中填写 AI 接口与密钥', 'warning')
    return
  }
  const question = draft.value
  layoutBusy.value = true
  layoutStatus.value = '正在准备高清题目图…'
  try {
    const recognitionImage = await buildLayoutImage(question)
    layoutStatus.value = '正在请求视觉模型识别…'
    const result = await recognizeQuestionLayout(state.settings.ai, recognitionImage)
    if (!draft.value || draft.value.id !== question.id) return
    draft.value.content = result.content
    draft.value.ocr_text = result.text
    editorTab.value = 'content'
    dirty.value = true
    const summary = `${result.mathCount} 个公式、${result.figureCount} 个图形`
    if (result.warnings.length) {
      const detail = result.warnings.slice(0, 2).join('；')
      toast(`结构化完成：${summary}。需人工确认：${detail}`, 'warning', 6200)
    } else {
      toast(`结构化完成：${summary}，请对照原图校对`, 'success', 3800)
    }
  } catch (error) {
    toast('结构化识别失败：' + ((error as Error).message || '未知错误'), 'error', 6200)
  } finally {
    layoutBusy.value = false
    layoutStatus.value = ''
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return
  const id = pendingDelete.value.id
  await deleteQuestion(id)
  if (ui.activeQuestionId === id) {
    ui.activeQuestionId = null
    draft.value = null
    dirty.value = false
  }
  pendingDelete.value = null
  paperOpen.value = false
  toast('已删除该题目', 'success')
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    if (draft.value && ui.view === 'bank') {
      event.preventDefault()
      void saveDraft()
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (dirty.value) void flushDraft(true)
})
</script>

<template>
  <div class="view">
    <div class="bank-main">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="search-box">
            <Search :size="15" class="search-icon" />
            <input v-model="keyword" class="search-input" placeholder="搜索题干、答案、知识点、试卷标题…" />
            <button v-if="keyword" class="clear-btn" @click="keyword = ''"><X :size="13" /></button>
          </div>

          <select v-model="filterSubject" class="select filter-select">
            <option value="">全部学科</option>
            <option v-for="s in SUBJECTS" :key="s">{{ s }}</option>
          </select>
          <select v-model="filterGrade" class="select filter-select">
            <option value="">全部年级</option>
            <option v-for="g in GRADES" :key="g">{{ g }}</option>
          </select>
          <select v-model="filterYear" class="select filter-select">
            <option value="">全部年份</option>
            <option v-for="y in years" :key="y" :value="String(y)">{{ y }} 年</option>
          </select>
          <select v-model="filterType" class="select filter-select">
            <option value="">全部题型</option>
            <option v-for="t in QUESTION_TYPES" :key="t">{{ t }}</option>
          </select>

          <div class="toolbar-spacer" />

          <button class="btn btn-sm" @click="selectAllVisible"><Check :size="13" /> 全选结果</button>
          <button class="btn btn-primary btn-sm" :disabled="!ui.exportIds.length" @click="goExport">
            导出所选 {{ ui.exportIds.length ? `(${ui.exportIds.length})` : '' }}
            <ArrowRight :size="13" />
          </button>
        </div>

        <div class="filter-row">
          <select v-model="filterKnowledge" class="select filter-select" style="width: 126px">
            <option value="">全部知识点</option>
            <option v-for="k in knowledgeOptions" :key="k">{{ k }}</option>
          </select>
          <select v-model="filterDifficulty" class="select filter-select" style="width: 108px">
            <option value="">全部难度</option>
            <option v-for="(label, level) in DIFFICULTY_LABELS" :key="level" :value="String(level)">{{ level }} · {{ label }}</option>
          </select>
          <select v-model="filterPaper" class="select filter-select" style="width: 152px">
            <option value="">全部出处</option>
            <option v-for="p in state.papers" :key="p.id" :value="String(p.id)">{{ p.title }}</option>
          </select>
          <select v-model="sortBy" class="select filter-select" style="width: 116px">
            <option value="order">按录入顺序</option>
            <option value="new">最新优先</option>
            <option value="difficulty">难度从高到低</option>
          </select>
          <button v-if="hasFilters" class="btn btn-ghost btn-sm" @click="resetFilters"><RotateCcw :size="12" /> 重置筛选</button>

          <div class="toolbar-spacer" />
          <div v-if="ui.exportIds.length" class="selection-chip">
            已选 <strong>{{ ui.exportIds.length }}</strong> 道题
            <button class="chip-remove" @click="clearSelection"><X :size="11" /></button>
          </div>
        </div>
      </div>

      <div class="list-header">
        <div class="hint">
          共 <strong style="color: var(--text)">{{ filtered.length }}</strong> 道题
          <span v-if="ui.exportIds.length"> · 已选 {{ ui.exportIds.length }} 道</span>
        </div>
        <div v-if="filtered.length" class="hint">第 {{ (pageIndex - 1) * pageSize + 1 }}–{{ Math.min(pageIndex * pageSize, filtered.length) }} 条</div>
      </div>

      <div class="bank-content">
        <div v-if="!state.questions.length" class="empty">
          <div class="empty-icon"><Filter :size="24" /></div>
          <div class="empty-title">题库是空的</div>
          <div class="empty-desc">导入一份 PDF 试卷并完成题目切割后，题目会自动进入这里，可检索、编辑与导出。</div>
          <button class="btn btn-primary" @click="ui.view = 'import'">去导入试卷</button>
        </div>

        <div v-else-if="!filtered.length" class="empty">
          <div class="empty-icon"><Search :size="24" /></div>
          <div class="empty-title">没有匹配的题目</div>
          <div class="empty-desc">尝试更换关键词，或减少筛选条件。</div>
          <button class="btn" @click="resetFilters"><RotateCcw :size="14" /> 重置筛选</button>
        </div>

        <div v-else class="q-grid">
          <div
            v-for="question in paged"
            :key="question.id"
            class="q-card"
            :class="{ selected: ui.exportIds.includes(question.id), editing: ui.activeQuestionId === question.id }"
            @click="openQuestion(question)"
          >
            <div class="q-thumb">
              <img v-if="question.image" :src="question.image" loading="lazy" />
              <div class="q-check" @click.stop="toggleSelect(question.id)">
                <Check v-if="ui.exportIds.includes(question.id)" :size="13" />
              </div>
              <div class="q-thumb-index">#{{ state.questions.findIndex((q) => q.id === question.id) + 1 }}</div>
            </div>
            <div class="q-body">
              <div class="q-text" v-html="question.ocr_text ? highlight(snippet(question.ocr_text)) : '<span style=\'color:#a2a9b8\'>（无识别文字，可在编辑面板 OCR）</span>'"></div>
              <div class="q-meta">
                <span class="badge" :class="TYPE_BADGE_CLASS[question.question_type] || 'badge-gray'">{{ question.question_type }}</span>
                <span class="chip" style="height: 20px; font-size: 11px">
                  <Star :size="10" /> 难度 {{ question.difficulty }}
                </span>
                <span v-if="question.knowledge.length" class="chip" style="height: 20px; font-size: 11px; max-width: 116px; overflow: hidden; text-overflow: ellipsis">
                  <Tag :size="10" /> {{ question.knowledge[0] }}{{ question.knowledge.length > 1 ? ` +${question.knowledge.length - 1}` : '' }}
                </span>
              </div>
              <div class="q-source">{{ paperOf(question)?.title || '未关联试卷' }}</div>
            </div>
          </div>
        </div>

        <div v-if="totalPages > 1" class="pager">
          <button class="btn btn-sm" :disabled="pageIndex <= 1" @click="pageIndex = Math.max(1, pageIndex - 1)"><ChevronLeft :size="13" /> 上一页</button>
          <span class="hint">第 {{ pageIndex }} / {{ totalPages }} 页</span>
          <button class="btn btn-sm" :disabled="pageIndex >= totalPages" @click="pageIndex = Math.min(totalPages, pageIndex + 1)">下一页 <ChevronRight :size="13" /></button>
        </div>
      </div>
    </div>

    <aside class="inspector">
      <div v-if="!draft" class="empty" style="padding: 60px 16px">
        <div class="empty-icon"><Brain :size="22" /></div>
        <div class="empty-title">题目编辑面板</div>
        <div class="empty-desc">从左侧选择一道题目，可将题目结构化为「文字 + 公式 + 图形」，校对后补充答案与知识点。</div>
      </div>

      <template v-else>
        <div class="editor-head">
          <div style="min-width: 0">
            <div style="font-size: 13px; font-weight: 650; display: flex; align-items: center; gap: 6px">
              第 {{ draft ? state.questions.findIndex((q) => q.id === draft?.id) + 1 : '' }} 题
              <span v-if="dirty" class="badge badge-amber">未保存</span>
            </div>
            <div class="hint" style="margin-top: 3px">{{ activePaper?.title || '未关联试卷' }}</div>
          </div>
          <button class="btn btn-primary btn-sm" :disabled="saving || !dirty" @click="saveDraft()">
            <Loader2 v-if="saving" :size="12" class="spin" />
            <Save v-else :size="12" /> 保存
          </button>
        </div>

        <div class="editor-tabs">
          <button class="editor-tab" :class="{ active: editorTab === 'image' }" @click="editorTab = 'image'">原图 / 文字</button>
          <button class="editor-tab" :class="{ active: editorTab === 'content' }" @click="editorTab = 'content'">
            结构化内容
            <span v-if="draft.content" class="tab-badge">已识别</span>
          </button>
        </div>

        <template v-if="editorTab === 'image'">
          <div class="editor-image" @click="imagePreview = draft?.image || ''">
            <img v-if="draft.image" :src="draft.image" />
          </div>

          <div v-if="draft.content" class="field">
            <label class="label">正文（由结构化内容自动生成）</label>
            <textarea class="textarea" rows="4" :value="docToPlainText(draft.content)" readonly />
            <div class="hint" style="margin-top: 4px">如需修改文字，请切换到「结构化内容」。</div>
          </div>

          <div v-else class="field">
            <div class="label-row">
              <label class="label" style="margin: 0">题干文字（OCR 结果）</label>
              <button class="btn btn-ghost btn-sm" :disabled="ocrBusy" @click="runOcr">
                <Loader2 v-if="ocrBusy" :size="12" class="spin" />
                <ScanText v-else :size="12" /> OCR 识别
              </button>
            </div>
            <textarea v-model="draft.ocr_text" class="textarea" rows="5" placeholder="识别后的题干内容，支持人工校对…" />
            <div v-if="ocrBusy" class="ocr-progress">
              <div class="progress" style="flex: 1">
                <div class="progress-bar" :style="{ width: Math.round(ocrProgress * 100) + '%' }" />
              </div>
              <span class="hint">{{ ocrStatus }} {{ Math.round(ocrProgress * 100) }}%</span>
            </div>
            <div class="hint" style="margin-top: 4px">{{ draft.ocr_text.length }} 字 · OCR 结果请务必人工校对</div>
          </div>
        </template>

        <div v-else class="content-pane">
          <div v-if="!draft.content" class="content-empty">
            <div class="content-empty-title">还没有结构化内容</div>
            <div class="hint">把题目识别成「文字 + 公式 + 图形块」，识别后可逐题对照校对。</div>
            <button class="btn btn-primary btn-sm" :disabled="layoutBusy" @click="requestLayout">
              <Loader2 v-if="layoutBusy" :size="12" class="spin" />
              <Sparkles v-else :size="12" /> 识别并结构化
            </button>
            <div v-if="layoutBusy" class="hint">{{ layoutStatus }}</div>
            <div v-else class="hint">需要先在「设置」中填写支持图片输入的视觉模型。</div>
          </div>

          <template v-else>
            <div class="content-toolbar">
              <div class="hint">
                {{ contentStats?.paragraphs }} 段 · {{ contentStats?.math }} 公式 · {{ contentStats?.figures }} 图形
                <span v-if="contentStats?.unresolved"> · {{ contentStats?.unresolved }} 个待确认</span>
              </div>
              <div class="content-toolbar-actions">
                <button class="btn btn-ghost btn-sm" :disabled="layoutBusy" @click="requestLayout">
                  <Loader2 v-if="layoutBusy" :size="12" class="spin" />
                  <ScanText v-else :size="12" /> 重新识别
                </button>
                <button class="btn btn-primary btn-sm" @click="openPaper">
                  <Maximize2 :size="12" /> 打开题目文档
                </button>
              </div>
            </div>
            <div v-if="layoutBusy" class="hint" style="margin-bottom: 6px">{{ layoutStatus }}</div>
            <div class="paper-mini" @click="openPaper">
              <ContentEditor :model-value="editorContent" variant="paper" readonly />
            </div>
            <div class="hint" style="margin-top: 6px">点击预览打开题目文档；AI 生成请打开文档，公式可点开改 LaTeX。</div>
          </template>
        </div>

        <div class="field">
          <label class="label">参考答案</label>
          <textarea v-model="draft.answer" class="textarea" rows="3" placeholder="尚未填写答案，可使用 AI 生成后校对" />
        </div>

        <div class="row-2">
          <div class="field">
            <label class="label">题型</label>
            <select v-model="draft.question_type" class="select">
              <option v-for="t in QUESTION_TYPES" :key="t">{{ t }}</option>
            </select>
          </div>
          <div class="field">
            <label class="label">难度</label>
            <div class="difficulty-picker">
              <button
                v-for="level in 5"
                :key="level"
                class="difficulty-dot"
                :class="{ active: draft.difficulty >= level }"
                :title="DIFFICULTY_LABELS[level]"
                @click.stop="setDifficulty(level)"
              >
                <Star :size="14" />
              </button>
            </div>
            <div class="hint" style="margin-top: 2px">{{ DIFFICULTY_LABELS[draft.difficulty] }}</div>
          </div>
        </div>

        <div class="field">
          <label class="label">知识点</label>
          <div class="knowledge-chips">
            <span v-for="name in draft.knowledge" :key="name" class="chip active">
              {{ name }}
              <button class="chip-remove" @click="removeKnowledge(name)"><X :size="11" /></button>
            </span>
            <span v-if="!draft.knowledge.length" class="hint">尚未标注知识点</span>
          </div>
          <div class="knowledge-add">
            <input
              v-model="knowledgeInput"
              class="input"
              placeholder="输入知识点，回车添加"
              @keydown.enter.prevent="addKnowledge()"
            />
            <button class="btn btn-sm" @click="addKnowledge()">添加</button>
          </div>
        </div>

        <div class="field">
          <label class="label">题目理解（AI 分析）</label>
          <textarea v-model="draft.analysis" class="textarea" rows="4" placeholder="考查知识点、情境模型与解题思路…" />
        </div>

        <div class="editor-actions">
          <button class="btn btn-danger btn-sm" @click="pendingDelete = draft"><Trash2 :size="13" /> 删除题目</button>
          <span class="hint" style="margin-left: auto"><span class="kbd">Ctrl</span> + <span class="kbd">S</span> 保存</span>
        </div>
      </template>
    </aside>

    <AppModal v-if="pendingDelete" title="删除这道题目？" @close="pendingDelete = null">
      <template #description>题目图片与文字记录将被移除，无法恢复。</template>
      <div class="hint">{{ snippet(pendingDelete.ocr_text || '（无文字）') }}</div>
      <template #actions>
        <button class="btn" @click="pendingDelete = null">取消</button>
        <button class="btn btn-danger" @click="confirmDelete"><Trash2 :size="14" /> 确认删除</button>
      </template>
    </AppModal>

    <AppModal v-if="pendingLayout" title="重新识别这道题？" @close="pendingLayout = false">
      <template #description>当前的结构化内容会被新的识别结果覆盖，原图与答案不受影响。</template>
      <template #actions>
        <button class="btn" @click="pendingLayout = false">取消</button>
        <button class="btn btn-primary" @click="runLayout"><Sparkles :size="14" /> 重新识别</button>
      </template>
    </AppModal>

    <QuestionPaperView
      v-if="paperOpen && draft?.content"
      :model-value="editorContent"
      :image="paperImage"
      :title="paperTitle"
      :dirty="dirty"
      :answer="draft.answer"
      :analysis="draft.analysis"
      :knowledge="draft.knowledge"
      :ai-busy="aiBusy"
      @update:model-value="updateContent"
      @update:answer="updateAnswer"
      @update:analysis="updateAnalysis"
      @update:knowledge="updateKnowledge"
      @ai="runAi"
      @save="saveDraft()"
      @relayout="relayoutFromPaper"
      @close="paperOpen = false"
    />

    <AppModal v-if="imagePreview" title="题目图片预览" :width="720" @close="imagePreview = ''">
      <img :src="imagePreview" style="width: 100%; border-radius: 8px; border: 1px solid var(--border)" />
    </AppModal>
  </div>
</template>

<style scoped>
.bank-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.filter-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid var(--border);
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.search-box {
  position: relative;
  width: 236px;
  flex-shrink: 0;
}
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
}
.search-input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0 26px 0 31px;
  font-size: 13px;
  outline: none;
  transition: border 0.15s, box-shadow 0.15s;
}
.search-input:focus {
  border-color: #a5a0f5;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}
.clear-btn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  border: 0;
  background: transparent;
  color: var(--text-3);
  display: grid;
  place-items: center;
  padding: 3px;
  border-radius: 4px;
}
.clear-btn:hover {
  background: #f0f2f8;
}
.filter-select {
  width: 96px;
  height: 32px;
  padding-top: 0;
  padding-bottom: 0;
  font-size: 12.5px;
}
.selection-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  background: var(--accent-soft);
  border: 1px solid #d2d0fa;
  color: var(--accent-dark);
  border-radius: 999px;
  font-size: 11.5px;
}
.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 18px 0;
}
.bank-content {
  flex: 1;
  overflow: auto;
  padding: 12px 18px 24px;
}
.q-card.editing {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.18);
}
.q-thumb-index {
  position: absolute;
  left: 7px;
  top: 7px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  font-weight: 600;
}
.q-source {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-top: 1px dashed #eef0f5;
  padding-top: 6px;
  margin-top: 2px;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 22px 0 8px;
}
.editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.editor-image {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: #fafbfe;
  overflow: hidden;
  margin-bottom: 14px;
  cursor: zoom-in;
  max-height: 220px;
  display: flex;
  justify-content: center;
}
.editor-image img {
  width: 100%;
  object-fit: contain;
  object-position: top;
  max-height: 220px;
}
.editor-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.editor-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s;
}
.editor-tab:hover {
  background: #f4f5fb;
}
.editor-tab.active {
  border-color: #d7d5fb;
  background: #eef2ff;
  color: #4338ca;
  font-weight: 600;
}
.tab-badge {
  padding: 0 5px;
  border-radius: 999px;
  background: #dcfce7;
  color: #15803d;
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
}
.content-pane {
  margin-bottom: 14px;
}
.content-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 18px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: #fafbfe;
}
.content-empty-title {
  font-size: 13px;
  font-weight: 600;
}
.content-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.content-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.paper-mini {
  position: relative;
  max-height: 340px;
  overflow: hidden;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 9px;
  cursor: zoom-in;
  --paper-base-size: 12px;
  --paper-line-height: 1.8;
}
.paper-mini :deep(.content-editor) {
  pointer-events: none;
}
.paper-mini::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 44px;
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0), #fff);
  pointer-events: none;
}
.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.chip-remove {
  border: 0;
  background: transparent;
  color: inherit;
  display: grid;
  place-items: center;
  padding: 0;
  margin-left: 1px;
  opacity: 0.65;
}
.chip-remove:hover {
  opacity: 1;
}
.knowledge-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  min-height: 24px;
  align-items: center;
}
.knowledge-add {
  display: flex;
  gap: 6px;
}
.difficulty-picker {
  display: flex;
  gap: 3px;
  padding-top: 3px;
}
.difficulty-dot {
  border: 0;
  background: transparent;
  color: #d5dae6;
  padding: 3px;
  border-radius: 5px;
  transition: color 0.12s, background 0.12s;
  display: grid;
  place-items: center;
}
.difficulty-dot:hover {
  background: #f4f5fb;
}
.difficulty-dot.active {
  color: #f59e0b;
}
.editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.ocr-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.spin {
  animation: spin 0.8s linear infinite;
}
</style>
