import { toCanvas } from 'html-to-image'
import { fragmentsToRegionText, type TextFragment } from './pdf'
import type { Region } from '../types'

/** 光栅化倍率越高越清晰，内存也越大；页面缓存按最近使用保留 */
const RASTER_RATIO = 3
const MAX_RASTER_CACHE = 2

interface DocxPage {
  element: HTMLElement
  width: number
  height: number
  fragments?: TextFragment[]
  canvas?: HTMLCanvasElement
}

export interface RenderedDocx {
  pageCount: number
  renderPage(pageNo: number, targetWidth: number): Promise<HTMLCanvasElement>
  extractText(regions: Region[]): Promise<string>
  dispose(): void
}

/** docx-preview 只按分页符切页，内容超过页高时不会自动分页，这里按内容区高度重新分页 */
function paginate(host: HTMLElement): DocxPage[] {
  const wrapper = host.querySelector<HTMLElement>('.docx-wrapper')
  if (!wrapper) return []
  const origins = Array.from(wrapper.querySelectorAll<HTMLElement>(':scope > section.docx'))
  const result: DocxPage[] = []

  for (const origin of origins) {
    const sections: HTMLElement[] = []
    const before: Node[] = []
    const after: Node[] = []
    let seenArticle = false
    Array.from(origin.childNodes).forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if ((node as HTMLElement).tagName === 'ARTICLE') seenArticle = true
      else (seenArticle ? after : before).push(node)
    })

    const createPage = (): { section: HTMLElement; article: HTMLElement; usable: number; used: number } => {
      const computed = getComputedStyle(origin)
      const section = document.createElement('section')
      section.className = origin.className
      const styleAttr = origin.getAttribute('style')
      if (styleAttr) section.setAttribute('style', styleAttr)
      before.forEach((node) => section.appendChild(node.cloneNode(true)))

      const article = document.createElement('article')
      const originArticle = origin.querySelector<HTMLElement>(':scope > article')
      if (originArticle?.getAttribute('style')) {
        article.setAttribute('style', originArticle.getAttribute('style')!)
      }
      section.appendChild(article)
      after.forEach((node) => section.appendChild(node.cloneNode(true)))
      wrapper.appendChild(section)
      sections.push(section)

      const boxHeight = parseFloat(computed.minHeight) || origin.getBoundingClientRect().height
      const usable =
        boxHeight - (parseFloat(computed.paddingTop) || 0) - (parseFloat(computed.paddingBottom) || 0)
      return { section, article, usable: Math.max(120, usable), used: 0 }
    }

    let page = createPage()
    const articles = Array.from(origin.children).filter(
      (child): child is HTMLElement => child.tagName === 'ARTICLE'
    )
    for (const originArticle of articles) {
      for (const node of Array.from(originArticle.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
          page.article.appendChild(node)
          continue
        }
        let height = 0
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as HTMLElement
          const style = getComputedStyle(element)
          height =
            element.getBoundingClientRect().height +
            (parseFloat(style.marginTop) || 0) +
            (parseFloat(style.marginBottom) || 0)
        }
        if (page.used > 0 && page.used + height > page.usable + 1) {
          page = createPage()
        }
        page.article.appendChild(node)
        page.used += height
      }
    }

    for (const section of sections) {
      const rect = section.getBoundingClientRect()
      result.push({ element: section, width: rect.width, height: rect.height })
    }
    origin.remove()
  }

  return result
}

/** 等待页面内图片解码完成，避免光栅化时缺图 */
async function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve()
            return
          }
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        })
    )
  )
}

export async function renderDocxSource(bytes: ArrayBuffer): Promise<RenderedDocx> {
  const host = document.createElement('div')
  host.className = 'docx-source-host'
  host.style.cssText =
    'position:fixed;left:-20000px;top:0;width:900px;opacity:0;pointer-events:none;z-index:-1;'
  document.body.appendChild(host)
  try {
    const { renderAsync } = await import('docx-preview')
    await renderAsync(bytes, host, host, {
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: true,
      inWrapper: true,
      renderHeaders: true,
      renderFooters: true
    })
    await document.fonts?.ready.catch(() => undefined)
    await waitForImages(host)
  } catch (error) {
    host.remove()
    throw error
  }

  const pages = paginate(host)
  if (!pages.length) {
    host.remove()
    throw new Error('这个 Word 文件没有可显示的内容')
  }

  const rasterOrder: number[] = []

  async function fullCanvas(index: number): Promise<HTMLCanvasElement> {
    const page = pages[index]
    if (page.canvas) return page.canvas
    const canvas = await toCanvas(page.element, {
      pixelRatio: RASTER_RATIO,
      backgroundColor: '#ffffff'
    })
    page.canvas = canvas
    rasterOrder.push(index)
    while (rasterOrder.length > MAX_RASTER_CACHE) {
      const evicted = rasterOrder.shift()
      if (evicted != null) pages[evicted].canvas = undefined
    }
    return canvas
  }

  return {
    pageCount: pages.length,
    async renderPage(pageNo, targetWidth) {
      const index = Math.min(pages.length, Math.max(1, Math.round(pageNo))) - 1
      const page = pages[index]
      const full = await fullCanvas(index)
      const scale = Math.min(4, Math.max(0.4, targetWidth / page.width))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(page.width * scale))
      canvas.height = Math.max(1, Math.round(page.height * scale))
      const ctx = canvas.getContext('2d', { alpha: false })!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(full, 0, 0, canvas.width, canvas.height)
      return canvas
    },
    async extractText(regions) {
      const blocks: string[] = []
      const ordered = [...regions].sort((a, b) => a.page - b.page || a.y - b.y)
      for (const region of ordered) {
        const page = pages[region.page - 1]
        if (!page) continue
        if (!page.fragments) page.fragments = collectFragments(page)
        const text = fragmentsToRegionText(page.fragments, region)
        if (text) blocks.push(text)
      }
      return blocks.join('\n\n')
    },
    dispose() {
      pages.forEach((page) => {
        page.canvas = undefined
        page.fragments = undefined
      })
      host.remove()
    }
  }
}

/** 从分页后的 DOM 里按字符量出文字框，坐标按页面尺寸归一化 */
function collectFragments(page: DocxPage): TextFragment[] {
  const pageRect = page.element.getBoundingClientRect()
  if (!pageRect.width || !pageRect.height) return []
  const fragments: TextFragment[] = []
  const walker = document.createTreeWalker(page.element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    }
  })
  const range = document.createRange()
  let current: { str: string; left: number; top: number; right: number; bottom: number } | null = null

  const flush = () => {
    if (!current) return
    const text = current.str.replace(/\s+/g, ' ').trim()
    if (text) {
      fragments.push({
        str: text,
        x: (current.left - pageRect.left) / pageRect.width,
        y: (current.top - pageRect.top) / pageRect.height,
        w: (current.right - current.left) / pageRect.width,
        h: (current.bottom - current.top) / pageRect.height
      })
    }
    current = null
  }

  let node = walker.nextNode()
  while (node) {
    const text = node.textContent ?? ''
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const rect = range.getClientRects()[0]
      if (!rect || rect.height === 0) continue
      if (char.trim() === '') {
        if (current && !current.str.endsWith(' ')) current.str += ' '
        if (current) current.right = Math.max(current.right, rect.right)
        continue
      }
      const sameLine =
        current &&
        Math.abs(rect.top - current.top) <= Math.max(2, rect.height * 0.4) &&
        rect.left >= current.right - 2 &&
        rect.left - current.right <= Math.max(6, rect.height * 0.8)
      if (sameLine && current) {
        current.str += char
        current.right = rect.right
        current.bottom = Math.max(current.bottom, rect.bottom)
      } else {
        flush()
        current = { str: char, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      }
    }
    node = walker.nextNode()
  }
  flush()
  return fragments
}
