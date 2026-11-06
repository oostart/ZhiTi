import type { Question } from '../types'
import { canvasToDataUrl, composeDataUrls, cropCanvas } from './image'
import { getPaperDocument, renderPageToCanvas } from './pdf'

/** 识别时重新按高分辨率渲染题目区域，避免小下标、分数线丢失 */
export async function buildLayoutImage(question: Question): Promise<string> {
  if (!question.paper_id || !question.regions.length) return question.image
  try {
    const doc = await getPaperDocument(question.paper_id)
    const ordered = [...question.regions].sort((a, b) => a.page - b.page || a.y - b.y)
    const pageCanvases = new Map<number, HTMLCanvasElement>()
    const parts: string[] = []
    for (const region of ordered) {
      let canvas = pageCanvases.get(region.page)
      if (!canvas) {
        canvas = await renderPageToCanvas(doc, region.page, 2400)
        pageCanvases.set(region.page, canvas)
      }
      parts.push(canvasToDataUrl(cropCanvas(canvas, region), 0.95))
    }
    if (parts.length === 1) return parts[0]
    return await composeDataUrls(parts, 14, 2200)
  } catch {
    return question.image
  }
}
