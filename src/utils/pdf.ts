import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { repositories } from '../db'
import type { Region } from '../types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const docCache = new Map<number, PDFDocumentProxy>()
const textCache = new Map<string, TextFragment[]>()

export interface TextFragment {
  str: string
  x: number
  y: number
  w: number
  h: number
}

export interface OpenedPdf {
  doc: PDFDocumentProxy
  pageCount: number
  bytes: ArrayBuffer
}

export async function readPdfFile(file: File): Promise<OpenedPdf> {
  const bytes = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise
  return { doc, pageCount: doc.numPages, bytes }
}

export async function getPaperDocument(paperId: number): Promise<PDFDocumentProxy> {
  const cached = docCache.get(paperId)
  if (cached) return cached
  const stored = await repositories.savedFile(paperId)
  if (!stored) throw new Error('找不到原始 PDF 文件，请重新导入该试卷')
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(stored.data.slice(0)) }).promise
  docCache.set(paperId, doc)
  return doc
}

export function cacheDocument(paperId: number, doc: PDFDocumentProxy): void {
  docCache.set(paperId, doc)
}

export async function disposeDocument(paperId: number): Promise<void> {
  const doc = docCache.get(paperId)
  docCache.delete(paperId)
  textCache.forEach((_, key) => {
    if (key.startsWith(`${paperId}:`)) textCache.delete(key)
  })
  if (doc) await doc.destroy().catch(() => undefined)
}

export async function renderPageToCanvas(doc: PDFDocumentProxy, pageNo: number, targetWidth: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(4, targetWidth / base.width)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise
  return canvas
}

export async function getTextFragments(paperId: number, doc: PDFDocumentProxy, pageNo: number): Promise<TextFragment[]> {
  const key = `${paperId}:${pageNo}`
  const cached = textCache.get(key)
  if (cached) return cached
  const page = await doc.getPage(pageNo)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const frags: TextFragment[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str || !item.str.trim()) continue
    const tr = pdfjsLib.Util.transform(viewport.transform, item.transform as number[])
    const h = Math.hypot(tr[2], tr[3]) || item.height || 10
    frags.push({
      str: item.str,
      x: tr[4] / viewport.width,
      y: tr[5] / viewport.height - (h * 0.8) / viewport.height,
      w: (item.width || 1) / viewport.width,
      h: h / viewport.height
    })
  }
  textCache.set(key, frags)
  return frags
}

function isAsciiWordBoundary(left: string, right: string): boolean {
  const a = left.slice(-1)
  const b = right.slice(0, 1)
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)
}

function insideFragment(frag: TextFragment, region: Region): boolean {
  const cx = frag.x + frag.w / 2
  const cy = frag.y + frag.h / 2
  return cx >= region.x - 0.004 && cx <= region.x + region.w + 0.004 && cy >= region.y - 0.004 && cy <= region.y + region.h + 0.004
}

/** 从 PDF 文本层中按区域提取文字（比 OCR 更准确，数字版试卷首选） */
export async function extractTextFromRegions(paperId: number, doc: PDFDocumentProxy, regions: Region[]): Promise<string> {
  const blocks: string[] = []
  const sorted = [...regions].sort((a, b) => a.page - b.page || a.y - b.y)
  for (const region of sorted) {
    const frags = await getTextFragments(paperId, doc, region.page)
    const selected = frags.filter((f) => insideFragment(f, region)).sort((a, b) => a.y - b.y || a.x - b.x)
    if (!selected.length) continue
    const lines: { y: number; parts: TextFragment[] }[] = []
    for (const frag of selected) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(frag.y - last.y) < Math.max(frag.h * 0.7, 0.008)) {
        last.parts.push(frag)
      } else {
        lines.push({ y: frag.y, parts: [frag] })
      }
    }
    const text = lines
      .map((line) => {
        const parts = line.parts.sort((a, b) => a.x - b.x)
        return parts.reduce((acc, part, i) => {
          if (i === 0) return part.str
          return acc + (isAsciiWordBoundary(acc, part.str) ? ' ' : '') + part.str
        }, '')
      })
      .join('\n')
    if (text.trim()) blocks.push(text.trim())
  }
  return blocks.join('\n\n')
}

/** 根据切割线（归一化 y 值）生成区域 */
export function regionsFromCuts(page: number, cuts: number[]): Region[] {
  const sorted = [...cuts].sort((a, b) => a - b)
  const points = [0.015, ...sorted, 0.985]
  const regions: Region[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const top = points[i]
    const bottom = points[i + 1]
    if (bottom - top < 0.01) continue
    regions.push({ page, x: 0.02, y: top, w: 0.96, h: bottom - top })
  }
  return regions
}
