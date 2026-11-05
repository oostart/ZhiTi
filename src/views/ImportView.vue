<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { FileText, Loader2, Pencil, Scissors, Trash2, UploadCloud, Wand2 } from 'lucide-vue-next'
import { cacheDocument, disposeDocument, readPdfFile, type OpenedPdf } from '../utils/pdf'
import { createPaper, deletePaper, state, ui, updatePaper } from '../store'
import { toast } from '../composables/toast'
import AppModal from '../components/AppModal.vue'
import { SUBJECTS, GRADES, type Paper } from '../types'

const fileInput = ref<HTMLInputElement>()
const opened = shallowRef<OpenedPdf | null>(null)
const selectedFile = ref<File | null>(null)
const parsing = ref(false)
const importing = ref(false)
const dragging = ref(false)
const pendingDelete = ref<number | null>(null)
const editingPaper = ref<Paper | null>(null)
const savingEdit = ref(false)

const form = reactive({
  title: '',
  year: new Date().getFullYear(),
  subject: '数学',
  grade: '九年级'
})

const editForm = reactive({
  title: '',
  year: new Date().getFullYear(),
  subject: '数学',
  grade: '九年级'
})

const canImport = computed(() => !!opened.value && form.title.trim().length > 0 && !parsing.value && !importing.value)

const fileSizeText = computed(() => {
  if (!selectedFile.value) return ''
  const mb = selectedFile.value.size / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(selectedFile.value.size / 1024)} KB`
})

function questionCount(paperId: number): number {
  return state.questions.filter((q) => q.paper_id === paperId).length
}

async function handleFile(file: File | undefined | null) {
  if (!file) return
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('仅支持 PDF 格式的试卷文件', 'error')
    return
  }
  if (file.size > 120 * 1024 * 1024) {
    toast('文件超过 120 MB，请压缩后再导入', 'error')
    return
  }
  parsing.value = true
  selectedFile.value = file
  opened.value = null
  try {
    const result = await readPdfFile(file)
    opened.value = result
    form.title = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || '未命名试卷'
    toast(`已解析 ${result.pageCount} 页 PDF，请确认试卷信息`, 'success')
  } catch (error) {
    const message = (error as Error).message || ''
    selectedFile.value = null
    if (fileInput.value) fileInput.value.value = ''
    if (/password/i.test(message)) toast('该 PDF 已加密，暂不支持导入加密文档', 'error')
    else toast('PDF 解析失败：文件可能已损坏或格式不支持', 'error')
  } finally {
    parsing.value = false
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false
  handleFile(event.dataTransfer?.files?.[0])
}

async function doImport() {
  if (!opened.value) return
  importing.value = true
  try {
    const paper = await createPaper({
      title: form.title.trim(),
      year: Number(form.year) || new Date().getFullYear(),
      subject: form.subject,
      grade: form.grade,
      page_count: opened.value.pageCount,
      source_name: selectedFile.value?.name,
      file: opened.value.bytes
    })
    cacheDocument(paper.id, opened.value.doc)
    ui.activePaperId = paper.id
    ui.view = 'cut'
    toast(`「${paper.title}」导入成功，共 ${paper.page_count} 页，开始切割题目`, 'success')
    opened.value = null
    selectedFile.value = null
    form.title = ''
    if (fileInput.value) fileInput.value.value = ''
  } catch (error) {
    toast('导入失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    importing.value = false
  }
}

function continueCut(paperId: number) {
  ui.activePaperId = paperId
  ui.view = 'cut'
}

function openEdit(paper: Paper) {
  editingPaper.value = paper
  editForm.title = paper.title
  editForm.year = paper.year
  editForm.subject = paper.subject
  editForm.grade = paper.grade
}

async function saveEdit() {
  const target = editingPaper.value
  if (!target) return
  const title = editForm.title.trim()
  if (!title) {
    toast('试卷标题不能为空', 'warning')
    return
  }
  savingEdit.value = true
  try {
    await updatePaper(target.id, {
      title,
      year: Number(editForm.year) || target.year,
      subject: editForm.subject,
      grade: editForm.grade
    })
    toast('试卷信息已更新', 'success')
    editingPaper.value = null
  } catch (error) {
    toast('保存失败：' + ((error as Error).message || '未知错误'), 'error')
  } finally {
    savingEdit.value = false
  }
}

async function confirmDelete() {
  if (pendingDelete.value == null) return
  const id = pendingDelete.value
  await deletePaper(id)
  await disposeDocument(id)
  pendingDelete.value = null
  toast('已删除该试卷及关联题目', 'success')
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <div class="view">
    <div class="workspace" style="max-width: 1040px; margin: 0 auto; width: 100%">
      <div class="hero">
        <div>
          <h1>导入一份 PDF 试卷</h1>
          <p>系统会解析每一页并生成高清预览，接着用框选把题目切进题库。原始 PDF 保存在本地，可随时继续切割。</p>
        </div>
        <div class="hero-badges">
          <span class="chip"><Wand2 :size="12" /> 智能切割</span>
          <span class="chip"><FileText :size="12" /> 本地解析</span>
          <span class="chip"><Scissors :size="12" /> 跨页合并</span>
        </div>
      </div>

      <div class="import-grid">
        <div>
          <div
            class="dropzone"
            :class="{ dragging, filled: !!selectedFile }"
            @click="fileInput?.click()"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <input ref="fileInput" type="file" accept="application/pdf,.pdf" hidden @change="handleFile(($event.target as HTMLInputElement).files?.[0])" />
            <template v-if="!selectedFile">
              <div class="drop-icon"><UploadCloud :size="26" /></div>
              <div class="drop-title">拖拽 PDF 到此处，或点击选择文件</div>
              <div class="hint">支持多页 PDF 试卷（十几页也可），最大 120 MB · 文件仅保存在本机</div>
            </template>
            <template v-else>
              <div class="drop-icon" :style="{ background: parsing ? '#eef0ff' : '#e7f7f1', color: parsing ? '#4f46e5' : '#059669' }">
                <Loader2 v-if="parsing" :size="24" class="spin" />
                <FileText v-else :size="24" />
              </div>
              <div class="drop-title">{{ selectedFile.name }}</div>
              <div class="hint">
                <template v-if="parsing">正在解析 PDF 页面…</template>
                <template v-else-if="opened">{{ fileSizeText }} · {{ opened.pageCount }} 页 · 解析完成，点击可更换文件</template>
                <template v-else>解析失败，点击重新选择</template>
              </div>
            </template>
          </div>

          <div class="card card-pad" style="margin-top: 16px">
            <div class="section-title">试卷基本信息</div>
            <div class="field">
              <label class="label">试卷标题<span class="req">*</span></label>
              <input v-model="form.title" class="input" placeholder="例如：2024 年上海市初三物理一模试卷" />
            </div>
            <div class="row-3">
              <div class="field">
                <label class="label">年份</label>
                <input v-model.number="form.year" type="number" class="input" min="1990" max="2100" />
              </div>
              <div class="field">
                <label class="label">学科</label>
                <select v-model="form.subject" class="select">
                  <option v-for="s in SUBJECTS" :key="s">{{ s }}</option>
                </select>
              </div>
              <div class="field">
                <label class="label">年级</label>
                <select v-model="form.grade" class="select">
                  <option v-for="g in GRADES" :key="g">{{ g }}</option>
                </select>
              </div>
            </div>
            <button class="btn btn-primary btn-lg" style="width: 100%; margin-top: 6px" :disabled="!canImport" @click="doImport">
              <Loader2 v-if="importing" :size="16" class="spin" />
              <Scissors v-else :size="16" />
              {{ importing ? '正在导入…' : '导入并开始切割' }}
            </button>
            <div class="hint" style="margin-top: 10px; text-align: center">导入后可随时回到「题目切割」继续处理同一份试卷</div>
          </div>
        </div>

        <div class="card card-pad">
          <div class="section-title">
            已导入试卷 <span class="count">{{ state.papers.length }}</span>
          </div>
          <div v-if="state.papers.length === 0" class="hint" style="padding: 24px 0; text-align: center">
            还没有导入过试卷。<br />导入第一份 PDF 后，它会出现在这里。
          </div>
          <div v-else class="paper-list">
            <div v-for="paper in state.papers" :key="paper.id" class="paper-row">
              <div class="paper-icon"><FileText :size="17" /></div>
              <div style="flex: 1; min-width: 0">
                <div class="paper-title" :title="paper.title">{{ paper.title }}</div>
                <div class="paper-meta">
                  {{ paper.subject }} · {{ paper.grade }} · {{ paper.year }} 年 · {{ paper.page_count }} 页 ·
                  {{ questionCount(paper.id) }} 题 · {{ formatDate(paper.created_at) }}
                </div>
              </div>
              <div class="paper-actions">
                <button class="btn btn-ghost btn-icon" title="编辑试卷信息" @click="openEdit(paper)">
                  <Pencil :size="14" />
                </button>
                <button class="btn btn-sm" @click="continueCut(paper.id)"><Scissors :size="13" /> 切割</button>
                <button class="btn btn-ghost btn-icon" title="删除试卷" @click="pendingDelete = paper.id">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </div>
          <div class="hint" style="margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px">
            提示：删除试卷会同时移除由它切割出的全部题目，该操作不可撤销。
          </div>
        </div>
      </div>
    </div>

    <AppModal v-if="pendingDelete != null" title="删除这份试卷？" @close="pendingDelete = null">
      <template #description>关联的题目也会一并删除，无法恢复。</template>
      <div class="hint">
        即将删除：<strong>{{ state.papers.find((p) => p.id === pendingDelete)?.title }}</strong>
        （{{ pendingDelete ? questionCount(pendingDelete) : 0 }} 道题目）
      </div>
      <template #actions>
        <button class="btn" @click="pendingDelete = null">取消</button>
        <button class="btn btn-danger" @click="confirmDelete"><Trash2 :size="14" /> 确认删除</button>
      </template>
    </AppModal>

    <AppModal v-if="editingPaper" title="编辑试卷信息" @close="editingPaper = null">
      <template #description>修改仅影响题库中的试卷信息，不会改动原始 PDF 文件。</template>
      <div class="field">
        <label class="label">试卷标题<span class="req">*</span></label>
        <input v-model="editForm.title" class="input" placeholder="试卷标题" />
      </div>
      <div class="row-3">
        <div class="field">
          <label class="label">年份</label>
          <input v-model.number="editForm.year" type="number" class="input" min="1990" max="2100" />
        </div>
        <div class="field">
          <label class="label">学科</label>
          <select v-model="editForm.subject" class="select">
            <option v-for="s in SUBJECTS" :key="s">{{ s }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label">年级</label>
          <select v-model="editForm.grade" class="select">
            <option v-for="g in GRADES" :key="g">{{ g }}</option>
          </select>
        </div>
      </div>
      <template #actions>
        <button class="btn" @click="editingPaper = null">取消</button>
        <button class="btn btn-primary" :disabled="savingEdit" @click="saveEdit">
          <Loader2 v-if="savingEdit" :size="14" class="spin" />
          保存修改
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
  padding: 4px 2px;
  flex-wrap: wrap;
}
.hero h1 {
  font-size: 23px;
  margin: 0 0 7px;
  letter-spacing: -0.3px;
}
.hero p {
  margin: 0;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.7;
  max-width: 620px;
}
.hero-badges {
  display: flex;
  gap: 6px;
}
.import-grid {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 16px;
  align-items: start;
}
.dropzone {
  border: 1.5px dashed #c7cee0;
  border-radius: var(--radius-lg);
  background: #fff;
  padding: 34px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.16s;
}
.dropzone:hover,
.dropzone.dragging {
  border-color: var(--accent);
  background: #f8f8ff;
}
.dropzone.filled {
  border-style: solid;
  border-color: #d6dbea;
}
.drop-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: #f1f3fa;
  color: #6b7280;
  display: grid;
  place-items: center;
  margin: 0 auto 12px;
  transition: all 0.2s;
}
.drop-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
  word-break: break-all;
}
.spin {
  animation: spin 0.8s linear infinite;
}
.paper-list {
  display: flex;
  flex-direction: column;
  margin: 0 -18px;
}
.paper-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 18px;
  border-bottom: 1px solid #f0f2f7;
}
.paper-row:last-child {
  border-bottom: 0;
}
.paper-row:hover {
  background: #fafbfe;
}
.paper-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #eef0ff;
  color: #4f46e5;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.paper-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-meta {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.paper-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0.75;
  transition: opacity 0.15s;
}
.paper-row:hover .paper-actions {
  opacity: 1;
}
@media (max-width: 900px) {
  .import-grid {
    grid-template-columns: 1fr;
  }
}
</style>
