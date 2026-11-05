import { PDFDocument } from 'pdf-lib'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { ExportOptions, Question } from '../types'
import { createTextCanvas, dataUrlToBytes, loadImage, mimeOf, sanitizeFileName } from './image'

const DPI = 150
const PX_PER_MM = DPI / 25.4
const PAGE_MM = {
  a4: { w: 210, h: 297 },
  letter: { w: 215.9, h: 279.4 }
}

const ptToPx = (pt: number) => (pt * DPI) / 72

interface PageState {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  y: number
  hasContent: boolean
}

async function renderPaperPages(questions: Question[], options: ExportOptions): Promise<HTMLCanvasElement[]> {
  const pageMm = PAGE_MM[options.pageSize]
  const pageW = Math.round(pageMm.w * PX_PER_MM)
  const pageH = Math.round(pageMm.h * PX_PER_MM)
  const margin = Math.round(options.margin * PX_PER_MM)
  const contentW = pageW - margin * 2
  const contentBottom = pageH - margin
  const gutter = options.showNumber ? Math.round(ptToPx(12)) : 0
  const pages: PageState[] = []

  const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'

  function addPage(): PageState {
    const canvas = document.createElement('canvas')
    canvas.width = pageW
    canvas.height = pageH
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageW, pageH)
    const state: PageState = { canvas, ctx, y: margin, hasContent: false }
    pages.push(state)
    return state
  }

  let current = addPage()

  // 首页标题区
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
    current.ctx.drawImage(titleCanvas, margin, current.y)
    current.y += titleCanvas.height + 6
    current.hasContent = true
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
    current.ctx.drawImage(subCanvas, margin, current.y)
    current.y += subCanvas.height + 4
    current.hasContent = true
  }
  if (current.hasContent) {
    current.y += 8
    current.ctx.strokeStyle = '#cbd5e1'
    current.ctx.lineWidth = 2
    current.ctx.beginPath()
    current.ctx.moveTo(margin, current.y)
    current.ctx.lineTo(pageW - margin, current.y)
    current.ctx.stroke()
    current.y += ptToPx(16)
  }

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    if (!question.image) continue
    const img = await loadImage(question.image).catch(() => null)
    if (!img) continue

    const imgMaxW = Math.round((contentW - gutter) * Math.min(1, Math.max(0.4, options.scale)))
    let imgW = Math.min(img.naturalWidth, imgMaxW)
    let imgH = (img.naturalHeight * imgW) / img.naturalWidth

    const answerText = options.showAnswer && question.answer.trim() ? `答案：${question.answer.trim()}` : ''
    const answerCanvas = answerText
      ? createTextCanvas({
          text: answerText,
          width: Math.min(imgW, contentW - gutter),
          fontSize: ptToPx(10.5),
          lineHeight: ptToPx(15),
          color: '#334155',
          family: fontFamily
        })
      : null
    const answerH = answerCanvas ? answerCanvas.height + ptToPx(8) : 0
    const maxBlockH = Math.max(ptToPx(40), contentBottom - margin - ptToPx(12) - answerH)
    if (imgH > maxBlockH) {
      imgH = maxBlockH
      imgW = imgH * (img.naturalWidth / img.naturalHeight)
    }
    const blockH = imgH + answerH

    if (options.onePerPage && current.hasContent) {
      current = addPage()
    } else if (current.hasContent && current.y + blockH > contentBottom) {
      current = addPage()
    }

    const x = margin + gutter
    current.ctx.drawImage(img, x, current.y, imgW, imgH)
    if (options.showNumber) {
      current.ctx.fillStyle = '#0f172a'
      current.ctx.font = `600 ${ptToPx(11)}px ${fontFamily}`
      current.ctx.textBaseline = 'top'
      current.ctx.textAlign = 'left'
      current.ctx.fillText(`${i + 1}.`, margin, current.y + 2)
    }
    current.y += imgH
    if (answerCanvas) {
      current.y += ptToPx(8)
      current.ctx.drawImage(answerCanvas, x, current.y)
      current.y += answerCanvas.height
    }
    current.y += ptToPx(18)
    current.hasContent = true
  }

  return pages.map((p) => p.canvas)
}

function baseName(options: ExportOptions): string {
  return sanitizeFileName(options.fileName || options.title || '试卷')
}

export async function exportPdf(questions: Question[], options: ExportOptions): Promise<{ blob: Blob; filename: string }> {
  const canvases = await renderPaperPages(questions, options)
  const pdf = await PDFDocument.create()
  const size = options.pageSize === 'a4' ? [595.28, 841.89] : [612, 792]
  for (const canvas of canvases) {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
    const embedded = await pdf.embedJpg(dataUrlToBytes(dataUrl))
    const page = pdf.addPage(size as [number, number])
    page.drawImage(embedded, { x: 0, y: 0, width: size[0], height: size[1] })
  }
  const bytes = await pdf.save()
  return { blob: new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), filename: `${baseName(options)}.pdf` }
}

export async function exportPptx(questions: Question[], options: ExportOptions): Promise<{ blob: Blob; filename: string }> {
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

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    if (!question.image) continue
    const img = await loadImage(question.image).catch(() => null)
    if (!img) continue
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    if (options.showNumber) {
      slide.addText(`第 ${i + 1} 题`, { x: 0.45, y: 0.25, w: 3, h: 0.4, fontSize: 15, bold: true, color: '4F46E5' })
    }
    const hasAnswer = options.showAnswer && question.answer.trim()
    const areaY = options.showNumber ? 0.72 : 0.35
    const maxW = 9.2
    const maxH = hasAnswer ? 3.55 : 4.5
    const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1)
    const w = img.naturalWidth * ratio
    const h = img.naturalHeight * ratio
    slide.addImage({ data: question.image, x: (10 - w) / 2, y: areaY + (maxH - h) / 2, w, h })
    if (hasAnswer) {
      slide.addText(
        [
          { text: '答案：', options: { bold: true, color: '334155', fontSize: 11 } },
          { text: question.answer.trim(), options: { color: '334155', fontSize: 11 } }
        ],
        { x: 0.65, y: 4.45, w: 8.7, h: 0.95, valign: 'top', align: 'left' }
      )
    }
  }

  const blob = (await pptx.write({ outputType: 'blob' })) as Blob
  return { blob, filename: `${baseName(options)}.pptx` }
}

export async function exportZip(questions: Question[], options: ExportOptions): Promise<{ blob: Blob; filename: string }> {
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
      ocr_text: question.ocr_text,
      answer: options.showAnswer ? question.answer : '',
      analysis: question.analysis
    })
    lines.push(`第 ${i + 1} 题【${question.question_type}｜难度 ${question.difficulty}】${question.knowledge.length ? '｜' + question.knowledge.join('、') : ''}`)
    lines.push(question.ocr_text || '（无识别文字）')
    if (options.showAnswer) lines.push(`答案：${question.answer || '（未填写）'}`)
    lines.push('')
  }

  zip.file('题目清单.txt', lines.join('\r\n'))
  zip.file('questions.json', JSON.stringify(manifest, null, 2))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return { blob, filename: `${baseName(options)}-素材包.zip` }
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
  options: ExportOptions
): Promise<{ blob: Blob; filename: string }> {
  switch (format) {
    case 'pdf':
      return exportPdf(questions, options)
    case 'pptx':
      return exportPptx(questions, options)
    case 'zip':
      return exportZip(questions, options)
  }
}
