import { repositories } from '../db'
import type { PaperSourceType, Region } from '../types'
import {
  cacheDocument,
  disposeAllDocuments,
  disposeDocument,
  extractTextFromRegions,
  getPaperDocument,
  readPdfFile,
  renderPageToCanvas
} from './pdf'
import { renderDocxSource, type RenderedDocx } from './docxSource'

export interface PaperSource {
  kind: PaperSourceType
  pageCount: number
  renderPage(pageNo: number, targetWidth: number): Promise<HTMLCanvasElement>
  extractText(regions: Region[]): Promise<string>
  dispose(): Promise<void>
}

export interface OpenedDocument {
  kind: PaperSourceType
  pageCount: number
  bytes: ArrayBuffer
  /** 导入成功并生成试卷后，用同一份解析结果预热缓存，避免重复解析 */
  cache(paperId: number): void
}

const sources = new Map<number, Promise<PaperSource>>()

function wrapPdf(paperId: number, doc: Awaited<ReturnType<typeof getPaperDocument>>): PaperSource {
  return {
    kind: 'pdf',
    pageCount: doc.numPages,
    renderPage: (pageNo, targetWidth) => renderPageToCanvas(doc, pageNo, targetWidth),
    extractText: (regions) => extractTextFromRegions(paperId, doc, regions),
    dispose: () => disposeDocument(paperId)
  }
}

function wrapDocx(rendered: RenderedDocx): PaperSource {
  return {
    kind: 'docx',
    pageCount: rendered.pageCount,
    renderPage: (pageNo, targetWidth) => rendered.renderPage(pageNo, targetWidth),
    extractText: (regions) => rendered.extractText(regions),
    dispose: async () => rendered.dispose()
  }
}

function detectKind(bytes: ArrayBuffer, name?: string): PaperSourceType {
  const head = new Uint8Array(bytes.slice(0, 4))
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf'
  if (head[0] === 0x50 && head[1] === 0x4b) return 'docx'
  return /\.docx$/i.test(name ?? '') ? 'docx' : 'pdf'
}

export function isDocxFile(file: File): boolean {
  return (
    /\.docx$/i.test(file.name) ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
}

/** 打开待导入的 PDF / Word 文件，完成页面解析并给出页数 */
export async function openDocumentFile(file: File): Promise<OpenedDocument> {
  if (isDocxFile(file)) {
    const bytes = await file.arrayBuffer()
    const rendered = await renderDocxSource(bytes)
    return {
      kind: 'docx',
      pageCount: rendered.pageCount,
      bytes,
      cache: (paperId) => sources.set(paperId, Promise.resolve(wrapDocx(rendered)))
    }
  }
  const opened = await readPdfFile(file)
  return {
    kind: 'pdf',
    pageCount: opened.pageCount,
    bytes: opened.bytes,
    cache: (paperId) => {
      cacheDocument(paperId, opened.doc)
      sources.set(paperId, Promise.resolve(wrapPdf(paperId, opened.doc)))
    }
  }
}

export async function getPaperSource(paperId: number): Promise<PaperSource> {
  const cached = sources.get(paperId)
  if (cached) return cached
  const promise = (async () => {
    const stored = await repositories.savedFile(paperId)
    if (!stored) throw new Error('找不到原始试卷文件，请重新导入该试卷')
    if (detectKind(stored.data, stored.name) === 'docx') {
      return wrapDocx(await renderDocxSource(stored.data))
    }
    return wrapPdf(paperId, await getPaperDocument(paperId))
  })()
  sources.set(paperId, promise)
  try {
    return await promise
  } catch (error) {
    sources.delete(paperId)
    throw error
  }
}

export async function disposePaperSource(paperId: number): Promise<void> {
  const cached = sources.get(paperId)
  sources.delete(paperId)
  if (!cached) return
  try {
    const source = await cached
    await source.dispose()
  } catch {
    /* 解析失败时无需释放 */
  }
}

/** 清空全部页面缓存（切换数据目录、清空题库时调用） */
export async function disposeAllSources(): Promise<void> {
  const cached = Array.from(sources.values())
  sources.clear()
  for (const item of cached) {
    try {
      const source = await item
      await source.dispose()
    } catch {
      /* ignore */
    }
  }
  await disposeAllDocuments()
}
