<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { NodeViewProps } from '@tiptap/core'
import { NodeViewWrapper } from '@tiptap/vue-3'
import katex from 'katex'
import 'katex/contrib/mhchem'

const props = defineProps<NodeViewProps>()

const editing = ref(false)
const draft = ref('')
const error = ref('')
const input = ref<HTMLTextAreaElement | null>(null)

const display = computed(() => !!props.node.attrs.display)
const latex = computed(() => String(props.node.attrs.latex || ''))
const blockAlign = computed(() => String(props.node.attrs.align || 'center'))
const blockSize = computed(() => String(props.node.attrs.size || 'normal'))
const blockGap = computed(() => {
  const value = Number(props.node.attrs.gapBefore ?? 1)
  return Number.isFinite(value) ? Math.max(0, Math.min(3, value)) : 1
})
const blockStyle = computed(() => {
  if (!display.value) return undefined
  const style: Record<string, string> = { marginTop: `${blockGap.value * 1.95}em` }
  if (blockSize.value === 'large') style.fontSize = '1.18em'
  else if (blockSize.value === 'small') style.fontSize = '0.86em'
  return style
})

function check(source: string): boolean {
  try {
    katex.renderToString(source, { displayMode: display.value, throwOnError: true, strict: 'ignore', trust: false })
    return true
  } catch {
    return false
  }
}

function escapeHtml(source: string): string {
  return source.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

const failed = computed(() => !check(latex.value))
const renderedHtml = computed(() => {
  try {
    return katex.renderToString(latex.value, {
      displayMode: display.value,
      throwOnError: false,
      strict: 'ignore',
      trust: false
    })
  } catch {
    return escapeHtml(latex.value)
  }
})

function startEdit() {
  if (editing.value || !props.editor.isEditable) return
  draft.value = latex.value
  error.value = ''
  editing.value = true
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

function onWrapperClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('.math-actions')) return
  startEdit()
}

function commit() {
  const source = draft.value.trim()
  if (!source) {
    error.value = '公式不能为空'
    return
  }
  if (!check(source)) {
    error.value = 'LaTeX 语法有误，请修正后再确定'
    return
  }
  props.updateAttributes({ latex: source })
  editing.value = false
  error.value = ''
}

function cancel() {
  editing.value = false
  error.value = ''
}

function onEnter(event: KeyboardEvent) {
  if (display.value && !event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  commit()
}
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="math-node"
    :class="{ 'is-block': display, 'is-selected': selected, 'is-editing': editing }"
    :data-align="display ? blockAlign : undefined"
    :style="blockStyle"
    contenteditable="false"
    @click.stop="onWrapperClick"
  >
    <template v-if="editing">
      <textarea
        ref="input"
        v-model="draft"
        class="math-input"
        :rows="display ? 3 : 1"
        spellcheck="false"
        @keydown.enter="onEnter"
        @keydown.esc.prevent="cancel"
      />
      <span class="math-actions">
        <button type="button" class="math-btn is-primary" @mousedown.prevent @click.stop="commit">确定</button>
        <button type="button" class="math-btn" @mousedown.prevent @click.stop="cancel">取消</button>
      </span>
      <span v-if="error" class="math-error">{{ error }}</span>
    </template>
    <template v-else>
      <span class="math-render" title="点击修改 LaTeX" v-html="renderedHtml"></span>
      <span v-if="failed" class="math-warning" title="LaTeX 语法可能有误">!</span>
    </template>
  </NodeViewWrapper>
</template>

<style scoped>
.math-node {
  display: inline-block;
  vertical-align: baseline;
  border-radius: 5px;
  padding: 0 2px;
  max-width: 100%;
}
.math-node .math-render {
  cursor: text;
  max-width: 100%;
}
.math-node.is-block {
  display: block;
  width: 100%;
  padding: 6px 8px;
  margin: 4px 0;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 7px;
}
.math-node.is-block .math-render {
  overflow-x: auto;
  overflow-y: hidden;
}
.math-node.is-block[data-align='left'] :deep(.katex-display) {
  text-align: left;
}
.math-node.is-block[data-align='right'] :deep(.katex-display) {
  text-align: right;
}
.math-node.is-editing {
  display: inline-block;
  vertical-align: middle;
  padding: 6px 8px;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 7px;
}
.math-node.is-editing.is-block {
  display: block;
}
.math-node.is-selected,
.math-node.is-editing {
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.35);
}
.math-warning {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 1px solid #dc2626;
  border-radius: 50%;
  color: #dc2626;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.math-input {
  width: 100%;
  min-width: 200px;
  padding: 6px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
  background: #fff;
  resize: vertical;
}
.math-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.math-btn {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: #fff;
  color: var(--text);
  font-size: 11.5px;
  cursor: pointer;
}
.math-btn.is-primary {
  border-color: #6366f1;
  background: #6366f1;
  color: #fff;
}
.math-error {
  margin-top: 3px;
  color: #dc2626;
  font-size: 11px;
}
</style>
