<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Brain, Columns2, Loader2, RefreshCw, Save, Sparkles, Tag, X } from 'lucide-vue-next'
import ContentEditor from './ContentEditor.vue'
import { renderMathText } from '../utils/mathText'
import { normalizeNumberedList } from '../utils/text'
import type { ContentDoc } from '../types'
import { DIFFICULTY_LABELS, QUESTION_TYPES } from '../types'

const props = defineProps<{
  modelValue: ContentDoc
  image: string
  title: string
  dirty: boolean
  answer: string
  analysis: string
  knowledge: string[]
  questionType: string
  difficulty: number
  aiBusy: '' | 'answer' | 'knowledge' | 'analysis'
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: ContentDoc): void
  (event: 'save'): void
  (event: 'relayout'): void
  (event: 'close'): void
  (event: 'update:answer', value: string): void
  (event: 'update:analysis', value: string): void
  (event: 'update:knowledge', value: string[]): void
  (event: 'update:questionType', value: string): void
  (event: 'update:difficulty', value: number): void
  (event: 'ai', kind: 'answer' | 'knowledge' | 'analysis'): void
}>()

const compare = ref(true)
const knowledgeInput = ref('')
const answerBox = ref<HTMLTextAreaElement | null>(null)
const analysisBox = ref<HTMLTextAreaElement | null>(null)
const answerEditing = ref(false)
const analysisEditing = ref(false)

const answerHtml = computed(() => renderMathText(normalizeNumberedList(props.answer)))
const analysisHtml = computed(() => renderMathText(normalizeNumberedList(props.analysis)))

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
                  <button
                    type="button"
                    class="paper-ai-btn"
                    :disabled="!!props.aiBusy"
                    @click="emit('ai', 'answer')"
                  >
                    <Loader2 v-if="props.aiBusy === 'answer'" :size="12" class="spin" />
                    <Sparkles v-else :size="12" />
                    {{ props.answer ? '重新生成' : 'AI 生成' }}
                  </button>
                </header>
                <div
                  v-if="!answerEditing"
                  class="paper-answer-view"
                  :class="{ 'is-empty': !props.answer.trim() }"
                  title="点击可编辑"
                  @click="answerEditing = true"
                >
                  <div v-if="props.answer.trim()" class="paper-richtext" v-html="answerHtml" />
                  <span v-else class="paper-placeholder">尚未生成，可手动填写或点击 AI 生成</span>
                </div>
                <textarea
                  v-else
                  ref="answerBox"
                  class="paper-textarea"
                  :value="props.answer"
                  rows="2"
                  spellcheck="false"
                  placeholder="尚未生成，可手动填写或点击 AI 生成"
                  @input="onAnswerInput"
                  @blur="answerEditing = false"
                />
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
          </aside>
        </div>
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
  object-fit: contain;
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
    max-height: 240px;
    border-top: 1px solid var(--border);
    border-left: 0;
  }
  .paper-sheet {
    min-height: 480px;
    padding: 24px;
  }
}
</style>
