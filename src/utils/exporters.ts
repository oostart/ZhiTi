import { PDFDocument } from 'pdf-lib'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { ExportOptions, Question } from '../types'
import { createTextCanvas, dataUrlToBytes, loadImage, mimeOf, sanitizeFileName } from './image'
import { renderQuestionBlock } from './contentRender'

const DPI = 200
const PX_PER_MM = DPI / 25.4
const PAGE_MM = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 }
}

/** 题目文档在 PDF 中的基准字号（五号） */
const CONTENT_PT = 10.5
/** PPT 每页内容渲染宽度与基准字号（投屏可读） */
const PPT_WIDTH_PX = 2400
const PPT_CONTENT_PT = 16

const ptToPx = (pt: number) => (pt * DPI) / 72
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export interface ExportProgress {
  done: number
  total: number
}

export interface ExportResult {
  blob: Blob
  filename: string
  warnings: string[]
}

interface PageState {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  y: number
  hasContent: boolean
  hasBlock: boolean
}

function createPage(pageW: number, pageH: number, margin: number): PageState {
  const canvas = document.createElement('canvas')
  canvas.width = pageW
  canvas.height = pageH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pageW, pageH)
  return { canvas, ctx, y: margin, hasContent: false, hasBlock: false }
}

function drawPageHeader(page: PageState, pageW: number, margin: number, contentW: number, options: ExportOptions): void {
  const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'
  const ctx = page.ctx
  if (options.title.trim()) {
    const titleCanvas = createTextCanvas({
      text: options.title.trim(),
      width: contentW,
      fontSize: ptToPx(19),
      lineHeight: ptToPx(26),
      bold: true,
      color: '#0f172a',
      align: 'center',
      family: fontFamily
    })
    ctx.drawImage(titleCanvas, margin, page.y)
    page.y += titleCanvas.height + 6
    page.hasContent = true
  }
  if (options.subtitle.trim()) {
    const subCanvas = createTextCanvas({
      text: options.subtitle.trim(),
      width: contentW,
      fontSize: ptToPx(11),
      lineHeight: ptToPx(16),
      color: '#64748b',
      align: 'center',
      family: fontFamily
    })
    ctx.drawImage(subCanvas, margin, page.y)
    page.y += subCanvas.height + 4
    page.hasContent = true
  }
  if (page.hasContent) {
    page.y += 8
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(margin, page.y)
    ctx.lineTo(pageW - margin, page.y)
    ctx.stroke()
    page.y += ptToPx(16)
  }
}

/** 按目标宽度等比缩放原题图，作为渲染失败时的兜底 */
function imageToCanvas(image: HTMLImageElement, targetWidth: number): HTMLCanvasElement {
  const width = Math.max(1, Math.round(Math.min(targetWidth, image.naturalWidth)))
  const height = Math.max(1, Math.round((image.naturalHeight * width) / image.naturalWidth))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}

function sliceCanvas(source: HTMLCanvasElement, offsetY: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, offsetY, source.width, height, 0, 0, source.width, height)
  return canvas
}

/** 渲染一道题的排版块；失败时回退原图 */
async function renderBlock(
  question: Question,
  options: ExportOptions,
  widthPx: number,
  baseFontPx: number
): Promise<{ canvas: HTMLCanvasElement; fallback: boolean; reason: string } | null> {
  const rendered = await renderQuestionBlock(question, options, widthPx, baseFontPx)
  if (rendered.canvas) return { canvas: rendered.canvas, fallback: false, reason: '' }

  const image = await loadImage(question.image).catch(() => null)
  if (!image) return null
  return { canvas: imageToCanvas(image, widthPx), fallback: true, reason: rendered.error || '排版失败' }
}

function baseName(options: ExportOptions): string {
  return sanitizeFileName(options.fileName || options.title || '试卷')
}

export async function exportPdf(
  questions: Question[],
  options: ExportOptions,
  onProgress?: (progress: ExportProgress) => void
): Promise<ExportResult> {
  const sizeMm = PAGE_MM[options.pageSize]
  const pageW = Math.round(sizeMm.w * PX_PER_MM)
  const pageH = Math.round(sizeMm.h * PX_PER_MM)
  const ptW = (sizeMm.w * 72) / 25.4
  const ptH = (sizeMm.h * 72) / 25.4
  const margin = Math.round(options.margin * PX_PER_MM)
  const contentW = pageW - margin * 2
  const contentBottom = pageH - margin
  const gutter = options.showNumber ? Math.round(ptToPx(12)) : 0
  const blockWidth = Math.max(1, Math.round((contentW - gutter) * clamp(options.scale, 0.4, 1)))
  const baseFontPx = ptToPx(CONTENT_PT)

  const pdf = await PDFDocument.create()
  const warnings: string[] = []
  let current = createPage(pageW, pageH, margin)
  drawPageHeader(current, pageW, margin, contentW, options)

  async function flushPage(): Promise<void> {
    if (!current.hasContent) return
    const embedded = await pdf.embedJpg(dataUrlToBytes(current.canvas.toDataURL('image/jpeg', 0.92)))
    const page = pdf.addPage([ptW, ptH])
    page.drawImage(embedded, { x: 0, y: 0, width: ptW, height: ptH })
    current.canvas.width = 0
    current.canvas.height = 0
  }

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    onProgress?.({ done: i, total: questions.length })
    const block = await renderBlock(question, options, blockWidth, baseFontPx)
    if (!block) {
      warnings.push(`第 ${i + 1} 题排版失败且原图不可用，已跳过`)
      onProgress?.({ done: i + 1, total: questions.length })
      continue
    }
    if (block.fallback) warnings.push(`第 ${i + 1} 题排版失败（${block.reason}），已回退原图`)

    if (options.onePerPage && current.hasBlock) {
      await flushPage()
      current = createPage(pageW, pageH, margin)
    } else if (current.hasBlock && current.y + block.canvas.height > contentBottom) {
      await flushPage()
      current = createPage(pageW, pageH, margin)
    }

    let offset = 0
    let firstSlice = true
    while (offset < block.canvas.height) {
      if (contentBottom - current.y < 20 && current.hasContent) {
        await flushPage()
        current = createPage(pageW, pageH, margin)
      }
      const sliceH = Math.min(block.canvas.height - offset, contentBottom - current.y)
      const x = margin + gutter
      if (firstSlice && options.showNumber) {
        current.ctx.fillStyle = '#0f172a'
        current.ctx.font = `600 ${ptToPx(11)}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`
        current.ctx.textBaseline = 'top'
        current.ctx.textAlign = 'left'
        current.ctx.fillText(`${i + 1}.`, margin, current.y + 2)
      }
      current.ctx.drawImage(block.canvas, 0, offset, block.canvas.width, sliceH, x, current.y, block.canvas.width, sliceH)
      current.y += sliceH
      current.hasContent = true
      current.hasBlock = true
      offset += sliceH
      firstSlice = false
      if (offset < block.canvas.height) {
        await flushPage()
        current = createPage(pageW, pageH, margin)
      }
    }

    current.y += ptToPx(18)
    block.canvas.width = 0
    block.canvas.height = 0
    onProgress?.({ done: i + 1, total: questions.length })
  }

  await flushPage()
  const bytes = await pdf.save()
  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }),
    filename: `${baseName(options)}.pdf`,
    warnings
  }
}

export async function exportPptx(
  questions: Question[],
  options: ExportOptions,
  onProgress?: (progress: ExportProgress) => void
): Promise<ExportResult> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.title = options.title || '试卷'

  if (options.title.trim()) {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addText(options.title.trim(), { x: 0.6, y: 2.0, w: 8.8, h: 1.2, fontSize: 34, bold: true, color: '0F172A', align: 'center', valign: 'middle' })
    if (options.subtitle.trim()) {
      slide.addText(options.subtitle.trim(), { x: 0.6, y: 3.2, w: 8.8, h: 0.6, fontSize: 16, color: '64748B', align: 'center' })
    }
    slide.addShape('line', { x: 3.0, y: 3.95, w: 4.0, h: 0, line: { color: 'CBD5E1', width: 1.5 } })
  }

  const warnings: string[] = []
  const slideW = 13.333
  const slideH = 7.5
  const contentLeft = 0.5
  const contentWidth = slideW - contentLeft * 2
  const areaTop = options.showNumber ? 0.75 : 0.4
  const areaBottom = 0.5
  const availableH = slideH - areaTop - areaBottom
  const pxPerInch = PPT_WIDTH_PX / contentWidth
  const baseFontPx = ptToPx(PPT_CONTENT_PT)
  const maxSlicePx = Math.floor(availableH * pxPerInch)

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    onProgress?.({ done: i, total: questions.length })
    const block = await renderBlock(question, options, PPT_WIDTH_PX, baseFontPx)
    if (!block) {
      warnings.push(`第 ${i + 1} 题排版失败且原图不可用，已跳过`)
      onProgress?.({ done: i + 1, total: questions.length })
      continue
    }
    if (block.fallback) warnings.push(`第 ${i + 1} 题排版失败（${block.reason}），已回退原图`)

    const sliceCount = Math.max(1, Math.ceil(block.canvas.height / maxSlicePx))
    for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex++) {
      const offset = sliceIndex * maxSlicePx
      const sliceH = Math.min(maxSlicePx, block.canvas.height - offset)
      const slice = sliceCanvas(block.canvas, offset, sliceH)
      const slide = pptx.addSlide()
      slide.background = { color: 'FFFFFF' }
      if (options.showNumber) {
        slide.addText(sliceIndex === 0 ? `第 ${i + 1} 题` : `第 ${i + 1} 题（续）`, {
          x: 0.45,
          y: 0.25,
          w: 3,
          h: 0.4,
          fontSize: 15,
          bold: true,
          color: '4F46E5'
        })
      }
      slide.addImage({
        data: slice.toDataURL('image/jpeg', 0.92),
        x: contentLeft,
        y: areaTop,
        w: contentWidth,
        h: sliceH / pxPerInch
      })
      slice.width = 0
      slice.height = 0
    }

    block.canvas.width = 0
    block.canvas.height = 0
    onProgress?.({ done: i + 1, total: questions.length })
  }

  const blob = (await pptx.write({ outputType: 'blob' })) as Blob
  return { blob, filename: `${baseName(options)}.pptx`, warnings }
}

export async function exportZip(questions: Question[], options: ExportOptions): Promise<ExportResult> {
  const zip = new JSZip()
  const manifest: Record<string, unknown>[] = []
  const lines: string[] = [options.title || '题目素材包', '']

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    if (!question.image) continue
    const name = `题目${String(i + 1).padStart(2, '0')}.jpg`
    const ext = mimeOf(question.image) === 'image/png' ? 'png' : 'jpg'
    const fileName = ext === 'png' ? name.replace('.jpg', '.png') : name
    zip.file(fileName, dataUrlToBytes(question.image))
    manifest.push({
      index: i + 1,
      image: fileName,
      question_type: question.question_type,
      difficulty: question.difficulty,
      knowledge: question.knowledge,
      text: question.text,
      answer: options.showAnswer ? question.answer : '',
      analysis: question.analysis
    })
    lines.push(`第 ${i + 1} 题【${question.question_type}｜难度 ${question.difficulty}】${question.knowledge.length ? '｜' + question.knowledge.join('、') : ''}`)
    lines.push(question.text || '（暂无题干文字）')
    if (options.showAnswer) lines.push(`答案：${question.answer || '（未填写）'}`)
    lines.push('')
  }

  zip.file('题目清单.txt', lines.join('\r\n'))
  zip.file('questions.json', JSON.stringify(manifest, null, 2))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return { blob, filename: `${baseName(options)}-素材包.zip`, warnings: [] }
}

export type ExportFormat = 'pdf' | 'pptx' | 'zip'

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  pptx: 'PPT 演示文稿',
  zip: '素材包 ZIP'
}

export async function exportQuestions(
  format: ExportFormat,
  questions: Question[],
  options: ExportOptions,
  onProgress?: (progress: ExportProgress) => void
): Promise<ExportResult> {
  switch (format) {
    case 'pdf':
      return exportPdf(questions, options, onProgress)
    case 'pptx':
      return exportPptx(questions, options, onProgress)
    case 'zip':
      return exportZip(questions, options)
  }
}
