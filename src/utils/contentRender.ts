import { createApp, nextTick, type App } from 'vue'
import 'katex/dist/katex.min.css'
import { getFontEmbedCSS, toSvg } from 'html-to-image'
import ContentEditor from '../components/ContentEditor.vue'
import type { ContentDoc, ContentNode, ExportOptions, Question } from '../types'
import { loadImage } from './image'
import { hasContentDoc } from './layout'
import { renderMathText } from './mathText'

const FONT_FAMILY = "'SimSun', 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', serif"

/** 单题渲染上限：超时后回退原图，避免导出一直转圈 */
const RENDER_TIMEOUT_MS = 10000
/** 图片加载等待上限 */
const IMAGE_WAIT_MS = 5000
/** 渲染前逐张校验/恢复图片的上限 */
const IMAGE_PREPARE_MS = 4000
/** 字体就绪等待上限 */
const FONT_READY_MS = 3000
/** 字体资源内联上限 */
const FONT_EMBED_MS = 8000
/** 浏览器 canvas 尺寸上限（留一点余量） */
const CANVAS_LIMIT = 16000
/** 导出图片的最大边长：足够 200DPI 排版，同时避免超大图片拖垮整张 SVG */
const MAX_FIGURE_PX = 1600

/**
 * 只复制排版真正需要的计算样式。
 * html-to-image 默认会为每个节点复制全部计算属性，题目文档含大量公式节点时会让 SVG 膨胀数倍。
 */
const STYLE_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'box-sizing',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-feature-settings', 'font-variation-settings',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'white-space', 'word-break', 'overflow-wrap', 'line-break', 'overflow', 'overflow-x', 'overflow-y',
  'vertical-align', 'color', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
  'flex-direction', 'flex-wrap', 'align-items', 'align-content', 'justify-content', 'flex-grow', 'flex-shrink', 'flex-basis', 'gap', 'row-gap', 'column-gap',
  'transform', 'transform-origin', 'opacity', 'z-index', 'visibility', 'direction', 'unicode-bidi', 'list-style-type', 'float', 'clear',
  'object-fit', 'object-position', 'aspect-ratio', 'clip', 'clip-path', 'writing-mode', 'text-orientation', 'border-collapse', 'table-layout'
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function buildAnswerSection(answer: string, baseFontPx: number): HTMLElement {
  const section = document.createElement('div')
  section.style.cssText = `margin-top:${baseFontPx * 1.6}px;border-top:1px dashed #cbd5e1;padding-top:${baseFontPx * 0.6}px;`

  const title = document.createElement('div')
  title.textContent = '参考答案'
  title.style.cssText = `font-size:${baseFontPx * 0.9}px;font-weight:600;color:#334155;margin-bottom:${baseFontPx * 0.2}px;`

  const body = document.createElement('div')
  body.innerHTML = renderMathText(answer.trim())
  body.style.cssText = `font-size:${baseFontPx * 0.9}px;line-height:1.85;color:#334155;white-space:normal;word-break:break-word;`

  section.append(title, body)
  return section
}

async function waitForEditor(root: HTMLElement): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (root.querySelector('.ProseMirror')) return true
    await delay(16)
  }
  return false
}

async function loadImageSafe(src: string): Promise<HTMLImageElement | null> {
  if (!src) return null
  return withTimeout(loadImage(src), IMAGE_PREPARE_MS, '图片加载超时').catch(() => null)
}

/** 等待图片解码；已完成的图片直接放行，异常图片最多等 5 秒 */
async function waitImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve()
            return
          }
          const finish = () => {
            clearTimeout(timer)
            img.removeEventListener('load', finish)
            img.removeEventListener('error', finish)
            resolve()
          }
          const timer = setTimeout(finish, IMAGE_WAIT_MS)
          img.addEventListener('load', finish, { once: true })
          img.addEventListener('error', finish, { once: true })
        })
    )
  )
}

/** 等待 NodeView 把图片节点全部挂到 DOM，再等待图片完成解码 */
async function settleImages(root: HTMLElement): Promise<void> {
  let lastCount = -1
  for (let i = 0; i < 12; i++) {
    const count = root.querySelectorAll('img').length
    if (count === lastCount) break
    lastCount = count
    await delay(25)
  }
  await waitImages(root)
}

function downscaleImage(image: HTMLImageElement): string {
  try {
    const scale = Math.min(1, MAX_FIGURE_PX / image.naturalWidth, MAX_FIGURE_PX / image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.92)
  } catch {
    return ''
  }
}

/** 用题目原图 + 归一化 bbox 还原图形 */
function cropFigure(source: HTMLImageElement, bbox: unknown): string {
  if (!Array.isArray(bbox) || bbox.length < 4) return ''
  const [nx, ny, nw, nh] = bbox.slice(0, 4).map((value) => Number(value))
  if (![nx, ny, nw, nh].every((value) => Number.isFinite(value))) return ''
  if (nw <= 0.005 || nh <= 0.005) return ''
  const sx = Math.max(0, Math.round(nx * source.naturalWidth))
  const sy = Math.max(0, Math.round(ny * source.naturalHeight))
  const sw = Math.min(source.naturalWidth - sx, Math.round(nw * source.naturalWidth))
  const sh = Math.min(source.naturalHeight - sy, Math.round(nh * source.naturalHeight))
  if (sw < 8 || sh < 8) return ''
  try {
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, sw, sh)
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
    return canvas.toDataURL('image/jpeg', 0.92)
  } catch {
    return ''
  }
}

/**
 * 渲染前整理图形节点：
 * 有效的图片按需降采样；加载失败的用原题图 + bbox 重新裁剪；仍无法还原的直接省略，避免出现占位块。
 */
async function prepareContent(question: Question): Promise<ContentDoc> {
  const doc = JSON.parse(JSON.stringify(question.content)) as ContentDoc
  const nodes = doc.content ?? []
  let sourceImage: HTMLImageElement | null = null
  const kept: ContentNode[] = []

  for (const node of nodes) {
    if (node.type !== 'figure') {
      kept.push(node)
      continue
    }

    const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
    let image = src ? await loadImageSafe(src) : null
    let nextSrc = src

    if (!image) {
      if (!sourceImage) sourceImage = question.image ? await loadImageSafe(question.image) : null
      nextSrc = sourceImage ? cropFigure(sourceImage, node.attrs?.bbox) : ''
      image = nextSrc ? await loadImageSafe(nextSrc) : null
    }

    if (!image) continue

    if (image.naturalWidth > MAX_FIGURE_PX || image.naturalHeight > MAX_FIGURE_PX) {
      const scaled = downscaleImage(image)
      if (scaled) nextSrc = scaled
    }

    node.attrs = { ...(node.attrs ?? {}), src: nextSrc, unresolved: false }
    kept.push(node)
  }

  return { ...doc, content: kept }
}

/** 兜底清理：只处理已确定损坏的图片，绝不在图片仍加载中时替换 */
function cleanupImages(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (!img.complete) continue
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      const figure = img.closest('.figure-node')
      if (figure) figure.remove()
      else img.remove()
      continue
    }
    if (img.naturalWidth <= MAX_FIGURE_PX && img.naturalHeight <= MAX_FIGURE_PX) continue
    const scaled = downscaleImage(img)
    if (scaled) img.src = scaled
  }
}

const fontCssCache = new Map<string, Promise<string>>()

/** 用公式实际用到的字体家族做缓存键，避免每道题重复内联字体 */
function fontCssKey(root: HTMLElement): string {
  const families = new Set<string>()
  root.querySelectorAll<HTMLElement>('.katex, .katex *').forEach((element) => {
    const family = getComputedStyle(element).fontFamily
    if (!family) return
    family.split(',').forEach((name) => families.add(name.trim()))
  })
  return families.size ? Array.from(families).sort().join('|') : ''
}

async function fontEmbedCss(root: HTMLElement): Promise<string> {
  const key = fontCssKey(root)
  if (!key) return ''
  const cached = fontCssCache.get(key)
  if (cached) return cached
  const task = withTimeout(
    getFontEmbedCSS(root, { preferredFontFormat: 'woff2' }),
    FONT_EMBED_MS,
    '公式字体加载超时'
  ).catch(() => '')
  fontCssCache.set(key, task)
  return task
}

/** 用 SVG 渲染结果生成 canvas；不用 html-to-image 的 toCanvas，避免其 decode 异常导致永不返回 */
async function captureCanvas(root: HTMLElement): Promise<HTMLCanvasElement> {
  const fontEmbedCSS = await fontEmbedCss(root)
  const svg = await toSvg(root, {
    fontEmbedCSS,
    preferredFontFormat: 'woff2',
    includeStyleProperties: STYLE_PROPERTIES
  })
  const image = await loadImage(svg)

  const width = Math.max(1, root.offsetWidth)
  const height = Math.max(1, root.offsetHeight)
  const scale = Math.min(1, CANVAS_LIMIT / width, CANVAS_LIMIT / height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

export interface RenderQuestionResult {
  canvas: HTMLCanvasElement | null
  error?: string
}

/**
 * 按「题目文档」的纸张版式把一道题渲染成高清图。
 * 直接挂载 ContentEditor 复用预览样式，保证导出与题目文档一致；失败或超时返回 error 由调用方兜底。
 */
export async function renderQuestionBlock(
  question: Question,
  options: Pick<ExportOptions, 'showAnswer'>,
  widthPx: number,
  baseFontPx: number
): Promise<RenderQuestionResult> {
  if (!hasContentDoc(question.content)) return { canvas: null, error: '没有可排版的题目文档内容' }

  const sandbox = document.createElement('div')
  sandbox.style.cssText = 'position:fixed;left:-30000px;top:0;width:0;height:0;overflow:visible;z-index:-1;'

  const host = document.createElement('div')
  host.style.cssText = [
    `width:${widthPx}px`,
    'background:#ffffff',
    'color:#111111',
    `font-family:${FONT_FAMILY}`,
    `font-size:${baseFontPx}px`,
    'line-height:1.95',
    `--paper-base-size:${baseFontPx}px`,
    '--paper-line-height:1.95'
  ].join(';')

  sandbox.appendChild(host)
  document.body.appendChild(sandbox)

  let app: App | null = null

  try {
    const content = await withTimeout(prepareContent(question), RENDER_TIMEOUT_MS, '题目图片准备超时').catch(
      () => question.content as ContentDoc
    )

    app = createApp(ContentEditor, { modelValue: content, variant: 'paper', readonly: true })
    app.mount(host)
    await nextTick()
    if (!(await waitForEditor(host))) {
      return { canvas: null, error: '题目文档编辑器初始化失败' }
    }

    if (options.showAnswer && question.answer.trim()) {
      host.appendChild(buildAnswerSection(question.answer, baseFontPx))
    }

    await withTimeout(Promise.resolve(document.fonts.ready), FONT_READY_MS, '字体加载超时').catch(() => undefined)
    await settleImages(host)
    cleanupImages(host)
    await settleImages(host)
    await nextTick()

    return { canvas: await withTimeout(captureCanvas(host), RENDER_TIMEOUT_MS, '题目渲染超时') }
  } catch (error) {
    console.warn('[export] 题目文档渲染失败', question.id, error)
    return { canvas: null, error: (error as Error).message || '未知错误' }
  } finally {
    app?.unmount()
    sandbox.remove()
  }
}
