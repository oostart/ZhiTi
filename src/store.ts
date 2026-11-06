import { reactive } from 'vue'
import { repositories, db } from './db'
import { disposeAllDocuments } from './utils/pdf'
import type { AppSettings, KnowledgePoint, Paper, Question } from './types'

export type ViewKey = 'import' | 'cut' | 'bank' | 'export' | 'settings'

export interface UiState {
  view: ViewKey
  activePaperId: number | null
  activeQuestionId: number | null
  exportIds: number[]
  bankKeyword: string
  /** 每份试卷最后浏览的页码，切换视图/试卷后恢复 */
  cutPageByPaper: Record<number, number>
}

const defaultSettings: AppSettings = {
  ai: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    visionModel: '',
    apiKey: '',
    temperature: 0.2
  },
  ocr: { lang: 'chi_sim+eng' }
}

export const state = reactive({
  ready: false,
  papers: [] as Paper[],
  questions: [] as Question[],
  knowledge: [] as KnowledgePoint[],
  settings: structuredClone(defaultSettings) as AppSettings
})

export const ui = reactive<UiState>({
  view: 'import',
  activePaperId: null,
  activeQuestionId: null,
  exportIds: [],
  bankKeyword: '',
  cutPageByPaper: {}
})

/** 旧版本首次启动时写入的预置知识点目录；现在仅用于一次性清理，不再产生新数据 */
const LEGACY_SEED_KNOWLEDGE: Record<string, string[]> = {
  物理: [
    '运动的描述',
    '匀变速直线运动',
    '相互作用与力',
    '牛顿运动定律',
    '曲线运动',
    '万有引力',
    '机械能守恒',
    '静电场',
    '恒定电流',
    '磁场',
    '电磁感应',
    '交变电流',
    '光的折射与反射',
    '机械振动与机械波',
    '动量守恒',
    '热学基础'
  ],
  数学: [
    '集合与常用逻辑用语',
    '函数与导数',
    '三角函数',
    '平面向量',
    '数列',
    '不等式',
    '立体几何',
    '解析几何',
    '概率与统计',
    '复数',
    '排列组合',
    '算法初步'
  ],
  化学: [
    '物质的分类与转化',
    '化学计量',
    '离子反应',
    '氧化还原反应',
    '金属及其化合物',
    '非金属及其化合物',
    '化学反应速率与平衡',
    '水溶液中的离子平衡',
    '电化学',
    '有机化合物',
    '化学实验基础'
  ],
  英语: ['语法填空', '完形填空', '阅读理解', '七选五', '书面表达', '听力理解', '词汇与短语', '定语从句', '时态与语态'],
  语文: ['现代文阅读', '文言文阅读', '古诗词鉴赏', '语言文字运用', '名篇名句默写', '作文', '文学类文本', '实用类文本'],
  生物: ['细胞的分子组成', '细胞的结构与功能', '细胞的代谢', '细胞的生命历程', '遗传的基本规律', '基因的表达', '变异与育种', '生命活动的调节', '生态系统', '生物技术实践'],
  历史: ['古代中国政治制度', '近代中国民主革命', '现代中国外交', '古代世界经济', '近代世界经济', '世界现代史', '史学素养'],
  地理: ['地球与地图', '大气运动', '水循环与洋流', '地貌形成', '人口与城市', '农业与工业区位', '区域可持续发展', '地理信息技术'],
  政治: ['经济生活', '政治生活', '文化生活', '生活与哲学', '当代国际政治与经济']
}

function withoutId<T extends { id: number }>(value: T): Omit<T, 'id'> {
  const { id: _ignored, ...rest } = value
  return rest
}

const PRESET_CLEANUP_KEY = 'knowledge-preset-cleanup-v1'

/** 一次性清除旧版本写入、且从未被题目引用的预置知识点 */
async function cleanupLegacyPresetKnowledge(): Promise<void> {
  const done = await db.get<{ key: string; value: boolean }>('settings', PRESET_CLEANUP_KEY)
  if (done?.value) return
  const presetNames = new Set(Object.values(LEGACY_SEED_KNOWLEDGE).flat())
  const usedNames = new Set(state.questions.flatMap((q) => q.knowledge))
  const removable = state.knowledge.filter((k) => presetNames.has(k.name) && !usedNames.has(k.name))
  for (const row of removable) await db.remove('knowledge', row.id)
  const removedIds = new Set(removable.map((row) => row.id))
  state.knowledge = state.knowledge.filter((row) => !removedIds.has(row.id))
  await db.put('settings', { key: PRESET_CLEANUP_KEY, value: true })
}

export async function initStore(): Promise<void> {
  if (state.ready) return
  const [papers, questions, knowledge, settings] = await Promise.all([
    repositories.papers(),
    repositories.questions(),
    repositories.knowledge(),
    repositories.settings()
  ])
  state.papers = papers.sort((a, b) => b.created_at.localeCompare(a.created_at))
  state.questions = questions.sort((a, b) => a.order - b.order)
  state.knowledge = knowledge.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  state.settings = settings ? { ...defaultSettings, ...settings, ai: { ...defaultSettings.ai, ...settings.ai } } : structuredClone(defaultSettings)

  await cleanupLegacyPresetKnowledge()
  state.ready = true
}

export async function reloadStore(): Promise<void> {
  state.ready = false
  state.papers = []
  state.questions = []
  state.knowledge = []
  ui.activePaperId = null
  ui.activeQuestionId = null
  ui.exportIds = []
  ui.bankKeyword = ''
  ui.cutPageByPaper = {}
  await disposeAllDocuments()
  await initStore()
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
  const next: AppSettings = {
    ...state.settings,
    ...patch,
    ai: { ...state.settings.ai, ...(patch.ai ?? {}) },
    ocr: { ...state.settings.ocr, ...(patch.ocr ?? {}) }
  }
  state.settings = next
  await repositories.saveSettings(next)
}

export async function createPaper(input: {
  title: string
  year: number
  subject: string
  grade: string
  page_count: number
  source_name?: string
  file: ArrayBuffer
}): Promise<Paper> {
  const paper: Paper = {
    id: 0,
    title: input.title,
    year: input.year,
    subject: input.subject,
    grade: input.grade,
    created_at: new Date().toISOString(),
    page_count: input.page_count,
    source_name: input.source_name
  }
  const id = await db.put('papers', withoutId(paper))
  paper.id = id
  await repositories.saveFile({ paper_id: id, name: input.source_name ?? `${input.title}.pdf`, data: input.file })
  state.papers.unshift(paper)
  return paper
}

export async function updatePaper(id: number, patch: Partial<Pick<Paper, 'title' | 'year' | 'subject' | 'grade'>>): Promise<void> {
  const index = state.papers.findIndex((p) => p.id === id)
  if (index < 0) return
  const next: Paper = { ...state.papers[index], ...patch, id }
  state.papers[index] = next
  await db.put('papers', next)
}

export async function deletePaper(paperId: number): Promise<void> {
  const related = state.questions.filter((q) => q.paper_id === paperId)
  for (const q of related) await db.remove('questions', q.id)
  state.questions = state.questions.filter((q) => q.paper_id !== paperId)
  await db.remove('papers', paperId)
  await repositories.removeFile(paperId)
  state.papers = state.papers.filter((p) => p.id !== paperId)
  delete ui.cutPageByPaper[paperId]
  if (ui.activePaperId === paperId) ui.activePaperId = state.papers[0]?.id ?? null
}

function toPlainRegion(region: Question['regions'][number]): Question['regions'][number] {
  return { page: region.page, x: region.x, y: region.y, w: region.w, h: region.h }
}

/** 结构化内容是 Vue 响应式代理，写入数据库前转成纯 JSON，避免 IndexedDB 克隆失败 */
function toPlainContent(content: Question['content']): Question['content'] {
  return content ? (JSON.parse(JSON.stringify(content)) as NonNullable<Question['content']>) : undefined
}

function nextOrder(): number {
  return state.questions.reduce((max, q) => Math.max(max, q.order), 0) + 1
}

export async function createQuestion(input: Partial<Question>): Promise<Question> {
  const question: Question = {
    id: 0,
    paper_id: input.paper_id ?? null,
    image: input.image ?? '',
    regions: (input.regions ?? []).map(toPlainRegion),
    ocr_text: input.ocr_text ?? '',
    answer: input.answer ?? '',
    difficulty: input.difficulty ?? 3,
    question_type: input.question_type ?? '其他',
    created_at: new Date().toISOString(),
    order: nextOrder(),
    knowledge: [...(input.knowledge ?? [])],
    analysis: input.analysis ?? '',
    content: toPlainContent(input.content)
  }
  const id = await db.put('questions', withoutId(question))
  question.id = id
  state.questions.push(question)
  return question
}

export async function updateQuestion(id: number, patch: Partial<Question>): Promise<void> {
  const index = state.questions.findIndex((q) => q.id === id)
  if (index < 0) return
  const next: Question = { ...state.questions[index], ...patch, id }
  next.regions = next.regions.map(toPlainRegion)
  next.knowledge = [...next.knowledge]
  next.content = toPlainContent(next.content)
  state.questions[index] = next
  await db.put('questions', next)
}

export async function deleteQuestion(id: number): Promise<void> {
  state.questions = state.questions.filter((q) => q.id !== id)
  await db.remove('questions', id)
  if (ui.activeQuestionId === id) ui.activeQuestionId = null
  ui.exportIds = ui.exportIds.filter((x) => x !== id)
}

export async function reorderQuestions(ids: number[]): Promise<void> {
  const map = new Map(state.questions.map((q) => [q.id, q]))
  const result: Question[] = []
  let order = 1
  for (const id of ids) {
    const q = map.get(id)
    if (!q) continue
    q.order = order++
    result.push(q)
    await db.put('questions', { ...q, regions: q.regions.map(toPlainRegion), knowledge: [...q.knowledge] })
  }
  state.questions = state.questions
    .filter((q) => !ids.includes(q.id))
    .concat(result)
    .sort((a, b) => a.order - b.order)
  state.questions.forEach((q, i) => (q.order = i + 1))
}

export async function addKnowledgePoint(name: string, subject: string): Promise<KnowledgePoint> {
  const existing = state.knowledge.find((k) => k.name === name && k.subject === subject)
  if (existing) return existing
  const row: KnowledgePoint = { id: 0, name, parent_id: null, subject }
  const id = await db.put('knowledge', withoutId(row))
  row.id = id
  state.knowledge.push(row)
  state.knowledge.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return row
}

export async function deleteKnowledgePoint(id: number): Promise<void> {
  const target = state.knowledge.find((k) => k.id === id)
  if (!target) return
  for (const q of state.questions) {
    if (q.knowledge.includes(target.name)) {
      await updateQuestion(q.id, { knowledge: q.knowledge.filter((n) => n !== target.name) })
    }
  }
  await db.remove('knowledge', id)
  state.knowledge = state.knowledge.filter((k) => k.id !== id)
}

export function paperOf(question: Question): Paper | undefined {
  return state.papers.find((p) => p.id === question.paper_id)
}
