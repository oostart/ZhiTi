<script setup lang="ts">
import { computed, inject, onBeforeUnmount, reactive, ref } from 'vue'
import type { NodeViewProps } from '@tiptap/core'
import { NodeViewWrapper } from '@tiptap/vue-3'
import { AlignCenter, AlignLeft, AlignRight, Loader2 } from 'lucide-vue-next'
import AppModal from './AppModal.vue'
import { toast } from '../composables/toast'
import { FIGURE_SOURCE_KEY } from '../editor/figureContext'

const props = defineProps<NodeViewProps>()

const sourceImage = inject(FIGURE_SOURCE_KEY, computed(() => ''))

const width = computed(() => {
  const value = Number(props.node.attrs.width ?? 1) || 1
  return Math.max(0.1, Math.min(1, value))
})
const align = computed<'left' | 'center' | 'right'>(() => {
  const value = String(props.node.attrs.align || 'center')
  return value === 'left' || value === 'right' ? value : 'center'
})
const gap = computed(() => {
  const value = Number(props.node.attrs.gapBefore ?? 1)
  return Number.isFinite(value) ? Math.max(0, Math.min(3, value)) : 1
})

const figureStyle = computed(() => ({
  width: `${width.value * 100}%`,
  marginTop: `${gap.value * 1.95}em`,
  marginBottom: '0',
  marginLeft: align.value === 'left' ? '0' : 'auto',
  marginRight: align.value === 'right' ? '0' : 'auto'
}))

type ResizeMode = 'w' | 'e' | 'se'
let resizing: { startX: number; startWidth: number; mode: ResizeMode; editorWidth: number } | null = null

function startResize(event: PointerEvent, mode: ResizeMode) {
  if (!props.editor.isEditable) return
  resizing = {
    startX: event.clientX,
    startWidth: width.value,
    mode,
    editorWidth: props.editor.view.dom.clientWidth || 1
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
}

function onResizeMove(event: PointerEvent) {
  if (!resizing) return
  const delta = (event.clientX - resizing.startX) / resizing.editorWidth
  const next = resizing.mode === 'w' ? resizing.startWidth - delta : resizing.startWidth + delta
  const clamped = Math.max(0.1, Math.min(1, Math.round(next * 100) / 100))
  if (clamped !== width.value) props.updateAttributes({ width: clamped })
}

function stopResize() {
  resizing = null
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
}

function setAlign(value: 'left' | 'center' | 'right') {
  props.updateAttributes({ align: value })
}

function setGap(event: Event) {
  props.updateAttributes({ gapBefore: Number((event.target as HTMLSelectElement).value) })
}

const cropping = ref(false)
const cropBusy = ref(false)
const cropImageRef = ref<HTMLImageElement | null>(null)
const crop = reactive({ x: 0, y: 0, w: 1, h: 1 })

const cropBoxStyle = computed(() => ({
  left: `${crop.x * 100}%`,
  top: `${crop.y * 100}%`,
  width: `${crop.w * 100}%`,
  height: `${crop.h * 100}%`
}))

function openCrop() {
  if (!sourceImage.value) return
  const bbox = props.node.attrs.bbox
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const [x, y, w, h] = bbox.slice(0, 4).map((value) => Number(value))
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
      crop.x = Math.max(0, Math.min(0.95, x))
      crop.y = Math.max(0, Math.min(0.95, y))
      crop.w = Math.max(0.05, Math.min(1 - crop.x, w))
      crop.h = Math.max(0.05, Math.min(1 - crop.y, h))
      cropping.value = true
      return
    }
  }
  crop.x = 0
  crop.y = 0
  crop.w = 1
  crop.h = 1
  cropping.value = true
}

function closeCrop() {
  if (cropBusy.value) return
  cropping.value = false
  stopCropDrag()
}

type CropMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'
let cropDrag: {
  mode: CropMode
  startX: number
  startY: number
  rect: DOMRect
  start: { x: number; y: number; w: number; h: number }
} | null = null

function startCropDrag(event: PointerEvent, mode: CropMode) {
  const image = cropImageRef.value
  if (!image || cropBusy.value) return
  cropDrag = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    rect: image.getBoundingClientRect(),
    start: { ...crop }
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onCropMove)
  window.addEventListener('pointerup', stopCropDrag)
}

function onCropMove(event: PointerEvent) {
  if (!cropDrag) return
  const { rect, start, mode } = cropDrag
  const dx = (event.clientX - cropDrag.startX) / Math.max(1, rect.width)
  const dy = (event.clientY - cropDrag.startY) / Math.max(1, rect.height)
  const min = 0.05
  if (mode === 'move') {
    crop.x = Math.max(0, Math.min(1 - start.w, start.x + dx))
    crop.y = Math.max(0, Math.min(1 - start.h, start.y + dy))
    return
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.w
  let bottom = start.y + start.h
  if (mode === 'nw' || mode === 'sw') left = Math.min(right - min, Math.max(0, start.x + dx))
  if (mode === 'ne' || mode === 'se') right = Math.max(left + min, Math.min(1, start.x + start.w + dx))
  if (mode === 'nw' || mode === 'ne') top = Math.min(bottom - min, Math.max(0, start.y + dy))
  if (mode === 'sw' || mode === 'se') bottom = Math.max(top + min, Math.min(1, start.y + start.h + dy))
  crop.x = left
  crop.y = top
  crop.w = right - left
  crop.h = bottom - top
}

function stopCropDrag() {
  cropDrag = null
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onCropMove)
  window.removeEventListener('pointerup', stopCropDrag)
}

async function applyCrop() {
  const image = cropImageRef.value
  if (!image || cropBusy.value) return
  cropBusy.value = true
  try {
    const sx = Math.max(0, Math.round(crop.x * image.naturalWidth))
    const sy = Math.max(0, Math.round(crop.y * image.naturalHeight))
    const sw = Math.max(8, Math.round(crop.w * image.naturalWidth))
    const sh = Math.max(8, Math.round(crop.h * image.naturalHeight))
    const scale = Math.min(1, 1400 / sw)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw * scale))
    canvas.height = Math.max(1, Math.round(sh * scale))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    const src = canvas.toDataURL('image/jpeg', 0.92)
    props.updateAttributes({
      src,
      bbox: [crop.x, crop.y, crop.w, crop.h],
      unresolved: false
    })
    cropping.value = false
    toast('图形范围已更新', 'success', 2200)
  } catch {
    toast('裁剪失败，请重试', 'error')
  } finally {
    cropBusy.value = false
  }
}

onBeforeUnmount(() => {
  stopResize()
  stopCropDrag()
})
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="figure-node"
    :class="{ 'is-selected': selected, 'is-missing': !node.attrs.src, 'is-editable': editor.isEditable }"
    :style="figureStyle"
    contenteditable="false"
  >
    <div class="figure-frame">
      <img v-if="node.attrs.src" :src="node.attrs.src" alt="题目图形" draggable="false" />
      <div v-else class="figure-missing">
        <div class="figure-missing-title">图形区域未定位</div>
        <div class="figure-missing-desc">可在「原图 / 文字」中查看，或重新识别</div>
      </div>
      <template v-if="editor.isEditable">
        <span class="figure-handle is-w" title="拖动调整宽度" @pointerdown.prevent.stop="startResize($event, 'w')" />
        <span class="figure-handle is-e" title="拖动调整宽度" @pointerdown.prevent.stop="startResize($event, 'e')" />
        <span class="figure-handle is-se" title="拖动调整宽度" @pointerdown.prevent.stop="startResize($event, 'se')" />
      </template>
    </div>
    <div v-if="editor.isEditable" class="figure-bar" :class="`is-${align}`">
      <span class="figure-tag">{{ node.attrs.unresolved ? '待确认图形' : '图形' }} · {{ Math.round(width * 100) }}%</span>
      <div class="figure-tools">
        <div class="figure-align">
          <button type="button" :class="{ active: align === 'left' }" title="左对齐" @mousedown.prevent @click="setAlign('left')">
            <AlignLeft :size="13" />
          </button>
          <button type="button" :class="{ active: align === 'center' }" title="居中" @mousedown.prevent @click="setAlign('center')">
            <AlignCenter :size="13" />
          </button>
          <button type="button" :class="{ active: align === 'right' }" title="右对齐" @mousedown.prevent @click="setAlign('right')">
            <AlignRight :size="13" />
          </button>
        </div>
        <select class="figure-gap" :value="gap" title="图形上方间距" @change="setGap">
          <option v-for="level in 4" :key="level - 1" :value="level - 1">{{ level - 1 }} 行间距</option>
        </select>
        <button v-if="sourceImage" type="button" class="figure-crop" @mousedown.prevent @click="openCrop">调整范围</button>
        <button type="button" class="figure-remove" @mousedown.prevent @click="deleteNode?.()">删除</button>
      </div>
    </div>

    <AppModal v-if="cropping" title="调整图形范围" :width="860" :z-index="95" @close="closeCrop">
      <template #description>拖动裁剪框移动位置，拖四角调整大小，框选要显示的图形区域。</template>
      <div class="crop-wrap">
        <div class="crop-stage">
          <img ref="cropImageRef" :src="sourceImage" alt="题目原图" draggable="false" />
          <div class="crop-box" :style="cropBoxStyle" @pointerdown.prevent.stop="startCropDrag($event, 'move')">
            <span class="crop-handle is-nw" @pointerdown.prevent.stop="startCropDrag($event, 'nw')" />
            <span class="crop-handle is-ne" @pointerdown.prevent.stop="startCropDrag($event, 'ne')" />
            <span class="crop-handle is-sw" @pointerdown.prevent.stop="startCropDrag($event, 'sw')" />
            <span class="crop-handle is-se" @pointerdown.prevent.stop="startCropDrag($event, 'se')" />
          </div>
        </div>
      </div>
      <template #actions>
        <button class="btn" @click="closeCrop">取消</button>
        <button class="btn btn-primary" :disabled="cropBusy" @click="applyCrop">
          <Loader2 v-if="cropBusy" :size="14" class="spin" /> 应用裁剪
        </button>
      </template>
    </AppModal>
  </NodeViewWrapper>
</template>

<style scoped>
.figure-node {
  display: block;
  position: relative;
  margin: 6px 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
}
.figure-frame {
  position: relative;
}
.figure-node img {
  display: block;
  width: 100%;
  height: auto;
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
.figure-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid #fff;
  border-radius: 3px;
  background: #6d5ce7;
  box-shadow: 0 0 0 1px rgba(109, 92, 231, 0.35);
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 2;
}
.figure-node:hover .figure-handle,
.figure-node.is-selected .figure-handle {
  opacity: 1;
}
.figure-handle.is-w {
  top: 50%;
  left: 0;
  transform: translate(-50%, -50%);
  cursor: ew-resize;
}
.figure-handle.is-e {
  top: 50%;
  right: 0;
  transform: translate(50%, -50%);
  cursor: ew-resize;
}
.figure-handle.is-se {
  right: 0;
  bottom: 0;
  transform: translate(50%, 50%);
  cursor: nwse-resize;
}
.figure-bar {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.12);
  white-space: nowrap;
  transform: translateX(-50%);
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.figure-bar.is-left {
  left: 0;
  transform: none;
}
.figure-bar.is-right {
  right: 0;
  left: auto;
  transform: none;
}
.figure-bar::before {
  content: '';
  position: absolute;
  top: -10px;
  right: 0;
  left: 0;
  height: 10px;
}
.figure-node:hover .figure-bar,
.figure-node:focus-within .figure-bar {
  visibility: visible;
  opacity: 1;
}
.figure-tag {
  font-size: 11px;
  color: var(--text-3);
}
.figure-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.figure-align {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.figure-align button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border: 0;
  border-right: 1px solid var(--border);
  background: #fff;
  color: var(--text-3);
  cursor: pointer;
}
.figure-align button:last-child {
  border-right: 0;
}
.figure-align button:hover {
  background: #f4f5fa;
}
.figure-align button.active {
  background: #f5f3ff;
  color: #5145cd;
}
.figure-gap {
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  color: var(--text-2);
  font-size: 11px;
  outline: none;
}
.figure-crop {
  height: 24px;
  padding: 0 8px;
  border: 1px solid #d7d5fb;
  border-radius: 6px;
  background: #f5f3ff;
  color: #5145cd;
  font-size: 11.5px;
  cursor: pointer;
}
.figure-crop:hover {
  background: #ede9fe;
}
.figure-remove {
  border: 0;
  background: transparent;
  color: #dc2626;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
}
.crop-wrap {
  text-align: center;
}
.crop-stage {
  position: relative;
  display: inline-block;
  width: fit-content;
  max-width: 100%;
  line-height: 0;
}
.crop-stage img {
  display: block;
  max-width: 100%;
  max-height: 62vh;
  width: auto;
  height: auto;
}
.crop-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #6d5ce7;
  background: rgba(109, 92, 231, 0.12);
  cursor: move;
}
.crop-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid #fff;
  border-radius: 2px;
  background: #6d5ce7;
}
.crop-handle.is-nw {
  top: -6px;
  left: -6px;
  cursor: nwse-resize;
}
.crop-handle.is-ne {
  top: -6px;
  right: -6px;
  cursor: nesw-resize;
}
.crop-handle.is-sw {
  bottom: -6px;
  left: -6px;
  cursor: nesw-resize;
}
.crop-handle.is-se {
  right: -6px;
  bottom: -6px;
  cursor: nwse-resize;
}
.spin {
  animation: figure-spin 0.8s linear infinite;
}
@keyframes figure-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
