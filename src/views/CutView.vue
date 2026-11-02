<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Layers,
  Loader2,
  Merge,
  Plus,
  ScanText,
  Scissors,
  SquareDashed,
  Trash2,
  ZoomIn,
  ZoomOut
} from 'lucide-vue-next'
import { canvasToDataUrl, composeDataUrls, cropCanvas } from '../utils/image'
import { extractTextFromRegions, getPaperDocument, regionsFromCuts, renderPageToCanvas } from '../utils/pdf'
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
const mode = ref<'line' | 'box'>('line')
const cuts = reactive<Record<number, number[]>>({})
const pendingBox = ref<Region | null>(null)
const mergeTargetId = ref<number | null>(null)
const generating = ref(false)
const ocrProgress = reactive<Record<number, number>>({})
const baseWidth = ref(780)
const stageRef = ref<HTMLElement>()
const hoverY = ref<number | null>(null)
let dragStart: { x: number; y: number } | null = null
let renderToken = 0
let resizeObserver: ResizeObserver | null = null

const paper = computed(() => state.papers.find((p) => p.id === ui.activePaperId))
const paperQuestions = computed(() => state.questions.filter((q) => q.paper_id === ui.activePaperId))
const pageQuestions = computed(() => questionRegionsOnPage())
const currentCuts = computed(() => cuts[page.value] ?? [])
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
    pendingBox.value = null
  }
}

function prevPage() {
  if (page.value > 1) {
    page.value -= 1
    pendingBox.value = null
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
  if (!ui.activePaperId) {
    doc.value = null
    pageCount.value = 0
    pageImage.value = ''
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const document = await getPaperDocument(ui.activePaperId)
    doc.value = document
    pageCount.value = document.numPages
    page.value = 1
    pendingBox.value = null
    await renderPreview()
  } catch (error) {
    doc.value = null
    loadError.value = (error as Error).message || 'PDF 载入失败'
    toast(loadError.value, 'error')
  } finally {
    loading.value = false
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
  if (mode.value === 'line') {
    if (point.y < 0.03 || point.y > 0.97) return
    const list = cuts[page.value] ?? (cuts[page.value] = [])
    const existing = list.find((y) => Math.abs(y - point.y) < 0.015)
    if (existing != null) {
      cuts[page.value] = list.filter((y) => y !== existing)
      toast('已移除该切线', 'info', 1600)
      return
    }
    list.push(point.y)
    list.sort((a, b) => a - b)
    cuts[page.value] = [...list]
    return
  }
  dragStart = point
  pendingBox.value = { page: page.value, x: point.x, y: point.y, w: 0, h: 0 }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const point = normalizedPoint(event)
  hoverY.value = mode.value === 'line' ? point.y : null
  if (mode.value !== 'box' || !dragStart) return
  pendingBox.value = {
    page: page.value,
    x: Math.min(dragStart.x, point.x),
    y: Math.min(dragStart.y, point.y),
    w: Math.abs(point.x - dragStart.x),
    h: Math.abs(point.y - dragStart.y)
  }
}

function onPointerUp(event: PointerEvent) {
  hoverY.value = null
  if (mode.value !== 'box' || !dragStart) return
  dragStart = null
  const box = pendingBox.value
  if (box && (box.w < 0.02 || box.h < 0.012)) {
    pendingBox.value = null
    toast('框选区域过小，请重新框选', 'warning', 1800)
  }
  try {
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  } catch {
    /* ignore */
  }
}

function clearCuts() {
  cuts[page.value] = []
  pendingBox.value = null
}

function removeCut(y: number) {
  cuts[page.value] = (cuts[page.value] ?? []).filter((v) => v !== y)
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

async function saveRegions(regions: Region[], setAsTarget = false, silent = false): Promise<void> {
  if (!ui.activePaperId || !doc.value) return
  const target = mergeTargetId.value ? paperQuestions.value.find((q) => q.id === mergeTargetId.value) : null
  if (target) {
    const merged = [...target.regions, ...regions]
    const image = await buildImage(merged)
    const text = await extractTextFromRegions(ui.activePaperId, doc.value, merged)
    await updateQuestion(target.id, { regions: merged, image, ocr_text: text })
    if (!silent) toast(`已追加到第 ${paperQuestions.value.indexOf(target) + 1} 题，共 ${merged.length} 个区域`, 'success')
    pendingBox.value = null
    return
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
  mergeTargetId.value = setAsTarget ? created.id : null
  pendingBox.value = null
  if (silent) return
  const count = state.questions.filter((q) => q.paper_id === ui.activePaperId).length
  if (!text.trim()) toast('已生成题目。该页可能是扫描件，文本层为空，可点击「OCR」识别', 'warning', 4200)
  else toast(`已生成第 ${count} 题`, 'success')
}

async function createFromPending() {
  if (!pendingBox.value) return
  generating.value = true
  try {
    await saveRegions([pendingBox.value], true)
  } catch (error) {
    toast('生成题目失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    generating.value = false
  }
}

async function appendPending() {
  if (!pendingBox.value) return
  if (!mergeTargetId.value) {
    toast('请先在右侧「已切割题目」中选择一个合并目标', 'warning')
    return
  }
  generating.value = true
  try {
    await saveRegions([pendingBox.value])
  } catch (error) {
    toast('追加失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    generating.value = false
  }
}

async function generateFromCuts() {
  if (!doc.value || !ui.activePaperId) return
  const regions = regionsFromCuts(page.value, cuts[page.value] ?? [])
  if (!regions.length) {
    toast('请先在页面中画出至少一条切线', 'warning')
    return
  }
  generating.value = true
  mergeTargetId.value = null
  try {
    for (const region of regions) {
      await saveRegions([region], false, true)
    }
    cuts[page.value] = []
    toast(`本页已生成 ${regions.length} 道题目`, 'success')
  } catch (error) {
    toast('切割失败：' + ((error as Error).message || '未知错误'), 'error')
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
    await updateQuestion(question.id, { ocr_text: question.ocr_text ? `${question.ocr_text}\n${text}` : text })
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
    for (const key of Object.keys(cuts)) delete cuts[Number(key)]
    void loadDocument()
  }
)

watch([page, zoom], () => {
  hoverY.value = null
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

        <div class="segmented">
          <button :class="{ active: mode === 'line' }" @click="mode = 'line'; pendingBox = null"><Scissors /> 切线模式</button>
          <button :class="{ active: mode === 'box' }" @click="mode = 'box'; pendingBox = null"><SquareDashed /> 框选模式</button>
        </div>

        <button v-if="mode === 'line'" class="btn btn-primary btn-sm" :disabled="generating || !currentCuts.length" @click="generateFromCuts">
          <Loader2 v-if="generating" :size="13" class="spin" />
          <Scissors v-else :size="13" />
          生成 {{ currentCuts.length ? currentCuts.length + 1 + ' 道题' : '题目' }}
        </button>
      </div>

      <div class="cut-stage" ref="stageRef">
        <div v-if="!ui.activePaperId" class="empty" style="margin: auto">
          <div class="empty-icon"><Scissors :size="24" /></div>
          <div class="empty-title">还没有选择试卷</div>
          <div class="empty-desc">先导入一份 PDF 试卷，再回来进行切线或框选切割。</div>
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

        <div v-else class="page-wrap" :style="{ width: displayWidth + 'px' }" :class="{ 'mode-box': mode === 'box' }">
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
            <div v-for="(y, i) in currentCuts" :key="'cut' + i" class="cut-line" :style="{ top: y * 100 + '%' }">
              <span class="cut-grip" />
              <span class="cut-label">切线 {{ i + 1 }}</span>
            </div>

            <div
              v-if="hoverY != null && mode === 'line' && hoverY > 0.03 && hoverY < 0.97"
              class="cut-preview"
              :style="{ top: hoverY * 100 + '%' }"
            />

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
              v-if="pendingBox"
              class="pending-box"
              :style="{
                left: pendingBox.x * 100 + '%',
                top: pendingBox.y * 100 + '%',
                width: pendingBox.w * 100 + '%',
                height: pendingBox.h * 100 + '%'
              }"
            >
              <span class="pending-label">新框选</span>
            </div>
          </div>

          <div v-if="rendering" class="render-mask"><Loader2 :size="18" class="spin" /></div>
        </div>
      </div>

      <div class="cut-statusbar">
        <span v-if="mode === 'line'">在页面上单击可添加一条切线，再次单击已有切线可移除；从上到下按切线切分出题目。</span>
        <span v-else>
          按住拖动画框圈住题目内容；同一题跨页或包含多张图时，先「新建题目」，翻页后再框选并「追加到第 N 题」。
        </span>
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

      <div v-if="pendingBox" class="card pending-card">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px">已框选一个区域</div>
        <div class="hint" style="margin-bottom: 10px">
          第 {{ pendingBox.page }} 页 · 宽 {{ Math.round(pendingBox.w * 100) }}% · 高 {{ Math.round(pendingBox.h * 100) }}%
        </div>
        <div style="display: flex; gap: 7px; flex-wrap: wrap">
          <button class="btn btn-primary btn-sm" :disabled="generating" @click="createFromPending"><Plus :size="13" /> 新建题目</button>
          <button class="btn btn-sm" :disabled="generating || !mergeTargetId" @click="appendPending">
            <Merge :size="13" />
            追加到 {{ pendingTarget ? '第 ' + (paperQuestions.indexOf(pendingTarget) + 1) + ' 题' : '当前题目' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="pendingBox = null">取消</button>
        </div>
        <div v-if="!mergeTargetId" class="hint" style="margin-top: 8px">需先在下方题目列表中选择「合并目标」才能追加。</div>
      </div>

      <div class="panel-section">
        <div class="panel-section-title">
          <span>本页切线</span>
          <button v-if="currentCuts.length" class="btn btn-ghost btn-sm" @click="clearCuts"><Eraser :size="12" /> 清空</button>
        </div>
        <div v-if="!currentCuts.length" class="hint">第 {{ page }} 页还没有切线。切换到切线模式后在页面上单击即可添加。</div>
        <div v-else class="cut-chips">
          <button v-for="(y, i) in currentCuts" :key="i" class="chip" @click="removeCut(y)">切线 {{ i + 1 }} · {{ Math.round(y * 100) }}% ✕</button>
        </div>
      </div>

      <div class="panel-section" style="flex: 1">
        <div class="panel-section-title">
          <span>已切割题目</span>
          <span class="hint">{{ mergeTargetId ? '点击切换合并目标' : '点击设为追加目标' }}</span>
        </div>

        <div v-if="!paperQuestions.length" class="hint" style="padding: 18px 0; text-align: center">
          当前试卷还没有题目。<br />用切线或框选开始切割吧。
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
          1. 在第 1 页框选题干 → 点击「新建题目」；<br />
          2. 翻到下一页，框选剩余内容；<br />
          3. 点击「追加到第 N 题」，系统会纵向拼接所有区域并重新合并文字。
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
.cut-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 2px dashed #ef4444;
  pointer-events: none;
  filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.9));
}
.cut-grip {
  position: absolute;
  left: 8px;
  top: -6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #ef4444;
}
.cut-label {
  position: absolute;
  right: 8px;
  top: -11px;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  line-height: 16px;
}
.cut-preview {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1.5px dashed rgba(239, 68, 68, 0.4);
  pointer-events: none;
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
.cut-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
</style>
