<script setup lang="ts">
import { computed } from 'vue'
import type { NodeViewProps } from '@tiptap/core'
import { NodeViewWrapper } from '@tiptap/vue-3'

const props = defineProps<NodeViewProps>()

const figureStyle = computed(() => {
  const width = Math.max(0.1, Math.min(1, Number(props.node.attrs.width ?? 1) || 1))
  const align = String(props.node.attrs.align || 'center')
  const gapValue = Number(props.node.attrs.gapBefore ?? 1)
  const gap = Number.isFinite(gapValue) ? Math.max(0, Math.min(3, gapValue)) : 1
  return {
    width: `${width * 100}%`,
    marginTop: `${gap * 1.95}em`,
    marginBottom: '0',
    marginLeft: align === 'left' ? '0' : 'auto',
    marginRight: align === 'right' ? '0' : 'auto'
  }
})
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="figure-node"
    :class="{ 'is-selected': selected, 'is-missing': !node.attrs.src }"
    :style="figureStyle"
    contenteditable="false"
  >
    <img v-if="node.attrs.src" :src="node.attrs.src" alt="题目图形" />
    <div v-else class="figure-missing">
      <div class="figure-missing-title">图形区域未定位</div>
      <div class="figure-missing-desc">可在「原图 / 文字」中查看，或重新识别</div>
    </div>
    <div v-if="editor.isEditable" class="figure-bar">
      <span class="figure-tag">{{ node.attrs.unresolved ? '待确认图形' : '图形 · 来自原图裁剪' }}</span>
      <button type="button" class="figure-remove" @mousedown.prevent @click="deleteNode?.()">删除</button>
    </div>
  </NodeViewWrapper>
</template>

<style scoped>
.figure-node {
  display: block;
  margin: 6px 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
}
.figure-node img {
  display: block;
  max-width: 100%;
  margin: 0 auto;
}
.figure-node.is-selected {
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.35);
}
.figure-node.is-missing {
  border-style: dashed;
}
.figure-missing {
  display: grid;
  gap: 3px;
  place-items: center;
  padding: 16px 8px;
  color: var(--text-3);
}
.figure-missing-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.figure-missing-desc {
  font-size: 11px;
}
.figure-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}
.figure-tag {
  font-size: 11px;
  color: var(--text-3);
}
.figure-remove {
  border: 0;
  background: transparent;
  color: #dc2626;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
}
</style>
