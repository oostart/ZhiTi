<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import {
  addKnowledgePoint,
  deleteQuestion,
  paperOf,
  removePendingAnswer,
  state,
  ui,
  updateQuestion,
  type PendingAnswer
} from '../store'
import { toast } from '../composables/toast'
import { analyzeQuestion, recommendKnowledge } from '../utils/ai'
import {
  docToPlainText,
  hasContentDoc,
  recognizeAnswerLayout,
  recognizeQuestionLayout,
  summarizeContent
} from '../utils/layout'
import { buildLayoutImage, buildRegionsImage } from '../utils/layoutImage'
import { mergeContinuationLines } from '../utils/reflow'
import { answerTag, questionTag } from '../utils/label'
import { compressImage } from '../utils/image'
import { DIFFICULTY_LABELS, QUESTION_TYPES, TYPE_BADGE_CLASS, GRADES, type AnswerBlock, type ContentDoc, type Question } from '../types'

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
const aiBusy = ref<'' | 'knowledge' | 'analysis'>('')
const answerRecognizing = ref(false)
const answerPickTargetId = ref<number | null>(null)
const answerPickBusy = ref(false)
const answerPickStep = ref('')
const answerPickError = ref('')
const answerOverwriteTarget = ref<Question | null>(null)
const pendingDelete = ref<Question | null>(null)
const imagePreview = ref('')
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
  return `${questionLabelOf(draft.value)} · 题目文档`
})
const activePending = computed(() => ui.pendingAnswers.find((item) => item.id === ui.activePendingAnswerId) ?? null)
/** 当前答案框在其来源试卷内的序号（从 1 开始） */
const activePendingIndex = computed(() => {
  const pending = activePending.value
  if (!pending) return 0
  return ui.pendingAnswers.filter((item) => item.paperId === pending.paperId).findIndex((item) => item.id === pending.id) + 1
})
const answerPickPaper = computed(() => {
  const pending = activePending.value
  return pending ? state.papers.find((p) => p.id === pending.paperId) ?? null : null
})
const activePendingLabel = computed(() => answerTag(answerPickPaper.value?.subject, activePendingIndex.value))
const answerPickTarget = computed(() => state.questions.find((q) => q.id === answerPickTargetId.value) ?? null)
const answerPickSummary = computed(() => {
  const question = answerPickTarget.value
  if (!question) return ''
  const line = (question.text || '').split('\n').map((item) => item.trim()).find(Boolean) || '（无题干文字）'
  return `${questionLabelOf(question)} · ${paperOf(question)?.title || '未关联试卷'} · ${line}`
})
const answerOverwriteLabel = computed(() =>
  answerOverwriteTarget.value ? questionLabelOf(answerOverwriteTarget.value) : ''
)

watch(draft, () => {
  if (!suppressDirty) dirty.value = true
}, { deep: true })

watch(keyword, (value) => {
  ui.bankKeyword = value
  pageIndex.value = 1
})

watch(
  () => [ui.pendingAnswers.length, ui.activePendingAnswerId] as const,
  () => {
    answerPickTargetId.value = null
    validatePendingAnswer()
  }
)

const years = computed(() => Array.from(new Set(state.papers.map((p) => p.year))).sort((a, b) => b - a))
const subjectOptions = computed(() =>
  Array.from(new Set(state.papers.map((p) => p.subject.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
)
const gradeOptions = computed(() => {
  const rank = (grade: string) => {
    const index = GRADES.indexOf(grade)
    return index === -1 ? GRADES.length : index
  }
  return Array.from(new Set(state.papers.map((p) => p.grade.trim()).filter(Boolean))).sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh-CN')
  )
})
const knowledgeOptions = computed(() => Array.from(new Set(state.questions.flatMap((q) => q.knowledge))).sort((a, b) => a.localeCompare(b, 'zh-CN')))

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = state.questions.filter((q) => {
    const paper = paperOf(q)
    if (filterSubject.value && (paper?.subject ?? '').trim() !== filterSubject.value) return false
    if (filterGrade.value && (paper?.grade ?? '').trim() !== filterGrade.value) return false
    if (filterYear.value && String(paper?.year) !== filterYear.value) return false
    if (filterPaper.value && String(q.paper_id) !== filterPaper.value) return false
    if (filterType.value && q.question_type !== filterType.value) return false
    if (filterDifficulty.value && String(q.difficulty) !== filterDifficulty.value) return false
    if (filterKnowledge.value && !q.knowledge.includes(filterKnowledge.value)) return false
    if (kw) {
      const haystack = [q.text, q.answer, q.question_type, q.knowledge.join(' '), paper?.title ?? '', paper?.subject ?? '']
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

watch(subjectOptions, (options) => {
  if (filterSubject.value && !options.includes(filterSubject.value)) filterSubject.value = ''
})

watch(gradeOptions, (options) => {
  if (filterGrade.value && !options.includes(filterGrade.value)) filterGrade.value = ''
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

/** 题目在其所属试卷内的序号（从 1 开始） */
function questionIndexInPaper(question: Question): number {
  return state.questions.filter((q) => q.paper_id === question.paper_id).findIndex((q) => q.id === question.id) + 1
}

/** 题目编号：学科 + 该试卷内序号，如「物理3」 */
function questionLabelOf(question: Question): string {
  return questionTag(paperOf(question)?.subject, questionIndexInPaper(question))
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
    content: question.content ? (JSON.parse(JSON.stringify(question.content)) as ContentDoc) : undefined,
    answerBlocks: question.answerBlocks ? (JSON.parse(JSON.stringify(question.answerBlocks)) as AnswerBlock[]) : undefined
  }
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
      text: current.content ? docToPlainText(current.content) : current.text,
      content: current.content,
      answer: current.answer,
      answerImage: current.answerImage,
      answerBlocks: current.answerBlocks,
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

async function runAi(kind: 'knowledge' | 'analysis') {
  if (!draft.value) return
  const text = (draft.value.content ? docToPlainText(draft.value.content) : draft.value.text).trim()
  if (!text) {
    toast('题目还没有文字内容，请先生成题目文档或手动补充题干', 'warning')
    return
  }
  aiBusy.value = kind
  try {
    const config = state.settings.ai
    if (kind === 'knowledge') {
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

/** 题目文档「AI 识别答案」与切割页「添加答案」共用的识别流程，保证两条入口结果一致 */
async function recognizeAnswer(imageDataUrl: string) {
  return await recognizeAnswerLayout(state.settings.ai, imageDataUrl)
}

async function recognizeAnswerFromImage(imageDataUrl: string) {
  if (!draft.value) return
  answerRecognizing.value = true
  try {
    const result = await recognizeAnswer(imageDataUrl)
    const replaced = !!draft.value.answer.trim() || !!draft.value.answerBlocks?.length
    draft.value.answer = result.text
    draft.value.answerBlocks = result.blocks
    dirty.value = true
    const figures = result.figureCount ? `，含 ${result.figureCount} 张插图` : ''
    const head = replaced ? '已用识别结果替换原答案' : '已识别并填入参考答案'
    if (result.warnings.length) {
      toast(`${head}${figures}。需人工确认：${result.warnings.slice(0, 2).join('；')}`, 'warning', 6200)
    } else {
      toast(`${head}${figures}，请核对后保存`, 'success', 4200)
    }
  } catch (error) {
    toast('答案识别失败：' + ((error as Error).message || '未知错误'), 'error', 5200)
  } finally {
    answerRecognizing.value = false
  }
}

function exitAnswerPick() {
  answerPickTargetId.value = null
  answerPickStep.value = ''
  answerPickError.value = ''
  answerOverwriteTarget.value = null
}

/** 待处理答案区域失效时移除该框并给出提示 */
function validatePendingAnswer() {
  const pending = activePending.value
  if (!pending) {
    answerPickTargetId.value = null
    return
  }
  if (!state.papers.some((paper) => paper.id === pending.paperId)) {
    removePendingAnswer(pending.id)
    exitAnswerPick()
    toast('答案区域信息已失效（原试卷可能已被删除），请回到「题目切割」重新框选', 'warning', 5600)
    return
  }
  const region = pending.region
  if (!region || !(region.w > 0) || !(region.h > 0)) {
    removePendingAnswer(pending.id)
    exitAnswerPick()
    toast('答案区域信息不完整，请回到「题目切割」重新框选', 'warning', 5600)
  }
}

function onQuestionCardClick(question: Question) {
  if (!activePending.value) {
    void openQuestion(question)
    return
  }
  answerPickTargetId.value = question.id
  answerPickError.value = ''
}

function startAnswerFill() {
  if (answerPickBusy.value) return
  const target = answerPickTarget.value
  const pending = activePending.value
  if (!target || !pending) {
    toast('请先在题库中点击一道题目作为目标', 'warning')
    return
  }
  answerPickError.value = ''
  if (!state.settings.ai.apiKey.trim()) {
    toast('请先在「设置」中填写 AI 接口与密钥', 'warning')
    return
  }
  if (target.answer.trim()) {
    answerOverwriteTarget.value = target
    return
  }
  void runAnswerFill(target, pending)
}

function confirmAnswerOverwrite() {
  const target = answerOverwriteTarget.value
  const pending = activePending.value
  answerOverwriteTarget.value = null
  if (target && pending) void runAnswerFill(target, pending)
}

async function runAnswerFill(target: Question, pending: PendingAnswer) {
  answerPickBusy.value = true
  answerPickError.value = ''
  answerPickStep.value = '正在读取答案区域原图…'
  let step = '答案图读取'
  try {
    const rawImage = await buildRegionsImage(pending.paperId, [pending.region])
    if (!rawImage) throw new Error('无法读取答案区域原图，原试卷可能已被删除，请回到「题目切割」重新框选')
    const answerImage = await compressImage(rawImage).catch(() => rawImage)
    let question = state.questions.find((q) => q.id === target.id) ?? target
    const hadContent = hasContentDoc(question.content)
    if (!hadContent) {
      step = '原图识别'
      answerPickStep.value = '步骤 1/2 · 正在识别原图生成题目文档…'
      const layoutImage = await buildLayoutImage(question)
      const layout = await recognizeQuestionLayout(state.settings.ai, layoutImage)
      await updateQuestion(question.id, { content: layout.content, text: layout.text })
      question = state.questions.find((q) => q.id === target.id) ?? question
    }
    step = '答案识别'
    answerPickStep.value = hadContent ? '步骤 1/1 · 正在识别答案…' : '步骤 2/2 · 正在识别答案…'
    const recognized = await recognizeAnswer(answerImage)
    step = '答案写入'
    answerPickStep.value = '正在写入参考答案…'
    await updateQuestion(question.id, { answer: recognized.text, answerBlocks: recognized.blocks, answerImage })
    const targetLabel = questionLabelOf(question)
    const pendingSubject = state.papers.find((p) => p.id === pending.paperId)?.subject
    const pendingNo =
      ui.pendingAnswers.filter((item) => item.paperId === pending.paperId).findIndex((item) => item.id === pending.id) + 1
    const pendingLabel = answerTag(pendingSubject, pendingNo)
    removePendingAnswer(pending.id)
    exitAnswerPick()
    const remains = ui.pendingAnswers.length
    const figures = recognized.figureCount ? `（含 ${recognized.figureCount} 张插图）` : ''
    toast(
      remains
        ? `已写入「${targetLabel}」的参考答案${figures}并移除「${pendingLabel}」，还有 ${remains} 个答案框待处理`
        : `已写入「${targetLabel}」的参考答案${figures}，请核对`,
      'success',
      4200
    )
  } catch (error) {
    answerPickError.value = `${step}失败：${(error as Error).message || '未知错误'}`
    toast(answerPickError.value, 'error', 5600)
  } finally {
    answerPickBusy.value = false
    answerPickStep.value = ''
  }
}

function cancelAnswerPick() {
  if (answerPickBusy.value) return
  const pending = activePending.value
  if (!pending) {
    exitAnswerPick()
    return
  }
  const label = activePendingLabel.value
  removePendingAnswer(pending.id)
  exitAnswerPick()
  const remains = ui.pendingAnswers.length
  toast(remains ? `已取消「${label}」，还有 ${remains} 个答案框待处理` : `已取消「${label}」`, 'info', 2800)
}

function updateContent(doc: ContentDoc) {
  if (!draft.value) return
  draft.value.content = doc
  draft.value.text = docToPlainText(doc)
  dirty.value = true
}

function updateAnswer(value: string) {
  if (!draft.value) return
  draft.value.answer = value
  // 手动编辑按纯文本保存：文字在前，原有图片块保留为附图，避免悄悄丢图
  const figures = (draft.value.answerBlocks ?? []).filter((block): block is AnswerBlock & { type: 'image' } => block.type === 'image')
  draft.value.answerBlocks = figures.length ? [{ type: 'text', text: value }, ...figures] : undefined
  dirty.value = true
}

function updateAnswerImage(value: string) {
  if (!draft.value) return
  const next = value || undefined
  const hadBlocks = !!draft.value.answerBlocks?.length
  // 答案块里的裁剪坐标依赖原图，换图/删图后必须失效，避免按旧坐标截出错图
  if (next !== draft.value.answerImage) draft.value.answerBlocks = undefined
  draft.value.answerImage = next
  dirty.value = true
  if (hadBlocks) {
    toast(
      next === undefined
        ? '已移除答案原图，原有答案块（含插图）已清除'
        : '已更换答案原图，原有答案块（含插图定位）已清除，可重新识别',
      'warning',
      4600
    )
  }
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

function updateQuestionType(value: string) {
  if (!draft.value) return
  draft.value.question_type = value
  dirty.value = true
}

function updateDifficulty(value: number) {
  if (!draft.value) return
  draft.value.difficulty = value
  dirty.value = true
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
    draft.value.text = docToPlainText(merged.doc)
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
    draft.value.text = result.text
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

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  validatePendingAnswer()
  const pendingId = ui.pendingPaperId
  if (pendingId == null) return
  ui.pendingPaperId = null
  const question = state.questions.find((q) => q.id === pendingId)
  if (!question) return
  await openQuestion(question)
  if (question.content) openPaper()
  else toast('该题还没有题目文档，请先生成题目文档', 'warning', 4200)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (dirty.value) void flushDraft(true)
})
</script>

<template>
  <div class="view" :class="{ 'answer-picking': !!activePending }">
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
            <option v-for="s in subjectOptions" :key="s">{{ s }}</option>
          </select>
          <select v-model="filterGrade" class="select filter-select">
            <option value="">全部年级</option>
            <option v-for="g in gradeOptions" :key="g">{{ g }}</option>
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
            :class="{
              selected: ui.exportIds.includes(question.id),
              editing: !activePending && ui.activeQuestionId === question.id,
              'answer-target': !!activePending && answerPickTargetId === question.id
            }"
            @click="onQuestionCardClick(question)"
          >
            <div class="q-thumb">
              <img v-if="question.image" :src="question.image" loading="lazy" />
              <div class="q-check" @click.stop="toggleSelect(question.id)">
                <Check v-if="ui.exportIds.includes(question.id)" :size="13" />
              </div>
              <div class="q-thumb-index">{{ questionLabelOf(question) }}</div>
            </div>
            <div class="q-body">
              <div class="q-text" v-html="question.text ? highlight(snippet(question.text)) : '<span style=\'color:#a2a9b8\'>（暂无题干文字，可生成题目文档）</span>'"></div>
              <div class="q-meta">
                <span class="badge" :class="TYPE_BADGE_CLASS[question.question_type] || 'badge-gray'">{{ question.question_type }}</span>
                <span class="chip" style="height: 20px; font-size: 11px">
                  <Star :size="10" /> 难度 {{ question.difficulty }}
                </span>
                <span v-if="question.knowledge.length" class="chip" style="height: 20px; font-size: 11px; max-width: 116px; overflow: hidden; text-overflow: ellipsis">
                  <Tag :size="10" /> {{ question.knowledge[0] }}{{ question.knowledge.length > 1 ? ` +${question.knowledge.length - 1}` : '' }}
                </span>
                <span v-if="question.answer.trim()" class="badge badge-amber">已有答案</span>
                <span
                  v-if="!(paperOf(question)?.subject ?? '').trim()"
                  class="badge badge-gray"
                  title="该题所属试卷未填写学科，可到「试卷导入」编辑试卷补填"
                >
                  未设学科
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
        <div class="empty-desc">从左侧选择一道题目，可将题目结构化为「文字 + 公式 + 图形」，校对后可在题目文档中完善答案、知识点与解析。</div>
      </div>

      <template v-else>
        <div class="editor-head">
          <div style="min-width: 0">
            <div style="font-size: 13px; font-weight: 650; display: flex; align-items: center; gap: 6px">
              {{ draft ? questionLabelOf(draft) : '' }}
              <span v-if="dirty" class="badge badge-amber">未保存</span>
            </div>
            <div class="hint" style="margin-top: 3px">{{ activePaper?.title || '未关联试卷' }}</div>
          </div>
          <button class="btn btn-primary btn-sm" :disabled="saving || !dirty" @click="saveDraft()">
            <Loader2 v-if="saving" :size="12" class="spin" />
            <Save v-else :size="12" /> 保存
          </button>
        </div>

        <div class="content-pane">
          <div v-if="draft.image" class="editor-image" title="点击放大查看" @click="imagePreview = draft.image">
            <img :src="draft.image" alt="题目原图" />
          </div>
          <div v-else class="editor-image-placeholder">暂无题目原图</div>

          <div v-if="!draft.content" class="content-empty">
            <button class="btn btn-primary btn-sm" :disabled="layoutBusy" @click="requestLayout">
              <Loader2 v-if="layoutBusy" :size="12" class="spin" />
              <Sparkles v-else :size="12" /> AI识别
            </button>
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
                  <Sparkles v-else :size="12" /> 重新识别
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

        <div class="editor-actions">
          <button class="btn btn-danger btn-sm" @click="pendingDelete = draft"><Trash2 :size="13" /> 删除题目</button>
          <span class="hint" style="margin-left: auto"><span class="kbd">Ctrl</span> + <span class="kbd">S</span> 保存</span>
        </div>
      </template>
    </aside>

    <AppModal v-if="pendingDelete" title="删除这道题目？" @close="pendingDelete = null">
      <template #description>题目图片与文字记录将被移除，无法恢复。</template>
      <div class="hint">{{ snippet(pendingDelete.text || '（无文字）') }}</div>
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

    <div v-if="activePending" class="answer-pick-bar">
      <div class="answer-pick-main">
        <div class="answer-pick-mode">
          <Sparkles :size="13" />
          正在为 <span class="answer-pick-tag">{{ activePendingLabel }}</span> 选择题目
          <span class="answer-pick-source">
            第 {{ activePending.region.page }} 页 · 「{{ answerPickPaper?.title || '已删除的试卷' }}」
          </span>
          <span v-if="ui.pendingAnswers.length > 1" class="answer-pick-count">共 {{ ui.pendingAnswers.length }} 个答案框待处理</span>
        </div>
        <div v-if="answerPickBusy" class="answer-pick-progress">
          <Loader2 :size="13" class="spin" />
          <span>{{ answerPickStep || '正在处理…' }}</span>
        </div>
        <div v-else-if="answerPickError" class="answer-pick-error">{{ answerPickError }}</div>
        <div v-else class="answer-pick-target">
          {{ answerPickSummary || '点击下方任意题目卡片，选中要填入答案的题目' }}
        </div>
      </div>
      <div class="answer-pick-actions">
        <button class="btn btn-ghost btn-sm" :disabled="answerPickBusy" @click="cancelAnswerPick">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="!answerPickTargetId || answerPickBusy" @click="startAnswerFill">
          <Loader2 v-if="answerPickBusy" :size="13" class="spin" />
          <Sparkles v-else :size="13" />
          识别并填入
        </button>
      </div>
    </div>

    <AppModal v-if="answerOverwriteTarget" title="覆盖已有答案？" @close="answerOverwriteTarget = null">
      <template #description>
        「{{ answerOverwriteLabel }}」已有参考答案，识别结果将覆盖原答案。
      </template>
      <div class="hint">{{ snippet(answerOverwriteTarget.text || '（无题干文字）') }}</div>
      <template #actions>
        <button class="btn" @click="answerOverwriteTarget = null">取消</button>
        <button class="btn btn-primary" @click="confirmAnswerOverwrite">
          <Sparkles :size="14" /> 覆盖并识别
        </button>
      </template>
    </AppModal>

    <QuestionPaperView
      v-if="paperOpen && draft?.content"
      :model-value="editorContent"
      :image="paperImage"
      :title="paperTitle"
      :dirty="dirty"
      :answer="draft.answer"
      :answer-blocks="draft.answerBlocks || []"
      :answer-image="draft.answerImage || ''"
      :analysis="draft.analysis"
      :knowledge="draft.knowledge"
      :question-type="draft.question_type"
      :difficulty="draft.difficulty"
      :ai-busy="aiBusy"
      :answer-recognizing="answerRecognizing"
      @update:model-value="updateContent"
      @update:answer="updateAnswer"
      @update:answer-image="updateAnswerImage"
      @update:analysis="updateAnalysis"
      @update:knowledge="updateKnowledge"
      @update:question-type="updateQuestionType"
      @update:difficulty="updateDifficulty"
      @recognize-answer="recognizeAnswerFromImage"
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
.q-card.answer-target {
  border-color: #6366f1;
  background: var(--accent-soft);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.22);
}
.view.answer-picking .bank-content {
  padding-bottom: 118px;
}
.answer-pick-bar {
  position: fixed;
  left: 50%;
  bottom: 18px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 16px;
  width: min(920px, calc(100vw - 48px));
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(20, 28, 48, 0.18);
  transform: translateX(-50%);
}
.answer-pick-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.answer-pick-mode {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--accent-dark);
}
.answer-pick-source {
  margin-left: 4px;
  overflow: hidden;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.answer-pick-tag {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 11.5px;
  line-height: 18px;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #f3d9a4;
  border-radius: 999px;
}
.answer-pick-count {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
  white-space: nowrap;
}
.answer-pick-target {
  overflow: hidden;
  font-size: 12px;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.answer-pick-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--accent);
}
.answer-pick-error {
  overflow: hidden;
  font-size: 12px;
  color: var(--danger);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.answer-pick-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}
.q-thumb-index {
  position: absolute;
  left: 7px;
  top: 7px;
  max-width: calc(100% - 14px);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  max-width: 100%;
  max-height: 220px;
  width: auto;
  height: auto;
  object-fit: contain;
  object-position: top;
}
.editor-image-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  margin-bottom: 14px;
  border: 1px dashed var(--border);
  border-radius: 9px;
  background: #fafbfe;
  color: var(--text-3);
  font-size: 12px;
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
.editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.spin {
  animation: spin 0.8s linear infinite;
}
</style>
