export interface Paper {
  id: number
  title: string
  year: number
  subject: string
  grade: string
  created_at: string
  page_count: number
  source_name?: string
}

/** 归一化坐标：0~1，原点在页面左上角 */
export interface Region {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** TipTap / ProseMirror 文档节点（结构松散，便于兼容不同版本） */
export interface ContentNode {
  type: string
  text?: string
  attrs?: Record<string, any>
  content?: ContentNode[]
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
}

/** 结构化题目内容：paragraph / mathInline / mathBlock / figure */
export interface ContentDoc {
  type: 'doc'
  content?: ContentNode[]
}

export interface Question {
  id: number
  paper_id: number | null
  /** 题目图片（dataURL，多区域时纵向拼接） */
  image: string
  regions: Region[]
  /** 题干纯文本（用于搜索、AI 分析与导出兜底） */
  text: string
  answer: string
  /** 难度 1-5 */
  difficulty: number
  question_type: string
  created_at: string
  order: number
  knowledge: string[]
  analysis: string
  /** 结构化内容；为空表示尚未识别，仍按原图展示 */
  content?: ContentDoc
}

export interface KnowledgePoint {
  id: number
  name: string
  parent_id: number | null
  subject: string
}

export interface AiSettings {
  provider: 'deepseek' | 'qwen' | 'custom'
  baseUrl: string
  model: string
  /** 识图用模型；留空时沿用 model */
  visionModel: string
  apiKey: string
  temperature: number
}

export interface AppSettings {
  ai: AiSettings
}

export interface StoredFile {
  paper_id: number
  name: string
  data: ArrayBuffer
}

export interface ExportOptions {
  title: string
  subtitle: string
  showAnswer: boolean
  onePerPage: boolean
  showNumber: boolean
  pageSize: 'a4' | 'letter'
  margin: number
  scale: number
  fileName: string
}

export const GRADES = [
  '一年级',
  '二年级',
  '三年级',
  '四年级',
  '五年级',
  '六年级',
  '七年级',
  '八年级',
  '九年级',
  '高一',
  '高二',
  '高三'
]
export const QUESTION_TYPES = ['单选题', '多选题', '填空题', '判断题', '解答题', '计算题', '实验题', '阅读理解', '作文题', '其他']

export const DIFFICULTY_LABELS: Record<number, string> = {
  1: '很容易',
  2: '较容易',
  3: '中等',
  4: '较难',
  5: '很难'
}

export const TYPE_BADGE_CLASS: Record<string, string> = {
  单选题: 'badge-blue',
  多选题: 'badge-indigo',
  填空题: 'badge-teal',
  判断题: 'badge-amber',
  解答题: 'badge-violet',
  计算题: 'badge-cyan',
  实验题: 'badge-orange',
  阅读理解: 'badge-pink',
  作文题: 'badge-rose',
  其他: 'badge-gray'
}
