<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  Loader2,
  Merge,
  Plus,
  ScanText,
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut
} from 'lucide-vue-next'
import { canvasToDataUrl, composeDataUrls, cropCanvas } from '../utils/image'
import { extractTextFromRegions, getPaperDocument, renderPageToCanvas } from '../utils/pdf'
import { createQuestion, deleteQuestion, state, ui, updateQuestion } from '../store'
import { toast } from '../composables/toast'
import { recognizeImage } from '../utils/ocr'
import { guessQuestionType } from '../utils/questionType'
import type { Question, Region } from '../types'

const doc = shallowRef<PDFDocumentProxy | null>(null)
const loading = ref(false)
const loadError = ref('')
const page = ref(1)
const pageCount = ref(0)
const pageImage = ref('')
const rendering = ref(false)
const zoom = ref(1)
const draftBox = ref<Region | null>(null)
const pendingBoxes = ref<Region[]>([])
const mergeTargetId = ref<number | null>(null)
const generating = ref(false)
const ocrProgress = reactive<Record<number, number>>({})
const baseWidth = ref(780)
const stageRef = ref<HTMLElement>()
let dragStart: { x: number; y: number } | null = null
let renderToken = 0
let loadToken = 0
let resizeObserver: ResizeObserver | null = null

const paper = computed(() => state.papers.find((p) => p.id === ui.activePaperId))
const paperQuestions = computed(() => state.questions.filter((q) => q.paper_id === ui.activePaperId))
const pageQuestions = computed(() => questionRegionsOnPage())
const pendingBoxesOnPage = computed(() =>
  pendingBoxes.value.map((region, index) => ({ region, index })).filter(({ region }) => region.page === page.value)
)
const pendingTarget = computed(() => paperQuestions.value.find((q) => q.id === mergeTargetId.value) ?? null)
const displayWidth = computed(() => Math.round(baseWidth.value * zoom.value))

function questionRegionsOnPage(): { question: Question; index: number; region: Region }[] {
  const list: { question: Question; index: number; region: Region }[] = []
  paperQuestions.value.forEach((question, index) => {
    question.regions
      .filter((r) => r.page === page.value)
      .forEach((region) => list.push({ question, index, region }))
  })
  return list
}

function nextPage() {
  if (page.value < pageCount.value) {
    page.value += 1
  }
}

function prevPage() {
  if (page.value > 1) {
    page.value -= 1
  }
}

async function renderPreview() {
  const document = doc.value
  if (!document) return
  const token = ++renderToken
  rendering.value = true
  try {
    const canvas = await renderPageToCanvas(document, page.value, displayWidth.value * 1.5)
    if (token !== renderToken) return
    pageImage.value = canvasToDataUrl(canvas, 0.94)
  } catch {
    if (token === renderToken) toast('页面预览渲染失败', 'error')
  } finally {
    if (token === renderToken) rendering.value = false
  }
}

async function loadDocument() {
  const token = ++loadToken
  if (!ui.activePaperId) {
    doc.value = null
    pageCount.value = 0
    pageImage.value = ''
    page.value = 1
    loading.value = false
    return
  }
  const paperId = ui.activePaperId
  loading.value = true
  loadError.value = ''
  try {
    const document = await getPaperDocument(paperId)
    if (token !== loadToken) return
    doc.value = document
    pageCount.value = document.numPages
    const savedPage = ui.cutPageByPaper[paperId] ?? 1
    page.value = Math.min(Math.max(1, savedPage), document.numPages)
    draftBox.value = null
    pendingBoxes.value = []
    await renderPreview()
  } catch (error) {
    if (token !== loadToken) return
    doc.value = null
    loadError.value = (error as Error).message || 'PDF 载入失败'
    toast(loadError.value, 'error')
  } finally {
    if (token === loadToken) loading.value = false
  }
}

function normalizedPoint(event: PointerEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  return { x, y }
}

function onPointerDown(event: PointerEvent) {
  if (loading.value || rendering.value || !doc.value) return
  if (event.button !== 0) return
  const point = normalizedPoint(event)
  dragStart = point
  draftBox.value = { page: page.value, x: point.x, y: point.y, w: 0, h: 0 }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!dragStart) return
  const point = normalizedPoint(event)
  draftBox.value = {
    page: page.value,
    x: Math.min(dragStart.x, point.x),
    y: Math.min(dragStart.y, point.y),
    w: Math.abs(point.x - dragStart.x),
    h: Math.abs(point.y - dragStart.y)
  }
}

function onPointerUp(event: PointerEvent) {
  if (!dragStart) return
  dragStart = null
  const box = draftBox.value
  draftBox.value = null
  if (box && (box.w < 0.02 || box.h < 0.012)) {
    toast('框选区域过小，请重新框选', 'warning', 1800)
  } else if (box) {
    pendingBoxes.value.push(box)
  }
  try {
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  } catch {
    /* ignore */
  }
}

function removePending(index: number) {
  pendingBoxes.value.splice(index, 1)
}

function clearPending() {
  pendingBoxes.value = []
  draftBox.value = null
}

async function buildImage(regions: Region[]): Promise<string> {
  if (!doc.value) throw new Error('文档未就绪')
  const ordered = [...regions].sort((a, b) => a.page - b.page || a.y - b.y)
  const pageCanvases = new Map<number, HTMLCanvasElement>()
  const parts: string[] = []
  for (const region of ordered) {
    let canvas = pageCanvases.get(region.page)
    if (!canvas) {
      canvas = await renderPageToCanvas(doc.value, region.page, 1600)
      pageCanvases.set(region.page, canvas)
    }
    parts.push(canvasToDataUrl(cropCanvas(canvas, region)))
  }
  if (parts.length === 1) return parts[0]
  return await composeDataUrls(parts, 14)
}

async function appendToQuestion(target: Question, regions: Region[]): Promise<Question> {
  if (!ui.activePaperId || !doc.value) return target
  const merged = [...target.regions, ...regions]
  const image = await buildImage(merged)
  const text = await extractTextFromRegions(ui.activePaperId, doc.value, merged)
  await updateQuestion(target.id, { regions: merged, image, ocr_text: text })
  return { ...target, regions: merged, image, ocr_text: text }
}

async function saveRegions(
  regions: Region[],
  options: { appendToTarget?: boolean; silent?: boolean } = {}
): Promise<Question | null> {
  if (!ui.activePaperId || !doc.value) return null
  const target =
    options.appendToTarget && mergeTargetId.value
      ? paperQuestions.value.find((q) => q.id === mergeTargetId.value) ?? null
      : null
  if (options.appendToTarget) {
    if (!target) return null
    const targetIndex = paperQuestions.value.indexOf(target) + 1
    const next = await appendToQuestion(target, regions)
    if (!options.silent) toast(`已追加到第 ${targetIndex} 题，共 ${next.regions.length} 个区域`, 'success')
    return next
  }
  const image = await buildImage(regions)
  const text = await extractTextFromRegions(ui.activePaperId, doc.value, regions)
  const created = await createQuestion({
    paper_id: ui.activePaperId,
    image,
    regions,
    ocr_text: text,
    question_type: guessQuestionType(text),
    difficulty: 3
  })
  if (options.silent) return created
  const count = state.questions.filter((q) => q.paper_id === ui.activePaperId).length
  if (!text.trim()) toast('已生成题目。该页可能是扫描件，文本层为空，可点击「OCR」识别', 'warning', 4200)
  else toast(`已生成第 ${count} 题`, 'success')
  return created
}

async function createFromPending() {
  if (!pendingBoxes.value.length) return
  generating.value = true
  try {
    const created = await saveRegions([...pendingBoxes.value], { silent: true })
    pendingBoxes.value = []
    draftBox.value = null
    if (!created) return
    const count = state.questions.filter((q) => q.paper_id === ui.activePaperId).length
    const regionCount = created.regions.length
    if (!created.ocr_text.trim()) toast('已生成题目。该页可能是扫描件，文本层为空，可点击「OCR」识别', 'warning', 4200)
    else if (regionCount > 1) toast(`已生成第 ${count} 题，含 ${regionCount} 个区域`, 'success')
    else toast(`已生成第 ${count} 题`, 'success')
  } catch (error) {
    toast('生成题目失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    generating.value = false
  }
}

async function appendPending() {
  if (!pendingBoxes.value.length) return
  if (!mergeTargetId.value) {
    toast('请先在右侧「已切割题目」中选择一个合并目标', 'warning')
    return
  }
  generating.value = true
  try {
    const appended = await saveRegions([...pendingBoxes.value], { appendToTarget: true })
    if (!appended) {
      mergeTargetId.value = null
      toast('所选合并目标已不存在，请重新选择', 'warning')
      return
    }
    pendingBoxes.value = []
    draftBox.value = null
  } catch (error) {
    toast('追加失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    generating.value = false
  }
}

async function runOcr(question: Question) {
  ocrProgress[question.id] = 0.01
  try {
    const lang = state.settings.ocr.lang || 'chi_sim+eng'
    const text = await recognizeImage(question.image, lang, (progress) => {
      ocrProgress[question.id] = Math.max(0.01, progress)
    })
    if (!text) {
      toast('未识别到文字，请尝试调整题目图片清晰度', 'warning')
      return
    }
    await updateQuestion(question.id, { ocr_text: text })
    toast(`OCR 完成，识别出 ${text.length} 个字符`, 'success')
  } catch (error) {
    toast('OCR 识别失败：' + ((error as Error).message || '请检查网络连接'), 'error', 4200)
  } finally {
    delete ocrProgress[question.id]
  }
}

async function removeQuestion(question: Question) {
  await deleteQuestion(question.id)
  if (mergeTargetId.value === question.id) mergeTargetId.value = null
  toast('已删除该题目', 'success')
}

function toggleMergeTarget(question: Question) {
  mergeTargetId.value = mergeTargetId.value === question.id ? null : question.id
}

watch(
  () => ui.activePaperId,
  () => {
    mergeTargetId.value = null
    draftBox.value = null
    pendingBoxes.value = []
    void loadDocument()
  }
)

watch(page, (value) => {
  if (ui.activePaperId) ui.cutPageByPaper[ui.activePaperId] = value
})

watch([page, zoom], () => {
  void renderPreview()
})

onMounted(() => {
  if (stageRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        baseWidth.value = Math.max(460, Math.min(880, width - 64))
      }
    })
    resizeObserver.observe(stageRef.value)
  }
  void loadDocument()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  renderToken++
})
</script>

<template>
  <div class="view">
    <div class="cut-main">
      <div class="cut-toolbar">
        <select v-if="state.papers.length > 1" v-model.number="ui.activePaperId" class="select" style="width: 190px; height: 32px">
          <option v-for="p in state.papers" :key="p.id" :value="p.id">{{ p.title }}</option>
        </select>

        <div class="page-nav">
          <button class="btn btn-icon" :disabled="page <= 1" @click="prevPage"><ChevronLeft :size="15" /></button>
          <span class="page-indicator">{{ page }} / {{ pageCount || 1 }}</span>
          <button class="btn btn-icon" :disabled="page >= pageCount" @click="nextPage"><ChevronRight :size="15" /></button>
        </div>

        <div class="page-nav">
          <button class="btn btn-icon" :disabled="zoom <= 0.6" @click="zoom = Math.max(0.6, zoom - 0.2)"><ZoomOut :size="15" /></button>
          <span class="page-indicator" style="min-width: 48px">{{ Math.round(zoom * 100) }}%</span>
          <button class="btn btn-icon" :disabled="zoom >= 2" @click="zoom = Math.min(2, zoom + 0.2)"><ZoomIn :size="15" /></button>
        </div>

        <div class="toolbar-spacer" />
      </div>

      <div class="cut-stage" ref="stageRef">
        <div v-if="!ui.activePaperId" class="empty" style="margin: auto">
          <div class="empty-icon"><Scissors :size="24" /></div>
          <div class="empty-title">还没有选择试卷</div>
          <div class="empty-desc">先导入一份 PDF 试卷，再回来进行框选切割。</div>
          <button class="btn btn-primary" style="margin-top: 6px" @click="ui.view = 'import'">去导入试卷</button>
        </div>

        <div v-else-if="loadError" class="empty" style="margin: auto">
          <div class="empty-title">无法打开试卷</div>
          <div class="empty-desc">{{ loadError }}</div>
        </div>

        <div v-else-if="loading" class="empty" style="margin: auto">
          <div class="empty-icon"><Loader2 :size="24" class="spin" /></div>
          <div class="empty-title">正在加载试卷…</div>
        </div>

        <div v-else class="page-wrap" :style="{ width: displayWidth + 'px' }">
          <img v-if="pageImage" :src="pageImage" alt="试卷页面" draggable="false" />
          <div v-else class="page-skeleton"><Loader2 :size="22" class="spin" /></div>

          <div
            class="interaction-layer"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointerleave="onPointerUp"
            @contextmenu.prevent
          >
            <div
              v-for="(item, i) in pageQuestions"
              :key="'box' + item.question.id + '-' + i"
              class="question-box"
              :class="{ target: item.question.id === mergeTargetId }"
              :style="{
                left: item.region.x * 100 + '%',
                top: item.region.y * 100 + '%',
                width: item.region.w * 100 + '%',
                height: item.region.h * 100 + '%'
              }"
            >
              <span class="question-box-label">#{{ item.index + 1 }}</span>
            </div>

            <div
              v-for="item in pendingBoxesOnPage"
              :key="'pending' + item.index"
              class="pending-box"
              :style="{
                left: item.region.x * 100 + '%',
                top: item.region.y * 100 + '%',
                width: item.region.w * 100 + '%',
                height: item.region.h * 100 + '%'
              }"
            >
              <span class="pending-label">区域 {{ item.index + 1 }}</span>
            </div>

            <div
              v-if="draftBox"
              class="pending-box"
              :style="{
                left: draftBox.x * 100 + '%',
                top: draftBox.y * 100 + '%',
                width: draftBox.w * 100 + '%',
                height: draftBox.h * 100 + '%'
              }"
            >
              <span class="pending-label">新框选</span>
            </div>
          </div>

          <div v-if="rendering" class="render-mask"><Loader2 :size="18" class="spin" /></div>
        </div>
      </div>

      <div class="cut-statusbar">
        按住拖动画框可连续圈选多个区域（可跨页），选好后点「创建题目」合成一题；也可追加到已有题目。
      </div>
    </div>

    <aside class="inspector">
      <div class="inspector-head">
        <div>
          <div style="font-size: 13px; font-weight: 650">切割面板</div>
          <div class="hint">{{ paper ? `${paper.subject} · ${paper.grade} · ${paper.year} 年` : '未选择试卷' }}</div>
        </div>
        <span class="badge badge-indigo">{{ paperQuestions.length }} 题</span>
      </div>

      <div v-if="pendingBoxes.length" class="card pending-card">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px">已框选 {{ pendingBoxes.length }} 个区域（可跨页合并）</div>
        <div class="pending-region-list">
          <div v-for="(box, i) in pendingBoxes" :key="i" class="pending-region-row">
            <span>
              区域 {{ i + 1 }} · 第 {{ box.page }} 页 · 宽 {{ Math.round(box.w * 100) }}% · 高
              {{ Math.round(box.h * 100) }}%
            </span>
            <button class="btn btn-ghost btn-icon" title="移除该区域" @click="removePending(i)"><Trash2 :size="13" /></button>
          </div>
        </div>
        <div style="display: flex; gap: 7px; flex-wrap: wrap">
          <button class="btn btn-primary btn-sm" :disabled="generating" @click="createFromPending">
            <Plus :size="13" />
            {{ pendingBoxes.length > 1 ? `创建题目（${pendingBoxes.length} 个区域）` : '创建题目' }}
          </button>
          <button class="btn btn-sm" :disabled="generating || !mergeTargetId" @click="appendPending">
            <Merge :size="13" />
            追加到 {{ pendingTarget ? '第 ' + (paperQuestions.indexOf(pendingTarget) + 1) + ' 题' : '当前题目' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="clearPending">清空</button>
        </div>
        <div class="hint" style="margin-top: 8px">
          {{
            mergeTargetId
              ? '「创建题目」始终新建一题；点「追加到第 N 题」才会并入所选题目。'
              : '需先在下方题目列表中选择「合并目标」才能追加。'
          }}
        </div>
      </div>

      <div class="panel-section" style="flex: 1">
        <div class="panel-section-title">
          <span>已切割题目</span>
          <span class="hint">{{ mergeTargetId ? '点击切换合并目标' : '点击设为追加目标' }}</span>
        </div>

        <div v-if="!paperQuestions.length" class="hint" style="padding: 18px 0; text-align: center">
          当前试卷还没有题目。<br />用框选开始切割吧。
        </div>

        <div v-else class="question-list">
          <div
            v-for="(question, index) in paperQuestions"
            :key="question.id"
            class="question-row"
            :class="{ target: question.id === mergeTargetId }"
            @click="toggleMergeTarget(question)"
          >
            <div class="q-thumb-mini">
              <img v-if="question.image" :src="question.image" />
            </div>
            <div style="flex: 1; min-width: 0">
              <div class="question-row-title">
                <span>第 {{ index + 1 }} 题</span>
                <span class="badge badge-gray" style="margin-left: 4px">{{ question.question_type }}</span>
                <span v-if="question.id === mergeTargetId" class="badge badge-indigo" style="margin-left: 4px">合并目标</span>
              </div>
              <div class="question-row-meta">
                第 {{ question.regions.map((r) => r.page).join('、') }} 页 · {{ question.regions.length }} 个区域 ·
                {{ question.ocr_text ? question.ocr_text.slice(0, 24) : '无文本（可用 OCR）' }}
              </div>
              <div v-if="ocrProgress[question.id] != null" class="progress" style="margin-top: 6px">
                <div class="progress-bar" :style="{ width: Math.round(ocrProgress[question.id] * 100) + '%' }" />
              </div>
            </div>
            <div class="question-row-actions" @click.stop>
              <button class="btn btn-ghost btn-icon" title="OCR 识别文字" :disabled="ocrProgress[question.id] != null" @click="runOcr(question)">
                <ScanText :size="14" />
              </button>
              <button class="btn btn-ghost btn-icon" title="删除题目" @click="removeQuestion(question)">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="tip-card">
        <div style="display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; margin-bottom: 6px">
          <Layers :size="13" /> 跨页 / 多图题目
        </div>
        <div class="hint">
          1. 框选可连续多次，跨页时翻页继续框选；<br />
          2. 选好后点「创建题目」，所有区域按页码顺序纵向拼接成一题；<br />
          3. 需要并入已有题目时，先在右侧题目列表点选「合并目标」，再点「追加到第 N 题」；直接点「创建题目」总是新建一题。
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.cut-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.cut-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  background: #fff;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.page-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}
.page-indicator {
  font-size: 12px;
  color: var(--text-2);
  min-width: 54px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.cut-stage {
  flex: 1;
  overflow: auto;
  background: #e9ecf3;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px 28px 40px;
  background-image: radial-gradient(#d6dbe6 1px, transparent 1px);
  background-size: 18px 18px;
}
.page-wrap {
  position: relative;
  flex: 0 0 auto;
  align-self: flex-start;
  margin: 0 auto;
  background: #fff;
  box-shadow: 0 4px 26px rgba(22, 28, 45, 0.18);
  border-radius: 2px;
  overflow: hidden;
}
.page-wrap img {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
}
.page-skeleton {
  height: 600px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.interaction-layer {
  position: absolute;
  inset: 0;
  cursor: crosshair;
  touch-action: none;
}
.question-box {
  position: absolute;
  border: 1.5px solid rgba(79, 70, 229, 0.45);
  background: rgba(99, 102, 241, 0.05);
  border-radius: 2px;
  pointer-events: none;
  transition: border-color 0.15s;
}
.question-box.target {
  border-color: #4f46e5;
  border-width: 2px;
  background: rgba(99, 102, 241, 0.1);
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.35);
}
.question-box-label {
  position: absolute;
  top: -1px;
  left: -1px;
  background: #4f46e5;
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 0 0 4px 0;
}
.pending-box {
  position: absolute;
  border: 2px dashed #0ea5e9;
  background: rgba(14, 165, 233, 0.12);
  pointer-events: none;
}
.pending-label {
  position: absolute;
  top: -1px;
  right: -1px;
  background: #0ea5e9;
  color: #fff;
  font-size: 10px;
  padding: 0 5px;
  line-height: 15px;
  border-radius: 0 0 0 4px;
}
.render-mask {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.7);
  display: grid;
  place-items: center;
  color: var(--accent);
}
.cut-statusbar {
  flex-shrink: 0;
  padding: 8px 18px;
  font-size: 12px;
  color: var(--text-3);
  background: #fff;
  border-top: 1px solid var(--border);
  line-height: 1.6;
}
.inspector-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 14px;
}
.pending-card {
  padding: 12px;
  border-color: #bfe6f8;
  background: #f6fcff;
  margin-bottom: 14px;
}
.panel-section {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.panel-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 650;
  margin-bottom: 8px;
}
.question-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.question-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 9px;
  cursor: pointer;
  transition: all 0.15s;
}
.question-row:hover {
  border-color: #c7cbf5;
  background: #fafbff;
}
.question-row.target {
  border-color: #8b84f2;
  background: #f5f5ff;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}
.q-thumb-mini {
  width: 44px;
  height: 52px;
  border-radius: 5px;
  overflow: hidden;
  background: #f4f6fb;
  flex-shrink: 0;
  border: 1px solid var(--border);
}
.q-thumb-mini img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.question-row-title {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
}
.question-row-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.question-row-actions {
  display: flex;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.15s;
}
.question-row:hover .question-row-actions {
  opacity: 1;
}
.tip-card {
  margin-top: 14px;
  padding: 12px;
  background: #f7f8fd;
  border: 1px solid #e6e8f4;
  border-radius: 10px;
}
.spin {
  animation: spin 0.8s linear infinite;
}
.pending-region-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.pending-region-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-2);
  background: #fff;
  border: 1px solid #e3ecf6;
  border-radius: 7px;
  padding: 4px 7px;
}
.pending-region-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
