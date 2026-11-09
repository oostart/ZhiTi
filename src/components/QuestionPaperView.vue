<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Brain, Columns2, ImagePlus, Loader2, RefreshCw, Save, Sparkles, Tag, X } from 'lucide-vue-next'
import ContentEditor from './ContentEditor.vue'
import AppModal from './AppModal.vue'
import { compressImage } from '../utils/image'
import { renderMathText } from '../utils/mathText'
import { normalizeNumberedList } from '../utils/text'
import { toast } from '../composables/toast'
import type { AnswerBlock, AnswerImageBlock, ContentDoc } from '../types'
import { DIFFICULTY_LABELS, QUESTION_TYPES } from '../types'

const props = defineProps<{
  modelValue: ContentDoc
  image: string
  title: string
  dirty: boolean
  answer: string
  answerBlocks: AnswerBlock[]
  answerImage: string
  analysis: string
  knowledge: string[]
  questionType: string
  difficulty: number
  aiBusy: '' | 'knowledge' | 'analysis'
  answerRecognizing: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: ContentDoc): void
  (event: 'save'): void
  (event: 'relayout'): void
  (event: 'close'): void
  (event: 'update:answer', value: string): void
  (event: 'update:answer-image', value: string): void
  (event: 'update:analysis', value: string): void
  (event: 'update:knowledge', value: string[]): void
  (event: 'update:questionType', value: string): void
  (event: 'update:difficulty', value: number): void
  (event: 'recognize-answer', imageDataUrl: string): void
  (event: 'ai', kind: 'knowledge' | 'analysis'): void
}>()

const compare = ref(true)
const knowledgeInput = ref('')
const answerBox = ref<HTMLTextAreaElement | null>(null)
const answerFileInput = ref<HTMLInputElement | null>(null)
const analysisBox = ref<HTMLTextAreaElement | null>(null)
const answerEditing = ref(false)
const analysisEditing = ref(false)
const answerPreview = ref('')
const figurePreview = ref<AnswerImageBlock | null>(null)
const answerImageRatio = ref(0)
const pendingImage = ref('')
const answerImageBlock = ref<HTMLElement | null>(null)
const answerImageFlash = ref(false)
let flashTimer = 0

const answerHtml = computed(() => renderMathText(normalizeNumberedList(props.answer)))
const analysisHtml = computed(() => renderMathText(normalizeNumberedList(props.analysis)))
const figurePreviewStyle = computed(() => (figurePreview.value ? figureStyle(figurePreview.value, true) : {}))
const answerFigures = computed(() => props.answerBlocks.filter((block): block is AnswerImageBlock => block.type === 'image'))
const hasAnswerContent = computed(() => !!props.answer.trim() || props.answerBlocks.length > 0)

/** 图片块按 answerImage 的相对坐标裁剪渲染，避免把同一张图再存一份 */
function figureStyle(block: AnswerImageBlock, full = false): Record<string, string> {
  const [x, y, w, h] = block.bbox
  const ratio = answerImageRatio.value || 4 / 3
  const safeW = Math.min(1, Math.max(0.01, w))
  const safeH = Math.min(1, Math.max(0.01, h))
  const percent = (start: number, size: number) => (size >= 1 ? 0 : (Math.min(start, 1 - size) / (1 - size)) * 100)
  return {
    width: full ? '100%' : `${Math.round(Math.min(1, Math.max(0.1, block.width)) * 100)}%`,
    aspectRatio: `${safeW * ratio} / ${safeH}`,
    backgroundImage: `url("${props.answerImage}")`,
    backgroundSize: `${100 / safeW}% ${100 / safeH}%`,
    backgroundPosition: `${percent(x, safeW)}% ${percent(y, safeH)}%`,
    backgroundRepeat: 'no-repeat'
  }
}

function figureRowStyle(block: AnswerImageBlock): Record<string, string> {
  return {
    justifyContent: block.align === 'center' ? 'center' : block.align === 'right' ? 'flex-end' : 'flex-start'
  }
}

function blockHtml(text: string): string {
  return renderMathText(normalizeNumberedList(text))
}

watch(
  () => props.answerImage,
  (src) => {
    answerImageRatio.value = 0
    if (!src) return
    const image = new Image()
    image.onload = () => {
      if (props.answerImage === src) answerImageRatio.value = image.naturalWidth / image.naturalHeight || 0
    }
    image.src = src
  },
  { immediate: true }
)

function update(value: ContentDoc) {
  emit('update:modelValue', value)
}

function grow(element: HTMLTextAreaElement | null) {
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}

function onAnswerInput(event: Event) {
  const element = event.target as HTMLTextAreaElement
  emit('update:answer', element.value)
  grow(element)
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 只把图片放进答案框供预览，不自动识别；识别由「AI 识别答案」触发 */
async function useAnswerImage(file: Blob) {
  if (!file.type.startsWith('image/')) {
    toast('请选择图片文件', 'warning')
    return
  }
  try {
    const raw = await readAsDataUrl(file)
    if (!raw) throw new Error('图片读取失败')
    applyAnswerImage(await compressImage(raw))
  } catch {
    toast('图片读取失败，请重试', 'error')
  }
}

/** 答案图只在右栏展示，这里给出位置提示并高亮右栏区块 */
function revealAnswerImageBlock() {
  if (!compare.value) return
  void nextTick(() => {
    answerImageBlock.value?.scrollIntoView({ block: 'nearest' })
    answerImageFlash.value = true
    window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => {
      answerImageFlash.value = false
    }, 1600)
  })
}

function applyAnswerImage(dataUrl: string) {
  if (props.answer.trim() || props.answerBlocks.length) {
    pendingImage.value = dataUrl
    return
  }
  emit('update:answer-image', dataUrl)
  toast(
    compare.value
      ? '已放入答案原图（右侧「答案原图」区块），点「AI 识别答案」可转为文字'
      : '已放入答案原图，点「显示右栏」查看，再点「AI 识别答案」可转为文字',
    'info',
    3600
  )
  revealAnswerImageBlock()
}

function confirmReplaceWithImage() {
  const dataUrl = pendingImage.value
  pendingImage.value = ''
  if (!dataUrl) return
  emit('update:answer-image', dataUrl)
  emit('update:answer', '')
  toast(
    compare.value
      ? '已用图片替换答案文字，图片在右侧「答案原图」，可点「AI 识别答案」转回文字'
      : '已用图片替换答案文字，点「显示右栏」查看答案原图',
    'info',
    3600
  )
  revealAnswerImageBlock()
}

function removeAnswerImage() {
  if (props.answerRecognizing) return
  emit('update:answer-image', '')
}

function recognizeAnswer() {
  if (props.answerRecognizing) return
  if (!props.answerImage) {
    toast('请先粘贴或导入答案图片，再点「AI 识别答案」', 'warning', 3600)
    return
  }
  emit('recognize-answer', props.answerImage)
}

function onAnswerFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void useAnswerImage(file)
}

function onAnswerPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return
  const imageItem = Array.from(items).find((item) => item.kind === 'file' && item.type.startsWith('image/'))
  const file = imageItem?.getAsFile()
  if (!file) return
  event.preventDefault()
  void useAnswerImage(file)
}

function onAnalysisInput(event: Event) {
  const element = event.target as HTMLTextAreaElement
  emit('update:analysis', element.value)
  grow(element)
}

function addKnowledge() {
  const name = knowledgeInput.value.trim()
  if (!name) return
  if (!props.knowledge.includes(name)) emit('update:knowledge', [...props.knowledge, name])
  knowledgeInput.value = ''
}

function removeKnowledge(name: string) {
  emit(
    'update:knowledge',
    props.knowledge.filter((item) => item !== name)
  )
}

function onTypeChange(event: Event) {
  emit('update:questionType', (event.target as HTMLSelectElement).value)
}

function onDifficultyChange(event: Event) {
  emit('update:difficulty', Number((event.target as HTMLSelectElement).value))
}

watch(
  () => props.answer,
  () => nextTick(() => grow(answerBox.value))
)
watch(
  () => props.analysis,
  () => nextTick(() => grow(analysisBox.value))
)
watch(answerEditing, (editing) => {
  if (!editing) return
  nextTick(() => {
    const box = answerBox.value
    box?.focus()
    box?.setSelectionRange(box.value.length, box.value.length)
    grow(box)
  })
})
watch(analysisEditing, (editing) => {
  if (!editing) return
  nextTick(() => {
    const box = analysisBox.value
    box?.focus()
    box?.setSelectionRange(box.value.length, box.value.length)
    grow(box)
  })
})
onMounted(() =>
  nextTick(() => {
    grow(answerBox.value)
    grow(analysisBox.value)
  })
)
</script>

<template>
  <teleport to="body">
    <div class="paper-mask" role="dialog" aria-modal="true">
      <div class="paper-panel">
        <header class="paper-head">
          <div class="paper-title">
            <span>{{ props.title }}</span>
            <span v-if="props.dirty" class="badge badge-amber">未保存</span>
          </div>
          <div class="paper-actions">
            <button class="btn btn-ghost btn-sm" @click="compare = !compare">
              <Columns2 :size="14" /> {{ compare ? '只看排版' : '对照原图' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="emit('relayout')">
              <RefreshCw :size="14" /> 重新识别
            </button>
            <button class="btn btn-primary btn-sm" :disabled="!props.dirty" @click="emit('save')">
              <Save :size="14" /> 保存
            </button>
            <button class="btn btn-ghost btn-icon" title="关闭" @click="emit('close')">
              <X :size="16" />
            </button>
          </div>
        </header>

        <div class="paper-body" :class="{ 'paper-body--compare': compare }">
          <div class="paper-stage">
            <article class="paper-sheet">
              <ContentEditor :model-value="props.modelValue" variant="paper" @update:model-value="update" />

              <div class="paper-divider"><span>教师参考</span></div>

              <section class="paper-section">
                <header class="paper-section-head">
                  <h3 class="paper-section-title">参考答案</h3>
                </header>
                <div v-if="!compare" class="paper-answer-aside-hint">
                  <span>{{ props.answerImage ? '答案原图已保存，当前右栏隐藏' : '答案原图在右侧栏导入与识别' }}</span>
                  <button type="button" class="paper-link-btn" @click="compare = true">显示右栏</button>
                </div>
                <div class="paper-answer-body" tabindex="0" @paste="onAnswerPaste">
                  <template v-if="!answerEditing">
                    <div
                      class="paper-answer-view"
                      :class="{ 'is-empty': !hasAnswerContent }"
                      title="点击可编辑"
                      @click="answerEditing = true"
                    >
                      <div v-if="props.answerBlocks.length" class="answer-blocks">
                        <template v-for="(block, index) in props.answerBlocks" :key="index">
                          <div
                            v-if="block.type === 'text' && block.text"
                            class="answer-block-text"
                            v-html="blockHtml(block.text)"
                          />
                          <div v-else-if="block.type === 'image'" class="answer-figure-row" :style="figureRowStyle(block)">
                            <button
                              type="button"
                              class="answer-figure"
                              :style="figureStyle(block)"
                              title="点击放大预览"
                              @click.stop="figurePreview = block"
                            />
                          </div>
                        </template>
                      </div>
                      <div v-else-if="props.answer.trim()" class="paper-richtext" v-html="answerHtml" />
                      <span v-else class="paper-placeholder">尚未填写，可直接输入；粘贴截图会放到右侧「答案原图」</span>
                    </div>
                  </template>
                  <template v-else>
                    <div v-if="answerFigures.length" class="paper-answer-edit-note">
                      手动编辑按纯文本保存；答案中的 {{ answerFigures.length }} 张图会保留在下方作为附图，图片与文字的原始相对位置可能改变。
                    </div>
                    <textarea
                      ref="answerBox"
                      class="paper-textarea"
                      :value="props.answer"
                      rows="2"
                      spellcheck="false"
                      placeholder="尚未填写，可直接输入；粘贴截图会放到右侧「答案原图」"
                      @input="onAnswerInput"
                      @blur="answerEditing = false"
                    />
                    <div v-if="answerFigures.length" class="answer-blocks answer-blocks--editing">
                      <div class="answer-figure-caption">答案附图</div>
                      <div
                        v-for="(figure, index) in answerFigures"
                        :key="'figure' + index"
                        class="answer-figure-row"
                        :style="figureRowStyle(figure)"
                      >
                        <button
                          type="button"
                          class="answer-figure"
                          :style="figureStyle(figure)"
                          title="点击放大预览"
                          @mousedown.prevent
                          @click.stop="figurePreview = figure"
                        />
                      </div>
                    </div>
                  </template>
                </div>
              </section>

              <section class="paper-section">
                <header class="paper-section-head">
                  <h3 class="paper-section-title">知识点</h3>
                  <button
                    type="button"
                    class="paper-ai-btn"
                    :disabled="!!props.aiBusy"
                    @click="emit('ai', 'knowledge')"
                  >
                    <Loader2 v-if="props.aiBusy === 'knowledge'" :size="12" class="spin" />
                    <Tag v-else :size="12" />
                    {{ props.knowledge.length ? '重新推荐' : '推荐知识点' }}
                  </button>
                </header>
                <div class="paper-knowledge">
                  <span v-for="name in props.knowledge" :key="name" class="paper-knowledge-chip">
                    {{ name }}
                    <button type="button" class="paper-chip-remove" @click="removeKnowledge(name)">
                      <X :size="10" />
                    </button>
                  </span>
                  <span v-if="!props.knowledge.length" class="paper-empty">尚未标注知识点</span>
                </div>
                <div class="paper-knowledge-add">
                  <input
                    v-model="knowledgeInput"
                    class="paper-knowledge-input"
                    placeholder="输入知识点，回车添加"
                    @keydown.enter.prevent="addKnowledge"
                  />
                  <button type="button" class="paper-add-btn" @click="addKnowledge">添加</button>
                </div>
              </section>

              <section class="paper-section">
                <header class="paper-section-head">
                  <h3 class="paper-section-title">题目理解</h3>
                  <button
                    type="button"
                    class="paper-ai-btn"
                    :disabled="!!props.aiBusy"
                    @click="emit('ai', 'analysis')"
                  >
                    <Loader2 v-if="props.aiBusy === 'analysis'" :size="12" class="spin" />
                    <Brain v-else :size="12" />
                    {{ props.analysis ? '重新分析' : 'AI 分析' }}
                  </button>
                </header>
                <div
                  v-if="!analysisEditing"
                  class="paper-answer-view"
                  :class="{ 'is-empty': !props.analysis.trim() }"
                  title="点击可编辑"
                  @click="analysisEditing = true"
                >
                  <div v-if="props.analysis.trim()" class="paper-richtext" v-html="analysisHtml" />
                  <span v-else class="paper-placeholder">尚未生成，可手动填写或点击 AI 分析</span>
                </div>
                <textarea
                  v-else
                  ref="analysisBox"
                  class="paper-textarea"
                  :value="props.analysis"
                  rows="3"
                  spellcheck="false"
                  placeholder="尚未生成，可手动填写或点击 AI 分析"
                  @input="onAnalysisInput"
                  @blur="analysisEditing = false"
                />
              </section>

              <section class="paper-section">
                <header class="paper-section-head">
                  <h3 class="paper-section-title">题目属性</h3>
                </header>
                <div class="paper-attrs">
                  <label class="paper-attr">
                    <span>题型</span>
                    <select :value="props.questionType" @change="onTypeChange">
                      <option v-for="type in QUESTION_TYPES" :key="type" :value="type">{{ type }}</option>
                    </select>
                  </label>
                  <label class="paper-attr">
                    <span>难度</span>
                    <select :value="props.difficulty" @change="onDifficultyChange">
                      <option v-for="level in 5" :key="level" :value="level">{{ level }} · {{ DIFFICULTY_LABELS[level] }}</option>
                    </select>
                  </label>
                </div>
              </section>
            </article>
          </div>

          <aside v-if="compare" class="paper-source">
            <div class="paper-source-head">
              <span>原图裁剪</span>
              <span class="paper-source-hint">对照校对</span>
            </div>
            <img v-if="props.image" :src="props.image" alt="原图裁剪" />
            <div v-else class="hint">没有原图</div>

            <section class="paper-answer-block">
              <div class="paper-source-head">
                <span>答案原图</span>
                <div class="paper-answer-block-actions">
                  <button
                    type="button"
                    class="paper-ai-btn"
                    :disabled="props.answerRecognizing"
                    @click="answerFileInput?.click()"
                  >
                    <ImagePlus :size="12" /> {{ props.answerImage ? '替换图片' : '导入图片' }}
                  </button>
                  <button
                    type="button"
                    class="paper-ai-btn"
                    :disabled="props.answerRecognizing"
                    @click="recognizeAnswer"
                  >
                    <Loader2 v-if="props.answerRecognizing" :size="12" class="spin" />
                    <Sparkles v-else :size="12" /> AI 识别答案
                  </button>
                </div>
                <input
                  ref="answerFileInput"
                  type="file"
                  accept="image/*"
                  class="paper-file-input"
                  @change="onAnswerFileChange"
                />
              </div>
              <div v-if="props.answerRecognizing" class="paper-answer-status">
                <Loader2 :size="12" class="spin" /> 正在识别图片中的文字与公式…
              </div>
              <div
                v-if="props.answerImage"
                ref="answerImageBlock"
                class="paper-answer-image"
                :class="{ 'is-thumb': !!props.answer.trim(), 'is-flash': answerImageFlash }"
              >
                <img
                  :src="props.answerImage"
                  alt="答案图片"
                  title="点击放大预览"
                  @click="answerPreview = props.answerImage"
                />
                <div class="paper-answer-image-bar">
                  <span>答案图片</span>
                  <button type="button" @click="answerPreview = props.answerImage">预览</button>
                  <button type="button" :disabled="props.answerRecognizing" @click="answerFileInput?.click()">
                    替换
                  </button>
                  <button type="button" :disabled="props.answerRecognizing" @click="removeAnswerImage">移除</button>
                </div>
              </div>
              <div v-else class="paper-answer-empty">
                还没有答案图片，可点「导入图片」，或在左侧答案区直接粘贴截图
              </div>
            </section>
          </aside>
        </div>

        <AppModal v-if="pendingImage" title="用图片替换答案文字？" :width="440" :z-index="95" @close="pendingImage = ''">
          <template #description>
            当前参考答案文字会被清空并替换为该图片，之后仍可点「AI 识别答案」转回文字。
          </template>
          <div class="paper-answer-preview">
            <img :src="pendingImage" alt="待替换的答案图片" />
          </div>
          <template #actions>
            <button class="btn" @click="pendingImage = ''">取消</button>
            <button class="btn btn-primary" @click="confirmReplaceWithImage">替换为图片</button>
          </template>
        </AppModal>

        <AppModal v-if="answerPreview" title="答案图片预览" :width="720" :z-index="95" @close="answerPreview = ''">
          <div class="paper-answer-preview">
            <img :src="answerPreview" alt="答案图片" />
          </div>
        </AppModal>

        <AppModal v-if="figurePreview" title="答案插图预览" :width="760" :z-index="95" @close="figurePreview = null">
          <div class="paper-answer-figure-preview" :style="figurePreviewStyle" />
        </AppModal>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.paper-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.36);
  backdrop-filter: blur(2px);
}
.paper-panel {
  width: min(1280px, 100%);
  height: min(900px, 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
}
.paper-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: #fff;
}
.paper-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}
.paper-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.paper-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
  background: #eceef4;
}
.paper-body--compare {
  grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr);
}
.paper-stage {
  min-height: 0;
  overflow: auto;
  padding: 22px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.paper-sheet {
  width: 100%;
  max-width: 860px;
  min-height: 640px;
  padding: 40px 48px;
  background: #fff;
  border-radius: 3px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.12);
  font-family: 'SimSun', 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', serif;
  --paper-base-size: 17px;
  --paper-line-height: 1.95;
}
.paper-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 34px 0 16px;
  color: var(--text-3);
  font-size: 12px;
}
.paper-divider::before,
.paper-divider::after {
  content: '';
  flex: 1;
  border-top: 1px dashed var(--border-strong);
}
.paper-section {
  margin-bottom: 20px;
}
.paper-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.paper-section-title {
  margin: 0;
  color: #1a1a1a;
  font-size: 15px;
  font-weight: 600;
}
.paper-ai-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid #d7d5fb;
  border-radius: 6px;
  background: #f5f3ff;
  color: #5145cd;
  font-size: 11.5px;
  cursor: pointer;
}
.paper-ai-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.paper-answer-status {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: #5145cd;
  font-size: 11.5px;
}
.paper-answer-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.paper-answer-block-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.paper-answer-empty {
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: #fff;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}
.paper-answer-aside-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: #fafbfe;
  color: var(--text-3);
  font-size: 12px;
}
.paper-link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: #5145cd;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.paper-link-btn:hover {
  text-decoration: underline;
}
.paper-file-input {
  display: none;
}
.paper-answer-body {
  outline: none;
}
.paper-answer-image {
  margin: 0;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fbfcfe;
}
.paper-answer-image.is-flash {
  border-color: #7c6cf0;
  box-shadow: 0 0 0 3px rgba(124, 108, 240, 0.16);
}
.paper-answer-image img {
  display: block;
  max-width: 100%;
  max-height: 260px;
  margin: 0 auto;
  border-radius: 4px;
  background: #fff;
  cursor: zoom-in;
}
.paper-answer-image.is-thumb {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
}
.paper-answer-image.is-thumb img {
  max-width: 140px;
  max-height: 48px;
  margin: 0;
}
.paper-answer-image-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--text-3);
  font-size: 11.5px;
}
.paper-answer-image.is-thumb .paper-answer-image-bar {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  margin-top: 0;
  white-space: nowrap;
}
.paper-answer-image-bar button {
  padding: 0;
  border: 0;
  background: transparent;
  color: #5145cd;
  font-size: 11.5px;
  cursor: pointer;
}
.paper-answer-image-bar button:hover {
  text-decoration: underline;
}
.paper-answer-image-bar button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.paper-answer-preview img {
  display: block;
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: #fff;
}
.paper-textarea {
  display: block;
  width: 100%;
  min-height: 3em;
  padding: 2px 4px;
  border: 1px dashed transparent;
  border-radius: 6px;
  background: transparent;
  color: #1a1a1a;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.9;
  resize: none;
  overflow: hidden;
  outline: none;
}
.paper-textarea:focus {
  border-color: var(--border-strong);
  background: #fafbfe;
}
.paper-textarea::placeholder {
  color: #a2a9b8;
}
.paper-answer-view {
  min-height: 3em;
  padding: 2px 4px;
  border: 1px dashed transparent;
  border-radius: 6px;
  cursor: text;
}
.paper-answer-view:hover {
  border-color: var(--border-strong);
}
.paper-richtext {
  color: #1a1a1a;
  font-size: 15px;
  line-height: 1.9;
  word-break: break-word;
}
.paper-richtext :deep(.katex) {
  font-size: 1.05em;
}
.paper-richtext :deep(.katex-display) {
  margin: 0.35em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.answer-blocks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  color: #1a1a1a;
  font-size: 15px;
  line-height: 1.9;
}
.answer-blocks--editing {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.answer-block-text {
  word-break: break-word;
}
.answer-block-text :deep(.katex) {
  font-size: 1.05em;
}
.answer-block-text :deep(.katex-display) {
  margin: 0.35em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.answer-figure-row {
  display: flex;
  width: 100%;
  margin: 4px 0;
}
.answer-figure {
  display: block;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: #fff;
  cursor: zoom-in;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.answer-figure:hover {
  border-color: #a5a0f5;
  box-shadow: 0 2px 10px rgba(79, 70, 229, 0.12);
}
.answer-figure-caption {
  margin-bottom: 2px;
  color: var(--text-3);
  font-size: 12px;
}
.paper-answer-edit-note {
  margin-bottom: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  background: #fffbeb;
  color: #92400e;
  font-size: 12px;
  line-height: 1.6;
}
.paper-answer-figure-preview {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background-color: #fff;
}
.paper-placeholder {
  color: #a2a9b8;
  font-size: 15px;
  line-height: 1.9;
}
.paper-knowledge {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 22px;
}
.paper-knowledge-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: 1px solid #d7d5fb;
  border-radius: 999px;
  background: #f5f3ff;
  color: #5145cd;
  font-size: 12px;
}
.paper-attrs {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}
.paper-attr {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #5b6472;
  font-size: 13px;
}
.paper-attr select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  color: #1a1a1a;
  font-family: inherit;
  font-size: 13px;
  outline: none;
}
.paper-chip-remove {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.paper-empty {
  color: var(--text-3);
  font-size: 12px;
}
.paper-knowledge-add {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.paper-knowledge-input {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  font-size: 12.5px;
  outline: none;
}
.paper-knowledge-input:focus {
  border-color: #a5a0f5;
}
.paper-add-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
.paper-source {
  align-self: start;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  background: #f7f8fb;
  border-left: 1px solid var(--border);
}
.paper-source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}
.paper-source-hint {
  color: var(--text-3);
  font-weight: 400;
}
.paper-source img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 60vh;
  object-fit: contain;
  object-position: top center;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.spin {
  animation: paper-spin 0.8s linear infinite;
}
@keyframes paper-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 980px) {
  .paper-body--compare {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .paper-source {
    max-height: 46vh;
    border-top: 1px solid var(--border);
    border-left: 0;
  }
  .paper-source > img {
    max-height: 22vh;
  }
  .paper-source .paper-answer-image img {
    max-height: 140px;
  }
  .paper-sheet {
    min-height: 480px;
    padding: 24px;
  }
}
</style>
