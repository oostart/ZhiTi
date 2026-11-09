export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function mimeOf(dataUrl: string): 'image/png' | 'image/jpeg' {
  return dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg'
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, quality = 0.92): string {
  return canvas.toDataURL('image/jpeg', quality)
}

/** 压缩答案图片：只缩小不放大，限制最大宽度并转 JPEG，避免题库体积膨胀 */
export async function compressImage(dataUrl: string, maxWidth = 1600, quality = 0.86): Promise<string> {
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxWidth / img.naturalWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvasToDataUrl(canvas, quality)
}

/** 从整页 canvas 中裁剪归一化区域 */
export function cropCanvas(source: HTMLCanvasElement, region: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const sx = Math.max(0, Math.round(region.x * source.width))
  const sy = Math.max(0, Math.round(region.y * source.height))
  const sw = Math.min(source.width - sx, Math.round(region.w * source.width))
  const sh = Math.min(source.height - sy, Math.round(region.h * source.height))
  const out = document.createElement('canvas')
  out.width = Math.max(1, sw)
  out.height = Math.max(1, sh)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
  return out
}

/** 将多张题目图片纵向拼接为一张（用于跨页/多框图） */
export async function composeDataUrls(parts: string[], gap = 16, maxWidth = 1800): Promise<string> {
  const images = await Promise.all(parts.map(loadImage))
  if (images.length === 0) return ''
  const width = Math.min(maxWidth, Math.max(...images.map((img) => img.naturalWidth)))
  const scaleFactor = width / Math.max(...images.map((img) => img.naturalWidth))
  const heights = images.map((img) => Math.round(img.naturalHeight * scaleFactor))
  const totalHeight = heights.reduce((a, b) => a + b, gap * (images.length - 1)) + 24
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.max(1, totalHeight)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let y = 12
  images.forEach((img, i) => {
    const w = Math.round(img.naturalWidth * scaleFactor)
    ctx.drawImage(img, Math.round((width - w) / 2), y, w, heights[i])
    y += heights[i] + gap
  })
  return canvasToDataUrl(canvas)
}

export interface TextBlockOptions {
  text: string
  width: number
  fontSize: number
  lineHeight: number
  color?: string
  bold?: boolean
  family?: string
  align?: 'left' | 'center'
}

/** 将一段中文文本绘制到 canvas 上（PDF 导出用，避免依赖中文字体文件） */
export function createTextCanvas(options: TextBlockOptions): HTMLCanvasElement {
  const { text, width, fontSize, lineHeight, color = '#111827', bold = false, family, align = 'left' } = options
  const font = `${bold ? '600 ' : ''}${fontSize}px ${family ?? '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'}`
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const maxWidth = width - 8
  const paragraphs = text.replace(/\r/g, '').split('\n')
  const lines: string[] = []
  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push('')
      continue
    }
    let current = ''
    for (const ch of para) {
      const next = current + ch
      if (measure.measureText(next).width > maxWidth && current) {
        lines.push(current)
        current = ch
      } else {
        current = next
      }
    }
    if (current) lines.push(current)
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(lines.length * lineHeight + 8))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  ctx.textAlign = align
  const x = align === 'center' ? canvas.width / 2 : 4
  lines.forEach((line, i) => ctx.fillText(line, x, i * lineHeight + 4))
  return canvas
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || '未命名'
}
