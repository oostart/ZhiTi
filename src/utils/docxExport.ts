import katex from 'katex'
import 'katex/contrib/mhchem'
import { getFontEmbedCSS, toSvg } from 'html-to-image'
import type { AnswerBlock, ContentNode, ExportOptions, Question } from '../types'
import { dataUrlToBytes, loadImage, mimeOf, sanitizeFileName } from './image'

export interface DocxExportProgress {
  done: number
  total: number
}

export interface DocxExportResult {
  blob: Blob
  filename: string
  warnings: string[]
}

const PT_TO_TWIPS = 20
const MM_TO_TWIPS = 1440 / 25.4
const MM_TO_PX = 96 / 25.4

const PAGE_TWIPS = {
  a4: { width: 11906, height: 16838 },
  letter: { width: 12240, height: 15840 }
}

const FONT = { ascii: 'Times New Roman', eastAsia: '宋体' }

type RunPiece = { type: 'text'; text: string } | { type: 'math'; latex: string; display: boolean }

const DELIMITER = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g

/** 把带 $...$ / $$...$$ 的文本拆成文字与公式片段 */
function splitMath(text: string): RunPiece[] {
  const pieces: RunPiece[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  DELIMITER.lastIndex = 0
  while ((match = DELIMITER.exec(text))) {
    if (match.index > lastIndex) pieces.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    const display = match[1] != null || match[2] != null
    const latex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (latex) pieces.push({ type: 'math', latex, display })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) pieces.push({ type: 'text', text: text.slice(lastIndex) })
  return pieces
}

function baseName(options: ExportOptions): string {
  return sanitizeFileName(options.fileName || options.title || '试卷')
}

/** 用 KaTeX + 光栅化生成公式图片，作为 Word 原生公式不支持时的回退 */
async function formulaToImage(
  latex: string,
  display: boolean,
  maxWidthPx: number
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  // 捕获目标必须保持常规定位，否则 html-to-image 克隆出的节点会带着负偏移落在画布外
  const sandbox = document.createElement('div')
  sandbox.style.cssText = 'position:fixed;left:-20000px;top:0;width:0;height:0;overflow:visible;z-index:-1;'
  const host = document.createElement('div')
  host.style.cssText =
    'display:inline-block;background:#ffffff;color:#000000;padding:2px 10px 2px 4px;font-size:20px;line-height:1.25;white-space:nowrap;'
  sandbox.appendChild(host)
  document.body.appendChild(sandbox)
  try {
    host.innerHTML = katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: 'ignore' })
    await document.fonts?.ready.catch(() => undefined)
    const cssWidth = Math.max(1, host.offsetWidth)
    const cssHeight = Math.max(1, host.offsetHeight)
    // 多留一点画布，避免公式末尾字符被 SVG 视口裁掉
    const captureWidth = Math.ceil(cssWidth) + 24
    const captureHeight = Math.ceil(cssHeight) + 8
    const fontEmbedCSS = await getFontEmbedCSS(host, { preferredFontFormat: 'woff2' }).catch(() => '')
    const svg = await toSvg(host, {
      fontEmbedCSS,
      preferredFontFormat: 'woff2',
      width: captureWidth,
      height: captureHeight
    })
    const image = await loadImage(svg)
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(captureWidth * scale))
    canvas.height = Math.max(1, Math.round(captureHeight * scale))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

    const trimmed = trimCanvas(canvas)
    const width = Math.min(maxWidthPx, trimmed.width / scale)
    const height = (trimmed.height / scale) * (width / (trimmed.width / scale))
    return { data: dataUrlToBytes(trimmed.toDataURL('image/png')), width, height }
  } catch {
    return null
  } finally {
    sandbox.remove()
  }
}

/** 去掉公式图片四周的空白，避免行内出现大块留白 */
function trimCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const { width, height } = source
  const ctx = source.getContext('2d')!
  const data = ctx.getImageData(0, 0, width, height).data
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      if (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (right < left || bottom < top) return source
  const pad = 2
  const x = Math.max(0, left - pad)
  const y = Math.max(0, top - pad)
  const w = Math.min(width - x, right - left + 1 + pad * 2)
  const h = Math.min(height - y, bottom - top + 1 + pad * 2)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const outCtx = out.getContext('2d')!
  outCtx.fillStyle = '#ffffff'
  outCtx.fillRect(0, 0, w, h)
  outCtx.drawImage(source, x, y, w, h, 0, 0, w, h)
  return out
}

async function imageRunFromDataUrl(
  src: string,
  targetWidth: number,
  maxWidth: number
): Promise<{ data: Uint8Array; type: 'png' | 'jpg'; width: number; height: number } | null> {
  if (!src) return null
  try {
    const image = await loadImage(src)
    const width = Math.max(10, Math.min(maxWidth, targetWidth, image.naturalWidth || maxWidth))
    const height = Math.max(10, ((image.naturalHeight || 1) * width) / (image.naturalWidth || 1))
    return {
      data: dataUrlToBytes(src),
      type: mimeOf(src) === 'image/png' ? 'png' : 'jpg',
      width,
      height
    }
  } catch {
    return null
  }
}

/** 从参考答案原图按归一化 bbox 裁剪出插图 */
async function cropAnswerImage(answerImage: string, bbox: [number, number, number, number]): Promise<string> {
  const image = await loadImage(answerImage)
  const sx = Math.max(0, Math.round(bbox[0] * image.naturalWidth))
  const sy = Math.max(0, Math.round(bbox[1] * image.naturalHeight))
  const sw = Math.max(8, Math.round(bbox[2] * image.naturalWidth))
  const sh = Math.max(8, Math.round(bbox[3] * image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, sw, sh)
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas.toDataURL('image/jpeg', 0.92)
}

function alignOf(value: unknown, fallback: 'left' | 'center' | 'right') {
  const text = String(value ?? '').toLowerCase()
  return text === 'center' || text === 'right' || text === 'left' ? (text as 'left' | 'center' | 'right') : fallback
}

function sizeFactor(value: unknown): number {
  return value === 'large' ? 1.15 : value === 'small' ? 0.88 : 1
}

function countOf(value: unknown, max = 3): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.round(number))) : 0
}

function escapeNodeText(node: ContentNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'mathInline') return `$${String(node.attrs?.latex ?? '')}$`
  return (node.content ?? []).map(escapeNodeText).join('')
}

export async function exportDocx(
  questions: Question[],
  options: ExportOptions,
  onProgress?: (progress: DocxExportProgress) => void
): Promise<DocxExportResult> {
  const [{ Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, PageBreak, BorderStyle }, mathModule] =
    await Promise.all([import('docx'), import('docx/math')])
  const { Math: DocxMath, latexToMath } = mathModule

  const warnings = new Set<string>()
  let fallbackMath = 0
  let missingImage = 0

  const page = PAGE_TWIPS[options.pageSize]
  const marginTwips = Math.round(options.margin * MM_TO_TWIPS)
  const contentWidthPx = Math.max(200, (page.width / MM_TO_TWIPS - options.margin * 2) * MM_TO_PX)
  const baseFontPt = 10.5
  const baseSize = Math.round(baseFontPt * 2 * Math.min(1, Math.max(0.6, options.scale)))

  const alignment = (value: 'left' | 'center' | 'right') =>
    value === 'center' ? AlignmentType.CENTER : value === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT

  const spacingBefore = (lines: number) => (lines > 0 ? { before: lines * baseSize * PT_TO_TWIPS * 1.4 } : undefined)

  const mathRun = async (latex: string, display: boolean, maxWidth: number): Promise<any | null> => {
    try {
      return new DocxMath({ children: latexToMath(latex) })
    } catch {
      const image = await formulaToImage(latex, display, maxWidth)
      if (!image) return null
      fallbackMath += 1
      // 行内公式图片按正文字号收一下高度，避免在行里显得过大
      const inlineMaxHeight = baseSize * 0.95
      const height = display ? image.height : Math.min(image.height, inlineMaxHeight)
      const width = (image.width * height) / image.height
      return new ImageRun({
        data: image.data,
        type: 'png',
        transformation: { width: Math.round(width), height: Math.round(height) }
      })
    }
  }

  const imageParagraph = async (
    src: string,
    attrs: Record<string, any> | undefined,
    align: 'left' | 'center' | 'right',
    gapBefore: number
  ): Promise<any | null> => {
    const ratio = typeof attrs?.width === 'number' ? attrs.width : 1
    const image = await imageRunFromDataUrl(src, contentWidthPx * Math.min(1, Math.max(0.1, ratio)), contentWidthPx)
    if (!image) {
      missingImage += 1
      return null
    }
    return new Paragraph({
      alignment: alignment(align),
      spacing: spacingBefore(gapBefore),
      children: [
        new ImageRun({
          data: image.data,
          type: image.type,
          transformation: { width: Math.round(image.width), height: Math.round(image.height) }
        })
      ]
    })
  }

  const contentParagraph = async (node: ContentNode, prefix = ''): Promise<any[]> => {
    if (node.type === 'figure') {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
      if (!src) {
        missingImage += 1
        return []
      }
      const paragraph = await imageParagraph(
        src,
        node.attrs,
        alignOf(node.attrs?.align, 'center'),
        countOf(node.attrs?.gapBefore)
      )
      return paragraph ? [paragraph] : []
    }

    if (node.type === 'mathBlock') {
      const latex = String(node.attrs?.latex ?? '').trim()
      if (!latex) return []
      const run = await mathRun(latex, true, contentWidthPx)
      if (!run) {
        warnings.add(`公式无法导出：${latex.slice(0, 40)}`)
        return []
      }
      return [
        new Paragraph({
          alignment: alignment(alignOf(node.attrs?.align, 'center')),
          spacing: spacingBefore(countOf(node.attrs?.gapBefore)),
          children: [run]
        })
      ]
    }

    if (node.type !== 'paragraph') {
      const text = escapeNodeText(node).trim()
      return text ? [new Paragraph({ children: [new TextRun({ text, font: FONT, size: baseSize })] })] : []
    }

    const scale = sizeFactor(node.attrs?.size)
    const size = Math.round(baseSize * scale)
    const children: any[] = prefix ? [new TextRun({ text: prefix, bold: true, font: FONT, size })] : []
    for (const child of node.content ?? []) {
      if (child.type === 'text' && child.text) {
        children.push(new TextRun({ text: child.text.replace(/\u2060/g, ''), font: FONT, size }))
        continue
      }
      if (child.type === 'mathInline') {
        const latex = String(child.attrs?.latex ?? '').trim()
        if (!latex) continue
        const run = await mathRun(latex, false, contentWidthPx)
        if (run) children.push(run)
        else warnings.add(`公式无法导出：${latex.slice(0, 40)}`)
      }
    }
    if (!children.length) return []
    const indent = countOf(node.attrs?.indent)
    return [
      new Paragraph({
        alignment: alignment(alignOf(node.attrs?.align, 'left')),
        spacing: spacingBefore(countOf(node.attrs?.gapBefore)),
        indent: indent > 0 ? { firstLine: Math.round(indent * size * PT_TO_TWIPS) } : undefined,
        children
      })
    ]
  }

  const answerParagraphs = async (question: Question): Promise<any[]> => {
    const blocks: AnswerBlock[] = question.answerBlocks?.length
      ? question.answerBlocks
      : question.answer.trim()
        ? question.answer
            .replace(/\r\n/g, '\n')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => ({ type: 'text', text: line }) as AnswerBlock)
        : []
    if (!blocks.length) return []

    const paragraphs: any[] = [
      new Paragraph({
        spacing: { before: Math.round(baseSize * PT_TO_TWIPS * 1.8), after: Math.round(baseSize * PT_TO_TWIPS * 0.4) },
        border: {
          top: { color: 'CBD5E1', style: BorderStyle.DASHED, size: 4, space: 4 }
        },
        children: [new TextRun({ text: '参考答案', bold: true, color: '334155', font: FONT, size: Math.round(baseSize * 0.9) })]
      })
    ]

    for (const block of blocks) {
      if (block.type === 'image') {
        if (!question.answerImage) {
          missingImage += 1
          continue
        }
        try {
          const src = await cropAnswerImage(question.answerImage, block.bbox)
          const paragraph = await imageParagraph(src, { width: block.width }, block.align, 0)
          if (paragraph) paragraphs.push(paragraph)
        } catch {
          missingImage += 1
        }
        continue
      }

      const lines = block.text.replace(/\r\n/g, '\n').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        const children: any[] = []
        for (const piece of splitMath(line)) {
          if (piece.type === 'text') {
            if (piece.text) {
              children.push(new TextRun({ text: piece.text, font: FONT, size: Math.round(baseSize * 0.9), color: '334155' }))
            }
          } else {
            const run = await mathRun(piece.latex, piece.display, contentWidthPx)
            if (run) children.push(run)
            else warnings.add(`答案公式无法导出：${piece.latex.slice(0, 40)}`)
          }
        }
        if (children.length) paragraphs.push(new Paragraph({ children }))
      }
    }
    return paragraphs
  }

  const children: any[] = []
  if (options.title.trim()) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: Math.round(baseSize * PT_TO_TWIPS * 0.5) },
        children: [new TextRun({ text: options.title.trim(), bold: true, size: 38, font: { ascii: FONT.ascii, eastAsia: '黑体' } })]
      })
    )
  }
  if (options.subtitle.trim()) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: options.subtitle.trim(), size: 22, color: '64748B', font: FONT })]
      })
    )
  }
  if (children.length) {
    children.push(
      new Paragraph({
        spacing: { after: Math.round(baseSize * PT_TO_TWIPS) },
        border: { bottom: { color: 'CBD5E1', style: BorderStyle.SINGLE, size: 6, space: 6 } }
      })
    )
  }

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    onProgress?.({ done: i, total: questions.length })
    if (options.onePerPage && i > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }))
    }

    const nodes = question.content?.content ?? []
    let numbered = false
    for (const node of nodes) {
      let prefix = ''
      if (!numbered && options.showNumber) {
        numbered = true
        prefix = `${i + 1}. `
      }
      if (prefix && node.type !== 'paragraph') {
        children.push(
          new Paragraph({ children: [new TextRun({ text: prefix.trim(), bold: true, font: FONT, size: baseSize })] })
        )
        prefix = ''
      }
      children.push(...(await contentParagraph(node, prefix)))
    }
    if (!nodes.length) {
      const fallback = await imageRunFromDataUrl(question.image, contentWidthPx, contentWidthPx)
      if (fallback) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                data: fallback.data,
                type: fallback.type,
                transformation: { width: Math.round(fallback.width), height: Math.round(fallback.height) }
              })
            ]
          })
        )
      } else {
        warnings.add(`第 ${i + 1} 题没有可导出的内容，已跳过`)
        onProgress?.({ done: i + 1, total: questions.length })
        continue
      }
    }

    if (options.showAnswer) children.push(...(await answerParagraphs(question)))
    onProgress?.({ done: i + 1, total: questions.length })
  }

  if (fallbackMath) warnings.add(`${fallbackMath} 个公式无法转为 Word 原生公式，已自动转为图片`)
  if (missingImage) warnings.add(`${missingImage} 张插图缺少图片数据，已跳过`)

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: baseSize },
          paragraph: { spacing: { line: 360, after: 60 } }
        }
      }
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: page.width, height: page.height },
            margin: { top: marginTwips, right: marginTwips, bottom: marginTwips, left: marginTwips }
          }
        },
        children
      }
    ]
  })

  const blob = await Packer.toBlob(document)
  return { blob, filename: `${baseName(options)}.docx`, warnings: Array.from(warnings) }
}
