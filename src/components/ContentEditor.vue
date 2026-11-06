<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { editorExtensions } from '../editor/extensions'
import type { ContentDoc } from '../types'

const props = withDefaults(
  defineProps<{
    modelValue: ContentDoc
    variant?: 'plain' | 'paper'
    readonly?: boolean
  }>(),
  { variant: 'plain', readonly: false }
)

const emit = defineEmits<{ (event: 'update:modelValue', value: ContentDoc): void }>()

const editor = useEditor({
  content: props.modelValue as unknown as JSONContent,
  extensions: editorExtensions,
  editable: !props.readonly,
  editorProps: {
    attributes: {
      class: 'content-editor-body',
      spellcheck: 'false'
    }
  },
  onUpdate: ({ editor: instance }) => {
    emit('update:modelValue', instance.getJSON() as unknown as ContentDoc)
  }
})

watch(
  () => props.modelValue,
  (value) => {
    const instance = editor.value
    if (!instance) return
    if (JSON.stringify(value) === JSON.stringify(instance.getJSON())) return
    instance.commands.setContent(value as unknown as JSONContent, false)
  },
  { deep: true }
)

watch(
  () => props.readonly,
  (value) => {
    editor.value?.setEditable(!value)
  }
)

onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <div
    class="content-editor"
    :class="{ 'content-editor--paper': variant === 'paper', 'content-editor--readonly': readonly }"
  >
    <EditorContent :editor="editor" />
  </div>
</template>

<style scoped>
.content-editor {
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: #fff;
  padding: 9px 11px;
}
.content-editor :deep(.content-editor-body) {
  min-height: 110px;
  outline: none;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}
.content-editor :deep(.content-editor-body p) {
  margin: 0 0 8px;
}
.content-editor :deep(.content-editor-body p:last-child) {
  margin-bottom: 0;
}
.content-editor :deep(.ProseMirror-selectednode) {
  border-radius: 6px;
}
.content-editor :deep(.katex) {
  font-size: 1.02em;
}
.content-editor :deep(.katex-error) {
  color: #dc2626 !important;
}

/* 纸张视图 */
.content-editor--paper {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
}
.content-editor--paper :deep(.content-editor-body) {
  min-height: 0;
  color: #1a1a1a;
  font-family: 'SimSun', 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', serif;
  font-size: var(--paper-base-size, 17px);
  line-height: var(--paper-line-height, 1.95);
  white-space: pre-wrap;
  word-break: break-word;
}
.content-editor--paper :deep(.content-editor-body p) {
  margin: 0;
}
.content-editor--paper :deep(.content-editor-body p[data-align='center']) {
  text-align: center;
}
.content-editor--paper :deep(.content-editor-body p[data-align='right']) {
  text-align: right;
}
.content-editor--paper :deep(.content-editor-body p[data-indent='1']) {
  text-indent: 1em;
}
.content-editor--paper :deep(.content-editor-body p[data-indent='2']) {
  text-indent: 2em;
}
.content-editor--paper :deep(.content-editor-body p[data-indent='3']) {
  text-indent: 3em;
}
.content-editor--paper :deep(.content-editor-body p[data-size='large']) {
  font-size: 1.18em;
}
.content-editor--paper :deep(.content-editor-body p[data-size='small']) {
  font-size: 0.86em;
}
.content-editor--paper :deep(.content-editor-body p[data-gap-before='1']) {
  margin-top: 1.95em;
}
.content-editor--paper :deep(.content-editor-body p[data-gap-before='2']) {
  margin-top: 3.9em;
}
.content-editor--paper :deep(.content-editor-body p[data-gap-before='3']) {
  margin-top: 5.85em;
}
.content-editor--paper :deep(.math-node.is-block) {
  background: transparent;
  border: 0;
  padding: 0;
}
.content-editor--paper :deep(.figure-node) {
  background: transparent;
  border: 0;
  padding: 0;
}
.content-editor--paper :deep(.figure-bar) {
  display: none;
}
.content-editor--readonly :deep(.content-editor-body) {
  cursor: default;
}
</style>
