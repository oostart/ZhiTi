import katex from 'katex'
import 'katex/contrib/mhchem'
import type { AiSettings, ContentDoc, ContentNode } from '../types'
import { chat, type ChatMessage } from './ai'
import { loadImage } from './image'

export type LayoutAlign = 'left' | 'center' | 'right'
export type LayoutSize = 'large' | 'normal' | 'small'

export interface LayoutStyle {
  align: LayoutAlign
  indent: number
  size: LayoutSize
  gapBefore: number
}

export type LayoutRun = { type: 'text'; text: string } | { type: 'math'; latex: string; display?: boolean }

export type LayoutBlock =
  | ({ type: 'paragraph'; runs: LayoutRun[] } & LayoutStyle)
  | ({ type: 'math'; latex: string; display: boolean } & LayoutStyle)
  | ({ type: 'image'; bbox: [number, number, number, number] | null; width: number } & LayoutStyle)

export interface LayoutResult {
  content: ContentDoc
  text: string
  warnings: string[]
  mathCount: number
  figureCount: number
  unresolved: number
}

const SYSTEM_PROMPT = [
  '你是一名试卷排版转录员。唯一任务是把图片中的题目逐行原样转录成结构化 JSON。',
  '禁止解答、改写、纠错、翻译、补充或推断图片中没有的内容。',
  '只输出 JSON，不要输出 markdown 代码块、解释或任何前后缀。'
].join('\n')

const USER_PROMPT = [
  '这是一道从试卷中裁剪出的题目。请严格按视觉行转录，输出：',
  '{"blocks":[',
  '  {"type":"line","runs":[{"type":"text","text":"10. 已知 "},{"type":"math","latex":"f(x)=x^2"}],"align":"left","indent":0,"size":"normal","gapBefore":0},',
  '  {"type":"line","runs":[{"type":"text","text":"（A）1    （B）2"}],"align":"left","indent":0,"size":"normal","gapBefore":0},',
  '  {"type":"math","latex":"d=\\sqrt{1-S}","align":"center","gapBefore":1},',
  '  {"type":"image","bbox":[0.2,0.5,0.45,0.3],"width":0.45,"align":"center","gapBefore":1}',
  ']}',
  '规则：',
  '1. 每一行一个 line，按从上到下的顺序；不要把两行合并成一行，也不要替原文自动换行。',
  '2. 段落内的公式放在 runs 里，类型为 math；独立成行的公式用 type=math。',
  '3. align 用 left/center/right；indent 用 0/1/2/3，表示行首缩进几个汉字宽；size 用 large/normal/small；gapBefore 用 0/1/2/3，表示本行前空几行。',
  '4. 图形、坐标图、表格一律用 type=image：bbox 是相对整张裁剪图的归一化坐标 [x,y,w,h]，width 是图形相对裁剪图宽度（0~1），不要用文字描述图形。',
  '5. LaTeX 不要带 $、\\( \\)、\\[ \\] 定界符；化学方程式用 \\ce{}。',
  '6. 保留原文标点、空格、题号和选项顺序；看不清的字符写成 □，不要猜测。'
].join('\n')

/** 调用视觉模型识别一道题，并转换成带版式信息的结构化内容 */
export async function recognizeQuestionLayout(config: AiSettings, imageDataUrl: string): Promise<LayoutResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: USER_PROMPT },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
    }
  ]
  const raw = await chat(config, messages, {
    model: (config.visionModel || '').trim() || config.model,
    temperature: 0,
    maxTokens: 4096,
    timeoutMs: 90000
  })
  const blocks = parseLayoutBlocks(raw)
  if (!blocks.length) throw new Error('模型未返回可用的题目内容')
  const built = await buildContentDoc(blocks, imageDataUrl)
  return {
    content: built.doc,
    text: docToPlainText(built.doc),
    warnings: built.warnings,
    mathCount: built.mathCount,
    figureCount: built.figureCount,
    unresolved: built.unresolved
  }
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    /* 继续尝试截取第一个完整对象 */
  }
  const start = cleaned.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  throw new Error('识别结果不是有效 JSON，请重试或更换视觉模型')
}

function pickBlocks(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    for (const key of ['blocks', 'lines', 'elements', 'items', 'paragraphs', 'content']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
    if (typeof obj.text === 'string') return [payload]
  }
  return []
}

function parseLayoutBlocks(raw: string): LayoutBlock[] {
  const payload = extractJson(raw)
  const blocks = pickBlocks(payload)
  const result: LayoutBlock[] = []
  for (const item of blocks) {
    const block = normalizeBlock(item)
    if (!block) continue
    if (block.type === 'paragraph') result.push(...splitParagraphLines(block))
    else result.push(block)
  }
  return result
}

function normalizeBlock(input: unknown): LayoutBlock | null {
  if (typeof input === 'string') return paragraphFromText(input, styleOf({}))
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, any>
  const type = String(obj.type ?? '').toLowerCase()

  if (['image', 'figure', 'table', 'chart', 'diagram'].includes(type)) {
    return {
      type: 'image',
      bbox: parseBbox(obj.bbox ?? obj.box ?? obj.rect),
      width: normalizeWidth(obj.width),
      ...styleOf(obj, { align: 'center', gapBefore: 1 })
    }
  }
  if (['math', 'formula', 'latex', 'equation'].includes(type)) {
    const latex = cleanLatex(String(obj.latex ?? obj.value ?? obj.text ?? ''))
    if (!latex) return null
    return {
      type: 'math',
      latex,
      display: obj.display !== false,
      ...styleOf(obj, { align: 'center', gapBefore: 1 })
    }
  }

  const style = styleOf(obj)
  const runs = obj.runs ?? obj.spans ?? obj.inlines ?? obj.children
  if (Array.isArray(runs)) {
    const normalized = normalizeRuns(runs)
    if (normalized.length) return { type: 'paragraph', runs: normalized, ...style }
  }
  for (const key of ['text', 'content', 'value']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return paragraphFromText(obj[key], style)
  }
  return null
}

function normalizeRuns(input: unknown[]): LayoutRun[] {
  const out: LayoutRun[] = []
  for (const item of input) {
    if (typeof item === 'string') {
      pushText(out, item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, any>
    const type = String(obj.type ?? '').toLowerCase()
    if (['math', 'formula', 'latex', 'equation'].includes(type)) {
      const latex = cleanLatex(String(obj.latex ?? obj.value ?? obj.text ?? ''))
      if (latex) out.push({ type: 'math', latex, display: obj.display === true })
      continue
    }
    if (typeof obj.text === 'string') pushText(out, obj.text)
  }
  return out
}

function normalizeAlign(value: unknown, fallback: LayoutAlign): LayoutAlign {
  const text = String(value ?? '').toLowerCase()
  return text === 'center' || text === 'right' || text === 'left' ? (text as LayoutAlign) : fallback
}

function normalizeSize(value: unknown, fallback: LayoutSize): LayoutSize {
  const text = String(value ?? '').toLowerCase()
  return text === 'large' || text === 'small' || text === 'normal' ? (text as LayoutSize) : fallback
}

function normalizeCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(3, Math.round(n)))
}

function normalizeWidth(value: unknown): number {
  let n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  if (!Number.isFinite(n) || n <= 0) return 1
  if (n > 1.01 && n <= 100) n /= 100
  return Math.max(0.1, Math.min(1, n))
}

function styleOf(obj: Record<string, any>, defaults: Partial<LayoutStyle> = {}): LayoutStyle {
  return {
    align: normalizeAlign(obj.align, defaults.align ?? 'left'),
    indent: obj.indent === undefined ? defaults.indent ?? 0 : normalizeCount(obj.indent, defaults.indent ?? 0),
    size: normalizeSize(obj.size, defaults.size ?? 'normal'),
    gapBefore:
      obj.gapBefore === undefined ? defaults.gapBefore ?? 0 : normalizeCount(obj.gapBefore, defaults.gapBefore ?? 0)
  }
}

type ParagraphLayoutBlock = Extract<LayoutBlock, { type: 'paragraph' }>

/** 模型仍把多行合并成一段时的兜底：按换行拆成多个行块 */
function splitParagraphLines(block: ParagraphLayoutBlock): LayoutBlock[] {
  if (!block.runs.some((run) => run.type === 'text' && run.text.includes('\n'))) return [block]
  const lines: LayoutRun[][] = [[]]
  for (const run of block.runs) {
    if (run.type === 'text' && run.text.includes('\n')) {
      const parts = run.text.split('\n')
      parts.forEach((part, index) => {
        if (index > 0) lines.push([])
        if (part) lines[lines.length - 1].push({ type: 'text', text: part })
      })
    } else {
      lines[lines.length - 1].push(run)
    }
  }
  const nonEmpty = lines.filter((runs) => runs.length > 0)
  return nonEmpty.map((runs, index) => ({
    ...block,
    runs,
    gapBefore: index === 0 ? block.gapBefore : 0
  }))
}

function paragraphFromText(text: string, style: LayoutStyle): LayoutBlock | null {
  const runs = splitInlineMath(text)
  const hasContent = runs.some((run) => (run.type === 'math' ? run.latex.trim() : run.text.trim()))
  return hasContent ? { type: 'paragraph', runs, ...style } : null
}

function pushText(out: LayoutRun[], text: string) {
  for (const run of splitInlineMath(text)) {
    if (run.type === 'text') {
      if (!run.text) continue
      const last = out[out.length - 1]
      if (last && last.type === 'text') last.text += run.text
      else out.push(run)
    } else if (run.latex) {
      out.push(run)
    }
  }
}

function splitInlineMath(text: string): LayoutRun[] {
  if (!/[$]|\\\(|\\\[/.test(text)) return [{ type: 'text', text }]
  const runs: LayoutRun[] = []
  const pattern = /\$([^$\n]+)\$|\\\(([^]*?)\\\)|\\\[([^]*?)\\\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) runs.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    const latex = cleanLatex(match[1] ?? match[2] ?? match[3] ?? '')
    if (latex) runs.push({ type: 'math', latex, display: !!match[3] })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) runs.push({ type: 'text', text: text.slice(lastIndex) })
  return runs
}

function cleanLatex(input: string): string {
  return input
    .trim()
    .replace(/^\$\$?|\$\$?$/g, '')
    .replace(/^\\\(|\\\)$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    .trim()
}

function parseBbox(input: unknown): [number, number, number, number] | null {
  let values: number[] | null = null
  if (Array.isArray(input)) {
    values = input.map((value) => Number(value))
  } else if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    values = [obj.x, obj.y, obj.w ?? obj.width, obj.h ?? obj.height].map((value) => Number(value))
  }
  if (!values || values.length < 4 || values.some((value) => !Number.isFinite(value))) return null

  let [x, y, w, h] = values
  // 兼容部分模型输出 [x1, y1, x2, y2]
  if (x + w > 1.02 && w <= 1.02 && h <= 1.02) {
    w -= x
    h -= y
  }
  if (w <= 0.01 || h <= 0.01) return null
  if (x < -0.02 || y < -0.02 || x + w > 1.02 || y + h > 1.02) return null

  const nx = Math.max(0, Math.min(1, x))
  const ny = Math.max(0, Math.min(1, y))
  const nw = Math.max(0.01, Math.min(1 - nx, w))
  const nh = Math.max(0.01, Math.min(1 - ny, h))
  return [nx, ny, nw, nh]
}

async function cropFigure(dataUrl: string, bbox: [number, number, number, number]): Promise<string> {
  const image = await loadImage(dataUrl)
  const sx = Math.max(0, Math.round(bbox[0] * image.naturalWidth))
  const sy = Math.max(0, Math.round(bbox[1] * image.naturalHeight))
  const sw = Math.max(8, Math.round(bbox[2] * image.naturalWidth))
  const sh = Math.max(8, Math.round(bbox[3] * image.naturalHeight))
  const scale = Math.min(1, 1400 / sw)
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', 0.92)
}

function isValidLatex(latex: string, display: boolean): boolean {
  try {
    katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false })
    return true
  } catch {
    return false
  }
}

async function buildContentDoc(
  blocks: LayoutBlock[],
  imageDataUrl: string
): Promise<{ doc: ContentDoc; warnings: string[]; mathCount: number; figureCount: number; unresolved: number }> {
  const content: ContentNode[] = []
  const warnings = new Set<string>()
  let mathCount = 0
  let figureCount = 0
  let unresolved = 0

  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const runs: ContentNode[] = []
      for (const run of block.runs) {
        if (run.type === 'math') {
          if (!run.latex) continue
          mathCount++
          if (!isValidLatex(run.latex, false)) warnings.add(`公式语法可疑：${run.latex.slice(0, 48)}`)
          runs.push({ type: 'mathInline', attrs: { latex: run.latex } })
        } else if (run.text) {
          runs.push({ type: 'text', text: run.text })
        }
      }
      if (runs.length) {
        content.push({
          type: 'paragraph',
          attrs: {
            align: block.align,
            indent: block.indent,
            size: block.size,
            gapBefore: block.gapBefore
          },
          content: runs
        })
      }
      continue
    }

    if (block.type === 'math') {
      mathCount++
      if (!isValidLatex(block.latex, true)) warnings.add(`公式语法可疑：${block.latex.slice(0, 48)}`)
      content.push({
        type: 'mathBlock',
        attrs: {
          latex: block.latex,
          display: true,
          align: block.align,
          size: block.size,
          gapBefore: block.gapBefore
        }
      })
      continue
    }

    figureCount++
    let src = ''
    if (block.bbox) {
      try {
        src = await cropFigure(imageDataUrl, block.bbox)
      } catch {
        src = ''
      }
    }
    if (!src) {
      unresolved++
      warnings.add('图形区域未定位，已保留占位')
    }
    content.push({
      type: 'figure',
      attrs: {
        src,
        bbox: block.bbox,
        unresolved: !src,
        width: block.width,
        align: block.align,
        gapBefore: block.gapBefore
      }
    })
  }

  if (!content.length) throw new Error('识别结果为空')
  return { doc: { type: 'doc', content }, warnings: Array.from(warnings), mathCount, figureCount, unresolved }
}

/** 把结构化内容压平成纯文本，供搜索、AI 分析与旧导出使用 */
export function docToPlainText(doc: ContentDoc | undefined | null): string {
  if (!doc?.content) return ''
  const lines: string[] = []
  for (const node of doc.content) {
    if (node.type === 'paragraph') {
      let line = ''
      for (const child of node.content ?? []) {
        if (child.type === 'text') line += (child.text ?? '').replace(/\u2060/g, '')
        else if (child.type === 'mathInline') line += `$${child.attrs?.latex ?? ''}$`
      }
      if (line.trim()) lines.push(line)
    } else if (node.type === 'mathBlock') {
      lines.push(`$${node.attrs?.latex ?? ''}$`)
    } else if (node.type === 'figure') {
      lines.push('[图片]')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function summarizeContent(doc: ContentDoc | undefined | null): {
  paragraphs: number
  math: number
  figures: number
  unresolved: number
} {
  const result = { paragraphs: 0, math: 0, figures: 0, unresolved: 0 }
  for (const node of doc?.content ?? []) {
    if (node.type === 'paragraph') {
      const hasText = (node.content ?? []).some(
        (child) => (child.type === 'text' && child.text?.trim()) || child.type === 'mathInline'
      )
      if (hasText) result.paragraphs++
      result.math += (node.content ?? []).filter((child) => child.type === 'mathInline').length
    } else if (node.type === 'mathBlock') {
      result.math++
    } else if (node.type === 'figure') {
      result.figures++
      if (node.attrs?.unresolved) result.unresolved++
    }
  }
  return result
}
